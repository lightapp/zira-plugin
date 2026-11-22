// Shared band saw board-inspection rollout logic: the board fields, the site done criteria, the shared
// definitions (48x40 shape, pallet mix, stills per pallet) and the Scale and crop fits, used by
// setup-bandsaw-site, validate-bandsaw-site and the internal band saw rollout project skill. Pure functions plus one
// readings loader over the readings-report cache; nothing here writes to Zira or a camera.
import os from "node:os";
import path from "node:path";
import { readingValue } from "../skills/readings-report/scripts/query-core.mjs";

// Local work folders: $ZIRA_PROJECTS_HOME/<name> (default ~/.cache/zira/projects/<name>), outside Git.
export function projectsHome(name, env = process.env) {
  const base = env.ZIRA_PROJECTS_HOME ? path.resolve(env.ZIRA_PROJECTS_HOME)
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "zira", "projects");
  return path.join(base, name);
}
export const slug = value => String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "site";

// The seven board fields every rolled-out band saw data source carries (AI Data Source Builder, exact names).
// Metric IDs are Zira's shared metric catalogue, the same on every site.
export const BOARD_FIELDS = [
  { name: "Board Count", metricId: "56829", type: "Number", unit: null },
  { name: "Pallet Length", metricId: "59842", type: "Length", unit: "Inch" },
  { name: "Pallet Width", metricId: "60829", type: "Length", unit: "Inch" },
  { name: "Pallet State", metricId: "60830", type: "Text", unit: null },
  { name: "Measured Board Length", metricId: "60831", type: "Length", unit: "Inch" },
  { name: "Min Board Length", metricId: "60832", type: "Length", unit: "Inch" },
  { name: "Max Board Length", metricId: "60833", type: "Length", unit: "Inch" },
];
export const UNITS = { name: "Units", metricId: "86" };

// Check a data source field (meterSchema metric) against its board field: the shared metric, and for the five
// lengths a Length field in inches. Zira's AI Data Source Builder has saved draft "Length" fields as Text on
// new metrics (Baltimore 2026-11-12: 60850–60854), which a name check alone does not catch.
export function boardFieldProblem(field, metric) {
  const id = String(metric?.metric?.id ?? "");
  const category = metric?.uom?.uomCategory?.name ?? null, unit = metric?.uom?.name ?? null;
  const problems = [];
  if (id !== field.metricId) problems.push(`metric ${id || "none"}, not the shared ${field.metricId}`);
  if (field.type === "Length" && ((category && category !== "Length") || (unit && unit !== "Inch"))) problems.push(`saved as ${category ?? "?"}${unit && unit !== category ? ` / ${unit}` : ""}, not Length / Inch`);
  if (field.type === "Text" && category && category !== "Text") problems.push(`saved as ${category}, not Text`);
  if (field.type === "Number" && category && !["Number", "Count"].includes(category)) problems.push(`saved as ${category}, not Number`);
  return problems.length ? { name: field.name, metricId: id || null, expected: field.metricId, problems,
    fix: field.type === "Length" ? `Edit the field: Type Length, metric "${field.name} (global)", Unit of measure Inch.` : `Edit the field: pick the metric "${field.name} (global)".` } : null;
}

// Site done criteria (hub #62, Muli 2026-11-11, tightened 2026-11-12). Counts are information only.
export const CRITERIA = {
  stillsPerPallet: { min: 0.97, max: 1.03, label: "stills per pallet 0.97–1.03" },
  inReadings: { min: 0.9, label: "≥90 % of stills in readings" },
  sizePosted: { min: 0.7, label: "size posted ≥70 % of measurable" },
  shape4840: { tolerance: 0.6, label: "48×40 within ±0.6 in" },
};
// A posted size "shaped like 48x40": long side 45–52 in, short side 37–43 in (widened 2026-11-11 after Milton).
export const SHAPE_4840 = { long: [45, 52], short: [37, 43] };
export const MEASURABLE = ["measurable", "broken_measurable"];
// Pallet mix: nearest of these within 4 in on both sides, either orientation; otherwise Other.
export const MIX_SIZES = ["48x40", "48x42", "48x48", "42x42", "40x40", "48x45", "45x45", "47x32", "48x36", "44x44", "38x26", "36x36", "30x30"];
export const MIX_MIN_SHARE = 5, MIX_MAX_BARS = 6;

