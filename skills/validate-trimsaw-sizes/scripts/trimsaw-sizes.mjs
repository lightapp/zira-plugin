#!/usr/bin/env node
// Validate Trimsaw Sizes: checks one trimsaw data source's stop buckets, uncut boards and pre-cut
// lengths over a time window and builds an interactive report. It reuses the readings-report cache,
// query engine, page and helper. It writes only to this computer: a derived copy of the dataset
// (rescaled pre-cut, outcome, trim and stop columns) and the HTML report. Nothing is written to Zira.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { argValue, isMain, liveSession, runCli } from "../../../scripts/client.mjs";
import { writePrivate } from "../../health-report/scripts/storage.mjs";
import { formatLocal, parseLocal } from "../../readings-report/scripts/query-core.mjs";
import { ROUTES, serveDetached, writeReport } from "../../readings-report/scripts/readings.mjs";
import { LIMITS, fetchDataset, home, loadDataset, readDataset } from "../../readings-report/scripts/store.mjs";
import { neighboringStops, deriveNeighborColumns, neighborSections } from "./neighbor-stops.mjs";

const HELP = `Validate Trimsaw Sizes — stop buckets, uncut boards and pre-cut for one trimsaw data source
node scripts/trimsaw-sizes.mjs windows --company-id ID --site-id ID --device-id ID --from ISO [--to ISO]
node scripts/trimsaw-sizes.mjs check --dataset ID --from LOCAL --to LOCAL [--merge auto|none|A=B,...]
node scripts/trimsaw-sizes.mjs report --dataset ID --from LOCAL --to LOCAL [--merge auto|none|A=B,...]
    [--factor none|auto|F|F,F2@LOCAL] [--title TEXT] [--serve]
Common: --profile prod|integ

windows fetches the source's readings (cached by readings-report) and lists production periods,
label changes, relabels and likely calibration changes, with a suggested window after the last one.
check reports each stop's measured peaks, detected relabels and the scale check: uncut boards at a
stop should measure about the stop's size; when two or more stops agree on the same error it
suggests a factor for pre-cut. report writes a derived dataset under $ZIRA_TRIMSAW_HOME (default:
next to the readings cache) and the report; --serve hands it out on 127.0.0.1 like readings-report.
LOCAL times are site time such as 2026-10-09T10:00. --factor none keeps Zira's pre-cut values.
Exit 0 success, 2 invalid/failed, 3 incomplete, 4 blocked (JSON explains).
`;

// Zira metric IDs are shared across data sources.
export const M = {
  units: "86", status: "2693", precut: "40072", postcut: "40073", avgPre: "46904", avgPost: "46905",
  target: "48169", noCut: "48168",
};
const REQUIRED = [M.units, M.avgPre, M.avgPost, M.target, M.noCut];
const MIN = 60e3;

// Derived metric IDs live only in the local derived dataset.
export const D = {
  precut: "910001", precutBin: "910002", trim: "910003", trimBin: "910004", outcome: "910005",
  stop: "910006", uncutReason: "910007", trimBand: "910008", cutAny: "910010", uncutAny: "910011",
  unmatchedCut: "910012", notAtStop: "910013", binTarget: "910014",
};
const cutId = k => String(910100 + k);
const uncutId = k => String(910120 + k);
export const MAX_STOPS = 6;

const num = v => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const isTrue = v => v === true || v === 1 || v === "t" || v === "true" || v === "1";
const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
export const label = v => (v === null || v === undefined ? "" : Number.isInteger(v) ? String(v) : String(round(v, 2)));
const local = t => formatLocal(t, "minute").replace(" ", "T");
const wsum = pairs => pairs.reduce((s, [, w]) => s + w, 0);

export function wquantile(pairs, q) {
  const sorted = pairs.filter(([v, w]) => v !== null && w > 0).sort((a, b) => a[0] - b[0]);
  const total = wsum(sorted);
  if (!total) return null;
  let c = 0;
  for (const [v, w] of sorted) { c += w; if (c >= q * total) return v; }
  return sorted.at(-1)[0];
}

// Mode of 0.1-wide bins after a [1,2,1] smoothing, refined by the weighted mean around it.
export function smoothedMode(pairs, width = 0.1) {
  const h = new Map();
  for (const [v, w] of pairs) { const b = Math.round(v / width); h.set(b, (h.get(b) ?? 0) + w); }
  if (!h.size) return null;
  let best = null, bestScore = -1;
  for (const b of h.keys()) {
    const s = (h.get(b - 1) ?? 0) + 2 * h.get(b) + (h.get(b + 1) ?? 0);
    if (s > bestScore) { bestScore = s; best = b; }
  }
  let sw = 0, sv = 0;
  for (const d of [-1, 0, 1]) { const w = h.get(best + d) ?? 0; sw += w; sv += w * (best + d) * width; }
  return sv / sw;
}

/** One entry per reading row that carries boards, from a dataset device's columns. */
export function boardRows(device) {
  const col = id => device.cols[id] ?? [];
  const rows = [];
  for (let i = 0; i < device.t.length; i++) {
    const units = num(col(M.units)[i]);
    if (!(units > 0)) continue;
    rows.push({
      i, t: device.t[i], units, avgPre: num(col(M.avgPre)[i]), avgPost: num(col(M.avgPost)[i]),
      postcut: num(col(M.postcut)[i]), target: num(col(M.target)[i]) ?? 0, noCut: isTrue(col(M.noCut)[i]),
    });
  }
  return rows;
}

export function parseMerges(text) {
  if (!text || text === "auto" || text === "none") return [];
  return text.split(",").map(s => s.trim()).filter(Boolean).map(pair => {
    const m = /^([\d.]+)\s*=\s*([\d.]+)$/.exec(pair);
    if (!m) throw new Error(`--merge expects pairs like 44=45, not ${pair}`);
    return { from: Number(m[1]), to: Number(m[2]) };
  });
}

