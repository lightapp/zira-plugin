#!/usr/bin/env node
// The saw-line gate for every trimsaw calibration. A trimsaw camera measures a board as
// size = (saw - stop end) * scale, so the saw position its stops imply must sit where the cut board
// ends really are. Stop labels can agree with each other and still be wrong: on one customer's
// Trimsaw 1 (11/13) stops labelled from a stale saw (243.1 frame px, real cut ends at about 248.5) read
// every board about 2 in. short while the size reports said PASSED. So nothing is applied, assigned,
// recorded or reported as passed until this check has measured the cut ends on a real recording, drawn
// the saw on it, found them within about 1 frame px and the user has approved the picture.
//
// check   reads the camera's trim saw status and its newest raw recording (read-only), measures where
//         the cut board ends sit over a few seconds of production, draws the saw, stops and cut ends,
//         and writes a record with the verdict. --from-record judges another saw (a proposed one)
//         against the same measured ends without reading Zira again.
// approve records the user's explicit OK of a passed check's picture.
// require is the gate: exit 0 only for an approved, passed, recent check of the same camera (and saw).
// Nothing is ever sent to the camera; files are written only under --out.
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Blocked, argValue, isMain, liveSession, route, runCli } from "./client.mjs";
import { ROUTES, chooseIdentity, collect, deviceBase, discover, loadLiveDevice, statusTopic, withIot } from "./remote.mjs";
import { RAW_VIDEO_ROUTES, confirmDownload, downloadRawVideos, listOrExplain, parseRawVideoName } from "./raw-videos.mjs";

const HELP = `Trimsaw saw-line check: is the camera's saw line on the saw? (a gate for every calibration)
node scripts/trimsaw-saw-line.mjs check --device-id ID [--identity ID] [--proposed-saw-px PX] [--saw-px PX]
    [--from DAY] [--to DAY] [--clip FILE] [--at 2] [--seconds 8] [--fps 4] [--search-px 15] [--tolerance-px 1]
    [--frame-size 320] [--resize CROP|BOX|STRETCH] [--windows 3] [--out DIR] [--confirm] [--profile prod|integ]
node scripts/trimsaw-saw-line.mjs check --status FILE --video FILE --data-source-id ID [same options]
node scripts/trimsaw-saw-line.mjs check --from-record FILE --proposed-saw-px PX [--out DIR]
node scripts/trimsaw-saw-line.mjs check ... --cut-ends-px PX   (only when detection is undetermined: read off the picture)
node scripts/trimsaw-saw-line.mjs approve --record FILE --words "the user's own words"
node scripts/trimsaw-saw-line.mjs require --record FILE --device-id ID [--saw-px PX | --status FILE] [--max-age-hours 72]

check reads the camera's trim saw status (applied stops, saw, side) and its newest raw recording from
Zira (read-only; --clip picks one), takes --seconds of frames, measures where the cut board ends sit and
compares them with the saw. Frames are first resized (the camera's ResizeMethod: CROP, BOX letterbox) and
rotated (analysisRotationDegrees) exactly as the camera builds its analysis frame, so the lines are drawn
and the ends measured in the camera's own frame px (--windows windows of the clip must agree within a frame px, else undetermined): the camera's current one, or --proposed-saw-px (the saw of a mapping,
a line-edit preview or a calibration preview). It writes record.json, overlay.png (red: the saw being
judged, magenta: the camera's current saw when another is judged, green: where the cut ends are,
yellow: the stops) and overlay-zoom.png under --out. Verdict pass within --tolerance-px frame px
(default 1, about 0.4 in. at 0.368 in/px), fail beyond it, undetermined when the ends could not be found.
approve records the user's OK of a passed check (their words, the picture's hash). require exits 0 only
for an approved pass of this camera, newer than --max-age-hours, whose judged saw matches --saw-px (or the
saw in --status) within 0.3 px; otherwise exit 4 with the reason. Nothing is sent to the camera.
JSON on stdout. Exit 0 done, 2 failed, 4 blocked (the JSON explains).`;

export const TOLERANCE_PX = 1;
export const SAME_SAW_PX = 0.3;
export const MAX_AGE_HOURS = 72;
export const RECORD_KIND = "trimsaw-saw-line-check";
export const FRAME_PX = 320;
const SEARCH_PX = 15;
const MIN_VOTES = 40, MIN_FRAMES = 3, MIN_GROUPS = 3;

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : null; };
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

// ---------- the camera's saw ----------

// The trim saw meta from any saved shape: camera.mjs status --save ({raw: {meta}}), remote.mjs status
// ({status: {trimsaw: {meta}}}), a retained message ({meta}) or the meta itself.
export function trimsawMetaOf(saved) {
  const m = saved?.raw?.meta ?? saved?.status?.trimsaw?.meta ?? saved?.trimsaw?.meta ?? saved?.meta ?? saved;
  return m && typeof m === "object" && !Array.isArray(m) && ("appliedStops" in m || "stopSide" in m || "flow" in m) ? m : null;
}

// "… saw 243.1 px …" in the undo entry's summary.
export function sawFromSummary(text) {
  const m = String(text ?? "").match(/saw\s*(?:at\s*)?(-?\d+(?:\.\d+)?)\s*px/i);
  return m ? Number(m[1]) : null;
}

// The saw and scale the applied stops imply, as Vision-App derives them: a least-squares fit of each
// stop's calibration value against its position, size = (saw - px) * scale for a LOW stop end (the
// saw past the stops at higher px), size = (px - saw) * scale for a HIGH one.
export function sawFromStops(stops) {
  const pts = (stops ?? []).map(s => ({ x: num(s.pos ?? s.positionPx), y: num(s.calibrationSize ?? s.calibration ?? s.jigSize ?? s.size) }))
    .filter(p => p.x !== null && p.y !== null);
  if (pts.length < 2) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (!sxx) return null;
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx, intercept = my - slope * mx;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0) / n);
  return { sawPx: round(-intercept / slope, 2), inPerPx: round(Math.abs(slope), 5), rms: round(rms, 3) };
}

export function axisOf(meta) {
  const side = String(meta?.stopSide ?? "").toUpperCase(), axis = String(meta?.axis ?? "").toUpperCase();
  if (["TOP", "BOTTOM"].includes(side) || /Y$/.test(axis)) return "y";
  if (["LEFT", "RIGHT"].includes(side) || /X$/.test(axis)) return "x";
  return null;
}

