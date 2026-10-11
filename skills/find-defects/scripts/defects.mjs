#!/usr/bin/env node
// Find Defects: rank the nail slices most likely to show a rare defect (raised nails by default),
// let a person accept or reject them on a local review page, and export the accepted slices as a
// dataset. Works on QA session slices prepared by evaluate-model's sessions.mjs, or any nails dataset
// folder. Nothing is created or changed in Zira; an exported ZIP is uploaded only if the user does.
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, argValue, id, isMain, originFor, runCli } from "../../../scripts/client.mjs";
import { launchBrowser, webOrigin } from "../../../scripts/datasets.mjs";
import { exec, paths, runtimePython, status } from "../../evaluate-model/scripts/evaluate.mjs";
import { datasetsRoot, sessionsRoot } from "../../evaluate-model/scripts/sessions.mjs";
import { readJsonFile, startReview, tally } from "./review.mjs";
import { createWorkspace } from "./workspace.mjs";

const HELP = `Find Defects — rank likely defect slices, review them, export the accepted ones
node scripts/defects.mjs scan --dataset NAILS_DIR --model FILE [--target raisedNail] [--confidence 0.05]
    [--model-classes a,b,c] [--limit N]
node scripts/defects.mjs review [--device-id ID] [--run RUN_DIR] [--open] [--idle-minutes 240]
node scripts/defects.mjs progress --run RUN_DIR
node scripts/defects.mjs export --run RUN_DIR [--name NAME] [--all-reviewed] [--no-known] [--whole] [--keep-unsure] [--zip]
node scripts/defects.mjs runs

scan runs a model that knows the defect class at a low confidence over every slice and ranks the
candidates (slices a reviewer marked as a nails defect are raised; boxes already labeled with the
defect are kept as known examples). review serves the run on 127.0.0.1 (printing its url) and saves
each decision as it is made; keep the process running while the person reviews. With --device-id the
page also lists the camera's dataset versions, QA sessions and models, so the person can start a
search there and open earlier ones. progress counts the
decisions. export writes the accepted slices, every other nail labeled as in the reference, as a
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

export async function scan({ dataset, model, target = "raisedNail", confidence = 0.05, modelClasses, limit, deviceId, env = process.env,
  execImpl = exec, now = () => new Date(), log = line => process.stderr.write(`${line}\n`) }) {
  if (!dataset || !model) throw new Error("--dataset and --model are required");
  if (!String(target).split(",").every(t => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(t))) throw new Error("--target must be a class name or comma-separated class names");
  await ready(env);
  let classes = modelClasses ? String(modelClasses) : null;
  if (!classes) {
    try { classes = (JSON.parse(await readFile(`${path.resolve(model)}.zira.json`, "utf8")).labels ?? []).join(",") || null; }
    catch { /* not fetched through Zira */ }
  }
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const out = path.join(runsRoot(env), `${stamp}-${String(target).split(",").join("-")}`);
  await mkdir(runsRoot(env), { recursive: true });
  const frames = framesRootFor(dataset, env);
  const args = [FINDER, "scan", "--dataset", path.resolve(dataset), "--model", path.resolve(model), "--target", target,
    "--confidence", String(confidence), "--out", out, "--progress", ...(classes ? ["--model-classes", classes] : []),
    ...(limit ? ["--limit", String(limit)] : []), ...(frames ? ["--frames-root", frames] : []),
    ...(id(String(deviceId ?? "")) ? ["--device-id", String(deviceId)] : [])];
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
    "model-classes": { type: "string" }, limit: { type: "string" }, run: { type: "string" }, open: { type: "boolean" },
    "idle-minutes": { type: "string" }, name: { type: "string" }, "all-reviewed": { type: "boolean" }, "no-known": { type: "boolean" },
    zip: { type: "boolean" }, whole: { type: "boolean" }, "keep-unsure": { type: "boolean" }, profile: { type: "string" },
    "device-id": { type: "string" }, "web-origin": { type: "string" },
  } });
  switch (args[0]) {
    case "scan": {
      const confidence = o.confidence ? Number(o.confidence) : 0.05;
      if (!(confidence > 0 && confidence < 1)) throw new Error("--confidence must be between 0 and 1");
      if (o.limit && !/^[1-9]\d*$/.test(o.limit)) throw new Error("--limit must be a positive number");
      return scan({ dataset: o.dataset, model: o.model, target: o.target, confidence, modelClasses: o["model-classes"], limit: o.limit,
        deviceId: o["device-id"] });
    }
    case "review": {
      const idleMinutes = o["idle-minutes"] ? Number(o["idle-minutes"]) : 240;
      if (!(idleMinutes >= 1 && idleMinutes <= 720)) throw new Error("--idle-minutes must be 1-720");
      if (!o.run && !o["device-id"]) throw new Error("Give --device-id (to choose what to search on the page) and/or --run");
      if (o["device-id"] && !id(o["device-id"])) throw new Error("--device-id must be a data source ID");
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
      const helper = await startReview({ run: o.run, workspace, runs: listRuns, helperFile, idleMinutes, log });
      console.log(JSON.stringify({ kind: "zira.defect-review", url: helper.url, idleMinutes, ...(helper.tally ?? {}),
        note: "Open url in the browser; decisions save as they are made. Stop this process to end it." }));
      if (o.open) await launchBrowser(helper.url);
      for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => helper.close());
      await helper.closed;
      return { kind: "zira.defect-review-stopped" };
    }
    case "progress": return progress({ run: o.run });
    case "runs": return runs();
    case "export": return exportRun({ run: o.run, name: o.name, allReviewed: !!o["all-reviewed"], known: !o["no-known"], whole: !!o.whole, keepUnsure: !!o["keep-unsure"], zip: !!o.zip });
    default: throw new Error("Choose scan, review, progress, export or runs");
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