export function mapLabel(target, merges) {
  let v = target;
  for (let guard = 0; guard < 10; guard++) {
    const m = merges.find(x => x.from === v);
    if (!m) return v;
    v = m.to;
  }
  return v;
}

function labelStats(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!(r.target > 0)) continue;
    const e = by.get(r.target) ?? { label: r.target, first: r.t, last: r.t, units: 0, cut: [] };
    e.first = Math.min(e.first, r.t); e.last = Math.max(e.last, r.t); e.units += r.units;
    if (!r.noCut && r.avgPost !== null) e.cut.push([r.avgPost, r.units]);
    by.set(r.target, e);
  }
  return [...by.values()].map(e => ({ ...e, cutUnits: wsum(e.cut), median: wquantile(e.cut, 0.5) }));
}

/**
 * A relabel: one label stops when another starts and their cut boards sit at the same measured
 * position. The line was renamed, not moved, so both labels are one physical stop.
 */
export function findRelabels(rows, { tolMin = 20, maxDelta = 0.25, maxGap = 2, minCut = 10, leftover = 0.05, localMin = 60 } = {}) {
  const stats = labelStats(rows);
  const tol = tolMin * MIN, span = localMin * MIN;
  // Compare the two labels only around the switch: older readings may use another calibration.
  const cutNear = (lab, from, to) => rows.filter(r => r.target === lab && !r.noCut && r.avgPost !== null && r.t >= from && r.t < to).map(r => [r.avgPost, r.units]);
  const unitsOf = (lab, test) => rows.filter(r => r.target === lab && test(r.t)).reduce((s, r) => s + r.units, 0);
  const merges = [];
  for (const a of stats) {
    const fits = [];
    for (const b of stats) {
      if (b === a || Math.abs(a.label - b.label) > maxGap || b.first <= a.first || Math.abs(a.last - b.first) > tol) continue;
      const before = cutNear(a.label, b.first - span, b.first + tol), after = cutNear(b.label, b.first, b.first + span);
      if (wsum(before) < minCut || wsum(after) < minCut) continue;
      const ma = wquantile(before, 0.5), mb = wquantile(after, 0.5);
      if (Math.abs(ma - mb) > maxDelta) continue;
      if (unitsOf(a.label, t => t > b.first + tol) > leftover * a.units) continue;
      if (unitsOf(b.label, t => t < a.last - tol) > leftover * b.units) continue;
      fits.push({ b, ma, mb });
    }
    fits.sort((x, y) => Math.abs(x.ma - x.mb) - Math.abs(y.ma - y.mb));
    if (fits[0]) merges.push({ from: a.label, to: fits[0].b.label, at: local(fits[0].b.first), measuredFrom: round(fits[0].ma), measuredTo: round(fits[0].mb) });
  }
  return merges;
}

/**
 * Uncut boards against a stop are mostly boards already at that size. Their measured length should
 * be about the stop's size; when two or more stops agree on the same ratio, the camera's scale is
 * off by that ratio and pre-cut can be rescaled by it.
 */
export function scaleCheck(rows, merges, { minUnits = 30, low = 0.85, high = 1.03, maxSpread = 0.01, minChange = 0.01 } = {}) {
  const byStop = new Map();
  for (const r of rows) {
    if (!r.noCut || !(r.target > 0) || r.avgPost === null) continue;
    const s = mapLabel(r.target, merges);
    if (!byStop.has(s)) byStop.set(s, []);
    byStop.get(s).push([r.avgPost, r.units]);
  }
  const stops = [];
  for (const [stop, pairs] of byStop) {
    const near = pairs.filter(([v]) => v >= stop * low && v <= stop * high);
    const n = wsum(near);
    if (n < minUnits) continue;
    const mode = smoothedMode(near);
    stops.push({ stop, uncutBoards: n, measured: round(mode), ratio: round(stop / mode, 4) });
  }
  stops.sort((a, b) => b.uncutBoards - a.uncutBoards);
  const total = stops.reduce((s, p) => s + p.uncutBoards, 0);
  const factor = total ? stops.reduce((s, p) => s + p.ratio * p.uncutBoards, 0) / total : null;
  const spread = stops.length ? Math.max(...stops.map(p => Math.abs(p.ratio - factor))) : null;
  const agreeing = stops.length >= 2 && spread <= maxSpread;
  return {
    stops, factor: round(factor, 4), spread: round(spread, 4), agreeing,
    suggest: agreeing && Math.abs(factor - 1) >= minChange,
    note: stops.length < 2 ? "Fewer than two stops have enough uncut boards to compare; no scale suggestion."
      : !agreeing ? "The stops disagree by more than 1%, so the error is not one scale; check labels and calibration instead."
        : Math.abs(factor - 1) < minChange ? "Uncut boards measure within 1% of their stops; pre-cut needs no rescaling."
          : `Uncut boards at ${stops.length} stops agree: lengths read ${Math.abs((1 - 1 / factor) * 100).toFixed(1)}% ${factor > 1 ? "short" : "long"}.`,
  };
}

export function parseFactor(text, from) {
  if (text === undefined || text === null || text === "none") return [{ from, factor: 1 }];
  const parts = String(text).split(",").map(s => s.trim()).filter(Boolean);
  return parts.map((p, i) => {
    const m = /^([\d.]+)(?:@(.+))?$/.exec(p);
    const factor = m ? Number(m[1]) : NaN;
    if (!(factor > 0.5 && factor < 2)) throw new Error(`--factor ${p} is not a plausible scale factor`);
    const at = m[2] ? parseLocal(m[2]) : from;
    if (i > 0 && !m[2]) throw new Error("Each later --factor part needs @LOCAL time, such as 1.043@2026-10-09T11:40");
    if (!Number.isFinite(at)) throw new Error(`--factor time ${m[2]} is not a site-local time`);
    return { from: at, factor };
  }).sort((a, b) => a.from - b.from);
}
const factorAt = (schedule, t) => schedule.filter(s => s.from <= t).at(-1)?.factor ?? schedule[0].factor;

