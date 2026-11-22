#!/usr/bin/env node
// Start a next-generation dashboard like the Home Assistant builder (create it with the
// selected site data sources, then draft widgets in its AI builder), or duplicate one the way
// Zira web's Duplicate does, with a reviewed data source and metric mapping for another site.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  Blocked, argValue, fingerprint, guardedWrite, id, idList, isMain, link, listAll, liveSession, normalizeName,
  originFor, receiptsFile, resolveScope, resolveSite, route, runCli, scopeDashboards, siteDataSources, text,
} from "./client.mjs";
import { argumentDevice, resaveBody, verifyWidget } from "./dashboard-widgets.mjs";
import { describeSources } from "../skills/readings-report/scripts/store.mjs";
import {
  EDIT_ROUTES, PLATFORM_CHANGE, SITE_ROUTES, applyWrites, editDashboard, loadDashboard, notEnabled, planEdit, planRelink, putSiteDays,
  revision, runWrites, siteDashboardList, siteDaysBody, siteRow, siteSettings, verifyWrites,
} from "./dashboard-edit.mjs";

// Kept here, not imported: dashboard-delete.mjs builds on dashboard-rollout.mjs, which builds on this module.
const DELETE_PLATFORM_CHANGE = "Zira's plugin access update for dashboard deletes";

