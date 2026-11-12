#!/usr/bin/env node
// Start a next-generation dashboard like the Home Assistant builder (create it with the
// selected site data sources, then draft widgets in its AI builder), or duplicate one the way
// Zira web's Duplicate does, with a reviewed data source and metric mapping for another site.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  Blocked, argValue, fingerprint, guardedWrite, id, idList, isMain, link, listAll, liveSession, normalizeName,
  originFor, receiptsFile, resolveSite, route, runCli, siteDataSources, text,
} from "./client.mjs";
import { argumentDevice, resaveBody, verifyWidget } from "./dashboard-widgets.mjs";

const HELP = `Zira dashboards — start a next-generation dashboard
node scripts/dashboards.mjs create --company-id ID --site-id ID --name TEXT
    --data-source-ids ID,ID [--description TEXT] [--range RANGE] [--interval INTERVAL]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/dashboards.mjs copy-mapping --company-id ID --site-id ID --dashboard-id ID
    [--target-company-id ID] [--target-site-id ID] [--out FILE]
node scripts/dashboards.mjs copy --company-id ID --site-id ID --dashboard-id ID [--name TEXT]
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/dashboards.mjs fix-copy --company-id ID --site-id ID --dashboard-id ID --copy-id ID
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
Common: --profile prod|integ

RANGE: ${"today yesterday this-week last-week last-7-days last-14-days last-21-days last-30-days last-60-days last-365-days last-60-minutes"}
INTERVAL: last-reading 1-minute 5-minutes 15-minutes hourly daily weekly monthly

create previews by default. --apply creates one dashboard with those data sources and
reads it back. Use dashboard-widgets.mjs context/save to author native widgets in chat.
copy-mapping reads (writes nothing in Zira) the source dashboard's data sources, the metrics its
widgets use and the target site's data sources of the same kind, and proposes a one-to-one
mapping: the same unit by name (type and number, camera suffixes ignored), then matching metrics.
Equal fits are listed as ambiguous and left out of the mapping (--out saves it). copy previews a
duplicate of a next-generation dashboard (default name "<name> (copy)"); in the same site every
data source maps to itself, another site needs --mapping. --apply copies it once, re-saves the
widgets whose description or chart data source Zira's Duplicate lost, and reads it back.
fix-copy previews (--apply makes) that restore for an existing copy (--copy-id) of the source.
Exit 0 success, 2 invalid/failed, 3 unverified write, 4 blocked (JSON explains).
`;

// IDs used by the web builder (homeDashboardBuilder.server.js).
export const RANGES = {
  "last-60-minutes": "16", today: "1", yesterday: "2", "last-week": "14", "this-week": "3", "last-7-days": "4",
  "last-14-days": "5", "last-21-days": "6", "last-30-days": "9", "last-60-days": "10", "last-365-days": "12",
};
export const INTERVALS = {
  "last-reading": "-1000", "1-minute": "1", "5-minutes": "2", "15-minutes": "3",
  hourly: "4", daily: "5", weekly: "6", monthly: "7",
};
export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/dashboards\/list$/],
  ["GET", /^\/dashboards\/[1-9]\d*$/], ["POST", /^\/dashboards\/new$/],
  ["GET", /^\/devices\/all$/], ["POST", /^\/dashboards\/copy$/], ["PUT", /^\/dashboards\/widgets\/[1-9]\d*$/],
];
const MAX_DATA_SOURCES = 50;

export function uniqueName(name, existing) {
  const taken = new Set(existing.map(normalizeName));
  if (!taken.has(normalizeName(name))) return name;
  let n = 2;
  while (taken.has(normalizeName(`${name} ${n}`))) n++;
  return `${name} ${n}`;
}

// The create response has varied shapes; follow the web builder's fallback chain.
export function createdDashboardId(body) {
  const payload = body && typeof body === "object" && Object.hasOwn(body, "data") ? body.data : body;
  if (["string", "number"].includes(typeof payload)) return id(String(payload)) ? String(payload) : null;
  const dashboard = payload?.dashboard ?? payload?.item ?? payload?.entity ?? payload;
  const found = String(dashboard?.id ?? payload?.dashboardId ?? payload?.id ?? "");
  return id(found) ? found : null;
}

async function findByName(call, site, name) {
  const matches = (await siteDashboards(call, site)).filter(d => normalizeName(d.name) === normalizeName(name));
  return matches.length === 1 ? String(matches[0].id) : null;
}

const siteDashboards = (call, site) =>
  listAll(call, "/dashboards/list", { siteIds: site.id, dashboardTypeIds: "3" });