/** Physical stops by boards, most used first; the rest are grouped. */
export function stopList(rows, merges, { from, to }) {
  const units = new Map();
  for (const r of rows) {
    if (r.t < from || r.t >= to || !(r.target > 0)) continue;
    const s = mapLabel(r.target, merges);
    units.set(s, (units.get(s) ?? 0) + r.units);
  }
  return [...units.entries()].sort((a, b) => b[1] - a[1]).map(([stop, boards]) => ({ stop, boards }));
}

/** For each half-unit pre-cut bin, the stop most of its boards sat against, cut or uncut. */
export function binTargets(rows, { from, to, merges, schedule }) {
  const by = new Map();
  for (const r of rows) {
    if (r.t < from || r.t >= to || r.avgPre === null) continue;
    const bin = Math.round(r.avgPre * factorAt(schedule, r.t) * 2) / 2;
    const stop = r.target > 0 ? label(mapLabel(r.target, merges)) : "Not at a stop";
    if (!by.has(bin)) by.set(bin, new Map());
    by.get(bin).set(stop, (by.get(bin).get(stop) ?? 0) + r.units);
  }
  return new Map([...by].map(([bin, stops]) => [bin, [...stops].sort((a, b) => b[1] - a[1])[0][0]]));
}

export const BANDS = ["Under 2", "2–6", "6–10", "10 or more"];
const band = trim => (trim < 2 ? BANDS[0] : trim < 6 ? BANDS[1] : trim < 10 ? BANDS[2] : BANDS[3]);

/** Adds the derived columns to one device's arrays, for rows inside [from, to). */
export function deriveColumns(device, { from, to, merges, schedule, stops, unit = "in", binTarget = new Map() }) {
  const n = device.t.length;
  const shown = stops.slice(0, MAX_STOPS).map(s => s.stop);
  const cols = Object.fromEntries([...Object.values(D), ...shown.flatMap((_, k) => [cutId(k), uncutId(k)])].map(id => [id, new Array(n).fill(null)]));
  for (const r of boardRows(device)) {
    if (r.t < from || r.t >= to) continue;
    const i = r.i, f = factorAt(schedule, r.t);
    const pre = r.avgPre === null ? null : r.avgPre * f;
    const stop = r.target > 0 ? mapLabel(r.target, merges) : null;
    const k = stop === null ? -1 : shown.indexOf(stop);
    const stopName = stop === null ? "Not at a stop" : label(stop);
    cols[D.stop][i] = stopName;
    if (pre !== null) {
      cols[D.precut][i] = round(pre); cols[D.precutBin][i] = Math.round(pre * 2) / 2;
      cols[D.binTarget][i] = binTarget.get(cols[D.precutBin][i]) ?? null;
    }
    let outcome;
    if (r.noCut) {
      outcome = "Uncut";
      const delta = pre === null || stop === null ? null : pre - stop;
      cols[D.uncutReason][i] = stop === null ? "Not at a stop" : delta === null ? null
        : delta >= -1 && delta < 0.5 ? "At stop size" : delta >= 0.5 ? "Longer than stop" : "Short of stop";
    } else if (stop !== null) {
      outcome = `Cut to ${stopName}`;
      if (pre !== null) {
        const trim = pre - stop;
        cols[D.trim][i] = round(trim); cols[D.trimBin][i] = Math.round(trim * 2) / 2; cols[D.trimBand][i] = band(trim);
      }
    } else outcome = "Cut, not at a stop";
    cols[D.outcome][i] = outcome;
    cols[D.cutAny][i] = !r.noCut && stop !== null && k < 0 ? r.units : 0;
    cols[D.uncutAny][i] = r.noCut ? r.units : 0;
    cols[D.unmatchedCut][i] = !r.noCut && stop === null ? r.units : 0;
    cols[D.notAtStop][i] = r.noCut && stop === null ? r.units : 0;
    shown.forEach((_, j) => {
      cols[cutId(j)][i] = !r.noCut && k === j ? r.units : 0;
      cols[uncutId(j)][i] = r.noCut && k === j ? r.units : 0;
    });
  }
  Object.assign(device.cols, cols);
  const meta = [
    [D.precut, "Pre-cut (rescaled)", unit, "numeric"], [D.precutBin, "Pre-cut (0.5 bins)", unit, "numeric"],
    [D.trim, "Trim (pre-cut minus stop)", unit, "numeric"], [D.trimBin, "Trim (0.5 bins)", unit, "numeric"],
    [D.outcome, "Outcome", null, "list"], [D.stop, "Stop", null, "list"], [D.uncutReason, "Uncut reason", null, "list"],
    [D.trimBand, "Trim band", null, "list"], [D.cutAny, "Cut to other stops", null, "numeric"],
    [D.uncutAny, "Uncut boards", null, "numeric"], [D.unmatchedCut, "Cut, not at a stop", null, "numeric"],
    [D.notAtStop, "Uncut, not at a stop", null, "numeric"], [D.binTarget, "Target (most boards at this pre-cut)", null, "list"],
    ...shown.flatMap((s, j) => [[cutId(j), `Cut to ${label(s)}`, null, "numeric"], [uncutId(j), `Uncut at ${label(s)}`, null, "numeric"]]),
  ];
  return meta.map(([id, name, u, dataType]) => ({ id, name, unit: u, dataType, present: true }));
}

