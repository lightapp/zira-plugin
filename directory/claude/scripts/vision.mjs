#!/usr/bin/env node
// Guide Vision / Pallet Vision setup from pairing to validation, following the Home
// Assistant's next-step order (visionWorkflow.server.js) with the evidence the API exposes.
import { parseArgs } from "node:util";
import { statusValues } from "../skills/health-report/scripts/status.mjs";
import {
  Blocked, argValue, id, isMain, link, liveSession, originFor, resolveSite, route, runCli, siteDataSources,
} from "./client.mjs";

const HELP = `Zira vision setup — next step for a Vision or Pallet Vision data source
node scripts/vision.mjs list --company-id ID --site-id ID
node scripts/vision.mjs status --company-id ID --site-id ID --device-id ID
node scripts/vision.mjs mark --company-id ID --site-id ID --device-id ID
    --step paired|skip-pairing|mounted|skip-mounting [--apply]
Common: --profile prod|integ

list/status are read-only. mark previews by default; --apply records the setup step on
the data source (the same flag the web assistant sets) and reads it back. Marking a
step does not pair, mount or test hardware.
Exit 0 success, 2 invalid/failed, 3 unverified write, 4 blocked (JSON explains).
`;

export const VISION_APPLYING_IDS = ["7", "10"];
export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/],
  ["PUT", /^\/files\/attach\/device\/[1-9]\d*$/],
];
export const MARKS = {
  paired: { isPairingConfirmed: true, isPairingSkipped: false },
  "skip-pairing": { isPairingConfirmed: false, isPairingSkipped: true },
  mounted: { isMounted: true, isMountedSkipped: false },
  "skip-mounting": { isMounted: false, isMountedSkipped: true },
};

// Counts that only zira-web's dataset/bucket routes can read; never report them as zero.
const WEB_ONLY = {
  vision: ["recorded videos", "datasets", "dataset images and annotations", "train/val splits", "validation sessions"],
  pallet: ["validation snapshots", "datasets", "dataset images and annotations", "train/val splits", "validation sessions"],
};

const tab = (profile, deviceId, name, label) => ({ label, url: link(profile, `/data-sources/${deviceId}`, { tab: name }) });
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function setupState(device) {
  const cv = device?.cv ?? {}, meta = cv.metadata ?? {};
  return {
    isPallet: String(device?.applying?.id ?? "") === "10",
    pairing: meta.isPairingConfirmed ? "confirmed" : meta.isPairingSkipped ? "skipped" : "not-marked",
    mounting: meta.isMounted ? "mounted" : meta.isMountedSkipped ? "skipped" : "not-marked",
    modelsCount: Array.isArray(cv.models) ? cv.models.length : 0,
    datasetVersionFiles: Array.isArray(cv.datasets) ? cv.datasets.length : 0,
    device: {
      ...statusValues(cv.status ?? {}),
      lastHeartbeat: iso(cv.status?.lastHeartbeat),
      lastReadingAt: iso(device?.timestamp),
      appVersion: typeof cv.status?.version === "string" ? cv.status.version : null,
    },
  };
}

export function nextStep(device, profile = "prod", now = Date.now()) {
  const s = setupState(device), deviceId = String(device.id);
  const t = (name, label) => tab(profile, deviceId, name, label);
  const pairingDone = s.pairing !== "not-marked", mountingDone = s.mounting !== "not-marked";
  const trained = s.modelsCount > 0, versioned = s.datasetVersionFiles > 0;
  const lastSignal = [s.device.lastHeartbeat, s.device.lastReadingAt].filter(Boolean).sort().at(-1) ?? null;
  const evidence = [];
  if (lastSignal) evidence.push(`Last signal from this data source: ${lastSignal} (${Math.max(0, Math.round((now - Date.parse(lastSignal)) / 3600000))} h ago).`);
  let step;
  if (!trained && !versioned && !pairingDone) {
    step = {
      phase: "pair_device", title: "Pair the device",
      body: "The data source is not marked as paired. Pair the device from the Overview tab with the QR code or one-time code, then mark pairing done. If recordings or datasets already exist, pairing simply was not marked: mark it done or skip it.",
      links: [t("overview", "Open Overview (QR / one-time-code pairing)")],
      marks: ["paired", "skip-pairing"],
    };
    if (lastSignal) evidence.push("A recent signal suggests the device may already be paired; confirm before marking it.");
  } else if (!trained && !versioned && !mountingDone) {
    step = {
      phase: "confirm_mounting", title: "Confirm mounting",
      body: "Pairing is marked, but mounting is not. Check the camera view in Live View / Remote Control, then mark the device mounted or skip this step.",
      links: [t("overview", "Open Overview"), t("remoteControl", "Open Remote Control")],
      marks: ["mounted", "skip-mounting"],
    };
  } else if (trained) {
    step = {
      phase: "push_model_and_validate", title: "Push the model and review validation",
      body: `A model exists (${s.modelsCount}). To check it first, evaluate it on a dataset version on this computer (Evaluate a Model skill). Push it to the device, collect fresh validation ${s.isPallet ? "snapshots" : "videos"}, then review the output, mark issues and move strong examples back into the dataset. Validation sessions are only visible in Zira.`,
      links: [t("models", "Open Models"), t("validation", "Review Validation"), ...(s.isPallet ? [] : [t("remoteControl", "Record validation")]), t("datasets", "Open Datasets")],
    };
  } else if (versioned) {
    step = {
      phase: "train_model", title: "Run training",
      body: `Dataset version files are recorded on the data source (${s.datasetVersionFiles}), but no model exists yet. Zira matches versions to current datasets, which the plugin cannot see: if a current version is listed on the Datasets tab, run training from its menu; otherwise create a version first.`,
      links: [t("datasets", "Run training")],
    };
  } else {
    step = {
      phase: "prepare_dataset", title: "Prepare the first dataset version",
      body: "Setup is marked, and no dataset version or model exists yet. Work through these in order on the linked tabs; the plugin cannot read dataset storage, so confirm which one you are on in Zira.",
      checklist: [
        "Create or choose a dataset (Datasets)",
        s.isPallet ? "Let the device upload validation snapshots, or inspect Remote Control" : "Record the first videos (Remote Control → Record videos)",
        s.isPallet ? "Copy useful snapshots into the dataset (Validation)" : "Sample frames from the videos into the dataset (Videos → Auto sample)",
        "Annotate the dataset images (Datasets)",
        "Put annotated images in both train and val splits (Datasets)",
        "Create a dataset version, then run training (Datasets)",
      ],
      links: [t("datasets", "Open Datasets"), s.isPallet ? t("validation", "Open Validation") : t("remoteControl", "Open Remote Control"), ...(s.isPallet ? [] : [t("videos", "Open Videos")])],
    };
  }
  return { ...step, setup: s, evidence, notReadableHere: WEB_ONLY[s.isPallet ? "pallet" : "vision"] };
}

