#!/usr/bin/env node
// Push models to Zira Vision and Pallet Vision cameras from chat. upload adds a local model file to
// the data source's models, as zira-web's Models upload does; push asks Zira to send the paired camera
// one guarded syncModel for a slot and confirms it by the slot fingerprint the camera then reports.
// Zira checks both writes against the user's site rights (admins: every site) and audits each push.
// Writes preview by default; --apply sends once and records a receipt.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Blocked, ZiraApiError, annotateReceipt, argValue, fingerprint, guardedWrite, id, isMain, liveSession, originFor, receiptsFile, route, runCli } from "./client.mjs";
import { downloadUrl, fetchDownload } from "./downloads.mjs";
import { parseZiraUrl, webOrigin } from "./datasets.mjs";
import { ROUTES as REMOTE_ROUTES, chooseIdentity, collect, deviceBase, discover, identityTopic, liveLinks, loadLiveDevice, statusTopic, withIot } from "./remote.mjs";

const HELP = `Push models to Zira Vision / Pallet Vision cameras
node scripts/models.mjs list (--url ZIRA_URL | --device-id ID) [--identity ID]
node scripts/models.mjs upload (--url | --device-id ID) --file MODEL.tflite [--image-size N] [--apply]
node scripts/models.mjs push (--url | --device-id ID) --role SLOT (--model-id ID | --model NAME)
    [--image-size N] [--identity ID] [--expected-current SHA256 | --expect-empty] [--apply] [--wait 600]
Common: --profile prod|integ   --receipts FILE   --resolve-pending none

list reads the camera's models in Zira and, when its paired camera is online, the model in each
slot. upload adds a .tflite/.pt file (at most 100 MB) to the data source's models. push sends the
camera one model for one slot through Zira's audited remote-commands API and watches until the
camera reports that slot with the model's SHA-256 (up to --wait seconds, default 10 minutes).
Some cameras answer minutes late: no answer in time is "pending", not failed. While a push is
pending (15 minutes from the send, or --wait if longer), rerunning the same command sends nothing
and keeps watching. A first push into an empty slot needs a camera that lists the slot as empty,
and applies with --expect-empty instead of --expected-current.
Input size: --image-size when the user gave one, else the size in the file name, else the size
Zira records; with none, push stops and asks.
Zira allows both writes only at sites the user can manage (Zira admins: every site).
Exit 0 success, 2 invalid/failed, 3 sent and still pending, 4 blocked (JSON explains).
`;

export const ROUTES = [...REMOTE_ROUTES, ["GET", /^\/files\/[1-9]\d*$/], ["POST", /^\/files\/signed-uploads\/create$/]];
export const MAX_MODEL_BYTES = 100 * 1024 * 1024; // platform fileUpload guard and zira-web MAX_MODEL_FILE_SIZE
export const IMAGE_SIZE = { min: 32, max: 4096 };
const SHA256 = /^[a-f0-9]{64}$/;
// What Vision-App reports for a slot that holds no model: the SHA-256 of no bytes
// (ModelInventory.EMPTY_SLOT_SHA256). Its push guard compares it like any other fingerprint.
export const EMPTY_SLOT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ROLE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const S3_HOST = /\.amazonaws\.com$/;
// Milton Cam 57 answered model commands ~5 minutes late (2026-11-11) and still installed the model.
// apply watches for 10 minutes by default; the push counts as pending for 15 minutes from the send
// (or the chosen --wait, if longer), so a rerun soon after a pending result watches instead of sending.
export const WAIT_SECONDS = 600;
export const PENDING_SECONDS = 900;
const MODEL_FILE = /^[^/\\\u0000-\u001f]{1,200}\.(tflite|pt)$/i;

// ---- Input size ----

