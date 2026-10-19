#!/usr/bin/env node
// Calibrate Trimsaw Stops: turns a window of a trimsaw source's readings into calibration values a
// technician enters on the camera. Anchored on one trusted stop, it estimates the camera's scale
// and offset, then each stop line's real size. Reads the readings-report cache only; it changes
// nothing in Zira or on the camera.
import { parseArgs } from "node:util";
import { argValue, isMain, runCli } from "../../../scripts/client.mjs";
import { parseLocal } from "../../readings-report/scripts/query-core.mjs";
import { loadDataset, readDataset } from "../../readings-report/scripts/store.mjs";
import {
  M, boardRows, findRelabels, label, mapLabel, parseMerges, scaleCheck, smoothedMode, stopList, timeline,
} from "../../validate-trimsaw-sizes/scripts/trimsaw-sizes.mjs";

const HELP = `Calibrate Trimsaw Stops — calibration values for a trimsaw camera's stop lines
node scripts/calibration.mjs plan --dataset ID --from LOCAL --to LOCAL [--anchor SIZE] [--merge auto|none|A=B,...]

Fetch the source and pick the window with the validate-trimsaw-sizes windows command first.
plan anchors on one trusted stop (default: the busiest stop with uncut boards), estimates the
camera's scale from that stop's uncut boards and its offset from its cut boards, and gives each
stop's real size: the calibration value to enter on the camera. It writes nothing.
LOCAL times are site time such as 2026-10-09T10:00.
Exit 0 success, 2 invalid/failed.
`;

const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const wsum = pairs => pairs.reduce((s, [, w]) => s + w, 0);

/** The most common measured postcut of a stop's cut boards: where the camera places that stop. */
function cutPeak(rows, merges, stop, { low = 0.9, high = 1.1 } = {}) {
  const pairs = rows.filter(r => !r.noCut && r.target > 0 && r.avgPost !== null && mapLabel(r.target, merges) === stop
    && r.avgPost >= stop * low && r.avgPost <= stop * high).map(r => [r.avgPost, r.units]);
  const n = wsum(pairs);
  return { boards: n, measured: n ? round(smoothedMode(pairs)) : null };
}

/**
 * Measured length = a × real + b along the stops (a = scale, b = offset). Uncut boards already at
 * the anchor's size fix a; the anchor's cut boards then fix b. Every other stop's real size follows
 * from its cut boards, and its uncut boards (when there are enough) cross-check it.
 */
export function calibrationPlan(rows, { merges = [], anchor = null, from, to, minCut = 30, minUncut = 30, tolerance = 0.2 } = {}) {
  const inWindow = rows.filter(r => r.t >= from && r.t < to);
  if (!inWindow.length) throw new Error("No boards in that window; pick another window");
  const stops = stopList(inWindow, merges, { from, to });
  const scale = scaleCheck(inWindow, merges, { minUnits: minUncut });
  const uncut = new Map(scale.stops.map(s => [s.stop, s]));
  const per = stops.map(s => ({ stop: s.stop, boards: s.boards, cut: cutPeak(inWindow, merges, s.stop), uncut: uncut.get(s.stop) ?? null }));

  const usable = per.filter(p => p.cut.boards >= minCut);
  const chosen = anchor !== null && anchor !== undefined ? per.find(p => p.stop === Number(anchor))
    : usable.find(p => p.uncut) ?? usable[0];
  if (!chosen) throw new Error(anchor !== null && anchor !== undefined ? `No stop ${anchor} in that window` : "No stop has enough cut boards to anchor on");
  if (chosen.cut.boards < minCut) throw new Error(`Stop ${label(chosen.stop)} has only ${chosen.cut.boards} cut boards; anchor on a busier stop`);

  let a, basis;
  if (chosen.uncut) { a = chosen.uncut.measured / chosen.stop; basis = `uncut boards at the ${label(chosen.stop)} stop (${chosen.uncut.uncutBoards}) measure ${chosen.uncut.measured}`; }
  else if (scale.agreeing) { a = 1 / scale.factor; basis = `uncut boards at ${scale.stops.length} other stops agree`; }
  else { a = 1; basis = "no uncut-board evidence; the scale is assumed right and only the offset is corrected"; }
  const b = chosen.cut.measured - a * chosen.stop;

  const lines = per.map(p => {
    const real = p.cut.boards >= minCut ? (p.cut.measured - b) / a : null;
    const fromUncut = p.uncut ? p.uncut.measured / a : null;
    const notes = [];
    if (real === null) notes.push(`only ${p.cut.boards} cut boards; use the camera's calibration suggestion after the other lines are set`);
    if (real !== null && Math.abs(real - p.stop) > 0.5) notes.push(`real size ${round(real, 1)} is ${round(Math.abs(real - p.stop), 1)} from its label; check the physical stop or the label`);
    if (real !== null && fromUncut !== null && Math.abs(real - fromUncut) > 0.4) notes.push(`its cut and uncut boards disagree by ${round(Math.abs(real - fromUncut), 1)}; boards may bounce off this stop or the line may be misplaced`);
    return {
      stop: label(p.stop), boards: p.boards, cutBoards: p.cut.boards, cutMeasured: p.cut.measured,
      uncutBoards: p.uncut?.uncutBoards ?? 0, uncutMeasured: p.uncut?.measured ?? null,
      realSize: round(real), calibrationValue: real === null ? null : round(real, 1),
      crossCheck: fromUncut === null ? null : round(fromUncut),
      measuredOff: real === null ? null : round(p.cut.measured - real),
      confidence: real === null ? "none" : p.cut.boards >= 100 && (fromUncut === null || Math.abs(real - fromUncut) <= 0.4) ? "high" : "medium",
      anchor: p === chosen, notes,
    };
  });

  const changes = timeline(inWindow, merges).changes.filter(c => parseLocal(c.at) > from);
  const warnings = [];
  if (changes.length) warnings.push(`The window has ${changes.length} change point(s) (${changes.map(c => `${c.kind} at ${c.at.replace("T", " ")}`).join(", ")}); pick a window after the last change for exact values.`);
  if (basis.startsWith("no uncut")) warnings.push("Without uncut boards at size, a scale error cannot be seen; these values correct only where each stop sits.");
  const needed = lines.some(l => l.measuredOff !== null && Math.abs(l.measuredOff) > tolerance) || Math.abs(a - 1) > 0.01;
  return {
    anchor: label(chosen.stop), scale: { measuredPerReal: round(a, 4), readsShortBy: round((1 - a) * 100, 1), basis },
    offset: round(b), needed, relabels: merges, lines, warnings, steps: deviceSteps(lines, needed),
  };
}