export async function createDashboard({
  call, profile = "prod", companyId, siteId, name, description, dataSourceIds, range = "today", interval = "hourly",
  apply = false, allowRepeat = false, receipts, resolve,
}) {
  const site = await resolveSite(call, companyId, siteId);
  const dashboardName = text(name, 120);
  if (!dashboardName) throw new Error("A dashboard name is required");
  if (!Object.hasOwn(RANGES, range)) throw new Error("Unknown --range");
  if (!Object.hasOwn(INTERVALS, interval)) throw new Error("Unknown --interval");
  const wanted = idList(dataSourceIds);
  if (!wanted.length || !wanted.every(id)) throw new Error("Choose one or more data source IDs from this site");
  if (wanted.length > MAX_DATA_SOURCES) throw new Error(`Choose at most ${MAX_DATA_SOURCES} data sources`);
  const inventory = new Map((await siteDataSources(call, site)).map(d => [String(d.id), d]));
  const missing = wanted.filter(w => !inventory.has(w));
  if (missing.length) throw new Blocked("scope", "Some data sources are not in the selected site", { missing });
  const dataSources = wanted.map(w => ({ id: w, name: String(inventory.get(w).name ?? "Data source") }));
  const existing = (await siteDashboards(call, site)).filter(d => !d.isDeleted).map(d => String(d.name ?? ""));
  const suggestedName = uniqueName(dashboardName, existing);
  const preview = {
    site: { id: site.id, name: site.name }, name: dashboardName, description: text(description, 500) || null,
    dataSources, defaultRange: range, defaultInterval: interval, type: "next-generation",
    ...(suggestedName !== dashboardName ? { nameTaken: true, suggestedName } : {}),
  };
  const webPrompt = `Create a dashboard\ndata-source-ids: ${wanted.join(",")}`;
  if (!apply) return { kind: "dashboard-draft", profile, preview, applied: false, webPrompt };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "dashboardId",
    key: fingerprint({ op: "create-dashboard", profile, siteId: site.id, name: normalizeName(dashboardName), dataSources: [...wanted].sort() }),
    summary: { kind: "dashboard", siteId: site.id, name: dashboardName },
    precheck: async () => {
      if (suggestedName !== dashboardName)
        throw new Blocked("duplicate", `A dashboard named "${dashboardName}" already exists at ${site.name}. Use "${suggestedName}" or another name.`, { suggestedName });
    },
    // The precheck guaranteed the name was free, so exactly one match now is this attempt's.
    reconcile: async () => {
      const found = (await siteDashboards(call, site)).filter(d => normalizeName(d.name) === normalizeName(dashboardName));
      return found.length === 1 ? { dashboardId: String(found[0].id) } : null;
    },
    run: async progress => {
      const body = (await call("POST", "/dashboards/new", {
        name: dashboardName,
        description: preview.description,
        siteId: site.id,
        companyId: site.companyId,
        isLocked: true,
        isShared: false,
        defaultDisplayRange: { id: RANGES[range] },
        defaultDisplayInterval: { id: INTERVALS[interval] },
        configurationLayout: { lg: [], md: [], sm: [], xs: [] },
        type: { id: "3", name: "Device" },
        devices: dataSources,
        isPrivate: false,
      })).data;
      const dashboardId = createdDashboardId(body) ?? await findByName(call, site, dashboardName);
      if (!dashboardId) throw new Error("Create returned no dashboard ID; check the site's dashboards before retrying");
      await progress({ dashboardId });
      let saved = {}, readBack = null;
      try {
        saved = (await call("GET", `/dashboards/${dashboardId}`)).data ?? {};
      } catch (error) {
        readBack = `Read-back failed (${error.status ? `HTTP ${error.status}` : error.message})`;
      }
      const savedDevices = new Set((saved.devices ?? saved.dataSources ?? []).map(d => String(d?.id)));
      const verified = String(saved.id ?? "") === dashboardId && normalizeName(saved.name) === normalizeName(dashboardName) &&
        String(saved.site?.id ?? saved.siteId ?? site.id) === site.id && wanted.every(w => savedDevices.has(w));
      return { receipt: { dashboardId }, dashboardId, verified, ...(readBack ? { readBack } : {}) };
    },
  });
  const dashboardId = outcome.dashboardId ?? outcome.receipt?.dashboardId;
  const links = {
    url: link(profile, `/dashboards/${dashboardId}`),
    builderUrl: link(profile, `/dashboards/${dashboardId}`, { aiAssistant: "build" }),
  };
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "dashboard", profile, applied: false, state: outcome.state, dashboardId, ...links,
      message: "This exact dashboard was already created; nothing new was written." };
  return { kind: "dashboard", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    dashboardId, ...links, preview, ...(outcome.readBack ? { readBack: outcome.readBack } : {}),
    next: "Use dashboard-widgets.mjs context and save to preview, create and verify native widgets. The dashboard has no widgets yet; builderUrl remains an optional web editor." };
}

// ---- Duplicate a dashboard (CopyNextGenDashboardDialog.js → POST /dashboards/copy) ----

// Keys of next-generation widget settings that hold a metric ID ("86") or lists of them.
const METRIC_KEYS = new Set(["metric", "primaryMetric", "secondaryMetric"]);
const METRIC_LISTS = new Set(["groupBy", "columnsSelected"]);
// Built-in dimensions every data source has; the copy keeps them as they are.
const BUILT_IN = /^(event_date.*|meter_id|meter_name|inherit_from_widget)$/;
const NOT_COPIED_DASHBOARD = ["sharing and bookmarks", "channel links", "AI reports and their schedules", "the data table",
  "locked and private settings (the copy is unlocked and not private)"];

function widgetSettings(dashboard) {
  return (dashboard.widgets ?? []).flatMap(w => (w.components ?? []).flatMap(c => (c.arguments ?? [])
    .map(a => ({ widget: String(w.name ?? w.id), type: w.type?.name ?? null, settings: a.nextGenWidgetSettings }))))
    .filter(x => x.settings && typeof x.settings === "object");
}

// Metric IDs each widget reads, found under the settings keys above at any depth (filters, aggregations).
export function usedMetrics(dashboard) {
  const used = new Map();
  const add = (metric, widget) => {
    const m = String(metric ?? "");
    if (!id(m) || BUILT_IN.test(m)) return;
    if (!used.has(m)) used.set(m, new Set());
    used.get(m).add(widget);
  };
  const walk = (value, widget) => {
    if (Array.isArray(value)) return value.forEach(v => walk(v, widget));
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (METRIC_KEYS.has(k) && (typeof v === "string" || typeof v === "number")) add(v, widget);
      else if (METRIC_LISTS.has(k) && Array.isArray(v)) v.forEach(x => (typeof x === "string" || typeof x === "number") && add(x, widget));
      else walk(v, widget);
    }
  };
  for (const { widget, settings } of widgetSettings(dashboard)) walk(settings, widget);
  return used;
}

const schemaMetrics = device => (device?.meterSchema?.metrics ?? []).map(m => ({
  id: String(m.metric?.id ?? m.metricId ?? ""), key: String(m.metric?.name ?? ""),
  name: String(m.displayName ?? m.metric?.name ?? ""), unit: m.uom?.name ?? null,
})).filter(m => id(m.id));