// Everything the check needs from the camera's status: the current saw (applied stops' fit, else the
// undo entry's "saw N px"), the stored blade line, a pending line edit's saw, the stops and the side.
export function cameraGeometry(meta) {
  if (!meta) throw new Blocked("no_status", "No trim saw status: the camera has not published one, or the file is not a saved status.");
  const stops = (Array.isArray(meta.appliedStops) ? meta.appliedStops : []).map(s => ({ px: num(s.pos), size: num(s.jigSize), calibration: num(s.calibrationSize) ?? num(s.jigSize) }))
    .filter(s => s.px !== null);
  const fit = sawFromStops(stops.map(s => ({ pos: s.px, calibrationSize: s.calibration })));
  const undo = sawFromSummary(meta.undo?.summary);
  const current = fit ? { px: fit.sawPx, source: "applied stops' fit" } : undo !== null ? { px: undo, source: "undo entry" } : null;
  const warnings = [];
  if (fit && undo !== null && Math.abs(fit.sawPx - undo) > 0.5)
    warnings.push({ code: "saw_sources_disagree", message: `The applied stops put the saw at ${fit.sawPx} px but the last change says saw ${undo} px.` });
  const blade = num(meta.bladeLine?.applied?.positionPx) ?? (meta.bladeLine?.status === "FOUND" ? num(meta.bladeLine?.positionPx) : null);
  const stopEnd = meta.stopEnd === "HIGH" || meta.stopEnd === "LOW" ? meta.stopEnd
    : ["BOTTOM", "RIGHT"].includes(String(meta.stopSide ?? "").toUpperCase()) ? "HIGH" : meta.stopSide ? "LOW" : null;
  return {
    axis: axisOf(meta), side: meta.stopSide ?? null, stopEnd, rotationDeg: num(meta.analysisRotationDegrees),
    current, inPerPx: fit?.inPerPx ?? null, fitRms: fit?.rms ?? null, undoSawPx: undo, bladeLinePx: blade,
    lineEditSawPx: num(meta.lineEdit?.sawPositionPx), stops, revision: typeof meta.appliedRevision === "string" ? meta.appliedRevision.slice(0, 64) : null,
    warnings,
  };
}

// ---------- frame <-> raw video ----------

// How the camera turns a decoded (orientation-normalised) video frame into its square analysis frame,
// exactly as Vision-App's TrimSawEdgeMapping / ImageProcessingUtility.renderCropResizeAndMask do it:
// ResizeMethod CROP centre-crops the square and fills the frame, BOX fits the whole frame inside it
// (letterbox, black bars), anything else stretches the whole frame; then the picture is rotated
// `rotation` degrees clockwise about the frame centre (analysisRotationDegrees). On a 270° camera
// recorded 640x360 with a -90° display matrix the decoded frame is 360x640; BOX into 320 and rotate 270
// gives analysis y = 250 - u/2: the stops and saw run along the chains, not across them.
export function analysisMapping({ width, height, frameSize, resize = "CROP", rotation = 0 }) {
  if (!(width > 0 && height > 0 && frameSize > 0)) throw new Error("Invalid frame for the analysis mapping");
  const rot = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360, method = String(resize ?? "").toUpperCase();
  const crop = method === "CROP", box = method === "BOX", side = Math.min(width, height);
  const sL = crop ? Math.trunc((width - side) / 2) : 0, sT = crop ? Math.trunc((height - side) / 2) : 0;
  const sR = crop ? sL + side : width, sB = crop ? sT + side : height;
  const scale = Math.min(frameSize / width, frameSize / height);
  const drawW = box ? Math.round(width * scale) : frameSize, drawH = box ? Math.round(height * scale) : frameSize;
  const dL = Math.trunc((frameSize - drawW) / 2), dT = Math.trunc((frameSize - drawH) / 2);
  const kx = (sR - sL) / drawW, ky = (sB - sT) / drawH, centre = frameSize / 2;
  const exact = v => (Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);
  const ang = -rot * Math.PI / 180, cos = exact(Math.cos(ang)), sin = exact(Math.sin(ang));
  return {
    width, height, frameSize, resize: crop ? "CROP" : box ? "BOX" : "STRETCH", rotation: rot,
    sourcePerFramePx: Math.min(kx, ky),
    // Analysis-frame point -> decoded video pixel coordinates.
    toSource(x, y) {
      const dx = x - centre, dy = y - centre;
      const ux = centre + cos * dx - sin * dy, uy = centre + sin * dx + cos * dy;
      return [sL + (ux - dL) * kx, sT + (uy - dT) * ky];
    },
  };
}

// Renders decoded frames (gray, or rgb with channels 3) into the analysis frame at `k` output px per
// frame px, with bilinear sampling; outside the source is black, like the camera's letterbox.
export function analysisRenderer(mapping, k = Math.max(1, mapping.sourcePerFramePx)) {
  const size = Math.max(1, Math.round(mapping.frameSize * k)), kk = size / mapping.frameSize;
  const { width: W, height: H } = mapping, n = size * size;
  const idx = new Int32Array(n * 4), wt = new Float32Array(n * 4);
  for (let Y = 0; Y < size; Y++) for (let X = 0; X < size; X++) {
    const [u, v] = mapping.toSource((X + 0.5) / kk, (Y + 0.5) / kk), o = (Y * size + X) * 4;
    const fx = u - 0.5, fy = v - 0.5;
    if (!(fx > -0.5 && fy > -0.5 && fx < W - 0.5 && fy < H - 0.5)) { idx.fill(-1, o, o + 4); continue; }
    const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy)), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
    idx[o] = y0 * W + x0; idx[o + 1] = y0 * W + x1; idx[o + 2] = y1 * W + x0; idx[o + 3] = y1 * W + x1;
    wt[o] = (1 - ax) * (1 - ay); wt[o + 1] = ax * (1 - ay); wt[o + 2] = (1 - ax) * ay; wt[o + 3] = ax * ay;
  }
  const render = (src, channels = 1) => {
    const out = new Uint8Array(n * channels);
    for (let p = 0; p < n; p++) {
      const o = p * 4;
      if (idx[o] < 0) continue;
      for (let ch = 0; ch < channels; ch++) {
        const v = src[idx[o] * channels + ch] * wt[o] + src[idx[o + 1] * channels + ch] * wt[o + 1]
          + src[idx[o + 2] * channels + ch] * wt[o + 2] + src[idx[o + 3] * channels + ch] * wt[o + 3];
        out[p * channels + ch] = Math.round(v);
      }
    }
    return out;
  };
  return { size, scale: kk, render };
}

// Positions along the board axis in the picture the lines are drawn on. A picture rendered in the
// analysis frame (`scale` px per frame px, every current record) is plain scaling. Older records drew on
// the decoded video: a screen-width square of side FrameSize centred on the image, filling its height.
export function frameToRaw(p, { axis, frameSize, width, height, scale }) {
  if (scale) return p * scale;
  return axis === "x" ? (p - frameSize / 2) * height / frameSize + width / 2 : p * height / frameSize;
}
export function rawToFrame(a, { axis, frameSize, width, height, scale }) {
  if (scale) return a / scale;
  return axis === "x" ? (a - width / 2) * frameSize / height + frameSize / 2 : a * frameSize / height;
}

// ---------- where the cut ends are ----------