// Sizes written into a model's file name: whole numbers that are multiples of 32, like 320 in
// "nails_int8_320_b1.tflite". A name with two different ones (or none) does not say.
export function sizeFromName(name) {
  const found = new Set((String(name ?? "").match(/(?<!\d)\d{3,4}(?!\d)/g) ?? []).map(Number)
    .filter(n => n % 32 === 0 && n >= 96 && n <= IMAGE_SIZE.max));
  return found.size === 1 ? [...found][0] : undefined;
}
const originProperty = (origin, key) => {
  let value = origin;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  if (Array.isArray(value)) return value.find(e => String(e?.key).toLowerCase() === key.toLowerCase())?.value;
  return value && typeof value === "object" ? value[key] : undefined;
};
// The size Zira records for a model file, in zira-web's order (registry row, then originProperties).
export function recordedSize(row) {
  for (const v of [row?.visionModel?.imageSize, originProperty(row?.originProperties, "imageSize"), originProperty(row?.originProperties, "resolution"), row?.imageSize]) {
    const n = Number(v);
    if (v !== null && v !== "" && Number.isInteger(n) && n >= IMAGE_SIZE.min && n <= IMAGE_SIZE.max) return n;
  }
  return undefined;
}
const sizeArg = value => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < IMAGE_SIZE.min || n > IMAGE_SIZE.max) throw new Blocked("invalid_params", `--image-size must be a whole number from ${IMAGE_SIZE.min} to ${IMAGE_SIZE.max}`);
  return n;
};
// Noah's rule (2026-10-27): the user's answer, else the file name, else the recorded size, else ask.
export function imageSizeFor(name, row, given) {
  const fromName = sizeFromName(name), recorded = row ? recordedSize(row) : undefined, user = sizeArg(given);
  const imageSize = user ?? fromName ?? recorded;
  const source = user !== undefined ? "user" : fromName !== undefined ? "name" : recorded !== undefined ? "recorded" : null;
  const conflict = fromName !== undefined && recorded !== undefined && fromName !== recorded
    ? `The file name says ${fromName} but Zira records ${recorded}; ${source === "user" ? `using the user's ${imageSize}` : `using ${fromName} from the name unless the user says otherwise`}.` : undefined;
  return { imageSize, source, fromName, recorded, ...(conflict ? { conflict } : {}) };
}
const needSize = (name, extra = {}) => new Blocked("image_size_needed",
  `Neither the name of ${name} nor Zira says which input size it was trained for. Ask the user, then rerun with --image-size. A wrong size makes the camera detect poorly while reporting success.`,
  { ...extra, question: { header: "Input size", question: `Which input size was ${name} trained and exported at?`, multiSelect: false,
    options: [{ label: "320", description: "Typical for tracking and nail models" }, { label: "640", description: "Mid-size detection models" },
      { label: "1024", description: "Typical for quality inspection models" }] } });

// ---- Zira inventory ----

async function loadModels(call, deviceId) {
  const d = (await call("GET", route("/devices/all", { meterIds: deviceId, expand: "true" }))).data?.[0];
  return Array.isArray(d?.cv?.models) ? d.cv.models : [];
}
const stemOf = name => path.parse(String(name)).name.replaceAll(" ", "_");
export const describeModel = row => {
  const size = imageSizeFor(row.name, row);
  return { id: String(row.id), name: String(row.name), sizeBytes: Number.isInteger(row.fileSize) ? row.fileSize : null, createdAt: row.createdDate ?? null,
    imageSize: size.imageSize ?? null, imageSizeFrom: size.source, ...(size.conflict ? { imageSizeNote: size.conflict } : {}) };
};
// The exact model the camera will download: unique on the data source, a .tflite with its byte size.
export function targetModel(rows, { modelId, model }) {
  const matches = rows.filter(r => modelId !== undefined ? String(r?.id) === String(modelId) : r?.name === model);
  if (matches.length !== 1)
    throw new Blocked("model_not_found", matches.length ? `Several models are named ${model}; choose one by --model-id.` : `That model is not on this camera's Models list in Zira.`,
      { models: rows.slice(-20).map(describeModel) });
  const row = matches[0];
  if (rows.filter(r => r?.name === row.name).length !== 1)
    throw new Blocked("ambiguous_model", `Two models on this camera are named ${row.name}; the camera downloads by name, so rename or remove one in Zira first.`);
  if (!/\.tflite$/i.test(String(row.name))) throw new Blocked("not_device_model", `${row.name} is not a .tflite export; cameras run .tflite models.`);
  if (!Number.isInteger(row.fileSize) || row.fileSize < 1) throw new Blocked("model_incomplete", `Zira has no byte size for ${row.name}; it may still be uploading.`);
  return row;
}

// ---- Camera slots ----