/** Production periods, label changes and likely calibration changes, with a suggested window. */
export function timeline(rows, merges, { gapMin = 30, bucketMin = 30, minShift = 0.2, minUnits = 15, minWindowBoards = 200 } = {}) {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const periods = [];
  for (const r of sorted) {
    const p = periods.at(-1);
    if (!p || r.t - p.lastT > gapMin * MIN) periods.push({ firstT: r.t, lastT: r.t, boards: 0 });
    const q = periods.at(-1); q.lastT = r.t; q.boards += r.units;
  }
  const bucket = t => Math.floor(t / (bucketMin * MIN)) * bucketMin * MIN;
  const buckets = new Map();
  for (const r of sorted) {
    const b = bucket(r.t);
    if (!buckets.has(b)) buckets.set(b, { t: b, boards: 0, labels: new Map() });
    const e = buckets.get(b); e.boards += r.units;
    if (r.target > 0) {
      const s = mapLabel(r.target, merges);
      if (!e.labels.has(s)) e.labels.set(s, { boards: 0, cut: [] });
      const l = e.labels.get(s); l.boards += r.units;
      if (!r.noCut && r.avgPost !== null) l.cut.push([r.avgPost, r.units]);
    }
  }
  // Labels carrying under 1% of all boards are stray (another device, a test or a typo).
  const totals = new Map();
  for (const e of buckets.values()) for (const [s, l] of e.labels) totals.set(s, (totals.get(s) ?? 0) + l.boards);
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  const rare = s => totals.get(s) < 0.01 * all;
  const changes = [];
  const seen = new Set();
  const lastSeen = new Map();
  let disturbed = false, first = true;
  for (const e of [...buckets.values()].sort((a, b) => a.t - b.t)) {
    const rareBoards = [...e.labels].filter(([s]) => rare(s)).reduce((a, [, l]) => a + l.boards, 0);
    const isDisturbed = rareBoards >= 5 && rareBoards >= 0.3 * e.boards;
    if (disturbed && !isDisturbed) changes.push({ at: local(e.t), kind: "stray-labels-ended" });
    disturbed = isDisturbed;
    for (const [s, l] of e.labels) {
      if (rare(s) || isDisturbed) continue;
      if (!seen.has(s) && l.boards >= 10 && !first) changes.push({ at: local(e.t), kind: "new-label", label: label(s), boards: l.boards });
      if (l.boards >= 10 || first) seen.add(s);
      const before = lastSeen.get(s);
      if (wsum(l.cut) >= minUnits) {
        const b = wquantile(l.cut, 0.5);
        if (before && e.t - before.t <= 3 * 60 * MIN && Math.abs(b - before.median) >= minShift)
          changes.push({ at: local(e.t), kind: "measured-shift", label: label(s), from: round(before.median), to: round(b) });
        lastSeen.set(s, { t: e.t, median: b });
      }
    }
    // The first ordinary bucket sets the baseline; stray-label stretches before it do not.
    if (e.boards > 0 && !isDisturbed) first = false;
  }
  const last = [...periods].reverse().find(p => p.boards >= minWindowBoards) ?? periods.at(-1) ?? null;
  let suggested = null;
  if (last) {
    const inside = changes.map(c => parseLocal(c.at)).filter(t => t > last.firstT && t <= last.lastT);
    const start = inside.length ? Math.max(...inside) : last.firstT;
    const end = last.lastT + MIN;
    const boards = sorted.filter(r => r.t >= start && r.t < end).reduce((s, r) => s + r.units, 0);
    suggested = { from: local(start), to: local(end), boards,
      reason: inside.length ? "After the last label or measurement change in the latest production period" : "The latest production period" };
  }
  return {
    periods: periods.map(p => ({ from: local(p.firstT), to: local(p.lastT + MIN), boards: p.boards })),
    changes, suggested,
  };
}

const pct = (part, whole) => (whole ? round((100 * part) / whole, 1) : 0);

/** Every number the summary quotes, unit-weighted, from the derived rows in the window. */
export function summarize(device, { from, to, stops }) {
  const c = device.cols, total = { boards: 0 };
  const g = (id, i) => c[id]?.[i] ?? null;
  const reasons = {}, peaks = new Map(), trims = new Map(), bands = new Map(), stopPeaks = new Map();
  let cutShort = 0, matchedCut = 0;
  for (const r of boardRows(device)) {
    if (r.t < from || r.t >= to) continue;
    total.boards += r.units;
    const reason = g(D.uncutReason, r.i), outcome = g(D.outcome, r.i), stop = g(D.stop, r.i);
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + r.units;
    const bin = g(D.precutBin, r.i);
    if (bin !== null) {
      const p = peaks.get(bin) ?? { boards: 0, outcomes: {} };
      p.boards += r.units; p.outcomes[outcome] = (p.outcomes[outcome] ?? 0) + r.units; peaks.set(bin, p);
    }
    const trim = g(D.trim, r.i);
    if (trim !== null) {
      matchedCut += r.units; if (trim < 0) cutShort += r.units;
      if (!trims.has(stop)) trims.set(stop, []);
      trims.get(stop).push([trim, r.units]);
      const b = g(D.trimBand, r.i);
      if (!bands.has(stop)) bands.set(stop, { boards: 0, long: 0, buckets: new Set() });
      const e = bands.get(stop); e.boards += r.units;
      if (b === BANDS[2] || b === BANDS[3]) { e.long += r.units; e.buckets.add(Math.floor(r.t / (15 * MIN))); }
    }
    if (!r.noCut && r.target > 0 && r.avgPost !== null) {
      if (!stopPeaks.has(stop)) stopPeaks.set(stop, []);
      stopPeaks.get(stop).push([r.avgPost, r.units]);
    }
  }
  const uncut = Object.values(reasons).reduce((s, v) => s + v, 0);
  const buckets15 = Math.max(1, Math.ceil((to - from) / (15 * MIN)));
  return {
    boards: total.boards,
    uncut: { boards: uncut, pct: pct(uncut, total.boards),
      atSize: pct(reasons["At stop size"] ?? 0, total.boards), longer: pct(reasons["Longer than stop"] ?? 0, total.boards),
      shortOrNotAtStop: pct((reasons["Short of stop"] ?? 0) + (reasons["Not at a stop"] ?? 0), total.boards) },
    cutShorterThanStopPct: pct(cutShort, matchedCut),
    peaks: [...peaks.entries()].sort((a, b) => b[1].boards - a[1].boards).slice(0, 6).map(([bin, p]) => ({
      precut: bin, boards: p.boards, mostly: Object.entries(p.outcomes).sort((a, b) => b[1] - a[1])[0][0] })),
    stops: stops.map(({ stop }) => {
      const name = label(stop), tr = trims.get(name) ?? [], pk = stopPeaks.get(name) ?? [], b = bands.get(name);
      return { stop: name, cutBoards: wsum(pk), measuredMedian: round(wquantile(pk, 0.5)),
        trimP25: round(wquantile(tr, 0.25), 1), trimP75: round(wquantile(tr, 0.75), 1),
        longTrims: b?.long ?? 0, longTrimPct: pct(b?.long ?? 0, b?.boards ?? 0),
        longTrimSpread: b ? round(b.buckets.size / buckets15, 2) : 0 };
    }),
  };
}

