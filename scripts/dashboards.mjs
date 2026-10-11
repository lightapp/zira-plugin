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

const HELP = `Zira dashboards — start a next-generation dashboard
node scripts/dashboards.mjs create --company-id ID --site-id ID --name TEXT
    --data-source-ids ID,ID [--description TEXT] [--range RANGE] [--interval INTERVAL]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/dashboards.mjs copy-mapping --company-id ID --site-id ID --dashboard-id ID
    [--target-company-id ID] [--target-site-id ID] [--out FILE]
node scripts/dashboards.mjs copy --company-id ID --site-id ID --dashboard-id ID [--name TEXT]
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
Common: --profile prod|integ

RANGE: ${"today yesterday this-week last-week last-7-days last-14-days last-21-days last-30-days last-60-days last-365-days last-60-minutes"}
INTERVAL: last-reading 1-minute 5-minutes 15-minutes hourly daily weekly monthly

create previews by default. --apply creates one dashboard with those data sources and
reads it back. Widgets are drafted afterwards in the dashboard's AI builder link.
copy-mapping reads (writes nothing in Zira) the source dashboard's data sources, the metrics its
widgets use and the target site's data sources of the same kind, and proposes a mapping
(--out saves it). copy previews a duplicate of a next-generation dashboard (default name
"<name> (copy)"); in the same site every data source maps to itself, another site needs
--mapping. --apply copies it once and reads it back.
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
  ["GET", /^\/devices\/all$/], ["POST", /^\/dashboards\/copy$/],
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
    next: "Open builderUrl to draft widgets with the dashboard's AI builder, then review and save them there. The dashboard has no widgets yet." };
}

// ---- Duplicate a dashboard (CopyNextGenDashboardDialog.js → POST /dashboards/copy) ----

// Keys of next-generation widget settings that hold a metric ID ("86") or lists of them.
const METRIC_KEYS = new Set(["metric", "primaryMetric", "secondaryMetric"]);
const METRIC_LISTS = new Set(["groupBy", "columnsSelected"]);
// Built-in dimensions every data source has; the copy keeps them as they are.
const BUILT_IN = /^(event_date.*|meter_id|meter_name|inherit_from_widget)$/;
const NOT_COPIED_DASHBOARD = ["sharing and bookmarks", "channel links", "AI reports and their schedules", "the data table",
  "widget descriptions", "locked and private settings (the copy is unlocked and not private)"];

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
  const devices = sourceIds.map(sid => {
    const src = described.get(sid) ?? { id: sid, name: (source.devices ?? []).find(d => String(d.id) === sid)?.name };
    const metrics = schemaMetrics(src);
    const usedHere = metrics.filter(m => used.has(m.id)).map(m => ({ ...m, widgets: [...used.get(m.id)].slice(0, 8) }));
    const kind = String(src.applying?.id ?? "");
    const pool = target.id === site.id ? [src] : candidateIds.map(c => targets.get(c)).filter(d => d && String(d.applying?.id ?? "") === kind);
    const scored = pool.map(t => {
      const tm = schemaMetrics(t);
      const matches = usedHere.map(m => ({ source: m, ...matchMetric(m, tm) }));
      const resolved = matches.filter(m => m.target).length;
      const sameName = normalizeName(t.name) === normalizeName(src.name);
      return { device: t, matches, resolved, sameName, score: (usedHere.length ? resolved / usedHere.length : 1) + (sameName ? 0.5 : 0) };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0] && (scored[0].resolved > 0 || scored[0].sameName || !usedHere.length) ? scored[0] : null;
    return {
      source: { id: sid, name: String(src.name ?? ""), kind: src.applying?.name ?? null, metricsUsedByWidgets: usedHere },
      proposed: best ? { id: String(best.device.id), name: String(best.device.name ?? "") } : null,
      reason: best ? `${best.resolved}/${usedHere.length} metrics matched${best.sameName ? ", same name" : ""}`
        : "No data source of the same kind at the target; Zira will copy this one there (\"Copy of\").",
      metrics: (best?.matches ?? []).map(m => ({ source: m.source.id, sourceName: m.source.name, unit: m.source.unit,
        target: m.target?.id ?? null, targetName: m.target?.name ?? null, how: m.how,
        ...(m.candidates ? { candidates: m.candidates.map(c => ({ id: c.id, name: c.name })) } : {}) })),
      alternatives: scored.slice(1, 4).map(s => ({ id: String(s.device.id), name: String(s.device.name ?? ""), metricsMatched: `${s.resolved}/${usedHere.length}` })),
    };
  });
  const mapping = {
    deviceMapping: Object.fromEntries(devices.map(d => [d.source.id, d.proposed?.id ?? null])),
    metricMapping: Object.fromEntries(devices.flatMap(d => d.metrics.filter(m => m.target && m.target !== m.source).map(m => [m.source, m.target]))),
  };
  return {
    kind: "dashboard-copy-mapping", profile,
    source: { id: dashboardId, name: String(source.name ?? ""), site: { id: site.id, name: site.name }, widgets: (source.widgets ?? []).length },
    target: { siteId: target.id, siteName: target.name, sameSite: target.id === site.id },
    devices, mapping,
    unresolved: devices.flatMap(d => d.metrics.filter(m => !m.target).map(m => ({ dataSource: d.source.name, metric: m.sourceName, unit: m.unit }))),
    note: "Review the proposal: confirm each data source and every unresolved metric, edit mapping if needed, then pass it to copy --mapping. A widget whose metric stays unresolved keeps the source metric and may show no data.",
  };
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
  if (keys.length !== sources.length || !sources.every(s => keys.includes(s.id)))
    throw new Error("The mapping must list every data source of the source dashboard, and only those");
  const targetIds = [...new Set(Object.values(chosen).filter(v => v !== null).map(String))];
  if (!targetIds.every(id)) throw new Error("Mapped data sources must be IDs or null");
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
  const deviceMapping = { ...Object.fromEntries(keys.map(k => [k, chosen[k] === null ? null : String(chosen[k])])) };
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
      const verified = !!saved && String(saved.id) === copyId && String(saved.site?.id ?? "") === target.id &&
        normalizeName(saved.name) === normalizeName(targetName) && (saved.widgets ?? []).length === (source.widgets ?? []).length &&
        (saved.devices ?? []).length === sources.length;
      return { receipt: { dashboardId: copyId }, dashboardId: copyId, verified, warnings, orphaned };
    },
  });
  const dashboardIdOut = outcome.dashboardId ?? outcome.receipt?.dashboardId;
  const links = { url: link(profile, `/dashboards/${dashboardIdOut}`) };
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "dashboard-copy", profile, applied: false, state: outcome.state, dashboardId: dashboardIdOut, ...links,
      message: "This exact copy was already made; nothing new was written." };
  return { kind: "dashboard-copy", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    dashboardId: dashboardIdOut, warnings: outcome.warnings, ...(outcome.orphaned.length ? { orphanedMetrics: outcome.orphaned } : {}), preview, ...links };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, name: { type: "string" },
    description: { type: "string" }, "data-source-ids": { type: "string" }, range: { type: "string" },
    interval: { type: "string" }, apply: { type: "boolean" }, "allow-repeat": { type: "boolean" },
    receipts: { type: "string" }, profile: { type: "string" }, "resolve-pending": { type: "string" },
    "dashboard-id": { type: "string" }, "target-company-id": { type: "string" }, "target-site-id": { type: "string" },
    mapping: { type: "string" }, out: { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  if (["copy", "copy-mapping"].includes(args[0])) {
    const scope = { call: await liveSession(profile, { allow: ROUTES, maxRequests: 80 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], targetCompanyId: o["target-company-id"], targetSiteId: o["target-site-id"] };
    if (args[0] === "copy-mapping") {
      const proposal = await copyMapping(scope);
      if (o.out) { await writeFile(o.out, JSON.stringify(proposal, null, 2), { mode: 0o600 }); proposal.savedTo = o.out; }
      return proposal;
    }
    return copyDashboard({ ...scope, name: o.name, mapping: o.mapping ? await readMapping(o.mapping) : undefined,
      apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) });
  }
  if (args[0] !== "create") throw new Error("Choose create, copy-mapping or copy");
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
