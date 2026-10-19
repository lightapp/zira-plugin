#!/usr/bin/env node
// Open a Vision data source's dataset, model or validation views in Zira with the context
// already filled in. Read-only: it lists choices, resolves the user's selection and builds
// links, and opens a browser only when asked. It never runs a model, edits labels or publishes.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Blocked, argValue, id, isMain, listAll, liveSession, normalizeName, originFor, route, runCli, siteDataSources } from "./client.mjs";
import { listVision, ROUTES as VISION_ROUTES } from "./vision.mjs";

const HELP = `Zira datasets — choose a data source, dataset, version or model, then open it in Zira
node scripts/datasets.mjs scope
node scripts/datasets.mjs find --place TEXT [--source TEXT] [--dataset-name TEXT]
node scripts/datasets.mjs sources --company-id ID --site-id ID [--name TEXT]
node scripts/datasets.mjs datasets (--url ZIRA_URL | --device-id ID) [--name TEXT]
node scripts/datasets.mjs open (--url ZIRA_URL | --device-id ID)
    --view datasets|dataset|models|training|validation|evaluate
    [--dataset NAME] [--version ID] [--model ID] [--launch]
Common: --profile prod|integ   --web-origin http://localhost:PORT (local zira-web only)

scope starts a request from nothing: one site is chosen for you, a few become a choice, and
many (admins) offer the cameras used recently and ask for a name. find matches --place against company and site names and --source against Vision data
source names, in one call; a single match also returns its datasets. sources lists the site's Vision and Pallet Vision data sources. datasets lists the data
source's datasets (named from their version files, newest first, optionally filtered by
--name), their versions, other versions (merges, staged copies) and models to choose from.
--url accepts a Zira data-source or dataset link; its host selects the profile and, for a
local zira-web, the web origin. open returns one view's link for the chosen dataset,
version or model; --launch also opens it in the default browser. Opening a page does not
run a model, change labels or publish edits.
Exit 0 success, 2 invalid/failed, 4 blocked (JSON explains).
`;

export const VISION_APPLYING_IDS = ["7", "10"];
export const ROUTES = [["GET", /^\/devices\/all$/], ["GET", /^\/companies\/list$/], ...VISION_ROUTES.filter(([m]) => m === "GET")];
export const VIEWS = ["datasets", "dataset", "models", "training", "validation", "evaluate"];
const WEB_HOSTS = { "my.zira.us": "prod", "zira-webinteg.zira.us": "integ" };
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/;
const NOT_READABLE = ["datasets that have no version yet", "which dataset a merge or staged version came from", "image counts", "annotation progress", "train/val/test splits", "validation sessions"];
const NO_SIDE_EFFECTS = "Opening this page does not run a model, change labels or publish edits.";

// A local zira-web is allowed for development; anything else must be a Zira origin.
export function webOrigin(profile, override) {
  if (!override) return originFor(profile);
  const origin = String(override).replace(/\/+$/, "");
  if (!LOOPBACK.test(origin)) throw new Error("--web-origin must be a loopback http origin such as http://localhost:3000");
  return origin;
}

// Dataset folder names are single path segments in the Vision Hub bucket.
export function datasetName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 200 || /[/\\\0]|^\.\.?$/.test(name)) throw new Error("Dataset name must be one folder name");
  return name;
}

// Accepts /data-sources/ID pages and /vision-hub/dataset?dataSourceId=…&datasetName=… links.
export function parseZiraUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("--url must be a full Zira link"); }
  const origin = url.origin;
  const profile = WEB_HOSTS[url.host] && url.protocol === "https:" ? WEB_HOSTS[url.host] : null;
  if (!profile && !LOOPBACK.test(origin)) throw new Error("--url must be a my.zira.us, zira-webinteg.zira.us or local zira-web link");
  const fromPath = url.pathname.match(/^\/(?:data-sources|live)\/([1-9]\d*)\/?$/)?.[1];
  const deviceId = fromPath ?? url.searchParams.get("dataSourceId") ?? "";
  if (!id(deviceId)) throw new Error("The link does not name a data source");
  // The dataset page double-encodes the name (see zira-web DatasetsHubTab buildDatasetHref).
  let dataset = url.pathname.startsWith("/vision-hub/dataset") ? url.searchParams.get("datasetName") : null;
  if (dataset) { try { dataset = decodeURIComponent(dataset); } catch { /* already plain */ } }
  return { deviceId, profile, webOrigin: profile ? null : origin, ...(dataset ? { dataset } : {}) };
}

