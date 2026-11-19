// Zira's stored copy of a trimsaw camera's settings (the data source's cv.settings) against the camera's
// own retained trim saw status. Push uploaded stops, the Kamps rollout snapshot and a replacement phone's
// Sync Settings read this copy, so a copy that lags the camera hands out the wrong stops.
// Read-only: nothing here writes to Zira or the camera. The camera writes its own copy (Vision-App after
// 851, meta.settingsUploadSupported) when someone presses Upload settings in Zira's Trim saw stops panel.
import { createHash } from "node:crypto";

// The entries an upload may change, as Vision-App's utility/TrimSawStoredSettings.KEYS lists them.
export const COPY_KEYS = ["TrimSawBuckets", "TrimSawBucketsEnabled", "TrimSawStopSide", "TrimSawStopEnd", "analysisFrameRotationDegrees",
  "TrimSawReferenceLengthUnits", "TrimSawReferenceSpanFraction"];

// Only these keys are kept from a stored copy: older uploads also stored the API key and the Cognito login.
export const pickCopyKeys = (settings = {}) =>
  Object.fromEntries(COPY_KEYS.filter(k => settings?.[k] !== undefined && settings[k] !== null).map(k => [k, settings[k]]));

const sha256 = text => createHash("sha256").update(text).digest("hex");
const sizeList = list => list.map(n => String(Number(n))).join(", ");

// The camera's new-bucket stops from Zira's stored copy of its settings: the stop (jig) size of each line.
// `fingerprint` is the SHA-256 of the stored string, the same fingerprint the camera publishes as meta.appliedRevision.
export function storedStops(settings = {}) {
  let doc = null;
  const raw = typeof settings.TrimSawBuckets === "string" && settings.TrimSawBuckets.trim() ? settings.TrimSawBuckets : null;
  try { doc = raw ? JSON.parse(raw) : null; } catch { return { enabled: false, stops: [], unreadable: true, fingerprint: sha256(raw) }; }
  const stops = Array.isArray(doc?.buckets) ? doc.buckets.map(b => Number(b.jigSize ?? b.size)).filter(Number.isFinite) : [];
  return {
    enabled: settings.TrimSawBucketsEnabled === true || settings.TrimSawBucketsEnabled === "true",
    stops, revision: doc?.revision ?? null, fingerprint: raw ? sha256(raw) : null,
    calibratedAt: doc?.derivedStopCalibration?.atMs ? new Date(doc.derivedStopCalibration.atMs).toISOString() : null,
    rotation: settings.analysisFrameRotationDegrees ?? null, stopSide: settings.TrimSawStopSide ?? null,
    app: doc?.context?.appVersion ?? null,
  };
}

const sameSizes = (a, b) => a.length === b.length && a.every((s, i) => Math.abs(s - b[i]) < 0.001);
export const cameraStopsOf = m => (Array.isArray(m?.appliedStops) ? m.appliedStops : []).map(s => Number(s.jigSize ?? s.size)).filter(Number.isFinite);

// Does Zira's stored copy hold what the camera measures with? From the camera's retained trimsaw-status meta.
// "unknown" without a camera status: a missing status is never read as a match.
export function storedCopyState(stored = {}, camera = null) {
  const m = camera?.meta;
  if (!m || typeof m !== "object") return { state: "unknown", differences: [], cameraStops: null };
  const cameraStops = cameraStopsOf(m);
  const storedStopList = stored.stops ?? [], storedHas = !!stored.fingerprint, revision = typeof m.appliedRevision === "string" ? m.appliedRevision : null;
  const differences = [];
  if (revision || cameraStops.length) {
    if (!storedHas) differences.push("Zira has no stops");
    else if (revision) { if (stored.fingerprint !== revision) differences.push(sameSizes(storedStopList, cameraStops) ? "stop positions" : "stop sizes"); }
    else if (!sameSizes(storedStopList, cameraStops)) differences.push("stop sizes");
  } else if (storedHas) differences.push("the camera has no stops");
  const side = String(stored.stopSide ?? "").toUpperCase();
  if (m.stopSide && side && side !== m.stopSide) differences.push("board side");
  if (Number.isInteger(m.analysisRotationDegrees) && Number(stored.rotation ?? 0) !== m.analysisRotationDegrees) differences.push("frame rotation");
  if (typeof m.enabled === "boolean" && stored.enabled !== m.enabled) differences.push("stop measurement on/off");
  return { state: differences.length ? "stale" : "match", differences, cameraStops, enabled: m.enabled !== false };
}

// Equal as settings, as TrimSawStoredSettings.sameValue compares them after JSON: numbers by value, the rest exactly.
const same = (a, b) => (a === null || a === undefined || b === null || b === undefined) ? (a ?? null) === (b ?? null)
  : typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b;
const shown = v => (v === undefined || v === null ? "not stored" : typeof v === "string" ? v : JSON.stringify(v));

