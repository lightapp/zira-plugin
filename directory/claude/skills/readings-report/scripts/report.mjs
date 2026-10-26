// Build a self-contained interactive readings report: static summary, KPIs and tables first,
// then ECharts charts and live range/interval/source controls over embedded readings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { INTERVALS, checkQuery, formatLocal, formatValue, metricIds, parseLocal, runQuery, tableCells } from "./query-core.mjs";

const here = new URL(".", import.meta.url);
const ECHARTS = readFileSync(new URL("vendor/echarts/echarts.min.js", here), "utf8");
// The page runs the same query engine as the CLI, without module syntax.
const CORE = readFileSync(new URL("query-core.mjs", here), "utf8").replace(/^export /gm, "");
export const MAX_EMBEDDED_VALUES = 6_000_000;
const TIME_INTERVALS = INTERVALS.filter(i => !["raw", "all"].includes(i));

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const json = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-09-28T01:00:00" (site time) → "Sep 28, 2026 01:00"
const spanLabel = s => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}, ${s.slice(0, 4)} ${s.slice(11, 16)}`;

// Paragraphs, "- " bullets, "### " headings and **bold**; everything else is text.
export function richText(src) {
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return String(src ?? "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).map(block => {
    const lines = block.split("\n");
    if (lines.every(l => /^\s*[-*] /.test(l)))
      return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
    if (lines.length === 1 && /^#{1,3} /.test(lines[0])) return `<h3>${inline(lines[0].replace(/^#+ /, ""))}</h3>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

function walk(value, fn, depth = 0) {
  if (depth > 12) throw new Error("Chart option is nested too deeply");
  fn(value);
  if (Array.isArray(value)) value.forEach(v => walk(v, fn, depth + 1));
  else if (plain(value)) Object.values(value).forEach(v => walk(v, fn, depth + 1));
}

export function checkOption(option) {
  if (option === undefined) return {};
  if (!plain(option)) throw new Error("A chart option must be an ECharts option object");
  if (JSON.stringify(option).length > 100_000) throw new Error("A chart option is larger than 100 kB");
  if ("dataset" in option) throw new Error("Leave out dataset: the report supplies each chart's data from its query");
  if (Array.isArray(option.yAxis) && option.yAxis.length > 1)
    throw new Error("Use one y-axis per chart; put a measure with a different scale in its own chart");
  walk(option, v => {
    if (typeof v === "string" && /javascript:|<\s*(script|iframe|img|svg|object|embed)/i.test(v))
      throw new Error("Chart option strings cannot contain markup or script links");
  });
  return option;
}

// Embedded pictures are PNG data URIs only (the page's CSP allows data: images and nothing else).
export const MAX_IMAGES = 24;
export const MAX_IMAGE_CHARS = 4_000_000;
const MAX_SECTION_IMAGE_CHARS = 12_000_000;
const PNG_DATA = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function checkImages(images, where) {
  if (images == null) return null;
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) throw new Error(`${where}: give 1-${MAX_IMAGES} images`);
  let total = 0;
  return images.map((img, i) => {
    if (!plain(img) || typeof img.src !== "string" || img.src.length > MAX_IMAGE_CHARS || !PNG_DATA.test(img.src))
      throw new Error(`${where}: image ${i + 1} must be a PNG data URI (data:image/png;base64,…) under ${MAX_IMAGE_CHARS / 1e6} MB`);
    total += img.src.length;
    if (total > MAX_SECTION_IMAGE_CHARS) throw new Error(`${where}: images are larger than ${MAX_SECTION_IMAGE_CHARS / 1e6} MB together`);
    const width = img.width == null ? null : Math.round(Number(img.width));
    if (width !== null && !(width >= 40 && width <= 1200)) throw new Error(`${where}: image ${i + 1} width is 40-1200 px`);
    return { src: img.src, alt: String(img.alt ?? img.caption ?? "").slice(0, 200), caption: String(img.caption ?? "").slice(0, 200), width };
  });
}

// A fixed table of values the report computed elsewhere (not a query over readings).
function checkStaticTable(table, where) {
  if (table == null) return null;
  if (!plain(table) || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 12 || !Array.isArray(table.rows) || table.rows.length > 200)
    throw new Error(`${where}: staticTable is {columns: [1-12 names], rows: [up to 200 rows]}`);
  const cell = v => (v === null || v === undefined ? "" : typeof v === "number" && Number.isFinite(v) ? v : String(v).slice(0, 200));
  return {
    columns: table.columns.map(c => String(c).slice(0, 80)),
    rows: table.rows.map((row, i) => {
      if (!Array.isArray(row) || row.length !== table.columns.length) throw new Error(`${where}: staticTable row ${i + 1} needs ${table.columns.length} cells`);
      return row.map(cell);
    }),
  };
}

// Spec: { title, summary?, range?: {from, to}, kpis?: [{label, query, unit?}],
//         sections: [{ title, text?, chart?: {query, option?, height?}, table?: {query, maxRows?},
//                      images?: [{src: PNG data URI, caption?, alt?, width?}], staticTable?: {columns, rows} }] }
export function checkSpec(spec, metrics) {
  if (!plain(spec)) throw new Error("The report spec must be a JSON object");
  const title = String(spec.title ?? "").trim().slice(0, 140);
  if (!title) throw new Error("The report needs a title");
  const kpis = spec.kpis ?? [], sections = spec.sections ?? [];
  if (!Array.isArray(kpis) || kpis.length > 12) throw new Error("Give at most 12 kpis");
  if (!Array.isArray(sections) || !sections.length || sections.length > 40) throw new Error("Give 1-40 sections");
  const query = (q, where) => {
    try {
      checkQuery(q, metrics);
      return q;
    } catch (error) {
      throw new Error(`${where}: ${error.message}`);
    }
  };
  if (spec.range != null && (!plain(spec.range) || ["from", "to"].some(k => spec.range[k] != null && !Number.isFinite(parseLocal(spec.range[k])))))
    throw new Error('range is {"from": "2026-09-01", "to": "2026-09-08T06:00"} in site time');
  return {
    title,
    summary: String(spec.summary ?? "").slice(0, 8000),
    // Set by the report helper once it loads dates the summary was not written for.
    summaryFor: spec.summaryFor ? String(spec.summaryFor).slice(0, 80) : null,
    range: spec.range ?? null,
    kpis: kpis.map((k, i) => {
      if (!plain(k) || !String(k.label ?? "").trim()) throw new Error(`KPI ${i + 1} needs a label`);
      const q = query({ ...k.query, interval: "all", groupBy: undefined }, `KPI "${k.label}"`);
      if (q.measures.length !== 1) throw new Error(`KPI "${k.label}" needs exactly one measure`);
      return { label: String(k.label).slice(0, 60), unit: k.unit ? String(k.unit).slice(0, 16) : null, query: q };
    }),
    sections: sections.map((s, i) => {
      if (!plain(s) || !String(s.title ?? "").trim()) throw new Error(`Section ${i + 1} needs a title`);
      const where = `Section "${s.title}"`;
      if (!s.chart && !s.table && !s.text && !s.images && !s.staticTable) throw new Error(`${where} needs a chart, a table, text or images`);
      return {
        title: String(s.title).slice(0, 140), text: String(s.text ?? "").slice(0, 4000),
        images: checkImages(s.images, where), staticTable: checkStaticTable(s.staticTable, where),
        chart: s.chart ? {
          query: query(s.chart.query, where), option: checkOption(s.chart.option),
          height: Math.min(900, Math.max(180, Number(s.chart.height) || 340)),
        } : null,
        table: s.table ? { query: query(s.table.query, where), maxRows: Math.min(5000, Math.max(1, Number(s.table.maxRows) || 200)) } : null,
      };
    }),
  };
}

export function specMetrics(spec) {
  const ids = new Set();
  const add = q => metricIds(q).forEach(m => ids.add(m));
  spec.kpis.forEach(k => add(k.query));
  spec.sections.forEach(s => { if (s.chart) add(s.chart.query); if (s.table) add(s.table.query); });
  return [...ids];
}

// The site-local span of a dataset, from its UTC range and the site offset seen in readings.
export function siteRange(manifest) {
  const off = (manifest.siteOffsetMinutes?.[0] ?? 0) * 60000;
  return { from: formatLocal(Date.parse(manifest.from) + off, "raw").replace(" ", "T"), to: formatLocal(Date.parse(manifest.to) + off, "raw").replace(" ", "T") };
}

function compact(data, metrics) {
  let values = 0;
  const devices = data.devices.map(d => {
    const t = d.t.map((v, i) => (i ? v - d.t[i - 1] : v));
    const cols = {};
    for (const m of metrics) if (d.cols[m]) { cols[m] = d.cols[m]; values += d.t.length; }
    values += d.t.length;
    return { id: d.id, name: d.name, t, cols };
  });
  return { values, payload: { devices, metrics: data.metrics } };
}

const hash = s => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

// `helper` is set when `readings.mjs serve` hands the page out: { min, max } site-local picker
// bounds. The page may then ask that helper (same origin only) to load more dates.
export function buildReport({ spec: rawSpec, manifest, data, generatedAt = new Date().toISOString(), helper = null }) {
  const spec = checkSpec(rawSpec, data.metrics);
  const span = siteRange(manifest);
  const full = v => formatLocal(parseLocal(v), "raw").replace(" ", "T");
  const range = { from: spec.range?.from ? full(spec.range.from) : span.from, to: spec.range?.to ? full(spec.range.to) : span.to };
  const scoped = q => ({ ...q, from: q.from ?? range.from, to: q.to ?? range.to });
  const kpis = spec.kpis.map(k => ({ ...k, query: scoped(k.query), result: runQuery(data, scoped(k.query)) }));
  const sections = spec.sections.map(s => ({
    ...s,
    chart: s.chart ? { ...s.chart, query: scoped(s.chart.query), result: runQuery(data, scoped(s.chart.query)) } : null,
    table: s.table ? { ...s.table, query: scoped(s.table.query), result: runQuery(data, scoped(s.table.query)) } : null,
  }));
  const used = specMetrics(spec);
  const packed = compact(data, used);
  const embedded = packed.values <= MAX_EMBEDDED_VALUES;
  const raw = embedded ? gzipSync(JSON.stringify(packed.payload), { level: 9 }).toString("base64") : "";
  const devices = manifest.devices.map(d => ({ id: d.id, name: d.name, url: d.url }));
  const unit = id => data.metrics[id]?.unit ?? null;
  const notes = [...(manifest.notes ?? [])];
  if (!embedded) notes.push("This report covers too many readings to embed them all, so the range, interval and data source controls are off. Ask for a shorter range or fewer data sources to explore it interactively.");
  if (manifest.chunks.some(c => !c.final)) notes.push(`The latest week was read at ${manifest.fetchedAt.slice(0, 16).replace("T", " ")} UTC; newer readings are not included.`);

  const page = {
    title: spec.title, range, span, interval: null, devices, embedded, helper: !!helper,
    kpis: kpis.map(k => ({ label: k.label, unit: k.unit ?? unit(k.query.measures[0].metric), query: k.query, result: k.result })),
    sections: sections.map(s => ({
      title: s.title,
      chart: s.chart && { query: s.chart.query, option: s.chart.option, height: s.chart.height, result: s.chart.result },
      table: s.table && { query: s.table.query, maxRows: s.table.maxRows, result: s.table.result },
    })),
  };
  const kpiHtml = page.kpis.map((k, i) => {
    const v = k.result.rows[0]?.[k.result.columns.length - 1] ?? null;
    return `<div class="k"><div class="kl">${esc(k.label)}</div><div class="kv" id="kpi-${i}">${esc(v === null ? "—" : formatValue(v))}${k.unit ? `<span class="ku"> ${esc(k.unit)}</span>` : ""}</div></div>`;
  }).join("");
  const tableHtml = (result, maxRows) => {
    const cells = tableCells(result).slice(0, maxRows);
    const more = result.rows.length > maxRows ? `<tfoot><tr><td colspan="${result.columns.length}" class="muted">First ${maxRows} of ${result.rows.length} rows. Download the CSV for all of them.</td></tr></tfoot>` : "";
    return `<thead><tr>${result.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${cells.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${result.columns.length}" class="muted">No readings match</td></tr>`}</tbody>${more}`;
  };
  const sectionHtml = sections.map((s, i) => `<section class="sec" id="s-${i}">
<div class="sh"><h2>${esc(s.title)}</h2><div class="acts">${s.chart || s.table ? `<button type="button" class="b" data-csv="${i}" disabled>CSV</button><button type="button" class="b" data-sheet="${i}" disabled>Open in Sheets</button>` : ""}</div></div>
${s.text ? `<div class="txt">${richText(s.text)}</div>` : ""}
${s.images ? `<div class="figs">${s.images.map(img => `<figure class="fig"><img src="${img.src}" alt="${esc(img.alt)}"${img.width ? ` width="${img.width}"` : ""}>${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ""}</figure>`).join("")}</div>` : ""}
${s.staticTable ? `<div class="wrap"><table><thead><tr>${s.staticTable.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.staticTable.rows.map(r => `<tr>${r.map(c => `<td>${esc(typeof c === "number" ? formatValue(c) : c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}
${s.chart ? `<div class="chart" id="c-${i}" style="height:${s.chart.height}px" role="img" aria-label="${esc(s.title)}"><div class="muted ph">Charts need JavaScript; the data is in the table${s.table ? " below" : " view"}.</div></div>` : ""}
${s.chart && !s.table ? `<details class="tv"><summary>Table view</summary><div class="wrap"><table id="t-${i}">${tableHtml(s.chart.result, 200)}</table></div></details>` : ""}
${s.table ? `<div class="wrap"><table id="t-${i}">${tableHtml(s.table.result, s.table.maxRows)}</table></div>` : ""}
<div class="err" id="e-${i}"></div>
</section>`).join("\n");
  const pick = helper ?? { min: span.from, max: span.to };
  const controls = `<div class="ctl" id="ctl">
<label>From <input type="datetime-local" id="from" value="${esc(range.from.slice(0, 16))}" min="${esc(pick.min.slice(0, 16))}" max="${esc(pick.max.slice(0, 16))}" disabled></label>
<label>To <input type="datetime-local" id="to" value="${esc(range.to.slice(0, 16))}" min="${esc(pick.min.slice(0, 16))}" max="${esc(pick.max.slice(0, 16))}" disabled></label>
<label>Interval <select id="interval" disabled><option value="">As designed</option>${TIME_INTERVALS.map(v => `<option value="${v}">${v.replace("-", " ")}</option>`).join("")}</select></label>
${devices.length > 1 ? `<fieldset id="devs"><legend>Data sources</legend>${devices.map(d => `<label class="dv"><input type="checkbox" value="${esc(d.id)}" checked disabled> ${esc(d.name)}</label>`).join("")}</fieldset>` : ""}
<button type="button" class="b" id="reset" disabled>Reset</button>${helper ? '<button type="button" class="b" id="load" hidden>Load from Zira</button>' : ""}<span class="muted" id="status"></span>
<div class="span" id="span">This report holds readings from <strong>${esc(spanLabel(span.from))}</strong> to <strong>${esc(spanLabel(span.to))}</strong>. ${helper
    ? "Pick earlier or later dates and press Load to download them from Zira with your sign-in; weeks already downloaded are reused."
    : "The dates can only be chosen within that period. For other dates, ask in chat to load them (for example \"load since Jan 1\"); weeks already downloaded are reused."}</div>
</div>`;
  const app = APP;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;${helper ? " connect-src 'self';" : ""} script-src ${hash(ECHARTS)} ${hash(CORE)} ${hash(app)}`;
  const sourceLine = devices.map(d => d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>` : esc(d.name)).join(", ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${esc(spec.title)}</title>
<style>${CSS}</style></head><body><main>
<header><h1>${esc(spec.title)}</h1>
<div class="meta">${esc(manifest.site.name)} · ${sourceLine}<br>${esc(range.from.replace("T", " ").slice(0, 16))} – ${esc(range.to.replace("T", " ").slice(0, 16))} site time · generated ${esc(generatedAt.slice(0, 16).replace("T", " "))} UTC</div></header>
${notes.length ? `<div class="note">${notes.map(esc).join("<br>")}</div>` : ""}
${controls}
<div class="note" id="stale" hidden>The summary describes the original range; the charts, tables and key numbers show your current selection.</div>
${spec.summary ? `<section class="summary">${spec.summaryFor ? `<p class="muted">Written for ${esc(spec.summaryFor)}. The key numbers and charts show the dates loaded since; ask in chat to update the summary.</p>` : ""}${richText(spec.summary)}</section>` : ""}
${kpiHtml ? `<div class="kpis">${kpiHtml}</div>` : ""}
${sectionHtml}
<footer>Readings from Zira, read ${esc(manifest.fetchedAt.slice(0, 16).replace("T", " "))} UTC. Times are site local. This file works offline; source links open Zira when clicked.</footer>
</main>
<script type="application/json" id="page">${json(page)}</script>
<script type="application/octet-stream" id="raw">${raw}</script>
<script>${ECHARTS}</script>
<script>${CORE}</script>
<script>${app}</script>
</body></html>
`;
}

// Palette and ink follow the dataviz reference palette; dark steps are their own validated set.
const CSS = `:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--card:#f3f2ee;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--line:rgba(11,11,11,.10);--warn:#fab219;--crit:#d03b3b;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--card:#262624;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--line:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--card:#262624;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--line:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;font-weight:600;margin:0}h2{font-size:16px;font-weight:600;margin:0}h3{font-size:14px;margin:12px 0 4px}
.meta{color:var(--ink2);font-size:13px;margin:6px 0 16px}a{color:inherit}
.note{border:1px solid var(--warn);border-radius:8px;padding:8px 12px;margin:0 0 14px;font-size:13px}
.ctl{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:end;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:16px;font-size:13px;color:var(--ink2)}
.ctl .span{flex-basis:100%;font-size:12px;color:var(--ink2)}.ctl .span.hl{color:var(--ink);border-left:3px solid var(--warn);padding-left:8px}.ctl label{display:flex;flex-direction:column;gap:2px}.ctl input,.ctl select{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--axis);border-radius:6px;padding:4px 6px;min-height:32px}
fieldset{border:0;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 10px}legend{padding:0;margin-bottom:2px}.ctl label.dv{flex-direction:row;align-items:center;gap:4px;color:var(--ink)}.ctl label.dv input{min-height:0}
.b{font:inherit;font-size:12px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 10px;min-height:30px;cursor:pointer}.b:disabled{opacity:.5;cursor:default}
.summary{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:4px 16px;margin-bottom:16px}.summary p,.txt p{margin:10px 0}.summary ul,.txt ul{margin:8px 0;padding-left:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px}
.k{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.kl{font-size:13px;color:var(--ink2)}.kv{font-size:26px;font-weight:600}.ku{font-size:14px;font-weight:400;color:var(--ink2)}
.sec{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px}
.sh{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.acts{display:flex;gap:6px}.txt{color:var(--ink2)}
.chart{width:100%;margin-top:8px}.ph{padding:24px 0}.err{color:var(--crit);font-size:13px}.err:empty{display:none}
.wrap{overflow-x:auto;margin-top:8px}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--axis);padding:5px 8px;white-space:nowrap}td{border-bottom:1px solid var(--grid);padding:5px 8px;white-space:nowrap}
.muted{color:var(--muted)}details.tv{margin-top:6px;font-size:13px}summary{cursor:pointer;color:var(--ink2)}
.figs{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;align-items:flex-start}.fig{margin:0;max-width:100%}.fig img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px}.fig figcaption{font-size:12px;color:var(--ink2);margin-top:4px;max-width:360px}
footer{margin-top:20px;font-size:12px;color:var(--muted)}`;

// Browser side: draws charts from the embedded results, then re-runs queries locally when the
// viewer changes range, interval or data sources. No network access is needed or allowed.
const APP = `(function(){
"use strict";
var P=JSON.parse(document.getElementById("page").textContent),DATA=null,charts={},state={},current={};
var $=function(id){return document.getElementById(id)};
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function ink(){return {ink:css("--ink"),ink2:css("--ink2"),muted:css("--muted"),grid:css("--grid"),axis:css("--axis"),surface:css("--surface"),
  pal:["--s1","--s2","--s3","--s4","--s5","--s6","--s7","--s8"].map(css)}}
function merge(a,b){if(Array.isArray(b)||b===null||typeof b!=="object")return b;var o={};var k;
  if(a&&typeof a==="object"&&!Array.isArray(a))for(k in a)o[k]=a[k];for(k in b)o[k]=merge(o[k],b[k]);return o}
// Tooltips use the tables' rounding and show times at the chart's interval (a week as its Monday).
function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return "&#"+ch.charCodeAt(0)+";"})}
function tip(res){var tc=res.meta.timeColumn;return function(ps){ps=[].concat(ps);if(!ps.length)return "";
  var v=function(p){var y=p.encode&&p.encode.y?p.encode.y[0]:null;return y==null?"":formatValue(Array.isArray(p.value)?p.value[y]:p.value)};
  var head=tc?formatLocal(ps[0].value[0],res.meta.interval):(ps[0].name||"");
  return "<div style='font-weight:600;margin-bottom:4px'>"+esc(head)+"</div>"+ps.map(function(p){var x=v(p);
    return "<div>"+p.marker+esc(p.seriesName)+" <b style='float:right;margin-left:16px'>"+(x===""?"—":esc(x))+"</b></div>"}).join("")}}
function axisStyle(c){return {axisLine:{lineStyle:{color:c.axis}},axisTick:{show:false},axisLabel:{color:c.muted,hideOverlap:true},splitLine:{lineStyle:{color:c.grid}},nameTextStyle:{color:c.muted}}}
function option(sec,res){
  var c=ink(),tc=res.meta.timeColumn,user=sec.chart.option||{};
  var q=sec.chart.query,dims=(tc?1:0)+(q.groupBy&&!(tc&&q.pivot!==false)?1:0);
  var measures=res.columns.slice(dims),cat=!tc&&dims?res.columns[0]:null;
  var series=(user.series||measures.map(function(){return {type:"line"}})).map(function(s,i){
    var base={type:"line",showSymbol:false,symbolSize:8,lineStyle:{width:2},emphasis:{focus:"series"}};
    if((s.type||"line")==="bar")base={type:"bar",barMaxWidth:32,itemStyle:{borderRadius:[4,4,0,0]}};
    if(s.type==="scatter")base={type:"scatter",symbolSize:8};
    var o=merge(base,s);
    if(!s.encode&&measures[i]!==undefined)o.encode=tc?{x:"time",y:measures[i]}:{x:cat,y:measures[i]};
    if(!o.name&&o.encode&&typeof o.encode.y==="string")o.name=o.encode.y;
    // A series keeps its first color when filters remove others (color follows the entity).
    var pal=sec.colors||(sec.colors={}),used=Object.keys(pal).length;
    if(o.name&&!s.itemStyle&&!s.lineStyle&&!(o.name in pal))pal[o.name]=used%c.pal.length;
    if(o.name in pal){var col=c.pal[pal[o.name]];o.itemStyle=merge(o.itemStyle,{color:col});if(o.type==="line")o.lineStyle=merge(o.lineStyle,{color:col})}
    return o});
  var base={useUTC:true,animation:false,color:c.pal,backgroundColor:"transparent",textStyle:{color:c.ink2,fontFamily:'system-ui,-apple-system,"Segoe UI",sans-serif'},
    grid:{left:8,right:20,top:series.length>1?44:20,bottom:8,containLabel:true},
    legend:{show:series.length>1,top:0,left:0,type:"scroll",icon:"roundRect",textStyle:{color:c.ink2}},
    tooltip:{trigger:tc||!cat?"axis":"item",confine:true,backgroundColor:c.surface,borderColor:c.axis,textStyle:{color:c.ink},axisPointer:{type:"line",lineStyle:{color:c.axis}},
      formatter:tip(res)},
    dataset:{source:[res.columns].concat(res.rows)},
    xAxis:merge(axisStyle(c),{type:tc?"time":"category",splitLine:{show:false}}),
    yAxis:merge(axisStyle(c),{type:"value",scale:false}),
    dataZoom:tc?[{type:"inside",zoomOnMouseWheel:"ctrl",moveOnMouseMove:true,moveOnMouseWheel:false}]:[]};
  var o=merge(base,user);o.dataset={source:[res.columns].concat(res.rows)};o.series=series;
  if(o.xAxis&&!Array.isArray(o.xAxis))o.xAxis=merge(merge(axisStyle(c),{splitLine:{show:false}}),o.xAxis);
  if(o.yAxis&&!Array.isArray(o.yAxis))o.yAxis=merge(axisStyle(c),o.yAxis);
  // A y-axis name sits above the plot, where containLabel reserves no room: start it at the axis
  // and push the plot down below the legend so the name is neither clipped nor drawn over it.
  if(o.yAxis&&!Array.isArray(o.yAxis)&&o.yAxis.name){
    o.yAxis=merge({nameLocation:"end",nameGap:12,nameTextStyle:{align:"left",color:c.muted}},o.yAxis);
    if(!(user.grid&&user.grid.top!=null))o.grid=merge(o.grid,{top:(series.length>1?44:12)+22})}
  return o}
function draw(i){var s=P.sections[i];if(!s.chart)return;var res=current[i]||s.chart.result,el=$("c-"+i);
  if(!charts[i]){el.textContent="";charts[i]=echarts.init(el,null,{renderer:"canvas"})}
  try{charts[i].setOption(option(s,res),{notMerge:true});$("e-"+i).textContent=""}catch(e){$("e-"+i).textContent="This chart could not be drawn: "+e.message}}
function fillTable(i,res,max){var t=$("t-"+i);if(!t)return;t.textContent="";var h=t.createTHead().insertRow();
  res.columns.forEach(function(c){var th=document.createElement("th");th.textContent=c;h.appendChild(th)});
  var b=t.createTBody(),cells=tableCells(res);
  cells.slice(0,max).forEach(function(r){var tr=b.insertRow();r.forEach(function(v){tr.insertCell().textContent=v})});
  if(!cells.length){var td=b.insertRow().insertCell();td.colSpan=res.columns.length;td.className="muted";td.textContent="No readings match"}
  if(cells.length>max){var f=t.createTFoot().insertRow().insertCell();f.colSpan=res.columns.length;f.className="muted";f.textContent="First "+max+" of "+cells.length+" rows. Download the CSV for all of them."}}
function resultFor(i){var s=P.sections[i];return current[i]||(s.chart?s.chart.result:s.table.result)}
function decode(){if(DATA)return Promise.resolve(DATA);var b64=$("raw").textContent.trim();
  var bytes=Uint8Array.from(atob(b64),function(ch){return ch.charCodeAt(0)});
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(function(txt){
    var d=JSON.parse(txt);d.devices.forEach(function(dev){for(var k=1;k<dev.t.length;k++)dev.t[k]+=dev.t[k-1]});DATA=d;return d})}
function tweak(q){var o={};for(var k in q)o[k]=q[k];o.from=state.from;o.to=state.to;o.devices=state.devices;
  if(state.interval&&INTERVALS.indexOf(q.interval)>0&&q.interval!=="all")o.interval=state.interval;return o}
function apply(){var st=$("status");st.textContent="Updating…";
  decode().then(function(d){
    P.kpis.forEach(function(k,i){var el=$("kpi-"+i);try{var r=runQuery(d,tweak(k.query));var v=r.rows[0]?r.rows[0][r.columns.length-1]:null;
      el.firstChild.textContent=v===null?"—":formatValue(v)}catch(e){el.firstChild.textContent="—"}});
    P.sections.forEach(function(s,i){var q=s.chart?s.chart.query:s.table?s.table.query:null;if(!q)return;
      try{current[i]=runQuery(d,tweak(q));$("e-"+i).textContent="";draw(i);fillTable(i,current[i],s.table?s.table.maxRows:200)}
      catch(e){$("e-"+i).textContent=e.message}});
    var changed=state.from!==P.range.from.slice(0,16)||state.to!==P.range.to.slice(0,16)||state.interval||state.devices.length!==P.devices.length;
    $("stale").hidden=!changed;st.textContent=""})
  .catch(function(e){st.textContent="Could not update: "+e.message})}
function outside(){return $("from").value<P.span.from.slice(0,16)||$("to").value>P.span.to.slice(0,16)}
function read(){if(!$("from").validity.valid||!$("to").validity.valid){$("status").textContent=P.helper?"Choose dates within the last year.":"Those dates are outside the readings in this report; ask in chat to load them.";$("span").classList.add("hl");return}
  if(P.helper){var out=outside();$("load").hidden=!out;
    if(out){$("load").textContent="Load "+$("from").value.replace("T"," ")+" – "+$("to").value.replace("T"," ")+" from Zira";$("status").textContent="Those dates are not in this report yet.";$("span").classList.add("hl");return}}
  $("span").classList.remove("hl");state.from=$("from").value;state.to=$("to").value;state.interval=$("interval").value;
  var boxes=document.querySelectorAll("#devs input");state.devices=boxes.length?Array.prototype.filter.call(boxes,function(b){return b.checked}).map(function(b){return b.value}):P.devices.map(function(d){return d.id});
  if(state.from&&state.to&&state.from<state.to)apply();else $("status").textContent="Choose a start before the end"}
function save(name,text,type){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:type}));a.download=name;document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},1000)}
function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60)||"data"}
function copy(text){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text).catch(fallback);return Promise.resolve(fallback());
  function fallback(){var t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();document.execCommand("copy");t.remove()}}
