// Camera view over time for Validate Trimsaw Sizes: lists a trimsaw camera's raw recordings in Zira
// (read-only), picks one per recording window, downloads them into a private cache, runs
// scene_drift.py in a local runtime the user agreed to install, and turns its scene.json into a
// report section. Nothing is written to Zira or the camera.
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Blocked, liveSession } from "../../../scripts/client.mjs";
import {
  LIST_LIMIT, RAW_VIDEO_ROUTES, confirmDownload, downloadRawVideos, listOrExplain, parseRawVideoName,
} from "../../../scripts/raw-videos.mjs";
import { exec, findPython } from "../../evaluate-model/scripts/evaluate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILES = { analyzer: path.join(here, "scene_drift.py"), requirements: path.join(here, "requirements-scene.txt") };
export const PER_DAY = 3; // recording windows per day by default: the day's first, middle and last
export const MAX_CLIPS = 16; // about 650 MB of 5-minute 640x360 clips
export const MAX_DAYS = 31;
export const MIN_CLIP_BYTES = 1024 ** 2; // under about 10 s of video: too few frames for a steady median
export const MIN_PYTHON_MINOR = 11; // NumPy 2.3
export const BURST_GAP_MIN = 15; // a new recording window starts after a gap this long…
export const WINDOW_MIN = 60; // …or this long after the window's first clip
const SIDES = ["TOP", "BOTTOM", "LEFT", "RIGHT"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const RULE = `One clip per recording window: the first recording of each run of clips in a recording session with under ${BURST_GAP_MIN} minutes `
  + `between starts, split every ${WINDOW_MIN} minutes, from 1 MB up. With more windows than --per-day (default ${PER_DAY}) on a day, the day's first, last and evenly spaced ones between; `
  + `at most ${MAX_CLIPS} clips, thinned evenly. The earliest selected clip is the reference unless --reference names another.`;

export function scenePaths(env = process.env) {
  const base = env.ZIRA_TRIMSAW_SCENE_HOME ? path.resolve(env.ZIRA_TRIMSAW_SCENE_HOME)
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "zira", "trimsaw-scene");
  return { base, runtime: path.join(base, "runtime"), clips: path.join(base, "clips"), runs: path.join(base, "runs") };
}
export const runtimePython = p => path.join(p.runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const sha = async file => createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);
const packages = async () => (await readFile(FILES.requirements, "utf8")).split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));

// Instant readiness check: the runtime exists and was built from the current requirements.
export async function runtimeStatus({ env = process.env } = {}) {
  const p = scenePaths(env);
  let marker = null;
  try { marker = JSON.parse(await readFile(path.join(p.runtime, ".zira-runtime.json"), "utf8")); } catch { /* not built */ }
  const built = Boolean(marker) && existsSync(runtimePython(p));
  const ready = built && marker.requirements === await sha(FILES.requirements);
  return { ready, path: p.runtime, ...(built && !ready ? { outdated: true } : {}), ...(ready ? { python: marker.python } : {}) };
}