const fmt = v => (v === null || v === undefined ? "—" : String(v));

// A stop needs enough boards for its own chart or call-out.
export const significant = (stops, total, key = "boards") => stops.filter(x => x[key] >= Math.max(30, 0.02 * total));

export function summaryText({ s, merges, scale, schedule, unit, window }) {
  const main = significant(s.stops, s.boards, "cutBoards");
  const u = unit ? ` ${unit === "in" ? "inches" : unit}` : "";
  const lines = [`Window: ${window.from.replace("T", " ")} to ${window.to.replace("T", " ")} site time, ${s.boards.toLocaleString("en-US")} boards.`, "", "### What the stop buckets show", ""];
  lines.push(`- **${s.uncut.pct}% of boards are uncut (No Cut).** ${s.uncut.atSize}% of all boards were already at their stop's size and passed untouched, ${s.uncut.longer}% were longer than their stop but recorded as uncut, and ${s.uncut.shortOrNotAtStop}% were short of their stop or not at any stop.${s.uncut.longer >= 3 ? " Boards longer than their stop should have been trimmed; when that share is large, the saw line sits past the real blade and thin trims are recorded as No Cut." : ""}`);
  const offs = main.map(x => `${x.stop} at ${fmt(x.measuredMedian)}`);
  if (offs.length) lines.push(`- **Cut boards peak at:** ${offs.join(", ")} (Zira's measured postcut). Posted Postcut is the stop's size; these raw values show where the camera places each stop.`);
  lines.push("- **Uncut boards are reported under the stop they sat against.** Their own length goes to Average Postcut, which pulls each bucket's raw average below the stop.");
  if (merges.length) lines.push(`- **Relabelled lines:** ${merges.map(m => `${label(m.from)} became ${label(m.to)} at ${m.at.replace("T", " ")} (same measured position, ${fmt(m.measuredFrom)} vs ${fmt(m.measuredTo)})`).join("; ")}. They are counted as one stop here.`);
  lines.push("", "### Scale check", "");
  if (scale.stops.length) lines.push(`- Uncut boards at each stop measure: ${scale.stops.map(p => `${label(p.stop)} at ${p.measured} (${p.uncutBoards} boards)`).join(", ")}. ${scale.note}`);
  else lines.push(`- ${scale.note}`);
  const rescaled = schedule.some(x => x.factor !== 1);
  lines.push(rescaled
    ? `- **Pre-cut below is rescaled by ${schedule.map(x => `${x.factor}${x.from > parseLocal(window.from) ? ` from ${local(x.from).replace("T", " ")}` : ""}`).join(", then ")}.** Zira itself still holds the unscaled values.`
    : "- Pre-cut below is shown as Zira measured it (not rescaled).");
  lines.push("", `### Pre-cut${rescaled ? " (rescaled)" : ""}`, "");
  if (s.peaks.length) lines.push(`- **Most common incoming lengths:** ${s.peaks.map(p => `${p.precut} (${p.boards.toLocaleString("en-US")} boards, mostly ${p.mostly.toLowerCase()})`).join(", ")}. Peaks should sit at a stop size (uncut) or a few${u} above the stop they were cut to.`);
  lines.push(`- **${s.cutShorterThanStopPct}% of cut boards were shorter than their stop** before the cut. Anything above about 1% means pre-cut or a stop label is off.`);
  const tr = main.filter(x => x.trimP25 !== null);
  if (tr.length) lines.push(`- **Typical trim (middle half of cut boards):** ${tr.map(x => `${x.stop}: ${x.trimP25}–${x.trimP75}`).join("; ")}${u}.`);
  const longStop = [...main].sort((a, b) => b.longTrimPct - a.longTrimPct)[0];
  if (longStop && longStop.longTrimPct >= 10) lines.push(`- **${longStop.longTrims.toLocaleString("en-US")} boards cut to ${longStop.stop} lost 6${u} or more (${longStop.longTrimPct}%),** ${longStop.longTrimSpread >= 0.5 ? "spread across most of the window, so it looks like routine practice rather than one batch" : "concentrated in part of the window, so it looks like a batch"}. Worth confirming it is intended.`);
  lines.push("", "Medians and percentiles in tables are per reading row, where one row can hold several boards. Histograms and the numbers above are weighted by boards.");
  return lines.join("\n");
}

const bars = (cols, x) => cols.map(c => ({ type: "bar", stack: "s", encode: { x, y: c } }));
const sumOf = (id, name) => ({ metric: id, op: "sum", label: name });