const round = (v, n) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n + Number.EPSILON * Math.sign(v)) / 10 ** n);
export const round2 = v => round(v, 2);
export const round1 = v => round(v, 1);
export function median(values) {
  const s = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const longShort = (a, b) => [Math.max(a, b), Math.min(a, b)];
export const isShape4840 = (a, b, shape = SHAPE_4840) => {
  const [l, s] = longShort(a, b);
  return l >= shape.long[0] && l <= shape.long[1] && s >= shape.short[0] && s <= shape.short[1];
};

export function nearestMix(a, b) {
  const [l, s] = longShort(a, b);
  let best = null;
  for (const m of MIX_SIZES) {
    const [x, y] = m.split("x").map(Number);
    const [X, Y] = longShort(x, y);
    if (Math.abs(l - X) <= 4 && Math.abs(s - Y) <= 4) {
      const d = Math.abs(l - X) + Math.abs(s - Y);
      if (!best || d < best.d) best = { d, m };
    }
  }
  return best ? best.m.replace("x", "×") : "Other";
}

// Shares of each nearest size; sizes under 5 % fold into Other; at most six bars before Other.
export function palletMix(sizes) {
  const counts = new Map();
  for (const [a, b] of sizes) { const k = nearestMix(a, b); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const n = sizes.length;
  if (!n) return { n: 0, bars: [] };
  let other = counts.get("Other") ?? 0;
  const named = [...counts].filter(([k]) => k !== "Other").map(([k, c]) => ({ label: k, count: c, share: (100 * c) / n }))
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
  const bars = [];
  for (const b of named) {
    if (b.share >= MIX_MIN_SHARE && bars.length < MIX_MAX_BARS) bars.push(b);
    else other += b.count;
  }
  if (other) bars.push({ label: "Other", count: other, share: (100 * other) / n });
  return { n, bars: bars.map(b => ({ ...b, share: round1(b.share) })) };
}

// ---- Readings ----
const metricIdByName = (metrics, name) => Object.entries(metrics ?? {}).find(([, m]) => String(m?.name ?? "").trim().toLowerCase() === name.toLowerCase())?.[0];

// One device of a readings-report dataset (loadDataset) as rows with the band saw fields by name.
// t is the site's wall-clock ms, u the UTC instant.
export function bandsawRows(device, metrics) {
  const ids = {
    units: metricIdByName(metrics, "Units") ?? UNITS.metricId,
    state: metricIdByName(metrics, "Pallet State"), length: metricIdByName(metrics, "Pallet Length"),
    width: metricIdByName(metrics, "Pallet Width"), boardLength: metricIdByName(metrics, "Measured Board Length"),
    boardCount: metricIdByName(metrics, "Board Count"),
  };
  const col = (k, i) => (ids[k] && device.cols?.[ids[k]] ? readingValue(device.cols[ids[k]][i]) : null);
  const n = (k, i) => { const v = col(k, i); return typeof v === "number" ? v : null; };
  const rows = [];
  for (let i = 0; i < device.t.length; i++) {
    const state = col("state", i);
    rows.push({ t: device.t[i], u: device.u[i], units: n("units", i) ?? 0, state: typeof state === "string" && state ? state : null,
      length: n("length", i), width: n("width", i), boardLength: n("boardLength", i), boardCount: n("boardCount", i) });
  }
  return { rows, fields: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v ?? null])) };
}

const DAY = 86400e3;
const hhmm = t => new Date(t).toISOString().slice(11, 16);
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// Counts for the same clock window on the previous week's Mon–Fri days the saw ran (information only).
// Windows are site wall-clock ms; a day "ran" when it counted at least one pallet in the window.
export function countBaseline(rows, from, to) {
  const weekday = new Date(from).getUTCDay(); // site wall clock, so getUTC* reads local fields
  const mondayBack = ((weekday + 6) % 7) + 7; // days back to the previous week's Monday
  const days = [];
  for (let back = mondayBack; back > mondayBack - 5; back--) {
    const a = from - back * DAY, b = to - back * DAY;
    const units = rows.reduce((s, r) => s + (r.t >= a && r.t < b ? r.units : 0), 0);
    days.push({ day: dayOf(a), weekday: new Date(a).toUTCString().slice(0, 3), units: Math.round(units) });
  }
  const ran = days.filter(d => d.units > 0);
  const same = days.find(d => d.weekday === new Date(from).toUTCString().slice(0, 3)) ?? null;
  return { days, ran: ran.map(d => d.day), range: ran.length ? [Math.min(...ran.map(d => d.units)), Math.max(...ran.map(d => d.units))] : null,
    sameWeekdayLastWeek: same };
}