const HELP = `Zira dashboards — start a next-generation dashboard
node scripts/dashboards.mjs create --company-id ID --site-id ID --name TEXT
    --data-source-ids ID,ID | --company-level [--description TEXT] [--range RANGE] [--interval INTERVAL]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
    --company-level: a Private dashboard without data sources of its own, for embedded/custom widgets that
    read any site of the company (dashboard-widgets.mjs types embedded and custom).
node scripts/dashboards.mjs copy-mapping --company-id ID --site-id ID --dashboard-id ID
    [--target-company-id ID] [--target-site-id ID] [--out FILE]
node scripts/dashboards.mjs copy --company-id ID --site-id ID --dashboard-id ID [--name TEXT]
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE] [--dashboard-mapping SRC:COPY,...|FILE]
    [--match-site-day-start]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/dashboards.mjs fix-copy --company-id ID --site-id ID --dashboard-id ID --copy-id ID
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/dashboards.mjs relink --company-id ID --site-id ID --dashboard-id ID --copy-id ID
    [--target-company-id ID] [--target-site-id ID] [--mapping FILE] [--dashboard-mapping SRC:COPY,...|FILE]
    [--skip-platform] [--apply --expected REVISION] [--receipts FILE]
node scripts/dashboards.mjs edit --company-id ID --site-id ID --dashboard-id ID --spec FILE
    [--skip-platform] [--apply --expected REVISION] [--receipts FILE]
node scripts/dashboards.mjs site-settings --company-id ID --site-id ID [--day-start HH:MM|MINUTES]
    [--first-day-of-week 0-6|monday…] [--apply --expected REVISION] [--receipts FILE]
node scripts/dashboards.mjs rollout --plan FILE [--skip-platform]
    [--apply --expected FILE --backup-dir DIR] [--receipts FILE]
node scripts/dashboards.mjs restore --company-id ID --site-id ID --dashboard-id ID --backup FILE [--skip-platform]
    [--apply --expected REVISION --backup-dir DIR] [--receipts FILE]
node scripts/dashboards.mjs sharing --company-id ID --site-id ID --dashboard-ids ID,ID | --plan FILE
node scripts/dashboards.mjs delete-widgets --company-id ID --site-id ID --dashboard-id ID
    --widget-ids ID,ID | --widget-names "NAME","NAME" [--unlink] [--keep-layout] [--allow-locked]
    [--apply --expected REVISION --backup-dir DIR] [--resolve-pending none] [--receipts FILE]
node scripts/dashboards.mjs delete --company-id ID --site-id ID --dashboard-id ID [--allow-linked] [--allow-locked]
    [--apply --expected REVISION --backup-dir DIR] [--resolve-pending none] [--receipts FILE]
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
copy also relinks what Zira's Duplicate leaves pointing at the source: filter targets, shortcuts to the
source itself or to dashboards in --dashboard-mapping, camera/live-count tiles on mapped data sources
(mapping deviceMapping or tileDeviceMapping) and every breakpoint's layout (tablet/phone derived from lg
when the source has none). --match-site-day-start also sets the target site's day start and first day of
week to the source site's. relink previews (--apply makes) the same for an existing copy, e.g. after
copying several dashboards that link to each other (--dashboard-mapping 11779:11918,11797:11916).
edit previews field-level changes from a spec and --apply saves each changed object once, then reads the
dashboard back and checks only the intended fields changed. Spec: {"version":1,
 "dashboard":{name,description,isShared,isLocked,isPrivate,lazyLoading,range,interval},
 "widgets":[{widgetId,name?,description?,filterTargets?:[widgetId],shortcuts?:[{index,dashboardId,displayText?}],
   deviceId?,rotation?,primaryMetric?}],
 "layout":{"lg":[{i,x,y,w,h}],"md":[…],"sm":[…],"xs":[…]}, "copyLayout":{"from":"lg","to":["md","sm","xs"]}}.
site-settings previews (--apply sets) the site's day start (minutes after midnight) and first day of
week; these are site settings shared by every dashboard. Dashboard settings, site settings, shortcut,
camera and live-count widgets and list-valued filters need ${PLATFORM_CHANGE} deployed for plugin sign-in;
until then they stop with not_enabled before anything else is written. Dashboard names are unique per
site (Zira answers HTTP 409).
rollout previews one change on many dashboards (writes nothing) and prints each dashboard's changes and
revision. Plan: {"version":1,"label":"time-analysis","change":{…},"skip":[dashboardId],
 "sites":[{companyId,siteId,dashboardId,label?,deviceMapping?:{sourceId: targetId | [targetIds]}}]}.
change is exactly one of
 {"edit": <edit spec; a widget change may give widgetName[, widgetType] instead of widgetId>},
 {"copySection": {"source":{companyId,siteId,dashboardId},"header":"Time analysis",
   "until":"<widget name where the section ends>","position":"bottom"|"above-header:<name>","rename":{name: newName},
   "chartDataSource":"first-mapped","extendFilters":true}},
 {"remapDataSources": {"widgetNames":[…],"chartDataSource":"first-mapped"}}.
copySection copies the header and the widgets below it up to the next header onto each dashboard, with data
sources mapped per site (one to one, one to many: = becomes IN, or [] to leave one out), links to the new widgets and a place on
every breakpoint. It refuses a dashboard that already has that header, a widget bound to one data source that
maps to several, unmapped data sources and widget types it cannot create. One dashboard that fails refuses
the whole plan (exit 2) unless it is listed under skip. --apply needs --expected FILE (the saved preview) and
--backup-dir DIR: each dashboard is checked against its reviewed revision, backed up to
<dashboardId>-<UTC time>-before-<label>.json and read back before its first write, saved under its own
receipt and read back. The run stops at the first dashboard that fails or is not verified and reports
done / failed / notTried; a rerun answers already-done for finished dashboards.
restore previews setting a dashboard back to a backup file (dashboard settings, each remaining widget and the
layout) and lists under cannotRestore what stays different: widgets added or deleted since (nothing is
deleted or recreated) and data sources. --apply needs --expected REVISION and --backup-dir DIR.
sharing reads each dashboard from Zira's server and reports private (= !isShared), isShared and isPrivate.
It writes nothing. The web editor's settings dialog can show an older cached value; the server value is the truth.
delete-widgets previews (writes nothing) each chosen widget (ID, name, type) and what else on the dashboard points
at it: filters that target it and AI summaries that read it. It refuses while a remaining widget points at one
unless --unlink is given; then those widgets are saved once without the links, and the preview shows each change.
A filter or AI summary that would be left with nothing is refused: delete it too. --apply needs --expected
REVISION and --backup-dir DIR: under one receipt the dashboard is checked against the reviewed revision, backed
up to <dashboardId>-<UTC time>-before-delete-widgets.json and read back, then widgets are deleted one at a time,
their layout rows are removed on every breakpoint and the dashboard is read back: the widgets are gone and
nothing else changed. It stops at the first failure and reports done / failed / notTried. --keep-layout leaves
the layout unsaved (for a layout the layout route refuses). delete previews removing a whole next-generation
dashboard with its widgets, scans the site's other dashboards for shortcut cards that open it and refuses while
one does (or one could not be read) unless --allow-linked; --apply backs it up the same way, deletes it once and
checks it is gone. Locked dashboards need --allow-locked. A delete cannot be undone here: restore never
recreates; the backup is the record to rebuild from. Deletes need ${DELETE_PLATFORM_CHANGE} deployed for plugin
sign-in; until then apply stops with not_enabled before anything is written.
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
  ["PUT", /^\/dashboards\/configuration-layout\/[1-9]\d*$/],
];
const MAX_DATA_SOURCES = 50;
const MAX_COMPANY_DATA_SOURCES = 200;

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
  apply = false, allowRepeat = false, receipts, resolve, companyLevel = false,
}) {
  // --company-level: a company dashboard (no site) as Zira web's company channel creates it; its data sources may be
  // on any site of the company. Otherwise a site dashboard with that site's data sources.
  if (companyLevel && siteId != null && siteId !== "") throw new Error("--company-level creates a dashboard of the company, without a site: leave out --site-id");
  const site = companyLevel ? await resolveScope(call, companyId, null) : await resolveSite(call, companyId, siteId);
  const dashboardName = text(name, 120);
  if (!dashboardName) throw new Error("A dashboard name is required");
  if (!Object.hasOwn(RANGES, range)) throw new Error("Unknown --range");
  if (!Object.hasOwn(INTERVALS, interval)) throw new Error("Unknown --interval");
  const wanted = idList(dataSourceIds);
  // A company-level dashboard may start without data sources (headers, shortcuts, embedded/custom widgets).
  if (companyLevel ? !wanted.every(id) : !wanted.length || !wanted.every(id)) throw new Error("Choose one or more data source IDs from this site");
  if (wanted.length > (companyLevel ? MAX_COMPANY_DATA_SOURCES : MAX_DATA_SOURCES)) throw new Error(`Choose at most ${companyLevel ? MAX_COMPANY_DATA_SOURCES : MAX_DATA_SOURCES} data sources`);
  let inventory;
  if (companyLevel) {
    const details = wanted.length ? await describeSources(call, wanted) : new Map();
    const foreign = wanted.filter(w => !details.get(w) || details.get(w).isDeleted || String(details.get(w).companyId ?? "") !== site.companyId);
    if (foreign.length) throw new Blocked("scope", "Some data sources are not readable data sources of the selected company", { missing: foreign });
    inventory = details;
  } else {
    inventory = new Map((await siteDataSources(call, site)).map(d => [String(d.id), d]));
    const missing = wanted.filter(w => !inventory.has(w));
    if (missing.length) throw new Blocked("scope", "Some data sources are not in the selected site", { missing });
  }
  const dataSources = wanted.map(w => ({ id: w, name: String(inventory.get(w).name ?? "Data source") }));
  const existing = (await (companyLevel ? scopeDashboards(call, site) : siteDashboards(call, site))).filter(d => !d.isDeleted).map(d => String(d.name ?? ""));
  const suggestedName = uniqueName(dashboardName, existing);
  const preview = {
    ...(companyLevel ? { company: { id: site.companyId, name: site.name } } : { site: { id: site.id, name: site.name } }), name: dashboardName, description: text(description, 500) || null,
    dataSources, defaultRange: range, defaultInterval: interval, type: "next-generation",
    ...(companyLevel ? { companyLevel: true, private: true, note: "Company-level (company channel's Dashboards tab, no site). Add widgets with dashboard-widgets.mjs without --site-id; data sources may be on any site of the company. It starts Private: only you see it until it is shared." } : {}),
    ...(suggestedName !== dashboardName ? { nameTaken: true, suggestedName } : {}),
  };
  const webPrompt = `Create a dashboard\ndata-source-ids: ${wanted.join(",")}`;
  if (!apply) return { kind: "dashboard-draft", profile, preview, applied: false, webPrompt };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "dashboardId",
    key: fingerprint({ op: "create-dashboard", profile, siteId: site.id, ...(companyLevel ? { companyId: site.companyId } : {}), name: normalizeName(dashboardName), dataSources: [...wanted].sort(), ...(companyLevel ? { companyLevel: true } : {}) }),
    summary: { kind: "dashboard", siteId: site.id, name: dashboardName },
    precheck: async () => {
      if (suggestedName !== dashboardName)
        throw new Blocked("duplicate", `A dashboard named "${dashboardName}" already exists at ${site.name}. Use "${suggestedName}" or another name.`, { suggestedName });
    },
    // The precheck guaranteed the name was free, so exactly one match now is this attempt's.
    reconcile: async () => {
      const found = (await (companyLevel ? scopeDashboards(call, site) : siteDashboards(call, site))).filter(d => normalizeName(d.name) === normalizeName(dashboardName));
      return found.length === 1 ? { dashboardId: String(found[0].id) } : null;
    },
    run: async progress => {
      const body = (await call("POST", "/dashboards/new", {
        name: dashboardName,
        description: preview.description,
        ...(companyLevel ? {} : { siteId: site.id }),
        companyId: site.companyId,
        isLocked: true,
        isShared: false,
        defaultDisplayRange: { id: RANGES[range] },
        defaultDisplayInterval: { id: INTERVALS[interval] },
        configurationLayout: { lg: [], md: [], sm: [], xs: [] },
        type: { id: "3", name: "Device" },
        ...(dataSources.length ? { devices: dataSources } : {}),
        isPrivate: !!companyLevel,
      })).data;
      const dashboardId = createdDashboardId(body) ?? (companyLevel
        ? (await scopeDashboards(call, site)).filter(d => normalizeName(d.name) === normalizeName(dashboardName)).map(d => String(d.id))[0]
        : await findByName(call, site, dashboardName));
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
        (companyLevel ? (saved.site?.id ?? saved.siteId) == null && String(saved.companyId ?? "") === site.companyId
          : String(saved.site?.id ?? saved.siteId ?? site.id) === site.id) && wanted.every(w => savedDevices.has(w));
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
  const tiles = await tileDeviceProposals(call, source, sourceIds, target.id === site.id ? null : inventory);
  const mapping = {
    deviceMapping: Object.fromEntries(devices.filter(d => !d.ambiguous).map(d => [d.source.id, d.proposed?.id ?? null])),
    metricMapping: Object.fromEntries(devices.flatMap(d => d.metrics.filter(m => m.target && m.target !== m.source).map(m => [m.source, m.target]))),
    ...(tiles.length ? { tileDeviceMapping: Object.fromEntries(tiles.filter(t => t.proposed).map(t => [t.source.id, t.proposed.id])) } : {}),
  };
  const names = new Map([...devices.map(d => [d.source.id, d.source.name]), ...[...targets.values()].map(d => [String(d.id), String(d.name ?? "")])]);
  const ambiguous = devices.filter(d => d.ambiguous).map(d => ({ dataSource: d.source.name, id: d.source.id, candidates: d.candidates.map(c => c.name) }));
  return {
    kind: "dashboard-copy-mapping", profile,
    source: { id: dashboardId, name: String(source.name ?? ""), site: { id: site.id, name: site.name }, widgets: (source.widgets ?? []).length },
    target: { siteId: target.id, siteName: target.name, sameSite: target.id === site.id },
    devices, mapping,
    ...(ambiguous.length ? { ambiguous } : {}),
    ...(tiles.length ? { tileDevices: tiles } : {}),
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

const RELINKED_WHAT = { "20": "filter targets and description", "7": "shortcut targets and description",
  "21": "camera data source and description", "22": "live-count data source and description" };
const RELINKED = new Set(Object.keys(RELINKED_WHAT));

// What the copy restores per widget, from the source dashboard and a (proposed) mapping.
export function widgetPlan(source, deviceMapping, names = new Map()) {
  const first = String(source.devices?.[0]?.id ?? "");
  const label = v => v == null ? null : { id: String(v), name: names.get(String(v)) ?? null };
  return (source.widgets ?? []).map(w => {
    const { from, to } = targetDevice(w, deviceMapping, first);
    const description = typeof w.description === "string" && w.description.trim() ? w.description : null;
    const check = resaveBody(w, { device: from });
    // Filter, shortcut, camera and live-count widgets are relinked after the copy instead.
    const relinked = RELINKED.has(String(w.type?.id));
    return { widget: String(w.name ?? ""), type: w.type?.name ?? null, description: description ? "kept" : null,
      ...(from != null ? { device: { from: label(from), to: to === undefined ? "choose the mapping first" : to === null ? "the copy Zira makes" : label(to) } } : {}),
      ...(relinked ? { relink: RELINKED_WHAT[String(w.type.id)] } : {}),
      ...(!relinked && check.skip && (description || (from != null && to !== from)) ? { notRestored: check.skip } : {}) };
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
    if (RELINKED.has(String(g.copy[0]?.type?.id ?? g.source[0]?.type?.id))) continue;
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
  const tiles = mapping.tileDeviceMapping ?? {};
  if (typeof tiles !== "object" || Array.isArray(tiles) || !Object.entries(tiles).every(([k, v]) => id(k) && (v === null || id(String(v)))))
    throw new Error("tileDeviceMapping must map data source IDs to data source IDs");
  return { deviceMapping: mapping.deviceMapping, metricMapping: mapping.metricMapping ?? {}, tileDeviceMapping: tiles };
};

// Source dashboard ID → copy ID, as "11779:11918,11797:11916" or a JSON file of {source: copy}.
export async function readDashboardMapping(value) {
  if (!value) return {};
  const pairs = /^\s*[1-9]\d*:[1-9]\d*(\s*,\s*[1-9]\d*:[1-9]\d*)*\s*$/.test(value)
    ? Object.fromEntries(value.split(",").map(p => p.trim().split(":")))
    : JSON.parse(await readFile(value, "utf8"));
  if (!pairs || typeof pairs !== "object" || Array.isArray(pairs) || !Object.entries(pairs).every(([k, v]) => id(k) && id(String(v))))
    throw new Error("--dashboard-mapping must be SOURCE:COPY pairs or a JSON file of {sourceId: copyId}");
  return Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, String(v)]));
}

// Camera and live-count tiles show a data source that need not be one of the dashboard's: propose the
// target site's data source with the same name (or same type and number) for each.
const TILE_TYPES = new Set(["21", "22"]);
const tileDevices = dashboard => [...new Set((dashboard.widgets ?? []).filter(w => TILE_TYPES.has(String(w.type?.id)))
  .map(w => w.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings?.deviceId).filter(v => v != null && id(String(v))).map(String))];
async function tileDeviceProposals(call, source, sourceIds, inventory) {
  const extra = tileDevices(source).filter(d => !sourceIds.includes(d));
  if (!extra.length) return [];
  const described = await describeDevices(call, extra);
  return extra.map(sid => {
    const name = String(described.get(sid)?.name ?? "");
    if (!inventory) return { source: { id: sid, name }, proposed: { id: sid, name }, reason: "same site" };
    const scored = inventory.map(t => ({ t, n: nameMatch(name, t.name) })).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
    const best = scored.filter(x => x.n === scored[0]?.n);
    return { source: { id: sid, name }, proposed: best.length === 1 ? { id: String(best[0].t.id), name: String(best[0].t.name ?? "") } : null,
      ...(best.length > 1 ? { candidates: best.map(x => ({ id: String(x.t.id), name: String(x.t.name ?? "") })) } : {}),
      reason: best.length === 1 ? (best[0].n === 3 ? "same name" : "same type and number") : best.length ? "several fit; choose one" : "no data source with this name at the target; choose one" };
  });
}

export async function copyDashboard({
  call, profile = "prod", companyId, siteId, dashboardId, targetCompanyId, targetSiteId, name, mapping,
  dashboardMapping = {}, matchSiteDayStart = false, apply = false, allowRepeat = false, receipts, resolve,
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
  const kinds = type => (source.widgets ?? []).filter(w => String(w.type?.id) === type).length;
  const days = sameSite ? null : await siteDays(call, site, target);
  if (matchSiteDayStart && !days) throw new Error("--match-site-day-start is for a copy to another site");
  const preview = {
    source: { id: dashboardId, name: String(source.name ?? ""), widgets: (source.widgets ?? []).length },
    target: { siteId: target.id, siteName: target.name, sameSite },
    name: targetName,
    dataSources: sources.map(s => ({ from: s.name, to: deviceMapping[s.id] === null ? `a copy of ${s.name} at ${target.name}` : String(inventory.get(deviceMapping[s.id])?.name ?? deviceMapping[s.id]) })),
    metricsRemapped: Object.keys(metricMapping).length,
    afterCopy: afterCopySummary(widgetPlan(source, idMapping, new Map([...sources.map(s => [s.id, s.name]),
      ...[...inventory.values()].map(d => [String(d.id), String(d.name ?? "")])]))),
    notCopied: NOT_COPIED_DASHBOARD,
    relink: { filters: kinds("20"), shortcuts: kinds("7"), cameraTiles: kinds("21"), liveCountTiles: kinds("22"),
      layoutBreakpoints: Object.keys(source.configurationLayout ?? {}).filter(bp => (source.configurationLayout[bp] ?? []).length),
      dashboardMapping, note: `After copying, filter targets, shortcuts to this dashboard or to dashboards in dashboardMapping, camera/live-count tiles on mapped data sources and every breakpoint's layout are relinked to the copy. Shortcut, camera and live-count saves need ${PLATFORM_CHANGE} deployed; until then they are listed as pendingPlatform for a later relink.` },
    ...(days ? { siteSettings: { ...days, ...(days.differs ? { action: matchSiteDayStart ? "The target site's day start and first day of week will be set to the source site's." : "Pass --match-site-day-start to set the target site's day start and first day of week to the source's (a site setting for every dashboard there)." } : {}) } } : {}),
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
        const full = resolveCreated(sources, idMapping, copyDevices);
        const plan = planCopyFixes({ source, copy: saved, deviceMapping: full });
        widgetFixes = { ...await applyCopyFixes(call, copyId, plan.fixes), skipped: plan.skipped };
        if (!widgetFixes.complete)
          warnings.push(`Not every widget was restored (failed, not tried or unverified). Run fix-copy --copy-id ${copyId} with the same mapping to finish.`);
        if (plan.skipped.length)
          warnings.push(`${plan.skipped.length} widget(s) keep Zira's copy as it is: ${plan.skipped.map(x => `${x.widget} (${x.reason})`).join("; ")}.`);
      }
      // Relink what still points at the source, then (on request) match the site's day start.
      let relink = null, siteDayStart = null;
      if (saved) {
        const copyDevices = (saved.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
        try {
          relink = await relinkCopy({ call, source, copyId, site: target,
            deviceMapping: { ...(sameSite ? Object.fromEntries(tileDevices(source).map(d => [d, d])) : {}), ...(mapping?.tileDeviceMapping ?? {}),
              ...resolveCreated(sources, idMapping, copyDevices) }, dashboardMapping });
        } catch (error) { relink = { complete: false, error: error.message }; }
        if (!relink.complete) warnings.push(`Relinking the copy did not finish${relink.error ? ` (${relink.error})` : ""}. Preview relink --copy-id ${copyId} to see what is left.`);
        if (relink.pendingPlatform?.length) warnings.push(`${relink.pendingPlatform.length} shortcut/camera/live-count/filter save(s) wait for ${PLATFORM_CHANGE}; run relink --copy-id ${copyId} once it is deployed.`);
        if (relink.open?.length) warnings.push(`${relink.open.length} link(s) need a decision: ${relink.open.map(o => `${o.widget} ${o.field} (${o.reason})`).join("; ")}.`);
      }
      if (matchSiteDayStart && days?.differs) {
        const { body: siteBody, after } = siteDaysBody(target.id, days.target, days.source);
        try {
          siteDayStart = { state: "set", before: days.target, ...await putSiteDays(call, target, siteBody, after) };
        } catch (error) { siteDayStart = { state: "not-set", error: error.message, ...(error.reason ? { blocked: error.reason } : {}) }; }
        if (!siteDayStart.verified) warnings.push(`The target site's day start was not set or not confirmed (${siteDayStart.error ?? siteDayStart.readBack ?? "read-back differs"}); check it with site-settings.`);
      }
      const verified = !!saved && String(saved.id) === copyId && String(saved.site?.id ?? "") === target.id &&
        normalizeName(saved.name) === normalizeName(targetName) && (saved.widgets ?? []).length === (source.widgets ?? []).length &&
        (saved.devices ?? []).length === sources.length && !!widgetFixes?.complete && relink?.complete !== false;
      return { receipt: { dashboardId: copyId }, dashboardId: copyId, verified, warnings, orphaned, widgetFixes, relink, siteDayStart };
    },
  });
  const dashboardIdOut = outcome.dashboardId ?? outcome.receipt?.dashboardId;
  const links = { url: link(profile, `/dashboards/${dashboardIdOut}`) };
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "dashboard-copy", profile, applied: false, state: outcome.state, dashboardId: dashboardIdOut, ...links,
      message: "This exact copy was already made; nothing new was written." };
  return { kind: "dashboard-copy", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    dashboardId: dashboardIdOut, warnings: outcome.warnings, ...(outcome.orphaned.length ? { orphanedMetrics: outcome.orphaned } : {}),
    ...(outcome.widgetFixes ? { widgetFixes: outcome.widgetFixes } : {}), ...(outcome.relink ? { relink: outcome.relink } : {}),
    ...(outcome.siteDayStart ? { siteDayStart: outcome.siteDayStart } : {}), preview, ...links };
}

