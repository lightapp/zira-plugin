#!/usr/bin/env node
// Review Pallet Nails: rank the nail slices most likely to show a rare defect (raised nails by default),
// let a person accept or reject them on a local review page, and export the accepted slices as a
// dataset. Works on QA session slices prepared by evaluate-model's sessions.mjs, or any nails dataset
// folder. Nothing is created or changed in Zira; an exported ZIP is uploaded only if the user does.
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, argValue, id, isMain, originFor, runCli } from "../../../scripts/client.mjs";
import { launchBrowser, webOrigin } from "../../../scripts/datasets.mjs";
import { exec, paths, runtimePython, status } from "../../evaluate-model/scripts/evaluate.mjs";
import { datasetsRoot, sessionsRoot } from "../../evaluate-model/scripts/sessions.mjs";
import { readJsonFile, startReview, tally } from "./review.mjs";
import { createWorkspace } from "./workspace.mjs";

const HELP = `Review Pallet Nails — rank likely defect slices, review them, export the accepted ones
node scripts/defects.mjs scan --dataset NAILS_DIR --model FILE [--target raisedNail] [--confidence 0.05]
    [--model-classes a,b,c] [--limit N] [--out RUN_DIR] [--frames-root ORIGINAL_SESSIONS_DIR] [--device cpu|mps]
node scripts/defects.mjs review [--device-id ID] [--run RUN_DIR] [--compare-run RUN_DIR …] [--open] [--idle-minutes 480] [--stop]
node scripts/defects.mjs others --run RUN_DIR [--confidence 0.25]
node scripts/defects.mjs progress --run RUN_DIR
node scripts/defects.mjs export --run RUN_DIR [--name NAME] [--all-reviewed] [--no-known] [--whole] [--keep-unsure] [--zip]
node scripts/defects.mjs runs

scan runs a model that knows the defect class at a low confidence over every slice and ranks the
candidates (slices a reviewer marked as a nails defect are raised; boxes already labeled with the
defect are kept as known examples). review serves the run on 127.0.0.1 (printing its url) and saves
each decision as it is made. The page runs as its own process until it has been idle for --idle-minutes
(8 hours by default), so it outlives the command that started it; starting it again replaces it at the
same address, and --stop ends it. With --device-id the
page also lists the camera's dataset versions, QA sessions and models, so the person can start a
search there and open earlier ones. Slices also show the model's other detections (nails, flush
nails, knots) where nothing is labeled, so a nail the camera missed can be marked too; others adds them
to a run scanned before that, keeping its decisions. progress counts the decisions. export writes the accepted slices, every other nail labeled as in the reference, as a
YOLO dataset; --whole writes every slice of the scanned dataset with the decisions applied and its
splits kept (a corrected version, e.g. relabeling nails as raised nails in a training set); --zip also
puts <name>.zip in Downloads for Zira's Add dataset upload.
Exit 0 success, 2 invalid/failed, 4 blocked (JSON explains).
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const FINDER = path.join(here, "find_defects.py");
export const runsRoot = (env = process.env) => path.join(paths(env).base, "defect-runs");
export const exportsRoot = (env = process.env) => path.join(paths(env).base, "defect-datasets");
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

async function ready(env) {
  const r = await status({ env });
  if (!r.runtime.ready) throw new Blocked("runtime_missing", "The local model runtime is not set up yet. Run evaluate-model's `evaluate.mjs setup` once (it downloads about 30 MB of Python packages; ask the user first).");
  return r;
}

const pythonError = r => r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? `failed: ${r.err.trim().split("\n").slice(-2).join(" ")}`;

// Session slices remember their camera in the path, so the review page can show a slice on its pallet.
export function framesRootFor(dataset, env = process.env) {
  const relative = path.relative(datasetsRoot(env), path.resolve(dataset));
  const [deviceId] = relative.split(path.sep);
  return !relative.startsWith("..") && /^[1-9]\d*$/.test(deviceId ?? "") ? path.join(sessionsRoot(env), deviceId) : null;
}

export async function scan({ dataset, model, target = "raisedNail", confidence = 0.05, modelClasses, limit, deviceId, device = "cpu", env = process.env,
  out: outputDir, framesRoot, execImpl = exec, now = () => new Date(), log = line => process.stderr.write(`${line}\n`) }) {
  if (!dataset || !model) throw new Error("--dataset and --model are required");
  if (!String(target).split(",").every(t => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(t))) throw new Error("--target must be a class name or comma-separated class names");
  await ready(env);
  let classes = modelClasses ? String(modelClasses) : null;
  if (!classes) {
    try { classes = (JSON.parse(await readFile(`${path.resolve(model)}.zira.json`, "utf8")).labels ?? []).join(",") || null; }
    catch { /* not fetched through Zira */ }
  }
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const out = outputDir ? path.resolve(outputDir) : path.join(runsRoot(env), `${stamp}-${String(target).split(",").join("-")}`);
  if (existsSync(path.join(out, "candidates.json"))) throw new Error(`${out} already has a run; reopen it with review --run or choose a new --out`);
  await mkdir(path.dirname(out), { recursive: true });
  const frames = framesRoot ? path.resolve(framesRoot) : framesRootFor(dataset, env);
  const args = [FINDER, "scan", "--dataset", path.resolve(dataset), "--model", path.resolve(model), "--target", target,
    "--confidence", String(confidence), "--out", out, "--progress", ...(classes ? ["--model-classes", classes] : []),
    ...(limit ? ["--limit", String(limit)] : []), ...(frames ? ["--frames-root", frames] : []),
    ...(id(String(deviceId ?? "")) ? ["--device-id", String(deviceId)] : []),
    // A .pt model can run on an Apple GPU; .tflite always runs on the CPU.
    ...(device === "mps" && /\.pt$/i.test(model) ? ["--device", "mps"] : [])];
  let last = 0;
  const r = await execImpl(runtimePython(paths(env)), args, { onLine: line => {
    try {
      const e = JSON.parse(line);
      if (e.event === "start") log(`Looking for ${e.target} in ${e.total} slices with ${e.model}…`);
      if (e.event === "slice" && (e.done === e.total || e.done - last >= Math.max(1, Math.ceil(e.total / 10)))) { last = e.done; log(`  ${e.done}/${e.total}`); }
    } catch { /* not a progress line */ }
  } });
  if (r.code !== 0) {
    const message = pythonError(r);
    if (/has no .* class|no class names/.test(message)) throw new Blocked("model_classes", message);
    throw new Error(message);
  }
  return { ...JSON.parse(r.out), next: `node scripts/defects.mjs review --run "${out}" --open` };
}

// The model's other detections for an earlier run's review slices; candidates and decisions are kept.
export async function addOthers({ run, confidence = 0.25, env = process.env, execImpl = exec, log = line => process.stderr.write(`${line}\n`) }) {
  const summary = await progress({ run });
  await ready(env);
  let last = 0;
  const r = await execImpl(runtimePython(paths(env)), [FINDER, "others", "--run", summary.run, "--confidence", String(confidence), "--progress"], { onLine: line => {
    try {
      const e = JSON.parse(line);
      if (e.event === "start") log(`Adding ${e.model}'s other detections to ${e.total} slices…`);
      if (e.event === "slice" && (e.done === e.total || e.done - last >= Math.max(1, Math.ceil(e.total / 5)))) { last = e.done; log(`  ${e.done}/${e.total}`); }
    } catch { /* not a progress line */ }
  } });
  if (r.code !== 0) throw new Error(pythonError(r));
  return { ...JSON.parse(r.out), note: "Reload the review page to see them." };
}

