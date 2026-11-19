#!/usr/bin/env node
// QA snapshot sessions on this computer: list a Pallet Vision camera's sessions, copy chosen ones from
// Zira through read-only, short-lived links, and build per-model datasets from them (pallets, geometry,
// nail slices) with session_datasets.py. Nothing is created or changed in Zira.
import { fetchDownload } from "../../../scripts/downloads.mjs";
import path from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, ZiraApiError, argValue, id, isMain, liveSession, originFor, route, runCli } from "../../../scripts/client.mjs";
import { loadDevice, summarize, views, webOrigin } from "../../../scripts/datasets.mjs";
import { exec, paths, runtimePython, status } from "./evaluate.mjs";

const HELP = `QA snapshot sessions — copy a Pallet Vision camera's sessions and build local datasets
node scripts/sessions.mjs list --device-id ID [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N]
node scripts/sessions.mjs fetch --device-id ID (--session DAY::SESSION ... | --latest N) [--frames N] [--confirm]
node scripts/sessions.mjs prepare --device-id ID --session DAY::SESSION ... [--outputs nails,geometry,pallets]
    [--classes-from MODEL_FILE | --nail-classes a,b,c] [--reference auto|annotations|device] [--name NAME] [--replace]

list shows the camera's sessions, newest first, with a question for the choice UI. fetch copies the
sessions' frames, device labels, reviewer corrections and marks to this computer (frames are large:
it stops for confirmation above ${500} MB unless --confirm). --frames keeps only each session's newest N
frames. prepare builds pallets (320), geometry (1024) and nails (320 px intersection slices) datasets
like Zira's "Generate training datasets", in the test split; --classes-from lines the classes up with a
model fetched through evaluate.mjs. Then run evaluate.mjs run --dataset <path> --model FILE --split test.
Exit 0 success, 2 invalid/failed, 4 blocked (JSON explains).
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const PREPARER = path.join(here, "session_datasets.py");
const DAY = String.raw`\d{4}-\d{2}-\d{2}`, SESSION = String.raw`(?:\d{4}-\d{2}-\d{2}-)?\d{2}-\d{2}(?:-\d{2})?`;
const SESSION_ID = new RegExp(`^(${DAY})::(${SESSION})$`);
export const ROUTES = [["GET", /^\/devices\/all$/], ["GET", /^\/prod-vision\/[1-9]\d*\/snapshot-sessions$/],
  ["GET", new RegExp(`^/prod-vision/[1-9]\\d*/snapshot-sessions/${DAY}/${SESSION}/files$`)]];
const KINDS = ["images", "labels", "annotations", "marks"];
const META = ["data.yaml", "metadata.json"];
export const CONFIRM_BYTES = 500 * 1024 * 1024;
// Links expire in 15 minutes: pages that download many large frames stay small, and listing-only
// passes (or a few frames per session) use the server's largest page, since each request costs ~1.5 s.
const PAGE = 200, LIST_PAGE = 1000, FEW_FRAMES = 300;
const NAILS = ["nail", "protrudeNail", "flushNail", "raisedNail", "knot"];
const GEOMETRY = ["board", "leadBoard", "boardCluster", "brokenBoard", "stringer"];

const body = r => r?.data ?? r ?? {};
const mb = bytes => `${Math.round(bytes / 1048576)} MB`;
export const sessionsRoot = (env = process.env) => path.join(paths(env).base, "sessions");
export const datasetsRoot = (env = process.env) => path.join(paths(env).base, "session-datasets");
export const sessionFolder = (deviceId, sessionId, env = process.env) => {
  const [, day, session] = SESSION_ID.exec(sessionId) ?? [];
  if (!day) throw new Error(`Session ids look like 2026-10-05::14-03, not ${sessionId}`);
  return path.join(sessionsRoot(env), deviceId, day, session);
};

// Defect frames carry a disposition prefix (DBB-2026-…); the timestamp after it orders frames.
export const frameTime = name => String(name).replace(/^[A-Za-z]+(?:_[A-Za-z]+)*[-_](?=\d{4}-\d{2}-\d{2}T)/, "");
const stemOf = name => name.replace(/\.review\.json$/i, "").replace(/\.[^.]+$/, "");

async function palletDevice(call, deviceId) {
  if (!id(String(deviceId ?? ""))) throw new Error("--device-id is required");
  const ds = summarize(await loadDevice(call, String(deviceId)));
  if (ds.type !== "Pallet Vision")
    throw new Blocked("not_pallet", `${ds.name} is a Vision camera. QA snapshot sessions exist only on Pallet Vision data sources; review its recorded validation in Zira.`);
  return ds;
}

// Before the platform routes are deployed, the gateway answers 404 for them.
function unavailable(error, ds, origin) {
  if (error instanceof ZiraApiError && [403, 404].includes(error.status))
    return new Blocked("sessions_unavailable", `Zira did not offer ${ds.name}'s QA sessions to the plugin (HTTP ${error.status}). Session downloads need the snapshot-session API, which may not be enabled in this environment yet; the sessions are still visible in Zira.`,
      { pageUrl: views(origin, ds).validation.url });
  return error;
}

