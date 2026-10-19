#!/usr/bin/env node
// Create a Dataset Subset: preview and build a per-class subset of a dataset version on this
// computer, then hand the new ZIP to Zira's "Add dataset" upload. Nothing is changed in Zira
// by this helper; the user uploads the ZIP on the page the agent opened.
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, ZiraApiError, argValue, fingerprint, guardedWrite, id, isMain, liveSession, receiptsFile, route, runCli } from "../../../scripts/client.mjs";
import { loadDevice, question, summarize, webOrigin } from "../../../scripts/datasets.mjs";
import { paths, status } from "../../evaluate-model/scripts/evaluate.mjs";
import { spawn } from "node:child_process";

const HELP = `Create a Dataset Subset — at least N images per class from a dataset version
node scripts/subset.mjs preview --dataset ZIP --min "raisedNail=100,protrudeNail=50"
    [--split-mode proportional|keep] [--seed TEXT]
node scripts/subset.mjs create --dataset ZIP --min SPEC --name NEW_DATASET [--use-available] [--version-id ID]
    [--split-mode …] [--seed …] [--device-id ID] [--profile prod|integ] [--web-origin URL]
node scripts/subset.mjs upload --file NEW_DATASET.zip --name NEW_DATASET --device-id ID [--apply]
    [--profile prod|integ] [--web-origin URL] [--receipts FILE]

Targets count images that contain a class (an image with several classes counts for each).
"all=100" sets every class. Splits stay populated: each target is spread over train/val/test
like the source (proportional), or ignored (keep). preview changes nothing. create writes
NEW_DATASET.zip to the Downloads folder with a manifest of how it was made, and returns the
steps to upload it as a new dataset in Zira. upload adds the ZIP to Zira as a new dataset of
the camera through plugin sign-in: it previews by default, --apply uploads once (a receipt
prevents repeats) and starts Zira's import; when Zira does not allow agent uploads it stops
with the manual steps. Uses the model evaluation runtime (setup once with evaluate-model's
evaluate.mjs setup).
Exit 0 success, 2 invalid input or impossible request, 4 blocked (JSON explains).
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "subset_dataset.py");
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _().-]{0,99}$/;

function python(args, env) {
  const p = paths(env);
  const bin = path.join(p.runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [SCRIPT, ...args, "--work-dir", p.datasets], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}

async function runPython(args, { env = process.env, exec = python } = {}) {
  const ready = await status({ env });
  if (!ready.runtime.ready)
    throw new Blocked("runtime_missing", "The local dataset runtime is not set up yet. Run evaluate-model's `evaluate.mjs setup` once (it downloads about 30 MB of Python packages; ask the user first).");
  const r = await exec(args, env);
  if (r.code !== 0) throw new Error(r.err.split("\n").find(l => l.startsWith("error:"))?.slice(7) ?? `Subset failed: ${r.err.trim().slice(-300)}`);
  return JSON.parse(r.out);
}

const common = ({ dataset, min, splitMode, seed }) => {
  if (!dataset || !existsSync(dataset)) throw new Error("--dataset must be a downloaded dataset version ZIP or folder");
  if (!min) throw new Error('--min is required, for example "raisedNail=100,protrudeNail=50"');
  return ["--dataset", path.resolve(dataset), "--min", min,
    ...(splitMode ? ["--split-mode", splitMode] : []), ...(seed ? ["--seed", seed] : [])];
};

// What the user decides next, ready for the host's choice UI.
export function nextQuestion(plan) {
  const options = plan.complete
    ? [{ label: "Create it", description: `${plan.images} images (${Object.entries(plan.imagesBySplit).map(([s, n]) => `${s} ${n}`).join(", ")})`, value: "create" }]
    : [{ label: "Use what's available", description: plan.shortfalls.map(s => `${s.class}: ${s.available} of ${s.requested}`).join("; "), value: "use-available" }];
  options.push({ label: "Change the numbers", description: "Adjust the per-class minimums", value: "change" });
  return question("Subset", plan.complete ? "Create this subset?" : "Some classes don't have enough images. What should I do?",
    options, { label: o => o.label, description: o => o.description, value: o => o.value, other: "Type new targets, for example raisedNail=80." });
}

export async function preview(opts, deps) {
  const plan = await runPython(["plan", ...common(opts)], deps);
  return { ...plan, question: nextQuestion(plan) };
}

export async function create({ name, useAvailable, deviceId, versionId, origin, env = process.env, ...opts }, deps = {}) {
  if (!NAME.test(String(name ?? ""))) throw new Error("--name must be 1–100 letters, digits, spaces or _ ( ) . -");
  const out = path.join(paths(env).downloads, `${name}.zip`);
  if (existsSync(out)) throw new Error(`${out} already exists; choose another name`);
  const result = await runPython(["create", ...common(opts), "--name", name, "--out", out, ...(useAvailable ? ["--use-available"] : []),
    ...(versionId && id(String(versionId)) ? ["--source-id", String(versionId)] : [])], { env, ...deps });
  const pageUrl = deviceId && origin && id(String(deviceId))
    ? `${origin}${route(`/data-sources/${deviceId}`, { viewMode: "vision", tab: "datasets", fromPage: "vision-hub" })}` : null;
  return {
    ...result,
    upload: {
      ...(pageUrl ? { pageUrl } : {}),
      file: out,
      steps: ["On the Datasets tab, click + Add dataset", `Name it ${name}`, "Under Initial data choose Upload dataset version (ZIP)",
        `Click Choose ZIP file and pick ${path.basename(out)} from Downloads`, "Click Create"],
      note: "Zira uploads the ZIP and unpacks it into the new dataset; large files take a while. The ZIP's subset-manifest.json records the source version and selection.",
    },
  };
}

export const UPLOAD_ROUTES = [["GET", /^\/devices\/all$/], ["POST", /^\/files\/signed-uploads\/create$/],
  ["POST", /^\/prod-vision\/[1-9]\d*\/assets-to-hub$/]];
const MAX_ZIP = 5000 * 1024 * 1024; // zira-web's dataset ZIP limit
const S3_HOST = /\.amazonaws\.com$/;
// Zira names an uploaded file after the original with spaces as underscores (zira-web socketBigFile).
const uploadedMatches = (fileName, row) => String(row?.name ?? "").includes(path.parse(fileName).name.replaceAll(" ", "_"));

function manualUpload(origin, ds, file, name) {
  return {
    pageUrl: `${origin}${route(`/data-sources/${ds.id}`, { viewMode: "vision", tab: "datasets", fromPage: "vision-hub" })}`,
    file,
    steps: ["On the Datasets tab, click + Add dataset", `Name it ${name}`, "Under Initial data choose Upload dataset version (ZIP)",
      `Click Choose ZIP file and pick ${path.basename(file)}`, "Click Create"],
  };
}

// Add a subset ZIP to Zira as a new dataset of the camera, as zira-web's Add dataset does:
// signed upload → the ZIP becomes a dataset version file on the device → import it into a new folder.
export async function upload({ call, file, name, deviceId, origin, apply = false, receipts, env = process.env,
  fetchImpl = globalThis.fetch, blob = openAsBlob, poll = { everyMs: 3000, maxMs: 10 * 60 * 1000 }, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!NAME.test(String(name ?? ""))) throw new Error("--name must be 1–100 letters, digits, spaces or _ ( ) . -");
  const zip = path.resolve(String(file ?? ""));
  if (!existsSync(zip) || !zip.toLowerCase().endsWith(".zip")) throw new Error("--file must be the subset ZIP");
  const size = (await stat(zip)).size;
  if (!size || size > MAX_ZIP) throw new Error("The ZIP must be between 1 byte and 5000 MB");
  const device = await loadDevice(call, deviceId);
  const ds = summarize(device);
  const manual = manualUpload(origin, ds, zip, name);
  const preview = { camera: { id: ds.id, name: ds.name, site: ds.site.name }, dataset: name, file: zip, sizeBytes: size };
  if (!apply) return { kind: "dataset-upload-draft", applied: false, preview,
    note: "Nothing was uploaded. Confirm with the user, then rerun with --apply." };
  const sha = createHash("sha256").update(await readFile(zip)).digest("hex");
  return guardedWrite({
    file: receiptsFile(receipts, env),
    key: `dataset-upload:${ds.id}:${fingerprint({ name, sha })}`,
    summary: `Upload ${path.basename(zip)} to ${ds.name} as dataset ${name}`,
    links: () => ({ manual }),
    run: async progress => {
      const startedAt = Date.now();
      let form;
      try {
        form = (await call("POST", "/files/signed-uploads/create", {
          site: { id: ds.site.id }, ...(ds.companyId ? { company: { id: ds.companyId } } : {}),
          name: path.basename(zip), fileMimeType: "application/zip", fileType: "zip", fileSize: size,
          deviceId: Number(ds.id), assetType: "dataset", fileSizeLoose: true,
          originProperties: { originalMimeType: "application/zip", source: "zira-plugin-subset" },
        }))?.data;
      } catch (error) {
        if (error instanceof ZiraApiError && [401, 403].includes(error.status))
          throw new Blocked("upload_not_enabled", `Zira did not allow uploading with plugin sign-in (HTTP ${error.status}); nothing was uploaded. The user can add it on the open Datasets tab.`, { manual });
        throw error;
      }
      const target = (() => { try { return new URL(form?.signedUrl?.url); } catch { return null; } })();
      if (!target || target.protocol !== "https:" || !S3_HOST.test(target.hostname) || typeof form?.signedUrl?.fields !== "object")
        throw new Blocked("upload_not_enabled", "Zira returned no usable upload form; nothing was uploaded.", { manual });
      const body = new FormData();
      for (const [k, v] of Object.entries(form.signedUrl.fields)) body.append(k, String(v));
      body.append("file", await blob(zip), path.basename(zip));
      const sent = await fetchImpl(target.href, { method: "POST", body });
      if (!sent.ok) throw new Error(`Upload to storage failed (HTTP ${sent.status})`);
      // Zira attaches the ZIP to the camera asynchronously; wait for the version file to appear.
      let zipFile = null;
      for (let waited = 0; !zipFile && waited <= poll.maxMs; waited += poll.everyMs) {
        const rows = (await loadDevice(call, ds.id)).cv?.datasets ?? [];
        zipFile = rows.find(r => uploadedMatches(path.basename(zip), r) && Date.parse(r.createdDate ?? 0) >= startedAt - 60000);
        if (!zipFile) await sleep(poll.everyMs);
      }
      if (!zipFile) throw new Error("The ZIP was uploaded but Zira has not attached it to the camera yet");
      await progress({ zipFile: String(zipFile.id) });
      await call("POST", `/prod-vision/${ds.id}/assets-to-hub`, { files: { [String(zipFile.id)]: { newName: name } } });
      return { receipt: { zipFile: String(zipFile.id), dataset: name },
        result: { pageUrl: manual.pageUrl, zipFile: String(zipFile.id),
          note: "Zira is importing the ZIP into the new dataset; it appears on the Datasets tab within a few minutes." } };
    },
  });
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    dataset: { type: "string" }, min: { type: "string" }, "split-mode": { type: "string" }, seed: { type: "string" },
    name: { type: "string" }, "use-available": { type: "boolean" }, "device-id": { type: "string" },
    profile: { type: "string" }, "web-origin": { type: "string" }, "version-id": { type: "string" },
    file: { type: "string" }, apply: { type: "boolean" }, receipts: { type: "string" },
  } });
  if (o["split-mode"] && !["proportional", "keep"].includes(o["split-mode"])) throw new Error("--split-mode must be proportional or keep");
  const opts = { dataset: o.dataset, min: o.min, splitMode: o["split-mode"], seed: o.seed };
  if (args[0] === "preview") return preview(opts);
  if (args[0] === "create") {
    const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
    return create({ ...opts, name: o.name, useAvailable: !!o["use-available"], deviceId: o["device-id"], versionId: o["version-id"],
      origin: o["device-id"] ? webOrigin(profile, o["web-origin"]) : null });
  }
  if (args[0] === "upload") {
    const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
    const call = await liveSession(profile, { allow: UPLOAD_ROUTES, maxRequests: 260 });
    return upload({ call, file: o.file, name: o.name, deviceId: o["device-id"], origin: webOrigin(profile, o["web-origin"]),
      apply: !!o.apply, receipts: o.receipts });
  }
  throw new Error("Choose preview, create or upload");
}

if (isMain(import.meta))
  runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