const tabLink = (origin, ds, tab) =>
  `${origin}${route(`/data-sources/${ds.id}`, { viewMode: "vision", tab, fromPage: "vision-hub" })}`;

// Mirrors zira-web's buildDatasetHref, including its pre-encoded datasetName.
export function datasetLink(origin, ds, name) {
  return `${origin}${route("/vision-hub/dataset", {
    datasetName: encodeURIComponent(datasetName(name)), dataSourceId: ds.id, dataSourceName: ds.name,
    siteId: ds.site.id, siteName: ds.site.name, dataSourceType: ds.applyingId,
  })}`;
}

export function summarize(device) {
  const company = device?.company?.id ?? device?.companyId;
  return {
    id: String(device.id),
    name: String(device.name ?? "Vision data source"),
    type: String(device.applying?.id) === "10" ? "Pallet Vision" : "Vision",
    applyingId: String(device.applying?.id),
    site: { id: String(device.site?.id ?? ""), name: String(device.site?.name ?? "") },
    ...(company != null ? { companyId: String(company) } : {}),
  };
}

const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
// Newest first, like the Models and Datasets tabs.
const newestFirst = rows => (Array.isArray(rows) ? rows : [])
  .toSorted((a, b) => (Date.parse(b?.createdDate) || 0) - (Date.parse(a?.createdDate) || 0));
const file = row => ({
  id: String(row?.id ?? ""),
  name: String(row?.displayName ?? row?.name ?? "Unnamed"),
  ...(iso(row?.createdDate) ? { createdAt: iso(row.createdDate) } : {}),
});

const labelList = value => Array.isArray(value) && value.every(v => typeof v === "string") ? value.map(String) : null;
const num = value => Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null;

// A version ZIP's classes and split counts, as recorded when Zira built it.
const versionFile = row => {
  const props = row?.originProperties ?? {}, perSplit = props.datasetMerge?.counts?.perSplit;
  return { ...file(row), ...(labelList(props.labels) ? { labels: labelList(props.labels) } : {}),
    ...(perSplit && typeof perSplit === "object" ? { images: Object.fromEntries(Object.entries(perSplit).map(([k, v]) => [k, num(v)])) } : {}) };
};

// A model's lineage as Zira's training job recorded it: the version it trained on, its classes,
// input size and the metrics measured at the end of training on that version's val split.
const modelFile = row => {
  const props = row?.originProperties ?? {}, metrics = props.finalMetrics ?? {};
  const recorded = { precision: num(metrics.precision), recall: num(metrics.recall), mAP50: num(metrics.mAP50), "mAP50-95": num(metrics["mAP50-95"]) };
  return { ...file(row), ...(typeof row?.fileType === "string" ? { format: row.fileType } : {}),
    ...(labelList(props.labels) ? { labels: labelList(props.labels) } : {}),
    ...(num(props.imageSize) ? { imageSize: num(props.imageSize) } : {}),
    ...(id(String(props.datasetFileId ?? "")) ? { trainedOnVersionId: String(props.datasetFileId) } : {}),
    ...(Object.values(recorded).some(v => v !== null) ? { trainingMetrics: recorded } : {}) };
};

// Version ZIPs carry their source in originProperties.origin_name. Only a plain folder name
// identifies a dataset: "merged" marks a merge result, and ".temp/…" or "__tmp_zip_…" a staged
// copy that zira-web maps back only with the real folder list, which plugin sign-in cannot read.
export function versionOrigin(row) {
  const origin = typeof row?.originProperties?.origin_name === "string" ? row.originProperties.origin_name.trim() : "";
  if (!origin) return { kind: "no-origin" };
  if (origin === "merged") return { kind: "merge" };
  if (/^(?:\.?tmp|\.temp)[/_-]|^__tmp_zip_/i.test(origin)) return { kind: "staged", source: origin };
  try { return { kind: "dataset", dataset: datasetName(origin) }; } catch { return { kind: "no-origin" }; }
}