const SELF = fileURLToPath(import.meta.url);
const reviewHelperFile = ({ deviceId, run }) => deviceId ? path.join(runsRoot(), `review-${deviceId}.json`) : path.join(path.resolve(String(run)), "review.json");

async function liveReview(file) {
  const state = await readJsonFile(file, {});
  if (!state.port || !state.token) return null;
  const url = `http://127.0.0.1:${state.port}/r/${state.token}/`;
  try { return (await fetch(`${url}state`, { signal: AbortSignal.timeout(800) })).ok ? { url, pid: state.pid ?? null } : null; } catch { return null; }
}

// Ends a running review page. Only a page that answers at its recorded address is stopped, so a reused
// process ID never ends anything else.
export async function stopReview({ deviceId, run }) {
  const live = await liveReview(reviewHelperFile({ deviceId, run }));
  if (!live?.pid) return { kind: "zira.defect-review-stopped", stopped: false };
  try { process.kill(live.pid, "SIGTERM"); } catch { return { kind: "zira.defect-review-stopped", stopped: false }; }
  for (let i = 0; i < 50; i += 1) {
    try { process.kill(live.pid, 0); } catch { return { kind: "zira.defect-review-stopped", stopped: true }; }
    await new Promise(r => setTimeout(r, 100));
  }
  return { kind: "zira.defect-review-stopped", stopped: false, note: "The page did not stop within 5 seconds." };
}