// Day start and first day of week of the source and target sites (site settings, not copied by Zira).
async function siteDays(call, site, target) {
  const [a, b] = [await siteRow(call, site.companyId, site.id), await siteRow(call, target.companyId, target.id)];
  const differs = a.view.defaultDayOffset !== b.view.defaultDayOffset || a.view.firstDayOfWeek !== b.view.firstDayOfWeek;
  return { source: a.view, target: b.view, differs };
}

// Plan a copy's relink against its current state, with the target site's dashboards and data sources.
async function planCopyRelink({ call, source, copy, site, deviceMapping, dashboardMapping, skipPlatform = false }) {
  const hasShortcuts = (copy.widgets ?? []).some(w => String(w.type?.id) === "7");
  const siteDashboards = hasShortcuts ? await siteDashboardList(call, site) : [];
  const relinked = planRelink({ source, copy, deviceMapping, dashboardMapping, targetDashboards: new Set(siteDashboards.filter(d => !d.isDeleted).map(d => String(d.id))) });
  const widgets = relinked.spec.widgets ?? [];
  const siteDeviceIds = widgets.some(w => w.deviceId) ? new Set((await siteDataSources(call, site)).map(d => String(d.id))) : new Set();
  const plan = planEdit({ spec: relinked.spec, dashboard: copy, siteDashboards, siteDeviceIds });
  const deferred = skipPlatform ? plan.writes.filter(w => w.needsPlatform) : [];
  return { ...relinked, plan: { ...plan, writes: plan.writes.filter(w => !deferred.includes(w)) }, deferred };
}