// Gray frames (Uint8Array, width x height) over a few seconds of production. Boards move across the
// view, so the per-pixel median is the empty machine; a board is where a frame differs from it. Each
// column of each frame votes where a board run ends going from the stops toward the saw (`dir` +1 to
// higher px, -1 to lower), at the half-contrast point between the board and the background. Boards cut
// at the saw all end on one line, so the votes pile up there; uncut stock ends spread beyond it.
export function detectCutEnds(frames, { width, height, axis, sawRaw, dir, searchRaw, minRunRaw, threshold = 28, groupRaw = 16, pxPerFrame = 1, span = null }) {
  if (!frames.length) return { found: false, why: "no frames" };
  const along = axis === "x" ? width : height, across = axis === "x" ? height : width;
  const at = axis === "x" ? (f, a, c) => f[c * width + a] : (f, a, c) => f[a * width + c];
  const lo = Math.max(1, Math.floor(sawRaw - searchRaw - minRunRaw - 3)), hi = Math.min(along - 3, Math.ceil(sawRaw + searchRaw + 3));
  const [c0, c1] = span ?? [0, across];
  if (hi - lo < minRunRaw + 4) return { found: false, why: "the saw is too close to the edge of the picture" };
  const rows = hi - lo + 1, cols = c1 - c0, F = frames.length;
  const bg = new Uint8Array(rows * cols), buf = new Uint8Array(F);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    for (let f = 0; f < F; f++) buf[f] = at(frames[f], lo + r, c0 + c);
    buf.sort(); bg[r * cols + c] = buf[F >> 1];
  }
  const votes = [];
  const d = new Float32Array(rows);
  for (let f = 0; f < F; f++) {
    const fr = frames[f];
    for (let c = 1; c < cols - 1; c++) {
      for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let k = -1; k <= 1; k++) s += Math.abs(at(fr, lo + r, c0 + c + k) - bg[r * cols + c + k]);
        d[r] = s / 3;
      }
      let run = 0;
      for (let i = 0; i < rows; i++) {
        const r = dir > 0 ? i : rows - 1 - i;
        if (d[r] > threshold) { run++; continue; }
        // r is the first background pixel after a run of board pixels.
        if (run >= minRunRaw) {
          const inside = r - dir, next = r + dir;
          const outsideOk = next < 0 || next >= rows || d[next] <= threshold;
          if (outsideOk) {
            const lvlIn = (d[inside] + d[inside - dir] + (d[inside - 2 * dir] ?? d[inside - dir])) / 3, lvlOut = d[r];
            const half = (lvlIn + lvlOut) / 2;
            // Crossing between the last board pixel (centre inside+0.5) and this one, at the half level.
            const frac = d[inside] - lvlOut > 0 ? Math.min(1, Math.max(0, (d[inside] - half) / (d[inside] - lvlOut))) : 0.5;
            const edge = lo + inside + 0.5 + dir * frac;
            if (Math.abs(edge - sawRaw) <= searchRaw) votes.push({ a: edge, c: c0 + c, f });
          }
        }
        run = 0;
      }
    }
  }
  if (votes.length < MIN_VOTES) return { found: false, why: `only ${votes.length} board-end observations near the saw (need ${MIN_VOTES}): too few boards ran, or they do not stand out from the machine`, votes: votes.length };
  // The densest place, within one frame px, then the median of the votes within 1.5 frame px of it.
  const bin = pxPerFrame / 4, kernel = Math.max(1, Math.round(pxPerFrame / bin));
  const base = sawRaw - searchRaw, n = Math.ceil(2 * searchRaw / bin) + 1, hist = new Float64Array(n);
  for (const v of votes) hist[Math.min(n - 1, Math.max(0, Math.floor((v.a - base) / bin)))]++;
  let best = 0, bestAt = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -kernel; k <= kernel; k++) s += hist[i + k] ?? 0;
    if (s > best) { best = s; bestAt = i; }
  }
  const mode = base + (bestAt + 0.5) * bin, near = votes.filter(v => Math.abs(v.a - mode) <= 1.5 * pxPerFrame);
  const framesUsed = new Set(near.map(v => v.f)).size;
  // Per group of columns, the median end: a tilted saw (frame rotation) shows as a slope.
  const groups = new Map();
  for (const v of near) { const g = Math.floor(v.c / groupRaw); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(v.a); }
  const points = [...groups].filter(([, a]) => a.length >= 3).map(([g, a]) => ({ c: (g + 0.5) * groupRaw, a: median(a), n: a.length }));
  const centre = across / 2;
  let tilt = null, atCentre = median(near.map(v => v.a));
  if (points.length >= 4 && Math.max(...points.map(p => p.c)) - Math.min(...points.map(p => p.c)) >= across / 4) {
    let fitted = linear(points);
    const kept = points.filter(p => Math.abs(p.a - (fitted.b + fitted.m * p.c)) <= pxPerFrame);
    if (kept.length >= 4) fitted = linear(kept);
    tilt = fitted.m; atCentre = fitted.b + fitted.m * centre;
  }
  const spread = (quantile(near.map(v => v.a), 0.9) - quantile(near.map(v => v.a), 0.1)) / pxPerFrame;
  const weak = near.length < MIN_VOTES ? `only ${near.length} board ends line up` : framesUsed < MIN_FRAMES ? `board ends line up in only ${framesUsed} frames`
    : points.length < MIN_GROUPS ? "board ends line up in too few places across the picture" : null;
  return {
    found: !weak, ...(weak ? { why: weak } : {}), rawPx: round(atCentre, 2), modeRawPx: round(mode, 2), votes: votes.length, near: near.length,
    concentration: round(near.length / votes.length, 2), framesUsed, groups: points.length, spreadFramePx: round(spread, 2),
    tiltPerPx: tilt === null ? null : round(tilt, 4), points: points.map(p => ({ c: round(p.c, 1), a: round(p.a, 2), n: p.n })),
    bestFrame: [...near.reduce((m, v) => m.set(v.f, (m.get(v.f) ?? 0) + 1), new Map())].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0,
  };
}

// The windows must agree: at least `need` found the ends, all within one frame px of their median.
export function combineWindows(perWindow, { pxPerFrame, need = 2 }) {
  const found = perWindow.filter(d => d.found);
  const windows = perWindow.map(d => ({ at: d.at, ...(d.found ? { px: d.rawPx } : { why: d.why }) }));
  if (found.length < need) return { found: false, why: found.length ? `the board ends were found in only ${found.length} of ${perWindow.length} windows of the clip` : perWindow[0]?.why ?? "no board ends found", windows, votes: perWindow.reduce((n, d) => n + (d.votes ?? 0), 0) };
  const mid = median(found.map(d => d.rawPx)), worst = Math.max(...found.map(d => Math.abs(d.rawPx - mid))) / pxPerFrame;
  if (worst * 2 > TOLERANCE_PX) return { found: false, why: `windows of the clip disagree on where boards end (${found.map(d => d.rawPx).sort((a, b) => a - b).map(v => round(v / pxPerFrame, 1)).join(", ")} frame px): boards there do not end on one line. Read the cut ends off overlay-zoom.png's ruler and rerun with --cut-ends-px, or record a clip with steady production`, windows, votes: found.reduce((n, d) => n + d.votes, 0) };
  const first = found.reduce((b, d) => (d.near > b.near ? d : b));
  return { ...first, rawPx: round(median(found.map(d => d.rawPx)), 2), votes: found.reduce((n, d) => n + d.votes, 0), near: found.reduce((n, d) => n + d.near, 0),
    framesUsed: found.reduce((n, d) => n + d.framesUsed, 0), window: perWindow.indexOf(first), windows };
}