export function catalog(device, { max = 50, name } = {}) {
  const groups = new Map(), other = [], byVersion = new Map();
  for (const row of newestFirst(device.cv?.datasets)) {
    if (!id(String(row?.id ?? ""))) continue;
    const origin = versionOrigin(row), version = versionFile(row);
    byVersion.set(version.id, { ...version, dataset: origin.dataset ?? null });
    if (origin.kind !== "dataset") { other.push({ ...version, kind: origin.kind, ...(origin.source ? { source: origin.source } : {}) }); continue; }
    if (!groups.has(origin.dataset)) groups.set(origin.dataset, []);
    groups.get(origin.dataset).push(version);
  }
  const wanted = name ? normalizeName(name) : "";
  const datasets = [...groups].map(([dataset, versions]) => ({ name: dataset, latestVersionAt: versions[0].createdAt ?? null, versions }))
    .filter(d => !wanted || normalizeName(d.name).includes(wanted));
  const models = newestFirst(device.cv?.models).filter(m => id(String(m?.id ?? ""))).map(modelFile).map(m => {
    const v = m.trainedOnVersionId && byVersion.get(m.trainedOnVersionId);
    return v ? { ...m, trainedOn: { versionId: v.id, version: v.name, dataset: v.dataset } } : m;
  });
  return { datasets: datasets.slice(0, max), otherVersions: other.slice(0, max), models: models.slice(0, max),
    allModels: models, byVersion,
    totals: { datasets: datasets.length, otherVersions: other.length, models: models.length } };
}

// For a chosen dataset: models trained on it first, then models with the same classes as its
// latest version, then the rest; newest first within each group.
export function modelsFor(models, dataset, labels) {
  if (!dataset) return models;
  const rank = m => m.trainedOn?.dataset === dataset ? 0 : labels && compatibility(m, { labels }).sameClasses ? 1 : 2;
  return [0, 1, 2].flatMap(r => models.filter(m => rank(m) === r));
}

// Same class names in the same order; anything else makes per-class metrics meaningless.
export function compatibility(model, version) {
  if (!model?.labels || !version?.labels) return { checked: false, reason: "Zira has no class list recorded for the model or the version." };
  const same = model.labels.length === version.labels.length && model.labels.every((l, i) => l === version.labels[i]);
  return { checked: true, sameClasses: same, modelLabels: model.labels, versionLabels: version.labels };
}

export async function loadDevice(call, deviceId) {
  if (!id(deviceId)) throw new Error("Data source ID required");
  const device = (await call("GET", route("/devices/all", { meterIds: deviceId, expand: "true" }))).data?.[0];
  if (String(device?.id ?? "") !== deviceId || device.isDeleted)
    throw new Blocked("not_found", "The data source is missing or not visible to this user");
  if (!VISION_APPLYING_IDS.includes(String(device.applying?.id ?? "")))
    throw new Blocked("not_vision", "This data source is not a Vision or Pallet Vision data source; datasets exist only on those");
  if (!id(String(device.site?.id ?? ""))) throw new Blocked("scope", "The data source has no site the plugin can confirm");
  return device;
}

export function views(origin, ds, dataset) {
  const out = {
    datasets: { label: "Datasets tab", url: tabLink(origin, ds, "datasets") },
    models: { label: "Models tab", url: tabLink(origin, ds, "models") },
    training: { label: "Training tab", url: tabLink(origin, ds, "training") },
    validation: { label: ds.type === "Pallet Vision" ? "Validation snapshots" : "Validation tab", url: tabLink(origin, ds, "validation") },
  };
  if (dataset) out.dataset = { label: `Dataset ${dataset}`, url: datasetLink(origin, ds, dataset) };
  return out;
}