// Starts the review page as its own process, so it keeps running after the command (or a chat tool's
// job, which is stopped after 30 minutes) ends: until it has been idle for idleMinutes. A page already
// running for the same camera or run is replaced, keeping its address.
export async function reviewDetached({ deviceId, run, compareRuns = [], profile, webOrigin: origin, idleMinutes, waitMs = 20000 }) {
  const file = reviewHelperFile({ deviceId, run });
  await stopReview({ deviceId, run });
  await mkdir(path.dirname(file), { recursive: true });
  const logFile = file.replace(/\.json$/, ".log");
  const log = await open(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [SELF, "review", ...(run ? ["--run", path.resolve(String(run))] : []), ...(deviceId ? ["--device-id", String(deviceId)] : []),
      ...compareRuns.flatMap(dir => ["--compare-run", path.resolve(dir)]), "--profile", profile, ...(origin ? ["--web-origin", origin] : []), "--idle-minutes", String(idleMinutes), "--foreground"],
    { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
    let exited = null;
    child.once("exit", code => { exited = code ?? 1; });
    child.unref();
    for (const end = Date.now() + waitMs; Date.now() < end && exited === null;) {
      await new Promise(r => setTimeout(r, 200));
      const live = await liveReview(file);
      if (live && live.pid === child.pid) {
        return { kind: "zira.defect-review", url: live.url, idleMinutes, pid: child.pid, log: logFile, ...(run ? tally((await readJsonFile(path.join(path.resolve(String(run)), "candidates.json"), {})), (await readJsonFile(path.join(path.resolve(String(run)), "decisions.json"), {})).decisions ?? {}) : {}),
          note: `The page keeps running until it has been idle for ${idleMinutes} minutes; decisions save as they are made. Run review --stop to end it.` };
      }
    }
    const tail = (await readFile(logFile, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ");
    if (exited === null) child.kill();
    throw new Error(`The review page did not start${tail ? `: ${tail}` : ""}`);
  } finally {
    await log.close();
  }
}

export async function progress({ run }) {
  const dir = path.resolve(String(run ?? ""));
  const data = await readJsonFile(path.join(dir, "candidates.json"), null);
  if (data?.format !== "zira.defect-candidates") throw new Error("--run must be a find-defects run folder");
  const decisions = (await readJsonFile(path.join(dir, "decisions.json"), {})).decisions ?? {};
  return { kind: "zira.defect-progress", run: dir, target: data.target, model: data.model.name, createdAt: data.createdAt ?? null,
    dataset: data.dataset.name ?? path.basename(data.dataset.path), ...(data.dataSourceId ? { dataSourceId: data.dataSourceId } : {}),
    ...tally(data, decisions) };
}

// Recent runs, newest first; with a camera, its own runs and runs from before cameras were recorded.
export async function runs({ env = process.env, deviceId } = {}) {
  const root = runsRoot(env);
  const found = [];
  for (const name of (await readdir(root).catch(() => [])).sort().reverse()) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, "candidates.json"))) continue;
    const row = await progress({ run: dir }).catch(() => null);
    if (row && (!deviceId || !row.dataSourceId || row.dataSourceId === String(deviceId))) found.push(row);
    if (found.length >= 20) break;
  }
  return { kind: "zira.defect-runs", runs: found };
}