// Without --confirm this only says what it would install; with it, it builds the runtime once.
export async function sceneSetup({ confirm = false, env = process.env, run = spawnSync, execImpl = exec, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const p = scenePaths(env);
  const status = await runtimeStatus({ env });
  const base = { kind: "trimsaw-scene-setup", path: p.runtime, packages: await packages() };
  if (status.ready) return { ...base, ready: true, applied: false, python: status.python, note: "The camera-view runtime is already set up." };
  const python = findPython(run, undefined, { minMinor: MIN_PYTHON_MINOR });
  if (!confirm)
    return { ...base, ready: false, applied: false, ...(status.outdated ? { outdated: true } : {}), python,
      download: "About 30-60 MB of Python packages from PyPI (PyAV with its FFmpeg libraries, NumPy, Pillow), into the folder above only.",
      next: python ? "Ask the user once whether to set it up; run scene-setup --confirm only after they agree."
        : `Python 3.${MIN_PYTHON_MINOR} or newer is needed first (for example from python.org).` };
  if (!python) throw new Blocked("python_missing", `Python 3.${MIN_PYTHON_MINOR} or newer is required for the camera-view check. Install it (for example from python.org), then run scene-setup again.`);
  await mkdir(p.base, { recursive: true, mode: 0o700 });
  for (const [cmd, args] of [[python.command, ["-m", "venv", "--clear", p.runtime]],
    [runtimePython(p), ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", FILES.requirements]]]) {
    const r = await execImpl(cmd, args, { onLine: log });
    if (r.code !== 0) throw new Error(`Runtime setup failed: ${(r.err || r.out).trim().split("\n").slice(-3).join(" ")}`);
  }
  await writeFile(path.join(p.runtime, ".zira-runtime.json"), JSON.stringify({ python: python.version, requirements: await sha(FILES.requirements), builtAt: new Date().toISOString() }, null, 2));
  return { ...base, ready: true, applied: true, python: python.version };
}

// ---------- choosing clips ----------

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
export function dayList(from, to) {
  if (!DAY.test(from ?? "")) throw new Error("--from is a site-local day, YYYY-MM-DD");
  if (!DAY.test(to ?? "")) throw new Error("--to is a site-local day, YYYY-MM-DD");
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || isoDay(a) !== from || isoDay(b) !== to) throw new Error("--from and --to must be real days");
  if (b < a) throw new Error("--to must not be before --from");
  const days = [];
  for (let t = a; t <= b; t += 86400e3) days.push(isoDay(t));
  if (days.length > MAX_DAYS) throw new Error(`Choose at most ${MAX_DAYS} days`);
  return days;
}

const recorded = v => v.recordedAtLocal ?? parseRawVideoName(v.name ?? v.file)?.recordedAtLocal ?? null;
const evenly = (items, n) => (items.length <= n ? items
  : n === 1 ? [items[0]] : [...new Set(Array.from({ length: n }, (_, i) => Math.round((i * (items.length - 1)) / (n - 1))))].map(i => items[i]));

/**
 * The clips to compare. By default the first recording of each recording window: a run of clips in
 * one session with under BURST_GAP_MIN minutes between starts (a "record N videos" burst), split every
 * WINDOW_MIN minutes of continuous recording. At most `perDay` windows per day, spread over it, and
 * `maxClips` overall; with `names`, exactly those. The reference is always included.
 */
export function selectClips(videos, { perDay = PER_DAY, names = null, reference = null, maxClips = MAX_CLIPS, minBytes = MIN_CLIP_BYTES } = {}) {
  const usable = videos.filter(v => recorded(v)).sort((a, b) => recorded(a).localeCompare(recorded(b)) || (a.part ?? 0) - (b.part ?? 0) || a.file.localeCompare(b.file));
  const find = n => usable.find(v => v.file === n || v.name === n);
  let ref = null;
  if (reference) {
    ref = find(reference);
    if (!ref) throw new Blocked("video_not_listed", `--reference ${reference} is not among the listed raw recordings; widen --from/--to.`);
  }
  if (names?.length) {
    const picked = names.map(n => { const v = find(n); if (!v) throw new Blocked("video_not_listed", `${n} is not among the listed raw recordings; widen --from/--to.`); return v; });
    const all = ref && !picked.includes(ref) ? [ref, ...picked] : picked;
    return { clips: [...new Set(all)].sort((a, b) => recorded(a).localeCompare(recorded(b))), windows: null, thinned: false };
  }
  const minutes = v => Date.parse(`${recorded(v)}Z`) / 60000;
  const firsts = [], open = new Map(); // session → its current window: first and last start, chosen clip
  for (const v of usable) {
    const key = `${v.day}|${v.session}`, at = minutes(v);
    let w = open.get(key);
    if (w && at - w.last < BURST_GAP_MIN && at - w.first < WINDOW_MIN) w.last = at;
    else open.set(key, w = { first: at, last: at, pick: null });
    if (!w.pick && v.size >= minBytes) firsts.push(w.pick = v); // the first clip of the window that is not tiny
  }
  firsts.sort((a, b) => recorded(a).localeCompare(recorded(b)));
  const byDay = new Map();
  for (const v of firsts) byDay.set(v.day, [...(byDay.get(v.day) ?? []), v]);
  let clips = [...byDay.values()].flatMap(list => evenly(list, perDay));
  let thinned = false;
  if (clips.length > maxClips) { clips = evenly(clips, maxClips); thinned = true; }
  if (ref && !clips.includes(ref)) clips = [ref, ...clips].sort((a, b) => recorded(a).localeCompare(recorded(b)));
  return { clips, windows: firsts.length, thinned };
}

// ---------- the scene command ----------

export function parseStopsArg(text) {
  if (text === undefined || text === null || text === "") return null;
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('--stops is a JSON object of stop size to analysis px, such as {"42":126.9,"40":131.6}'); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length)
    throw new Error('--stops is a JSON object of stop size to analysis px, such as {"42":126.9,"40":131.6}');
  for (const [k, v] of Object.entries(raw))
    if (!(Number(k) > 0) || typeof v !== "number" || !Number.isFinite(v) || v < -320 || v > 640) throw new Error(`--stops entry ${k}: ${v} is not a stop size with its analysis px position`);
  return raw;
}

export function sceneArgs(o) {
  const local = o.files !== undefined;
  if (local === (o.dataSourceId !== undefined)) throw new Error("scene needs --data-source-id ID (recordings in Zira) or --files A.mp4,B.mp4 (clips on this computer)");
  if (!local && !/^[1-9]\d*$/.test(String(o.dataSourceId))) throw new Error("--data-source-id is a data source ID");
  if (o.names !== undefined && o.perDay !== undefined) throw new Error("Give --names or --per-day, not both");
  const perDay = o.perDay === undefined ? PER_DAY : Number(o.perDay);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 24) throw new Error("--per-day is a whole number from 1 to 24");
  const inPerPx = o.inPerPx === undefined ? null : Number(o.inPerPx);
  if (inPerPx !== null && !(inPerPx > 0 && inPerPx < 5)) throw new Error("--in-per-px is the camera's scale in inches per analysis px, such as 0.367");
  const stopSide = o.stopSide === undefined ? null : String(o.stopSide).toUpperCase();
  if (stopSide !== null && !SIDES.includes(stopSide)) throw new Error("--stop-side is TOP, BOTTOM, LEFT or RIGHT");
  const list = s => String(s ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const names = o.names === undefined ? null : list(o.names);
  if (names && !names.length) throw new Error("--names is empty");
  const files = local ? list(o.files) : null;
  if (local) {
    if (files.length < 2) throw new Error("--files needs at least two clips: the reference and one to compare");
    for (const f of files) if (!f.toLowerCase().endsWith(".mp4")) throw new Error(`Not an .mp4 file: ${f}`);
    if (new Set(files.map(f => path.basename(f))).size !== files.length) throw new Error("--files names must be unique");
    if (o.from !== undefined || o.to !== undefined || names || o.perDay !== undefined) throw new Error("--files takes the clips as given; --from, --to, --names and --per-day are for recordings in Zira");
  }
  return { local, files, names, perDay, inPerPx, stopSide, stops: parseStopsArg(o.stops) };
}

const today = now => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const stamp = now => new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
const brief = c => ({ clip: c.clip, recordedAt: c.recordedAt ?? null, verdict: c.verdict, shiftPx: c.shiftPx ?? null, readsIn: c.readsIn ?? null,
  rotDeg: c.transform?.rotDeg ?? null, matched: c.transform && !c.reference ? `${c.transform.patches}/${c.transform.of}` : null,
  ...(c.verdict === "uncertain" ? { why: c.why } : {}) });

export async function scene({
  dataSourceId, from, to, names, perDay, reference, stops, inPerPx, stopSide, out, confirm = false, list = false, files, profile = "prod",
  call, env = process.env, fetchImpl, execImpl = exec, log = line => process.stderr.write(`${line}\n`), now = Date.now(),
}) {
  const a = sceneArgs({ dataSourceId, from, to, names, perDay, inPerPx, stopSide, stops, files });
  const p = scenePaths(env);
  if (!list) {
    const status = await runtimeStatus({ env });
    if (!status.ready)
      throw new Blocked("runtime_missing", "The camera-view check's local runtime is not set up yet. Run scene-setup to see what it installs, ask the user, then run scene-setup --confirm.",
        { setup: "scene-setup", ...(status.outdated ? { outdated: true } : {}) });
  }
  const notes = [];
  let clipFiles, selection = null, id = null;
  if (a.local) {
    clipFiles = a.files.map(f => path.resolve(f));
    for (const f of clipFiles) if (!(await stat(f).catch(() => null))?.isFile()) throw new Error(`Not a file: ${f}`);
    for (const f of clipFiles) if (!parseRawVideoName(f)) notes.push(`${path.basename(f)} has no recording time in its name; it is ordered by name.`);
    if (reference && !clipFiles.some(f => f === path.resolve(reference) || path.basename(f) === reference)) throw new Error("--reference must be one of --files");
  } else {
    id = String(dataSourceId);
    if (from === undefined) throw new Error("scene needs --from DAY (site-local, YYYY-MM-DD)");
    const days = dayList(from, to ?? today(now));
    const session = call ?? await liveSession(profile, { allow: RAW_VIDEO_ROUTES, maxRequests: 2 * days.length + 6 });
    const listed = [], truncated = [];
    for (const day of days) {
      const r = await listOrExplain(session, id, { from: day, to: day, limit: LIST_LIMIT }, { profile });
      listed.push(...r.videos);
      if (r.hasMore) truncated.push(day);
    }
    if (truncated.length) notes.push(`More than ${LIST_LIMIT} recordings on ${truncated.join(", ")}: only the latest ${LIST_LIMIT} of ${truncated.length > 1 ? "each" : "that day"} were listed, so its earliest windows may be missing.`);
    const pick = selectClips(listed, { perDay: a.perDay, names: a.names, reference });
    if (pick.thinned) notes.push(`More than ${MAX_CLIPS} recording windows: thinned evenly to ${MAX_CLIPS}. Narrow --from/--to or lower --per-day to choose.`);
    selection = { rule: a.names ? "The clips named with --names." : RULE, listed: listed.length, windows: pick.windows,
      clips: pick.clips.map(v => ({ file: v.file, recordedAt: recorded(v), session: v.session, part: v.part ?? null, sizeMB: Math.round(v.size / 1048576) })) };
    const bytes = pick.clips.reduce((n, v) => n + (v.size ?? 0), 0);
    if (list || pick.clips.length < 2) {
      const result = { kind: "trimsaw-scene-clips", dataSourceId: id, days: [days[0], days.at(-1)], selection, downloadMB: Math.round(bytes / 1048576), notes };
      if (list) return { ...result, next: "Run scene without --list to download these into the private cache and compare them." };
      throw new Blocked("too_few_clips", `Zira lists ${listed.length} raw recording${listed.length === 1 ? "" : "s"} from ${days[0]} to ${days.at(-1)}, giving ${pick.clips.length} clip${pick.clips.length === 1 ? "" : "s"} to compare; at least two are needed. Widen --from/--to, or record clips first.`, result);
    }
    const chosen = pick.clips.map(v => v.file);
    confirmDownload(listed, chosen, confirm);
    const dir = path.join(p.clips, id);
    const chosenDays = [...new Set(pick.clips.map(v => v.day))];
    const relist = async () => (await Promise.all(chosenDays.map(day => listOrExplain(session, id, { from: day, to: day, limit: LIST_LIMIT }, { profile })))).flatMap(r => r.videos);
    const got = await downloadRawVideos(listed, chosen, dir, { relist, fetchImpl, log });
    selection.downloaded = got.downloaded.length; selection.alreadyPresent = got.alreadyPresent.length; selection.folder = dir;
    clipFiles = chosen.map(f => path.join(dir, path.basename(f)));
    if (reference) reference = path.basename(pick.clips.find(v => v.file === reference || v.name === reference).file);
  }
  const folder = out ? path.resolve(out) : path.join(p.runs, id ?? "local", stamp(now));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const args = ["-I", FILES.analyzer, "--out", folder, "--progress",
    ...(reference ? ["--reference", path.basename(reference)] : []), ...(a.stops ? ["--stops", JSON.stringify(a.stops)] : []),
    ...(a.inPerPx !== null ? ["--in-per-px", String(a.inPerPx)] : []), ...(a.stopSide ? ["--stop-side", a.stopSide] : []), ...clipFiles];
  log(`Comparing ${clipFiles.length} recordings…`);
  const r = await execImpl(runtimePython(p), args, { onLine: line => {
    try {
      const e = JSON.parse(line);
      if (e.event === "clip") log(`  snapshot ${e.done + 1}/${e.total}: ${e.clip}`);
    } catch { /* not a progress line */ }
  } });
  if (r.code === 2) throw new Error(`The camera-view analysis refused its input: ${r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? "see stderr"}`);
  if (![0, 3].includes(r.code)) throw new Error(`The camera-view analysis failed: ${(r.err || r.out).trim().split("\n").slice(-3).join(" ")}`);
  const sceneFile = path.join(folder, "scene.json");
  const data = JSON.parse(await readFile(sceneFile, "utf8"));
  if (data.failed?.length) notes.push(`Could not read ${data.failed.join(", ")}; ${data.failed.length > 1 ? "they are" : "it is"} marked uncertain.`);
  return {
    kind: "trimsaw-scene", ...(id ? { dataSourceId: id } : {}), scene: sceneFile, folder, reference: data.reference, referenceAt: data.referenceAt,
    mapping: { rotation: data.mapping.rotation, rotationSource: data.mapping.rotationSource, axis: data.mapping.axis, stopSide: data.mapping.stopSide,
      sideSource: data.mapping.sideSource, note: data.mapping.note },
    inPerPx: data.inPerPx, summary: data.summary, clips: data.clips.map(brief), ...(selection ? { selection } : {}), notes,
    complete: r.code === 0 && !data.failed?.length,
    next: `Add it to the report: report --dataset ID --from LOCAL --to LOCAL --scene ${sceneFile}`,
  };
}

// ---------- report section ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 2.5 * 1024 ** 2;
const MAX_THUMBNAILS = 12;
const VERDICT_WORDS = { reference: "Reference", steady: "Steady", view_moved: "View moved", camera_turned: "View moved", part_moved: "Part of the view moved", uncertain: "Uncertain" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (at, clip) => (at ? `${MONTHS[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))} ${at.slice(11, 16)}` : clip);
const signed = (v, d = 2) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`);

export async function readScene(file) {
  const resolved = path.resolve(String(file ?? ""));
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile() || info.size > 4 * 1024 ** 2) throw new Error("--scene must be a scene.json written by the scene command");
  let data;
  try { data = JSON.parse(await readFile(resolved, "utf8")); } catch { throw new Error("--scene is not valid JSON"); }
  if (data?.kind !== "trimsaw-scene" || data.version !== 1 || !Array.isArray(data.clips) || !data.summary)
    throw new Error("--scene must be a scene.json written by the scene command (version 1)");
  return { scene: data, dir: path.dirname(resolved) };
}

// Only flat PNG names inside the scene's own folder, as the analyzer writes them.
async function pngData(dir, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.png$/.test(name)) return null;
  const file = path.join(dir, name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_PNG_BYTES) return null;
  const bytes = await readFile(file);
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? `data:image/png;base64,${bytes.toString("base64")}` : null;
}

/** The report's "Camera view over time" section from a scene.json, with its pictures embedded. */
export async function sceneSection(file) {
  const { scene: s, dir } = await readScene(file);
  const clips = [...s.clips].sort((a, b) => String(a.recordedAt ?? a.clip).localeCompare(String(b.recordedAt ?? b.clip)));
  const sum = s.summary, inches = s.inPerPx !== null && s.inPerPx !== undefined && s.mapping?.readingSign != null;
  const largest = clips.find(c => c.clip === sum.largest) ?? null;
  const ref = clips.find(c => c.reference) ?? null;
  const shown = clips.length <= MAX_THUMBNAILS ? clips
    : [...new Set([ref, largest, ...Array.from({ length: MAX_THUMBNAILS }, (_, i) => clips[Math.round((i * (clips.length - 1)) / (MAX_THUMBNAILS - 1))])].filter(Boolean))]
      .slice(0, MAX_THUMBNAILS).sort((a, b) => clips.indexOf(a) - clips.indexOf(b));
  const images = [];
  for (const c of shown) {
    const src = await pngData(dir, c.snapshot);
    if (!src) continue;
    const amount = c.reference ? "reference" : c.shiftPx === null || c.shiftPx === undefined ? "not compared"
      : `${signed(c.shiftPx)} px${inches && c.readsIn !== null ? ` (${signed(c.readsIn)} in.)` : ""}`;
    images.push({ src, caption: `${when(c.recordedAt, c.clip)} · ${amount}`, alt: `Scene snapshot of the recording at ${when(c.recordedAt, c.clip)}`, width: 180 });
  }
  if (largest) {
    const overlay = await pngData(dir, largest.overlay), zoomed = await pngData(dir, largest.zoom);
    if (overlay) images.push({ src: overlay, width: 360, caption: `Edges of ${when(largest.recordedAt, largest.clip)} (cyan) over the reference ${when(ref?.recordedAt, ref?.clip)} (red); white where they line up.`,
      alt: "Edge overlay of the largest shift against the reference" });
    if (zoomed) images.push({ src: zoomed, width: 288, caption: "Enlarged 3x: when the view moved, every edge shows the same red/cyan fringe in the same direction.",
      alt: "Enlarged part of the edge overlay" });
  }
  const along = s.stops ? "at the stop lines" : "at the frame's centre line";
  const text = [
    `**${sum.sentence}**`, "",
    `Each picture is the median of about ${s.thresholds?.samples ?? 300} frames of one raw recording, so boards passing through drop out and the floor, machine and stops stay. Every recording is matched to the reference (${when(ref?.recordedAt, ref?.clip)}) on steady details only, and the shift is measured along the stop axis of the camera's 320 px analysis frame, ${along}. ${inches ? `At the camera's ${s.inPerPx} in. per px, a 1 px shift changes a board's reading by ${s.inPerPx} in. (negative reads shorter).` : "No scale or stop side was given, so shifts are in px only."} Below ${s.thresholds?.steadyPx ?? 0.5} px nothing that matters changes.`,
    "",
    "The camera's own \"camera moved\" status comes from its tilt sensors (more than 2 degrees for 5 minutes) and misses turns this small; it is not reset when stops are applied or edited.",
  ].join("\n");
  const rows = clips.map(c => [when(c.recordedAt, c.clip), c.reference ? "0 (reference)" : signed(c.shiftPx), inches && !c.reference ? signed(c.readsIn) : c.reference ? "0" : "—",
    c.transform && !c.reference ? signed(c.transform.rotDeg, 3) : "—", c.transform && !c.reference ? `${c.transform.patches} of ${c.transform.of}` : "—",
    c.verdict === "uncertain" ? `Uncertain: ${c.why ?? ""}`.trim() : VERDICT_WORDS[c.verdict] ?? c.verdict]);
  return {
    section: { title: "Camera view over time", text, images: images.length ? images : undefined,
      staticTable: { columns: ["Recorded", "Shift along the stop axis (px)", "Reading change (in.)", "Rotation (°)", "Steady details matched", "Verdict"], rows } },
    summary: { ...sum, reference: s.reference, referenceAt: s.referenceAt ?? null, recordings: clips.length, file: path.resolve(file) },
    summaryLines: ["### Camera view over time", "", `- ${sum.sentence}`],
  };
}
