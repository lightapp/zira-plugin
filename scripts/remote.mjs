#!/usr/bin/env node
// Live view, live data and remote control for Zira Vision and Pallet Vision cameras.
// Reads go over AWS IoT MQTT with the plugin's sign-in (read-only role plus the live-data
// watcher heartbeat). Commands go through Zira's audited remote-commands API: preview by
// default, --apply sends once, records a receipt and waits for the camera's own status reply.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { IotError, MqttClient, iotConfig, identityCredentials, presignIotUrl, topicMatches } from "./iot.mjs";
import {
  Blocked, argValue, fingerprint, guardedWrite, id, isMain, link, liveSession, originFor, receiptsFile, route, runCli,
} from "./client.mjs";
import { findSource, launchBrowser, parseZiraUrl, webOrigin, ROUTES as DATASET_ROUTES } from "./datasets.mjs";
import { toolkit } from "../skills/health-report/scripts/api.mjs";

const HELP = `Zira live view, live data and remote control for Vision / Pallet Vision cameras
node scripts/remote.mjs find --place TEXT [--source TEXT]
node scripts/remote.mjs open (--url ZIRA_URL | --device-id ID) [--identity ID] [--autostart 0|1] [--launch]
node scripts/remote.mjs devices (--url | --device-id ID) [--seconds 12]
node scripts/remote.mjs status (--url | --device-id ID) [--identity ID] [--seconds 6]
node scripts/remote.mjs watch (--url | --device-id ID) [--identity ID] [--seconds 60] [--jsonl]
node scripts/remote.mjs actions [--all]
node scripts/remote.mjs command (--url | --device-id ID) [--identity ID] --action NAME
    [--params JSON] [--apply] [--wait 30] [--allow-repeat] [--resolve-pending none]
Common: --profile prod|integ   --web-origin http://localhost:PORT (local zira-web links only)

find, open and actions make Zira API reads only. devices, status and watch connect to the
camera's live topics with the plugin's sign-in: they read, and watch also sends the same
"someone is watching" heartbeat the web page sends so the camera streams live data.
command previews by default; --apply asks Zira to send the command once, records a local
receipt and waits for the camera's status reply. The same action with the same values is
not sent twice (already-done) unless --allow-repeat says the user wants it again. An acknowledged command is not proof the
camera acted: only a matching status reply verifies it.
Exit 0 success, 2 invalid/failed, 3 sent but not verified, 4 blocked (JSON explains).
`;

export const VISION_APPLYING_IDS = ["7", "10"];
export const ROUTES = [
  ...DATASET_ROUTES,
  ["GET", /^\/prod-vision\/iot-client-creds$/],
  ["POST", /^\/prod-vision\/[1-9]\d*\/remote-commands$/],
];
const IDENTITY = /^[a-z]{2}(-[a-z]+)+-\d:[0-9a-f-]{36}$/;
const HEARTBEAT_MS = 25000;

// ---- Topics ----

// Every camera topic hangs off the data source; identity-scoped ones name one paired Android device.
export const deviceBase = ({ companyId, siteId, id: deviceId }) => {
  for (const v of [companyId, siteId, deviceId]) if (!id(String(v ?? ""))) throw new Error("Data source company, site and ID are required");
  return `companies-${companyId}/sites-${siteId}/devices-${deviceId}`;
};
export const identityTopic = (base, identity, suffix) => {
  if (!IDENTITY.test(String(identity ?? ""))) throw new Error("Invalid camera identity");
  return `${base}/identities-${identity}/${suffix}`;
};

// Status topics a camera publishes (all retained except settings-status); labels are user-facing.
// Pallet Vision keeps its settings on the data source's own topics, without the identity.
export const STATUS_TOPICS = {
  presence: { suffix: "status", label: "Connection", match: m => m && !m.kind },
  model: { suffix: "status", label: "Model update", match: m => m?.kind === "model" },
  liveView: { suffix: "meeting-status", label: "Live view" },
  recording: { suffix: "recording-status", label: "Video recording" },
  sampling: { suffix: "sampling-status", label: "Image sampling" },
  settings: { suffix: "settings-state", label: "Device settings", palletScope: "device" },
  settingsStatus: { suffix: "settings-status", label: "Settings command", palletScope: "device" },
  trimsaw: { suffix: "trimsaw-status", label: "Trim saw stops", types: ["vision"] },
  deployment: { suffix: "deployment-status", label: "App version", types: ["vision"] },
};

export const deviceKind = ds => (ds.applyingId === "10" || ds.type === "Pallet Vision" ? "pallet" : "vision");
export function statusTopic(ds, identity, kind) {
  const t = STATUS_TOPICS[kind], base = deviceBase(ds);
  return t.palletScope === "device" && deviceKind(ds) === "pallet" ? `${base}/${t.suffix}` : identityTopic(base, identity, t.suffix);
}