// Per-saw KPIs over a window [from, to) of site wall-clock ms. stills = board stills taken in the window
// (null when unknown). from4840 starts the 48x40 window later (after a Scale change).
export function sawKpis(rows, { from, to, stills = null, from4840 = null }) {
  const win = rows.filter(r => r.t >= from && r.t < to);
  const pallets = Math.round(win.reduce((s, r) => s + r.units, 0));
  const withState = win.filter(r => r.state);
  const measurable = withState.filter(r => MEASURABLE.includes(r.state));
  const sized = measurable.filter(r => r.length != null && r.width != null);
  const start48 = from4840 ?? from;
  const shape = sized.filter(r => r.t >= start48 && isShape4840(r.length, r.width)).map(r => longShort(r.length, r.width));
  const states = {};
  for (const r of withState) states[r.state] = (states[r.state] ?? 0) + 1;
  const counted = win.filter(r => r.units > 0);
  return {
    pallets, stills, readingsWithState: withState.length, measurable: measurable.length, sized: sized.length,
    stillsPerPallet: stills != null && pallets ? stills / pallets : null,
    inReadings: stills ? withState.length / stills : null,
    sizePosted: measurable.length ? sized.length / measurable.length : null,
    shape4840: { n: shape.length, from: start48, length: median(shape.map(x => x[0])), width: median(shape.map(x => x[1])) },
    boardLengthMedian: median(sized.map(r => r.boardLength).filter(v => v != null)),
    notSettled: states.not_settled ?? 0, states,
    firstCount: counted.length ? hhmm(counted[0].t) : null, lastCount: counted.length ? hhmm(counted.at(-1).t) : null,
    sizes: sized.map(r => [r.length, r.width]), shapes: shape,
  };
}

// Judge one saw against the done criteria. Stills per pallet is judged as shown (2 decimals) and the
// 48x40 medians as shown (1 decimal); percentages unrounded. A criterion with no data is not met.
export function judgeSaw(k) {
  const spp = round2(k.stillsPerPallet);
  const L = round1(k.shape4840.length), W = round1(k.shape4840.width);
  const c = [
    { key: "stillsPerPallet", label: CRITERIA.stillsPerPallet.label, value: spp,
      pass: spp == null ? null : spp >= CRITERIA.stillsPerPallet.min && spp <= CRITERIA.stillsPerPallet.max },
    { key: "inReadings", label: CRITERIA.inReadings.label, value: k.inReadings, pass: k.inReadings == null ? null : k.inReadings >= CRITERIA.inReadings.min },
    { key: "sizePosted", label: CRITERIA.sizePosted.label, value: k.sizePosted, pass: k.sizePosted == null ? null : k.sizePosted >= CRITERIA.sizePosted.min },
    { key: "shape4840", label: CRITERIA.shape4840.label, value: L == null ? null : [L, W], n: k.shape4840.n,
      pass: L == null ? null : Math.abs(L - 48) <= CRITERIA.shape4840.tolerance + 1e-9 && Math.abs(W - 40) <= CRITERIA.shape4840.tolerance + 1e-9 },
  ];
  const pc = v => `${Math.floor(v * 1000) / 10}%`.replace(/\.0%$/, "%");
  const detail = {
    stillsPerPallet: x => `${x.value.toFixed(2)} stills per pallet (0.97–1.03 needed)`,
    inReadings: x => `${pc(x.value)} of stills in readings (90% needed)`,
    sizePosted: x => `size posted for ${pc(x.value)} of measurable pallets (70% needed)`,
    shape4840: x => `48×40 reads ${x.value[0].toFixed(1)} × ${x.value[1].toFixed(1)} in (48 × 40 ±0.6 needed)`,
  };
  for (const x of c) x.detail = x.pass === null ? `${x.label}: no data` : detail[x.key](x);
  const failing = c.filter(x => x.pass !== true).map(x => (x.pass === null ? `${x.label} (no data)` : x.label));
  return { criteria: c, failing, failingDetail: c.filter(x => x.pass !== true).map(x => x.detail), pill: failing.length ? "Held" : "Pass" };
}

// Ready only when every saw passes; otherwise Held, naming each saw and criterion.
export function siteVerdict(saws) {
  const held = saws.filter(s => s.judgement.pill !== "Pass").map(s => ({ saw: s.name, failing: s.judgement.failing, detail: s.judgement.failingDetail ?? s.judgement.failing }));
  return { verdict: held.length || !saws.length ? "Held" : "Ready", held,
    sentence: !saws.length ? "No saws to judge." : held.length ? `Held: ${held.map(h => `${h.saw}: ${h.detail.join(" and ")}`).join("; ")}.` : "Ready: every saw meets every done criterion." };
}