function linear(points) {
  const n = points.length, mx = points.reduce((s, p) => s + p.c, 0) / n, my = points.reduce((s, p) => s + p.a, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.c - mx) ** 2, 0) || 1;
  const m = points.reduce((s, p) => s + (p.c - mx) * (p.a - my), 0) / sxx;
  return { m, b: my - m * mx };
}

// ---------- verdict ----------

export function judge({ judgedPx, cutEndsPx, inPerPx, tolerancePx = TOLERANCE_PX }) {
  if (cutEndsPx === null || cutEndsPx === undefined) return { verdict: "undetermined", gapPx: null, gapIn: null };
  const gap = cutEndsPx - judgedPx;
  return { verdict: Math.abs(gap) <= tolerancePx ? "pass" : "fail", gapPx: round(gap, 2), gapIn: inPerPx ? round(Math.abs(gap) * inPerPx, 2) : null };
}

function verdictText(r) {
  const saw = `${r.saw.judged.source === "proposed" ? "The proposed saw" : "The camera's saw line"} at ${r.saw.judged.px} px`;
  if (r.verdict === "undetermined") return `${saw} could not be checked: ${r.cutEnds?.why ?? "the cut ends were not found"}.`;
  const where = `the cut board ends sit at ${r.cutEnds.px} px`;
  const off = `${Math.abs(r.gapPx)} px${r.gapIn !== null ? ` (${r.gapIn} in.)` : ""} ${r.gapPx > 0 ? "beyond" : "short of"} it`;
  return r.verdict === "pass"
    ? `${saw} is on the saw: ${where}, ${off}, within ${r.tolerancePx} px. Show overlay.png and ask the user to confirm the red line sits on the cut ends before anything is applied or reported.`
    : `${saw} is NOT on the saw: ${where}, ${off}. Every length reads about ${r.gapIn ?? "?"} in. ${(r.gapPx > 0) === (r.stopEnd !== "HIGH") ? "short" : "long"}. Stop: nothing may be applied, assigned, recorded or reported as passed. Relabel or re-collect so the stops' saw lands on the cut ends, then check that saw (--from-record with --proposed-saw-px).`;
}

// ---------- the gate ----------

// Throws Blocked("saw_line_unconfirmed") unless `record` is an approved pass for this camera, recent,
// and (when given) for this saw. Every Apply, Edit stops, size assignment, tracker entry and PASS report
// calls it first.
export function requireSawLine(record, { deviceId, sawPx = null, now = Date.now(), maxAgeHours = MAX_AGE_HOURS, what = "this step" } = {}) {
  const reasons = [];
  if (!record) reasons.push("no saw-line check was given (--saw-line FILE: the record.json of trimsaw-saw-line check)");
  else {
    if (record.kind !== RECORD_KIND || record.version !== 1) reasons.push("the file is not a saw-line check record");
    if (deviceId !== undefined && deviceId !== null && String(record.dataSource?.id) !== String(deviceId))
      reasons.push(`the check is for data source ${record.dataSource?.id}, not ${deviceId}`);
    if (record.verdict !== "pass") reasons.push(record.verdict === "fail"
      ? `the check failed: the saw at ${record.saw?.judged?.px} px is ${Math.abs(record.gapPx)} px (${record.gapIn} in.) off the cut ends at ${record.cutEnds?.px} px`
      : "the check could not find the cut ends (undetermined)");
    if (!record.approval?.words) reasons.push("the user has not approved the saw-line picture (approve --record FILE --words …)");
    else if (record.approval.overlaySha256 !== record.images?.overlaySha256) reasons.push("the approval is for another picture");
    const age = (now - Date.parse(record.checkedAt ?? "")) / 3600000;
    if (!(age >= 0)) reasons.push("the check has no valid time");
    else if (age > maxAgeHours) reasons.push(`the check is ${Math.round(age)} h old (limit ${maxAgeHours} h): the camera may have moved since; check again`);
    if (sawPx !== null && Number.isFinite(Number(sawPx)) && record.saw?.judged && Math.abs(Number(sawPx) - record.saw.judged.px) > SAME_SAW_PX)
      reasons.push(`the check judged a saw at ${record.saw.judged.px} px, but ${what} uses a saw at ${round(Number(sawPx), 2)} px; check that saw (--from-record --proposed-saw-px ${round(Number(sawPx), 2)})`);
  }
  if (reasons.length)
    throw new Blocked("saw_line_unconfirmed", `Saw-line gate: ${what} is blocked until the camera's saw line is shown on the cut board ends and the user approves it. ${reasons.join("; ")}.`,
      { reasons, next: "Run trimsaw-saw-line check, show overlay.png, get the user's explicit OK that the saw line sits on the saw, run approve, then retry." });
  return { ok: true, dataSourceId: String(record.dataSource.id), sawPx: record.saw.judged.px, cutEndsPx: record.cutEnds.px, gapPx: record.gapPx,
    checkedAt: record.checkedAt, approvedAt: record.approval.at };
}

// The gate's answer without throwing, for previews.
export function sawLineState(record, opts = {}) {
  try { return requireSawLine(record, opts); } catch (error) {
    if (error instanceof Blocked) return { ok: false, reasons: error.details.reasons, message: error.message, next: error.details.next };
    throw error;
  }
}

export async function readRecord(file) {
  if (!file) return null;
  let record;
  try { record = JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new Error(`Cannot read the saw-line check ${file}: ${error.message}`); }
  return record;
}

// ---------- drawing ----------

const FONT = { // 5x7, rows top to bottom, 5 bits each
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12], ".": [0, 0, 0, 0, 0, 12, 12], " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 31, 0, 0, 0], A: [14, 17, 17, 31, 17, 17, 17], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
};
export const COLORS = { saw: [255, 40, 40], current: [255, 0, 255], cut: [40, 230, 40], stop: [255, 220, 0] };