// ---- Remote actions ----
// Mirrors platform src/prodVision/common/remoteCommands.ts: names, parameters and status
// replies. `enabled` actions are offered; the others stay in Zira's Remote Control tab
// (or update-vision-device for models) until each is reviewed and enabled on both sides.
const int = (min, max, dflt, label) => ({ type: "integer", min, max, ...(dflt === undefined ? {} : { default: dflt }), label });
const bool = (dflt, label) => ({ type: "boolean", default: dflt, label });
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const recordingParams = {
  duration: int(1, 600, 300, "Seconds per video (at most 10 minutes)"),
  interval: int(2, 86400, 360, "Seconds between video starts (more than the duration)"),
  count: int(1, 20, 3, "Number of videos"),
  recordRaw: bool(true, "Record raw video"),
  recordValidation: bool(true, "Record validation video (with detections drawn)"),
  useDetection: bool(false, "Only keep videos with detections"),
  useCounts: bool(true, "Only keep videos with counts"),
};

// Device support follows the cameras' own parsers: Vision is Vision-App (vision-hub),
// Pallet Vision is pallet-vision. Pallet Vision treats any recording command other than
// start as stop, so schedules are Vision only.
const BOTH = ["vision", "pallet"];
export const ACTIONS = {
  "settings.get": { label: "Read device settings", status: "settings", correlation: "settingsReason", risk: "read", enabled: true, types: BOTH, params: {},
    note: "Vision cameras running Vision-App report an empty settings list; Pallet Vision reports its settings." },
  "sampling.start": { label: "Start image sampling", status: "sampling", correlation: "stateAfter", expect: "Running", risk: "device", enabled: true, types: BOTH,
    params: { timeInterval: int(1, 3600, 1, "Spacing between images: frames on Vision cameras, seconds on Pallet Vision"),
      maxImageCount: int(1, 200, 10, "Images to take") },
    effect: "The camera saves images and uploads them for datasets." },
  "sampling.stop": { label: "Stop image sampling", status: "sampling", correlation: "stateAfter", expect: "Idle", risk: "device", enabled: true, types: BOTH, params: {} },
  "recording.start": { label: "Record videos now", status: "recording", risk: "device", enabled: true, types: BOTH, params: recordingParams,
    effect: "The camera records and uploads videos; on cellular this uses data." },
  "recording.schedule": { label: "Schedule video recording", status: "recording", risk: "device", enabled: true, types: ["vision"],
    params: { ...recordingParams, schedules: { type: "schedules", label: "Days and start times (HH:MM, camera's local time); an empty list clears the schedule" } },
    effect: "Replaces the camera's recording schedule." },
  "recording.stop": { label: "Stop video recording", status: "recording", risk: "device", enabled: true, types: BOTH, params: {} },
  "settings.apply": { label: "Change device settings", status: "settingsStatus", risk: "guarded", enabled: false, types: ["pallet"], web: "remoteControl" },
  "model.sync": { label: "Push a model to the camera", status: "model", risk: "guarded", enabled: false, types: BOTH, skill: "update-vision-device" },
  "model.delete": { label: "Remove a model from the camera", status: "model", risk: "guarded", enabled: false, types: ["pallet"], web: "remoteControl" },
  ...Object.fromEntries(["start", "stop", "continue", "assign", "remove", "apply", "cancel", "clear"].map(c =>
    [`trimsaw.${c}`, { label: `Trim saw stops: ${c}`, status: "trimsaw", risk: "guarded", enabled: false, types: ["vision"], web: "remoteControl" }])),
  "sync.images": { label: "Upload selected images", risk: "guarded", enabled: false, types: ["pallet"], web: "remoteControl" },
  "sync.videosRaw": { label: "Upload selected raw videos", risk: "guarded", enabled: false, types: ["pallet"], web: "videos" },
  "sync.videosValidation": { label: "Upload selected validation videos", risk: "guarded", enabled: false, types: ["pallet"], web: "videos" },
  "audit.upload": { label: "Upload the camera's diagnostics", risk: "guarded", enabled: false, types: ["vision"], web: "remoteControl" },
};