export function siteTotals(saws) {
  const sum = k => saws.reduce((s, x) => s + (x.kpis[k] ?? 0), 0);
  const pallets = sum("pallets"), stillsKnown = saws.every(s => s.kpis.stills != null), stills = stillsKnown ? sum("stills") : null;
  // Each saw's own 48x40 window (after its Scale change, when it has one).
  const pool = saws.flatMap(s => s.kpis.shapes ?? []);
  return { pallets, stills, stillsPerPallet: stills != null && pallets ? stills / pallets : null,
    inReadings: stills ? sum("readingsWithState") / stills : null, sizePosted: sum("measurable") ? sum("sized") / sum("measurable") : null,
    shape4840: { n: pool.length, length: median(pool.map(x => x[0])), width: median(pool.map(x => x[1])) },
    mix: palletMix(saws.flatMap(s => s.kpis.sizes)) };
}

// ---- Scale ----
// Fit the Scale that makes pallets shaped like 48x40 read 48x40. Readings scale linearly with Scale, so a
// factor f maps each posted size (L, W) to (fL, fW). A coarse search finds the f that puts most pallets on
// 48x40 (47–49 x 39–41), so a far-off Scale (Dallas Bandsaw 2 read 59.7 x 49.9) still finds its group;
// then f is refined until the shape window's medians read 48 x 40: f *= mean(48/median L, 40/median W).
export function scaleFit(sizes, { scale, boards = null, minPallets = 15, searchFrom = 0.7, searchTo = 1.3 } = {}) {
  if (!(scale > 0)) throw new Error("Give the Scale the camera used for these readings");
  const pts = sizes.filter(([a, b]) => a > 0 && b > 0).map(([a, b, bl]) => [...longShort(a, b), bl ?? null])
    .filter(([, , bl]) => !boards || (bl != null && bl >= boards[0] && bl <= boards[1]));
  const core = f => pts.filter(([l, s]) => Math.abs(f * l - 48) <= 1 && Math.abs(f * s - 40) <= 1).length;
  const curve = [];
  for (let f = searchFrom; f <= searchTo + 1e-9; f += 0.002) curve.push({ f: round(f, 3), n: core(f) });
  const peaks = curve.filter((p, i) => p.n > 0 && (i === 0 || p.n >= curve[i - 1].n) && (i === curve.length - 1 || p.n > curve[i + 1].n));
  // Merge plateaus: keep the best point of each run of peaks closer than 3 %.
  const groups = [];
  for (const p of peaks.toSorted((a, b) => b.n - a.n || Math.abs(a.f - 1) - Math.abs(b.f - 1)))
    if (!groups.some(g => Math.abs(g.f - p.f) < 0.03)) groups.push(p);
  const best = groups[0];
  const out = { scale, pallets: pts.length, boardsFilter: boards, peaks: groups.slice(0, 3) };
  if (!best) return { ...out, ok: false, reason: "No posted sizes come near a 48 x 40 shape at any Scale within ±30 %." };
  let f = best.f, inWin = [], iterations = 0;
  for (; iterations < 8; iterations++) {
    inWin = pts.filter(([l, s]) => isShape4840(f * l, f * s));
    if (!inWin.length) break;
    const mL = median(inWin.map(x => f * x[0])), mW = median(inWin.map(x => f * x[1]));
    const next = f * ((48 / mL + 40 / mW) / 2);
    if (Math.abs(next - f) < 1e-5) { f = next; break; }
    f = next;
  }
  inWin = pts.filter(([l, s]) => isShape4840(f * l, f * s));
  const before = pts.filter(([l, s]) => isShape4840(l, s));
  const medL = median(inWin.map(x => x[0])), medW = median(inWin.map(x => x[1]));
  const bl = inWin.map(x => x[2]).filter(v => v != null).map(v => v * f);
  const binned = new Map();
  for (const v of bl) { const k = Math.round(v * 2) / 2; binned.set(k, (binned.get(k) ?? 0) + 1); }
  const peak = [...binned].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const longFactor = medL ? 48 / medL : null, shortFactor = medW ? 40 / medW : null;
  const warnings = [];
  if (inWin.length < minPallets) warnings.push(`Only ${inWin.length} pallets shaped like 48×40; wait for at least ${minPallets} before changing the Scale.`);
  if (groups[1] && groups[1].n >= 0.7 * best.n) warnings.push(`Two pallet groups fit 48×40 at different Scales (factor ${best.f} with ${best.n} pallets, ${groups[1].f} with ${groups[1].n}); ask which pallets the site runs before choosing.`);
  if (Math.abs(f - 1) > 0.2) warnings.push(`The change is ${round1((f - 1) * 100)} %: check the camera, its ruler and the table on a still before sending it.`);
  if (longFactor && shortFactor && Math.abs(longFactor / shortFactor - 1) > 0.015)
    warnings.push(`The long and short sides disagree by ${round1(Math.abs(longFactor / shortFactor - 1) * 100)} %: one Scale cannot fix both; a per-axis correction (Vision-App 933 or later) is a separate decision from a full shift.`);
  if (bl.length && peak != null && Math.abs(peak - 40) > 1.5) warnings.push(`At the new Scale the most common board in these pallets reads ${peak} in, not 40: check whether the site's 48×40 pallets use 40-in boards.`);
  return { ...out, ok: inWin.length >= minPallets && !(groups[1] && groups[1].n >= 0.7 * best.n), factor: round(f, 4),
    proposedScale: round(scale * f, 4), changePercent: round1((f - 1) * 100),
    current: { n: before.length, length: round1(median(before.map(x => x[0]))), width: round1(median(before.map(x => x[1]))) },
    proposed: { n: inWin.length, length: round1(median(inWin.map(x => f * x[0]))), width: round1(median(inWin.map(x => f * x[1]))) },
    sides: { longFactor: round(longFactor, 4), shortFactor: round(shortFactor, 4) },
    boardLength: { n: bl.length, median: round1(median(bl)), peak }, iterations, warnings };
}