export class Canvas {
  constructor(width, height, rgb) { this.width = width; this.height = height; this.rgb = rgb ?? new Uint8Array(width * height * 3); }
  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3; this.rgb[i] = r; this.rgb[i + 1] = g; this.rgb[i + 2] = b;
  }
  // A line across the picture at `a` along the board axis, `aAt(c)` when tilted.
  across(axis, aAt, color, thick = 2, dash = 0) {
    const n = axis === "x" ? this.height : this.width;
    for (let c = 0; c < n; c++) {
      if (dash && Math.floor(c / dash) % 2) continue;
      const a = aAt(c);
      for (let t = 0; t < thick; t++) {
        const p = Math.round(a - thick / 2 + t);
        axis === "x" ? this.set(p, c, color) : this.set(c, p, color);
      }
    }
  }
  text(x, y, s, color, scale = 2) {
    const chars = String(s).toUpperCase().split("").filter(ch => FONT[ch]);
    const w = chars.length * 6 * scale + scale, h = 9 * scale;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.set(x + xx, y + yy, [0, 0, 0]);
    chars.forEach((ch, i) => FONT[ch].forEach((row, ry) => { for (let rx = 0; rx < 5; rx++) if (row & (16 >> rx))
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.set(x + scale + (i * 6 + rx) * scale + sx, y + scale + ry * scale + sy, color); }));
    return w;
  }
  crop(x0, y0, w, h, k) {
    const out = new Canvas(w * k, h * k);
    for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
      const sx = Math.min(this.width - 1, x0 + Math.floor(x / k)), sy = Math.min(this.height - 1, y0 + Math.floor(y / k)), i = (sy * this.width + sx) * 3;
      out.rgb.set(this.rgb.subarray(i, i + 3), (y * out.width + x) * 3);
    }
    return out;
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function encodePng({ width, height, rgb }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("Not a PNG image");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The judged saw (red), the camera's current saw when another is judged (magenta, dashed), the measured
// cut ends (green, following any tilt) and the stops (yellow, labelled with their sizes).
export function drawOverlay(frameRgb, r) {
  const { width, height } = r.frames, g = { axis: r.axis, frameSize: r.frameSize, width, height, scale: r.frames.scale };
  const canvas = new Canvas(width, height, Uint8Array.from(frameRgb));
  const scale = Math.max(2, Math.round(Math.min(width, height) / 300));
  const label = (a, s, color, slot) => {
    const along = Math.round(a) + (slot % 2 ? 4 : -9 * scale - 4);
    r.axis === "x" ? canvas.text(along, 8 + slot * 12 * scale, s, color, scale)
      : canvas.text(8 + slot * Math.min(70 * scale, Math.floor((width - 40 * scale) / 6)), along, s, color, scale);
  };
  r.stops.forEach((s, i) => { const a = frameToRaw(s.px, g); canvas.across(r.axis, () => a, COLORS.stop, 1, 6); if (s.size !== null) label(a, String(s.size), COLORS.stop, 4 + (i % 2)); });
  if (r.cutEnds?.px !== null && r.cutEnds?.px !== undefined) {
    const a0 = frameToRaw(r.cutEnds.px, g), tilt = r.cutEnds.tiltPerPx ?? 0, centre = (r.axis === "x" ? height : width) / 2;
    canvas.across(r.axis, c => a0 + tilt * (c - centre), COLORS.cut, Math.max(2, scale));
    label(a0, `CUT ENDS ${r.cutEnds.px}`, COLORS.cut, 1);
  }
  if (r.saw.current && r.saw.judged.source === "proposed") {
    const a = frameToRaw(r.saw.current.px, g); canvas.across(r.axis, () => a, COLORS.current, Math.max(2, scale), 10); label(a, `NOW ${r.saw.current.px}`, COLORS.current, 2);
  }
  const a = frameToRaw(r.saw.judged.px, g);
  canvas.across(r.axis, () => a, COLORS.saw, Math.max(2, scale));
  label(a, `${r.saw.judged.source === "proposed" ? "NEW SAW" : "SAW"} ${r.saw.judged.px}`, COLORS.saw, 0);
  // A close-up of the band around the saw and the cut ends, lines only (labels would hide the board
  // ends), with a ruler in frame px so the ends can be read off by eye, and a legend above.
  const clean = new Canvas(width, height, Uint8Array.from(frameRgb));
  const marks = [[r.saw.judged.px, COLORS.saw], ...(r.saw.current && r.saw.judged.source === "proposed" ? [[r.saw.current.px, COLORS.current]] : []),
    ...(Number.isFinite(r.cutEnds?.px) ? [[r.cutEnds.px, COLORS.cut]] : [])];
  for (const [px, color] of marks) { const a = frameToRaw(px, g); clean.across(r.axis, () => a, color, 1); }
  const lines = marks.map(([px]) => frameToRaw(px, g));
  const along = r.axis === "x" ? width : height, pad = 12 * height / r.frameSize;
  const lo = Math.max(0, Math.floor(Math.min(...lines) - pad)), hi = Math.min(along - 1, Math.ceil(Math.max(...lines) + pad));
  const k = Math.max(2, Math.min(6, Math.floor(1800 / (r.axis === "x" ? height : width))));
  const band = r.axis === "x" ? clean.crop(lo, 0, hi - lo + 1, height, k) : clean.crop(0, lo, width, hi - lo + 1, k);
  for (let p = Math.ceil(rawToFrame(lo, g)); frameToRaw(p, g) <= hi; p++) {
    const at = Math.round((frameToRaw(p, g) - lo) * k), len = p % 5 ? 10 : 22;
    for (let t = 0; t < len; t++) for (let w = 0; w < 2; w++) r.axis === "x" ? band.set(at + w, t, [255, 255, 255]) : band.set(t, at + w, [255, 255, 255]);
    if (p % 5 === 0) r.axis === "x" ? band.text(at + 3, 24, String(p), [255, 255, 255], 2) : band.text(26, at - 9, String(p), [255, 255, 255], 2);
  }
  const head = 22, zoom = new Canvas(band.width, band.height + head);
  zoom.rgb.set(band.rgb, band.width * head * 3);
  let x = 4;
  x += zoom.text(x, 2, `SAW ${r.saw.judged.px}`, COLORS.saw, 2) + 8;
  if (marks.length > 1 && r.saw.judged.source === "proposed") x += zoom.text(x, 2, `NOW ${r.saw.current.px}`, COLORS.current, 2) + 8;
  if (Number.isFinite(r.cutEnds?.px)) zoom.text(x, 2, `CUT ENDS ${r.cutEnds.px}`, COLORS.cut, 2);
  return { overlay: encodePng(canvas), zoom: encodePng(zoom) };
}

// ---------- reading video ----------

function ffmpeg(args, { binary = false, run = spawnSync } = {}) {
  const r = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { encoding: binary ? "buffer" : "utf8", maxBuffer: 1 << 30, shell: false });
  if (r.error?.code === "ENOENT") throw new Blocked("ffmpeg_missing", "ffmpeg is not installed, so no frames could be read. Ask the user before installing it (macOS: brew install ffmpeg; Windows: winget install Gyan.FFmpeg).");
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr ?? "").trim().slice(0, 300)}`);
  return r.stdout;
}

export function readFrames(video, { at = 2, seconds = 8, fps = 4, run } = {}) {
  const png = ffmpeg(["-ss", String(at), "-i", video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { binary: true, run });
  const { width, height } = pngSize(png);
  const gray = ffmpeg(["-ss", String(at), "-t", String(seconds), "-i", video, "-vf", `fps=${fps}`, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], { binary: true, run });
  const size = width * height, frames = [];
  for (let o = 0; o + size <= gray.length; o += size) frames.push(new Uint8Array(gray.buffer, gray.byteOffset + o, size));
  return { width, height, frames };
}

export function readColorFrame(video, at, { width, height, run } = {}) {
  const rgb = ffmpeg(["-ss", String(at), "-i", video, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { binary: true, run });
  if (rgb.length < width * height * 3) throw new Error("ffmpeg returned a short frame");
  return new Uint8Array(rgb.buffer, rgb.byteOffset, width * height * 3);
}

// ---------- the check ----------

const home = () => process.env.ZIRA_TRIMSAW_HOME ?? path.join(os.homedir(), ".cache", "zira", "trimsaw-saw-line");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
async function writePrivate(file, data) { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, data, { mode: 0o600 }); }

// Builds the record from measured cut ends (or a manual reading) and the saw being judged, and draws it.
export async function finishCheck({ base, geometry, judged, cutEnds, frameRgb, out, tolerancePx = TOLERANCE_PX, now = new Date() }) {
  const result = judge({ judgedPx: judged.px, cutEndsPx: cutEnds?.found === false ? null : cutEnds?.px, inPerPx: geometry.inPerPx, tolerancePx });
  const record = {
    kind: RECORD_KIND, version: 1, checkedAt: now.toISOString(), ...base,
    axis: geometry.axis, side: geometry.side, stopEnd: geometry.stopEnd, rotationDeg: geometry.rotationDeg, revision: geometry.revision,
    inPerPx: geometry.inPerPx, stops: geometry.stops.map(s => ({ size: s.size, px: s.px })),
    saw: { judged, current: geometry.current, ...(geometry.undoSawPx !== null ? { undoSummaryPx: geometry.undoSawPx } : {}),
      ...(geometry.bladeLinePx !== null ? { bladeLinePx: geometry.bladeLinePx } : {}), ...(geometry.lineEditSawPx !== null ? { lineEditPx: geometry.lineEditSawPx } : {}) },
    cutEnds, tolerancePx, tolerancePxIn: geometry.inPerPx ? round(tolerancePx * geometry.inPerPx, 2) : null,
    verdict: result.verdict, gapPx: result.gapPx, gapIn: result.gapIn,
    warnings: [...geometry.warnings], approval: null,
  };
  if (geometry.bladeLinePx !== null && cutEnds?.px !== null && cutEnds?.px !== undefined && Math.abs(geometry.bladeLinePx - cutEnds.px) > tolerancePx)
    record.warnings.push({ code: "blade_line_off", message: `The stored blade line at ${geometry.bladeLinePx} px is ${round(Math.abs(geometry.bladeLinePx - cutEnds.px), 2)} px from the cut ends: pre-cut lengths are off by about ${geometry.inPerPx ? round(Math.abs(geometry.bladeLinePx - cutEnds.px) * geometry.inPerPx, 2) : "?"} in.` });
  if (Math.abs(geometry.rotationDeg ?? 0) >= 0.5)
    record.warnings.push(record.frames?.space === "analysis"
      ? { code: "rotated_frame", message: `The camera rotates its analysis frame ${geometry.rotationDeg}°: the frames were ${record.frames.resize === "BOX" ? "letterboxed (BOX)" : record.frames.resize === "CROP" ? "centre-cropped (CROP)" : "stretched"} and rotated the same way before the lines were drawn and the cut ends measured.` }
      : { code: "rotated_frame_not_applied", message: `The camera rotates its analysis frame ${geometry.rotationDeg}°, but this record's picture is the unrotated video, so its lines and cut ends are not valid. Run check again on the clip.` });
  if (record.frames?.resizeAssumed)
    record.warnings.push({ code: "resize_assumed", message: `The camera's ResizeMethod is unknown, so ${record.frames.resize} was assumed. If the picture does not match the live view, pass --resize BOX or CROP.` });
  if (record.frames?.perspective)
    record.warnings.push({ code: "perspective_not_applied", message: "The camera has a trim saw perspective correction, which this check does not reproduce: compare the picture with the live view before trusting it." });
  const { overlay, zoom } = drawOverlay(frameRgb, record);
  await writePrivate(path.join(out, "overlay.png"), overlay);
  await writePrivate(path.join(out, "overlay-zoom.png"), zoom);
  record.images = { overlay: path.join(out, "overlay.png"), zoom: path.join(out, "overlay-zoom.png"), overlaySha256: sha256(overlay) };
  record.message = verdictText(record);
  await writePrivate(path.join(out, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, record: path.join(out, "record.json"),
    next: record.verdict === "pass"
      ? "Show both pictures to the user and ask: does the red saw line sit on the cut board ends (green)? Only on their explicit yes run approve --record with their words."
      : record.verdict === "fail" ? "Show the pictures and explain the gap. Do not apply, assign, record or report anything as passed until a saw that passes is approved."
        : "Show the pictures. Collect a clip with production running, or read the cut ends off the picture and rerun with --cut-ends-px." };
}