const labelOf = s => {
  const at = s.sessionAt ? new Date(s.sessionAt) : null;
  return at ? `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC` : `${s.day} ${s.session}`;
};

export async function listSessions({ call, deviceId, from, to, limit = 30, origin }) {
  const ds = await palletDevice(call, deviceId);
  let result;
  try {
    result = body(await call("GET", route(`/prod-vision/${ds.id}/snapshot-sessions`, { from, to, limit })));
  } catch (error) {
    throw unavailable(error, ds, origin);
  }
  const sessions = (Array.isArray(result.sessions) ? result.sessions : []).filter(s => SESSION_ID.test(String(s?.id)));
  const recentDays = sessions.length ? [...new Set(sessions.map(s => s.day))].slice(0, 3) : [];
  const inRecent = sessions.filter(s => recentDays.includes(s.day)).length;
  return {
    kind: "zira.qa-sessions", dataSource: ds, sessions, hasMore: Boolean(result.hasMore),
    ...(sessions.length ? { question: {
      header: "Session", question: `Which ${ds.name} QA sessions?`,
      options: [
        ...sessions.slice(0, 2).map((s, i) => ({ label: `${labelOf(s)}${i === 0 ? " (latest)" : ""}`, description: `Session ${s.id}`, value: s.id })),
        ...(inRecent > 2 ? [{ label: `All of ${recentDays.length === 1 ? recentDays[0] : `${recentDays.at(-1)} to ${recentDays[0]}`}`,
          description: `${inRecent} sessions`, value: sessions.filter(s => recentDays.includes(s.day)).map(s => s.id).join(",") }] : []),
      ],
      other: "Type a day (YYYY-MM-DD) or a session id.",
    } } : { note: "No QA sessions were found for this camera in that range." }),
    links: { validation: views(origin, ds).validation.url },
  };
}

// One page of a session's files; the links expire in minutes, so pages are small and fetched as needed.
async function filesPage(call, deviceId, sessionId, kinds, cursor, pageSize = PAGE) {
  const [, day, session] = SESSION_ID.exec(sessionId);
  return body(await call("GET", route(`/prod-vision/${deviceId}/snapshot-sessions/${day}/${session}/files`,
    { kinds: kinds.join(","), cursor, pageSize })));
}

async function allPages(call, deviceId, sessionId, kinds, onPage, pageSize = PAGE) {
  let cursor;
  do {
    const page = await filesPage(call, deviceId, sessionId, kinds, cursor, pageSize);
    await onPage(page, cursor);
    cursor = page.nextCursor || undefined;
  } while (cursor);
}