const brief = w => ({ kind: w.kind, target: w.target, ...(w.widget ? { widget: w.widget, widgetType: w.widgetType } : {}) });

// Inside a copy: save what plugin sign-in can save now, then try the writes that need the platform
// change and keep the rest as pendingPlatform at the first not_enabled answer. One write per object.
async function relinkCopy({ call, source, copyId, site, deviceMapping, dashboardMapping }) {
  const copy = (await call("GET", `/dashboards/${copyId}`)).data ?? {};
  const { plan, open, unpaired } = await planCopyRelink({ call, source, copy, site, deviceMapping, dashboardMapping });
  const now = plan.writes.filter(w => !w.needsPlatform), later = plan.writes.filter(w => w.needsPlatform);
  const first = await runWrites(call, now);
  const done = [...first.done], failed = first.failed.map(f => ({ ...brief(f.write), error: f.error.message })), pendingPlatform = [];
  if (!first.failed.length) for (const [n, w] of later.entries()) {
    try { await call(w.method, w.path, w.body); done.push(w); } catch (error) {
      if (notEnabled(w, error)) pendingPlatform.push(...later.slice(n).map(brief));
      else failed.push({ ...brief(w), error: error.message });
      break;
    }
  }
  const notTried = [...first.notTried, ...(first.failed.length ? later : [])].map(brief);
  let saved = null, readBack = null;
  if (done.length) try { saved = (await call("GET", `/dashboards/${copyId}`)).data ?? null; } catch (error) { readBack = error.message; }
  const mismatches = saved ? verifyWrites(copy, saved, done) : [];
  return { saved: done.map(brief), ...(failed.length ? { failed } : {}), ...(notTried.length ? { notTried } : {}),
    ...(pendingPlatform.length ? { pendingPlatform } : {}), ...(open.length ? { open } : {}), ...(unpaired.length ? { unpaired } : {}),
    ...(plan.skipped.length ? { skipped: plan.skipped } : {}), ...(mismatches.length ? { mismatches } : {}), ...(readBack ? { readBack } : {}),
    complete: !failed.length && !notTried.length && !mismatches.length && !readBack };
}