export function buildSpec({ title, window, stops, unit, s, merges, schedule, summary, neighbors = { pairs: [], labels: [], omitted: 0 }, names = { avgPost: "Average Postcut Length", postcut: "Postcut Length" } }) {
  const shown = stops.slice(0, MAX_STOPS);
  const u = unit || "length";
  const cutCols = shown.map((x, k) => ({ id: cutId(k), name: `Cut to ${label(x.stop)}` }));
  const outcomeCols = [...cutCols, ...(stops.length > MAX_STOPS ? [{ id: D.cutAny, name: "Cut to other stops" }] : []),
    { id: D.unmatchedCut, name: "Cut, not at a stop" }, { id: D.uncutAny, name: "Uncut boards" }];
  const uncutCols = [...shown.map((x, k) => ({ id: uncutId(k), name: `Uncut at ${label(x.stop)}` })), { id: D.notAtStop, name: "Uncut, not at a stop" }];
  const share = (lab, value) => ({ label: lab, unit: "%", query: { measures: [{ metric: M.units, op: "share", where: { metric: D.uncutReason, op: "=", value } }] } });
  const histogram = stop => ({
    query: { groupBy: M.avgPost, pivot: false, filters: [{ metric: D.outcome, op: "=", value: `Cut to ${label(stop)}` }],
      measures: [sumOf(M.units, "Boards")], sort: { by: names.avgPost, dir: "asc" } },
    option: { xAxis: { type: "category", name: u }, yAxis: { name: "Boards" }, series: [{ type: "bar", encode: { x: names.avgPost, y: "Boards" } }] },
  });
  const total = stops.reduce((a, x) => a + x.boards, 0);
  const big = significant(shown, total);
  const longStop = [...significant(s.stops, s.boards, "cutBoards")].sort((a, b) => b.longTrimPct - a.longTrimPct)[0];
  const sections = [
    { title: "Boards by stop label, every 15 minutes", text: `The labels as Zira posted them. 0 is unmatched.${merges.length ? " Relabelled lines show as one series ending where the next begins." : ""}`,
      chart: { query: { interval: "15-minutes", groupBy: M.target, filters: [{ metric: M.target, op: "not-empty" }, { metric: M.units, op: ">", value: 0 }], measures: [sumOf(M.units, "Boards")] },
        option: { yAxis: { name: "Boards" } } } },
    ...big.slice(0, 4).map(x => ({ title: `${label(x.stop)} stop — cut boards: measured postcut`,
      text: "Zira's raw measurement of each cut board. A tight peak away from the stop's size is a calibration offset, not noise.", chart: histogram(x.stop) })),
    { title: "Unmatched boards (Target 0): posted Postcut",
      text: "Boards outside every stop's band post their own length. A group just below a stop is boards that were not pushed fully against it.",
      chart: { query: { groupBy: M.postcut, pivot: false, filters: [{ metric: M.target, op: "=", value: 0 }, { metric: M.units, op: ">", value: 0 }], measures: [sumOf(M.units, "Boards")], sort: { by: names.postcut, dir: "asc" } },
        option: { xAxis: { type: "category", name: u }, yAxis: { name: "Boards" }, series: [{ type: "bar", encode: { x: names.postcut, y: "Boards" } }] } } },
    ...(shown[0] ? [{ title: `Drift: average measured postcut of the ${label(shown[0].stop)} stop's cut boards, every 15 minutes`,
      text: "A step that every stop shares points to the camera (moved, rotated or re-zoomed) rather than to one label.",
      chart: { query: { interval: "15-minutes", filters: [{ metric: D.outcome, op: "=", value: `Cut to ${label(shown[0].stop)}` }], measures: [{ metric: M.avgPost, op: "avg", label: "Avg postcut" }] },
        option: { yAxis: { name: u, scale: true } } } }] : []),
    { title: "Pre-cut: incoming board length and what happened to it",
      text: "Pre-cut in half-unit bins, coloured by outcome. Uncut peaks should sit at a stop size; cut boards a little above the stop they were cut to.",
      chart: { height: 420, query: { groupBy: D.precutBin, pivot: false, filters: [{ metric: D.precutBin, op: "not-empty" }], measures: outcomeCols.map(c => sumOf(c.id, c.name)), sort: { by: "Pre-cut (0.5 bins)", dir: "asc" } },
        option: { xAxis: { type: "category", name: u }, yAxis: { name: "Boards" }, series: bars(outcomeCols.map(c => c.name), "Pre-cut (0.5 bins)") } } },
    { title: "Pre-cut peaks", text: "The ten most common incoming lengths, the stop most of them sat against (Target, cut or uncut) and what happened to them.",
      table: { query: { groupBy: D.precutBin, pivot: false, filters: [{ metric: D.precutBin, op: "not-empty" }],
        measures: [sumOf(M.units, "Boards"), { metric: D.binTarget, op: "first", label: "Target" }, ...outcomeCols.map(c => sumOf(c.id, c.name))], sort: { by: "Boards", dir: "desc" }, limit: 10 } } },
    { title: "Uncut boards: length by the stop they sat at",
      text: "Uncut boards should be at, or just under, their stop. Lengths above the stop are thin trims recorded as uncut.",
      chart: { query: { groupBy: D.precutBin, pivot: false, filters: [{ metric: D.outcome, op: "=", value: "Uncut" }], measures: uncutCols.map(c => sumOf(c.id, c.name)), sort: { by: "Pre-cut (0.5 bins)", dir: "asc" } },
        option: { xAxis: { type: "category", name: u }, yAxis: { name: "Boards" }, series: bars(uncutCols.map(c => c.name), "Pre-cut (0.5 bins)") } } },
    { title: "Trim per stop: how much each cut took off", text: "Pre-cut minus the stop, for cut boards at a stop.",
      chart: { query: { groupBy: D.trimBin, pivot: false, filters: [{ metric: D.trimBin, op: "not-empty" }], measures: cutCols.map(c => sumOf(c.id, c.name)) },
        option: { xAxis: { type: "value", name: `${u} trimmed`, min: 0, interval: 1, axisLabel: { hideOverlap: true } }, yAxis: { name: "Boards" }, series: bars(cutCols.map(c => c.name), "Trim (0.5 bins)").map(b => ({ ...b, barWidth: 7 })) } } },
    ...(longStop && longStop.longTrimPct >= 10 ? [{ title: `What was cut to ${longStop.stop}, by trim, every 15 minutes`,
      text: "A long-trim share that runs all window is routine practice; one block of it is a batch.",
      chart: { query: { interval: "15-minutes", groupBy: D.trimBand, filters: [{ metric: D.stop, op: "=", value: longStop.stop }, { metric: D.trimBand, op: "not-empty" }], measures: [sumOf(M.units, "Boards")] },
        option: { yAxis: { name: "Boards" }, series: BANDS.map(b => ({ type: "bar", stack: "s", encode: { x: "time", y: b } })) } } }] : []),
    { title: "Per stop (reading rows)", text: `${merges.length ? "Relabelled lines are merged. " : ""}Pre-cut and trim are ${schedule.some(x => x.factor !== 1) ? "rescaled" : "as measured"}; postcut is Zira's raw reading.`,
      table: { query: { groupBy: D.stop, pivot: false, filters: [{ metric: D.stop, op: "not-empty" }], measures: [
        sumOf(M.units, "Boards"),
        { metric: M.units, op: "share", where: { metric: D.outcome, op: "=", value: "Uncut" }, label: "Uncut %" },
        { metric: M.units, op: "share", where: { metric: D.uncutReason, op: "=", value: "At stop size" }, label: "Uncut at size %" },
        { metric: D.precut, op: "p10", label: "Pre-cut p10" }, { metric: D.precut, op: "median", label: "Pre-cut median" }, { metric: D.precut, op: "p90", label: "Pre-cut p90" },
        { metric: D.trim, op: "median", label: "Trim median" }, { metric: M.avgPost, op: "median", label: "Postcut median (raw)" }] } } },
  ];
  sections.push(...neighborSections(neighbors, { target: M.target, units: M.units, avgPost: M.avgPost,
    outcome: D.outcome, avgPostName: names.avgPost, unit }));
  return {
    title, summary, range: { from: window.from, to: window.to },
    kpis: [
      { label: "Boards (Units)", query: { measures: [sumOf(M.units)] } },
      { label: "Uncut (No Cut flag)", unit: "%", query: { measures: [{ metric: M.units, op: "share", where: { metric: D.outcome, op: "=", value: "Uncut" } }] } },
      share("…already at stop size", "At stop size"),
      share("…longer than stop", "Longer than stop"),
      { label: "…short or not at a stop", unit: "%", query: { measures: [{ metric: M.units, op: "share", where: { metric: D.uncutReason, op: "in", value: ["Short of stop", "Not at a stop"] } }] } },
      { label: "Unmatched (Target 0)", unit: "%", query: { measures: [{ metric: M.units, op: "share", where: { metric: M.target, op: "=", value: 0 } }] } },
      { label: "Cut boards shorter than their stop", unit: "%", query: { measures: [{ metric: D.trim, op: "percent", where: { op: "<", value: 0 } }] } },
    ],
    sections,
  };
}

