// Local review page for find-defects: serves one run's candidates on 127.0.0.1 and saves each decision
// to the run's decisions.json as it is made. With a workspace it also lets the person choose what to
// search (a dataset version or QA sessions, the class and the model) and switch between earlier
// searches. It reads only the runs' own slice and frame images and answers nothing but its own page.
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";

import { contentRect, galleryOrder } from "./gallery.mjs";

const MAX_BODY = 16384;
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp" };
export const SKIP = "skip", REJECT = "reject";

// Optional guidance, collapsed beside the selected image. Others get a neutral prompt.
export const GUIDANCE = {
  raisedNail: [
    "Raised nail: a perfectly round head standing above the board, with a soft, even shadow around it.",
    "Regular nail: sunk into the wood, the head not perfectly round, small wood cracks around it, and a different, tighter shadow inside the sink.",
    "Protruding nail: the shank sticks out; judge it by its side profile, not just the head.",
  ],
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeAtomic(file, value) {
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify(value, null, 1));
  await rename(partial, file);
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Counts the agent reports in chat while the person reviews.
export const targetsOf = run => run.targets?.length ? run.targets : [run.target];

export function tally(run, decisions) {
  const targets = targetsOf(run), isTarget = v => targets.includes(v);
  let reviewed = 0, accepted = 0, rejected = 0, relabeled = 0, unsure = 0;
  for (const item of run.review ?? []) {
    const chosen = decisions[item.image]?.boxes ?? {};
    const boxes = Object.values(chosen);
    if (boxes.some(isTarget)) accepted += 1; // counts as soon as one box is accepted
    if (boxes.includes(SKIP)) unsure += 1;
    if (!boxes.length || item.candidates.some((c, i) => !(String(i) in chosen))) continue;
    reviewed += 1;
    if (boxes.some(isTarget) || boxes.includes(SKIP)) continue;
    if (boxes.some(v => v !== REJECT)) relabeled += 1;
    else rejected += 1;
  }
  return { toReview: run.review?.length ?? 0, reviewed, accepted, rejected, relabeled, unsure, known: run.totals?.knownSlices ?? 0 };
}

async function loadRun(dir) {
  const run = await readJsonFile(path.join(dir, "candidates.json"), null);
  if (run?.format !== "zira.defect-candidates") throw bad("That is not a find-defects run folder (with candidates.json)");
  const decisions = (await readJsonFile(path.join(dir, "decisions.json"), {})).decisions ?? {};
  return { dir, run, decisions, root: path.resolve(run.dataset.path), framesRoot: run.framesRoot ? path.resolve(run.framesRoot) : null,
    labels: [...new Set([...targetsOf(run), ...run.dataset.classNames])], items: run.review ?? [] };
}

/**
 * Start the page. `run` opens one run; `workspace` (createWorkspace) adds choosing and starting
 * searches; `runs()` lists earlier runs that may be opened; `helperFile` keeps port and token so a
 * restarted page keeps its address (default: the run folder's review.json).
 */
export async function startReview({ run: runDir, compareRuns = [], workspace = null, runs = null, helperFile, idleMinutes = 240, port = 0, log = () => {} }) {
  if (!runDir && !helperFile) throw new Error("Give a run folder or a helper file");
  let current = runDir ? await loadRun(path.resolve(String(runDir))) : null;
  let comparisons = [];
  const compare = async dirs => {
    if (!current) throw bad("Open a primary run first");
    if (!Array.isArray(dirs) || dirs.length > 4) throw bad("Choose up to four comparison runs");
    const loaded = await Promise.all([...new Set(dirs.map(d => path.resolve(d)))].filter(d => d !== current.dir).map(loadRun));
    const fingerprint = current.run.dataset.fingerprint;
    for (const other of loaded) {
      if (!fingerprint || fingerprint !== other.run.dataset.fingerprint || !current.run.complete || !other.run.complete)
        throw bad("Comparison needs complete scans with matching image and label fingerprints; rescan older runs");
      if (JSON.stringify([...targetsOf(current.run)].sort()) !== JSON.stringify([...targetsOf(other.run)].sort()) ||
          JSON.stringify(current.run.settings) !== JSON.stringify(other.run.settings))
        throw bad("Comparison needs the same target classes, confidence and NMS settings");
    }
    comparisons = loaded;
  };
  if (compareRuns.length) await compare(compareRuns);
  const helper = helperFile ?? path.join(current.dir, "review.json");
  const saved = await readJsonFile(helper, {});
  const token = /^[A-Za-z0-9_-]{24}$/.test(saved.token ?? "") ? saved.token : randomBytes(18).toString("base64url");
  const base = `/r/${token}/`;
  let host, timer, finish, writing = Promise.resolve();
  const closed = new Promise(resolve => { finish = resolve; });
  const idle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { log("Review page idle; stopping"); close(); }, idleMinutes * 60000);
    timer.unref?.();
  };
  const open = async dir => { current = await loadRun(path.resolve(dir)); comparisons = []; log(`Showing ${current.dir}`); };

  const file = async (folder, relative) => {
    const full = path.resolve(folder, relative);
    if (!full.startsWith(folder + path.sep) || !TYPES[path.extname(full).toLowerCase()]) return null;
    try { return (await stat(full)).isFile() ? full : null; } catch { return null; }
  };
  const frameOf = item => current?.framesRoot && item.session && item.frame ? path.join(...item.session.split("::"), "images", item.frame) : null;

  const state = () => {
    if (!current) return { empty: true, workspace: Boolean(workspace) };
    const { run, decisions, labels, items } = current;
    return { run: current.dir, target: run.target, targets: targetsOf(run), labels, guidance: targetsOf(run).flatMap(t => GUIDANCE[t] ?? []),
      dataset: run.dataset, model: run.model.name,
      // Runs from before the camera was recorded keep their frames under sessions/<camera id>.
      dataSourceId: run.dataSourceId ?? (current.framesRoot ? path.basename(current.framesRoot) : null),
      comparisons: [current, ...comparisons].map(c => ({run: c.dir, model: c.run.model.name, sha256: c.run.model.sha256,
        threshold: c.run.settings?.confidence, elapsedSeconds: c.run.elapsedSeconds,
        candidateBoxes: c.run.totals.candidateBoxes, toReview: c.run.totals.toReview,
        metrics: c.run.comparisonMetrics ?? null, predictions: c.run.comparisonItems ?? null})),
      labelsFrom: run.labelsFrom ?? (run.dataset.sessions?.length ? "sessions" : "dataset"),
      // Runs from before names were recorded show the unpacked folder; drop its content hash.
      datasetName: (run.dataset.name ?? path.basename(run.dataset.path).replace(/-[0-9a-f]{16}$/, "")).replace(/\.zip$/i, ""),
      threshold: run.settings?.confidence ?? null, createdAt: run.createdAt ?? null,
      framesAvailable: Boolean(current.framesRoot), items, decisions, tally: tally(run, decisions), workspace: Boolean(workspace) };
  };

  const decide = async body => {
    if (!current) throw bad("Nothing to review yet");
    let wanted;
    try { wanted = JSON.parse(body); } catch { throw bad("Send JSON"); }
    if (wanted.run && wanted.run !== current.dir) throw bad("The active run changed; reopen the image before saving", 409);
    const target = current, { items, labels, run } = target;
    const item = items[wanted?.index];
    if (!item) throw bad("Unknown slice");
    const key = String(wanted.box ?? "");
    const isCandidate = /^\d+$/.test(key) && Number(key) < item.candidates.length;
    const isReference = /^r\d+$/.test(key) && Number(key.slice(1)) < item.truth.length;
    const isOther = /^m\d+$/.test(key) && Number(key.slice(1)) < (item.others?.length ?? 0); // the model's other detections
    // A slice without boxes (a reviewer's mark, nothing found) can only be dismissed or marked unsure.
    const isSlice = key === "slice" && !item.candidates.length && !item.truth.length && !item.others?.length;
    if (!isCandidate && !isReference && !isOther && !isSlice) throw bad("Unknown box");
    const label = wanted.label === null ? null : String(wanted.label);
    if (label !== null && ![...(isSlice ? [] : labels), REJECT, SKIP].includes(label)) throw bad("Unknown label");
    const entry = { ...(target.decisions[item.image] ?? {}), boxes: { ...(target.decisions[item.image]?.boxes ?? {}) } };
    if (label === null) delete entry.boxes[key]; else entry.boxes[key] = label;
    entry.updatedAt = new Date().toISOString();
    target.decisions = { ...target.decisions, [item.image]: entry };
    if (!Object.keys(entry.boxes).length) delete target.decisions[item.image];
    const snapshot = { format: "zira.defect-decisions", version: 1, target: run.target, decisions: target.decisions };
    writing = writing.then(() => writeAtomic(path.join(target.dir, "decisions.json"), snapshot));
    await writing;
    return { ok: true, boxes: entry.boxes, tally: tally(run, target.decisions) };
  };

  const json = body => { try { return JSON.parse(body); } catch { throw bad("Send JSON"); } };

  const server = http.createServer(async (req, res) => {
    idle();
    try {
      if (req.headers.host !== host) return send(res, 421, { message: "Wrong host" });
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
      if (route === null) return send(res, 404, { message: "Not found" });
      if (req.method === "POST") {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { message: "Send JSON" });
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${host}`) || ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]))
          return send(res, 403, { message: "Only this review page can make changes" });
        const body = await readBody(req);
        if (route === "decide") return send(res, 200, await decide(body));
        if (route === "search" && workspace) return send(res, 200, await workspace.search(json(body), { onDone: async (dir, others = []) => { await open(dir); await compare(others); } }));
        if (route === "compare" && runs) {
          const wanted = json(body), allowed = new Set((await runs()).map(r => r.run));
          if (!Array.isArray(wanted.runs) || !wanted.runs.every(r => allowed.has(r))) throw bad("Choose listed runs");
          await compare(wanted.runs); return send(res, 200, {ok: true});
        }
        if (route === "select-model") {
          const wanted = json(body), all = [current, ...comparisons];
          const selected = all.find(r => r?.dir === wanted.run);
          if (!selected) throw bad("Choose a compared model");
          await writing;
          current = await loadRun(selected.dir); comparisons = all.filter(r => r.dir !== selected.dir);
          return send(res, 200, {ok: true});
        }
        if (route === "open" && runs) {
          const wanted = json(body);
          if (!(await runs()).some(r => r.run === wanted?.run)) throw bad("Choose one of the earlier searches");
          await open(wanted.run);
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { message: "Not found" });
      }
      if (req.method !== "GET") return send(res, 405, { message: "Method not allowed" });
      if (route === "") {
        res.setHeader("content-security-policy", `${REVIEW_CSP}; frame-ancestors 'none'`);
        return send(res, 200, page(), "text/html; charset=utf-8");
      }
      if (route === "state") return send(res, 200, state());
      if (route === "options" && workspace) return send(res, 200, await workspace.options({ refresh: url.searchParams.get("refresh") === "1" }));
      if (route === "job" && workspace) return send(res, 200, workspace.job() ?? {});
      if (route === "runs" && runs) return send(res, 200, { runs: await runs() });
      if ((route === "slice" || route === "frame") && current) {
        if (url.searchParams.has("r") && url.searchParams.get("r") !== current.dir) return send(res, 409, {message: "Run changed"});
        const item = current.items[Number(url.searchParams.get("i"))];
        const full = item && (route === "frame" ? (frameOf(item) && await file(current.framesRoot, frameOf(item))) : await file(current.root, item.image));
        if (!full) return send(res, 404, { message: "Not found" });
        res.writeHead(200, { "content-type": TYPES[path.extname(full).toLowerCase()], "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
        return createReadStream(full).pipe(res);
      }
      return send(res, 404, { message: "Not found" });
    } catch (error) {
      log(`Review page: ${error.message}`);
      return send(res, error.status ?? 500, { message: error.message });
    }
  });

  const listen = p => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const preferred = port || (Number.isInteger(saved.port) && saved.port > 1023 && saved.port < 65536 ? saved.port : 0);
  try {
    await listen(preferred);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || !preferred) throw error;
    log(`Port ${preferred} is busy; using another, so open the new url`);
    await listen(0);
  }
  host = `127.0.0.1:${server.address().port}`;
  await writeFile(helper, JSON.stringify({ port: server.address().port, token, pid: process.pid }));
  function close() {
    clearTimeout(timer);
    server.close(() => finish());
    server.closeAllConnections?.();
  }
  idle();
  return { url: `http://${host}${base}`, close, closed, tally: current ? tally(current.run, current.decisions) : null };
}

const REVIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review pallet nails</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--accent:#e8890c;--ok:#1f9d55;--no:#d93636;--ref:#2f6fd6}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#ecebe6;--muted:#a3a29b;--card:#1f1f1d;--line:#34332f;--ref:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1240px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
h1{font-size:18px;margin:0}.sub{color:var(--muted)}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:6px 0 12px}.bar i{display:block;height:100%;width:0;background:var(--ok)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
.panel h2{font-size:12px;font-weight:600;color:var(--muted);margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
.setup{margin:0 0 12px}.setup .row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0 0 10px}
.seg{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.seg .lbl{font-size:12px;color:var(--muted);margin-right:4px}
.seg label{flex-direction:row!important;align-items:center;gap:6px!important;border:1px solid var(--line);border-radius:999px;padding:5px 12px;cursor:pointer;color:var(--fg)!important;font-size:13px!important}
.seg label:has(input:checked){border-color:var(--fg);background:color-mix(in srgb,var(--fg) 8%,var(--card))}.seg label:has(input:disabled){opacity:.5;cursor:default}
.seg input{margin:0}
.setup summary{cursor:pointer;font-weight:600}.setup[open] summary{margin-bottom:6px}.setup .q{margin:10px 0 6px;font-weight:600}
.setup summary .change{font-weight:400;color:var(--ref);margin-left:6px}
.setup label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted);min-width:0}
.setup select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:min(100%,420px)}
button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
a.button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;text-decoration:none}
button:hover,a.button:hover{border-color:var(--fg)}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}button:disabled{opacity:.5;cursor:default}
.lead{margin:0 0 12px;line-height:1.55}.lead .cand{color:var(--accent);font-weight:600}.lead .ref{color:var(--ref);font-weight:600}.lead .oth{color:#c08cff;font-weight:600}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}@media (max-width:900px){.layout{grid-template-columns:1fr}}
.views{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}@media (max-width:640px){.views{grid-template-columns:1fr}}
canvas{width:100%;height:auto;display:block;background:#000;border-radius:6px}
.cwrap{position:relative}.zbadge{position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center}
.zbadge span,.zbadge button{font-family:inherit;font-size:12px;line-height:1.4;color:#fff;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:2px 9px}
.zbadge span{pointer-events:none;font-variant-numeric:tabular-nums}.zbadge button:hover{border-color:#fff}#frame,#slice,#zoom{cursor:grab;touch-action:none}canvas.drag{cursor:grabbing!important}
.buttons{display:grid;gap:8px}.buttons button{text-align:left;padding:10px 12px}
.buttons .target{font-weight:600}
.buttons button[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 18%,var(--card));border-color:var(--accent)}
.buttons .target[aria-pressed=true]{background:color-mix(in srgb,var(--ok) 18%,var(--card));border-color:var(--ok)}
.buttons .reject[aria-pressed=true]{background:color-mix(in srgb,var(--no) 18%,var(--card));border-color:var(--no)}
.buttons .skip[aria-pressed=true]{background:color-mix(in srgb,#9a9a93 18%,var(--card));border-color:#9a9a93}
.buttons .cam{border-style:dashed;border-color:var(--muted)}.buttons .cam[aria-pressed=true]{border-style:solid}
.meta{color:var(--muted);font-size:12px;word-break:break-all}.chips span{display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:12px;border:1px solid var(--line);font-size:12px}
.chips .mark{border-color:var(--accent)}.guide{font-size:13px}.guide p{margin:0 0 6px}
.boxes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.boxes button{font-size:12px;padding:3px 8px;border-radius:12px}
.boxes button.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,var(--card))}
.why{margin:8px 0 0;font-size:13px}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px;margin-top:8px}
.legend i{display:inline-block;width:14px;height:10px;border:2px solid;margin-right:5px;vertical-align:-1px}
.lc{border-color:#e8890c!important;border-style:dashed!important}.lr{border-color:#6ea0ff!important}.lm{border-color:#c08cff!important;border-style:dotted!important}.lg{border-color:#1f9d55!important}.ln{border-color:#d93636!important}.lu{border-color:#9a9a93!important}
nav{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}nav select{font:inherit;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.where{margin-top:10px}.where b{font-size:14px}
.where code{font-size:12px;word-break:break-all}.where button{font-size:12px;padding:2px 8px;margin-left:4px}
.empty{padding:28px;text-align:center;color:var(--muted)}#err{color:var(--no)}[hidden]{display:none!important}

.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin:16px 0}
.tile{padding:0;overflow:hidden;text-align:left;align-self:start}.tile canvas{border-radius:0;background:transparent}.tile .caption{padding:8px;overflow-wrap:anywhere}.tile small{display:block;color:var(--muted)}
.tile{border:2px solid var(--line)}.tile[data-status="accepted"]{border-color:#328557}.tile[data-status="reviewed"]{border-color:#487cc7}.tile[data-status="partial"],.tile[data-status="unsure"]{border-color:#b88724}
.tile .statusRow{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:7px}
.tile .statusBadge{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:700;background:#e4e4e1;color:#4c4c46}
.tile[data-status="accepted"] .statusBadge{background:#d8f0e0;color:#145f32}.tile[data-status="reviewed"] .statusBadge{background:#deebff;color:#245693}.tile[data-status="partial"] .statusBadge,.tile[data-status="unsure"] .statusBadge{background:#fff0c9;color:#775000}
@media(prefers-color-scheme:dark){.tile .statusBadge{background:#373733;color:#cecec6}.tile[data-status="accepted"] .statusBadge{background:#1d4430;color:#a4e5ba}.tile[data-status="reviewed"] .statusBadge{background:#213b60;color:#b4d1ff}.tile[data-status="partial"] .statusBadge,.tile[data-status="unsure"] .statusBadge{background:#4c3a16;color:#f3d284}}
.filters{position:sticky;top:0;background:var(--bg);z-index:1;padding:10px 0}.filters input{font:inherit;padding:7px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
dialog{width:min(1240px,96vw);max-height:94vh;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);padding:16px}dialog::backdrop{background:#0009}
.dialogHead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}.views{display:block}.imageViewport{overflow:auto;max-height:65vh}#slice{background:transparent;border-radius:0;max-width:none}#frame{background:transparent}
.modelTable{border-collapse:collapse;width:100%;margin:12px 0}.modelTable td,.modelTable th{padding:6px;border-bottom:1px solid var(--line);text-align:left}
</style></head><body><main>
<header><div><h1 id="title">Review pallet nails</h1><div class="sub" id="sub"></div></div><div class="sub" id="count"></div></header>
<div class="bar"><i id="progress"></i></div>
<details class="panel setup" id="setup" hidden><summary id="setupSummary">Start a search</summary>
<p class="q">Which images should we search?</p>
<div class="row"><div class="seg" role="radiogroup" aria-label="Which images">
<label><input type="radio" name="kind" value="sessions"> New frames from QA sessions</label>
<label><input type="radio" name="kind" value="dataset"> Images in a dataset, to check its labels</label></div></div>
<p class="meta" id="kindNote" hidden></p>
<div class="row" id="sessionRow" hidden>
<label>Which sessions<select id="sessions"></select></label>
<label>How many frames from each<select id="frames"><option value="">All</option><option value="50">Newest 50</option><option value="200">Newest 200</option><option value="500">Newest 500</option></select></label>
</div>
<div class="row" id="datasetRow" hidden>
<label>Which dataset<select id="dataset"></select></label>
<label>Which version<select id="version"></select></label>
</div>
<p class="q">What are you looking for? <span class="meta">Choose one or more</span></p>
<div class="row"><div class="seg" id="targets"></div></div>
<p class="q">Which models should point out possible ones? (up to five)</p>
<div class="row"><label><select id="model" multiple size="4" aria-label="Models to compare"></select></label></div>
<p class="meta">Choose a model trained to recognize them. It only suggests where to look; you decide what each one is.</p>
<div class="row"><button id="go" class="primary">Find</button></div>
<p class="meta" id="jobText"></p><div id="confirmRow" hidden><button id="confirmBtn">Download and continue</button></div>
<div class="row" id="runsWrap" hidden><label>Or reopen an earlier search<select id="runs"></select></label><button id="openRun">Open selected run</button><button id="compareRun">Compare selected run</button></div>
</details>
<p class="lead" id="lead"></p>
<div id="reviewArea" hidden>
<nav class="filters" aria-label="Gallery filters">
<label>Review status <select id="filter"><option value="all">All</option><option value="todo">Not reviewed</option><option value="accepted">Accepted</option><option value="rejected">Not this</option><option value="unsure">Unsure</option></select></label>
<label>File name <input id="searchFiles" type="search" placeholder="Search file names"></label>
<label>Sort <select id="sort"><option value="score-desc">Score: high to low</option><option value="score-asc">Score: low to high</option><option value="name-asc">File name: A–Z</option><option value="name-desc">File name: Z–A</option></select></label>
<button id="applyFilters">Apply filters</button><span id="galleryCount" class="meta"></span>
</nav><p class="meta">Decisions stay visible. Apply filters when you want to update this gallery.</p>
<div id="comparisonSummary"></div><div class="gallery" id="gallery"></div><button id="more" hidden>Show more</button>
<dialog id="detail" aria-label="Review image"><div class="dialogHead"><strong id="dialogName"></strong><button id="closeDetail">Back to gallery</button></div>
<div class="layout"><section>
<div class="panel empty" id="emptyView" hidden></div>
<div class="views" id="views">
<div class="panel"><h2>Slice</h2><div class="cwrap"><canvas id="slice" width="640" height="640"></canvas><div class="zbadge"><span id="sliceLevel" title="How many times closer than the whole slice">1×</span><button id="sliceReset" hidden title="Back to the start view">Reset</button></div></div>
<nav><label><input type="checkbox" id="showBoxes" checked> boxes (H)</label><span class="meta">Click a box to select it · scroll or pinch to zoom, drag or two-finger drag to move</span></nav>
<p class="why" id="why"></p><div class="boxes" id="boxes"></div>
<div class="legend" id="legend"></div></div>
<nav><label><input type="checkbox" id="pixel"> pixels</label><label><input type="checkbox" id="refs" checked> reference boxes</label>
<button id="frameBtn" hidden>Show on the pallet</button>
<a id="ziraLink" class="button" target="_blank" rel="noopener noreferrer" title="Key O" hidden>Open in Zira ↗</a></nav>
<div id="comparisonDetail"></div><details class="where"><summary>Frame and slice names</summary><div><b id="frameName" title="The frame's name in Zira"></b> <span class="meta" id="spot"></span>
<div class="meta">Slice <code id="sliceName"></code> <button id="copyName" title="Copy the frame and slice names">Copy</button></div></div></details>
</div>
<div class="panel" id="framePanel" hidden style="margin-top:12px"><h2>On the pallet</h2><div class="cwrap"><canvas id="frame" width="1200" height="1200"></canvas><div class="zbadge"><span id="frameLevel" title="How many times closer than the whole pallet">1×</span><button id="zoomFit" hidden title="Back to the start view">Reset</button></div></div>
<nav><button id="zoomSlice" title="Key Z">Zoom to slice</button><button id="zoomOut" title="Key -">−</button><button id="zoomIn" title="Key +">+</button>
<span class="meta" id="zoomText">Scroll or pinch to zoom, drag or two-finger drag to move, double-click to zoom in.</span></nav></div>
<nav><button id="prev">← Back</button><button id="next">Next →</button>

<span class="meta" id="pos"></span></nav>
</section><aside id="aside">
<div class="panel"><h2>What is it?</h2><div class="buttons" id="choices"></div><p id="err"></p></div>
<details class="panel" style="margin-top:12px"><summary>Details</summary><div class="chips" id="chips"></div><div class="meta" id="meta"></div></details>
<details class="panel guide" style="margin-top:12px"><summary>How to tell</summary><div id="guide"></div></details>
</aside></div></dialog></div>
<div class="panel empty" id="emptyArea" hidden>Choose where to look and which model to use, then press Find.</div>
</main>
<script>
${contentRect.toString()}
${galleryOrder.toString()}
const base = location.pathname;
let S = null, O = null, order = [], at = 0, box = "0", showRefs = true;
const $ = id => document.getElementById(id);
const img = new Image(), frameImg = new Image();
// Load the original pallet only when its optional view is open.
let frameKey = null;
const frameKeyOf = i => S.run + "|" + i;
function loadFrame() {
  const item = S.items[order[at]];
  if ($("framePanel").hidden || !S.framesAvailable || !item.frame || frameKey === frameKeyOf(order[at])) return;
  const key = frameKeyOf(order[at]);
  frameImg.onload = () => { if (key !== frameKeyOf(order[at])) return; frameKey = key; if (!$("framePanel").hidden) frameLoaded(); };
  frameImg.src = base + "frame?i=" + order[at] + "&r=" + encodeURIComponent(S.run);
}
const KEYS = {};
const NAMES = { nail: "Nail", protrudeNail: "Protruding nail", flushNail: "Flush nail", raisedNail: "Raised nail", knot: "Knot" };
const h = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nice = l => h(NAMES[l] || String(l).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase()));
const plural = l => nice(l).toLowerCase() + "s";
const both = list => list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0] || "";
const isTarget = v => S.targets.includes(v);
const wanted = () => both(S.targets.map(plural));
const day = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const choiceOf = (item, key) => (S.decisions[item.image]?.boxes || {})[key];
const pending = item => item.candidates.some((c, i) => !choiceOf(item, String(i)));
const touched = item => Object.keys(S.decisions[item.image]?.boxes || {}).length > 0;
const reviewed = item => touched(item) && !pending(item);
const unsure = item => Object.values(S.decisions[item.image]?.boxes || {}).includes("skip");
const todo = item => item.candidates.length ? pending(item) : !touched(item);
const accepted = item => Object.values(S.decisions[item.image]?.boxes || {}).some(isTarget);
function filtered() {
  return galleryOrder(S.items, S.decisions, S.targets, {status: $("filter").value, search: $("searchFiles").value, sort: $("sort").value});
}
let visible = 80;
const savedViews = new Map();
function refreshGallery() {
  order = filtered(); at = 0; visible = 80; savedViews.set(S.run, {order: [...order], at, visible}); renderGallery(); render();
}
function renderGallery() {
  const gallery = $("gallery"); gallery.replaceChildren();
  $("galleryCount").textContent = order.length + " images";
  $("more").hidden = visible >= order.length;
  for (const index of order.slice(0, visible)) {
    const item = S.items[index], tile = document.createElement("button"), canvas = document.createElement("canvas");
    tile.className = "tile"; tile.dataset.index = index; tile.append(canvas);
    const caption = document.createElement("div"); caption.className = "caption";
    const name = document.createElement("div"); name.textContent = item.image.split("/").pop(); caption.append(name);
    const statusRow = document.createElement("div"); statusRow.className = "statusRow";
    const status = document.createElement("span"); status.className = "statusBadge"; status.id = "status-" + index;
    const score = document.createElement("small"), confidence = Math.max(0, ...item.candidates.map(c => c.score || 0));
    score.textContent = confidence ? Math.round(confidence * 100) + "%" : "";
    statusRow.append(status, score); caption.append(statusRow); tile.append(caption);
    tile.onclick = () => { at = order.indexOf(index); box = "0"; resetView("slice"); $("framePanel").hidden = true; $("detail").showModal(); render(); };
    gallery.append(tile); updateTile(index);
    const thumbnail = new Image();
    thumbnail.onload = () => {
      const W = thumbnail.naturalWidth, H = thumbnail.naturalHeight, [x,y,w,hh] = contentRect(item, W, H);
      canvas.width = w; canvas.height = hh; const g = canvas.getContext("2d");
      g.drawImage(thumbnail,x,y,w,hh,0,0,w,hh); g.strokeStyle = "#e8890c"; g.lineWidth = 1;
      for (const b of item.candidates) g.strokeRect((b.x-b.w/2)*W-x,(b.y-b.h/2)*H-y,b.w*W,b.h*H);
    };
    thumbnail.onerror = () => { status.textContent = "Image unavailable"; };
    thumbnail.src = base + "slice?i=" + index + "&r=" + encodeURIComponent(S.run);
  }
}
function updateTile(index) {
  const item = S.items[index], el = $("status-" + index); if (!el) return;
  const status = unsure(item) ? "unsure" : touched(item) && pending(item) ? "partial" : accepted(item) ? "accepted" : reviewed(item) ? "reviewed" : "todo";
  el.closest(".tile").dataset.status = status;
  el.textContent = {partial:"◐ Partly reviewed",unsure:"? Unsure",accepted:"✓ Accepted",reviewed:"✓ Reviewed",todo:"○ Not reviewed"}[status];
}
function boxesOf(item) {
  const list = item.candidates.map((c, i) => ({ key: String(i), b: c, kind: "candidate", label: "Possible " + nice(c.class || S.target).toLowerCase() + " " + (i + 1) + " · " + Math.round(c.score * 100) + "%" + (c.referenceClass ? " · labeled " + nice(c.referenceClass) : "") }));
  const covered = new Set(item.candidates.map(c => c.referenceIndex).filter(i => i !== undefined));
  item.truth.forEach((t, i) => { if (!covered.has(i)) list.push({ key: "r" + i, b: t, kind: "reference", label: nice(S.dataset.classNames[t.classId]) + " " + (i + 1) }); });
  // The model's other detections where nothing is labeled: a nail the camera missed can be marked too.
  (item.others || []).forEach((o, i) => list.push({ key: "m" + i, b: o, kind: "other", label: "Model: " + nice(o.class).toLowerCase() + " " + (i + 1) + " · " + Math.round(o.score * 100) + "%" }));
  return list;
}
// Boxes in the colour of their decision; k maps slice fractions to canvas units from (ox, oy), pad pushes
// the outline outward so it does not cover the nail's edge, and lines keep their on-screen width at any zoom.
function drawBoxes(g, item, k, ox, oy, z, pad, kh = k) {
  for (const x of showBoxes ? boxesOf(item) : []) {
    if (x.kind === "reference" && !showRefs && x.key !== box) continue;
    const on = x.key === box, d = choiceOf(item, x.key), p = pad / z;
    g.lineWidth = (on ? 4 : x.kind === "other" ? 3 : 2.5) / z; g.setLineDash(x.kind === "candidate" ? [7 / z, 4 / z] : x.kind === "other" ? [4 / z, 3 / z] : []);
    g.strokeStyle = isTarget(d) ? "#1f9d55" : d === "reject" ? "#d93636" : d === "skip" ? "#9a9a93" : x.kind === "candidate" ? "#e8890c" : x.kind === "other" ? "#c08cff" : "#6ea0ff";
    g.strokeRect((x.b.x - x.b.w / 2) * k - ox - p, (x.b.y - x.b.h / 2) * kh - oy - p, x.b.w * k + 2 * p, x.b.h * kh + 2 * p);
  }
  g.setLineDash([]);
}
function drawSlice() {
  const item = S.items[order[at]], c = $("slice"), g = c.getContext("2d");
  if (!item || !img.naturalWidth) return;
  const [left, top, width, height] = contentRect(item, img.naturalWidth, img.naturalHeight);
  c.width = width; c.height = height;
  g.imageSmoothingEnabled = !$("pixel").checked;
  useView(g, "slice");
  g.drawImage(img, left, top, width, height, 0, 0, width, height);
  drawBoxes(g, item, img.naturalWidth, left, top, VIEWS.slice.z, 0, img.naturalHeight);
  g.setTransform(1, 0, 0, 1, 0, 0);
}
const times = z => (z >= 10 ? Math.round(z) : Math.round(z * 10) / 10) + "×";
// The cropped slice zooms from canvas point (v.x, v.y); new images start whole.
const VIEWS = { slice: { x: 0, y: 0, z: 1 } }, shown = { image: null, box: null };
let showBoxes = true;
function resetView(id) { Object.assign(VIEWS[id], { x: 0, y: 0, z: 1, still: id === "slice" }); $(id + "Reset").hidden = true; }
function useView(g, id) {
  const v = VIEWS[id], c = $(id);
  v.z = Math.min(MAX_ZOOM, Math.max(1, v.z));
  v.x = Math.min(c.width - c.width / v.z, Math.max(0, v.x)); v.y = Math.min(c.height - c.height / v.z, Math.max(0, v.y));
  $(id + "Reset").hidden = v.z === 1; v.still = v.z === 1; $(id + "Level").textContent = times(v.z);
  g.setTransform(v.z, 0, 0, v.z, -v.x * v.z, -v.y * v.z);
}
// Select the smallest box under the pointer, accounting for removed padding and zoom.
function pickBox(p) {
  if (!S || S.empty || !order.length) return;
  const item = S.items[order[at]], W = img.naturalWidth, H = img.naturalHeight;
  const [left, top] = contentRect(item, W, H), nx = (p.x + left) / W, ny = (p.y + top) / H;
  const pad = 6 / W / VIEWS.slice.z, pady = 6 / H / VIEWS.slice.z;
  const hits = (showBoxes ? boxesOf(item) : []).filter(x => (x.kind !== "reference" || showRefs || x.key === box) &&
    Math.abs(nx - x.b.x) <= x.b.w / 2 + pad && Math.abs(ny - x.b.y) <= x.b.h / 2 + pady);
  if (!hits.length) return;
  hits.sort((a, b) => a.b.w * a.b.h - b.b.w * b.b.h);
  box = hits[0].key; render();
}
function setBoxes(on) {
  showBoxes = on; $("showBoxes").checked = on;
  if (S && !S.empty && order.length) { drawSlice(); if (!$("framePanel").hidden) drawFrame(); }
}
// Wheel events come from mice and trackpads alike. A pinch arrives with ctrlKey and zooms; a two-finger drag pans;
// a mouse wheel zooms as before. Chrome and Safari report a trackpad's wheelDeltaY as exactly -3 × deltaY and a
// mouse's otherwise; a sideways delta is always a trackpad. A trackpad gesture keeps panning until it pauses, so it
// does not flip to zooming halfway.
let panUntil = 0;
function wheelKind(e) {
  if (e.ctrlKey) return "pinch";
  const mouse = e.deltaMode !== 0 || (e.deltaX === 0 && e.wheelDeltaY !== undefined && e.wheelDeltaY !== -3 * e.deltaY);
  if (!mouse || e.timeStamp < panUntil) { panUntil = e.timeStamp + 250; return "pan"; }
  return "zoom";
}
// Wheel steps in pixels: Firefox reports lines (or pages) for many mice.
const wheelY = e => e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
// Dragging with the left button or the wheel button moves the view; the wheel button's autoscroll is turned off.
const dragButton = e => e.button === 0 || e.button === 1;
function noAutoscroll(c) { c.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); }); }
function zoomable(id, redraw, onClick) {
  const c = $(id);
  let from = null;
  const point = e => {
    const r = c.getBoundingClientRect(), v = VIEWS[id], px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    return { px, py, x: v.x + px * c.width / v.z, y: v.y + py * c.height / v.z };
  };
  // Keeps the canvas point under the cursor in place.
  const to = (p, z) => { const v = VIEWS[id]; v.z = Math.min(MAX_ZOOM, Math.max(v.min ?? 1, z)); v.x = p.x - p.px * c.width / v.z; v.y = p.y - p.py * c.height / v.z; redraw(); };
  c.addEventListener("wheel", e => {
    const kind = wheelKind(e), v = VIEWS[id];
    if (kind === "pan" && (v.still ?? v.z === 1)) return; // nothing to move: let the page scroll
    e.preventDefault();
    if (kind === "pan") { const k = c.width / v.z / c.getBoundingClientRect().width; v.x += e.deltaX * k; v.y += e.deltaY * k; redraw(); }
    else to(point(e), v.z * Math.exp(-wheelY(e) * (kind === "pinch" ? 0.01 : 0.002)));
  }, { passive: false });
  c.addEventListener("dblclick", e => to(point(e), VIEWS[id].z * 2));
  noAutoscroll(c);
  c.addEventListener("pointerdown", e => {
    if (!dragButton(e)) return;
    from = { x: e.clientX, y: e.clientY, vx: VIEWS[id].x, vy: VIEWS[id].y, moved: false, button: e.button }; c.setPointerCapture(e.pointerId); c.classList.add("drag");
  });
  c.addEventListener("pointermove", e => {
    if (!from) return;
    // A few pixels of movement is still a click, not a drag.
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) from.moved = true;
    const r = c.getBoundingClientRect(), v = VIEWS[id], k = c.width / v.z / r.width;
    v.x = from.vx - (e.clientX - from.x) * k; v.y = from.vy - (e.clientY - from.y) * k; redraw();
  });
  const end = () => { from = null; c.classList.remove("drag"); };
  c.addEventListener("pointerup", e => { const click = from && !from.moved && from.button === 0; end(); if (click && onClick) onClick(point(e)); });
  c.addEventListener("pointercancel", end);
  $(id + "Reset").onclick = () => { resetView(id); redraw(); };
}
// The pallet view shows the part of the frame from (view.x, view.y), view.z times closer than the whole frame.
// Moving to another slice keeps the zoom and centers on the new slice, so a close look can follow along.
const view = { x: 0, y: 0, z: 1 }, MAX_ZOOM = 16;
function clampView() {
  const W = frameImg.naturalWidth, H = frameImg.naturalHeight;
  view.z = Math.min(MAX_ZOOM, Math.max(1, view.z));
  view.x = Math.min(W - W / view.z, Math.max(0, view.x)); view.y = Math.min(H - H / view.z, Math.max(0, view.y));
}
function zoomAt(fx, fy, z, px = 0.5, py = 0.5) {
  // Keeps frame point (fx, fy) at the same place (px, py fractions) on the canvas.
  view.z = Math.min(MAX_ZOOM, Math.max(1, z));
  view.x = fx - px * frameImg.naturalWidth / view.z; view.y = fy - py * frameImg.naturalHeight / view.z;
  clampView(); drawFrame();
}
function zoomToSlice() {
  const item = S.items[order[at]];
  if (!frameImg.naturalWidth || !item.crop) return;
  const [l, t, w, hh] = item.crop;
  // The slice with about its own size of pallet around it.
  zoomAt(l + w / 2, t + hh / 2, Math.min(frameImg.naturalWidth / (w * 3), frameImg.naturalHeight / (hh * 3)));
}
function drawFrame() {
  const item = S.items[order[at]], c = $("frame"), g = c.getContext("2d");
  if (!frameImg.naturalWidth || !item.crop) return;
  clampView();
  const W = frameImg.naturalWidth, H = frameImg.naturalHeight, vw = W / view.z, vh = H / view.z;
  c.height = Math.round(H * c.width / W);
  const scale = c.width / vw;
  g.imageSmoothingEnabled = !$("pixel").checked;
  g.drawImage(frameImg, view.x, view.y, vw, vh, 0, 0, c.width, c.height);
  const [l, t, w, hh] = item.crop; g.strokeStyle = "#e8890c"; g.lineWidth = 3; if (showBoxes) g.strokeRect((l - view.x) * scale, (t - view.y) * scale, w * scale, hh * scale);
  $("frameLevel").textContent = times(view.z); $("zoomFit").hidden = view.z <= 1;
}
function frameLoaded() {
  if (view.z > 1) { const [l, t, w, hh] = S.items[order[at]].crop || [0, 0, 0, 0]; zoomAt(l + w / 2, t + hh / 2, view.z); }
  else drawFrame();
}
// Canvas position (CSS pixels) to frame pixels and canvas fractions.
function framePoint(e) {
  const r = $("frame").getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  return { px, py, fx: view.x + px * frameImg.naturalWidth / view.z, fy: view.y + py * frameImg.naturalHeight / view.z };
}
// Zira's image review opens one QA frame by its storage key, base64url-encoded, and shows its whole session.
function ziraUrl(item) {
  const cam = O && O.camera;
  if (!cam || !O.web || !cam.companyId || !cam.site.id || cam.id !== S.dataSourceId || !item.session || !item.frame) return "";
  const [d, session] = item.session.split("::");
  const key = "companies/" + cam.companyId + "/sites/" + cam.site.id + "/data-sources/" + cam.id + "/datasets/snapshots/" + d + "/" + session + "/images/" + item.frame;
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(key))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  return O.web + "/image-review/" + encoded + "?dataSourceId=" + encodeURIComponent(cam.id);
}
// The frame's name as Zira's image review shows it ("DISC 2026-10-19 15:21:09"), and where the slice sits:
// slice names end in __b<board>-s<stringer>, counted from 0, boards top to bottom and stringers left to right.
const ZIRA_NAME = /^(?:(.+)-)?(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}(?::?\\d{2})?)?(?:\\(\\d+\\))?$/i;
const stem = name => String(name).split("/").pop().replace(/\\.[^.]+$/, "");
function ziraName(frame) {
  const m = stem(frame).match(ZIRA_NAME);
  return m ? [String(m[1] || "").replace(/-+$/, ""), m[2] + " " + m[3] + ":" + m[4] + ":" + m[5]].filter(Boolean).join(" ") : stem(frame);
}
function spotOf(item) {
  const m = stem(item.image).match(/__b(\\d+)-s(\\d+)$/);
  return m ? "board " + (Number(m[1]) + 1) + " from the top, stringer " + (Number(m[2]) + 1) + " from the left" : "";
}
// What the reference said at the selected box: the label it overlaps, or nothing there.
function camAnswer(item, key) {
  if (/^m\\d+$/.test(key)) return "reject"; // shown only where the camera labeled nothing
  if (/^r\\d+$/.test(key)) return S.dataset.classNames[item.truth[Number(key.slice(1))]?.classId] ?? null;
  const c = item.candidates[Number(key)];
  return !c ? null : c.referenceClass || "reject";
}
const camText = () => S.labelsFrom === "sessions" ? "what the camera's models found here" : "what the dataset version says here";
function sourceText() {
  return S.labelsFrom === "sessions"
    ? "what the camera&#39;s own models found during the QA sessions (or a reviewer&#39;s correction)"
    : "the dataset version <b>" + h(S.datasetName) + "</b> (what annotators drew)";
}
function why(item) {
  const c = item.candidates, parts = [];
  const counts = {};
  c.forEach(x => { const k = x.class || S.target; counts[k] = (counts[k] || 0) + 1; });
  if (c.length) parts.push("the model marked " + both(Object.entries(counts).map(([k, n]) => n + " possible " + (n > 1 ? plural(k) : nice(k).toLowerCase()))) + " here" +
    (c[0].referenceClass ? ", where the existing label says " + nice(c[0].referenceClass).toLowerCase() : ", where nothing is labeled") + ".");
  if (item.marks.length) parts.push("A reviewer marked it in Zira&#39;s QA review: " + item.marks.map(h).join(", ") + ".");
  const o = (item.others || []).length;
  if (o) parts.push("It also found " + o + " other nail" + (o > 1 ? "s" : "") + " (purple) where nothing is labeled; mark one if it is " + (S.targets.length > 1 ? "one of them" : "one") + " too.");
  if (!c.length && !o) parts.push("The model found nothing here; look at the labeled nails.");
  return parts.join(" ").replace(/^the/, "The");
}
function render() {
  const has = S && !S.empty;
  $("reviewArea").hidden = !has; $("emptyArea").hidden = has || !O;
  if (!has) { $("title").textContent = "Find examples to review"; $("lead").innerHTML = ""; $("count").textContent = ""; $("sub").textContent = O ? O.camera.name + " · " + O.camera.site.name : ""; return; }
  const tl = S.tally;
  $("title").textContent = ("Review possible " + wanted()).replace(/&#39;/g, "'");
  $("sub").textContent = [O ? O.camera.name : "", S.datasetName, S.dataset.slices + " slices", S.model].filter(Boolean).join(" · ");
  $("lead").innerHTML = "Look at each orange box and choose what it really is. If you can&#39;t tell, choose <b>Unsure</b>. Your answers are saved as you go.<br>" +
    "<span class='cand'>Orange</span>: possible " + wanted() + " the model pointed out. <span class='ref'>Blue</span>: labels from " + sourceText() + ". <span class='oth'>Purple</span>: other nails the model found where nothing is labeled; click one to mark it.";
  $("legend").innerHTML = "<span><i class='lc'></i>the model&#39;s suggestion</span><span><i class='lr'></i>existing label</span><span><i class='lm'></i>the model&#39;s other finds</span><span><i class='lg'></i>you: yes</span>" +
    "<span><i class='ln'></i>you: not this</span><span><i class='lu'></i>you: unsure</span>";
  $("count").textContent = tl.accepted + " accepted · " + tl.reviewed + " of " + tl.toReview + " reviewed" + (tl.unsure ? " · " + tl.unsure + " unsure" : "") + (tl.known ? " · " + tl.known + " already labeled" : "");
  $("progress").style.width = (tl.toReview ? 100 * tl.reviewed / tl.toReview : 0) + "%";
  $("views").hidden = !order.length; $("emptyView").hidden = !!order.length; $("aside").hidden = !order.length;
  if (!order.length) {
    $("pos").textContent = "";
    $("emptyView").textContent = $("filter").value === "todo" && tl.reviewed === tl.toReview ? "All " + tl.toReview + " slices are reviewed. To look at them again, choose All in the menu below, or change the search." : "No slices in this view.";
    $("choices").innerHTML = ""; return;
  }
  at = Math.max(0, Math.min(at, order.length - 1));
  if (!$("detail").open) return;
  const item = S.items[order[at]];
  $("dialogName").textContent = item.image;
  renderComparison(item);
  const list = boxesOf(item);
  if (!list.some(x => x.key === box)) box = list[0]?.key ?? "slice";
  $("pos").textContent = (at + 1) + " / " + order.length;
  $("boxes").innerHTML = list.map(x => '<button data-k="' + h(x.key) + '" class="' + (x.key === box ? "on" : "") + '">' + x.label + (choiceOf(item, x.key) ? " → " + nice(choiceOf(item, x.key)) : "") + "</button>").join("");
  const current = choiceOf(item, box), cam = camAnswer(item, box);
  const choice = (l, cls, title, text) => '<button data-l="' + h(l) + '" title="' + title + (l === cam ? " · " + h(camText()) : "") + '" class="' + cls + (l === cam ? " cam" : "") +
    '" aria-pressed="' + (current === l) + '">' + text + "</button>";
  $("choices").innerHTML = (box === "slice" ? '<p class="meta">Nothing was found or labeled on this slice. If you see the defect, label it in Zira&#39;s QA review; here you can only dismiss it or mark it unsure.</p>' : "") +
    (box === "slice" ? [] : S.labels).map((l, i) => choice(l, isTarget(l) ? "target" : "", "Key " + (i + 1), nice(l))).join("") +
    choice("reject", "reject", "Key R", "Reject proposal / nothing here") + choice("skip", "skip", "Key S", "Unsure, can&#39;t tell") +
    (cam ? '<p class="meta">Dashed: ' + h(camText()) + ".</p>" : "");
  S.labels.forEach((l, i) => { KEYS[String(i + 1)] = l; });
  $("chips").innerHTML = [item.labelSource ? (item.labelSource === "annotations" ? "reviewer-corrected labels" : "labels from the camera&#39;s models") : "",
    ...item.marks.map(m => '<span class="mark">' + h(m) + "</span>"), item.known ? item.known + " already labeled" : ""].filter(Boolean).map(t => t.startsWith("<span") ? t : "<span>" + t + "</span>").join("");
  $("meta").textContent = [item.session ? "Session " + item.session : "", item.frame || "", item.id ? "Slice " + item.id : "", item.image].filter(Boolean).join(" · ");
  $("why").innerHTML = "<b>Why this slice:</b> " + why(item);
  $("frameBtn").hidden = !(S.framesAvailable && item.frame);
  const link = ziraUrl(item); $("ziraLink").hidden = !link; if (link) $("ziraLink").href = link;
  $("frameName").textContent = item.frame ? ziraName(item.frame) : stem(item.image);
  $("spot").textContent = spotOf(item);
  $("sliceName").textContent = stem(item.image);
  if (item.image !== shown.image) { resetView("slice"); }
  shown.image = item.image; shown.box = box;
  if (sliceParam() !== stem(item.image)) history.replaceState(null, "", base + "?slice=" + encodeURIComponent(stem(item.image)));
  img.onerror = () => { $("slice").getContext("2d").clearRect(0,0,$("slice").width,$("slice").height); $("err").textContent = "Image unavailable; keep the dataset in its original location."; };
  frameImg.onerror = () => { $("frame").getContext("2d").clearRect(0,0,$("frame").width,$("frame").height); $("err").textContent = "Original pallet frame unavailable."; };
  img.onload = drawSlice; img.src = base + "slice?i=" + order[at] + "&r=" + encodeURIComponent(S.run);
  loadFrame();
}
let queue = Promise.resolve();
function decide(label) {
  if (!S || S.empty || !order.length || !$("detail").open) return;
  const request = {run: S.run, index: order[at], box, label};
  queue = queue.then(() => save(request)).catch(e => { $("err").textContent = e.message; });
}
async function save(request) {
  const res = await fetch(base + "decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const out = await res.json();
  if (!res.ok) throw new Error(out.message || "Not saved");
  if (S.run !== request.run) return;
  $("err").textContent = "";
  S.decisions[S.items[request.index].image] = { boxes: out.boxes }; S.tally = out.tally;
  updateTile(request.index); render();
}
function renderComparison(item) {
  const models = S.comparisons || [];
  $("comparisonSummary").innerHTML = models.length > 1 ? '<p>Same images, labels and scan settings. Candidate counts and scores are not accuracy. Decisions belong to the active model.</p><table class="modelTable"><thead><tr><th>Model</th><th>Candidate boxes</th><th>Images to review</th><th>Scan seconds</th></tr></thead><tbody>' + models.map(m => '<tr><td><button data-model="' + h(m.run) + '" ' + (m.run === S.run ? 'disabled' : '') + '>' + h(m.model) + ' · ' + h((m.sha256 || '').slice(0,8)) + '</button></td><td>' + h(m.candidateBoxes ?? 'Unknown') + '</td><td>' + h(m.toReview ?? 'Unknown') + '</td><td>' + h(m.elapsedSeconds ?? 'Unknown') + '</td></tr>').join('') + '</tbody></table>' : '';
  if (models.length > 1) {
    const rows = models.flatMap(m => Object.entries(m.metrics?.bySource || {}).flatMap(([source, classes]) => Object.entries(classes).map(([label, v]) => '<tr><td>' + h(m.model) + '</td><td>' + nice(label) + '</td><td>' + h(source === 'device' ? 'Device output (unverified)' : source === 'annotations' ? 'Reviewer corrections' : source === 'dataset' ? 'Dataset labels (review unverified)' : 'Unknown (unverified)') + '</td><td>' + h(v.tp) + ' / ' + h(v.fp) + ' / ' + h(v.fn) + '</td><td>' + (v.precision === null ? '—' : Math.round(v.precision * 100) + '%') + '</td><td>' + (v.recall === null ? '—' : Math.round(v.recall * 100) + '%') + '</td></tr>')));
    if (rows.length) $("comparisonSummary").innerHTML += '<details><summary>Reference agreement by class and label source</summary><p>IoU 0.5 at the scan threshold. Device output is unverified. Reviewer corrections may be incomplete. Use an independently reviewed holdout to judge accuracy.</p><table class="modelTable"><thead><tr><th>Model</th><th>Class</th><th>Reference source</th><th>TP / FP / FN</th><th>Precision</th><th>Recall</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' + models.map(m => '<p>' + h(m.model) + ': ' + h(m.metrics?.invalidLabelImages || 0) + ' invalid-label images excluded; classes without reference coverage: ' + h((m.metrics?.unavailableClasses || []).join(', ') || 'none') + '.</p>').join('') + '</details>';
  }
  if (!item) return;
  $("comparisonDetail").innerHTML = models.length > 1 ? '<h2>Predictions on this image</h2>' + models.map(m => {
    const row = m.predictions?.find(r => r.image === item.image);
    return '<p><button data-model="' + h(m.run) + '" ' + (m.run === S.run ? 'disabled' : '') + '>' + h(m.model) + '</button>: ' + (row ? row.predictions.map(p => nice(p.class) + ' ' + Math.round(p.score * 100) + '%').join(', ') || 'No target prediction above threshold' : 'Not recorded') + '</p>';
  }).join('') : '';
}
const selectComparisonModel = async e => {
  const button = e.target.closest('[data-model]'); if (!button) return;
  const image = S.items[order[at]]?.image, wasOpen = $("detail").open;
  savedViews.set(S.run, {order: [...order], at, visible});
  await queue;
  const res = await fetch(base + 'select-model', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:button.dataset.model})});
  if (!res.ok) { $("jobText").textContent = (await res.json()).message; return; }
  await loadState();
  const position = order.findIndex(i => S.items[i].image === image);
  if (position >= 0) at = position; else if (wasOpen) $("detail").close();
  render();
};
$("comparisonSummary").onclick = selectComparisonModel;
$("comparisonDetail").onclick = selectComparisonModel;
$("compareRun").onclick = async () => {
  if (!$("runs").value) return;
  await queue;
  const res = await fetch(base + 'compare', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runs:[...(S.comparisons || []).filter(m => m.run !== S.run).map(m => m.run), $('runs').value]})});
  if (!res.ok) { $("jobText").textContent = (await res.json()).message; return; }
  $("detail").close(); await loadState();
};
// ---- choosing what to search
// Daily batches start at 00:00 UTC; show those as the whole day rather than a local clock time.
function sessionLabel(s) {
  const a = s.sessionAt ? new Date(s.sessionAt) : null;
  if (!a) return s.id;
  if (/-00-00-00$/.test(s.session)) return day(s.day + "T12:00:00Z") + " (whole day)";
  return a.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
const kind = () => document.querySelector("input[name=kind]:checked")?.value || "";
const MERGED = "__other__";
// Versions grouped by their dataset, newest dataset first, like Zira's Datasets tab.
function datasets() {
  const groups = new Map();
  for (const v of O.versions) {
    const key = v.dataset || MERGED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return [...groups].map(([key, versions]) => ({ key, name: key === MERGED ? "Merged or staged versions" : key, versions }));
}
function fillSetup() {
  $("setup").hidden = false;
  const sessions = O.sessions.available ? O.sessions.list : [];
  const radio = v => document.querySelector("input[name=kind][value=" + v + "]");
  radio("sessions").disabled = !sessions.length;
  radio("dataset").disabled = !O.versions.length;
  $("kindNote").hidden = !!sessions.length;
  $("kindNote").textContent = sessions.length ? "" : (O.sessions.note || "This camera has no QA sessions.");
  setSummary();
  const days = [...new Set(sessions.map(s => s.day))].slice(0, 7);
  $("sessions").innerHTML = sessions.length ? '<option value="' + h(sessions[0].id) + '">Latest session · ' + h(sessionLabel(sessions[0])) + "</option>" +
    days.map(d => { const ids = sessions.filter(s => s.day === d).map(s => s.id); return '<option value="' + h(ids.join(",")) + '">All sessions of ' + h(day(d + "T12:00:00Z")) + " (" + ids.length + ")</option>"; }).join("") +
    sessions.slice(1, 20).map(s => '<option value="' + h(s.id) + '">Session ' + h(sessionLabel(s)) + "</option>").join("") : "";
  const groups = datasets();
  $("dataset").innerHTML = groups.map(g => '<option value="' + h(g.key) + '">' + h(g.name) + " · " + g.versions.length + " version" + (g.versions.length > 1 ? "s" : "") + "</option>").join("");
  // Start where the open search is, otherwise on new session frames when there are any.
  let chosen = sessions.length ? "sessions" : "dataset";
  if (S && !S.empty) {
    const name = String(S.datasetName).replace(/\\.zip$/i, "");
    const v = O.versions.find(v => v.name.replace(/\\.zip$/i, "") === name);
    if (v) { chosen = "dataset"; $("dataset").value = v.dataset || MERGED; fillVersions(); $("version").value = v.id; }
    else if (S.dataset.sessions?.length && sessions.length) {
      chosen = "sessions"; const val = S.dataset.sessions.join(",");
      if ([...$("sessions").options].some(o => o.value === val)) $("sessions").value = val;
    }
  }
  if (!$("version").options.length) fillVersions();
  if (!radio(chosen).disabled) radio(chosen).checked = true;
  const targets = O.targets.length ? O.targets : ["raisedNail"];
  const on = S && !S.empty ? S.targets.filter(t => targets.includes(t)) : [];
  const start = on.length ? on : [targets.includes("raisedNail") ? "raisedNail" : targets[0]];
  $("targets").innerHTML = targets.map(t => '<label><input type="checkbox" name="target" value="' + h(t) + '"' + (start.includes(t) ? " checked" : "") + "> " + nice(t) + "</label>").join("");
  document.querySelectorAll("input[name=target]").forEach(c => { c.onchange = fillModels; });
  fillModels(); kindChanged();
}
// While a search is open the choices fold into one line; with nothing open they stay visible.
function setSummary() {
  const open = S && !S.empty;
  const where = !open ? "" : S.labelsFrom === "sessions" ? "the QA session frames" : "the dataset version " + h(S.datasetName);
  $("setupSummary").innerHTML = open ? "Searching " + where + " for " + wanted() + '<span class="change">Change search</span>' : "Choose what to search";
  $("setup").open = !open;
}
function fillVersions() {
  const g = datasets().find(g => g.key === $("dataset").value);
  $("version").innerHTML = (g ? g.versions : []).map((v, i) => '<option value="' + h(v.id) + '">' + h(v.name.replace(/\\.zip$/i, "")) +
    (v.images ? " · " + v.images + " images" : "") + (v.createdAt ? " · " + h(day(v.createdAt)) : "") + (i === 0 ? " (newest)" : "") + "</option>").join("");
}
function kindChanged() {
  const k = kind();
  $("sessionRow").hidden = k !== "sessions"; $("datasetRow").hidden = k !== "dataset";
  $("go").disabled = !$("model").value || !k || (k === "sessions" ? !$("sessions").value : !$("version").value);
}
const checked = () => [...document.querySelectorAll("input[name=target]:checked")].map(c => c.value);
function fillModels() {
  const ts = checked(), list = ts.length ? O.models.filter(m => ts.every(t => m.labels.includes(t))) : [];
  $("model").innerHTML = list.map(m => '<option value="' + h(m.id) + '">' + h(m.name) + (m.createdAt ? " · " + h(day(m.createdAt)) : "") +
    (O.camera && m.camera && m.camera !== O.camera.name ? " · from " + h(m.camera) : "") + "</option>").join("") ||
    '<option value="">' + (ts.length ? "No model here was trained to recognize all of these" : "Choose what you are looking for first") + "</option>";
  if (S && !S.empty) { const m = list.find(m => m.name === S.model); if (m) $("model").value = m.id; }
  $("go").textContent = ts.length && ts.length <= 2 ? ("Find " + both(ts.map(plural))).replace(/&#39;/g, "'") : "Find them";
  if (!$("model").selectedOptions.length && $("model").options.length) $("model").options[0].selected = true;
  kindChanged();
}
// Earlier searches by what they searched (a session's day or the dataset), then when they ran.
function searched(r) {
  const name = String(r.dataset || ""), m = name.match(/^qa-(\\d{4}-\\d{2}-\\d{2})/);
  const what = m ? "Session " + day(m[1] + "T12:00:00Z") : name.replace(/_nails$/, "") || r.run.split("/").pop();
  return what + (r.createdAt ? " (searched " + day(r.createdAt) + ")" : "");
}
async function fillRuns() {
  const out = await (await fetch(base + "runs")).json();
  if (!out.runs || !out.runs.length) return;
  $("runsWrap").hidden = false;
  $("runs").innerHTML = '<option value="">Choose…</option>' + out.runs.map(r => '<option value="' + h(r.run) + '">' + h(searched(r)) + " · " + h(r.model) + " · " + r.accepted + " accepted of " + r.toReview + "</option>").join("");
}
async function search(confirm) {
  const sessions = kind() === "sessions", frames = $("frames").value;
  const body = { source: sessions ? { kind: "sessions", ids: $("sessions").value.split(",") } : { kind: "version", id: $("version").value },
    modelIds: [...$("model").selectedOptions].map(o => o.value), targets: checked(), ...(frames && sessions ? { frames: Number(frames) } : {}), ...(confirm ? { confirm: true } : {}) };
  $("go").disabled = true; $("confirmRow").hidden = true;
  const res = await fetch(base + "search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) { $("jobText").textContent = out.message || "Could not start"; $("go").disabled = false; return; }
  poll();
}
async function poll() {
  const j = await (await fetch(base + "job")).json();
  if (!j.state) return;
  const last = j.steps && j.steps.length ? j.steps[j.steps.length - 1].text : "";
  if (j.state === "running") { $("jobText").textContent = "Working: " + last + "…"; $("go").disabled = true; setTimeout(poll, 1500); return; }
  $("go").disabled = false;
  if (j.state === "confirm") { $("jobText").textContent = j.message; $("confirmRow").hidden = false; return; }
  if (j.state === "failed") { $("jobText").textContent = "Stopped: " + j.message; return; }
  $("jobText").textContent = "Done: " + (j.message || "");
  await loadState(); fillRuns(); setSummary();
}
// The address keeps the open slice (?slice=<name>), so reloading the page comes back to it.
const sliceParam = () => new URLSearchParams(location.search).get("slice");
function goToSlice(name) {
  const i = S.items.findIndex(it => stem(it.image) === name);
  if (i < 0) return;
  if (!order.includes(i)) order.push(i);
  at = order.indexOf(i);
  if (!$("detail").open) $("detail").showModal();
}
async function loadState() {
  S = await (await fetch(base + "state")).json();
  at = 0; box = "0";
  if (S && !S.empty) $("guide").innerHTML = (S.guidance.length ? S.guidance : ["Accept only what you would label as " + wanted() + " in Zira."]).map(t => "<p>" + h(t) + "</p>").join("");
  const previousView = S && savedViews.get(S.run);
  order = previousView ? previousView.order : S && !S.empty ? filtered() : [];
  at = previousView?.at ?? 0; visible = previousView?.visible ?? 80;
  if (S && !S.empty) { if (sliceParam()) goToSlice(sliceParam()); renderGallery(); renderComparison(); }
  render(); setSummary();
}
document.addEventListener("click", e => {
  const l = e.target.closest("[data-l]"), k = e.target.closest("[data-k]");
  if (l) decide(l.dataset.l);
  if (k) { box = k.dataset.k; render(); }
});
document.addEventListener("keydown", e => {
  if (["SELECT", "INPUT"].includes(e.target.tagName) || e.metaKey || e.ctrlKey || !S || S.empty || !$("detail").open || !order.length) return;
  const key = e.key.toLowerCase();
  if (KEYS[e.key]) decide(KEYS[e.key]);
  else if (key === "0" || key === "r") decide("reject");
  else if (key === "s") decide("skip");
  else if (key === "u") decide(null);
  else if (key === "arrowright" || key === "n") { at += 1; render(); }
  else if (key === "arrowleft" || key === "b") { at -= 1; render(); }
  else if (key === "]") { e.preventDefault(); const list = boxesOf(S.items[order[at]]); if (!list.length) return; box = list[(list.findIndex(x => x.key === box) + 1) % list.length].key; render(); }
  else if (key === "f" && !$("frameBtn").hidden) $("frameBtn").click();
  else if (key === "h") setBoxes(!showBoxes);
  else if (key === "o" && !$("ziraLink").hidden) window.open($("ziraLink").href, "_blank", "noopener,noreferrer");
  else if (!$("framePanel").hidden && frameImg.naturalWidth && ["+", "=", "-", "z"].includes(key)) {
    if (key === "z") zoomToSlice();
    else { const W = frameImg.naturalWidth / view.z, H = frameImg.naturalHeight / view.z; zoomAt(view.x + W / 2, view.y + H / 2, view.z * (key === "-" ? 1 / 1.5 : 1.5)); }
  }
});
$("prev").onclick = () => { at -= 1; render(); };
$("next").onclick = () => { at += 1; render(); };
zoomable("slice", drawSlice, pickBox);
$("showBoxes").onchange = e => setBoxes(e.target.checked);
$("copyName").onclick = async () => {
  const text = [$("frameName").textContent, $("spot").textContent, $("sliceName").textContent].filter(Boolean).join(" · ");
  try { await navigator.clipboard.writeText(text); $("copyName").textContent = "Copied"; } catch { $("copyName").textContent = "Copy failed"; }
  setTimeout(() => { $("copyName").textContent = "Copy"; }, 1500);
};
const frameCanvas = $("frame");
const zoomBy = f => { const W = frameImg.naturalWidth / view.z, H = frameImg.naturalHeight / view.z; zoomAt(view.x + W / 2, view.y + H / 2, view.z * f); };
$("zoomIn").onclick = () => zoomBy(1.5);
$("zoomOut").onclick = () => zoomBy(1 / 1.5);
$("zoomFit").onclick = () => { view.z = 1; drawFrame(); };
$("zoomSlice").onclick = zoomToSlice;
frameCanvas.addEventListener("wheel", e => {
  if (!frameImg.naturalWidth) return;
  const kind = wheelKind(e);
  if (kind === "pan" && view.z === 1) return; // nothing to move: let the page scroll
  e.preventDefault();
  if (kind === "pan") { const k = frameImg.naturalWidth / view.z / frameCanvas.getBoundingClientRect().width; view.x += e.deltaX * k; view.y += e.deltaY * k; drawFrame(); return; }
  const p = framePoint(e);
  zoomAt(p.fx, p.fy, view.z * Math.exp(-wheelY(e) * (kind === "pinch" ? 0.01 : 0.002)), p.px, p.py);
}, { passive: false });
noAutoscroll(frameCanvas);
frameCanvas.addEventListener("dblclick", e => { const p = framePoint(e); zoomAt(p.fx, p.fy, view.z * 2, p.px, p.py); });
let dragFrom = null;
frameCanvas.addEventListener("pointerdown", e => { if (!dragButton(e)) return; dragFrom = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; frameCanvas.setPointerCapture(e.pointerId); frameCanvas.classList.add("drag"); });
frameCanvas.addEventListener("pointermove", e => {
  if (!dragFrom) return;
  const r = frameCanvas.getBoundingClientRect(), k = frameImg.naturalWidth / view.z / r.width;
  view.x = dragFrom.vx - (e.clientX - dragFrom.x) * k; view.y = dragFrom.vy - (e.clientY - dragFrom.y) * k; drawFrame();
});
const dragEnd = () => { dragFrom = null; frameCanvas.classList.remove("drag"); };
frameCanvas.addEventListener("pointerup", dragEnd); frameCanvas.addEventListener("pointercancel", dragEnd);
$("pixel").onchange = () => { drawSlice(); if (!$("framePanel").hidden) drawFrame(); };
$("applyFilters").onclick = refreshGallery;
$("searchFiles").onkeydown = e => { if (e.key === "Enter") refreshGallery(); };
$("more").onclick = () => { visible += 80; renderGallery(); };
$("closeDetail").onclick = () => $("detail").close();
$("detail").onclose = () => history.replaceState(null, "", base);
$("refs").onchange = e => { showRefs = e.target.checked; drawSlice(); };
$("frameBtn").onclick = () => { const p = $("framePanel"); p.hidden = !p.hidden; if (!p.hidden) { if (frameKey === frameKeyOf(order[at])) frameLoaded(); else loadFrame(); } };
document.querySelectorAll("input[name=kind]").forEach(r => { r.onchange = kindChanged; });
$("dataset").onchange = () => { fillVersions(); kindChanged(); };
$("version").onchange = kindChanged;
$("sessions").onchange = kindChanged;
$("go").onclick = () => search(false);
$("confirmBtn").onclick = () => search(true);
$("openRun").onclick = async () => {
  const e = {target: $("runs")};
  if (!e.target.value) return;
  await queue; $("detail").close();
  const res = await fetch(base + "open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: e.target.value }) });
  if (res.ok) { await loadState(); fillSetup(); setSummary(); } else $("jobText").textContent = (await res.json()).message;
};
(async () => {
  await loadState();
  if (S.workspace) {
    $("setup").hidden = false; $("setup").open = true; $("jobText").textContent = "Loading this camera's datasets, sessions and models…";
    try {
      const res = await fetch(base + "options");
      O = await res.json();
      if (!res.ok) throw new Error(O.message || "Could not load the choices");
      $("jobText").textContent = ""; fillSetup(); fillRuns(); render(); poll();
    } catch (error) { $("jobText").textContent = error.message; }
  }
})();
</script></body></html>`;

// This document is a fixed template; run/customer data arrives as JSON through same-origin APIs.
// Hash its own script so adding an inline handler or another script does not grant execution.
const script = REVIEW_HTML.split("<script>")[1].split("</script>")[0];
const scriptHash = createHash("sha256").update(script, "utf8").digest("base64");
const REVIEW_CSP = `default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; img-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'`;

export function page() {
  // The header also forbids framing; frame-ancestors is not supported in a meta policy.
  return REVIEW_HTML.replace("<title>", `<meta http-equiv="Content-Security-Policy" content="${REVIEW_CSP}">\n<title>`);
}
