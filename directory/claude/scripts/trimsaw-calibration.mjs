// Strict calibration contract and bounded, non-authoritative drift analysis. No network writes.
const fail = message => { throw new Error(message); };
const object = v => v && typeof v === "object" && !Array.isArray(v);
const only = (p, keys) => { if (!object(p) || Object.keys(p).some(k => !keys.includes(k))) fail("Unknown calibration fields or invalid object"); };
const range = (v, key, min, max) => {
  if (!Number.isFinite(v) || v < min || v > max) fail(`${key} must be between ${min} and ${max}`);
  return v;
};
export function calibrationParams(command, p) {
  if (!["get", "preview", "apply", "cancel"].includes(command)) fail("Unknown calibration command");
  only(p, command === "get" ? ["watchSeconds"] : command === "preview"
    ? ["expectedRevision", "changes", "sawAnchorPx", "sawTolerancePx"]
    : ["expectedRevision", "previewId", ...(command === "apply" ? ["physicalSawConfirmed"] : [])]);
  if (command === "get") {
    const watchSeconds = p.watchSeconds === undefined ? 0 : p.watchSeconds;
    if (!Number.isInteger(watchSeconds)) fail("watchSeconds must be an integer");
    return { watchSeconds: range(watchSeconds, "watchSeconds", 0, 300) };
  }
  if (typeof p.expectedRevision !== "string" || !/^[a-f0-9]{16,64}$/.test(p.expectedRevision)) fail("Invalid expectedRevision");
  if (command !== "preview") {
    if (typeof p.previewId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(p.previewId)) fail("Invalid previewId");
    if (command === "apply" && p.physicalSawConfirmed !== true) fail("Confirm the physical saw before applying");
    return { ...p };
  }
  if (!Array.isArray(p.changes) || !p.changes.length || p.changes.length > 32) fail("changes must contain 1 to 32 stop patches");
  const ids = new Set();
  for (const patch of p.changes) {
    only(patch, ["stopId", "positionPx", "calibrationSize", "jigSize"]);
    if (typeof patch.stopId !== "string" || !/^stop-[0-9]{1,2}$/.test(patch.stopId) || ids.has(patch.stopId) || Object.keys(patch).length < 2) fail("Each patch needs a unique stopId and a changed value");
    ids.add(patch.stopId);
    for (const key of ["positionPx", "calibrationSize", "jigSize"]) if (key in patch) range(patch[key], key, key === "positionPx" ? 0 : .001, 100000);
  }
  if ("sawAnchorPx" in p) range(p.sawAnchorPx, "sawAnchorPx", 0, 4096);
  if ("sawTolerancePx" in p) {
    range(p.sawTolerancePx, "sawTolerancePx", .1, 5);
    if (!("sawAnchorPx" in p)) fail("sawTolerancePx requires sawAnchorPx");
  }
  return { ...p, changes: p.changes.map(x => ({ ...x })) };
}

// Keep stop arrays and raw summaries, but never forward arbitrary device settings or data.
const pick = (v, keys) => Object.fromEntries(keys.filter(k => v && ["number", "boolean", "string"].includes(typeof v[k]))
  .map(k => [k, typeof v[k] === "string" ? v[k].slice(0, 128) : v[k]]));
const rows = v => Array.isArray(v) ? v.slice(0, 32) : [];
const distribution = v => pick(v, ["mean", "median", "p10", "p90"]);
const geometry = v => ({ ...pick(v, ["usable", "angleDeg", "bandUnits", "scaleUnitsPerPx", "sawPositionPx", "agreementUnits"]),
  stops: rows(v?.stops).map(s => pick(s, ["stopId", "positionPx", "calibrationSize", "jigSize"])) });
const statistics = v => ({ ...pick(v, ["usable", "unmatchedCount", "noCutCount"]),
  stops: rows(v?.stops).map(s => ({ ...pick(s, ["stopId", "jigSize", "count", "cutCount"]),
    pre: distribution(s.pre), post: distribution(s.post), cutPost: distribution(s.cutPost), endpointPx: distribution(s.endpointPx) })) });
export function calibrationSummary(v) {
  if (!object(v)) return null;
  const out = pick(v, ["schemaVersion", "supported", "revision", "busy", "frameSizePx", "axis", "unitOfMeasure", "stopEnd", "enabled",
    "physicalAccuracyValidated", "previewInvalidated", "previewId", "expiresAtUtcMs", "sawAnchorPx", "sawTolerancePx", "canApply", "applied"]);
  for (const key of ["current", "proposed", "rollback"]) if (object(v[key])) out[key] = geometry(v[key]);
  if (Array.isArray(v.refusals)) out.refusals = v.refusals.slice(0, 40).filter(x => typeof x === "string").map(x => x.slice(0, 300));
  if (object(v.comparison)) out.comparison = { ...pick(v.comparison, ["sampleCount", "measurement", "physicalAccuracyValidated", "changedTargetCount", "changedCutDecisionCount", "fromUtcMs", "toUtcMs"]),
    current: statistics(v.comparison.current), proposed: statistics(v.comparison.proposed) };
  return out;
}

export function analyzeCalibration(state) {
  if (state?.schemaVersion !== 1 || state?.supported !== true || !state?.current?.usable) return { ready: false, reason: "Compatible active calibration state required; do not send edits to older cameras." };
  const findings = [], changes = [];
  const scale = Math.abs(state.current.scaleUnitsPerPx), band = state.current.bandUnits;
  for (const s of state.comparison?.current?.stops ?? []) {
    const stop = state.current.stops.find(x => x.stopId === s.stopId);
    if (!stop || s.count < 30) { findings.push({ stopId: s.stopId, reason: "Insufficient recent crossings (need 30)" }); continue; }
    const offset = (s.endpointPx?.median - stop.positionPx) * scale;
    const spread = (s.endpointPx?.p90 - s.endpointPx?.p10) * scale;
    const postBias = s.cutCount >= 30 ? s.cutPost?.median - stop.jigSize : null;
    if (Number.isFinite(postBias) && Math.abs(postBias) > .2) findings.push({ stopId: s.stopId, reason: "Raw cut estimate differs from reported jig; this is not physical ground truth", rawCutBias: postBias });
    if (Number.isFinite(offset) && Math.abs(offset) > .15) {
      findings.push({ stopId: s.stopId, endpointOffsetUnits: offset, spreadUnits: spread,
        reason: "Observed board endpoint differs from saved stop position" });
      if (Number.isFinite(spread) && spread <= band && Math.abs(offset) <= band)
        changes.push({ stopId: s.stopId, positionPx: s.endpointPx.median });
    }
  }
  if (state.comparison?.current?.unmatchedCount > 0) findings.push({ reason: "Unmatched boards present; collect/review missing stops separately", count: state.comparison.current.unmatchedCount });
  return { ready: true, findings, suggestedPreview: changes.length ? { expectedRevision: state.revision, changes } : null,
    automaticApply: false, physicalAccuracyValidated: false,
    note: "Position candidates only; preserve calibration and jig values unless explicitly reviewed. Confirm physical saw, preview scale/saw and cut-decision changes. Raw cut estimates cannot validate their own saw geometry." };
}