// ---- Board crop ----
// Fit the board crop's top (y, a fraction of the upright frame) from the pallet boxes of the first real
// stills (meta palletBox, frame fractions). The app widens a still's crop by itself to cover its pallet box,
// so the boxes show where pallets really sit. Keep the crop square (height 0.5625 of a 16:9 portrait frame).
export function cropFit(boxes, { height = 0.5625, margin = 0.025, current = null } = {}) {
  const ok = boxes.filter(b => Number.isFinite(b?.top) && Number.isFinite(b?.bottom) && b.bottom > b.top);
  if (!ok.length) throw new Error("Give the pallet boxes (top and bottom, frame fractions) of at least one still");
  const top = Math.min(...ok.map(b => b.top)), bottom = Math.max(...ok.map(b => b.bottom));
  const y = Math.max(0, Math.floor((top - margin) * 100) / 100);
  const warnings = [];
  if (ok.length < 6) warnings.push(`Only ${ok.length} stills; fit on at least 6 per saw (pallets at both ends of the table).`);
  if (y + height < bottom + 0.01) warnings.push(`Pallets reach ${round(bottom, 3)} of the frame, below the crop's bottom (${round(y + height, 3)}): their near ends would be cut. Look at the stills before choosing.`);
  if (y + height > 1) warnings.push("The crop runs past the bottom of the frame.");
  const widened = current ? ok.filter(b => b.crop && (Math.abs(b.crop.y - current.y) > 0.001 || Math.abs(b.crop.height - current.height) > 0.001)).length : null;
  return { stills: ok.length, highestTop: round(top, 3), lowestBottom: round(bottom, 3),
    proposed: { x: 0, y, width: 1, height }, current, widenedByApp: widened,
    definedBy: ok.filter(b => b.top === top).map(b => b.name ?? null).filter(Boolean), warnings };
}

// ---- Versions ----
// Vision-App versionName to versionCode for the band saw builds of this rollout (hub #62).
export const APP_VERSIONS = { "1.308.3": 841, "1.308.29": 925, "1.308.30": 926, "1.308.31": 927, "1.308.32": 928, "1.308.33": 930,
  "1.308.34": 932, "1.308.35": 933, "1.308.36": 934, "1.308.37": 935, "1.308.40": 938 };
export const appCode = name => APP_VERSIONS[String(name ?? "").replace(/-.*$/, "")] ?? null;
const vparts = v => String(v ?? "").split(".").map(x => Number.parseInt(x, 10));
export function versionAtLeast(name, min) {
  const a = vparts(name), b = vparts(min);
  if (a.some(Number.isNaN) || !a.length) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x > y; }
  return true;
}
// Board stills with posted sizes only when the model's boxes agree arrived in 928 (1.308.32).
export const MIN_BOARD_APP = "1.308.32";