async function liveStatus(scope, ds, identity, seconds = 8) {
  return withIot(scope, ds, async client => {
    const camera = chooseIdentity(identity ? [] : await discover(client, deviceBase(ds)), identity);
    const topic = statusTopic(ds, camera, "trimsaw");
    const seen = await collect(client, [topic], seconds * 1000, { done: s => s.some(m => m.topic === topic) });
    return { camera, message: seen.filter(m => m.topic === topic && m.json).at(-1)?.json ?? null };
  });
}

export async function check(o, deps = {}) {
  const tolerancePx = o["tolerance-px"] === undefined ? TOLERANCE_PX : Number(o["tolerance-px"]);
  if (!(tolerancePx > 0 && tolerancePx <= 5)) throw new Error("--tolerance-px must be above 0 and at most 5");
  const proposed = o["proposed-saw-px"] === undefined ? null : Number(o["proposed-saw-px"]);
  if (proposed !== null && !Number.isFinite(proposed)) throw new Error("--proposed-saw-px must be a number");
  const manual = o["cut-ends-px"] === undefined ? null : Number(o["cut-ends-px"]);
  const out = path.resolve(o.out ?? path.join(home(), `${o["device-id"] ?? o["data-source-id"] ?? "record"}-${stamp()}`));

  if (o["from-record"]) {
    // Another saw against the same measured ends and frame: no new reading of Zira.
    const prior = await readRecord(o["from-record"]);
    if (prior?.kind !== RECORD_KIND) throw new Error(`${o["from-record"]} is not a saw-line check record`);
    if (proposed === null && manual === null) throw new Error("--from-record needs --proposed-saw-px (or --cut-ends-px)");
    const frameRgb = new Uint8Array(await readFile(path.join(path.dirname(path.resolve(o["from-record"])), "frame.rgb")));
    const geometry = { axis: prior.axis, side: prior.side, stopEnd: prior.stopEnd, rotationDeg: prior.rotationDeg, revision: prior.revision, inPerPx: prior.inPerPx,
      stops: prior.stops, current: prior.saw.current, undoSawPx: prior.saw.undoSummaryPx ?? null, bladeLinePx: prior.saw.bladeLinePx ?? null,
      lineEditSawPx: prior.saw.lineEditPx ?? null, warnings: (prior.warnings ?? []).filter(w => w.code === "saw_sources_disagree") };
    const cutEnds = manual !== null ? { found: true, px: round(manual, 2), source: "manual", note: "read off the picture by the assistant; the user's approval of the picture is what counts" } : prior.cutEnds;
    const judged = proposed !== null ? { px: round(proposed, 2), source: "proposed" } : prior.saw.judged;
    if (path.resolve(out) !== path.dirname(path.resolve(o["from-record"]))) await writePrivate(path.join(out, "frame.rgb"), frameRgb);
    const { dataSource, camera, clip, frames, frameSize, profile } = prior;
    return finishCheck({ base: { profile, dataSource, camera, clip, frames, frameSize, fromRecord: path.resolve(o["from-record"]) }, geometry, judged, cutEnds, frameRgb, out, tolerancePx, now: deps.now?.() });
  }

  const at = o.at === undefined ? 2 : Number(o.at), seconds = o.seconds === undefined ? 8 : Number(o.seconds), fps = o.fps === undefined ? 4 : Number(o.fps);
  if (!(at >= 0 && at <= 3600)) throw new Error("--at must be 0 to 3600 seconds");
  if (!(seconds >= 2 && seconds <= 30)) throw new Error("--seconds must be 2 to 30");
  if (!(fps >= 1 && fps <= 10)) throw new Error("--fps must be 1 to 10");
  let meta, dataSource, camera = o.identity ?? null, video, clip = null, profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod", frameSize = o["frame-size"] ? Number(o["frame-size"]) : null;
  let resize = o.resize ? String(o.resize).toUpperCase() : null, perspective = false;
  if (resize !== null && !["CROP", "BOX", "STRETCH"].includes(resize)) throw new Error("--resize must be CROP, BOX or STRETCH");
  const fromSettings = settings => {
    if (!settings || typeof settings !== "object") return;
    if (frameSize === null) frameSize = num(settings.FrameSize);
    if (resize === null && typeof settings.ResizeMethod === "string" && settings.ResizeMethod.trim()) resize = settings.ResizeMethod.trim().toUpperCase();
    perspective = typeof settings.TrimSawPerspectiveV1 === "string" && settings.TrimSawPerspectiveV1.trim() !== "";
  };
  if (o.status || o.video) {
    if (!o.status || !o.video) throw new Error("Offline checks need both --status FILE and --video FILE");
    const saved = JSON.parse(await readFile(o.status, "utf8"));
    meta = trimsawMetaOf(saved);
    const id = o["data-source-id"] ?? saved.dataSource?.id;
    if (!id) throw new Error("--data-source-id is required with --status and --video");
    dataSource = { id: String(id), name: saved.dataSource?.name ?? null };
    camera = camera ?? saved.camera ?? null;
    fromSettings(saved.settings ?? saved.cv?.settings);
    video = path.resolve(o.video);
    clip = { file: path.basename(video), recordedAtLocal: parseRawVideoName(video)?.recordedAtLocal ?? null, local: true };
  } else {
    if (!o["device-id"]) throw new Error("--device-id is required (or --status and --video, or --from-record)");
    const call = deps.call ?? await liveSession(profile, { allow: [...ROUTES, ...RAW_VIDEO_ROUTES] });
    const ds = await loadLiveDevice(call, o["device-id"]);
    const live = await liveStatus({ profile, call, ...(deps.connectIot ? { connectIot: deps.connectIot } : {}) }, ds, o.identity);
    meta = trimsawMetaOf(live.message);
    camera = live.camera;
    dataSource = { id: ds.id, name: ds.name, site: ds.site?.name ?? null };
    fromSettings((await call("GET", route("/devices/all", { meterIds: ds.id, expand: "true" }))).data?.[0]?.cv?.settings);
    const listed = await listOrExplain(call, ds.id, { from: o.from, to: o.to, limit: 50 }, { profile });
    const raws = listed.videos.filter(v => parseRawVideoName(v.file)).sort((a, b) => parseRawVideoName(b.file).recordedAtLocal.localeCompare(parseRawVideoName(a.file).recordedAtLocal));
    const chosen = o.clip ? listed.videos.find(v => v.file === o.clip || v.name === o.clip) : raws[0];
    if (!chosen) throw new Blocked("no_recording", o.clip ? `${o.clip} is not among the listed raw recordings.` : "Zira lists no raw recordings for this camera in that window. Record a few minutes while boards are cut (remote-control, with the user's approval), or widen --from/--to.");
    confirmDownload(listed.videos, [chosen.file], !!o.confirm);
    await downloadRawVideos(listed.videos, [chosen.file], out, { fetchImpl: deps.fetchImpl, relist: async () => (await listOrExplain(call, ds.id, { from: o.from, to: o.to, limit: 50 })).videos });
    video = path.join(out, path.basename(chosen.file));
    clip = { file: chosen.file, recordedAtLocal: parseRawVideoName(chosen.file)?.recordedAtLocal ?? null };
  }
  frameSize = frameSize ?? FRAME_PX;
  const geometry = cameraGeometry(meta);
  if (!geometry.axis) throw new Blocked("no_side", "The camera has no stop side, so the board axis is unknown. Collect sets it.");
  const sawOverride = o["saw-px"] === undefined ? null : Number(o["saw-px"]);
  if (sawOverride !== null) geometry.current = { px: round(sawOverride, 2), source: "given (--saw-px)" };
  if (!geometry.current) throw new Blocked("no_saw", "The camera's status gives no saw position (fewer than two applied stops and no undo entry). Pass --saw-px from the panel, or --proposed-saw-px.");
  const judged = proposed !== null ? { px: round(proposed, 2), source: "proposed" } : { px: geometry.current.px, source: geometry.current.source };
  await stat(video);
  // Several windows of the clip: board ends found in only one, or in places that disagree by more than
  // about a frame px, are not trusted (undetermined), so a noisy picture can never pass the gate.
  const windowCount = o.windows === undefined ? 3 : Number(o.windows);
  if (!(Number.isInteger(windowCount) && windowCount >= 1 && windowCount <= 6)) throw new Error("--windows must be 1 to 6");
  const reads = [];
  for (let w = 0; w < windowCount; w++) {
    try {
      const r = (deps.readFrames ?? readFrames)(video, { at: at + w * (seconds + 7), seconds, fps });
      if (r.frames.length >= 4) reads.push({ ...r, at: at + w * (seconds + 7) });
    } catch (error) { if (!w || error instanceof Blocked) throw error; }
  }
  if (!reads.length) throw new Error("No frames could be read from the clip at --at");
  // Every frame is turned into the camera's own analysis frame first (resize, then rotation), so the
  // stops and saw are level lines on the picture and the board ends are measured along the board axis.
  const source = { width: reads[0].width, height: reads[0].height };
  const resizeAssumed = resize === null;
  const mapping = analysisMapping({ ...source, frameSize, resize: resize ?? "CROP", rotation: geometry.rotationDeg ?? 0 });
  const renderer = analysisRenderer(mapping);
  for (const rd of reads) {
    if (rd.width !== source.width || rd.height !== source.height) throw new Error("The clip's frame size changed between windows");
    rd.frames = rd.frames.map(f => renderer.render(f));
    rd.width = rd.height = renderer.size;
  }
  const read = reads[0];
  const g = { axis: geometry.axis, frameSize, width: read.width, height: read.height, scale: renderer.scale };
  const pxPerFrame = renderer.scale;
  const meanStop = geometry.stops.length ? geometry.stops.reduce((s, x) => s + x.px, 0) / geometry.stops.length : null;
  const dir = meanStop !== null ? Math.sign(judged.px - meanStop) || 1 : geometry.stopEnd === "HIGH" ? -1 : 1;
  const searchPx = o["search-px"] === undefined ? SEARCH_PX : Number(o["search-px"]);
  const perWindow = reads.map(rd => ({ at: rd.at, ...detectCutEnds(rd.frames, { width: rd.width, height: rd.height, axis: geometry.axis, sawRaw: frameToRaw(judged.px, g), dir,
    searchRaw: searchPx * pxPerFrame, minRunRaw: Math.max(4, Math.round(4 * pxPerFrame)), pxPerFrame }) }));
  const detected = combineWindows(perWindow, { pxPerFrame, need: Math.min(2, reads.length) });
  const bestRead = reads[detected.window ?? 0];
  const cutEnds = manual !== null ? { found: true, px: round(manual, 2), source: "manual", detected: { found: detected.found, ...(detected.why ? { why: detected.why } : {}) } }
    : detected.found
      ? { found: true, px: round(rawToFrame(detected.rawPx, g), 2), source: "frames", votes: detected.votes, lined: detected.near, concentration: detected.concentration,
        framesUsed: detected.framesUsed, groups: detected.groups, spreadPx: detected.spreadFramePx, tiltPerPx: detected.tiltPerPx, windows: detected.windows }
      : { found: false, px: null, source: "frames", why: detected.why, votes: detected.votes ?? 0, windows: detected.windows };
  const best = Math.min(bestRead.frames.length - 1, detected.bestFrame ?? 0);
  const frameRgb = renderer.render((deps.readColorFrame ?? readColorFrame)(video, bestRead.at + best / fps, source), 3);
  await writePrivate(path.join(out, "frame.rgb"), frameRgb);
  const ageHours = clip?.recordedAtLocal ? (Date.now() - Date.parse(`${clip.recordedAtLocal}Z`)) / 3600000 : null;
  const base = { profile, dataSource, camera, clip: { ...clip, ...(ageHours !== null ? { ageDaysApprox: round(ageHours / 24, 1) } : {}) },
    frames: { space: "analysis", width: read.width, height: read.height, scale: renderer.scale, source, resize: mapping.resize, ...(resizeAssumed ? { resizeAssumed: true } : {}),
      rotationDeg: mapping.rotation, ...(perspective ? { perspective: true } : {}),
      count: reads.reduce((n, rd) => n + rd.frames.length, 0), windows: reads.map(rd => rd.at), seconds, fps }, frameSize };
  const result = await finishCheck({ base, geometry, judged, cutEnds, frameRgb, out, tolerancePx, now: deps.now?.() });
  if (ageHours !== null && ageHours > 72) {
    result.warnings.push({ code: "old_clip", message: `The newest raw recording is about ${Math.round(ageHours / 24)} days old: if the camera moved since, record a fresh clip while boards are cut and check again.` });
    await writePrivate(result.record, `${JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k]) => !["record", "next"].includes(k))), null, 2)}\n`);
  }
  return result;
}