// The paired camera's presence message lists its model slots with each file's SHA-256. A slot listed
// with the empty fingerprint holds no model yet and can take a guarded first push.
export function slotsFrom(presence) {
  return (Array.isArray(presence?.models) ? presence.models : []).filter(m => typeof m?.role === "string").map(m => {
    const sha256 = SHA256.test(String(m.sha256 ?? "")) ? m.sha256 : null;
    return { role: m.role, fileName: typeof m.fileName === "string" ? m.fileName : null, inputSize: Number.isInteger(m.inputSize) ? m.inputSize : null,
      available: m.available !== false, sha256, sizeBytes: Number.isInteger(m.sizeBytes) ? m.sizeBytes : null,
      ...(sha256 === EMPTY_SLOT_SHA256 ? { empty: true } : {}),
      ...(typeof m.purpose === "string" ? { purpose: m.purpose.slice(0, 120) } : {}) };
  });
}
// The camera's settings report (retained settings-state) names every slot its build installs, empty ones
// included: <role>.model ("" when empty), <role>.bytes and <role>.installedAt, the keys zira-web's Push to
// device dialog offers slots from (Vision-App ModelInventory.slotValues). It says nothing about the guard.
export function reportedSlots(state) {
  const values = state?.settings && typeof state.settings === "object" && !Array.isArray(state.settings) ? state.settings : {};
  const slots = [];
  for (const [key, model] of Object.entries(values)) {
    const role = key.endsWith(".model") ? key.slice(0, -".model".length) : "";
    if (!ROLE.test(role)) continue;
    const bytes = Number(values[`${role}.bytes`]), installedAt = values[`${role}.installedAt`];
    slots.push({ role, model: typeof model === "string" ? model.slice(0, 200) : "", bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0,
      installedAt: typeof installedAt === "string" && installedAt ? installedAt.slice(0, 40) : null });
  }
  return { reportedAt: Number.isFinite(state?._ts) ? new Date(state._ts).toISOString() : null, slots };
}
const isPresence = m => m?.json && !m.json.kind && Array.isArray(m.json.models);
async function readSlots(client, ds, identity, seconds = 12) {
  const topic = identityTopic(deviceBase(ds), identity, "status");
  const seen = await collect(client, [topic], seconds * 1000, { done: s => s.some(isPresence) });
  const last = seen.filter(isPresence).at(-1);
  return last ? slotsFrom(last.json) : null;
}
// The settings report is retained, so it arrives on subscribe when the camera ever published one.
async function readReported(client, ds, identity, seconds = 3) {
  const isState = m => m?.json && typeof m.json.settings === "object";
  const seen = await collect(client, [statusTopic(ds, identity, "settings")], seconds * 1000, { done: s => s.some(isState) });
  const last = seen.filter(isState).at(-1);
  return last ? reportedSlots(last.json) : null;
}
// Roles the settings report names that presence does not list: empty ones cannot take a guarded push.
const unlisted = (slots, reported) => (reported?.slots ?? []).filter(r => !slots.some(s => s.role === r.role))
  .map(r => ({ ...r, empty: !r.model && !r.bytes }));
function slotOf(slots, role, reported) {
  if (!slots) throw new Blocked("slots_unknown", "The camera did not report its model slots in time. Check that it is on and online, then try again; nothing was sent.");
  const slot = slots.find(s => s.role === role);
  const named = slot ? undefined : unlisted(slots, reported).find(r => r.role === role);
  if (named?.empty)
    throw new Blocked("empty_slot_unlisted", `The camera has an empty ${role} slot, but it does not list the slot as empty in its live status, so it cannot check the slot before installing and refuses a guarded push. Nothing was sent. Use Push to device on the camera's Models tab in Zira for this first push; later pushes to the slot work from chat.`,
      { slots: slots.map(s => s.role), reported: named, reportedAt: reported.reportedAt });
  if (named)
    throw new Blocked("slot_unverifiable", `The camera's settings report ${named.model || "a model"} in its ${role} slot, but its live status does not list the slot with a fingerprint, so a guarded push cannot check what it replaces. Use Push to device on the camera's Models tab in Zira.`,
      { slots: slots.map(s => s.role), reported: named, reportedAt: reported.reportedAt });
  if (!slot) throw new Blocked("slot_not_found", `The camera has no "${role}" slot right now. A slot is listed only while its stage is enabled (nails: detection.nailModelEnabled).`,
    { slots: slots.map(s => s.role) });
  if (!slot.sha256) throw new Blocked("slot_unverifiable", `The camera reports no fingerprint for its ${role} slot, so a guarded push cannot check what it replaces. Use Push to device on the camera's Models tab in Zira.`, { slot });
  return slot;
}