document.addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;
  if(b.dataset.csv){var i=+b.dataset.csv;save(slug(P.title+" "+P.sections[i].title)+".csv",delimited(resultFor(i),","),"text/csv")}
  if(b.dataset.sheet){var j=+b.dataset.sheet;copy(delimited(resultFor(j),"\\t")).then(function(){window.open("https://sheets.new","_blank","noopener");
    $("status").textContent="Copied. Paste into cell A1 of the new sheet."})}
  if(b.id==="load"){b.disabled=true;$("status").textContent="Loading from Zira… this can take a minute.";
    fetch("extend",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({from:$("from").value,to:$("to").value})})
      .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||("HTTP "+r.status));return j})})
      .then(function(){$("status").textContent="Loaded. Updating the report…";location.reload()})
      .catch(function(err){b.disabled=false;
        // A network error means the helper has stopped (idle, or its session ended).
        $("status").textContent=err instanceof TypeError?"The report helper isn't running. Ask in chat to start it again, then press Load.":"Could not load: "+err.message})}
  if(b.id==="reset"){$("from").value=P.range.from.slice(0,16);$("to").value=P.range.to.slice(0,16);$("interval").value="";
    Array.prototype.forEach.call(document.querySelectorAll("#devs input"),function(x){x.checked=true});read()}});
P.sections.forEach(function(s,i){draw(i)});
Array.prototype.forEach.call(document.querySelectorAll("[data-csv],[data-sheet]"),function(b){b.disabled=false});
if(P.embedded){["from","to","interval","reset"].forEach(function(id){$(id).disabled=false});
  Array.prototype.forEach.call(document.querySelectorAll("#devs input"),function(b){b.disabled=false});
  ["from","to","interval"].forEach(function(id){$(id).addEventListener("change",read)});
  Array.prototype.forEach.call(document.querySelectorAll("#devs input"),function(b){b.addEventListener("change",read)})}
else $("status").textContent="Controls are off for this report (see the note above).";
if(P.helper)setInterval(function(){fetch("ping",{cache:"no-store"}).catch(function(){})},300000);
var rt;window.addEventListener("resize",function(){clearTimeout(rt);rt=setTimeout(function(){for(var k in charts)charts[k].resize()},120)});
var mq=window.matchMedia("(prefers-color-scheme: dark)");if(mq.addEventListener)mq.addEventListener("change",function(){P.sections.forEach(function(s,i){draw(i)})});
})();`;