export async function approve(o, { now = new Date() } = {}) {
  if (!o.record) throw new Error("--record FILE is required");
  const words = String(o.words ?? "").trim();
  if (words.length < 2) throw new Error("--words must quote the user's own approval of the picture");
  const record = await readRecord(o.record);
  if (record?.kind !== RECORD_KIND) throw new Error(`${o.record} is not a saw-line check record`);
  if (record.verdict !== "pass")
    throw new Blocked("saw_line_not_passed", `This check did not pass (${record.verdict}${record.gapPx !== null ? `, ${Math.abs(record.gapPx)} px off the cut ends` : ""}): a failed or undetermined saw line cannot be approved. Fix the saw, check again, then approve.`);
  const overlay = await readFile(record.images.overlay);
  if (sha256(overlay) !== record.images.overlaySha256) throw new Error("overlay.png changed since the check; run the check again");
  record.approval = { at: now.toISOString(), words: words.slice(0, 500), overlaySha256: record.images.overlaySha256 };
  await writePrivate(o.record, `${JSON.stringify(record, null, 2)}\n`);
  return { kind: "trimsaw-saw-line-approval", record: path.resolve(o.record), dataSource: record.dataSource, sawPx: record.saw.judged.px, cutEndsPx: record.cutEnds.px, approval: record.approval };
}