// The camera stores each slot under its own file name, so the model it runs now is found in Zira's
// list by byte size: a hint for undoing the push, not proof. An empty slot has no model to push back.
export function previousModel(rows, slot, role) {
  if (slot.empty) return { modelId: null, empty: true,
    note: `The ${role} slot is empty now, so there is no earlier model to push back and this helper cannot empty it again. To undo, push another model to the slot the same way, or turn off the stage that uses it.` };
  const same = slot.sizeBytes ? rows.filter(r => /\.tflite$/i.test(String(r?.name)) && r.fileSize === slot.sizeBytes) : [];
  return same.length === 1
    ? { modelId: String(same[0].id), name: same[0].name, matchedBy: "byte size", note: `To undo, push ${same[0].name} back to the ${role} slot the same way.` }
    : { modelId: null, note: `Zira's list has ${same.length ? "several models" : "no model"} matching the file the ${role} slot runs now, so the undo model is unknown. Keep a copy of the current model before pushing if it may be needed again.` };
}

// ---- Files ----

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// The model's SHA-256 from its Zira download, so the slot readback can be compared.
async function sha256Model(call, row, fetchImpl = globalThis.fetch) {
  let url;
  try { url = (await call("GET", `/files/${row.id}`))?.data?.file; }
  catch (error) {
    if (error instanceof ZiraApiError && [401, 403].includes(error.status))
      throw new Blocked("download_not_enabled", `Zira did not let this sign-in download ${row.name} (HTTP ${error.status}), so the push could not be verified; nothing was sent.`);
    throw error;
  }
  const response = await fetchDownload(downloadUrl(url, { allowShortLinks: true }).href, { fetchImpl, allowShortLinks: true, maxRedirects: 5, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download of ${row.name} failed (HTTP ${response.status})`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== row.fileSize) throw new Error(`Download of ${row.name} was ${bytes} bytes, but Zira lists ${row.fileSize}`);
  return hash.digest("hex");
}

// ---- Refusals ----

const REFUSALS = {
  forbidden: ["forbidden", "Zira lets you push models only to cameras at sites you can manage (Zira admins: any site). Nothing was sent; a site manager can push it."],
  model_not_found: ["model_not_found", "Zira does not list that model on this camera any more. Nothing was sent; refresh the list."],
  model_changed: ["model_changed", "The model changed in Zira since the preview. Nothing was sent; preview again."],
  ambiguous_model: ["ambiguous_model", "Two models on this camera share that name. Nothing was sent; rename or remove one in Zira."],
  action_not_enabled: ["not_enabled", "Zira has not enabled model pushes from chat. Nothing was sent; use Push to device on the Models tab."],
};
const refusal = error => {
  const [reason, message] = REFUSALS[error?.details] ?? (error?.status === 403 ? REFUSALS.forbidden : []);
  return reason && [400, 403, 404].includes(error?.status) ? new Blocked(reason, message, { status: error.status }) : null;
};

// ---- Pending pushes ----

// A sent push stays pending until the camera reports the model or an error, or its window ends.
// Receipts written before pendingUntil existed count from the send.
export const pendingUntil = receipt => {
  const until = Date.parse(receipt?.pendingUntil ?? "");
  if (Number.isFinite(until)) return until;
  const sent = Date.parse(receipt?.sentAt ?? receipt?.doneAt ?? receipt?.at ?? "");
  return Number.isFinite(sent) ? sent + PENDING_SECONDS * 1000 : 0;
};
// The same push may be sent again only once the camera refused it or its pending window ended.
export const mayResend = (receipt, now = Date.now()) => receipt?.outcome === "failed" || now >= pendingUntil(receipt);
const iso = ms => new Date(ms).toISOString();
// The camera's answer is added to the receipt when the shared receipts lock is free within a
// second or so. Without it the push still reports what the camera said, and the receipt simply
// stays pending until its window ends.
async function recordOutcome(file, key, fields, match, { tries = 5, pauseMs = 250 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await annotateReceipt(file, key, fields, match); }
    catch (error) {
      if (error?.reason !== "busy" || attempt >= tries) return null;
      await new Promise(r => setTimeout(r, pauseMs));
    }
  }
}

// ---- Commands ----

export async function list(scope, ds, { identity } = {}) {
  const rows = await loadModels(scope.call, ds.id);
  const models = rows.filter(r => MODEL_FILE.test(String(r?.name ?? ""))).sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate))).slice(0, 40).map(describeModel);
  let camera = null, note;
  try {
    camera = await withIot(scope, ds, async client => {
      const chosen = chooseIdentity(identity ? [] : await discover(client, deviceBase(ds)), identity);
      const slots = await readSlots(client, ds, chosen);
      const others = slots ? unlisted(slots, await readReported(client, ds, chosen)) : [];
      return { identity: chosen, slots, ...(others.length ? { unlisted: others,
        unlistedNote: "The camera's settings name these slots, but its live status does not list them with a fingerprint, so pushes to them go through Push to device on the Models tab in Zira." } : {}) };
    });
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    note = `Camera slots not read: ${error.message}`;
  }
  return { kind: "camera-models", dataSource: { id: ds.id, name: ds.name, site: ds.site.name }, models, camera, ...(note ? { note } : {}),
    modelsUrl: `${scope.origin ?? originFor(scope.profile)}${route(`/data-sources/${ds.id}`, { viewMode: "vision", tab: "models" })}` };
}

export async function upload(scope, ds, { file, imageSize: given, apply = false, resolvePending,
  fetchImpl = globalThis.fetch, blob = openAsBlob, poll = { everyMs: 5000, maxMs: 5 * 60 * 1000 },
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now() }) {
  const full = path.resolve(String(file ?? ""));
  const name = path.basename(full), fileType = path.extname(name).slice(1).toLowerCase();
  if (!existsSync(full) || !MODEL_FILE.test(name)) throw new Error("--file must be an existing .tflite or .pt model file with a plain name");
  const size = (await stat(full)).size;
  if (!size || size > MAX_MODEL_BYTES) throw new Blocked("file_too_large", `Zira accepts model files up to 100 MB; ${name} is ${Math.round(size / 1048576)} MB.`);
  const sizing = imageSizeFor(name, null, given);
  if (fileType === "tflite" && sizing.imageSize === undefined) throw needSize(name);
  const existing = (await loadModels(scope.call, ds.id)).find(r => stemOf(r?.name) === stemOf(name));
  const preview = { camera: { id: ds.id, name: ds.name, site: ds.site.name }, file: full, name, sizeBytes: size,
    imageSize: sizing.imageSize ?? null, imageSizeFrom: sizing.source };
  if (existing) return { kind: "model-upload", applied: false, state: "already-listed", model: describeModel(existing), preview,
    note: "A model with this name is already on the camera's list; push that one or rename the file. Nothing was uploaded." };
  if (!apply) return { kind: "model-upload-draft", applied: false, preview,
    next: "Show this preview and wait for the user's approval before running it again with --apply." };
  const sha = await sha256File(full);
  return guardedWrite({
    file: receiptsFile(scope.receipts), key: `model-upload:${scope.profile}:${ds.id}:${fingerprint({ name, sha })}`, resolve: resolvePending,
    summary: `Upload ${name} to ${ds.name}`,
    reconcile: async () => {
      const row = (await loadModels(scope.call, ds.id)).find(r => stemOf(r?.name) === stemOf(name));
      return row ? { modelId: String(row.id) } : null;
    },
    run: async progress => {
      const startedAt = Date.now();
      let form;
      try {
        form = (await scope.call("POST", "/files/signed-uploads/create", {
          site: { id: String(ds.site.id) }, company: { id: String(ds.companyId) }, name, fileMimeType: "application/octet-stream", fileType, fileSize: size,
          // Zira's schema wants the IDs as strings: a numeric deviceId is refused with HTTP 400 [01-007] "must be string".
          deviceId: String(ds.id), assetType: "model", fileSizeLoose: false,
          originProperties: { source: "zira-plugin-models", ...(sizing.imageSize !== undefined ? { imageSize: sizing.imageSize } : {}) },
        }))?.data;
      } catch (error) {
        if (error instanceof ZiraApiError && error.status === 403)
          throw new Blocked("forbidden", "Zira lets you add models only to cameras at sites you can manage (Zira admins: any site). Nothing was uploaded.");
        throw error;
      }
      const target = (() => { try { return new URL(form?.signedUrl?.url); } catch { return null; } })();
      if (!target || target.protocol !== "https:" || !S3_HOST.test(target.hostname) || typeof form?.signedUrl?.fields !== "object")
        throw new Blocked("upload_not_enabled", "Zira returned no usable upload form; nothing was uploaded.");
      const body = new FormData();
      for (const [k, v] of Object.entries(form.signedUrl.fields)) body.append(k, String(v));
      body.append("file", await blob(full), name);
      // Persist before sending bytes: a disconnect or later read/admission denial
      // cannot prove that storage did not accept the upload.
      await progress({ uploadStarted: true });
      const sent = await fetchImpl(target.href, { method: "POST", body });
      if (!sent.ok) throw new Error(`Upload to storage failed (HTTP ${sent.status})`);
      // Zira lists the file on the camera once the upload completes in storage.
      // Pacing and read time count toward the polling budget as well as sleeps.
      const deadline = now() + poll.maxMs;
      for (let waited = 0; waited <= poll.maxMs; waited += poll.everyMs) {
        if (waited > 0 && now() >= deadline) break;
        const row = (await loadModels(scope.call, ds.id)).find(r => stemOf(r?.name).includes(stemOf(name)) && Date.parse(r.createdDate ?? 0) >= startedAt - 60000);
        if (row) return { receipt: { modelId: String(row.id) }, model: describeModel(row) };
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(poll.everyMs, remaining));
      }
      throw new Error("The file was uploaded, but Zira has not listed it on the camera yet; check the Models tab before uploading again");
    },
  }).catch(error => {
    if (error?.reason === "unverified_write" && error.details?.created?.uploadStarted)
      throw new Blocked("unverified_write", "The storage upload was started, but its final outcome is not verified. Check the camera's Models tab before any retry; do not upload again automatically.", error.details);
    throw error;
  });
}

export async function push(scope, ds, { role, modelId, model, imageSize: given, identity, expectedCurrent, expectEmpty = false, apply = false, waitSeconds = WAIT_SECONDS,
  resolvePending, fetchImpl = globalThis.fetch }) {
  if (!ROLE.test(String(role ?? ""))) throw new Blocked("invalid_params", "--role must name a model slot such as tracking, inspection or nails");
  if (modelId === undefined && model === undefined) throw new Blocked("invalid_params", "Choose the model with --model-id or --model");
  if (expectedCurrent !== undefined && !SHA256.test(expectedCurrent)) throw new Blocked("invalid_params", "--expected-current must be the slot SHA-256 from the preview");
  if (expectEmpty && expectedCurrent !== undefined) throw new Blocked("invalid_params", "Use --expect-empty or --expected-current from the preview, not both");
  // "Expected empty" is the empty-slot fingerprint, so one comparison guards both kinds of slot.
  const expected = expectEmpty ? EMPTY_SLOT_SHA256 : expectedCurrent;
  const rows = await loadModels(scope.call, ds.id);
  const row = targetModel(rows, { modelId, model });
  const sizing = imageSizeFor(row.name, row, given);
  if (sizing.imageSize === undefined) throw needSize(row.name, { model: describeModel(row) });
  const target = { id: Number(row.id), name: row.name, fileSize: row.fileSize, imageSize: sizing.imageSize };
  const sha = apply ? await sha256Model(scope.call, row, fetchImpl) : null;
  const base = deviceBase(ds);
  return withIot(scope, ds, async client => {
    const camera = chooseIdentity(identity ? [] : await discover(client, base), identity);
    const links = liveLinks(scope.profile, ds, { identity: camera, origin: scope.origin, livePage: scope.livePage });
    const topic = identityTopic(base, camera, "status");
    const seen = [];
    const onMessage = m => { if (m.topic === topic && m.json) seen.push(m); };
    client.on("message", onMessage);
    try {
      await client.subscribe([topic]);
      const slots = await readSlots(client, ds, camera);
      // The settings report only explains a slot that presence does not list.
      const reported = slots && !slots.some(s => s.role === role) ? await readReported(client, ds, camera) : null;
      const slot = slotOf(slots, role, reported);
      const preview = { dataSource: { id: ds.id, name: ds.name, site: ds.site.name }, camera, role,
        current: slot.empty ? { empty: true, fileName: null, inputSize: null, sha256: slot.sha256 } : { fileName: slot.fileName, inputSize: slot.inputSize, sha256: slot.sha256 },
        model: { ...describeModel(row), imageSize: sizing.imageSize, imageSizeFrom: sizing.source, ...(sizing.conflict ? { imageSizeNote: sizing.conflict } : {}) },
        effect: slot.empty ? `The ${role} slot is empty; the camera downloads this model into it and the stage that uses the slot starts using it.`
          : "The camera downloads this model and reloads the slot; detection in that stage pauses briefly while it reloads.",
        rollback: previousModel(rows, slot, role) };
      if (preview.rollback.modelId === String(row.id))
        preview.note = `The ${role} slot appears to run this model already (same byte size); applying checks the SHA-256 and sends nothing if it matches.`;
      const guard = slot.empty ? "--expect-empty" : `--expected-current ${slot.sha256}`;
      if (!apply) return { kind: "model-push-draft", profile: scope.profile, applied: false, preview, ...links,
        next: `Show this preview and wait for the user's explicit approval, then rerun with --apply --identity ${camera} ${guard}${sizing.source === "user" ? ` --image-size ${sizing.imageSize}` : ""}.` };
      const receipts = receiptsFile(scope.receipts);
      const keyFor = from => `model-push:${scope.profile}:${ds.id}:${camera}:${role}:${fingerprint({ sha, from, imageSize: sizing.imageSize })}`;
      // Checked before the guard: a late camera may have installed an earlier push of this model since the preview.
      if (slot.sha256 === sha) {
        const earlier = expected === undefined ? null
          : await recordOutcome(receipts, keyFor(expected), { outcome: "verified", verifiedAt: iso(Date.now()) }, r => r.state === "done" && !r.outcome && !!r.requestId);
        if (earlier) return { kind: "model-push", applied: false, requestId: earlier.requestId, sentAt: earlier.sentAt ?? null, state: "verified", verified: true,
          preview, ...links, sha256: sha, installed: slot,
          note: `The camera now reports the new model in its ${role} slot: the earlier push${earlier.sentAt ? ` sent at ${earlier.sentAt}` : ""} landed. Nothing new was sent.` };
        return { kind: "model-push", applied: false, state: "already-installed", preview, ...links,
          note: `The ${role} slot already runs this model (same SHA-256). Nothing was sent.` };
      }
      if (slot.empty && expected === undefined)
        throw new Blocked("invalid_params", `The ${role} slot is empty, so a first push needs --expect-empty from the preview. Nothing was sent.`, { current: preview.current });
      if (expected !== undefined && expected !== slot.sha256)
        throw new Blocked("slot_changed", expected === EMPTY_SLOT_SHA256
          ? `The ${role} slot was empty at the preview but now runs ${slot.fileName ?? "a model"}. Nothing was sent; preview again.`
          : slot.empty ? `The ${role} slot ran a model at the preview but is empty now. Nothing was sent; preview again.`
            : `The ${role} slot changed since the preview (it now runs ${slot.fileName ?? "another model"}). Nothing was sent; preview again.`, { current: preview.current });
      const requestId = `agent-${ds.id}-model-sync-${randomUUID()}`;
      const windowMs = Math.max(PENDING_SECONDS, waitSeconds) * 1000;
      let sentAt = Date.now();
      const matches = m => isPresence(m) && slotsFrom(m.json).some(s => s.role === role && s.sha256 === sha);
      const replies = rid => seen.filter(m => m.json.kind === "model" && String(m.json.requestId ?? "") === rid);
      const failure = rid => replies(rid).find(m => /error|fail/i.test(String(m.json.state ?? "")));
      const key = keyFor(slot.sha256);
      const result = await guardedWrite({
        file: receipts, key, resolve: resolvePending, summary: `Push ${row.name} to the ${role} slot of ${ds.name} (${camera})`,
        // A sent push is repeated only once the camera refused it or it is no longer pending.
        allowRepeat: prior => mayResend(prior),
        // An earlier attempt whose outcome was unknown is settled by the camera reporting the model.
        reconcile: async prior => seen.some(matches) ? { requestId: prior.requestId } : null,
        run: async () => {
          sentAt = Date.now();
          await scope.call("POST", `/prod-vision/${ds.id}/remote-commands`, { action: "model.sync", identity: camera, requestId,
            params: { role, expectedCurrentSha256: slot.sha256, model: target } }).catch(error => { throw refusal(error) ?? error; });
          return { receipt: { requestId, sentAt: iso(sentAt), sha256: sha, pendingUntil: iso(sentAt + windowMs) } };
        },
      });
      const fresh = result.state === "created";
      // A done receipt that is not repeated is a push still pending, or one the camera already confirmed.
      const prior = result.state === "already-done" && result.receipt?.requestId && result.receipt.outcome !== "verified" ? result.receipt : null;
      if (!fresh && !prior) return { kind: "model-push", applied: false, ...result, preview, ...links };
      const rid = fresh ? requestId : prior.requestId;
      const sentMs = fresh ? sentAt : Date.parse(prior.sentAt ?? prior.doneAt ?? prior.at ?? "") || pendingUntil(prior) - PENDING_SECONDS * 1000;
      const windowEnd = fresh ? sentAt + windowMs : pendingUntil(prior);
      const until = Math.min(Date.now() + waitSeconds * 1000, windowEnd);
      let done, failed, closed = false;
      const onClose = () => { closed = true; };
      client.once("close", onClose);
      try {
        while (!(done = seen.find(m => (!fresh || m.receivedAt >= sentAt) && matches(m))) && !(failed = failure(rid)) && !closed && Date.now() < until)
          await new Promise(r => setTimeout(r, 500));
      } finally {
        client.off("close", onClose);
      }
      const common = { kind: "model-push", applied: fresh, requestId: rid, sentAt: iso(sentMs), preview, ...links, sha256: sha };
      const before = fresh ? "" : `A push of this model to this slot was already sent at ${iso(sentMs)}; nothing new was sent. `;
      if (failed) {
        const reply = { state: String(failed.json.state ?? ""), message: String(failed.json.message ?? "").slice(0, 300) };
        await recordOutcome(receipts, key, { outcome: "failed", failedAt: iso(failed.receivedAt ?? Date.now()), reply }, r => r.requestId === rid);
        return { ...common, state: "failed", verified: false, reply,
          note: `${before}The camera refused or failed the install and ${slot.empty ? "the slot stays empty" : "kept its current model"}. Check the message before deciding on another push.` };
      }
      if (done) {
        await recordOutcome(receipts, key, { outcome: "verified", verifiedAt: iso(done.receivedAt) }, r => r.requestId === rid);
        return { ...common, state: "verified", verified: true, installed: slotsFrom(done.json).find(s => s.role === role),
          answeredAfterSeconds: Math.max(0, Math.round((done.receivedAt - sentMs) / 1000)), ...(before ? { note: `${before}It has now landed.` } : {}) };
      }
      const last = replies(rid).at(-1);
      const reply = last ? { state: String(last.json.state ?? ""), message: String(last.json.message ?? "").slice(0, 300) } : null;
      const answer = reply ? `The camera answered (${reply.state}${reply.message ? `: ${reply.message}` : ""}) but has not reported the new model in its ${role} slot yet.`
        : `The camera has not answered yet.`;
      const lost = closed ? " The live connection closed while watching." : "";
      if (Date.now() < windowEnd)
        return { ...common, state: "pending", verified: false, complete: false, pendingUntil: iso(windowEnd), ...(reply ? { reply } : {}),
          note: `${before}${answer} The push is pending, not failed: some cameras answer model commands several minutes late and still install the model.${lost} Until ${iso(windowEnd)}, rerunning this exact command sends nothing and keeps watching for the new model.`,
          next: "Rerun the same command to keep watching; it sends nothing while the push is pending." };
      return { ...common, state: "unverified", verified: false, pendingUntil: iso(windowEnd), ...(reply ? { reply } : {}),
        note: `${before}${answer} It is no longer pending (${Math.round((windowEnd - sentMs) / 60000)} minutes since the send).${lost} Check the camera with list or the live page. Running the command again would send the push again; ask the user first. The camera refuses a second install if the first one lands meanwhile.` };
    } finally {
      client.off("message", onMessage);
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
  if (!id(String(deviceId ?? ""))) throw new Error("--device-id or --url is required");
  return loadLiveDevice(scope.call, deviceId);
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    url: { type: "string" }, "device-id": { type: "string" }, identity: { type: "string" }, file: { type: "string" }, "image-size": { type: "string" },
    role: { type: "string" }, "model-id": { type: "string" }, model: { type: "string" }, "expected-current": { type: "string" }, "expect-empty": { type: "boolean" },
    apply: { type: "boolean" }, wait: { type: "string" }, "resolve-pending": { type: "string" }, receipts: { type: "string" },
    profile: { type: "string" }, "web-origin": { type: "string" },
  } });
  if (!["list", "upload", "push"].includes(args[0])) throw new Error("Choose list, upload or push");
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const scope = { call: await liveSession(profile, { allow: ROUTES, maxRequests: 150 }), profile, receipts: o.receipts,
    origin: o["web-origin"] ? webOrigin(profile, o["web-origin"]) : undefined };
  const ds = await resolveDevice(scope, o);
  if (args[0] === "list") return list(scope, ds, { identity: o.identity });
  if (args[0] === "upload") return upload(scope, ds, { file: o.file, imageSize: o["image-size"], apply: !!o.apply, resolvePending: o["resolve-pending"] });
  const wait = o.wait === undefined ? WAIT_SECONDS : Number(o.wait);
  if (!Number.isInteger(wait) || wait < 30 || wait > 900) throw new Error("--wait must be 30 to 900 seconds");
  return push(scope, ds, { role: o.role, modelId: o["model-id"], model: o.model, imageSize: o["image-size"], identity: o.identity,
    expectedCurrent: o["expected-current"], expectEmpty: !!o["expect-empty"], apply: !!o.apply, waitSeconds: wait, resolvePending: o["resolve-pending"] });
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => ({ prompt: "push a model to my camera" }),
  });