// Derived datasets live in their own readings root so the plain cache keeps only Zira's values.
export function derivedHome(env = process.env, root = home(env)) {
  return env.ZIRA_TRIMSAW_HOME ? path.resolve(env.ZIRA_TRIMSAW_HOME) : path.join(path.dirname(root), `${path.basename(root)}-trimsaw`);
}
const chunkPath = (root, profile, deviceId, week) => path.join(root, profile, "chunks", deviceId, `${week}.json.gz`);

async function writeGz(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, gzipSync(JSON.stringify(value)), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}

function checkSource(manifest) {
  if (manifest.devices.length !== 1) throw new Error("Use a dataset with exactly one trimsaw data source");
  const ids = new Set(manifest.devices[0].metrics.filter(m => m.present !== false).map(m => m.id));
  const missing = REQUIRED.filter(id => !ids.has(id));
  if (missing.length) throw new Error(`This data source lacks trimsaw metrics (${missing.join(", ")}); it does not look like a trimsaw camera`);
  return manifest.devices[0];
}

function windowArgs(from, to) {
  const f = parseLocal(from), t = parseLocal(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) throw new Error("--from and --to are site-local times such as 2026-10-09T10:00");
  if (t <= f) throw new Error("--to must be after --from");
  return { from: f, to: t, window: { from: local(f), to: local(t) } };
}

async function loadSource({ datasetId, profile, root }) {
  const manifest = await readDataset(datasetId, { profile, root });
  const source = checkSource(manifest);
  const data = await loadDataset(manifest, { root });
  return { manifest, source, device: data.devices[0] };
}

const displayUnit = (stops, source) => {
  const unit = source.metrics.find(m => m.id === M.avgPre)?.unit ?? null;
  const median = wquantile(stops.map(s => [s.stop, s.boards]), 0.5);
  return median !== null && median >= 12 ? "in" : unit;
};

export async function windows({ call, profile, companyId, siteId, deviceId, from, to, root, now = Date.now(), log }) {
  if (!deviceId) throw new Error("Give the trimsaw data source with --device-id");
  const manifest = await fetchDataset({ call, profile, companyId, siteId, deviceIds: [String(deviceId)], from, to, root, now, log });
  const source = checkSource(manifest);
  const data = await loadDataset(manifest, { root });
  const rows = boardRows(data.devices[0]);
  const merges = findRelabels(rows);
  return { kind: "trimsaw-windows", dataset: manifest.id, source: { id: source.id, name: source.name, url: source.url },
    readings: rows.length, complete: manifest.complete, notes: manifest.notes, relabels: merges, ...timeline(rows, merges) };
}

export async function check({ datasetId, profile, from: f, to: t, merge = "auto", root }) {
  const { from, to, window } = windowArgs(f, t);
  const { source, device } = await loadSource({ datasetId, profile, root });
  const rows = boardRows(device).filter(r => r.t >= from && r.t < to);
  if (!rows.length) throw new Error("No boards in that window; pick another window with the windows command");
  const merges = merge === "auto" ? findRelabels(rows) : parseMerges(merge);
  const stops = stopList(rows, merges, { from, to });
  const scale = scaleCheck(rows, merges);
  const peaks = stops.map(({ stop, boards }) => {
    const cut = rows.filter(r => !r.noCut && r.target > 0 && mapLabel(r.target, merges) === stop && r.avgPost !== null).map(r => [r.avgPost, r.units]);
    return { stop: label(stop), boards, cutBoards: wsum(cut), measuredMedian: round(wquantile(cut, 0.5)), p10: round(wquantile(cut, 0.1)), p90: round(wquantile(cut, 0.9)) };
  });
  return { kind: "trimsaw-check", dataset: datasetId, source: { id: source.id, name: source.name }, window,
    boards: rows.reduce((s, r) => s + r.units, 0), relabels: merges, stops: peaks, scale,
    neighbors: neighboringStops(rows, { from, to }) };
}