export async function main(args = process.argv.slice(2), deps = {}) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(`${HELP}\n`); return undefined; }
  const cmd = args[0];
  if (!["check", "approve", "require"].includes(cmd)) throw new Error("Choose check, approve or require; run with --help");
  const { values: o } = parseArgs({ args: args.slice(1), options: Object.fromEntries([
    "device-id", "data-source-id", "identity", "proposed-saw-px", "saw-px", "from", "to", "clip", "at", "seconds", "fps", "search-px", "tolerance-px",
    "frame-size", "resize", "out", "status", "video", "from-record", "cut-ends-px", "windows", "record", "words", "max-age-hours", "profile", "receipts",
  ].map(k => [k, { type: "string" }]).concat([["confirm", { type: "boolean" }]])) });
  if (cmd === "check") return check(o, deps);
  if (cmd === "approve") return approve(o, deps);
  const record = await readRecord(o.record);
  let sawPx = o["saw-px"] === undefined ? null : Number(o["saw-px"]);
  if (sawPx === null && o.status) sawPx = cameraGeometry(trimsawMetaOf(JSON.parse(await readFile(o.status, "utf8")))).current?.px ?? null;
  const maxAgeHours = o["max-age-hours"] === undefined ? MAX_AGE_HOURS : Number(o["max-age-hours"]);
  return { kind: "trimsaw-saw-line-gate", ...requireSawLine(record, { deviceId: o["device-id"] ?? null, sawPx, maxAgeHours, now: deps.now?.() ?? Date.now(), what: "the next step" }) };
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
