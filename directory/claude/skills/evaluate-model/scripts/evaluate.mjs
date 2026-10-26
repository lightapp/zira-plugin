#!/usr/bin/env node
// Evaluate a Model: get a dataset version and a model from Zira, prepare the local model runtime,
// run the model on the version's images and summarize per-class results. Nothing is written to Zira.
import { allowsPt } from "../../../scripts/build-info.mjs";
import os from "node:os";
import { downloadUrl, fetchDownload } from "../../../scripts/downloads.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, ZiraApiError, argValue, id, isMain, liveSession, originFor, route, runCli } from "../../../scripts/client.mjs";
import { launchBrowser, loadDevice, summarize, webOrigin } from "../../../scripts/datasets.mjs";

const HELP = `Evaluate a Model — run a Zira model on a dataset version on this computer
node scripts/evaluate.mjs status
node scripts/evaluate.mjs setup [--with-pt]
node scripts/evaluate.mjs fetch --device-id ID --file-id ID [--profile prod|integ] [--web-origin URL]
node scripts/evaluate.mjs find-download --name FILE [--dir DIR] [--since ISO]
node scripts/evaluate.mjs run --dataset ZIP_OR_DIR --model FILE [--split val|test|train|all]
    [--limit N] [--allow-class-mismatch]
node scripts/evaluate.mjs open --report REPORT.html
node scripts/evaluate.mjs local-files [--dir DIR]
node scripts/evaluate.mjs choose --kind dataset|folder|model
node scripts/evaluate.mjs inspect [--dataset ZIP_OR_DIR] [--model FILE] [--model-classes a,b,c]

status is instant and offline. setup creates the local model runtime once (downloads Python
packages; --with-pt adds PyTorch for .pt models). fetch downloads one dataset version or
model of the data source through Zira sign-in; when Zira does not allow that download it
stops with the page and file name to download in the browser. manual.then is an argument
array: execute it without a shell; never join its values into shell source. find-download locates that
file in the Downloads folder. run evaluates, prints a summary and saves a JSON report and an
HTML view (image gallery with boxes); open shows that view in the default browser.
local-files suggests recent dataset ZIPs and model files from Downloads; choose opens the
system file dialog so the user can pick one anywhere; inspect checks local
files (classes, splits, model type) before a run. run also accepts local files directly, with
--model-classes naming a .tflite's classes. Nothing is uploaded or changed in Zira.
Exit 0 success, 2 invalid/failed, 3 incomplete (cancelled), 4 blocked (JSON explains).
`;

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILES = {
  evaluator: path.join(here, "model_evaluation.py"),
  requirements: path.join(here, "requirements.txt"),
  pt: path.join(here, "requirements-pt.txt"),
};
export const ROUTES = [["GET", /^\/devices\/all$/], ["GET", /^\/files\/[1-9]\d*$/]];
const PARTIAL = /\.(crdownload|download|part|partial)$/i;

export function paths(env = process.env) {
  const base = env.ZIRA_MODEL_EVAL_HOME
    ? path.resolve(env.ZIRA_MODEL_EVAL_HOME)
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "zira", "model-evaluation");
  return { base, runtime: path.join(base, "runtime"), files: path.join(base, "files"),
    datasets: path.join(base, "datasets"), reports: path.join(base, "reports"),
    downloads: env.ZIRA_DOWNLOADS_DIR ? path.resolve(env.ZIRA_DOWNLOADS_DIR) : path.join(os.homedir(), "Downloads") };
}

export const runtimePython = p => path.join(p.runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const sha = async file => createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 16);