// What an upload from this camera would write into Zira's copy, entry by entry: Vision-App's
// TrimSawStoredSettings.diff, worked out from the camera's published status instead of its preferences.
// `certain: false` marks an entry the status cannot settle (a stop end the camera may only derive, a
// reference span published in pixels rather than as the stored fraction): the camera decides it and its
// reply lists the entries it wrote (meta.settingsUpload.changedKeys). TrimSawBuckets is summarised
// (sizes and fingerprint), never copied. Returns [] when the camera reported no status.
export function copyChanges(settings = {}, meta = null) {
  const m = meta && typeof meta === "object" ? meta : null;
  if (!m) return [];
  const out = [], add = (key, zira, camera, certain = true) => out.push({ key, zira, camera, certain });
  const stored = storedStops(settings);
  const revision = typeof m.appliedRevision === "string" ? m.appliedRevision : null;
  const cameraStops = cameraStopsOf(m);
  const bucketText = (stops, fp) => (fp ? `${stops.length ? `stops ${sizeList(stops)}` : "no stops"} (${fp.slice(0, 8)})` : "not stored");
  if (revision) {
    if (stored.fingerprint !== revision) add("TrimSawBuckets", bucketText(stored.stops, stored.fingerprint), bucketText(cameraStops, revision));
  } else if (cameraStops.length) {
    if (!sameSizes(stored.stops, cameraStops)) add("TrimSawBuckets", bucketText(stored.stops, stored.fingerprint), `stops ${sizeList(cameraStops)}`, false);
  } else if (stored.fingerprint) add("TrimSawBuckets", bucketText(stored.stops, stored.fingerprint), "not stored");
  // A key the camera does not hold means measurement off and rotation 0.
  if (typeof m.enabled === "boolean" && !same(settings.TrimSawBucketsEnabled ?? false, m.enabled))
    add("TrimSawBucketsEnabled", shown(settings.TrimSawBucketsEnabled), shown(m.enabled));
  if ("stopSide" in m && !same(settings.TrimSawStopSide, m.stopSide ?? null))
    add("TrimSawStopSide", shown(settings.TrimSawStopSide), shown(m.stopSide));
  // The status always names a stop end; the camera may only derive it from the side, without storing it.
  if (typeof m.stopEnd === "string" && !same(settings.TrimSawStopEnd, m.stopEnd))
    add("TrimSawStopEnd", shown(settings.TrimSawStopEnd), shown(m.stopEnd), settings.TrimSawStopEnd !== undefined && settings.TrimSawStopEnd !== null);
  if (Number.isInteger(m.analysisRotationDegrees) && !same(Number(settings.analysisFrameRotationDegrees ?? 0), m.analysisRotationDegrees))
    add("analysisFrameRotationDegrees", shown(settings.analysisFrameRotationDegrees), shown(m.analysisRotationDegrees));
  const ref = m.singleSize && typeof m.singleSize === "object" ? m.singleSize : null;
  if (ref) {
    const length = Number(ref.referenceLengthUnits) > 0 ? Number(ref.referenceLengthUnits) : null;
    const storedLength = settings.TrimSawReferenceLengthUnits ?? null;
    if (!same(storedLength === null ? null : Number(storedLength), length))
      add("TrimSawReferenceLengthUnits", shown(storedLength), shown(length));
    // The status gives the span in frame pixels and Zira stores a fraction of the frame: only presence compares.
    const span = Number(ref.referenceSpanPx) > 0, storedSpan = settings.TrimSawReferenceSpanFraction ?? null;
    if (span !== (storedSpan !== null && Number(storedSpan) > 0))
      add("TrimSawReferenceSpanFraction", shown(storedSpan), span ? `${Number(ref.referenceSpanPx)} px` : "not stored");
  }
  return out;
}

// The camera's own report of its last save into Zira's copy (meta.settingsUpload), bounded.
export function lastUpload(meta) {
  const u = meta?.settingsUpload;
  if (!u || typeof u !== "object") return null;
  const at = Number.isFinite(u.atUtcMs) && u.atUtcMs > 0 ? new Date(u.atUtcMs).toISOString() : null;
  return {
    state: typeof u.state === "string" ? u.state : null, trigger: typeof u.trigger === "string" ? u.trigger : null, at,
    mode: typeof u.mode === "string" ? u.mode : null, verified: u.verified === true,
    changedKeys: Array.isArray(u.changedKeys) ? u.changedKeys.filter(k => typeof k === "string").slice(0, 20) : [],
    ...(typeof u.revision === "string" ? { revision: u.revision.slice(0, 128) } : {}),
    ...(typeof u.message === "string" && u.message ? { message: u.message.slice(0, 300) } : {}),
  };
}

// Whether the camera can save its own copy from the panel, and what it would take otherwise.
export function uploadAction({ state, supported, online }) {
  if (state === "match") return "none";
  if (state === "unknown") return "check camera";
  if (!supported) return "update app";
  return online === false ? "check camera" : "upload";
}