// Relink an existing copy (after a batch of copies that link to each other, or once the platform
// change is deployed): preview the exact changes; --apply saves them under one receipt.
export async function relink({
  call, profile = "prod", companyId, siteId, dashboardId, targetCompanyId, targetSiteId, copyId, mapping, dashboardMapping = {},
  skipPlatform = false, expected, apply = false, receipts,
}) {
  const site = await resolveSite(call, companyId, siteId);
  const target = await resolveSite(call, targetCompanyId ?? companyId, targetSiteId ?? siteId);
  if (!id(copyId ?? "") || copyId === dashboardId) throw new Error("--copy-id must be the copy of --dashboard-id");
  const source = await loadSource(call, site, dashboardId);
  const copy = await loadDashboard(call, target, copyId);
  const sameSite = target.id === site.id;
  if (!sameSite && !mapping) throw new Error("A copy at another site needs --mapping (the source → copy data sources)");
  const copyDevices = (copy.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
  const sources = (source.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") })).filter(d => id(d.id));
  const chosen = sameSite && !mapping ? Object.fromEntries(sources.map(s => [s.id, s.id])) : mapping.deviceMapping;
  const idMapping = Object.fromEntries(Object.entries(chosen).filter(([k]) => id(k)).map(([k, v]) => [k, v === null ? null : String(v)]));
  const deviceMapping = { ...(sameSite ? Object.fromEntries(tileDevices(source).map(d => [d, d])) : {}), ...(mapping?.tileDeviceMapping ?? {}),
    ...resolveCreated(sources, idMapping, copyDevices) };
  const { plan, open, unpaired, deferred, pairs } = await planCopyRelink({ call, source, copy, site: target, deviceMapping, dashboardMapping, skipPlatform });
  const url = link(profile, `/dashboards/${copyId}`);
  const rev = revision(copy);
  const describe = w => ({ ...brief(w), ...(w.diff ? { changes: w.diff } : {}), ...(w.changes ? { changes: w.changes } : {}),
    ...(w.unplaced ? { unplaced: w.unplaced } : {}), ...(w.needsPlatform ? { needsPlatform: PLATFORM_CHANGE } : {}) });
  const preview = { kind: "dashboard-relink-preview", profile, url, revision: rev, source: { id: dashboardId, name: source.name }, copy: { id: copyId, name: copy.name },
    widgetPairs: Object.keys(pairs).length, writes: plan.writes.map(describe), ...(deferred.length ? { deferred: deferred.map(describe) } : {}),
    ...(open.length ? { open } : {}), ...(unpaired.length ? { unpaired } : {}), ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
    ...(plan.writes.some(w => w.needsPlatform) ? { platformNote: `Writes marked needsPlatform need ${PLATFORM_CHANGE} deployed; until then apply stops with not_enabled before writing anything. Use --skip-platform to save the rest now.` } : {}),
    applied: false };
  if (!apply) return preview;
  if (!expected) throw new Error("--expected REVISION from a reviewed preview is required with --apply");
  if (!plan.writes.length) return { kind: "dashboard-relink", profile, url, state: "nothing-to-do", applied: false, ...(deferred.length ? { deferred: preview.deferred } : {}) };
  const outcome = await applyWrites({
    call, dashboardId: copyId, before: copy, writes: plan.writes, receipts,
    key: fingerprint({ op: "dashboard-relink", profile, copyId, expected, writes: plan.writes.map(w => [w.path, w.body]) }),
    summary: { kind: "dashboard-relink", dashboardId: copyId, siteId: target.id, writes: plan.writes.length },
    precheck: async () => {
      if (expected !== rev) throw new Blocked("conflict", "The copy changed since the preview. Preview again; nothing was written.");
      if (revision((await call("GET", `/dashboards/${copyId}`)).data) !== expected) throw new Blocked("conflict", "The copy changed before saving; nothing was written.");
    },
  });
  if (outcome.state === "already-done") return { kind: "dashboard-relink", profile, url, state: "already-done", applied: false };
  return { kind: "dashboard-relink", profile, url, applied: true, state: outcome.complete ? "updated" : outcome.state === "partial" ? "partial" : "unverified",
    verified: outcome.verified, complete: outcome.complete, saved: outcome.saved, ...(outcome.failed ? { failed: outcome.failed } : {}),
    ...(outcome.notTried ? { notTried: outcome.notTried } : {}), ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}),
    ...(deferred.length ? { deferred: preview.deferred } : {}), ...(open.length ? { open } : {}) };
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
    mapping: { type: "string" }, out: { type: "string" }, "copy-id": { type: "string" }, "company-level": { type: "boolean" },
    "dashboard-mapping": { type: "string" }, "match-site-day-start": { type: "boolean" }, spec: { type: "string" },
    expected: { type: "string" }, "skip-platform": { type: "boolean" }, "day-start": { type: "string" }, "first-day-of-week": { type: "string" },
    plan: { type: "string" }, backup: { type: "string" }, "backup-dir": { type: "string" }, "dashboard-ids": { type: "string" },
    "widget-ids": { type: "string" }, "widget-names": { type: "string" }, unlink: { type: "boolean" }, "keep-layout": { type: "boolean" },
    "allow-linked": { type: "boolean" }, "allow-locked": { type: "boolean" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const receipts = receiptsFile(o.receipts);
  // Loaded on demand: dashboard-rollout.mjs builds on this module.
  if (["rollout", "restore", "sharing"].includes(args[0]))
    return (await import("./dashboard-rollout.mjs")).rolloutCommand(args[0], o, { profile, receipts });
  if (["delete-widgets", "delete"].includes(args[0])) {
    // Deletes cannot be undone: internal builds only.
    if ((await import("./build-info.mjs")).buildInfo().audience === "public") throw new Error("Deleting dashboards and widgets is not available in this Zira build; delete them in Zira.");
    return (await import("./dashboard-delete.mjs")).deleteCommand(args[0], o, { profile, receipts, session: liveSession });
  }
  if (args[0] === "site-settings")
    return siteSettings({ call: await liveSession(profile, { allow: SITE_ROUTES, maxRequests: 20 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dayStart: o["day-start"], firstDayOfWeek: o["first-day-of-week"], expected: o.expected, apply: !!o.apply, receipts });
  if (args[0] === "edit") {
    if (!o.spec) throw new Error("--spec FILE required");
    const raw = await readFile(o.spec, "utf8");
    if (raw.length > 256 * 1024) throw new Error("Spec exceeds 256 KiB");
    return editDashboard({ call: await liveSession(profile, { allow: EDIT_ROUTES, maxRequests: 300 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], spec: JSON.parse(raw), expected: o.expected, apply: !!o.apply, skipPlatform: !!o["skip-platform"], receipts });
  }
  if (args[0] === "relink")
    return relink({ call: await liveSession(profile, { allow: EDIT_ROUTES, maxRequests: 300 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], targetCompanyId: o["target-company-id"], targetSiteId: o["target-site-id"], copyId: o["copy-id"],
      mapping: o.mapping ? await readMapping(o.mapping) : undefined, dashboardMapping: await readDashboardMapping(o["dashboard-mapping"]),
      skipPlatform: !!o["skip-platform"], expected: o.expected, apply: !!o.apply, receipts });
  if (["copy", "copy-mapping", "fix-copy"].includes(args[0])) {
    // A copy re-saves up to one widget per request after the copy itself, then relinks.
    const allow = o["match-site-day-start"] ? [...ROUTES, ...SITE_ROUTES] : ROUTES;
    const scope = { call: await liveSession(profile, { allow, maxRequests: 400 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], targetCompanyId: o["target-company-id"], targetSiteId: o["target-site-id"] };
    if (args[0] === "copy-mapping") {
      const proposal = await copyMapping(scope);
      if (o.out) { await writeFile(o.out, JSON.stringify(proposal, null, 2), { mode: 0o600 }); proposal.savedTo = o.out; }
      return proposal;
    }
    const writes = { mapping: o.mapping ? await readMapping(o.mapping) : undefined,
      apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts };
    if (args[0] === "fix-copy") return fixCopy({ ...scope, ...writes, copyId: o["copy-id"] });
    return copyDashboard({ ...scope, ...writes, name: o.name, dashboardMapping: await readDashboardMapping(o["dashboard-mapping"]),
      matchSiteDayStart: !!o["match-site-day-start"] });
  }
  if (args[0] !== "create") throw new Error("Choose create, copy-mapping, copy, fix-copy, relink, edit, site-settings, rollout, restore, sharing, delete-widgets or delete");
  return createDashboard({
    call: await liveSession(profile, { allow: ROUTES, maxRequests: 40 }), profile,
    companyId: o["company-id"], siteId: o["site-id"], name: o.name, description: o.description,
    dataSourceIds: o["data-source-ids"], range: o.range ?? "today", interval: o.interval ?? "hourly",
    apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts, companyLevel: !!o["company-level"],
  });
}

const cliProfile = () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod";

// A blocked copy points to the source dashboard in Zira, whose site Dashboards tab has Duplicate.
export function handoffInfo(argv = process.argv) {
  const profileNow = ["prod", "integ"].includes(cliProfile()) ? cliProfile() : "prod";
  if (argv[2] === "edit" && id(argValue("dashboard-id", argv) ?? ""))
    return { pageUrl: link(profileNow, `/dashboards/${argValue("dashboard-id", argv)}`), details: "In Zira, open the dashboard and edit the listed widgets or its settings there. Nothing was changed here." };
  if (argv[2] === "restore" && id(argValue("dashboard-id", argv) ?? ""))
    return { pageUrl: link(profileNow, `/dashboards/${argValue("dashboard-id", argv)}`), details: "In Zira, open the dashboard and compare it with the backup file. Nothing was changed here." };
  if (["delete-widgets", "delete"].includes(argv[2]) && id(argValue("dashboard-id", argv) ?? ""))
    return { pageUrl: link(profileNow, `/dashboards/${argValue("dashboard-id", argv)}`), details: argv[2] === "delete"
      ? "In Zira, open the site's Dashboards tab and use ⋯ → Delete on this dashboard. Nothing was changed here."
      : "In Zira, open the dashboard in edit mode and use each widget's menu → Delete. Nothing was changed here." };
  if (["rollout", "restore", "sharing", "delete-widgets", "delete"].includes(argv[2])) return undefined;
  if (argv[2] === "site-settings")
    return { details: "In Zira, open the site's settings and set the day start and first day of week there. Nothing was changed here." };
  const copy = ["fix-copy", "relink"].includes(argv[2]) ? argValue("copy-id", argv) : undefined;
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