const fail = message => { throw new Blocked("invalid_params", message); };
const hhmm = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Validates parameters against the registry and fills defaults; the server validates again.
export function actionParams(name, given = {}, kind) {
  const action = ACTIONS[name];
  if (!action) fail(`Unknown action ${name}. Run actions to list them.`);
  if (kind && !action.types.includes(kind))
    throw new Blocked("not_supported", `${action.label} is not supported on ${kind === "pallet" ? "Pallet Vision" : "Vision"} cameras.`, { action: name });
  if (!action.enabled) {
    const where = action.skill ? `the ${action.skill} skill` : "Zira's Remote Control tab";
    throw new Blocked("not_enabled", `${action.label} is not available from chat yet; use ${where}.`, { action: name });
  }
  if (given === null || typeof given !== "object" || Array.isArray(given)) fail("--params must be a JSON object");
  const extra = Object.keys(given).filter(k => !Object.hasOwn(action.params, k));
  if (extra.length) fail(`Unknown parameter(s) for ${name}: ${extra.join(", ")}`);
  const out = {};
  for (const [key, spec] of Object.entries(action.params)) {
    const v = given[key] ?? spec.default;
    if (v === undefined) fail(`${key} is required (${spec.label})`);
    if (spec.type === "integer" && (!Number.isInteger(v) || v < spec.min || v > spec.max)) fail(`${key} must be a whole number from ${spec.min} to ${spec.max}`);
    if (spec.type === "boolean" && typeof v !== "boolean") fail(`${key} must be true or false`);
    if (spec.type === "schedules") {
      if (!Array.isArray(v) || v.length > 14) fail("schedules must list at most 14 entries (an empty list clears the schedule)");
      const needEnd = given.useDetection ?? action.params.useDetection.default ?? false;
      const needsEnd = needEnd || (given.useCounts ?? action.params.useCounts.default);
      out[key] = v.map(s => {
        if (!s || typeof s !== "object" || Object.keys(s).some(k => !["dayOfWeek", "startTime", "endTime", "recurring"].includes(k))) fail("Each schedule has dayOfWeek, startTime, recurring and optional endTime");
        if (!DAYS.includes(s.dayOfWeek) || !hhmm(s.startTime)) fail("Each schedule needs a dayOfWeek (sunday…saturday) and startTime HH:MM");
        if (needsEnd && (!hhmm(s.endTime) || s.endTime <= s.startTime)) fail("With detection or count gating, each schedule needs an endTime after its startTime");
        return { dayOfWeek: s.dayOfWeek, startTime: s.startTime, recurring: !!s.recurring, ...(needsEnd ? { endTime: s.endTime } : {}) };
      });
      if (new Set(out[key].map(s => `${s.dayOfWeek} ${s.startTime}`)).size !== out[key].length) fail("Schedules cannot repeat the same day and time");
      continue;
    }
    out[key] = v;
  }
  if ("interval" in out && out.interval <= out.duration) fail("interval must be greater than duration");
  if ("recordRaw" in out && !out.recordRaw && !out.recordValidation) fail("Choose raw, validation or both videos");
  return out;
}

export function listActions({ all = false } = {}) {
  return Object.entries(ACTIONS).filter(([, a]) => all || a.enabled).map(([name, a]) => ({
    name, label: a.label, enabled: a.enabled, risk: a.risk, cameras: a.types.map(t => t === "pallet" ? "Pallet Vision" : "Vision"),
    ...(a.note ? { note: a.note } : {}),
    ...(a.effect ? { effect: a.effect } : {}),
    ...(a.params ? { params: a.params } : {}),
    ...(a.status ? { reply: STATUS_TOPICS[a.status].label } : {}),
    ...(a.enabled ? {} : { where: a.skill ? `${a.skill} skill` : `Zira ${a.web === "videos" ? "Videos" : "Remote Control"} tab` }),
  }));
}

// ---- Payload summaries (allowlisted, bounded) ----

const MAX_KEYS = 40;
const prim = v => v === null || ["string", "number", "boolean"].includes(typeof v);
const cut = v => typeof v === "string" ? v.slice(0, 120) : v;
const flat = (obj, max = MAX_KEYS) => obj && typeof obj === "object" && !Array.isArray(obj)
  ? Object.fromEntries(Object.entries(obj).filter(([k, v]) => !k.startsWith("_") && prim(v)).slice(0, max).map(([k, v]) => [k, cut(v)]))
  : undefined;
// Epoch seconds or ms, or ISO text; devices also send offsets like "+03" without minutes.
const time = v => {
  const t = typeof v === "number" ? v : Date.parse(typeof v === "string" ? v.replace(/([+-]\d\d)$/, "$1:00") : v);
  return Number.isFinite(t) && t > 1e12 ? new Date(t).toISOString() : Number.isFinite(t) && t > 1e9 ? new Date(t * 1000).toISOString() : null;
};
// One level of nesting as "group.key", primitives only, bounded.
const flat2 = (obj, max = MAX_KEYS) => {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith("_") || Object.keys(out).length >= max) continue;
    if (prim(v)) out[k] = cut(v);
    else if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k2, v2] of Object.entries(v)) if (prim(v2) && Object.keys(out).length < max) out[`${k}.${k2}`] = cut(v2);
  }
  return out;
};
const pick = (m, keys) => Object.fromEntries(keys.filter(k => m?.[k] !== undefined && prim(m[k])).map(k => [k, cut(m[k])]));

// The newest reading: lastReading (Vision) or the last of aggregations[].readings (Pallet Vision).
function newestReading(m) {
  if (m.lastReading && typeof m.lastReading === "object") return m.lastReading;
  const readings = Array.isArray(m.aggregations) ? m.aggregations.flatMap(a => Array.isArray(a?.readings) ? a.readings : []) : [];
  return readings.toSorted((a, b) => String(time(a?.timestamp) ?? "").localeCompare(String(time(b?.timestamp) ?? ""))).at(-1) ?? null;
}