// Same metric ID, then same metric key, then same display name and unit.
export function matchMetric(metric, targetMetrics) {
  const same = targetMetrics.find(t => t.id === metric.id);
  if (same) return { target: same, how: "same metric" };
  const key = metric.key && targetMetrics.filter(t => t.key === metric.key);
  if (key?.length === 1) return { target: key[0], how: "same metric key" };
  const named = targetMetrics.filter(t => normalizeName(t.name) === normalizeName(metric.name) && t.unit === metric.unit);
  if (named.length === 1) return { target: named[0], how: "same name and unit" };
  return { target: null, how: "unresolved", candidates: targetMetrics.filter(t => t.unit === metric.unit).slice(0, 15) };
}

// A data source's unit from its name: type words and numbers without a camera suffix or prefix,
// so "Band Saw 1", "Bandsaw 1 | Cam 44", "Cam 44 - Bandsaw 1" and "BANDSAW-1" are the same saw
// while "Cam 1 Quality" keeps its camera number.
export function unitKey(name) {
  const lower = String(name ?? "").toLowerCase();
  const bare = lower.replace(/\s*[|(\-–,]?\s*\bcam(?:era)?\s*[#-]?\s*\d+\s*\)?\s*$/u, "")
    .replace(/^\s*\(?cam(?:era)?\s*[#-]?\s*\d+\s*\)?\s*[|:\-–,)]\s*/u, "");
  const plain = (/\p{L}/u.test(bare) ? bare : lower).replace(/(\p{L}+)[\s_-]+saw\b/gu, "$1saw")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2");
  const tokens = plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const number = t => /^\p{N}+$/u.test(t);
  return { words: tokens.filter(t => !number(t)).join(" "), numbers: tokens.filter(number).map(t => String(Number(t))).join(" ") };
}

// 3 same name, 2 same type and number, 1 only the same number, 0 nothing in common.
export function nameMatch(a, b) {
  if (normalizeName(a) === normalizeName(b)) return 3;
  const x = unitKey(a), y = unitKey(b);
  if ((x.words || x.numbers) && x.words === y.words && x.numbers === y.numbers) return 2;
  return x.numbers && x.numbers === y.numbers ? 1 : 0;
}

// The same unit by name outranks metric coverage, which outranks a shared number alone.
const rankOf = (name, coverage) => [name >= 2 ? name : 0, coverage, name === 1 ? 1 : 0];
const compareRank = (a = [], b = []) => { for (let i = 0; i < 3; i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); return 0; };

// One target per source: the strongest evidence chooses first. Equal fits stay unchosen for review,
// so several sources never collapse onto one target.
export function assignTargets(entries) {
  const taken = new Set();
  const order = [...entries].sort((a, b) => compareRank(b.scored[0]?.rank, a.scored[0]?.rank));
  for (const e of order) {
    const open = e.scored.filter(s => !taken.has(String(s.device.id)) && (s.resolved > 0 || s.name >= 2 || !e.usedHere.length));
    const ties = open.filter(s => compareRank(s.rank, open[0].rank) === 0);
    if (ties.length > 1) e.ties = ties;
    else if (open.length) { e.best = open[0]; taken.add(String(open[0].device.id)); }
    else e.allTaken = e.scored.length > 0;
  }
  return entries;
}

async function describeDevices(call, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    const rows = (await call("GET", route("/devices/all", { meterIds: ids.slice(i, i + 10).join(","), expand: "true", onlyMeters: "false" }))).data ?? [];
    for (const d of rows) out.set(String(d.id), d);
  }
  return out;
}

async function loadSource(call, site, dashboardId) {
  if (!id(dashboardId)) throw new Error("Dashboard ID required");
  const d = (await call("GET", `/dashboards/${dashboardId}`)).data ?? {};
  if (String(d.id ?? "") !== dashboardId || String(d.site?.id ?? d.siteId ?? "") !== site.id)
    throw new Blocked("scope", `Dashboard ${dashboardId} is not a dashboard of ${site.name} that this user can see`);
  if (String(d.type?.id ?? d.dashboardType?.id ?? "") !== "3")
    throw new Blocked("scope", "Only next-generation dashboards can be duplicated here; duplicate a classic dashboard from Zira.");
  return d;
}

// Read-only: the evidence and a proposed mapping for a copy to another site, for Claude to review.
export async function copyMapping({ call, profile = "prod", companyId, siteId, dashboardId, targetCompanyId, targetSiteId }) {
  const site = await resolveSite(call, companyId, siteId);
  const target = await resolveSite(call, targetCompanyId ?? companyId, targetSiteId ?? siteId);
  const source = await loadSource(call, site, dashboardId);
  const sourceIds = (source.devices ?? []).map(d => String(d.id)).filter(v => id(v));
  const used = usedMetrics(source);
  const described = await describeDevices(call, sourceIds);
  const inventory = target.id === site.id ? [] : await siteDataSources(call, target);
  const byKind = new Map();
  for (const d of inventory) {
    const kind = String(d.applying?.id ?? d.applyingId ?? "");
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(d);
  }
  // Data sources whose kind the site list does not show are described and filtered below.
  const kinds = new Set(sourceIds.map(s => String(described.get(s)?.applying?.id ?? "")));
  const candidateIds = [...new Set([...kinds, ""].flatMap(k => (byKind.get(k) ?? []).map(d => String(d.id))))];
  const targets = target.id === site.id ? described : await describeDevices(call, candidateIds.slice(0, 60));
  const entries = assignTargets(sourceIds.map(sid => {
    const src = described.get(sid) ?? { id: sid, name: (source.devices ?? []).find(d => String(d.id) === sid)?.name };
    const metrics = schemaMetrics(src);
    const usedHere = metrics.filter(m => used.has(m.id)).map(m => ({ ...m, widgets: [...used.get(m.id)].slice(0, 8) }));
    const kind = String(src.applying?.id ?? "");
    const pool = target.id === site.id ? [src] : candidateIds.map(c => targets.get(c)).filter(d => d && String(d.applying?.id ?? "") === kind);
    const scored = pool.map(t => {
      const tm = schemaMetrics(t);
      const matches = usedHere.map(m => ({ source: m, ...matchMetric(m, tm) }));
      const resolved = matches.filter(m => m.target).length;
      const name = nameMatch(src.name, t.name);
      return { device: t, matches, resolved, name, rank: rankOf(name, usedHere.length ? resolved / usedHere.length : 1) };
    }).sort((a, b) => compareRank(b.rank, a.rank));
    return { sid, src, usedHere, scored };
  }));
  const matched = s => `${s.resolved}/${s.matches.length} metrics matched`;
  const sameUnit = (s, src) => s.name === 3 ? ", same name" : s.name === 2 ? `, same type and number (${Object.values(unitKey(src.name)).filter(Boolean).join(" ")})`
    : s.name === 1 ? ", same number" : "";
  const remap = s => Object.fromEntries(s.matches.filter(m => m.target && m.target.id !== m.source.id).map(m => [m.source.id, m.target.id]));
  const devices = entries.map(({ sid, src, usedHere, scored, best, ties, allTaken }) => ({
    source: { id: sid, name: String(src.name ?? ""), kind: src.applying?.name ?? null, metricsUsedByWidgets: usedHere },
    proposed: best ? { id: String(best.device.id), name: String(best.device.name ?? "") } : null,
    ...(ties ? { ambiguous: true, candidates: ties.map(s => ({ id: String(s.device.id), name: String(s.device.name ?? ""), metricsMatched: `${s.resolved}/${usedHere.length}`,
      ...(Object.keys(remap(s)).length ? { metricMapping: remap(s) } : {}) })) } : {}),
    reason: best ? `${matched(best)}${sameUnit(best, src)}`
      : ties ? `${ties.length} data sources fit equally (${ties.map(s => s.device.name).join(", ")}). Choose one; it is left out of deviceMapping until then.`
      : allTaken ? "Every fitting data source at the target is already proposed for another source. Choose one, or null to have Zira copy this one there (\"Copy of\")."
      : "No data source of the same kind at the target; Zira will copy this one there (\"Copy of\").",
    metrics: (best?.matches ?? []).map(m => ({ source: m.source.id, sourceName: m.source.name, unit: m.source.unit,
      target: m.target?.id ?? null, targetName: m.target?.name ?? null, how: m.how,
      ...(m.candidates ? { candidates: m.candidates.map(c => ({ id: c.id, name: c.name })) } : {}) })),
    alternatives: scored.filter(s => s !== best && !ties?.includes(s)).slice(0, 3)
      .map(s => ({ id: String(s.device.id), name: String(s.device.name ?? ""), metricsMatched: `${s.resolved}/${usedHere.length}` })),
  }));
  const mapping = {
    deviceMapping: Object.fromEntries(devices.filter(d => !d.ambiguous).map(d => [d.source.id, d.proposed?.id ?? null])),
    metricMapping: Object.fromEntries(devices.flatMap(d => d.metrics.filter(m => m.target && m.target !== m.source).map(m => [m.source, m.target]))),
  };
  const names = new Map([...devices.map(d => [d.source.id, d.source.name]), ...[...targets.values()].map(d => [String(d.id), String(d.name ?? "")])]);
  const ambiguous = devices.filter(d => d.ambiguous).map(d => ({ dataSource: d.source.name, id: d.source.id, candidates: d.candidates.map(c => c.name) }));
  return {
    kind: "dashboard-copy-mapping", profile,
    source: { id: dashboardId, name: String(source.name ?? ""), site: { id: site.id, name: site.name }, widgets: (source.widgets ?? []).length },
    target: { siteId: target.id, siteName: target.name, sameSite: target.id === site.id },
    devices, mapping,
    ...(ambiguous.length ? { ambiguous } : {}),
    unresolved: devices.flatMap(d => d.metrics.filter(m => !m.target).map(m => ({ dataSource: d.source.name, metric: m.sourceName, unit: m.unit }))),
    widgets: widgetPlan(source, mapping.deviceMapping, names),
    note: "Review the proposal: confirm each data source (choose one for every ambiguous source; copy refuses a mapping without it) and every unresolved metric, edit mapping if needed, then pass it to copy --mapping. A widget whose metric stays unresolved keeps the source metric and may show no data. widgets shows what the copy restores after Zira's Duplicate: each widget's description and its chart's data source.",
  };
}

// ---- After Zira's Duplicate (copy_dashboard): it drops widget descriptions and keeps each chart
// argument's source data source. The plugin re-saves those widgets through the widget update route.

// The data source a copied widget's chart argument should name: the mapped one for a data source of
// the source dashboard; a chart's placeholder (Zira web saves a fixed ID) becomes the mapped first
// data source, as dashboard-widgets.mjs saves it. undefined: not known yet (unmapped or ambiguous).
function targetDevice(widget, deviceMapping, firstSource) {
  const from = argumentDevice(widget);
  if (from == null) return { from, to: null };
  const key = Object.hasOwn(deviceMapping, from) ? from : String(widget.type?.id) === "15" ? firstSource : null;
  return { from, to: key != null && Object.hasOwn(deviceMapping, key) ? deviceMapping[key] : undefined };
}

// What the copy restores per widget, from the source dashboard and a (proposed) mapping.
export function widgetPlan(source, deviceMapping, names = new Map()) {
  const first = String(source.devices?.[0]?.id ?? "");
  const label = v => v == null ? null : { id: String(v), name: names.get(String(v)) ?? null };
  return (source.widgets ?? []).map(w => {
    const { from, to } = targetDevice(w, deviceMapping, first);
    const description = typeof w.description === "string" && w.description.trim() ? w.description : null;
    const check = resaveBody(w, { device: from });
    return { widget: String(w.name ?? ""), type: w.type?.name ?? null, description: description ? "kept" : null,
      ...(from != null ? { device: { from: label(from), to: to === undefined ? "choose the mapping first" : to === null ? "the copy Zira makes" : label(to) } } : {}),
      ...(check.skip && (description || (from != null && to !== from)) ? { notRestored: check.skip } : {}) };
  });
}

// Data sources the copy holds for sources mapped to null (Zira created them): by name, or the only one left.
export function resolveCreated(sources, deviceMapping, copyDevices) {
  const full = {};
  for (const s of sources) if (deviceMapping[s.id] != null) full[s.id] = String(deviceMapping[s.id]);
  const mapped = new Set(Object.values(full));
  const left = copyDevices.filter(d => !mapped.has(String(d.id)));
  const open = sources.filter(s => Object.hasOwn(deviceMapping, s.id) && deviceMapping[s.id] === null);
  for (const s of open) {
    const named = left.filter(d => normalizeName(d.name).includes(normalizeName(s.name)));
    const pick = named.length === 1 ? named[0] : open.length === 1 && left.length === 1 ? left[0] : null;
    if (pick) full[s.id] = String(pick.id);
  }
  return full;
}

// meter_id filter values anywhere in the settings must name the copy's data sources (widget guard).
const meterIds = value => Array.isArray(value) ? value.flatMap(meterIds) : value && typeof value === "object"
  ? [...(value.metric === "meter_id" && typeof value.filterValue === "string" ? value.filterValue.split(",").map(v => v.trim()) : []),
    ...Object.values(value).flatMap(meterIds)] : [];

// Pair copied widgets with their source widgets (Zira keeps names and types) and plan the re-saves.
// Only empty descriptions and the untouched source data source are changed, never later edits.
export function planCopyFixes({ source, copy, deviceMapping }) {
  const first = String(source.devices?.[0]?.id ?? "");
  const onCopy = new Set((copy.devices ?? []).map(d => String(d.id)));
  const groups = new Map();
  for (const [side, list] of [["source", source.widgets], ["copy", copy.widgets]]) for (const w of list ?? []) {
    const key = `${w.type?.id}\u0000${w.name}`;
    if (!groups.has(key)) groups.set(key, { source: [], copy: [] });
    groups.get(key)[side].push(w);
  }
  const fixes = [], skipped = [];
  for (const g of groups.values()) {
    const byId = (a, b) => Number(a.id) - Number(b.id);
    g.source.sort(byId); g.copy.sort(byId);
    const wants = g.source.map(w => ({ description: typeof w.description === "string" ? w.description : "", ...targetDevice(w, deviceMapping, first) }));
    const name = String((g.source[0] ?? g.copy[0]).name ?? "");
    if (!g.source.length) continue;
    if (g.source.length !== g.copy.length) { skipped.push({ widget: name, reason: `${g.source.length} in the source and ${g.copy.length} in the copy` }); continue; }
    if (new Set(wants.map(x => JSON.stringify([x.description, x.from, x.to]))).size > 1) {
      skipped.push({ widget: name, reason: "several widgets share this name and type; cannot tell which copy is which" }); continue;
    }
    g.copy.forEach((w, i) => {
      const want = wants[i], current = argumentDevice(w), changes = {};
      if (!(w.description ?? "").trim() && want.description.trim()) changes.description = want.description;
      if (want.to != null && current === want.from && String(want.to) !== current) changes.device = { from: current, to: String(want.to) };
      if (!Object.keys(changes).length) return;
      const entry = { widgetId: String(w.id), widget: String(w.name ?? ""), changes };
      const r = resaveBody(w, { description: changes.description ?? w.description ?? "", device: changes.device?.to ?? current });
      const s = r.body?.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings;
      const outside = [r.body?.components?.[0]?.arguments?.[0]?.device?.id, String(w.type?.id) === "17" ? s?.device : null, ...meterIds(s)]
        .filter(v => v != null && !onCopy.has(String(v)));
      if (r.skip) skipped.push({ ...entry, reason: r.skip });
      else if (outside.length) skipped.push({ ...entry, reason: `it names data sources that are not on the copy (${[...new Set(outside)].join(", ")})` });
      else fixes.push({ ...entry, body: r.body });
    });
  }
  return { fixes, skipped };
}

const bodyDevice = body => { const v = body.components?.[0]?.arguments?.[0]?.device?.id; return v == null ? null : String(v); };

// Re-save each planned widget once, stop on an authorization denial, then read the copy back.
export async function applyCopyFixes(call, dashboardId, fixes) {
  const updated = [], failed = [];
  for (const f of fixes) {
    try {
      await call("PUT", `/dashboards/widgets/${f.widgetId}`, f.body);
      updated.push(f);
    } catch (error) {
      failed.push({ widgetId: f.widgetId, widget: f.widget, error: error.status ? `HTTP ${error.status}` : error.message });
      if ([401, 403].includes(error.status)) break;
    }
  }
  const notTried = fixes.slice(updated.length + failed.length).map(f => ({ widgetId: f.widgetId, widget: f.widget }));
  let saved = null, readBack = null;
  if (updated.length) try { saved = (await call("GET", `/dashboards/${dashboardId}`)).data ?? null; } catch (error) {
    readBack = `Read-back failed (${error.status ? `HTTP ${error.status}` : error.message})`;
  }
  const unverified = updated.filter(f => {
    const actual = saved?.widgets?.find(w => String(w.id) === f.widgetId);
    return !actual || (actual.description ?? "") !== (f.body.description ?? "") || argumentDevice(actual) !== bodyDevice(f.body) || !verifyWidget(actual, f.body);
  }).map(f => ({ widgetId: f.widgetId, widget: f.widget }));
  return { updated: updated.map(f => ({ widgetId: f.widgetId, widget: f.widget, ...f.changes })), failed, notTried, unverified,
    complete: !failed.length && !notTried.length && !unverified.length, ...(readBack ? { readBack } : {}) };
}

const readMapping = async file => {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const mapping = parsed.mapping ?? parsed;
  if (!mapping || typeof mapping.deviceMapping !== "object" || Array.isArray(mapping.deviceMapping)) throw new Error("Mapping file needs deviceMapping");
  return { deviceMapping: mapping.deviceMapping, metricMapping: mapping.metricMapping ?? {} };
};

export async function copyDashboard({
  call, profile = "prod", companyId, siteId, dashboardId, targetCompanyId, targetSiteId, name, mapping,
  apply = false, allowRepeat = false, receipts, resolve,
}) {
  const site = await resolveSite(call, companyId, siteId);
  const target = await resolveSite(call, targetCompanyId ?? companyId, targetSiteId ?? siteId);
  const sameSite = target.id === site.id;
  const source = await loadSource(call, site, dashboardId);
  const sources = (source.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") })).filter(d => id(d.id));
  const targetName = text(name, 120) || `${text(source.name, 110)} (copy)`;
  // Same site: every data source maps to itself, as Zira web sends.
  const chosen = sameSite && !mapping ? Object.fromEntries(sources.map(s => [s.id, s.id])) : mapping?.deviceMapping;
  if (!chosen) throw new Error("A copy to another site needs --mapping (run copy-mapping, review it, then pass the file)");
  const keys = Object.keys(chosen).filter(k => id(k));
  const targetIds = checkedTargets(chosen, sources);
  const inventory = sameSite ? new Map(sources.map(s => [s.id, s])) : new Map((await siteDataSources(call, target)).map(d => [String(d.id), d]));
  const outside = targetIds.filter(t => !inventory.has(t));
  if (outside.length) throw new Blocked("scope", `Some mapped data sources are not at ${target.name}`, { outside });
  const metricMapping = Object.fromEntries(Object.entries(mapping?.metricMapping ?? {}).map(([k, v]) => [String(k), String(v)]));
  if (!Object.entries(metricMapping).every(([k, v]) => id(k) && id(v))) throw new Error("metricMapping keys and values must be metric IDs");
  // Every mapped metric must exist on a mapped target data source.
  if (Object.keys(metricMapping).length) {
    const described = await describeDevices(call, targetIds);
    const available = new Set([...described.values()].flatMap(d => schemaMetrics(d).map(m => m.id)));
    const missing = Object.values(metricMapping).filter(m => !available.has(m));
    if (missing.length) throw new Blocked("scope", "Some mapped metrics are not on the mapped target data sources", { missing });
  }
  const idMapping = Object.fromEntries(keys.map(k => [k, chosen[k] === null ? null : String(chosen[k])]));
  const deviceMapping = { ...idMapping };
  for (const s of sources) {
    const t = deviceMapping[s.id];
    if (t && s.name) deviceMapping[s.name] = String(inventory.get(t)?.name ?? s.name);
  }
  const existing = (await siteDashboards(call, target)).filter(d => !d.isDeleted).map(d => String(d.name ?? ""));
  const suggestedName = uniqueName(targetName, existing);
  const filters = (source.widgets ?? []).filter(w => /filter/i.test(w.type?.name ?? "")).map(w => String(w.name ?? w.id));
  const preview = {
    source: { id: dashboardId, name: String(source.name ?? ""), widgets: (source.widgets ?? []).length },
    target: { siteId: target.id, siteName: target.name, sameSite },
    name: targetName,
    dataSources: sources.map(s => ({ from: s.name, to: deviceMapping[s.id] === null ? `a copy of ${s.name} at ${target.name}` : String(inventory.get(deviceMapping[s.id])?.name ?? deviceMapping[s.id]) })),
    metricsRemapped: Object.keys(metricMapping).length,
    afterCopy: afterCopySummary(widgetPlan(source, idMapping, new Map([...sources.map(s => [s.id, s.name]),
      ...[...inventory.values()].map(d => [String(d.id), String(d.name ?? "")])]))),
    notCopied: NOT_COPIED_DASHBOARD,
    ...(filters.length ? { warning: `Filter widgets (${filters.join(", ")}) may still point at the original dashboard's widgets; check them after copying.` } : {}),
    ...(suggestedName !== targetName ? { nameTaken: true, suggestedName } : {}),
  };
  if (!apply) return { kind: "dashboard-copy-draft", profile, preview, applied: false };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "dashboardId",
    key: fingerprint({ op: "dashboard-copy", profile, dashboardId, targetSiteId: target.id, name: normalizeName(targetName), deviceMapping, metricMapping }),
    summary: { kind: "dashboard-copy", dashboardId, siteId: target.id, name: targetName },
    precheck: async () => {
      if (suggestedName !== targetName)
        throw new Blocked("duplicate", `A dashboard named "${targetName}" already exists at ${target.name}. Use "${suggestedName}" or another name.`, { suggestedName });
    },
    reconcile: async () => {
      const found = (await siteDashboards(call, target)).filter(d => normalizeName(d.name) === normalizeName(targetName));
      return found.length === 1 ? { dashboardId: String(found[0].id) } : null;
    },
    run: async progress => {
      const body = (await call("POST", "/dashboards/copy", {
        targetDashboardName: targetName,
        targetSiteId: target.id,
        nameSuffix: null,
        sourceDashboardId: dashboardId,
        copyOnlyStructure: false,
        includeMeters: true,
        deviceMapping,
        metricMapping,
      })).data;
      const copyId = createdDashboardId(body) ?? await findByName(call, target, targetName);
      if (!copyId) throw new Error("Copy returned no dashboard ID; check the target site's dashboards before retrying");
      await progress({ dashboardId: copyId });
      const warnings = [];
      let saved = null;
      try {
        saved = (await call("GET", `/dashboards/${copyId}`)).data ?? null;
      } catch (error) {
        warnings.push(`Read-back failed (${error.status ? `HTTP ${error.status}` : error.message}); open the copy to check it.`);
      }
      let orphaned = [];
      if (saved) {
        const copied = (saved.devices ?? []).map(d => String(d.id)).filter(v => id(v));
        const schemas = await describeDevices(call, copied);
        const available = new Set([...schemas.values()].flatMap(d => schemaMetrics(d).map(m => m.id)));
        orphaned = [...usedMetrics(saved)].filter(([m]) => !available.has(m)).map(([m, w]) => ({ metric: m, widgets: [...w] }));
        if (orphaned.length) warnings.push(`${orphaned.length} metric(s) used by widgets are not on the copy's data sources; those widgets may show no data.`);
      }
      // Restore what Zira's Duplicate drops: widget descriptions and each chart's data source.
      let widgetFixes = null;
      if (saved) {
        const copyDevices = (saved.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
        const plan = planCopyFixes({ source, copy: saved, deviceMapping: resolveCreated(sources, idMapping, copyDevices) });
        widgetFixes = { ...await applyCopyFixes(call, copyId, plan.fixes), skipped: plan.skipped };
        if (!widgetFixes.complete)
          warnings.push(`Not every widget was restored (failed, not tried or unverified). Run fix-copy --copy-id ${copyId} with the same mapping to finish.`);
        if (plan.skipped.length)
          warnings.push(`${plan.skipped.length} widget(s) keep Zira's copy as it is: ${plan.skipped.map(x => `${x.widget} (${x.reason})`).join("; ")}.`);
      }
      const verified = !!saved && String(saved.id) === copyId && String(saved.site?.id ?? "") === target.id &&
        normalizeName(saved.name) === normalizeName(targetName) && (saved.widgets ?? []).length === (source.widgets ?? []).length &&
        (saved.devices ?? []).length === sources.length && !!widgetFixes?.complete;
      return { receipt: { dashboardId: copyId }, dashboardId: copyId, verified, warnings, orphaned, widgetFixes };
    },
  });
  const dashboardIdOut = outcome.dashboardId ?? outcome.receipt?.dashboardId;
  const links = { url: link(profile, `/dashboards/${dashboardIdOut}`) };
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "dashboard-copy", profile, applied: false, state: outcome.state, dashboardId: dashboardIdOut, ...links,
      message: "This exact copy was already made; nothing new was written." };
  return { kind: "dashboard-copy", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    dashboardId: dashboardIdOut, warnings: outcome.warnings, ...(outcome.orphaned.length ? { orphanedMetrics: outcome.orphaned } : {}),
    ...(outcome.widgetFixes ? { widgetFixes: outcome.widgetFixes } : {}), preview, ...links };
}

// Every data source of the source dashboard, and only those, mapped to an ID or null.
function checkedTargets(chosen, sources) {
  const keys = Object.keys(chosen).filter(k => id(k));
  if (keys.length !== sources.length || !sources.every(s => keys.includes(s.id)))
    throw new Error("The mapping must list every data source of the source dashboard, and only those (copy-mapping leaves out ambiguous ones for you to choose)");
  const targetIds = [...new Set(Object.values(chosen).filter(v => v !== null).map(String))];
  if (!targetIds.every(id)) throw new Error("Mapped data sources must be IDs or null");
  return targetIds;
}

function afterCopySummary(plan) {
  const descriptions = plan.filter(w => w.description && !w.notRestored).length;
  const devices = plan.filter(w => w.device && typeof w.device.to === "object" && w.device.to?.id !== w.device.from.id && !w.notRestored).length;
  return { descriptions, devices,
    note: `Zira's Duplicate drops widget descriptions and keeps each chart's source data source. After copying, the plugin re-saves the affected widgets (${descriptions} description(s), ${devices} data source field(s)) with only those changes and reads them back.`,
    ...(plan.some(w => w.notRestored) ? { notRestored: plan.filter(w => w.notRestored).map(w => ({ widget: w.widget, reason: w.notRestored })) } : {}) };
}

// Restore an existing copy's widget descriptions and chart data sources from its source dashboard
// (for copies made by Zira web's Duplicate, or a copy whose restore step did not finish).
export async function fixCopy({
  call, profile = "prod", companyId, siteId, dashboardId, targetCompanyId, targetSiteId, copyId, mapping,
  apply = false, allowRepeat = false, receipts, resolve,
}) {
  const site = await resolveSite(call, companyId, siteId);
  const target = await resolveSite(call, targetCompanyId ?? companyId, targetSiteId ?? siteId);
  if (!id(copyId ?? "")) throw new Error("--copy-id required: the copied dashboard to restore");
  if (copyId === dashboardId) throw new Error("--copy-id must be the copy, not the source dashboard");
  const source = await loadSource(call, site, dashboardId);
  const copy = await loadSource(call, target, copyId);
  const sameSite = target.id === site.id;
  const sources = (source.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") })).filter(d => id(d.id));
  const chosen = sameSite && !mapping ? Object.fromEntries(sources.map(s => [s.id, s.id])) : mapping?.deviceMapping;
  if (!chosen) throw new Error("A copy at another site needs --mapping (the source → copy data sources)");
  const copyDevices = (copy.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
  const outside = checkedTargets(chosen, sources).filter(t => !copyDevices.some(d => d.id === t));
  if (outside.length) throw new Blocked("scope", `Some mapped data sources are not data sources of the copy ${copyId}`, { outside });
  const idMapping = Object.fromEntries(Object.entries(chosen).filter(([k]) => id(k)).map(([k, v]) => [k, v === null ? null : String(v)]));
  const full = resolveCreated(sources, idMapping, copyDevices);
  const plan = planCopyFixes({ source, copy, deviceMapping: full });
  const names = new Map([...sources, ...copyDevices].map(d => [d.id, d.name]));
  const label = v => v == null ? null : `${names.get(v) ?? "data source"} (${v})`;
  const url = link(profile, `/dashboards/${copyId}`);
  const preview = {
    source: { id: dashboardId, name: String(source.name ?? ""), siteName: site.name },
    copy: { id: copyId, name: String(copy.name ?? ""), siteName: target.name, url },
    changes: plan.fixes.map(f => ({ widgetId: f.widgetId, widget: f.widget, ...(f.changes.description ? { description: f.changes.description } : {}),
      ...(f.changes.device ? { device: `${label(f.changes.device.from)} → ${label(f.changes.device.to)}` } : {}) })),
    ...(plan.skipped.length ? { skipped: plan.skipped.map(({ widgetId, widget, reason }) => ({ widgetId, widget, reason })) } : {}),
    note: "Only empty descriptions and chart data sources still on the source's data source change; every other widget setting is saved back as Zira has it.",
  };
  if (!apply) return { kind: "dashboard-copy-fix-draft", profile, preview, applied: false };
  if (!plan.fixes.length) return { kind: "dashboard-copy-fix", profile, applied: false, state: "nothing-to-do", url, preview };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "dashboardId",
    key: fingerprint({ op: "dashboard-copy-fix", profile, copyId, fixes: plan.fixes.map(f => [f.widgetId, f.body]) }),
    summary: { kind: "dashboard-copy-fix", dashboardId: copyId, siteId: target.id, widgets: plan.fixes.length },
    reconcile: async () => {
      const now = (await call("GET", `/dashboards/${copyId}`)).data ?? {};
      return planCopyFixes({ source, copy: now, deviceMapping: full }).fixes.length ? null : { dashboardId: copyId };
    },
    run: async () => {
      const result = await applyCopyFixes(call, copyId, plan.fixes);
      return { receipt: { dashboardId: copyId, updated: result.updated.map(u => u.widgetId) }, ...result };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "dashboard-copy-fix", profile, applied: false, state: outcome.state, url, message: "These widgets were already restored; nothing new was written." };
  return { kind: "dashboard-copy-fix", profile, applied: true, state: outcome.complete ? "updated" : "unverified", verified: outcome.complete, url,
    updated: outcome.updated, ...(outcome.failed.length ? { failed: outcome.failed } : {}), ...(outcome.notTried.length ? { notTried: outcome.notTried } : {}),
    ...(outcome.unverified.length ? { unverified: outcome.unverified } : {}), ...(outcome.readBack ? { readBack: outcome.readBack } : {}),
    ...(plan.skipped.length ? { skipped: preview.skipped } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, name: { type: "string" },
    description: { type: "string" }, "data-source-ids": { type: "string" }, range: { type: "string" },
    interval: { type: "string" }, apply: { type: "boolean" }, "allow-repeat": { type: "boolean" },
    receipts: { type: "string" }, profile: { type: "string" }, "resolve-pending": { type: "string" },
    "dashboard-id": { type: "string" }, "target-company-id": { type: "string" }, "target-site-id": { type: "string" },
    mapping: { type: "string" }, out: { type: "string" }, "copy-id": { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  if (["copy", "copy-mapping", "fix-copy"].includes(args[0])) {
    // A copy re-saves up to one widget per request after the copy itself.
    const scope = { call: await liveSession(profile, { allow: ROUTES, maxRequests: 200 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], targetCompanyId: o["target-company-id"], targetSiteId: o["target-site-id"] };
    if (args[0] === "copy-mapping") {
      const proposal = await copyMapping(scope);
      if (o.out) { await writeFile(o.out, JSON.stringify(proposal, null, 2), { mode: 0o600 }); proposal.savedTo = o.out; }
      return proposal;
    }
    const writes = { mapping: o.mapping ? await readMapping(o.mapping) : undefined,
      apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) };
    if (args[0] === "fix-copy") return fixCopy({ ...scope, ...writes, copyId: o["copy-id"] });
    return copyDashboard({ ...scope, ...writes, name: o.name });
  }
  if (args[0] !== "create") throw new Error("Choose create, copy-mapping, copy or fix-copy");
  return createDashboard({
    call: await liveSession(profile, { allow: ROUTES, maxRequests: 40 }), profile,
    companyId: o["company-id"], siteId: o["site-id"], name: o.name, description: o.description,
    dataSourceIds: o["data-source-ids"], range: o.range ?? "today", interval: o.interval ?? "hourly",
    apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts),
  });
}

const cliProfile = () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod";

// A blocked copy points to the source dashboard in Zira, whose site Dashboards tab has Duplicate.
export function handoffInfo(argv = process.argv) {
  const copy = argv[2] === "fix-copy" ? argValue("copy-id", argv) : undefined;
  if (id(copy ?? "")) {
    const profile = ["prod", "integ"].includes(cliProfile()) ? cliProfile() : "prod";
    return { pageUrl: link(profile, `/dashboards/${copy}`),
      details: "In Zira, open the copy and edit each listed widget: paste the source widget's description. Nothing was changed here." };
  }
  const source = ["copy", "copy-mapping"].includes(argv[2]) ? argValue("dashboard-id", argv) : undefined;
  if (id(source ?? "")) {
    const profile = ["prod", "integ"].includes(cliProfile()) ? cliProfile() : "prod";
    return { pageUrl: link(profile, `/dashboards/${source}`),
      details: "In Zira, open the site's Dashboards tab and use ⋯ → Duplicate on this dashboard. Nothing was copied here." };
  }
  return { prompt: /^[1-9]\d*(,[1-9]\d*)*$/.test(argValue("data-source-ids", argv) ?? "")
    ? `Create a dashboard\ndata-source-ids: ${argValue("data-source-ids", argv)}` : "build a dashboard" };
}

if (isMain(import.meta)) runCli(main, { profile: cliProfile, handoffInfo: () => handoffInfo() });