// A Python 3.10+ (or 3.minMinor+) to build a runtime from; the first that answers wins.
export function findPython(run = spawnSync, candidates = [process.env.ZIRA_PYTHON, "python3", "python3.12", "python3.13", "python3.11", "python3.14", "python3.10", "python"], { minMinor = 10 } = {}) {
  for (const cmd of candidates.filter(Boolean)) {
    const r = run(cmd, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" });
    const version = r.status === 0 ? r.stdout.trim() : "";
    const [major, minor] = version.split(".").map(Number);
    if (major === 3 && minor >= minMinor) return { command: cmd, version };
  }
  return null;
}

// Instant readiness check: the runtime exists and was built from the current requirements.
export async function status({ env = process.env, run = spawnSync } = {}) {
  const p = paths(env);
  let marker = null;
  try { marker = JSON.parse(await readFile(path.join(p.runtime, ".zira-runtime.json"), "utf8")); } catch { /* not built */ }
  const current = await sha(FILES.requirements), currentPt = allowsPt() ? await sha(FILES.pt) : null;
  const built = Boolean(marker) && existsSync(runtimePython(p));
  const ready = built && marker.requirements === current;
  return {
    kind: "model-evaluation-status",
    runtime: { ready, path: p.runtime, models: ready ? [".tflite", ...(allowsPt() && marker.pt === currentPt ? [".pt"] : [])] : [],
      ...(built && !ready ? { outdated: true } : {}) },
    python: ready ? { version: marker.python } : findPython(run),
    folders: { cache: p.base, reports: p.reports, downloads: p.downloads },
    ...(ready ? {} : { next: "Run setup once (it downloads Python packages; ask the user first)." }),
  };
}

export function exec(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => {
      err += d;
      if (onLine) for (const line of String(d).split("\n").filter(Boolean)) onLine(line);
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}

export async function setup({ withPt = false, env = process.env, run = spawnSync, execImpl = exec } = {}) {
  if (withPt && !allowsPt()) throw new Blocked("model_format", "This public build supports .tflite models only; .pt support is not released.");
  const p = paths(env);
  const python = findPython(run);
  if (!python) throw new Blocked("python_missing", "Python 3.10 or newer is required to evaluate models. Install it (for example from python.org), then run setup again.");
  await mkdir(p.base, { recursive: true });
  const steps = [[python.command, ["-m", "venv", p.runtime]],
    [runtimePython(p), ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", withPt ? FILES.pt : FILES.requirements]]];
  for (const [cmd, args] of steps) {
    const r = await execImpl(cmd, args, { onLine: line => process.stderr.write(`${line}\n`) });
    if (r.code !== 0) throw new Error(`Runtime setup failed: ${(r.err || r.out).trim().split("\n").slice(-3).join(" ")}`);
  }
  const marker = { python: python.version, requirements: await sha(FILES.requirements), ...(withPt ? { pt: await sha(FILES.pt) } : {}), builtAt: new Date().toISOString() };
  await writeFile(path.join(p.runtime, ".zira-runtime.json"), JSON.stringify(marker, null, 2));
  return { kind: "model-evaluation-setup", ready: true, path: p.runtime, python: python.version, models: [".tflite", ...(withPt ? [".pt"] : [])] };
}

// The file must be one of this data source's dataset versions or models.
export function describeFile(device, fileId) {
  for (const [kind, rows] of [["model", device.cv?.models], ["version", device.cv?.datasets]]) {
    const row = (rows ?? []).find(r => String(r?.id) === String(fileId));
    if (row) {
      const labels = row.originProperties?.labels;
      return { kind, id: String(row.id), name: path.basename(String(row.name ?? `file-${row.id}`)), size: Number(row.fileSize) || null,
        ...(Array.isArray(labels) && labels.every(l => typeof l === "string") ? { labels } : {}) };
    }
  }
  throw new Blocked("not_found", "That file is not a dataset version or model of this data source.");
}

function manualDownload(origin, ds, file, p) {
  const tab = file.kind === "model" ? "models" : "datasets";
  return {
    pageUrl: `${origin}${route(`/data-sources/${ds.id}`, { viewMode: "vision", tab, fromPage: "vision-hub" })}`,
    fileName: file.name,
    steps: file.kind === "model"
      ? [`On the Models tab, open the ⋮ menu of ${file.name}`, "Choose Download"]
      : [`On the Datasets tab, expand the dataset that owns ${file.name}`, "Open the version's ⋮ menu", "Choose Download file"],
    watch: p.downloads,
    then: ["node", fileURLToPath(import.meta.url), "find-download", "--name", file.name],
  };
}

// Zira's record of the file (classes from training) beside the download: a .tflite carries no
// class names, so run uses these to catch a model whose classes differ from the dataset's.
const sidecar = file => `${file}.zira.json`;
async function writeSidecar(target, file, ds) {
  await writeFile(sidecar(target), JSON.stringify({ fileId: file.id, kind: file.kind, name: file.name, dataSourceId: ds.id,
    ...(file.labels ? { labels: file.labels } : {}) }, null, 2));
}

export async function fetchFile({ call, deviceId, fileId, origin, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!id(String(fileId ?? ""))) throw new Error("--file-id is required");
  const p = paths(env);
  const device = await loadDevice(call, deviceId);
  const ds = summarize(device), file = describeFile(device, fileId);
  const target = path.join(p.files, file.id, file.name);
  try {
    const s = await stat(target);
    if (!file.size || s.size === file.size) {
      await writeSidecar(target, file, ds);
      return { ...file, kind: "model-evaluation-file", type: file.kind, path: target, cached: true };
    }
  } catch { /* not downloaded yet */ }
  let url;
  try {
    url = (await call("GET", `/files/${file.id}`))?.data?.file;
  } catch (error) {
    if (error instanceof ZiraApiError && [401, 403].includes(error.status))
      throw new Blocked("download_not_enabled", `Zira did not allow downloading ${file.name} with plugin sign-in (HTTP ${error.status}). The user can download it from the open page; nothing was changed.`,
        { manual: manualDownload(origin, ds, file, p) });
    throw error;
  }
  const link = (() => { try { return downloadUrl(url, { allowShortLinks: true }); } catch { return null; } })();
  if (!link)
    throw new Blocked("download_not_enabled", "Zira returned no usable download link for this file.", { manual: manualDownload(origin, ds, file, p) });
  const response = await fetchDownload(link.href, { fetchImpl, allowShortLinks: true, maxRedirects: 5, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download of ${file.name} failed (HTTP ${response.status})`);
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const size = (await stat(partial)).size;
  if (file.size && size !== file.size) {
    await rm(partial, { force: true });
    throw new Error(`Download of ${file.name} was incomplete (${size} of ${file.size} bytes)`);
  }
  await rename(partial, target);
  await writeSidecar(target, file, ds);
  return { ...file, kind: "model-evaluation-file", type: file.kind, path: target, cached: false };
}

// A browser saves a repeat download as "name (1).ext"; accept those, never partial files.
export function downloadMatches(fileName, candidate) {
  if (PARTIAL.test(candidate)) return false;
  const ext = path.extname(fileName), stem = fileName.slice(0, fileName.length - ext.length);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(stem)}( ?\\(\\d+\\)|-\\d+)?${escape(ext)}$`, "i").test(candidate);
}

export async function findDownload({ name, dir, since, env = process.env, settleMs = 400 }) {
  if (!name) throw new Error("--name is required");
  const folder = dir ? path.resolve(dir) : paths(env).downloads;
  const after = since ? Date.parse(since) : 0;
  const found = [];
  for (const entry of await readdir(folder).catch(() => [])) {
    if (!downloadMatches(path.basename(name), entry)) continue;
    const full = path.join(folder, entry), s = await stat(full);
    if (s.isFile() && s.size > 0 && s.mtimeMs >= after) found.push({ path: full, size: s.size, mtimeMs: s.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!found.length) return { kind: "model-evaluation-download", found: false, watch: folder, name };
  const pick = found[0];
  await new Promise(r => setTimeout(r, settleMs)); // still being written if the size changes
  const settled = (await stat(pick.path)).size === pick.size;
  return { kind: "model-evaluation-download", found: settled, ...(settled ? {} : { stillDownloading: true }), path: pick.path,
    size: pick.size, modifiedAt: new Date(pick.mtimeMs).toISOString() };
}

const round = v => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);

// What a person needs to read first; the full report stays on disk.
export function summarizeReport(report, reportPath) {
  const s = report.summary ?? {};
  return {
    kind: "model-evaluation-result",
    complete: report.complete,
    ...(report.complete ? {} : { evaluated: report.evaluated, requested: report.requested }),
    model: report.model?.name, dataset: path.basename(String(report.dataset?.path ?? "")), split: report.dataset?.split,
    images: s.images,
    overall: { precision: round(s.precision), recall: round(s.recall), f1: round(s.f1), tp: s.tp, fp: s.fp, fn: s.fn },
    classes: (report.classes ?? []).map(c => ({ name: c.name, precision: round(c.precision), recall: round(c.recall), f1: round(c.f1), tp: c.tp, fp: c.fp, fn: c.fn,
      ...(c.comparable === false ? { comparable: false, modelClass: c.modelClass } : {}) })),
    ...(report.classMapping?.warning ? { classWarning: report.classMapping.warning } : {}),
    ...(report.confusions?.length ? { confusions: report.confusions.slice(0, 8) } : {}),
    preprocessing: report.preprocessing,
    settings: report.settings,
    modelMs: round(report.timing?.model?.meanMs),
    worstImages: (report.images ?? []).filter(i => i.fp + i.fn > 0).slice(0, 5).map(i => ({ image: i.image, missed: i.fn, extra: i.fp })),
    ...(report.labelProblems ? { labelProblems: report.labelProblems.length } : {}),
    timingNote: report.timing?.note,
    reportPath,
  };
}

export async function runEvaluation({ dataset, model, split = "val", limit, allowClassMismatch = false, modelClasses, env = process.env, execImpl = exec } = {}) {
  if (!dataset || !model) throw new Error("--dataset and --model are required");
  const suffix = path.extname(model).toLowerCase();
  if (suffix === ".pt" && !allowsPt()) throw new Blocked("model_format", "This public build supports .tflite models only; .pt support is not released.");
  const p = paths(env);
  const ready = await status({ env });
  if (!ready.runtime.ready || !ready.runtime.models.includes(suffix))
    throw new Blocked("runtime_missing", `The model runtime for ${suffix || "this model"} is not set up yet. Run setup${suffix === ".pt" ? " --with-pt" : ""} once (it downloads Python packages; ask the user first).`);
  await mkdir(p.reports, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(p.reports, `${path.parse(model).name}__${path.parse(dataset).name}__${split}__${stamp}.json`);
  let recorded = null;
  try { recorded = JSON.parse(await readFile(sidecar(path.resolve(model)), "utf8")); } catch { /* not fetched through Zira */ }
  const given = modelClasses ? String(modelClasses).split(",").map(c => c.trim()).filter(Boolean) : null;
  const labels = given?.length ? given
    : Array.isArray(recorded?.labels) && recorded.labels.every(l => typeof l === "string" && l && !l.includes(",")) ? recorded.labels : null;
  const args = [FILES.evaluator, "--dataset", path.resolve(dataset), "--model", path.resolve(model), "--split", split,
    "--work-dir", p.datasets, "--out", out, "--html", out.replace(/\.json$/, ".html"), "--progress", ...(limit ? ["--limit", String(limit)] : []),
    ...(allowClassMismatch ? ["--allow-class-mismatch"] : []), ...(labels ? ["--model-classes", labels.join(",")] : [])];
  let last = 0;
  const r = await execImpl(runtimePython(p), args, { onLine: line => {
    // Relay progress about every 10% so a long run shows it is moving.
    try {
      const e = JSON.parse(line);
      if (e.event === "start") process.stderr.write(`Evaluating ${e.total} images with ${e.model}…\n`);
      if (e.event === "image" && (e.done === e.total || e.done - last >= Math.max(1, Math.ceil(e.total / 10)))) {
        last = e.done; process.stderr.write(`  ${e.done}/${e.total}\n`);
      }
    } catch { /* not a progress line */ }
  } });
  if (r.code === 2) {
    const message = r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? "evaluation failed";
    if (/class mismatch/.test(message)) throw new Blocked("class_mismatch", message);
    throw new Error(message);
  }
  if (![0, 3].includes(r.code)) throw new Error(`Evaluation failed: ${r.err.trim().split("\n").slice(-3).join(" ")}`);
  const html = out.replace(/\.json$/, ".html");
  return { ...summarizeReport(JSON.parse(await readFile(out, "utf8")), out), ...(existsSync(html) ? { reportHtml: html } : {}) };
}

const DATASET_FILE = /\.zip$/i, MODEL_FILE = /\.(tflite|pt)$/i;

// Recent candidates in Downloads for "files on this computer": newest first, three of each.
export async function localFiles({ dir, env = process.env, now = Date.now() } = {}) {
  const folder = dir ? path.resolve(dir) : paths(env).downloads;
  const found = [];
  for (const entry of await readdir(folder).catch(() => [])) {
    if (!DATASET_FILE.test(entry) && !MODEL_FILE.test(entry)) continue;
    const full = path.join(folder, entry), s = await stat(full).catch(() => null);
    if (s?.isFile() && s.size > 0) found.push({ path: full, name: entry, sizeBytes: s.size, modifiedAt: new Date(s.mtimeMs).toISOString(), mtimeMs: s.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pick = re => found.filter(f => re.test(f.name)).map(({ mtimeMs, ...f }) => f);
  const age = f => { const days = Math.round((now - Date.parse(f.modifiedAt)) / 86400000); return days < 1 ? "today" : `${days} d ago`; };
  const mb = f => `${(f.sizeBytes / 1048576).toFixed(1)} MB`;
  const datasets = pick(DATASET_FILE), models = pick(MODEL_FILE);
  // Two recent files plus "Choose a file…" keeps three options for both hosts' choice UIs. With no
  // recent file the dialog is still offered, beside typing a path.
  const ask = (rows, header, text, other) => ({
    header, question: text, other,
    options: [...rows.slice(0, 2).map(f => ({ label: f.name, description: `${mb(f)} · ${age(f)}`, value: f.path })),
      { label: "Choose a file…", description: "Pick it in the file dialog", value: "choose" },
      ...(rows.length ? [] : [{ label: "Type the path", description: "Paste where the file is", value: "type" }])],
    ...(rows.length > 2 ? { notShown: rows.length - 2 } : {}),
  });
  return { kind: "model-evaluation-local-files", folder, datasets: datasets.slice(0, 10), models: models.slice(0, 10),
    datasetQuestion: ask(datasets, "Dataset", "Which dataset ZIP?", "Type the path of a dataset ZIP or folder."),
    modelQuestion: ask(models, "Model", "Which model file?", "Type the path of a .tflite or .pt file."),
    note: "Only names, sizes and dates are listed; nothing is read until you choose." };
}

// The system's own file dialog, started in Downloads. Returns the picked path, or chosen: false
// when the user cancels. Nothing is read until the path is used.
export function dialogCommand(kind, platform = process.platform, downloads = paths().downloads, has = cmd => spawnSync("which", [cmd]).status === 0) {
  const prompt = { dataset: "Choose a dataset ZIP", folder: "Choose a dataset folder (with data.yaml)", model: "Choose a model file (.tflite or .pt)" }[kind];
  if (!prompt) throw new Error("--kind must be dataset, folder or model");
  const types = kind === "dataset" ? ["zip"] : kind === "model" ? ["tflite", "pt"] : [];
  if (platform === "darwin") {
    const what = kind === "folder" ? "choose folder" : `choose file of type {${types.map(t => `"${t}"`).join(", ")}}`;
    return ["osascript", ["-e", `POSIX path of (${what} with prompt "${prompt}" default location (POSIX file "${downloads.replace(/"/g, "")}"))`]];
  }
  if (platform === "win32") {
    const filter = types.length ? `$d.Filter = '${prompt}|${types.map(t => `*.${t}`).join(";")}'; ` : "";
    const script = kind === "folder"
      ? `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`
      : `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${prompt}'; ${filter}$d.InitialDirectory = '${downloads.replace(/'/g, "")}'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }`;
    return ["powershell", ["-NoProfile", "-STA", "-Command", script]];
  }
  if (has("zenity")) return ["zenity", ["--file-selection", `--title=${prompt}`, ...(kind === "folder" ? ["--directory"] : types.length ? [`--file-filter=${types.map(t => `*.${t}`).join(" ")}`] : []), `--filename=${downloads}/`]];
  if (has("kdialog")) return ["kdialog", [kind === "folder" ? "--getexistingdirectory" : "--getopenfilename", downloads, ...(types.length && kind !== "folder" ? [types.map(t => `*.${t}`).join(" ")] : [])]];
  throw new Blocked("no_file_dialog", "This computer has no file dialog the plugin can open. Ask the user to type the file's path or attach it in chat.");
}

export async function chooseFile({ kind, env = process.env, execImpl = exec, platform = process.platform } = {}) {
  const [cmd, args] = dialogCommand(kind, platform, paths(env).downloads);
  const r = await execImpl(cmd, args);
  const picked = r.out.trim().split("\n").pop()?.trim().replace(/\/$/, "");
  if (r.code !== 0 || !picked) return { kind: "model-evaluation-choice", chosen: false, note: "The dialog was closed without a choice." };
  return { kind: "model-evaluation-choice", chosen: true, path: picked };
}

export async function inspectLocal({ dataset, model, modelClasses, env = process.env, execImpl = exec } = {}) {
  if (!dataset && !model) throw new Error("inspect needs --dataset and/or --model");
  if (model && path.extname(model).toLowerCase() === ".pt" && !allowsPt()) throw new Blocked("model_format", "This public build supports .tflite models only; .pt support is not released.");
  const p = paths(env);
  const ready = await status({ env });
  if (!ready.runtime.ready) throw new Blocked("runtime_missing", "The model runtime is not set up yet. Run setup once (it downloads Python packages; ask the user first).");
  if (!modelClasses && model) {
    try { const saved = JSON.parse(await readFile(sidecar(path.resolve(model)), "utf8")); if (Array.isArray(saved?.labels)) modelClasses = saved.labels.join(","); }
    catch { /* a local file without Zira's record */ }
  }
  const r = await execImpl(runtimePython(p), [FILES.evaluator, "--inspect", "--work-dir", p.datasets,
    ...(dataset ? ["--dataset", path.resolve(dataset)] : []), ...(model ? ["--model", path.resolve(model)] : []),
    ...(modelClasses ? ["--model-classes", String(modelClasses)] : [])]);
  if (r.code !== 0) throw new Error(r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? "Could not read the files");
  return JSON.parse(r.out);
}

// The HTML view is a local file; only files this skill wrote under its reports folder are opened.
export async function openReport({ report, env = process.env, launcher = launchBrowser }) {
  const file = path.resolve(String(report ?? ""));
  if (path.dirname(file) !== paths(env).reports || !file.endsWith(".html") || !existsSync(file))
    throw new Error("--report must be an HTML report in the model evaluation reports folder");
  await launcher(`file://${file}`);
  return { kind: "model-evaluation-open", opened: true, path: file };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "device-id": { type: "string" }, "file-id": { type: "string" }, profile: { type: "string" }, "web-origin": { type: "string" },
    name: { type: "string" }, dir: { type: "string" }, since: { type: "string" },
    dataset: { type: "string" }, model: { type: "string" }, split: { type: "string" }, limit: { type: "string" },
    "allow-class-mismatch": { type: "boolean" }, "with-pt": { type: "boolean" }, report: { type: "string" },
    "model-classes": { type: "string" }, kind: { type: "string" },
  } });
  switch (args[0]) {
    case "status": return status();
    case "setup": return setup({ withPt: !!o["with-pt"] });
    case "find-download": return findDownload({ name: o.name, dir: o.dir, since: o.since });
    case "open": return openReport({ report: o.report });
    case "local-files": return localFiles({ dir: o.dir });
    case "choose": return chooseFile({ kind: o.kind });
    case "inspect": return inspectLocal({ dataset: o.dataset, model: o.model, modelClasses: o["model-classes"] });
    case "run": {
      if (o.split && !["train", "val", "test", "all"].includes(o.split)) throw new Error("--split must be train, val, test or all");
      if (o.limit && !/^[1-9]\d*$/.test(o.limit)) throw new Error("--limit must be a positive number");
      return runEvaluation({ dataset: o.dataset, model: o.model, split: o.split, limit: o.limit,
        allowClassMismatch: !!o["allow-class-mismatch"], modelClasses: o["model-classes"] });
    }
    case "fetch": {
      const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
      originFor(profile);
      return fetchFile({ call: await liveSession(profile, { allow: ROUTES, maxRequests: 4 }), deviceId: o["device-id"],
        fileId: o["file-id"], origin: webOrigin(profile, o["web-origin"]) });
    }
    default: throw new Error("Choose status, setup, fetch, find-download, local-files, choose, inspect, run or open");
  }
}

if (isMain(import.meta))
  runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