// names maps metric IDs to the data source's display names, so readings read as "Board Count".
export function liveSummary(m, names = {}) {
  if (!m || typeof m !== "object") return null;
  const counts = Array.isArray(m.lineShiftCounts) ? m.lineShiftCounts.slice(0, 20).map(x => prim(x) ? x : flat(x, 10))
    : flat(m.lineShiftCounts, 20);
  const reading = newestReading(m);
  const raw = reading ? flat(reading.values ?? reading) ?? {} : null;
  const entries = raw ? Object.entries(raw).filter(([k]) => k !== "groupKey") : [];
  const values = raw && Object.fromEntries([...entries.filter(([k]) => names[k]).map(([k, v]) => [names[k], v]),
    ...entries.filter(([k]) => !names[k]).map(([k, v]) => [/^\d+$/.test(k) ? `metric ${k}` : k, v])]);
  const readingAt = reading ? time(reading.timestamp ?? reading.time) : null;
  return { at: time(m.timestamp) ?? readingAt, trigger: cut(m.trigger), status: cut(m.status), units: m.units, shiftCount: m.shiftCount,
    ...(counts ? { lineShiftCounts: counts } : {}),
    ...(values ? { lastReading: { at: readingAt, values } } : {}),
    ...(m.sectionStatuses ? { sectionStatuses: Array.isArray(m.sectionStatuses) ? m.sectionStatuses.slice(0, 10).map(s => prim(s) ? s : flat(s, 8)) : flat(m.sectionStatuses) } : {}) };
}

export function statusSummary(kind, m) {
  if (!m || typeof m !== "object") return null;
  const at = time(m.updatedAt ?? m.ts ?? m.timestamp ?? m._ts);
  if (kind === "presence") return { at, connected: m.connected !== false, ...pick(m, ["model", "deviceName", "hwId", "batteryLevel", "isCharging"]) };
  if (kind === "settings") {
    const body = m.settings && typeof m.settings === "object" && !Array.isArray(m.settings) ? m.settings : m;
    return { at, reason: cut(m._reason), settings: flat2(body, 60), groups: Object.keys(body).filter(k => !k.startsWith("_")).length };
  }
  if (kind === "liveView") return { at, ...pick(m, ["isStreaming", "state", "networkState", "message", "reason"]) };
  if (kind === "recording") return { at, ...pick(m, ["state", "requestId", "requesterUsername", "message", "interval", "duration", "count", "recordRaw", "recordValidation", "useDetection", "useCounts"]),
    ...(Array.isArray(m.schedules) ? { schedules: m.schedules.slice(0, 14).map(s => flat(s, 6)) } : {}),
    ...(m.activeClip ? { activeClip: flat(m.activeClip, 8) } : {}), ...(Number.isFinite(m.completedClips) ? { completedClips: m.completedClips } : {}) };
  if (kind === "trimsaw") return { at, ...pick(m, ["state", "requestId", "message"]), ...(m.meta ? { meta: flat(m.meta, 12) } : {}) };
  if (kind === "model") return { at, ...pick(m, ["state", "requestId", "message"]), ...(m.meta ? { meta: flat(m.meta, 8) } : {}) };
  return { at, ...pick(m, ["state", "requestId", "message", "sampleInterval", "maxSamples", "version", "versionName", "versionCode", "appVersion"]) };
}

// ---- Zira API and IoT session ----

export async function loadLiveDevice(call, deviceId) {
  if (!id(String(deviceId ?? ""))) throw new Error("Data source ID required");
  const d = (await call("GET", route("/devices/all", { meterIds: deviceId, expand: "true" }))).data?.[0];
  if (String(d?.id ?? "") !== String(deviceId)) throw new Blocked("not_found", "Data source not found or not visible to this user");
  if (!VISION_APPLYING_IDS.includes(String(d.applying?.id ?? "")))
    throw new Blocked("not_vision", "Live view and remote control work for Vision and Pallet Vision data sources only");
  const companyId = String(d.company?.id ?? d.companyId ?? d.site?.company?.id ?? d.site?.companyId ?? "");
  const siteId = String(d.site?.id ?? d.siteId ?? "");
  if (!id(companyId) || !id(siteId)) throw new Error("Zira did not return the data source's company and site");
  const ds = { id: String(d.id), name: String(d.name ?? "Vision data source"), type: String(d.applying.id) === "10" ? "Pallet Vision" : "Vision",
    applyingId: String(d.applying.id), companyId, siteId, site: { id: siteId, name: String(d.site?.name ?? "") },
    company: { id: companyId, ...(d.company?.name ? { name: String(d.company.name) } : {}) } };
  // Metric display names for live readings; kept off the printed JSON.
  const names = {};
  for (const m of (Array.isArray(d.meterSchema?.metrics) ? d.meterSchema.metrics : []).slice(0, 500)) {
    const key = String(m?.metric?.id ?? ""), label = m?.displayName ?? m?.metric?.name;
    if (id(key) && typeof label === "string" && label.trim()) names[key] = label.trim().slice(0, 60);
  }
  Object.defineProperty(ds, "metricNames", { value: names, enumerable: false });
  return ds;
}