export async function exportRun({ run, name, allReviewed = false, known = true, whole = false, keepUnsure = false, zip = false, env = process.env, execImpl = exec, now = () => new Date() }) {
  const summary = await progress({ run });
  await ready(env);
  const label = name || `${summary.target}-found-${now().toISOString().slice(0, 10)}`;
  if (!NAME.test(label)) throw new Error("--name must be letters, digits, dots, dashes or underscores");
  const archive = zip ? path.join(paths(env).downloads, `${label}.zip`) : null;
  if (archive && existsSync(archive)) throw new Error(`${archive} already exists; choose another --name`);
  await mkdir(exportsRoot(env), { recursive: true });
  const r = await execImpl(runtimePython(paths(env)), [FINDER, "export", "--run", summary.run, "--out", exportsRoot(env), "--name", label,
    ...(allReviewed ? ["--all-reviewed"] : []), ...(known ? [] : ["--no-known"]), ...(whole ? ["--whole"] : []), ...(keepUnsure ? ["--keep-unsure"] : []), ...(archive ? ["--zip", archive] : [])]);
  if (r.code !== 0) {
    const message = pythonError(r);
    if (/no accepted slices/.test(message)) throw new Blocked("nothing_accepted", "No slices are accepted yet. Review some candidates first; decisions are saved as they are made.");
    throw new Error(message);
  }
  const result = JSON.parse(r.out);
  return { ...result, ...(archive ? { upload: {
    file: archive,
    steps: ["Open the camera's Datasets tab in Zira", "Click Add dataset → Upload dataset version (ZIP)", `Choose ${path.basename(archive)} from Downloads`, "Click Create"],
    note: whole ? "This is the whole dataset with the corrections; upload it as a new version of that dataset."
      : "Merge it with the training dataset in Zira before training, so the model still sees every class.",
  } } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    dataset: { type: "string" }, model: { type: "string" }, target: { type: "string" }, confidence: { type: "string" },
    "model-classes": { type: "string" }, limit: { type: "string" }, run: { type: "string" }, "compare-run": { type: "string", multiple: true }, open: { type: "boolean" },
    "idle-minutes": { type: "string" }, name: { type: "string" }, "all-reviewed": { type: "boolean" }, "no-known": { type: "boolean" },
    zip: { type: "boolean" }, whole: { type: "boolean" }, "keep-unsure": { type: "boolean" }, profile: { type: "string" },
    "device-id": { type: "string" }, "web-origin": { type: "string" }, device: { type: "string" },
    foreground: { type: "boolean" }, stop: { type: "boolean" },
    out: { type: "string" }, "frames-root": { type: "string" },
  } });
  switch (args[0]) {
    case "scan": {
      const confidence = o.confidence ? Number(o.confidence) : 0.05;
      if (!(confidence > 0 && confidence < 1)) throw new Error("--confidence must be between 0 and 1");
      if (o.limit && !/^[1-9]\d*$/.test(o.limit)) throw new Error("--limit must be a positive number");
      if (o.device && !["cpu", "mps"].includes(o.device)) throw new Error("--device must be cpu or mps");
      return scan({ dataset: o.dataset, model: o.model, target: o.target, confidence, modelClasses: o["model-classes"], limit: o.limit,
        deviceId: o["device-id"], device: o.device, out: o.out, framesRoot: o["frames-root"] });
    }
    case "review": {
      const idleMinutes = o["idle-minutes"] ? Number(o["idle-minutes"]) : 480;
      if (!(idleMinutes >= 1 && idleMinutes <= 720)) throw new Error("--idle-minutes must be 1-720");
      if (!o.run && !o["device-id"]) throw new Error("Give --device-id (to choose what to search on the page) and/or --run");
      if (o["device-id"] && !id(o["device-id"])) throw new Error("--device-id must be a data source ID");
      if (o.stop) return stopReview({ deviceId: o["device-id"], run: o.run });
      if (!o.foreground) {
        const out = await reviewDetached({ deviceId: o["device-id"], run: o.run, profile: o.profile ?? process.env.ZIRA_PROFILE ?? "prod",
          webOrigin: o["web-origin"], idleMinutes, compareRuns: o["compare-run"] ?? [] });
        if (o.open) await launchBrowser(out.url);
        return out;
      }
      const log = line => process.stderr.write(`${line}\n`);
      const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
      let workspace = null, listRuns = null, helperFile;
      if (o["device-id"]) {
        originFor(profile);
        const deviceId = o["device-id"];
        workspace = createWorkspace({ deviceId, profile, origin: webOrigin(profile, o["web-origin"]),
          scan: options => scan({ ...options, log: options.log ?? log }) });
        listRuns = async () => (await runs({ deviceId })).runs;
        await mkdir(runsRoot(), { recursive: true });
        helperFile = path.join(runsRoot(), `review-${deviceId}.json`);
      }
      const helper = await startReview({ run: o.run, compareRuns: o["compare-run"] ?? [], workspace, runs: listRuns, helperFile, idleMinutes, log });
      console.log(JSON.stringify({ kind: "zira.defect-review", url: helper.url, idleMinutes, ...(helper.tally ?? {}),
        note: "Open url in the browser; decisions save as they are made. Stop this process to end it." }));
      if (o.open) await launchBrowser(helper.url);
      for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => helper.close());
      await helper.closed;
      return { kind: "zira.defect-review-stopped" };
    }
    case "others": {
      const confidence = o.confidence ? Number(o.confidence) : 0.25;
      if (!(confidence > 0 && confidence < 1)) throw new Error("--confidence must be between 0 and 1");
      return addOthers({ run: o.run, confidence });
    }
    case "progress": return progress({ run: o.run });
    case "runs": return runs();
    case "export": return exportRun({ run: o.run, name: o.name, allReviewed: !!o["all-reviewed"], known: !o["no-known"], whole: !!o.whole, keepUnsure: !!o["keep-unsure"], zip: !!o.zip });
    default: throw new Error("Choose scan, review, others, progress, export or runs");
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
