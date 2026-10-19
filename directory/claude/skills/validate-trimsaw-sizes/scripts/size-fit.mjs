// Size fit: how tightly a trimsaw's cut boards sit on their stop sizes, the score every calibration
// change is measured against. One definition shared by production readings (validate-trimsaw-sizes
// check, report and compare) and video replays (calibrate-trimsaw-from-video replay-stats).
// Pure and dependency-free; every share and quantile is weighted by boards.

export const TOLERANCES = [0.25, 0.5];
// Unmatched boards by distance to the nearest stop: just outside the camera's ±0.6 match band,
// a little further, or not near any stop.
export const DISTANCE_BANDS = ["Under 1", "1 to 2", "Over 2"];
const DISTANCE_KEYS = ["under1", "from1to2", "over2"];

const round = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pct = (part, whole) => (whole ? round((100 * part) / whole, 1) : null);
const wsum = pairs => pairs.reduce((s, [, w]) => s + w, 0);
const sizeName = v => (Number.isInteger(v) ? String(v) : String(round(v, 2)));

export function wquantile(pairs, q) {
  const sorted = pairs.filter(([v, w]) => v !== null && w > 0).sort((a, b) => a[0] - b[0]);
  const total = wsum(sorted);
  if (!total) return null;
  let c = 0;
  for (const [v, w] of sorted) { c += w; if (c >= q * total) return v; }
  return sorted.at(-1)[0];
}