async function download(url, target, size, fetchImpl) {
  const response = await fetchDownload(url, { fetchImpl, maxRedirects: 5, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (response.status === 403) { await response.body?.cancel(); return "expired"; }
  if (!response.ok || !response.body) throw new Error(`Download of ${path.basename(target)} failed (HTTP ${response.status})`);
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (size && (await stat(partial)).size !== size) {
    await rm(partial, { force: true });
    throw new Error(`Download of ${path.basename(target)} was incomplete`);
  }
  await rename(partial, target);
  return "downloaded";
}

const sameSize = async (file, size) => { try { return (await stat(file)).size === size || !size; } catch { return false; } };

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

export async function fetchSessions({ call, deviceId, sessions = [], latest, frames, confirm = false, origin,
  env = process.env, fetchImpl = globalThis.fetch, log = () => {} }) {
  const ds = await palletDevice(call, deviceId);
  let ids = [...new Set(sessions.flatMap(s => String(s).split(",")).map(s => s.trim()).filter(Boolean))];
  try {
    if (latest) {
      const listed = body(await call("GET", route(`/prod-vision/${ds.id}/snapshot-sessions`, { limit: latest })));
      ids = (listed.sessions ?? []).map(s => s.id).filter(s => SESSION_ID.test(s)).slice(0, Number(latest));
    }
    if (!ids.length) throw new Error("Choose sessions with --session DAY::SESSION or --latest N");
    for (const s of ids) sessionFolder(ds.id, s, env); // validates every id before any request
    // Pass 1: which frames, and how big. Listing is cheap; nothing is downloaded yet.
    const plan = [];
    for (const sessionId of ids) {
      const images = [];
      await allPages(call, ds.id, sessionId, ["images"], async page => {
        for (const f of page.files ?? []) if (f.kind === "images") images.push({ name: f.name, size: Number(f.size) || 0 });
      }, LIST_PAGE);
      images.sort((a, b) => frameTime(b.name).localeCompare(frameTime(a.name)));
      const chosen = frames ? images.slice(0, Number(frames)) : images;
      plan.push({ id: sessionId, frames: chosen.length, available: images.length, stems: new Set(chosen.map(f => stemOf(f.name))),
        bytes: chosen.reduce((sum, f) => sum + f.size, 0) });
    }
    const total = plan.reduce((sum, p) => sum + p.bytes, 0);
    const summary = plan.map(({ stems, ...p }) => p);
    if (total > CONFIRM_BYTES && !confirm)
      return { kind: "zira.qa-session-fetch", needsConfirmation: true, dataSource: ds, sessions: summary, totalBytes: total,
        message: `That is ${plan.reduce((n, p) => n + p.frames, 0)} frames, about ${mb(total)}. Ask before downloading, or use --frames N for each session's newest N frames.` };

    // Pass 2: download the chosen frames and their label files, a fresh page of links at a time.
    const results = [];
    for (const p of plan) {
      const folder = sessionFolder(ds.id, p.id, env);
      const counts = { downloaded: 0, cached: 0 };
      log(`Copying ${p.frames} frames of session ${p.id}…`);
      const done = new Set(), size = p.frames <= FEW_FRAMES ? LIST_PAGE : PAGE;
      await allPages(call, ds.id, p.id, KINDS, async (page, cursor) => {
        let current = page;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const files = [
            ...Object.entries(current.meta ?? {}).filter(([name, url]) => META.includes(name) && url).map(([name, url]) => ({ target: path.join(folder, name), url, size: 0, fresh: true })),
            ...(current.files ?? []).filter(f => KINDS.includes(f.kind) && p.stems.has(f.stem) && /^[^/\\]+$/.test(f.name) && f.name !== "." && f.name !== "..")
              .map(f => ({ target: path.join(folder, f.kind, f.name), url: f.url, size: Number(f.size) || 0 })),
          ];
          const expired = [];
          await pool(files.filter(f => !done.has(f.target)), 6, async f => {
            if (!f.fresh && await sameSize(f.target, f.size)) { counts.cached += 1; done.add(f.target); return; }
            const outcome = await download(f.url, f.target, f.size, fetchImpl);
            if (outcome === "expired") expired.push(f);
            else { counts.downloaded += 1; done.add(f.target); }
          });
          if (!expired.length) return;
          current = await filesPage(call, ds.id, p.id, KINDS, cursor, size); // links expired: list this page again
        }
        throw new Error(`Session ${p.id}: storage links kept expiring; run fetch again to continue where it stopped`);
      }, size);
      await writeFile(path.join(folder, ".zira-session.json"), JSON.stringify({ dataSourceId: ds.id, dataSource: ds.name, session: p.id,
        frames: p.frames, available: p.available, fetchedAt: new Date().toISOString() }, null, 2));
      results.push({ id: p.id, path: folder, frames: p.frames, available: p.available, bytes: p.bytes, ...counts });
    }
    return { kind: "zira.qa-session-fetch", dataSource: ds, sessions: results, totalBytes: total,
      next: "prepare --session … builds the pallets, geometry and nails datasets from these folders." };
  } catch (error) {
    throw unavailable(error, ds, origin);
  }
}

// Which per-model dataset a model needs, from its class names.
export function outputFor(labels) {
  if (!Array.isArray(labels) || !labels.length) return null;
  if (labels.length === 1 && labels[0] === "pallet") return "pallets";
  if (labels.some(l => GEOMETRY.includes(l))) return "geometry";
  if (labels.every(l => NAILS.includes(l))) return "nails";
  return null;
}

export async function prepareSessions({ deviceId, sessions = [], outputs, classesFrom, nailClasses, reference = "auto", name, replace = false,
  env = process.env, execImpl = exec, log = line => process.stderr.write(`${line}\n`) }) {
  if (!id(String(deviceId ?? ""))) throw new Error("--device-id is required");
  const ids = [...new Set(sessions.flatMap(s => String(s).split(",")).map(s => s.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Choose sessions with --session DAY::SESSION");
  const folders = ids.map(s => sessionFolder(String(deviceId), s, env));
  const missing = folders.filter(f => !existsSync(path.join(f, "images")));
  if (missing.length) throw new Blocked("not_fetched", `Fetch these sessions first: ${missing.map(f => `${path.basename(path.dirname(f))}::${path.basename(f)}`).join(", ")}`);
  const ready = await status({ env });
  if (!ready.runtime.ready) throw new Blocked("runtime_missing", "The local model runtime is not set up yet. Run evaluate.mjs setup once (it downloads about 30 MB of Python packages; ask the user first).");

  let classes = nailClasses ? String(nailClasses).split(",").map(c => c.trim()).filter(Boolean) : null;
  let wanted = outputs ? String(outputs).split(",").map(o => o.trim()).filter(Boolean) : null;
  if (classesFrom) {
    let recorded;
    try { recorded = JSON.parse(await readFile(`${path.resolve(classesFrom)}.zira.json`, "utf8")); }
    catch { throw new Error(`${path.basename(classesFrom)} has no Zira record of its classes; fetch it with evaluate.mjs fetch or pass --nail-classes`); }
    const kind = outputFor(recorded.labels);
    if (!kind) throw new Error(`Cannot tell which model ${path.basename(classesFrom)} is from its classes (${(recorded.labels ?? []).join(", ")})`);
    wanted = wanted ?? [kind];
    if (kind === "nails" && !classes) classes = recorded.labels;
  }
  wanted = wanted ?? ["nails"];
  const days = ids.map(s => s.split("::")[0]).sort();
  const label = name || (ids.length === 1 ? `qa-${ids[0].replace("::", "-")}` : `qa-${days[0]}-to-${days.at(-1)}-${ids.length}s`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(label)) throw new Error("--name must be letters, digits, dots, dashes or underscores");
  const out = path.join(datasetsRoot(env), String(deviceId));
  await mkdir(out, { recursive: true });
  const args = [PREPARER, ...folders.flatMap(f => ["--session", f]), "--out", out, "--name", label, "--outputs", wanted.join(","),
    "--reference", reference, "--progress", ...(classes ? ["--nail-classes", classes.join(",")] : []), ...(replace ? ["--replace"] : [])];
  let last = 0;
  const r = await execImpl(runtimePython(paths(env)), args, { onLine: line => {
    try {
      const e = JSON.parse(line);
      if (e.event === "start") log(`Preparing ${e.total} frames from ${e.sessions} session(s)…`);
      if (e.event === "frame" && (e.done === e.total || e.done - last >= Math.max(1, Math.ceil(e.total / 10)))) { last = e.done; log(`  ${e.done}/${e.total}`); }
    } catch { /* not a progress line */ }
  } });
  if (r.code !== 0) throw new Error(r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? `Preparing failed: ${r.err.trim().split("\n").slice(-2).join(" ")}`);
  const result = JSON.parse(r.out);
  return { ...result, next: Object.fromEntries(Object.entries(result.outputs).map(([o, v]) =>
    [o, `node scripts/evaluate.mjs run --dataset "${v.path}" --model MODEL_FILE --split test`])) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "device-id": { type: "string" }, profile: { type: "string" }, "web-origin": { type: "string" },
    from: { type: "string" }, to: { type: "string" }, limit: { type: "string" },
    session: { type: "string", multiple: true }, latest: { type: "string" }, frames: { type: "string" }, confirm: { type: "boolean" },
    outputs: { type: "string" }, "classes-from": { type: "string" }, "nail-classes": { type: "string" }, reference: { type: "string" },
    name: { type: "string" }, replace: { type: "boolean" },
  } });
  for (const key of ["limit", "latest", "frames"]) if (o[key] && !/^[1-9]\d*$/.test(o[key])) throw new Error(`--${key} must be a positive number`);
  if (o.reference && !["auto", "annotations", "device"].includes(o.reference)) throw new Error("--reference must be auto, annotations or device");
  if (args[0] === "prepare")
    return prepareSessions({ deviceId: o["device-id"], sessions: o.session, outputs: o.outputs, classesFrom: o["classes-from"],
      nailClasses: o["nail-classes"], reference: o.reference, name: o.name, replace: !!o.replace });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const origin = webOrigin(profile, o["web-origin"]);
  if (args[0] === "list")
    return listSessions({ call: await liveSession(profile, { allow: ROUTES, maxRequests: 4 }), deviceId: o["device-id"],
      from: o.from, to: o.to, limit: o.limit, origin });
  if (args[0] === "fetch")
    return fetchSessions({ call: await liveSession(profile, { allow: ROUTES, maxRequests: 1000 }), deviceId: o["device-id"],
      sessions: o.session, latest: o.latest, frames: o.frames, confirm: !!o.confirm, origin, log: line => process.stderr.write(`${line}\n`) });
  throw new Error("Choose list, fetch or prepare");
}

if (isMain(import.meta))
  runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
