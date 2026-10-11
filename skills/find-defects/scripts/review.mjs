// Local review page for find-defects: serves one run's candidates on 127.0.0.1 and saves each decision
// to the run's decisions.json as it is made. With a workspace it also lets the person choose what to
// search (a dataset version or QA sessions, the class and the model) and switch between earlier
// searches. It reads only the runs' own slice and frame images and answers nothing but its own page.
import http from "node:http";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";

const MAX_BODY = 4096;
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp" };
export const SKIP = "skip", REJECT = "reject";

// What tells the defect apart, shown beside every candidate. Others get a neutral prompt.
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
export async function startReview({ run: runDir, workspace = null, runs = null, helperFile, idleMinutes = 240, port = 0, log = () => {} }) {
  if (!runDir && !helperFile) throw new Error("Give a run folder or a helper file");
  let current = runDir ? await loadRun(path.resolve(String(runDir))) : null;
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
  const open = async dir => { current = await loadRun(path.resolve(dir)); log(`Showing ${current.dir}`); };

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
    const target = current, { items, labels, run } = target;
    const item = items[wanted?.index];
    if (!item) throw bad("Unknown slice");
    const key = String(wanted.box ?? "");
    const isCandidate = /^\d+$/.test(key) && Number(key) < item.candidates.length;
    const isReference = /^r\d+$/.test(key) && Number(key.slice(1)) < item.truth.length;
    // A slice without boxes (a reviewer's mark, nothing found) can only be dismissed or marked unsure.
    const isSlice = key === "slice" && !item.candidates.length && !item.truth.length;
    if (!isCandidate && !isReference && !isSlice) throw bad("Unknown box");
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
        if (route === "search" && workspace) return send(res, 200, await workspace.search(json(body), { onDone: open }));
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
  await writeFile(helper, JSON.stringify({ port: server.address().port, token }));
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
<title>Find rare defects</title>
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
button:hover{border-color:var(--fg)}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}button:disabled{opacity:.5;cursor:default}
.lead{margin:0 0 12px;line-height:1.55}.lead .cand{color:var(--accent);font-weight:600}.lead .ref{color:var(--ref);font-weight:600}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}@media (max-width:900px){.layout{grid-template-columns:1fr}}
.views{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}@media (max-width:640px){.views{grid-template-columns:1fr}}
canvas{width:100%;height:auto;display:block;background:#000;border-radius:6px}
.buttons{display:grid;gap:8px}.buttons button{text-align:left;padding:10px 12px}
.buttons .target{border-color:var(--ok);font-weight:600}.buttons .reject{border-color:var(--no)}
.buttons button[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 18%,var(--card));border-color:var(--accent)}
.meta{color:var(--muted);font-size:12px;word-break:break-all}.chips span{display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:12px;border:1px solid var(--line);font-size:12px}
.chips .mark{border-color:var(--accent)}.guide{font-size:13px}.guide p{margin:0 0 6px}
.boxes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.boxes button{font-size:12px;padding:3px 8px;border-radius:12px}
.boxes button.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,var(--card))}
.why{margin:8px 0 0;font-size:13px}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px;margin-top:8px}
.legend i{display:inline-block;width:14px;height:10px;border:2px solid;margin-right:5px;vertical-align:-1px}
.lc{border-color:#e8890c!important;border-style:dashed!important}.lr{border-color:#6ea0ff!important}.lg{border-color:#1f9d55!important}.ln{border-color:#d93636!important}.lu{border-color:#9a9a93!important}
nav{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}nav select{font:inherit;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.empty{padding:28px;text-align:center;color:var(--muted)}#err{color:var(--no)}[hidden]{display:none!important}
</style></head><body><main>
<header><div><h1 id="title">Find rare defects</h1><div class="sub" id="sub"></div></div><div class="sub" id="count"></div></header>
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
<p class="q">Which model should point out possible ones?</p>
<div class="row"><label><select id="model"></select></label></div>
<p class="meta">Choose a model trained to recognize them. It only suggests where to look; you decide what each one is.</p>
<div class="row"><button id="go" class="primary">Find</button></div>
<p class="meta" id="jobText"></p><div id="confirmRow" hidden><button id="confirmBtn">Download and continue</button></div>
<div class="row" id="runsWrap" hidden><label>Or reopen an earlier search<select id="runs"></select></label></div>
</details>
<p class="lead" id="lead"></p>
<div id="reviewArea" hidden><div class="layout"><section>
<div class="panel empty" id="emptyView" hidden></div>
<div class="views" id="views">
<div class="panel"><h2>Slice</h2><canvas id="slice" width="640" height="640"></canvas>
<p class="why" id="why"></p><div class="boxes" id="boxes"></div>
<div class="legend" id="legend"></div></div>
<div class="panel"><h2>Close-up</h2><canvas id="zoom" width="640" height="640"></canvas>
<nav><label><input type="checkbox" id="pixel"> pixels</label><label><input type="checkbox" id="refs" checked> other nails</label>
<button id="frameBtn" hidden>Show on the pallet</button></nav></div>
</div>
<div class="panel" id="framePanel" hidden style="margin-top:12px"><h2>On the pallet</h2><canvas id="frame" width="1200" height="1200"></canvas></div>
<nav><button id="prev">← Back</button><button id="next">Next →</button>
<select id="filter"><option value="todo">Not reviewed</option><option value="all">All</option><option value="accepted">Accepted</option><option value="rejected">Not this</option><option value="unsure">Unsure</option></select>
<span class="meta" id="pos"></span></nav>
</section><aside id="aside">
<div class="panel"><h2>What is it?</h2><div class="buttons" id="choices"></div><p id="err"></p></div>
<div class="panel" style="margin-top:12px"><h2>Details</h2><div class="chips" id="chips"></div><div class="meta" id="meta"></div></div>
<div class="panel guide" style="margin-top:12px"><h2>How to tell</h2><div id="guide"></div></div>
</aside></div></div>
<div class="panel empty" id="emptyArea" hidden>Choose where to look and which model to use, then press Find.</div>
</main>
<script>
const base = location.pathname;
let S = null, O = null, order = [], at = 0, box = "0", showRefs = true;
const $ = id => document.getElementById(id);
const img = new Image(), frameImg = new Image();
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
  const f = $("filter").value;
  return S.items.map((it, i) => i).filter(i => f === "all" || (f === "todo" && todo(S.items[i])) ||
    (f === "accepted" && accepted(S.items[i])) || (f === "unsure" && unsure(S.items[i])) ||
    (f === "rejected" && reviewed(S.items[i]) && !accepted(S.items[i]) && !unsure(S.items[i])));
}
function boxesOf(item) {
  const list = item.candidates.map((c, i) => ({ key: String(i), b: c, kind: "candidate", label: "Possible " + nice(c.class || S.target).toLowerCase() + " " + (i + 1) + " · " + Math.round(c.score * 100) + "%" + (c.referenceClass ? " · labeled " + nice(c.referenceClass) : "") }));
  const covered = new Set(item.candidates.map(c => c.referenceIndex).filter(i => i !== undefined));
  item.truth.forEach((t, i) => { if (!covered.has(i)) list.push({ key: "r" + i, b: t, kind: "reference", label: nice(S.dataset.classNames[t.classId]) + " " + (i + 1) }); });
  return list;
}
function drawSlice() {
  const item = S.items[order[at]], c = $("slice"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  const k = c.width;
  for (const x of boxesOf(item)) {
    if (x.kind === "reference" && !showRefs && x.key !== box) continue;
    const on = x.key === box, d = choiceOf(item, x.key);
    g.lineWidth = on ? 4 : 2.5; g.setLineDash(x.kind === "candidate" ? [7, 4] : []);
    g.strokeStyle = isTarget(d) ? "#1f9d55" : d === "reject" ? "#d93636" : d === "skip" ? "#9a9a93" : x.kind === "candidate" ? "#e8890c" : "#6ea0ff";
    g.strokeRect((x.b.x - x.b.w / 2) * k, (x.b.y - x.b.h / 2) * k, x.b.w * k, x.b.h * k);
  }
  g.setLineDash([]);
  drawZoom(item);
}
function drawZoom(item) {
  const x = boxesOf(item).find(x => x.key === box), c = $("zoom"), g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  if (!x) return;
  // About three box widths of context, never less than 80 px of the slice (about 8x on screen).
  const W = img.naturalWidth, half = Math.max(Math.max(x.b.w, x.b.h) * W * 1.5, 40);
  const cx = x.b.x * W, cy = x.b.y * W;
  g.imageSmoothingEnabled = !$("pixel").checked;
  g.drawImage(img, cx - half, cy - half, half * 2, half * 2, 0, 0, c.width, c.height);
  // No outline over the nail: it would hide the head's edge and shadow. Ticks at the border point at it.
  const m = c.width / 2, L = 16;
  g.strokeStyle = "#e8890c"; g.lineWidth = 3; g.beginPath();
  g.moveTo(m, 0); g.lineTo(m, L); g.moveTo(m, c.height); g.lineTo(m, c.height - L);
  g.moveTo(0, m); g.lineTo(L, m); g.moveTo(c.width, m); g.lineTo(c.width - L, m); g.stroke();
}
function drawFrame() {
  const item = S.items[order[at]], c = $("frame"), g = c.getContext("2d");
  if (!frameImg.naturalWidth || !item.crop) return;
  const scale = c.width / frameImg.naturalWidth; c.height = Math.round(frameImg.naturalHeight * scale);
  g.drawImage(frameImg, 0, 0, c.width, c.height);
  const [l, t, w, hh] = item.crop; g.strokeStyle = "#e8890c"; g.lineWidth = 3; g.strokeRect(l * scale, t * scale, w * scale, hh * scale);
}
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
  if (!c.length) parts.push("The model found nothing here; look at the labeled nails.");
  return parts.join(" ").replace(/^the/, "The");
}
function render() {
  const has = S && !S.empty;
  $("reviewArea").hidden = !has; $("emptyArea").hidden = has || !O;
  if (!has) { $("title").textContent = "Find examples to review"; $("lead").innerHTML = ""; $("count").textContent = ""; $("sub").textContent = O ? O.camera.name + " · " + O.camera.site.name : ""; return; }
  order = filtered();
  const tl = S.tally;
  $("title").textContent = ("Review possible " + wanted()).replace(/&#39;/g, "'");
  $("sub").textContent = [O ? O.camera.name : "", S.datasetName, S.dataset.slices + " slices", S.model].filter(Boolean).join(" · ");
  $("lead").innerHTML = "Look at each orange box and choose what it really is. If you can&#39;t tell, choose <b>Unsure</b>. Your answers are saved as you go.<br>" +
    "<span class='cand'>Orange</span>: possible " + wanted() + " the model pointed out. <span class='ref'>Blue</span>: labels from " + sourceText() + ".";
  $("legend").innerHTML = "<span><i class='lc'></i>the model&#39;s suggestion</span><span><i class='lr'></i>existing label</span><span><i class='lg'></i>you: yes</span>" +
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
  const item = S.items[order[at]];
  const list = boxesOf(item);
  if (!list.some(x => x.key === box)) box = list[0]?.key ?? "slice";
  $("pos").textContent = (at + 1) + " / " + order.length;
  $("boxes").innerHTML = list.map(x => '<button data-k="' + h(x.key) + '" class="' + (x.key === box ? "on" : "") + '">' + x.label + (choiceOf(item, x.key) ? " → " + nice(choiceOf(item, x.key)) : "") + "</button>").join("");
  const current = choiceOf(item, box);
  $("choices").innerHTML = (box === "slice" ? '<p class="meta">Nothing was found or labeled on this slice. If you see the defect, label it in Zira&#39;s QA review; here you can only dismiss it or mark it unsure.</p>' : "") +
    (box === "slice" ? [] : S.labels).map((l, i) => '<button data-l="' + h(l) + '" title="Key ' + (i + 1) + '" class="' + (isTarget(l) ? "target" : "") + '" aria-pressed="' + (current === l) + '">' + nice(l) + "</button>").join("") +
    '<button data-l="reject" title="Key R" class="reject" aria-pressed="' + (current === "reject") + '">Not a nail / nothing here</button>' +
    '<button data-l="skip" title="Key S" aria-pressed="' + (current === "skip") + '">Unsure, can&#39;t tell</button>';
  S.labels.forEach((l, i) => { KEYS[String(i + 1)] = l; });
  $("chips").innerHTML = [item.labelSource ? (item.labelSource === "annotations" ? "reviewer-corrected labels" : "labels from the camera&#39;s models") : "",
    ...item.marks.map(m => '<span class="mark">' + h(m) + "</span>"), item.known ? item.known + " already labeled" : ""].filter(Boolean).map(t => t.startsWith("<span") ? t : "<span>" + t + "</span>").join("");
  $("meta").textContent = [item.session ? "Session " + item.session : "", item.frame || "", item.image].filter(Boolean).join(" · ");
  $("why").innerHTML = "<b>Why this slice:</b> " + why(item);
  $("frameBtn").hidden = !(S.framesAvailable && item.frame);
  img.onload = drawSlice; img.src = base + "slice?i=" + order[at] + "&r=" + encodeURIComponent(S.run);
  if (!$("framePanel").hidden) { frameImg.onload = drawFrame; frameImg.src = base + "frame?i=" + order[at] + "&r=" + encodeURIComponent(S.run); }
}
let queue = Promise.resolve();
function decide(label) { queue = queue.then(() => save(label)).catch(e => { $("err").textContent = e.message; }); }
async function save(label) {
  if (!S || S.empty || !order.length) return;
  const index = order[at], item = S.items[index];
  const res = await fetch(base + "decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index, box, label }) });
  const out = await res.json();
  if (!res.ok) { $("err").textContent = out.message || "Not saved"; return; }
  $("err").textContent = "";
  S.decisions[item.image] = { boxes: out.boxes }; S.tally = out.tally;
  const open = boxesOf(item).filter(x => x.kind === "candidate" && !choiceOf(item, x.key));
  if (label !== null && open.length) { box = open[0].key; render(); return; }
  if (label !== null && $("filter").value === "todo") { render(); return; }
  if (label !== null) at += 1;
  render();
}
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
  kindChanged();
}
async function fillRuns() {
  const out = await (await fetch(base + "runs")).json();
  if (!out.runs || !out.runs.length) return;
  $("runsWrap").hidden = false;
  $("runs").innerHTML = '<option value="">Choose…</option>' + out.runs.map(r => '<option value="' + h(r.run) + '">' + h(day(r.createdAt) || r.run.split("/").pop()) + " · " + h(r.model) + " · " + r.accepted + " accepted of " + r.toReview + "</option>").join("");
}
async function search(confirm) {
  const sessions = kind() === "sessions", frames = $("frames").value;
  const body = { source: sessions ? { kind: "sessions", ids: $("sessions").value.split(",") } : { kind: "version", id: $("version").value },
    modelId: $("model").value, targets: checked(), ...(frames && sessions ? { frames: Number(frames) } : {}), ...(confirm ? { confirm: true } : {}) };
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
async function loadState() {
  S = await (await fetch(base + "state")).json();
  at = 0; box = "0";
  if (S && !S.empty) $("guide").innerHTML = (S.guidance.length ? S.guidance : ["Accept only what you would label as " + wanted() + " in Zira."]).map(t => "<p>" + h(t) + "</p>").join("");
  render(); setSummary();
}
document.addEventListener("click", e => {
  const l = e.target.closest("[data-l]"), k = e.target.closest("[data-k]");
  if (l) decide(l.dataset.l);
  if (k) { box = k.dataset.k; render(); }
});
document.addEventListener("keydown", e => {
  if (["SELECT", "INPUT"].includes(e.target.tagName) || e.metaKey || e.ctrlKey || !S || S.empty) return;
  const key = e.key.toLowerCase();
  if (KEYS[e.key]) decide(KEYS[e.key]);
  else if (key === "0" || key === "r") decide("reject");
  else if (key === "s") decide("skip");
  else if (key === "u") decide(null);
  else if (key === "arrowright" || key === "n") { at += 1; render(); }
  else if (key === "arrowleft" || key === "b") { at -= 1; render(); }
  else if (key === "tab") { e.preventDefault(); const list = boxesOf(S.items[order[at]]); box = list[(list.findIndex(x => x.key === box) + 1) % list.length].key; render(); }
  else if (key === "f" && !$("frameBtn").hidden) $("frameBtn").click();
});
$("prev").onclick = () => { at -= 1; render(); };
$("next").onclick = () => { at += 1; render(); };
$("filter").onchange = () => { at = 0; render(); };
$("pixel").onchange = () => drawSlice();
$("refs").onchange = e => { showRefs = e.target.checked; drawSlice(); };
$("frameBtn").onclick = () => { const p = $("framePanel"); p.hidden = !p.hidden; if (!p.hidden) { frameImg.onload = drawFrame; frameImg.src = base + "frame?i=" + order[at] + "&r=" + encodeURIComponent(S.run); } };
document.querySelectorAll("input[name=kind]").forEach(r => { r.onchange = kindChanged; });
$("dataset").onchange = () => { fillVersions(); kindChanged(); };
$("version").onchange = kindChanged;
$("sessions").onchange = kindChanged;
$("go").onclick = () => search(false);
$("confirmBtn").onclick = () => search(true);
$("runs").onchange = async e => {
  if (!e.target.value) return;
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