export async function report({ datasetId, profile, from: f, to: t, merge = "auto", factor = "none", title, serve = false,
  root = home(), trimsawRoot = derivedHome(process.env, root), idleMinutes = 120, now = new Date(), env = process.env }) {
  const { from, to, window } = windowArgs(f, t);
  const { manifest, source, device } = await loadSource({ datasetId, profile, root });
  const rows = boardRows(device).filter(r => r.t >= from && r.t < to);
  if (!rows.length) throw new Error("No boards in that window; pick another window with the windows command");
  const merges = merge === "auto" ? findRelabels(rows) : parseMerges(merge);
  const scale = scaleCheck(rows, merges);
  let factorText = factor;
  if (factor === "auto") {
    if (!scale.suggest) throw new Error(`--factor auto needs a scale suggestion, but: ${scale.note}`);
    factorText = String(scale.factor);
  }
  const schedule = parseFactor(factorText, from);
  const stops = stopList(rows, merges, { from, to });
  const unit = displayUnit(stops, source);
  const neighbors = neighboringStops(rows, { from, to });
  const opts = { from, to, merges, schedule, stops, unit, binTarget: binTargets(rows, { from, to, merges, schedule }) };

  // Copy every week of the source with the derived columns into the trimsaw root.
  const key = createHash("sha256").update(JSON.stringify(["neighbors-v1", manifest.id, manifest.fetchedAt, window, merges, schedule])).digest("hex").slice(0, 10);
  const derivedId = `ds-${key}`;
  let metrics = null;
  for (const c of manifest.chunks) {
    const chunk = JSON.parse(gunzipSync(await readFile(chunkPath(root, manifest.profile, c.deviceId, c.week))).toString("utf8"));
    metrics = deriveColumns({ t: chunk.t, cols: chunk.cols }, opts);
    metrics.push(...deriveNeighborColumns(chunk, boardRows(chunk), neighbors, { from, to }));
    // Each calculation owns its chunks: another window/factor must not overwrite this report's data.
    await writeGz(chunkPath(trimsawRoot, manifest.profile, c.deviceId, `${c.week}-${key}`), chunk);
  }
  const derived = {
    ...manifest, id: derivedId,
    chunks: manifest.chunks.map(c => ({ ...c, week: `${c.week}-${key}` })),
    devices: [{ ...source, metrics: [...source.metrics.filter(m => !Object.values(D).includes(m.id) && !/^(9101|9120)\d\d$/.test(m.id)), ...metrics] }],
    notes: [...(manifest.notes ?? []), `Derived locally from dataset ${manifest.id}: ${schedule.some(x => x.factor !== 1) ? `pre-cut rescaled by ${schedule.map(x => x.factor).join(" then ")}; ` : ""}${merges.length ? `relabels merged (${merges.map(m => `${label(m.from)}→${label(m.to)}`).join(", ")}); ` : ""}window ${window.from.replace("T", " ")} to ${window.to.replace("T", " ")}.`],
    derivedFrom: manifest.id,
  };
  await writePrivate(path.join(trimsawRoot, manifest.profile, "datasets", `${derivedId}.json`), derived);

  const data = await loadDataset(derived, { root: trimsawRoot });
  const s = summarize(data.devices[0], { from, to, stops });
  const summary = summaryText({ s, merges, scale, schedule, unit, window });
  const metricName = (id, fallback) => source.metrics.find(m => m.id === id)?.name ?? fallback;
  const names = { avgPost: metricName(M.avgPost, "Average Postcut Length"), postcut: metricName(M.postcut, "Postcut Length") };
  const spec = buildSpec({ title: title ?? `${source.name.trim()} — stop sizes and pre-cut`, window, stops, unit, s, merges, schedule, summary, names, neighbors });
  const written = await writeReport({ spec, manifest: derived, root: trimsawRoot, now });
  const out = { ...written, kind: "trimsaw-report", dataset: derivedId, sourceDataset: manifest.id, window, relabels: merges, scale,
    factor: schedule, numbers: s, neighbors, source: { id: source.id, name: source.name, url: source.url } };
  if (serve) {
    const helper = await serveDetached({ report: written.path, profile: manifest.profile, idleMinutes, root: trimsawRoot,
      env: { ...env, ZIRA_READINGS_HOME: trimsawRoot } });
    out.liveUrl = helper.url; out.savedUrl = helper.savedUrl;
  }
  return out;
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, "company-id": { type: "string" }, "site-id": { type: "string" }, "device-id": { type: "string" },
    dataset: { type: "string" }, from: { type: "string" }, to: { type: "string" }, merge: { type: "string" },
    factor: { type: "string" }, title: { type: "string" }, serve: { type: "boolean" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const log = message => process.stderr.write(`${message}\n`);
  switch (args[0]) {
    case "windows":
      if (!o.from) throw new Error("windows needs --from (ISO with Z or an offset)");
      return windows({ call: await liveSession(profile, { allow: ROUTES, maxRequests: LIMITS.requests }), profile,
        companyId: o["company-id"], siteId: o["site-id"], deviceId: o["device-id"], from: o.from, to: o.to, log });
    case "check":
      return check({ datasetId: o.dataset, profile, from: o.from, to: o.to, merge: o.merge ?? "auto" });
    case "report":
      return report({ datasetId: o.dataset, profile, from: o.from, to: o.to, merge: o.merge ?? "auto", factor: o.factor ?? "none",
        title: o.title, serve: !!o.serve });
    default: throw new Error(`Unknown command ${args[0]}; run with --help`);
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