async function loadVisionDevice(call, site, deviceId) {
  if (!id(deviceId)) throw new Error("Data source ID required");
  const device = (await call("GET", route("/devices/all", { meterIds: deviceId, expand: "true" }))).data?.[0];
  if (String(device?.id ?? "") !== deviceId || String(device?.site?.id ?? "") !== site.id)
    throw new Blocked("scope", "Data source is not in the selected site");
  const company = device.company?.id ?? device.companyId;
  if (company != null && String(company) !== site.companyId) throw new Blocked("scope", "Data source is not in the selected company");
  if (!VISION_APPLYING_IDS.includes(String(device.applying?.id ?? "")))
    throw new Blocked("not_vision", "This data source is not a Vision or Pallet Vision data source");
  return device;
}

export async function listVision({ call, profile = "prod", companyId, siteId }) {
  const site = await resolveSite(call, companyId, siteId);
  const rows = await siteDataSources(call, site, { applyingIds: VISION_APPLYING_IDS.join(",") });
  const items = rows.filter(d => VISION_APPLYING_IDS.includes(String(d.applying?.id ?? d.applyingId ?? "")))
    .map(d => ({ id: String(d.id), name: String(d.name ?? "Vision data source"),
      type: String(d.applying?.id ?? d.applyingId) === "10" ? "Pallet Vision" : "Vision",
      url: link(profile, `/data-sources/${d.id}`, { tab: "overview" }) }));
  return { kind: "vision-data-sources", profile, site: { id: site.id, name: site.name }, items,
    ...(items.length ? {} : { next: "No Vision data source exists at this site yet; create one with the create-data-source skill." }) };
}

export async function visionStatus({ call, profile = "prod", companyId, siteId, deviceId, now }) {
  const site = await resolveSite(call, companyId, siteId);
  const device = await loadVisionDevice(call, site, deviceId);
  return { kind: "vision-next-step", profile, site: { id: site.id, name: site.name },
    dataSource: { id: deviceId, name: String(device.name ?? ""), url: link(profile, `/data-sources/${deviceId}`) },
    nextStep: nextStep(device, profile, now) };
}

export async function markStep({ call, profile = "prod", companyId, siteId, deviceId, step, apply = false }) {
  if (!Object.hasOwn(MARKS, step)) throw new Error("Choose paired, skip-pairing, mounted or skip-mounting");
  const site = await resolveSite(call, companyId, siteId);
  const device = await loadVisionDevice(call, site, deviceId);
  const before = setupState(device);
  const preview = { dataSource: { id: deviceId, name: String(device.name ?? "") }, step, before: { pairing: before.pairing, mounting: before.mounting } };
  if (!apply) return { kind: "vision-mark-draft", profile, preview, applied: false };
  // Idempotent merge like the web assistant, so other metadata stays intact.
  await call("PUT", `/files/attach/device/${deviceId}`, { metadata: { ...(device.cv?.metadata ?? {}), ...MARKS[step] } });
  const after = await loadVisionDevice(call, site, deviceId);
  const meta = after.cv?.metadata ?? {};
  const verified = Object.entries(MARKS[step]).every(([k, v]) => !!meta[k] === v);
  return { kind: "vision-mark", profile, applied: true, state: verified ? "created" : "partial", verified,
    preview, nextStep: nextStep(after, profile) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, "device-id": { type: "string" },
    step: { type: "string" }, apply: { type: "boolean" }, profile: { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const scope = { call: await liveSession(profile, { allow: ROUTES }), profile, companyId: o["company-id"], siteId: o["site-id"] };
  if (args[0] === "list") return listVision(scope);
  if (args[0] === "status") return visionStatus({ ...scope, deviceId: o["device-id"] });
  if (args[0] === "mark")
    return markStep({ ...scope, deviceId: o["device-id"], step: o.step, apply: !!o.apply });
  throw new Error("Choose list, status or mark");
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => ({ prompt: "set up vision device" }),
  });