// Links into Zira: the focused live page and the full Remote Control tab. Until a Zira site
// serves /live (livePage false), the Remote Control tab, which has the same live view, stands in.
export function liveLinks(profile, ds, { identity, autostart, origin, livePage = true } = {}) {
  const base = origin ?? originFor(profile);
  const live = link(profile, `/live/${ds.id}`, { ...(identity ? { identity } : {}), ...(autostart === false ? { autostart: "0" } : {}), fromPage: "plugin" });
  const remote = link(profile, `/data-sources/${ds.id}`, { viewMode: "vision", tab: "remoteControl" });
  const swap = url => origin ? url.replace(originFor(profile), base) : url;
  return { liveUrl: swap(livePage ? live : remote), remoteControlUrl: swap(remote), ...(livePage ? {} : { livePage: "not on this Zira site yet" }) };
}

// One unauthenticated request: does this Zira site serve /live yet? Unknown counts as yes.
export async function livePageAvailable(origin, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${origin}/live/1`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    return response.status !== 404;
  } catch {
    return true;
  }
}

const unavailable = (ds, links, detail) => new Blocked("live_data_unavailable",
  `Live device data is not available to the plugin's sign-in yet (${detail}). The live page shows the same live view and data in Zira; nothing was sent to the camera.`,
  { dataSource: { id: ds.id, name: ds.name }, ...links });

// Connects to AWS IoT as the signed-in user: Zira's IoT config, Cognito credentials, presigned WebSocket.
export async function connectIot({ call, profile, auth, fetchImpl = globalThis.fetch, connect = MqttClient.connect }) {
  const config = iotConfig(await call("GET", "/prod-vision/iot-client-creds"));
  const { getAuthorizationToken } = auth ?? await toolkit();
  const idToken = await getAuthorizationToken({ profileName: profile });
  const creds = await identityCredentials(config, idToken, { fetchImpl });
  const url = presignIotUrl({ endpoint: config.endpoint, region: config.region, credentials: creds });
  const client = await connect({ url, clientId: `${creds.identityId}-agent-${randomUUID().slice(0, 8)}` });
  return { client, identityId: creds.identityId, clientAccess: config.clientAccess ?? null };
}

async function withIot(scope, ds, fn) {
  let session;
  try {
    session = await (scope.connectIot ?? connectIot)(scope);
  } catch (error) {
    const links = liveLinks(scope.profile, ds, { origin: scope.origin, livePage: scope.livePage });
    if (error instanceof IotError && error.code === "not_authorized") throw unavailable(ds, links, "the identity pool or IoT policy refused it");
    if (error?.status === 401 || error?.status === 403) throw unavailable(ds, links, `Zira returned HTTP ${error.status} for IoT access`);
    throw error;
  }
  try {
    return await fn(session.client, session);
  } catch (error) {
    if (error instanceof IotError && error.code === "not_authorized")
      throw unavailable(ds, liveLinks(scope.profile, ds, { origin: scope.origin, livePage: scope.livePage }), error.message);
    throw error;
  } finally {
    session.client.close();
  }
}

const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// Collects messages on the given filters for up to ms, ending early when done() says so
// or the signal aborts. subscribe: false when the caller already subscribed.
async function collect(client, filters, ms, { done, onMessage, signal, subscribe = true } = {}) {
  const seen = [];
  let finish, onClose;
  const ended = new Promise(r => { finish = r; });
  const closed = new Promise((_, reject) => { onClose = reject; client.once("close", onClose); });
  closed.catch(() => {});
  const handler = m => {
    if (!filters.some(f => topicMatches(f, m.topic))) return;
    seen.push(m);
    onMessage?.(m);
    if (done?.(seen)) finish();
  };
  client.on("message", handler);
  try {
    if (subscribe) await client.subscribe(filters);
    await Promise.race([ended, sleep(ms, signal), closed]);
  } finally {
    client.off("message", handler);
    client.off("close", onClose);
  }
  return seen;
}

// ---- Reads ----

// Paired Android devices that announce presence on the data source's topics (every 10 s, retained 30 s).
export async function discover(client, base, { seconds = 12 } = {}) {
  const filter = `${base}/+/status`;
  // Presence repeats every 10 s; once one camera answered, give the others 2.5 s more.
  const settle = new AbortController();
  let timer = null;
  const seen = await collect(client, [filter], seconds * 1000, { signal: settle.signal, onMessage: m => {
    if (timer === null && STATUS_TOPICS.presence.match(m.json)) timer = setTimeout(() => settle.abort(), 2500);
  } });
  clearTimeout(timer);
  const byIdentity = new Map();
  for (const m of seen) {
    if (!STATUS_TOPICS.presence.match(m.json)) continue;
    const identity = m.topic.split("/")[3]?.replace(/^identities-/, "");
    if (!IDENTITY.test(identity ?? "")) continue;
    // Presence is retained for only 30 s, so any copy seen now is current; Vision-App sends no timestamp.
    const s = statusSummary("presence", m.json);
    const seenAt = s.at ?? new Date(m.receivedAt).toISOString();
    const prior = byIdentity.get(identity);
    if (!prior || seenAt >= prior.seenAt) byIdentity.set(identity, { identity, ...s, seenAt });
  }
  return [...byIdentity.values()].map(d => ({ ...d, online: d.connected }))
    .sort((a, b) => Number(b.online) - Number(a.online) || b.seenAt.localeCompare(a.seenAt));
}