export function deviceSteps(lines, needed) {
  if (!needed) return ["No change needed: every stop already measures within 0.2 of its real size and the scale is within 1%."];
  const set = lines.filter(l => l.calibrationValue !== null);
  const suggest = lines.filter(l => l.calibrationValue === null);
  return [
    "Do this while the saw is idle. Write down each line's current values first (the panel shows them as 45 (44.8): size, then calibration).",
    "On the camera's trim-saw panel, tap Edit lines.",
    ...set.map(l => `Select ${l.stop} with ◀ ▶, tap its value, open Calibration controls ▾ and set Calibration value to ${l.calibrationValue}. Keep the size ${l.stop}. Tap OK.`),
    ...suggest.map(l => `Select ${l.stop}, tap its value, open Calibration controls ▾ and tap Use calibration suggestion. Tap OK.`),
    `Do the same (Use calibration suggestion) for any other line on the camera that is not listed here, such as a stop added after this window${set.length ? `; set ${set.map(l => l.stop).join(", ")} first so the suggestion uses them` : ""}.`,
    "Tap Done. Counting continues with the new values; the stop lines do not move.",
    "After about an hour of production, run validate-trimsaw-sizes on that hour: uncut boards at each stop should measure about the stop's size and cut boards should peak at it.",
  ];
}

export async function plan({ datasetId, profile, from: f, to: t, anchor = null, merge = "auto", root }) {
  const from = parseLocal(f), to = parseLocal(t);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("--from and --to are site-local times such as 2026-10-09T10:00");
  if (to <= from) throw new Error("--to must be after --from");
  const manifest = await readDataset(datasetId, { profile, root });
  if (manifest.devices.length !== 1) throw new Error("Use a dataset with exactly one trimsaw data source");
  const source = manifest.devices[0];
  const have = new Set(source.metrics.filter(m => m.present !== false).map(m => m.id));
  const missing = [M.units, M.avgPre, M.avgPost, M.target, M.noCut].filter(id => !have.has(id));
  if (missing.length) throw new Error(`This data source lacks trimsaw metrics (${missing.join(", ")})`);
  const data = await loadDataset(manifest, { root });
  const rows = boardRows(data.devices[0]);
  const windowRows = rows.filter(r => r.t >= from && r.t < to);
  const merges = merge === "auto" ? findRelabels(windowRows) : parseMerges(merge);
  const result = calibrationPlan(rows, { merges, anchor: anchor === null || anchor === undefined ? null : Number(anchor), from, to });
  return { kind: "trimsaw-calibration-plan", dataset: datasetId, source: { id: source.id, name: source.name, url: source.url },
    window: { from: f, to: t }, ...result,
    validity: "Calibration values are the stops' real sizes; they stay valid while the stop lines are not moved and the camera is not moved, rotated or re-zoomed." };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, dataset: { type: "string" }, from: { type: "string" }, to: { type: "string" },
    anchor: { type: "string" }, merge: { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  if (args[0] !== "plan") throw new Error(`Unknown command ${args[0]}; run with --help`);
  return plan({ datasetId: o.dataset, profile, from: o.from, to: o.to, anchor: o.anchor ?? null, merge: o.merge ?? "auto" });
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