/** "42=41.7,44.5=44.3": a stop's nominal size = the value the camera measures it at (its calibration). */
export function parseCalibrations(text) {
  const out = new Map();
  for (const part of String(text ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new Error(`--calibration expects pairs like 42=41.7, not ${part}`);
    const size = Number(m[1]), value = Number(m[2]);
    if (Math.abs(value - size) > 3) throw new Error(`Calibration ${value} is more than 3 from stop ${size}; give the nominal size first, as in 42=41.7`);
    out.set(size, value);
  }
  return out;
}

const toMap = c => (c instanceof Map ? c : new Map(Object.entries(c ?? {}).map(([k, v]) => [Number(k), Number(v)])));

/** The nearest stop reference to a measured length, or null without a length or stops. */
export function nearestStop(length, refs) {
  if (typeof length !== "number" || !Number.isFinite(length) || !refs.length) return null;
  let best = null;
  for (const ref of refs) { const d = Math.abs(length - ref); if (!best || d < best.distance) best = { ref, distance: d }; }
  return { ref: best.ref, distance: round(best.distance, 6) };
}

export const distanceBand = d => (d === null || d === undefined ? null : d < 1 ? DISTANCE_BANDS[0] : d <= 2 ? DISTANCE_BANDS[1] : DISTANCE_BANDS[2]);

/**
 * [offset, boards] pairs: the share within each tolerance (inclusive, at 6 decimals like the report's
 * derived columns), median offset, p10, p90 and their width.
 */
export function offsetStats(pairs, tolerances = TOLERANCES) {
  const total = wsum(pairs);
  if (!total) return null;
  const p10 = wquantile(pairs, 0.1), p90 = wquantile(pairs, 0.9);
  return {
    within: Object.fromEntries(tolerances.map(t => [String(t), pct(wsum(pairs.filter(([o]) => round(Math.abs(o), 6) <= t)), total)])),
    medianOffset: round(wquantile(pairs, 0.5)), p10: round(p10), p90: round(p90), width: round(p90 - p10),
  };
}

/** Stop references for unmatched distances: every stop seen or calibrated, at its calibration value when known. */
export const stopRefs = (stops, calibrations = new Map()) => {
  const cal = toMap(calibrations);
  return [...new Set([...stops.map(Number), ...cal.keys()])].map(s => cal.get(s) ?? s);
};

/**
 * The size-fit score. `boards` are { stop, length, units = 1, cut }: `stop` is the nominal size the
 * camera matched (0 or null when unmatched), `length` the measured postcut, `cut` false for No Cut.
 * `calibrations` maps a nominal size to the value the camera measures that stop at, where they
 * differ (a 42 stop that physically cuts 41.7). Cut boards at a stop are scored against the size
 * (`vsSize`) and, when any calibration is known, against the calibration value or the size
 * (`vsCalibration`). Unmatched and No Cut shares are of all boards.
 */
export function sizeFit(boards, { calibrations = new Map(), tolerances = TOLERANCES } = {}) {
  const cal = toMap(calibrations);
  const refOf = s => cal.get(s) ?? s;
  let total = 0, noCut = 0, unmeasured = 0;
  const byStop = new Map(), unmatched = [];
  for (const b of boards) {
    const units = Number(b.units ?? 1);
    if (!(units > 0)) continue;
    total += units;
    if (!b.cut) noCut += units;
    const stop = Number(b.stop) > 0 ? Number(b.stop) : null;
    const length = typeof b.length === "number" && Number.isFinite(b.length) ? b.length : null;
    if (stop === null) { unmatched.push([length, units]); continue; }
    if (!byStop.has(stop)) byStop.set(stop, { boards: 0, cut: [] });
    const e = byStop.get(stop);
    e.boards += units;
    if (b.cut) { if (length === null) unmeasured += units; else e.cut.push([length, units]); }
  }
  const pooled = { size: [], cal: [] };
  const stops = [...byStop].sort((a, b) => b[1].boards - a[1].boards || b[0] - a[0]).map(([stop, e]) => {
    const vsSize = e.cut.map(([l, w]) => [l - stop, w]), vsCal = e.cut.map(([l, w]) => [l - refOf(stop), w]);
    pooled.size.push(...vsSize); pooled.cal.push(...vsCal);
    return { stop: sizeName(stop), calibration: cal.get(stop) ?? null, boards: e.boards, cutBoards: wsum(e.cut),
      vsSize: offsetStats(vsSize, tolerances), vsCalibration: cal.has(stop) ? offsetStats(vsCal, tolerances) : null };
  });
  const refs = stopRefs([...byStop.keys()], cal);
  const split = [0, 0, 0];
  let unknown = 0;
  for (const [length, units] of unmatched) {
    const near = nearestStop(length, refs);
    if (near) split[DISTANCE_BANDS.indexOf(distanceBand(near.distance))] += units; else unknown += units;
  }
  const unmatchedBoards = wsum(unmatched);
  return {
    boards: total, cutBoards: wsum(pooled.size), tolerances,
    vsSize: offsetStats(pooled.size, tolerances),
    vsCalibration: cal.size ? offsetStats(pooled.cal, tolerances) : null,
    stops,
    unmatched: { boards: unmatchedBoards, pct: pct(unmatchedBoards, total),
      ...Object.fromEntries(DISTANCE_KEYS.map((k, i) => [k, pct(split[i], total)])), ...(unknown ? { noLength: pct(unknown, total) } : {}) },
    noCut: { boards: noCut, pct: pct(noCut, total) },
    ...(unmeasured ? { cutWithoutLength: unmeasured } : {}),
  };
}

/** "42.3=40,37.9=36": stop labels of the first window paired with the second's. */
export function parsePairs(text) {
  const out = new Map();
  for (const part of String(text ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([\d.]+)\s*=\s*([\d.]+)$/.exec(part);
    if (!m) throw new Error(`--pair expects stop pairs like 42.3=40, not ${part}`);
    out.set(sizeName(Number(m[1])), sizeName(Number(m[2])));
  }
  return out;
}

const diff = (a, b, d) => (a === null || a === undefined || b === null || b === undefined ? null : round(b - a, d));

/**
 * Two size-fit scores side by side: overall rows, then one block per stop. Stops pair by equal
 * labels unless `pairs` maps a first-window label to a second-window one. Calibration rows appear
 * where either side has a calibration value; a side without one is scored against its sizes there.
 */
export function compareFits(a, b, { pairs = new Map() } = {}) {
  const rows = [];
  const row = (metric, x, y, d = 2, stop = undefined) => rows.push({ ...(stop ? { stop } : {}), metric, a: x ?? null, b: y ?? null, change: d === null ? null : diff(x, y, d) });
  const block = (fa, fb, stop) => {
    for (const t of a.tolerances ?? TOLERANCES) row(`Cut within ±${t} of size (%)`, fa?.vsSize?.within[String(t)], fb?.vsSize?.within[String(t)], 1, stop);
    if (fa?.vsCalibration || fb?.vsCalibration) for (const t of a.tolerances ?? TOLERANCES)
      row(`Cut within ±${t} of calibration (%)`, (fa?.vsCalibration ?? fa?.vsSize)?.within[String(t)], (fb?.vsCalibration ?? fb?.vsSize)?.within[String(t)], 1, stop);
    row("Median offset from size", fa?.vsSize?.medianOffset, fb?.vsSize?.medianOffset, 2, stop);
    row("Offset p10", fa?.vsSize?.p10, fb?.vsSize?.p10, 2, stop);
    row("Offset p90", fa?.vsSize?.p90, fb?.vsSize?.p90, 2, stop);
    row("p10–p90 width", fa?.vsSize?.width, fb?.vsSize?.width, 2, stop);
  };
  row("Boards", a.boards, b.boards, null);
  row("Cut boards at a stop", a.cutBoards, b.cutBoards, null);
  block(a, b);
  row("Unmatched (%)", a.unmatched.pct, b.unmatched.pct, 1);
  row("Unmatched, under 1 from a stop (%)", a.unmatched.under1, b.unmatched.under1, 1);
  row("Unmatched, 1 to 2 from a stop (%)", a.unmatched.from1to2, b.unmatched.from1to2, 1);
  row("Unmatched, over 2 from a stop (%)", a.unmatched.over2, b.unmatched.over2, 1);
  row("No Cut (%)", a.noCut.pct, b.noCut.pct, 1);
  const paired = new Set();
  const order = [...b.stops.map(s => {
    const from = [...pairs].find(([, to]) => to === s.stop)?.[0] ?? (pairs.has(s.stop) ? null : s.stop);
    const sa = from === null ? null : a.stops.find(x => x.stop === from) ?? null;
    if (sa) paired.add(sa.stop);
    return [sa, s];
  }), ...a.stops.filter(s => !paired.has(s.stop)).map(s => [s, null])];
  for (const [sa, sb] of order) {
    const name = sa && sb && sa.stop !== sb.stop ? `${sa.stop} → ${sb.stop}` : (sb ?? sa).stop;
    const calNote = [sa, sb].map(s => s?.calibration).filter(v => v !== null && v !== undefined);
    const stop = calNote.length ? `${name} (calibration ${[...new Set(calNote)].join("/")})` : name;
    row("Cut boards", sa?.cutBoards, sb?.cutBoards, null, stop);
    block(sa, sb, stop);
  }
  return rows;
}

const show = v => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v));
const signed = v => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${show(v)}`);

/** compareFits rows as a plain-text table with the two window labels as column heads. */
export function formatComparison(rows, { a = "A", b = "B" } = {}) {
  const lines = [];
  const w = Math.max(38, ...rows.map(r => r.metric.length + 2));
  const cw = Math.max(12, a.length, b.length) + 2;
  const line = (m, x, y, d) => `${m.padEnd(w)}${x.padStart(cw)}${y.padStart(cw)}${d.padStart(10)}`;
  lines.push(line("", a, b, "change"));
  let group = null;
  for (const r of rows) {
    if (r.stop !== group) { group = r.stop; lines.push("", group ? `Stop ${group}` : "All stops"); }
    lines.push(line(`  ${r.metric}`, show(r.a), show(r.b), r.change === null ? "" : signed(r.change)));
  }
  return lines.join("\n");
}