export function chooseIdentity(devices, wanted) {
  if (wanted) {
    if (!IDENTITY.test(wanted)) throw new Error("--identity must be a camera identity such as us-west-2:…");
    return wanted;
  }
  const online = devices.filter(d => d.online);
  if (online.length === 1) return online[0].identity;
  if (!devices.length)
    throw new Blocked("no_device", "No paired camera announced itself on this data source in the last few seconds. Check that the camera is on, paired and online.");
  if (!online.length)
    throw new Blocked("offline", "The paired camera is not online right now.", { devices });
  throw new Blocked("choose_device", "Several paired cameras are online on this data source; choose one.", {
    devices: online,
    question: { header: "Camera", question: "Which paired camera?", multiSelect: false,
      options: online.slice(0, 4).map(d => ({ label: (d.deviceName || d.model || d.identity).slice(0, 60), description: `${d.model ?? "Android device"} · seen ${d.seenAt}`, value: d.identity })) },
  });
}

export async function statusSnapshot(client, ds, identity, { seconds = 5 } = {}) {
  const kind = deviceKind(ds);
  const kinds = Object.entries(STATUS_TOPICS).filter(([k, t]) => k !== "settingsStatus" && (!t.types || t.types.includes(kind)));
  const topics = Object.fromEntries(kinds.map(([k]) => [k, statusTopic(ds, identity, k)]));
  const seen = await collect(client, [...new Set(Object.values(topics))], seconds * 1000);
  const out = {};
  for (const [k, t] of kinds) {
    const last = seen.filter(m => m.topic === topics[k] && m.json && (!t.match || t.match(m.json))).at(-1);
    out[k] = last ? { label: t.label, retained: last.retain, ...statusSummary(k, last.json) } : { label: t.label, reported: false };
  }
  return out;
}

// Streams live data while sending the watcher heartbeat the camera needs to keep publishing.
export async function watchLive(client, base, identity, { seconds = 60, onMessage, signal, heartbeatMs = HEARTBEAT_MS, names = {} } = {}) {
  const topic = identityTopic(base, identity, "live-data");
  const watchers = identityTopic(base, identity, "live-data-watchers");
  const beat = () => client.publish(watchers, { online: true }, { qos: 1, messageExpiry: 60 });
  const timer = setInterval(() => beat().catch(() => {}), heartbeatMs);
  timer.unref?.();
  const messages = [];
  try {
    // Subscribe first, then announce the watcher, so the camera's immediate snapshot is caught.
    await client.subscribe([topic]);
    const pending = collect(client, [topic], seconds * 1000, { signal, subscribe: false, onMessage: m => {
      const s = liveSummary(m.json, names);
      if (!s) return;
      s.at ??= new Date(m.receivedAt).toISOString();
      messages.push(s);
      onMessage?.(s, m);
    } });
    await beat();
    await pending;
  } finally {
    clearInterval(timer);
  }
  return summarizeLive(messages, seconds);
}

export function summarizeLive(messages, seconds) {
  const fresh = messages.filter(m => m.at).sort((a, b) => a.at.localeCompare(b.at));
  const first = fresh[0], last = fresh.at(-1);
  const delta = k => first && last && Number.isFinite(first[k]) && Number.isFinite(last[k]) ? last[k] - first[k] : null;
  const statuses = [];
  for (const m of fresh) if (m.status !== statuses.at(-1)?.status) statuses.push({ at: m.at, status: m.status });
  return { seconds, messages: messages.length, ...(first ? { firstAt: first.at, lastAt: last.at } : {}),
    unitsChange: delta("units"), shiftCountChange: delta("shiftCount"), statusChanges: statuses.slice(0, 20), latest: last ?? null,
    ...(messages.length ? {} : { note: "No live data arrived. The camera may be offline, still starting, or not streaming live data for this data source." }) };
}

// ---- Commands ----

// A reply names the request; sampling replies may not, so a live state change after sending counts.
const correlated = (action, requestId, sentAt) => m => {
  const json = m?.json ?? m;
  if (action.correlation === "settingsReason") return String(json?._reason ?? "").includes(requestId);
  if (String(json?.requestId ?? "") === requestId) return true;
  return action.correlation === "stateAfter" && !!m?.receivedAt && !m.retain && m.receivedAt >= sentAt &&
    !json?.requestId && String(json?.state ?? "").toLowerCase() === action.expect.toLowerCase();
};