// Recently used cameras (names and IDs only), so a person with many sites can pick one again.
const RECENT_MAX = 5;
export function recentFile(env = process.env) {
  const dir = env.ZIRA_STATE_DIR ? path.resolve(env.ZIRA_STATE_DIR)
    : env.ZIRA_CONFIG_DIR ? path.resolve(env.ZIRA_CONFIG_DIR)
      : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zira");
  return path.join(dir, "recent-vision-sources.json");
}
export async function readRecent(env = process.env) {
  try {
    const rows = JSON.parse(await readFile(recentFile(env), "utf8"));
    return Array.isArray(rows) ? rows.filter(r => id(String(r?.id ?? "")) && id(String(r?.site?.id ?? ""))).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
export async function rememberSource(ds, env = process.env, profile = "prod") {
  try {
    const entry = { id: ds.id, name: ds.name, type: ds.type, profile, site: { id: ds.site.id, name: ds.site.name },
      ...(ds.companyId ? { companyId: ds.companyId } : {}), usedAt: new Date().toISOString() };
    const rows = [entry, ...(await readRecent(env)).filter(r => !(r.id === ds.id && (r.profile ?? "prod") === profile))].slice(0, RECENT_MAX);
    await mkdir(path.dirname(recentFile(env)), { recursive: true });
    await writeFile(recentFile(env), JSON.stringify(rows, null, 2), { mode: 0o600 });
  } catch { /* remembering is a convenience; never fail the request over it */ }
}

// Start from nothing with as few questions as the account needs.
export async function startScope({ call, profile = "prod", origin, env = process.env }) {
  const page = await call("GET", route("/sites/list", { limit: 4 }));
  const sites = liveSites(Array.isArray(page?.data) ? page.data : []);
  const recent = (await readRecent(env)).filter(r => (r.profile ?? "prod") === profile);
  if (!sites.length) throw new Blocked("not_found", "This sign-in has no Zira sites.");
  if (sites.length === 1 && !page.lastValue)
    return { kind: "dataset-scope", profile, sites: 1, chosen: { site: sites[0].name, company: sites[0].companyName, place: sites[0].name },
      next: `Run find --place "${sites[0].name}" to list its cameras.` };
  if (sites.length <= 3 && !page.lastValue)
    return { kind: "dataset-scope", profile, sites: sites.length,
      question: question("Site", "Which site?", sites, { label: s => s.name, description: s => s.companyName, value: s => s.name,
        other: "Type the site or customer name." }) };
  // Recent cameras first; with a single one, "Another camera" keeps it a real choice.
  const rows = recent.length ? [...recent.slice(0, 3), ...(recent.length === 1 ? [{ other: true }] : [])] : [];
  return {
    kind: "dataset-scope", profile, sites: "many",
    ...(recent.length ? { recent: recent.map(r => ({ ...r, url: tabLink(origin, r, "models") })) } : {}),
    ...(rows.length ? {
      question: question("Camera", "Which camera? Recent ones are listed; type a customer, site or camera name for another.", rows, {
        label: r => r.other ? "Another camera" : r.name,
        description: r => r.other ? "Name the customer, site or camera" : `${r.type} · ${r.site.name}`,
        value: r => r.other ? "other" : r.id,
        other: "Type a customer, site or camera name, for example \"Example Plant Cam 1\"." }),
    } : { ask: "Which customer or site is the camera at? A camera name helps too, for example \"Example Plant, Cam 1 Quality\"." }),
  };
}

const MAX_FIND_SITES = 5;
// Choice-UI options: Claude Code's question tool takes 2–4 and Codex's request_user_input 2–3,
// and both add a free-text answer, so three keeps one shape for both hosts.
export const MAX_OPTIONS = 3;

// A ready-to-ask question for the host's choice UI. `value` maps the picked label back to the
// id or name the next command needs; `other` says what a typed answer means.
export function question(header, text, rows, { label, description, value, other, total = rows.length }) {
  if (rows.length < 2) return undefined;
  const shown = rows.slice(0, MAX_OPTIONS);
  const labels = shown.map(label);
  const options = shown.map((row, i) => ({
    // Two rows with the same name (same camera name on two sites) get their description appended.
    label: labels.indexOf(labels[i]) !== labels.lastIndexOf(labels[i]) ? `${labels[i]} (${description(row)})` : labels[i],
    description: description(row), value: value(row),
  }));
  return { header: header.slice(0, 12), question: text, options, other,
    ...(total > shown.length ? { notShown: total - shown.length } : {}) };
}
const shortDate = value => value ? new Date(value).toISOString().slice(0, 10) : "no date";
const sourceQuestion = items => question("Data source", "Which camera's datasets do you want?", items, {
  label: i => i.name, description: i => `${i.type} · ${i.site?.name ?? ""}`.trim().replace(/ ·$/, ""), value: i => i.id,
  other: "Type the camera name, or part of it." });
// Exact name first; otherwise every word the user gave ("cam quality" → "Cam 1 Quality").
const matches = (rows, text, key = r => r.name) => {
  const want = normalizeName(text), words = want.split(" ").filter(Boolean);
  const exact = rows.filter(r => normalizeName(key(r)) === want);
  return exact.length ? exact : rows.filter(r => { const have = normalizeName(key(r)); return words.every(w => have.includes(w)); });
};
const siteRow = s => ({ id: String(s.id), name: String(s.name ?? "Unnamed site"),
  companyId: String(s.company?.id ?? s.companyId ?? ""), companyName: String(s.company?.name ?? "") });
const liveSites = rows => rows.filter(s => !s.isDeleted && id(String(s?.id ?? "")) && id(String(s?.company?.id ?? s?.companyId ?? ""))).map(siteRow);

// One step from "Example Plant's Cam 1 Quality" to the data source: Zira's own site search, then its
// company search, then Vision data sources of the matching sites only.
export async function findSource({ call, profile = "prod", origin, place, source, datasetFilter, withDatasets = true }) {
  if (!normalizeName(place)) throw new Error("--place is required: a company or site name");
  let candidates = matches(liveSites(await listAll(call, "/sites/list", { textSearch: place }, 2)), place);
  if (!candidates.length) {
    const companies = (await listAll(call, "/companies/list", { textSearch: place }, 2))
      .filter(c => !c.isDeleted && id(String(c?.id ?? "")));
    const hit = matches(companies.map(c => ({ id: String(c.id), name: String(c.name ?? "") })), place);
    if (hit.length && hit.length <= MAX_FIND_SITES)
      candidates = liveSites(await listAll(call, "/sites/list", { companyIds: hit.map(c => c.id).join(",") }, 2))
        .filter(s => hit.some(c => c.id === s.companyId));
  }
  if (!candidates.length) throw new Blocked("not_found", `No authorized company or site matches "${place}"`);
  if (candidates.length > MAX_FIND_SITES)
    throw new Blocked("too_broad", `"${place}" matches ${candidates.length} sites; ask for the site name`,
      { sites: candidates.slice(0, 20).map(s => ({ id: s.id, name: s.name, company: s.companyName })),
        question: question("Site", `Which site did you mean by "${place}"?`, candidates, {
          label: s => s.name, description: s => s.companyName, value: s => s.name,
          other: "Type the site or customer name more fully." }) });
  const found = [];
  for (const site of candidates) {
    const rows = await siteDataSources(call, site, { applyingIds: VISION_APPLYING_IDS.join(",") });
    for (const d of rows.filter(r => VISION_APPLYING_IDS.includes(String(r.applying?.id ?? r.applyingId ?? ""))))
      found.push({ id: String(d.id), name: String(d.name ?? "Vision data source"),
        type: String(d.applying?.id ?? d.applyingId) === "10" ? "Pallet Vision" : "Vision",
        site: { id: site.id, name: site.name }, company: { id: site.companyId, name: site.companyName } });
  }
  const items = source ? matches(found, source) : found;
  const result = { kind: "dataset-find", profile, place, ...(source ? { source } : {}),
    sites: candidates.map(s => ({ id: s.id, name: s.name, company: s.companyName })),
    items: items.map(i => ({ ...i, url: tabLink(origin, i, "datasets") })) };
  if (items.length === 1) await rememberSource({ ...items[0], site: items[0].site }, process.env, profile);
  if (items.length === 1)
    return { ...result, chosen: items[0].id,
      ...(withDatasets ? { datasets: await listDatasets({ call, profile, origin, deviceId: items[0].id, name: datasetFilter }) } : {}) };
  return { ...result, question: sourceQuestion(result.items),
    ...(items.length ? {} : { next: source && found.length ? `No Vision data source matches "${source}"; offer the site's sources.` : "These sites have no Vision data source." }),
    ...(source && !items.length ? { available: found.map(f => ({ id: f.id, name: f.name, site: f.site.name })) } : {}) };
}

// The site's Vision data sources, so the user can choose one.
export async function listSources({ call, profile = "prod", origin, companyId, siteId, name }) {
  const r = await listVision({ call, profile, companyId, siteId });
  const wanted = name ? normalizeName(name) : "";
  const items = r.items
    .filter(item => !wanted || normalizeName(item.name).includes(wanted))
    .map(item => ({ id: item.id, name: item.name, type: item.type, url: tabLink(origin, { id: item.id }, "datasets") }));
  return { kind: "dataset-sources", profile, site: r.site, ...(name ? { filter: name } : {}), items,
    question: sourceQuestion(items.map(i => ({ ...i, site: r.site }))),
    ...(items.length ? {} : { next: name ? "No Vision data source matches that name at this site." : r.next }) };
}

export async function listDatasets({ call, profile = "prod", origin, deviceId, dataset, name, max = 20, env = process.env }) {
  const device = await loadDevice(call, deviceId);
  const ds = summarize(device);
  await rememberSource(ds, env, profile);
  const found = catalog(device, { max, name });
  const pick = dataset ? datasetName(dataset) : null;
  const picked = pick ? catalog(device, { max: Infinity }).datasets.find(d => d.name === pick) : null;
  return {
    kind: "dataset-choices", profile, webOrigin: origin, dataSource: ds,
    ...(pick ? { dataset: pick, datasetListed: Boolean(picked) } : {}),
    ...(picked ? { versions: picked.versions, versionQuestion: question("Version", `Which version of ${pick}?`, picked.versions, {
      label: v => v.name, value: v => v.id, description: v => `created ${shortDate(v.createdAt)}`,
      other: "Type part of the version name." }) } : {}),
    ...(name ? { filter: name } : {}),
    datasets: found.datasets.map(d => ({ ...d, url: datasetLink(origin, ds, d.name) })),
    ...(pick ? {} : { question: question("Dataset", `Which ${ds.name} dataset do you want?`, found.datasets, {
      label: d => d.name, value: d => d.name,
      description: d => `${d.versions.length} version${d.versions.length === 1 ? "" : "s"}, latest ${shortDate(d.latestVersionAt)}`,
      other: "Type a dataset name, or part of one (for example nails) to search all of them.", total: found.totals.datasets }) }),
    ...(pick ? { modelsTrainedOnDataset: found.allModels.filter(m => m.trainedOn?.dataset === pick).slice(0, max) } : {}),
    ...(picked?.versions[0]?.labels && !found.allModels.some(m => m.trainedOn?.dataset === pick || compatibility(m, picked.versions[0]).sameClasses)
      ? { modelNote: `No model on ${ds.name} was trained on ${pick} or has its classes (${picked.versions[0].labels.join(", ")}); per-class results from these models would not be meaningful.` } : {}),
    modelQuestion: question("Model", `Which ${ds.name} model?`, modelsFor(found.allModels, pick, picked?.versions[0]?.labels), {
      label: m => m.name, value: m => m.id,
      description: m => [m.trainedOn?.dataset === pick && pick ? "trained on this dataset" : m.trainedOn ? `trained on ${m.trainedOn.version}` : null,
        picked?.versions[0]?.labels && m.labels ? (compatibility(m, picked.versions[0]).sameClasses ? "same classes" : "different classes") : null,
        `created ${shortDate(m.createdAt)}`].filter(Boolean).join(" · "),
      other: "Type part of the model name.", total: found.totals.models }),
    otherVersions: found.otherVersions,
    models: found.models,
    totals: found.totals,
    ...(Object.entries(found.totals).some(([k, n]) => n > found[k].length) ? { more: `Showing the newest ${max} of each list; narrow datasets with --name.` } : {}),
    views: views(origin, ds, pick),
    notReadableHere: NOT_READABLE,
    note: "Datasets are named from their version files: a dataset with no version yet is missing, and a listed one may have been renamed or deleted since. otherVersions are merge results or staged copies that only Zira can map to a dataset. The user can name a dataset or pick it on the Datasets tab.",
  };
}

const choose = (rows, wanted, what) => {
  if (!wanted) return null;
  const row = rows.find(r => r.id === String(wanted));
  if (!row) throw new Blocked("not_found", `That ${what} is not on this data source; list the choices with the datasets command`);
  return row;
};

// Zira has no "evaluate this model on a dataset" page yet. This says what is actually known
// (metrics Zira recorded when it trained the model) and the real ways to get a fresh result,
// instead of steps that only look like an evaluation.
export function evaluateView(links, ds, { model, version, dataset, datasetVersions = [], models = [] }) {
  const target = version ?? datasetVersions[0] ?? null;
  const trainedHere = model?.trainedOn && (model.trainedOn.versionId === target?.id || model.trainedOn.dataset === dataset);
  const recorded = model?.trainingMetrics && trainedHere ? {
    metrics: model.trainingMetrics, onVersion: model.trainedOn.version,
    sameVersion: model.trainedOn.versionId === target?.id,
    note: `Recorded by Zira when it trained this model, on the val split of ${model.trainedOn.version}${model.format === "tflite" ? ", measured on the training checkpoint before the TFLite export" : ""}. Not a fresh run${model.trainedOn.versionId === target?.id ? "" : `, and not on ${target?.name ?? "the chosen version"}`}.`,
  } : null;
  const suggestions = dataset && !model ? models.filter(m => m.trainedOn?.dataset === dataset).slice(0, 3)
    .map(m => ({ id: m.id, name: m.name, trainedOn: m.trainedOn.version, ...(m.trainingMetrics ? { trainingMetrics: m.trainingMetrics } : {}) })) : [];
  return {
    available: false,
    reason: "Zira has no page yet that runs a model on a dataset and shows the results.",
    url: links.models.url,
    ...(model ? { model: { id: model.id, name: model.name, format: model.format ?? null, trainedOn: model.trainedOn ?? null } } : {}),
    ...(target ? { version: { id: target.id, name: target.name, ...(target.images ? { images: target.images } : {}) } } : {}),
    ...(model && target ? { compatibility: compatibility(model, target) } : {}),
    recorded,
    ...(model && !recorded ? { recordedNote: model.trainedOn ? `Zira recorded metrics only for ${model.trainedOn.version}, which is not this dataset.` : "Zira has no recorded metrics for this model on this dataset." } : {}),
    ...(suggestions.length ? { modelsTrainedOnDataset: suggestions } : {}),
    options: [
      ...(recorded ? [{ kind: "recorded", label: "Use the metrics Zira recorded at training", why: recorded.note }] : []),
      { kind: "local", label: "Run a fresh evaluation on this computer (evaluate-model skill)",
        why: "Runs the model on the version's images on this computer and writes a report with per-class precision, recall and F1.",
        needs: ["the version ZIP and the model file (the skill downloads them, or asks the user to click Download)",
          "a one-time local model runtime (about 30 MB of Python packages)"] },
      { kind: "validation", label: ds.type === "Pallet Vision" ? "Run it on validation snapshots" : "Review it on recorded validation",
        url: links.validation.url,
        why: ds.type === "Pallet Vision" ? "Image review can run a model on recent QA snapshots. Those are live camera frames, not this dataset's images." : "Uses validation recordings, not this dataset's images." },
    ],
    links: { models: links.models.url, ...(links.dataset ? { dataset: links.dataset.url } : {}) },
  };
}

export async function openView({ call, profile = "prod", origin, deviceId, view, dataset, version, model, launch = false, launcher = launchBrowser }) {
  if (!VIEWS.includes(view)) throw new Error(`Choose a view: ${VIEWS.join(", ")}`);
  const device = await loadDevice(call, deviceId);
  const ds = summarize(device);
  const found = catalog(device, { max: Infinity });
  const chosenVersion = choose(found.datasets.flatMap(d => d.versions.map(v => ({ ...v, dataset: d.name }))).concat(found.otherVersions), version, "dataset version");
  const chosenModel = choose(found.allModels, model, "model");
  const name = dataset ? datasetName(dataset) : chosenVersion?.dataset ?? null;
  if (view === "dataset" && !name) throw new Error("--dataset NAME (or a --version of a listed dataset) is required for the dataset view");
  if (dataset && chosenVersion?.dataset && chosenVersion.dataset !== name) throw new Error("--version belongs to a different dataset");
  const links = views(origin, ds, name);
  const target = view === "evaluate"
    ? evaluateView(links, ds, { model: chosenModel, version: chosenVersion, dataset: name, models: found.allModels,
      datasetVersions: found.datasets.find(d => d.name === name)?.versions ?? [] })
    : { available: true, ...links[view] };
  const listed = name ? found.datasets.some(d => d.name === name) : null;
  const result = {
    kind: "dataset-view", profile, view, dataSource: ds,
    ...(name ? { dataset: name, datasetListed: listed } : {}),
    ...(chosenVersion ? { version: chosenVersion } : {}),
    ...(chosenModel ? { model: chosenModel } : {}),
    ...target,
    launched: false,
    note: NO_SIDE_EFFECTS + (name && !listed ? " The dataset has no version file, so its name was not checked; if the page is empty, pick it on the Datasets tab." : ""),
  };
  if (launch) {
    await launcher(result.url);
    result.launched = true;
  }
  return result;
}

// Opens the default browser; the URL is built above from a fixed origin and encoded params.
export function launchBrowser(url, platform = process.platform) {
  const [cmd, args] = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", error => reject(new Error(`Could not open a browser (${error.message}); open the URL manually`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    url: { type: "string" }, "device-id": { type: "string" }, "company-id": { type: "string" }, "site-id": { type: "string" },
    name: { type: "string" }, place: { type: "string" }, source: { type: "string" }, "dataset-name": { type: "string" }, view: { type: "string" }, dataset: { type: "string" }, version: { type: "string" },
    model: { type: "string" }, launch: { type: "boolean" }, profile: { type: "string" }, "web-origin": { type: "string" },
  } });
  if (!["scope", "find", "sources", "datasets", "open"].includes(args[0])) throw new Error("Choose scope, find, sources, datasets or open");
  const fromUrl = o.url ? parseZiraUrl(o.url) : null;
  if (fromUrl && o["device-id"] && o["device-id"] !== fromUrl.deviceId) throw new Error("--device-id and --url name different data sources");
  if (fromUrl?.profile && o.profile && o.profile !== fromUrl.profile) throw new Error(`The link is a ${fromUrl.profile} link; drop --profile or use ${fromUrl.profile}`);
  const profile = fromUrl?.profile ?? o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const origin = webOrigin(profile, o["web-origin"] ?? fromUrl?.webOrigin);
  const call = await liveSession(profile, { allow: ROUTES, maxRequests: 20 });
  if (args[0] === "scope") return startScope({ call, profile, origin });
  if (args[0] === "find")
    return findSource({ call, profile, origin, place: o.place, source: o.source, datasetFilter: o["dataset-name"] });
  if (args[0] === "sources")
    return listSources({ call, profile, origin, companyId: o["company-id"], siteId: o["site-id"], name: o.name });
  const scope = { call, profile, origin, deviceId: fromUrl?.deviceId ?? o["device-id"], dataset: o.dataset ?? fromUrl?.dataset };
  if (args[0] === "datasets") return listDatasets({ ...scope, name: o.name });
  return openView({ ...scope, view: o.view ?? (scope.dataset || o.version ? "dataset" : "datasets"),
    version: o.version, model: o.model, launch: !!o.launch });
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => ({ prompt: "open my vision datasets" }),
  });