// The route's own refusals, in words; nothing was sent to the camera in any of them.
const REFUSALS = {
  forbidden: ["forbidden", "You can see this camera but cannot manage its site, so Zira did not send the command. A site manager can send it."],
  action_not_enabled: ["not_enabled", "Zira has not enabled this action for chat yet; use the Remote Control tab."],
  action_not_supported: ["not_supported", "This camera type does not support this action."],
  identity_required: ["no_device", "Zira needs the paired camera for this action; rerun with --identity."],
};
function refusal(error, action) {
  const [reason, message] = REFUSALS[error?.details] ?? [];
  return reason && [400, 403].includes(error.status) ? new Blocked(reason, `${action.label}: ${message}`, { status: error.status }) : null;
}

export async function runCommand(scope, ds, { identity, action: name, params, apply = false, waitSeconds = 30, resolvePending, allowRepeat = false }) {
  const action = ACTIONS[name];
  const values = actionParams(name, params ?? {}, deviceKind(ds));
  const preview = { dataSource: { id: ds.id, name: ds.name, site: ds.site.name }, camera: identity ?? "the only online paired camera",
    action: name, label: action.label, params: values, ...(action.effect ? { effect: action.effect } : {}),
    reply: STATUS_TOPICS[action.status]?.label ?? null };
  if (!apply) return { kind: "remote-command-draft", profile: scope.profile, applied: false, preview,
    ...liveLinks(scope.profile, ds, { identity, origin: scope.origin, livePage: scope.livePage }),
    next: "Show this preview and wait for the user's explicit approval before running it again with --apply." };
  const base = deviceBase(ds);
  return withIot(scope, ds, async client => {
    const camera = chooseIdentity(identity ? [] : await discover(client, base), identity);
    const links = liveLinks(scope.profile, ds, { identity: camera, origin: scope.origin, livePage: scope.livePage });
    const replyTopic = statusTopic(ds, camera, action.status);
    const replies = [];
    const onReply = m => { if (m.topic === replyTopic && m.json) replies.push(m); };
    client.on("message", onReply);
    try {
      await client.subscribe([replyTopic]);
      const requestId = `agent-${ds.id}-${name.replace(/\./g, "-")}-${randomUUID()}`;
      let sentAt = Date.now();
      const result = await guardedWrite({
        file: receiptsFile(scope.receipts), key: `remote:${scope.profile}:${ds.id}:${camera}:${name}:${fingerprint(values)}`,
        allowRepeat, resolve: resolvePending, summary: `${action.label} on ${ds.name} (${camera})`,
        // An earlier attempt whose outcome was unknown is settled by the camera's own reply.
        reconcile: async prior => replies.some(correlated(action, prior.requestId, Date.parse(prior.at))) ? { requestId: prior.requestId } : null,
        run: async () => {
          sentAt = Date.now();
          const sent = (await scope.call("POST", `/prod-vision/${ds.id}/remote-commands`, { action: name, identity: camera, requestId, params: values })
            .catch(error => { throw refusal(error, action) ?? error; }))?.data ?? {};
          return { receipt: { requestId, sentAt: new Date().toISOString(), topic: sent.topic ?? null } };
        },
      });
      if (result.state !== "created") return { kind: "remote-command", applied: false, ...result, preview: { ...preview, camera }, ...links };
      const match = correlated(action, requestId, sentAt);
      const deadline = Date.now() + waitSeconds * 1000;
      let reply;
      while (!(reply = replies.find(match)) && Date.now() < deadline) await sleep(250);
      const failed = reply && /error|fail/i.test(String(reply.json.state ?? ""));
      return { kind: "remote-command", applied: true, requestId, preview: { ...preview, camera }, ...links,
        state: reply && !failed ? "verified" : "unverified", verified: !!reply && !failed,
        ...(reply ? { reply: statusSummary(action.status, reply.json) } : {
          note: `Zira sent the command, but the camera posted no matching status within ${waitSeconds} s. Check the live page or rerun status; do not resend it.` }) };
    } finally {
      client.off("message", onReply);
    }
  });
}

// ---- CLI ----

async function resolveDevice(scope, o) {
  let deviceId = o["device-id"];
  if (o.url) {
    const parsed = parseZiraUrl(o.url);
    deviceId = parsed.deviceId;
    if (parsed.profile && parsed.profile !== scope.profile) throw new Error(`The link is for ${parsed.profile}; rerun with --profile ${parsed.profile}`);
    if (parsed.webOrigin) scope.origin = parsed.webOrigin;
  }
  return loadLiveDevice(scope.call, deviceId);
}

const parseParams = raw => {
  if (raw === undefined) return {};
  try { return JSON.parse(raw); } catch { throw new Blocked("invalid_params", "--params must be valid JSON"); }
};

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    url: { type: "string" }, "device-id": { type: "string" }, identity: { type: "string" }, place: { type: "string" }, source: { type: "string" },
    seconds: { type: "string" }, jsonl: { type: "boolean" }, autostart: { type: "string" }, launch: { type: "boolean" }, all: { type: "boolean" },
    action: { type: "string" }, params: { type: "string" }, apply: { type: "boolean" }, wait: { type: "string" },
    "resolve-pending": { type: "string" }, "allow-repeat": { type: "boolean" }, receipts: { type: "string" }, profile: { type: "string" }, "web-origin": { type: "string" },
  } });
  if (args[0] === "actions") return { kind: "remote-actions", actions: listActions({ all: !!o.all }) };
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const seconds = (dflt, max) => {
    const n = o.seconds === undefined ? dflt : Number(o.seconds);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--seconds must be 1 to ${max}`);
    return n;
  };
  const scope = { call: await liveSession(profile, { allow: ROUTES }), profile, receipts: o.receipts,
    origin: o["web-origin"] ? webOrigin(profile, o["web-origin"]) : undefined };
  const livePage = () => livePageAvailable(scope.origin ?? originFor(profile)).then(ok => { scope.livePage = ok; });
  if (args[0] === "find") {
    await livePage();
    const found = await findSource({ ...scope, origin: scope.origin ?? originFor(profile), place: o.place, source: o.source, withDatasets: false });
    const items = found.items.map(i => ({ ...i, ...liveLinks(profile, i, { origin: scope.origin, livePage: scope.livePage }), url: undefined }));
    return { ...found, kind: "live-find", items, datasets: undefined };
  }
  const ds = await resolveDevice(scope, o);
  await livePage();
  if (args[0] === "open") {
    const links = liveLinks(profile, ds, { identity: o.identity, autostart: o.autostart !== "0", origin: scope.origin, livePage: scope.livePage });
    const launched = o.launch ? await launchBrowser(links.liveUrl) : false;
    return { kind: "live-open", profile, dataSource: ds, ...links, launched,
      note: "Opening the live page starts the camera's live view for this viewer only; it does not record or change the camera." };
  }
  if (args[0] === "devices")
    return withIot(scope, ds, async client => ({ kind: "live-devices", profile, dataSource: ds,
      devices: await discover(client, deviceBase(ds), { seconds: seconds(12, 30) }) }));
  if (args[0] === "status")
    return withIot(scope, ds, async client => {
      const identity = chooseIdentity(o.identity ? [] : await discover(client, deviceBase(ds)), o.identity);
      return { kind: "live-status", profile, dataSource: ds, camera: identity,
        status: await statusSnapshot(client, ds, identity, { seconds: seconds(5, 30) }),
        ...liveLinks(profile, ds, { identity, origin: scope.origin, livePage: scope.livePage }) };
    });
  if (args[0] === "watch") {
    const emit = o.jsonl ? line => process.stdout.write(`${JSON.stringify(line)}\n`) : () => {};
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    try {
      const result = await withIot(scope, ds, async client => {
        const identity = chooseIdentity(o.identity ? [] : await discover(client, deviceBase(ds)), o.identity);
        emit({ type: "start", dataSource: { id: ds.id, name: ds.name, site: ds.site.name }, camera: identity, ...liveLinks(profile, ds, { identity, origin: scope.origin, livePage: scope.livePage }) });
        const summary = await watchLive(client, deviceBase(ds), identity, { seconds: seconds(60, 3600), signal: controller.signal,
          names: ds.metricNames, onMessage: s => emit({ type: "live", ...s }) });
        return { kind: "live-watch", profile, dataSource: ds, camera: identity, summary, ...liveLinks(profile, ds, { identity, origin: scope.origin, livePage: scope.livePage }) };
      });
      if (o.jsonl) { emit({ type: "end", summary: result.summary }); return undefined; }
      return result;
    } catch (error) {
      // The panel reads the error line; the CLI's own blocked JSON and exit code follow.
      if (o.jsonl) emit({ type: "error", ...(error instanceof Blocked ? { blocked: error.reason, ...error.details } : {}), message: error.message });
      throw error;
    }
  }
  if (args[0] === "command") {
    const wait = o.wait === undefined ? 30 : Number(o.wait);
    if (!Number.isInteger(wait) || wait < 5 || wait > 120) throw new Error("--wait must be 5 to 120 seconds");
    if (!o.action) throw new Error("--action is required; run actions to list them");
    if (o.identity !== undefined && !IDENTITY.test(o.identity)) throw new Error("--identity must be a camera identity such as us-west-2:…");
    return runCommand(scope, ds, { identity: o.identity, action: o.action, params: parseParams(o.params), apply: !!o.apply,
      waitSeconds: wait, resolvePending: o["resolve-pending"], allowRepeat: !!o["allow-repeat"] });
  }
  throw new Error("Choose find, open, devices, status, watch, actions or command");
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => ({ prompt: "open the live view of my camera" }),
  });
