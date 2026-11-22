// Field-level edits of an existing next-generation dashboard, its widgets and layout, and of a
// site's day start and first day of week, through the agent routes only. Every widget is saved as
// Zira returns it with only the requested fields changed; the read-back must show those changes and
// nothing else. Also plans what a cross-site copy must relink: shortcut targets, filter targets,
// camera/live-count tiles and every breakpoint's layout.
import {
  Blocked, ZiraApiError, dashboardInScope, fingerprint, guardedWrite, id, link, listAll, normalizeName, resolveScope, resolveSite,
  scopeDashboards, siteDataSources, text,
} from "./client.mjs";
import { COLS, ROW_KEYS, cleanRow, overlaps } from "./dashboard-layout.mjs";
import { resaveBody } from "./dashboard-widgets.mjs";

// The platform change that admits dashboard settings, site day start and shortcut/camera/live-count
// widget saves for plugin sign-in. Until it is deployed those writes stop with not_enabled.
export const PLATFORM_CHANGE = "Zira's plugin access update for dashboard and site edits (https://github.com/lightapp/platform/pull/248)";
export const EDIT_ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/], ["GET", /^\/dashboards\/list$/],
  ["GET", /^\/dashboards\/[1-9]\d*$/], ["PUT", /^\/dashboards\/[1-9]\d*$/], ["PUT", /^\/dashboards\/widgets\/[1-9]\d*$/],
  ["PUT", /^\/dashboards\/configuration-layout\/[1-9]\d*$/],
];
// Only the site-settings command (and copy with --match-site-day-start) may send the site update.
export const SITE_ROUTES = [["GET", /^\/sites\/list$/], ["PUT", /^\/sites\/[1-9]\d*$/]];

const RANGE_IDS = {
  "last-60-minutes": "16", today: "1", yesterday: "2", "last-week": "14", "this-week": "3", "last-7-days": "4",
  "last-14-days": "5", "last-21-days": "6", "last-30-days": "9", "last-60-days": "10", "last-365-days": "12",
};
const INTERVAL_IDS = {
  "last-reading": "-1000", "1-minute": "1", "5-minutes": "2", "15-minutes": "3", hourly: "4", daily: "5", weekly: "6", monthly: "7",
};
export const KINDS = { "6": "header", "15": "chart", "17": "readings", "18": "aiSummary", "20": "filter", "7": "shortcut", "21": "camera", "22": "liveCount" };
// Widget types the agent widget guard accepted before the platform change.
const GUARDED = new Set(["6", "15", "17", "20"]);
const ROUND_TRIP = new Set(["7", "19", "21", "22"]);
const DASHBOARD_KEYS = ["name", "description", "isShared", "isLocked", "isPrivate", "lazyLoading", "range", "interval"];
const WIDGET_KEYS = ["widgetId", "name", "description", "filterTargets", "shortcuts", "deviceId", "rotation", "primaryMetric"];
const FIELD_TYPES = { filterTargets: ["20"], shortcuts: ["7"], deviceId: ["21", "22"], rotation: ["21"], primaryMetric: ["22"] };
export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const obj = x => !!x && typeof x === "object" && !Array.isArray(x);
const fields = (x, allowed, where) => {
  assert(obj(x), `${where} must be an object`);
  for (const k of Object.keys(x)) assert(allowed.includes(k), `Unknown ${where} field: ${k}`);
};
const canonical = x => Array.isArray(x) ? x.map(canonical) : obj(x)
  ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
export const revision = dashboard => fingerprint(canonical(dashboard));
const errorText = error => error?.status ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ""}` : error?.message ?? String(error);

// ---- Comparison: normalized widgets and path-level diffs ----

// Response-only details (record IDs of parts, audit data) and empty envelopes are not settings.
export function normalizeWidget(widget) {
  const walk = (value, depth) => {
    if (Array.isArray(value)) return value.map(v => walk(v, depth));
    if (!obj(value)) return value === undefined ? null : value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "auditInfo" || (k === "id" && depth > 0 && depth <= 2)) continue;
      const next = walk(v, k === "components" ? 1 : k === "arguments" ? 2 : depth > 0 ? 3 : 0);
      if (next !== null) out[k] = next;
    }
    return Object.keys(out).length || !Object.keys(value).length ? out : null;
  };
  const { id: _id, ...rest } = widget ?? {};
  // Zira returns an empty description as "" or null; both mean no description.
  if (rest.description === "") rest.description = null;
  return walk(rest, 0);
}

export function diffPaths(before, after, path = "") {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) out.push(...diffPaths(before[i], after[i], `${path}[${i}]`));
    return out;
  }
  if (obj(before) && obj(after)) {
    const out = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
      out.push(...diffPaths(before[k], after[k], path ? `${path}.${k}` : k));
    return out;
  }
  const same = JSON.stringify(canonical(before ?? null)) === JSON.stringify(canonical(after ?? null));
  return same ? [] : [{ path, before: before ?? null, after: after ?? null }];
}

// Chart, readings and filter saves rewrite the legacy filters envelope as a copy of the settings,
// as Zira web and dashboard-widgets.mjs save them. That envelope is not compared.
const LEGACY_MIRROR = /^components\[0\]\.arguments\[0\]\.(filters|func|device)(\.|\[|$)/;
const sideEffect = (type, path) => GUARDED.has(type) && type !== "6" && LEGACY_MIRROR.test(path);

// ---- Spec validation and planning ----

const settingsOf = w => w?.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings;

function rangeId(value, table, where) {
  if (value == null) return null;
  const key = String(value);
  if (Object.hasOwn(table, key)) return table[key];
  assert(Object.values(table).includes(key), `Unknown ${where}: ${key}`);
  return key;
}

// The dashboard update body: the read-back object's editable fields with the requested changes, and the
// layout and data sources exactly as Zira has them (they have their own routes).
export function dashboardBody(dashboard, changes = {}) {
  const body = { id: String(dashboard.id) };
  for (const k of ["name", "description", "isShared", "isLocked", "isPrivate", "lazyLoading"])
    if (dashboard[k] !== undefined) body[k] = dashboard[k];
  body.defaultDisplayRange = { id: dashboard.defaultDisplayRange?.id == null ? null : String(dashboard.defaultDisplayRange.id) };
  body.defaultDisplayInterval = { id: dashboard.defaultDisplayInterval?.id == null ? null : String(dashboard.defaultDisplayInterval.id) };
  body.configurationLayout = dashboard.configurationLayout ?? { lg: [] };
  body.devices = (dashboard.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
  for (const [k, v] of Object.entries(changes)) {
    if (k === "range") body.defaultDisplayRange = { id: rangeId(v, RANGE_IDS, "range") };
    else if (k === "interval") body.defaultDisplayInterval = { id: rangeId(v, INTERVAL_IDS, "interval") };
    else body[k] = v;
  }
  return body;
}

const dashboardView = d => ({ name: d.name ?? null, description: d.description ?? null, isShared: d.isShared ?? null, isLocked: d.isLocked ?? null,
  isPrivate: d.isPrivate ?? null, lazyLoading: d.lazyLoading ?? null, range: d.defaultDisplayRange?.id == null ? null : String(d.defaultDisplayRange.id),
  interval: d.defaultDisplayInterval?.id == null ? null : String(d.defaultDisplayInterval.id) });

function checkDashboardChanges(changes, dashboard, siteDashboards) {
  fields(changes, DASHBOARD_KEYS, "dashboard");
  const out = {};
  if (changes.name !== undefined) {
    const name = text(changes.name, 120);
    assert(name, "Dashboard name must be non-empty (at most 120 characters)");
    const taken = siteDashboards.find(d => String(d.id) !== String(dashboard.id) && !d.isDeleted && normalizeName(d.name) === normalizeName(name));
    if (taken) throw new Blocked("duplicate", `A dashboard named "${taken.name}" already exists at this site (${taken.id}); Zira rejects duplicate names (HTTP 409). Choose another name.`, { existing: String(taken.id) });
    out.name = name;
  }
  if (changes.description !== undefined) {
    assert(changes.description === null || typeof changes.description === "string", "description must be text or null");
    out.description = changes.description === null ? null : text(changes.description, 4000);
  }
  for (const k of ["isShared", "isLocked", "isPrivate", "lazyLoading"]) if (changes[k] !== undefined) {
    assert(typeof changes[k] === "boolean", `${k} must be true or false`); out[k] = changes[k];
  }
  if (changes.range !== undefined) { rangeId(changes.range, RANGE_IDS, "range"); out.range = changes.range; }
  if (changes.interval !== undefined) { rangeId(changes.interval, INTERVAL_IDS, "interval"); out.interval = changes.interval; }
  return out;
}

// Apply one widget's requested fields to a copy of the widget as Zira returned it.
export function editWidget(widget, change, { dashboard, siteDashboardIds, siteDeviceIds }) {
  const type = String(widget.type?.id ?? "");
  const edited = structuredClone(widget);
  for (const [k, types] of Object.entries(FIELD_TYPES))
    if (change[k] !== undefined) assert(types.includes(type), `${k} is not a field of ${KINDS[type] ?? `type ${type}`} widgets (widget ${widget.id})`);
  if (change.name !== undefined) {
    const name = text(change.name, 120); assert(name, `Widget ${widget.id} name must be non-empty`); edited.name = name;
  }
  if (change.description !== undefined) {
    assert(change.description === null || typeof change.description === "string", "Widget description must be text or null");
    edited.description = change.description === null ? null : text(change.description, 4000);
    if (type === "6" && obj(edited.uiSettings) && Object.hasOwn(edited.uiSettings, "description")) edited.uiSettings.description = edited.description ?? "";
  }
  const s = settingsOf(edited);
  if (change.filterTargets !== undefined) {
    assert(Array.isArray(change.filterTargets) && change.filterTargets.length > 0 && change.filterTargets.length <= 100, "filterTargets must list 1–100 widget IDs");
    assert(obj(s), `Filter widget ${widget.id} has no settings to change`);
    s.widgetsList = change.filterTargets.map(t => {
      const target = (dashboard.widgets ?? []).find(w => String(w.id) === String(t));
      assert(target, `Filter target ${t} is not a widget of dashboard ${dashboard.id}`);
      assert(["15", "17"].includes(String(target.type?.id)), `Filter target ${t} must be a chart or readings widget`);
      return { id: String(target.id), name: String(target.name ?? "") };
    });
  }
  if (change.shortcuts !== undefined) {
    assert(Array.isArray(change.shortcuts) && change.shortcuts.length, "shortcuts must list {index, dashboardId[, displayText]}");
    const parts = edited.components ?? [];
    for (const sc of change.shortcuts) {
      fields(sc, ["index", "dashboardId", "displayText"], "shortcut");
      assert(Number.isInteger(sc.index) && sc.index >= 0 && sc.index < parts.length, `Shortcut index ${sc.index} is not a shortcut of widget ${widget.id} (0–${parts.length - 1})`);
      const cta = parts[sc.index]?.arguments?.[0]?.cta;
      assert(obj(cta) && String(cta.entityType?.id) === "19", `Shortcut ${sc.index} of widget ${widget.id} does not open a dashboard`);
      if (sc.dashboardId !== undefined) {
        assert(id(String(sc.dashboardId)) && siteDashboardIds.has(String(sc.dashboardId)), `Shortcut target ${sc.dashboardId} is not a dashboard of this site`);
        cta.entity = String(sc.dashboardId);
      }
      if (sc.displayText !== undefined) { const t = text(sc.displayText, 200); assert(t, "displayText must be non-empty"); cta.displayText = t; }
    }
  }
  if (change.deviceId !== undefined) {
    assert(obj(s), `Widget ${widget.id} has no settings to change`);
    assert(siteDeviceIds.has(String(change.deviceId)), `Data source ${change.deviceId} is not at this site`);
    s.deviceId = String(change.deviceId);
  }
  if (change.rotation !== undefined) { assert([0, 90, 180, 270].includes(change.rotation), "rotation must be 0, 90, 180 or 270"); s.rotation = change.rotation; }
  if (change.primaryMetric !== undefined) {
    assert(typeof change.primaryMetric === "string" && /^[A-Za-z0-9_]{1,64}$/.test(change.primaryMetric), "primaryMetric must be a metric key such as table6");
    s.primaryMetric = change.primaryMetric;
  }
  return edited;
}

// Conditions with a list value (filterValue: ["Table 1"]) pass the agent widget guard only with the
// platform change.
const listValues = value => Array.isArray(value) ? value.some(listValues)
  : obj(value) && (Array.isArray(value.filterValue) || Object.values(value).some(listValues));

// The save body for an edited widget, in the shape the agent widget guard accepts for its type.
export function widgetBody(edited) {
  const built = widgetBodyOf(edited);
  return built.body && listValues(settingsOf(edited)) ? { ...built, needsPlatform: true } : built;
}
function widgetBodyOf(edited) {
  const type = String(edited.type?.id ?? "");
  if (ROUND_TRIP.has(type)) {
    const body = {};
    for (const k of ["name", "description", "type", "overrideDisplayRange", "overrideDisplayInterval", "displayRangeOffset", "uiSettings", "components"])
      if (edited[k] !== undefined) body[k] = structuredClone(edited[k]);
    return { body, needsPlatform: true };
  }
  if (type === "20") {
    const c = edited.components?.[0], a = c?.arguments?.[0], s = a?.nextGenWidgetSettings;
    if ((edited.components ?? []).length !== 1 || (c.arguments ?? []).length !== 1 || !obj(s)) return { skip: "filter widget with several parts" };
    const settings = structuredClone(s);
    return { body: { name: edited.name, description: edited.description ?? "", type: edited.type, overrideDisplayRange: edited.overrideDisplayRange ?? null,
      overrideDisplayInterval: edited.overrideDisplayInterval ?? null, displayRangeOffset: edited.displayRangeOffset ?? null,
      components: [{ type: c.type, placementIndex: 1, overrideDisplayRange: c.overrideDisplayRange ?? null, overrideDisplayInterval: c.overrideDisplayInterval ?? null,
        displayRangeOffset: c.displayRangeOffset ?? null, arguments: [{ type: a.type, placementIndex: 1, overrideDisplayRange: a.overrideDisplayRange ?? null,
          overrideDisplayInterval: a.overrideDisplayInterval ?? null, displayRangeOffset: a.displayRangeOffset ?? null, device: null,
          filters: settings, nextGenWidgetSettings: settings, func: null }] }] } };
  }
  if (GUARDED.has(type)) {
    const device = edited.components?.[0]?.arguments?.[0]?.device?.id;
    const r = resaveBody(edited, { description: edited.description ?? "", device: device == null || device === "" ? null : String(device) });
    return r.skip ? { skip: r.skip } : { body: r.body };
  }
  return { skip: `${edited.type?.name ?? "this"} widgets are not saved by the plugin; edit them in Zira` };
}

// ---- Layout ----

const order = rows => [...rows].sort((a, b) => a.y - b.y || a.x - b.x);

// Place rows in reading order, moving each down past anything it would cover.
function settle(rows) {
  const placed = [];
  for (const row of order(rows)) {
    const r = { ...row };
    for (let hit = placed.find(p => overlaps(p, r)); hit; hit = placed.find(p => overlaps(p, r))) r.y = hit.y + hit.h;
    placed.push(r);
  }
  return placed;
}

// A breakpoint's layout from another one: same grid copies, a narrower grid scales and settles,
// a phone grid (2 columns) stacks every widget full width in reading order.
export function deriveLayout(rows, fromCols, toCols) {
  const source = order(rows.map(cleanRow));
  if (toCols === fromCols) return source.map(r => ({ ...r }));
  if (toCols <= 2) {
    let y = 0;
    return source.map(r => { const out = { ...r, x: 0, y, w: toCols }; delete out.maxW; if (out.minW > toCols) out.minW = toCols; y += r.h; return out; });
  }
  const ratio = toCols / fromCols;
  return settle(source.map(r => {
    const w = Math.min(toCols, Math.max(1, Math.round(r.w * ratio)));
    const out = { ...r, x: Math.min(toCols - w, Math.floor(r.x * ratio)), w };
    delete out.maxW; if (out.minW > w) out.minW = w;
    return out;
  }));
}

// The planned layout: the current one without keys the layout route refuses (moved) and without rows
// for widgets that no longer exist, with requested rows replaced and derived breakpoints.
export function planLayout(dashboard, layoutChanges = {}, copyLayout) {
  const widgetIds = new Set((dashboard.widgets ?? []).map(w => String(w.id)));
  const current = dashboard.configurationLayout ?? {};
  const next = {}, dropped = [];
  for (const [bp, rows] of Object.entries(current)) {
    if (!Object.hasOwn(COLS, bp) || !Array.isArray(rows)) continue;
    next[bp] = [];
    for (const row of rows) {
      if (!widgetIds.has(String(row.i))) dropped.push({ breakpoint: bp, widgetId: String(row.i) });
      else if (!next[bp].some(r => r.i === String(row.i))) next[bp].push(cleanRow(row));
    }
  }
  next.lg ??= [];
  fields(layoutChanges, Object.keys(COLS), "layout breakpoints");
  for (const [bp, rows] of Object.entries(layoutChanges)) {
    assert(Array.isArray(rows), `layout.${bp} must be a list of rows`);
    next[bp] ??= [];
    for (const row of rows) {
      fields(row, ROW_KEYS, "layout row");
      const i = String(row.i);
      assert(widgetIds.has(i), `Layout row ${i} is not a widget of dashboard ${dashboard.id}`);
      const existing = next[bp].findIndex(r => r.i === i);
      const merged = { ...(existing >= 0 ? next[bp][existing] : { minW: 1, minH: 1, static: false }), ...cleanRow(row) };
      if (existing >= 0) next[bp][existing] = merged; else next[bp].push(merged);
    }
  }
  if (copyLayout) {
    const spec = copyLayout === true ? { from: "lg", to: ["md", "sm", "xs"] } : copyLayout;
    fields(spec, ["from", "to"], "copyLayout");
    assert(Object.hasOwn(COLS, spec.from) && Array.isArray(spec.to) && spec.to.every(bp => Object.hasOwn(COLS, bp) && bp !== spec.from), "copyLayout needs from and to breakpoints (lg, md, sm, xs)");
    for (const bp of spec.to) next[bp] = deriveLayout(next[spec.from] ?? [], COLS[spec.from], COLS[bp]);
  }
  for (const [bp, rows] of Object.entries(next)) {
    const seen = new Set();
    for (const r of rows) {
      assert(!seen.has(r.i), `Widget ${r.i} appears twice in layout.${bp}`); seen.add(r.i);
      assert(["x", "y", "w", "h"].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= COLS[bp],
        `Layout row ${r.i} does not fit the ${COLS[bp]}-column ${bp} grid${bp === "lg" ? "" : `; if Zira saved ${bp} as an unpositioned pile, add "copyLayout": {"from": "lg", "to": ["${bp}"]} to lay it out from desktop`}`);
    }
  }
  const unplaced = Object.fromEntries(Object.entries(next).map(([bp, rows]) => [bp, [...widgetIds].filter(w => !rows.some(r => r.i === w))]).filter(([, v]) => v.length));
  const overlapping = Object.fromEntries(Object.entries(next).map(([bp, rows]) =>
    [bp, rows.flatMap((a, n) => rows.slice(n + 1).filter(b => overlaps(a, b)).map(b => [a.i, b.i]))]).filter(([, v]) => v.length));
  return { configurationLayout: next, dropped, unplaced, overlapping };
}

const box = r => r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
export function layoutChanges(before = {}, after = {}) {
  const out = [];
  for (const bp of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]) {
    const ids = new Set([...(before?.[bp] ?? []), ...(after[bp] ?? [])].map(r => String(r.i)));
    for (const i of ids) {
      const a = box((before?.[bp] ?? []).find(r => String(r.i) === i)), b = box((after[bp] ?? []).find(r => String(r.i) === i));
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ breakpoint: bp, widgetId: i, before: a, after: b });
    }
  }
  return out;
}

// ---- Edit: plan, preview, apply, verify ----

export function validateEditSpec(spec) {
  fields(spec, ["version", "dashboard", "widgets", "layout", "copyLayout"], "spec");
  assert(spec.version === 1, "Spec version must be 1");
  if (spec.widgets !== undefined) {
    assert(Array.isArray(spec.widgets) && spec.widgets.length <= 200, "widgets must be a list of at most 200 changes");
    const seen = new Set();
    for (const w of spec.widgets) {
      fields(w, WIDGET_KEYS, "widget change");
      assert(id(String(w.widgetId ?? "")) && !seen.has(String(w.widgetId)), "Each widget change needs a distinct widgetId");
      seen.add(String(w.widgetId));
    }
  }
  return spec;
}

// Everything the edit would send, with an exact before/after for each object.
export function planEdit({ spec, dashboard, siteDashboards = [], siteDeviceIds = new Set() }) {
  validateEditSpec(spec);
  const writes = [], skipped = [];
  const siteDashboardIds = new Set(siteDashboards.filter(d => !d.isDeleted).map(d => String(d.id)));
  if (spec.dashboard && Object.keys(spec.dashboard).length) {
    const changes = checkDashboardChanges(spec.dashboard, dashboard, siteDashboards);
    const body = dashboardBody(dashboard, changes);
    const before = dashboardView(dashboard), after = dashboardView(body);
    const diff = diffPaths(before, after);
    if (diff.length) writes.push({ kind: "dashboard", target: String(dashboard.id), method: "PUT", path: `/dashboards/${dashboard.id}`, body, diff, expected: after, needsPlatform: true });
  }
  for (const change of spec.widgets ?? []) {
    const widget = (dashboard.widgets ?? []).find(w => String(w.id) === String(change.widgetId));
    assert(widget, `Widget ${change.widgetId} is not on dashboard ${dashboard.id}`);
    const type = String(widget.type?.id ?? "");
    const edited = editWidget(widget, change, { dashboard, siteDashboardIds, siteDeviceIds });
    const diff = diffPaths(normalizeWidget(widget), normalizeWidget(edited));
    if (!diff.length) continue;
    const built = widgetBody(edited);
    if (built.skip) { skipped.push({ widgetId: String(widget.id), widget: widget.name, reason: built.skip }); continue; }
    writes.push({ kind: "widget", target: String(widget.id), widget: String(edited.name ?? ""), widgetType: KINDS[type] ?? widget.type?.name ?? type,
      method: "PUT", path: `/dashboards/widgets/${widget.id}`, body: built.body, diff, expected: normalizeWidget(edited), widgetTypeId: type,
      ...(built.needsPlatform ? { needsPlatform: true } : {}) });
  }
  if (spec.layout || spec.copyLayout) {
    const planned = planLayout(dashboard, spec.layout ?? {}, spec.copyLayout);
    const changes = layoutChanges(dashboard.configurationLayout, planned.configurationLayout);
    const cleaned = JSON.stringify(canonical(dashboard.configurationLayout ?? {})) !== JSON.stringify(canonical(planned.configurationLayout));
    if (changes.length || cleaned)
      writes.push({ kind: "layout", target: String(dashboard.id), method: "PUT", path: `/dashboards/configuration-layout/${dashboard.id}`,
        body: { configurationLayout: planned.configurationLayout }, changes, expected: planned.configurationLayout,
        ...(planned.dropped.length ? { dropped: planned.dropped } : {}), ...(Object.keys(planned.unplaced).length ? { unplaced: planned.unplaced } : {}),
        ...(Object.keys(planned.overlapping).length ? { overlapping: planned.overlapping } : {}) });
  }
  // Writes that need the platform change go first, so before it is deployed nothing else is written.
  writes.sort((a, b) => Number(!a.needsPlatform) - Number(!b.needsPlatform) || ["dashboard", "widget", "layout"].indexOf(a.kind) - ["dashboard", "widget", "layout"].indexOf(b.kind));
  return { writes, skipped };
}

// The read-back shows each write's intended state and nothing else changed.
export function verifyWrites(before, saved, writes) {
  const problems = [];
  for (const w of writes) {
    if (w.kind === "dashboard") {
      const diff = diffPaths(w.expected, dashboardView(saved));
      if (diff.length) problems.push({ target: w.target, kind: w.kind, diff });
      if (JSON.stringify((saved.devices ?? []).map(d => String(d.id)).sort()) !== JSON.stringify((before.devices ?? []).map(d => String(d.id)).sort()))
        problems.push({ target: w.target, kind: w.kind, diff: [{ path: "devices", note: "data sources changed" }] });
    } else if (w.kind === "widget") {
      const actual = (saved.widgets ?? []).find(x => String(x.id) === w.target);
      if (!actual) { problems.push({ target: w.target, kind: w.kind, diff: [{ path: "", note: "widget missing after save" }] }); continue; }
      const diff = diffPaths(w.expected, normalizeWidget(actual)).filter(d => !sideEffect(w.widgetTypeId, d.path));
      if (diff.length) problems.push({ target: w.target, kind: w.kind, widget: w.widget, diff: diff.slice(0, 20) });
    } else {
      const diff = layoutChanges(w.expected, Object.fromEntries(Object.keys(w.expected).map(bp => [bp, saved.configurationLayout?.[bp] ?? []])));
      if (diff.length) problems.push({ target: w.target, kind: w.kind, diff: diff.slice(0, 40) });
    }
  }
  return problems;
}

// A route or widget type plugin sign-in does not reach yet: the gateway has no agent route (404),
// or the agent guard refuses the shape (400 invalid_request) or the operation (403).
export const notEnabled = (write, error) => write.needsPlatform && error instanceof ZiraApiError && [400, 403, 404].includes(error.status);

export async function runWrites(call, writes, { progress = async () => {} } = {}) {
  const done = [], failed = [];
  for (const w of writes) {
    try {
      await call(w.method, w.path, w.body);
      done.push(w);
      await progress({ [`${w.kind}:${w.target}`]: "saved" });
    } catch (error) {
      failed.push({ write: w, error });
      break;
    }
  }
  return { done, failed, notTried: writes.slice(done.length + failed.length) };
}

const describeWrite = w => ({ kind: w.kind, target: w.target, ...(w.widget ? { widget: w.widget, widgetType: w.widgetType } : {}),
  ...(w.diff ? { changes: w.diff } : {}), ...(w.changes ? { changes: w.changes } : {}),
  ...(w.dropped ? { droppedStaleRows: w.dropped } : {}), ...(w.unplaced ? { unplaced: w.unplaced } : {}), ...(w.overlapping ? { overlapping: w.overlapping } : {}),
  ...(w.needsPlatform ? { needsPlatform: PLATFORM_CHANGE } : {}) });

export async function loadDashboard(call, site, dashboardId) {
  assert(id(String(dashboardId ?? "")), "Dashboard ID required");
  const d = (await call("GET", `/dashboards/${dashboardId}`)).data ?? {};
  if (String(d.id ?? "") !== String(dashboardId) || !dashboardInScope(d, site))
    throw new Blocked("scope", `Dashboard ${dashboardId} is not a ${site.kind === "company" ? "company-level dashboard" : "dashboard"} of ${site.name} that this user can see`);
  if (String(d.type?.id ?? "") !== "3") throw new Blocked("scope", "Only next-generation dashboards are edited here.");
  return d;
}

// A site's dashboards, or a company's company-level dashboards for a company scope (resolveScope).
export const siteDashboardList = (call, site) => scopeDashboards(call, site);

// Apply a planned set of writes once, under one receipt, then read the dashboard back.
export async function applyWrites({ call, dashboardId, before, writes, receipts, key, summary, precheck }) {
  return guardedWrite({
    file: receipts, key, summary,
    precheck,
    run: async progress => {
      const result = await runWrites(call, writes, { progress });
      const failure = result.failed[0];
      // Nothing saved: a refusal leaves no receipt; an unknown outcome stays pending for review.
      if (failure && !result.done.length) {
        if (notEnabled(failure.write, failure.error))
          throw new Blocked("not_enabled", `${failure.write.kind === "dashboard" ? "Dashboard settings" : `${failure.write.widgetType} widgets`} cannot be saved with plugin sign-in until ${PLATFORM_CHANGE} is deployed (${errorText(failure.error)}). Nothing was changed.`,
            { platformChange: PLATFORM_CHANGE, status: failure.error.status });
        throw failure.error;
      }
      let saved = null, readBack = null;
      if (result.done.length) try { saved = (await call("GET", `/dashboards/${dashboardId}`)).data ?? null; } catch (error) { readBack = `Read-back failed (${errorText(error)})`; }
      const problems = saved ? verifyWrites(before, saved, result.done) : [];
      const complete = !result.failed.length && !result.notTried.length && !!saved && !problems.length;
      return {
        partial: !!(result.failed.length || result.notTried.length) && result.done.length > 0,
        receipt: { dashboardId: String(dashboardId), saved: result.done.map(w => `${w.kind}:${w.target}`) },
        saved: result.done.map(describeWrite), complete, verified: !!saved && !problems.length,
        ...(result.failed.length ? { failed: result.failed.map(f => ({ ...describeWrite(f.write), error: errorText(f.error),
          ...(notEnabled(f.write, f.error) ? { notEnabled: `needs ${PLATFORM_CHANGE} deployed` } : {}) })) } : {}),
        ...(result.notTried.length ? { notTried: result.notTried.map(describeWrite) } : {}),
        ...(problems.length ? { mismatches: problems } : {}), ...(readBack ? { readBack } : {}),
      };
    },
  });
}

export async function editDashboard({ call, profile = "prod", companyId, siteId, dashboardId, spec, expected, apply = false, skipPlatform = false, receipts }) {
  const site = await resolveScope(call, companyId, siteId);
  const dashboard = await loadDashboard(call, site, dashboardId);
  validateEditSpec(spec);
  const needsDevices = (spec.widgets ?? []).some(w => w.deviceId !== undefined);
  const needsDashboards = (spec.widgets ?? []).some(w => w.shortcuts) || spec.dashboard?.name !== undefined;
  const siteDashboards = needsDashboards ? await siteDashboardList(call, site) : [];
  // A company-level dashboard's tiles use its own attached data sources, which may be on any site of the company.
  const siteDeviceIds = !needsDevices ? new Set() : site.kind === "company" ? new Set((dashboard.devices ?? []).map(d => String(d.id)))
    : new Set((await siteDataSources(call, site)).map(d => String(d.id)));
  const planned = planEdit({ spec, dashboard, siteDashboards, siteDeviceIds });
  const deferred = skipPlatform ? planned.writes.filter(w => w.needsPlatform) : [];
  const plan = { ...planned, writes: planned.writes.filter(w => !deferred.includes(w)) };
  const url = link(profile, `/dashboards/${dashboardId}`);
  const rev = revision(dashboard);
  const preview = { kind: "dashboard-edit-preview", profile, url, revision: rev, dashboard: { id: String(dashboard.id), name: dashboard.name },
    writes: plan.writes.map(describeWrite), ...(deferred.length ? { deferred: deferred.map(describeWrite) } : {}), ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
    ...(plan.writes.some(w => w.needsPlatform) ? { platformNote: `Writes marked needsPlatform are admitted for plugin sign-in once ${PLATFORM_CHANGE} is deployed; until then apply stops with not_enabled before writing anything else. Use --skip-platform to apply the rest now.` } : {}),
    applied: false };
  if (!apply) return preview;
  if (!expected) throw new Error("--expected REVISION from a reviewed preview is required with --apply");
  if (!plan.writes.length) return { kind: "dashboard-edit", profile, url, state: "nothing-to-do", applied: false };
  const outcome = await applyWrites({
    call, dashboardId: String(dashboardId), before: dashboard, writes: plan.writes, receipts,
    key: fingerprint(canonical({ op: "dashboard-edit", profile, dashboardId: String(dashboardId), spec, expected, skipPlatform })),
    summary: { kind: "dashboard-edit", dashboardId: String(dashboardId), siteId: site.id, writes: plan.writes.length },
    precheck: async () => {
      if (expected !== rev) throw new Blocked("conflict", "The dashboard changed since the preview. Preview again and review it; nothing was written.");
      const latest = (await call("GET", `/dashboards/${dashboardId}`)).data;
      if (revision(latest) !== expected) throw new Blocked("conflict", "The dashboard changed before saving; nothing was written.");
    },
  });
  if (outcome.state === "already-done") return { kind: "dashboard-edit", profile, url, state: "already-done", applied: false, receipt: outcome.receipt };
  return { kind: "dashboard-edit", profile, url, applied: true, state: outcome.complete ? "updated" : outcome.state === "partial" ? "partial" : "unverified",
    verified: outcome.verified, complete: outcome.complete, saved: outcome.saved, ...(outcome.failed ? { failed: outcome.failed } : {}),
    ...(outcome.notTried ? { notTried: outcome.notTried } : {}), ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}),
    ...(outcome.readBack ? { readBack: outcome.readBack } : {}), ...(plan.skipped.length ? { skipped: plan.skipped } : {}) };
}

// ---- Site day start and first day of week (site settings, not dashboard settings) ----

export function parseDayStart(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  const minutes = clock ? Number(clock[1]) * 60 + Number(clock[2]) : /^-?\d+$/.test(s) ? Number(s) : NaN;
  assert(Number.isInteger(minutes) && minutes > -1440 && minutes < 1440 && (!clock || Number(clock[2]) < 60),
    "Day start must be HH:MM (e.g. 05:00) or minutes after midnight (-1439…1439)");
  return minutes;
}
export function parseWeekStart(value) {
  if (value == null) return undefined;
  const s = String(value).trim().toLowerCase();
  const n = /^[0-6]$/.test(s) ? Number(s) : DAYS.findIndex(d => d === s || d.slice(0, 3) === s);
  assert(n >= 0 && n <= 6, "First day of week must be 0–6 (0 Sunday, 1 Monday) or a day name");
  return n;
}
const clockText = m => m == null ? null : `${m < 0 ? "-" : ""}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`;
export const siteDayView = row => {
  const offset = row?.defaultDayOffset == null || row.defaultDayOffset === "" ? null : Number(row.defaultDayOffset);
  const week = row?.firstDayOfWeek == null || row.firstDayOfWeek === "" ? null : Number(row.firstDayOfWeek);
  return { defaultDayOffset: offset, dayStarts: clockText(offset), firstDayOfWeek: week, weekStarts: week == null ? null : DAYS[week] ?? null };
};

export async function siteRow(call, companyId, siteId) {
  const site = await resolveSite(call, companyId, siteId);
  const row = (await listAll(call, "/sites/list", { companyIds: companyId })).find(s => String(s.id) === siteId);
  return { site, row, view: siteDayView(row) };
}

// One site update with only the day-start fields, then the site list read back.
export async function putSiteDays(call, site, body, after) {
  try { await call("PUT", `/sites/${site.id}`, body); } catch (error) {
    if (error instanceof ZiraApiError && [400, 403, 404].includes(error.status))
      throw new Blocked("not_enabled", `Site day start cannot be saved with plugin sign-in until ${PLATFORM_CHANGE} is deployed, or this user cannot update ${site.name} (${errorText(error)}). Nothing was changed.`, { platformChange: PLATFORM_CHANGE, status: error.status });
    throw error;
  }
  let now = null, readBack = null;
  try { now = siteDayView((await listAll(call, "/sites/list", { companyIds: site.companyId })).find(s => String(s.id) === site.id)); }
  catch (error) { readBack = `Read-back failed (${errorText(error)})`; }
  const verified = !!now && now.defaultDayOffset === after.defaultDayOffset && now.firstDayOfWeek === after.firstDayOfWeek;
  return { verified, now, ...(readBack ? { readBack } : {}) };
}

// The site-update body that makes a site's day start and week start equal to the given values.
export function siteDaysBody(siteId, current, { defaultDayOffset, firstDayOfWeek }) {
  const body = { id: String(siteId) };
  if (defaultDayOffset !== undefined && defaultDayOffset !== current.defaultDayOffset) body.defaultDayOffset = String(defaultDayOffset);
  if (firstDayOfWeek !== undefined && firstDayOfWeek !== current.firstDayOfWeek) body.firstDayOfWeek = String(firstDayOfWeek);
  const after = siteDayView({ defaultDayOffset: body.defaultDayOffset ?? current.defaultDayOffset, firstDayOfWeek: body.firstDayOfWeek ?? current.firstDayOfWeek });
  return { body, after, changes: Object.keys(body).length > 1 };
}

export async function siteSettings({ call, profile = "prod", companyId, siteId, dayStart, firstDayOfWeek, expected, apply = false, receipts }) {
  const { site, view } = await siteRow(call, companyId, siteId);
  const { body, after } = siteDaysBody(site.id, view, { defaultDayOffset: parseDayStart(dayStart), firstDayOfWeek: parseWeekStart(firstDayOfWeek) });
  const rev = fingerprint({ site: site.id, defaultDayOffset: view.defaultDayOffset, firstDayOfWeek: view.firstDayOfWeek });
  const preview = { kind: "site-settings-preview", profile, site: { id: site.id, name: site.name }, revision: rev, current: view,
    ...(Object.keys(body).length > 1 ? { planned: after, body } : { planned: null, note: "Nothing to change." }),
    scope: "Day start and first day of week are site settings: they apply to every dashboard and report of the site, not one dashboard.",
    platformNote: `Plugin sign-in can save these once ${PLATFORM_CHANGE} is deployed; until then apply stops with not_enabled and nothing changes.`, applied: false };
  if (!apply) return preview;
  if (Object.keys(body).length === 1) return { kind: "site-settings", profile, state: "nothing-to-do", applied: false, current: view };
  if (!expected) throw new Error("--expected REVISION from a reviewed preview is required with --apply");
  const outcome = await guardedWrite({
    file: receipts, key: fingerprint({ op: "site-day-start", profile, siteId: site.id, body, expected }),
    summary: { kind: "site-settings", siteId: site.id },
    precheck: async () => {
      if (expected !== rev) throw new Blocked("conflict", "The site settings changed since the preview; nothing was written.");
    },
    reconcile: async () => {
      const now = siteDayView((await listAll(call, "/sites/list", { companyIds: companyId })).find(s => String(s.id) === site.id));
      return now.defaultDayOffset === after.defaultDayOffset && now.firstDayOfWeek === after.firstDayOfWeek ? { siteId: site.id } : null;
    },
    run: async () => ({ receipt: { siteId: site.id }, ...await putSiteDays(call, site, body, after) }),
  });
  if (["already-done", "reconciled"].includes(outcome.state)) return { kind: "site-settings", profile, state: outcome.state, applied: false };
  return { kind: "site-settings", profile, applied: true, state: outcome.verified ? "updated" : "unverified", verified: outcome.verified,
    before: view, after: outcome.now, ...(outcome.readBack ? { readBack: outcome.readBack } : {}) };
}

// ---- Relinking a copy ----

// Copied widgets pair with source widgets by type and name (Zira keeps both), in ID order.
export function pairWidgets(source, copy) {
  const groups = new Map();
  for (const [side, list] of [["source", source.widgets], ["copy", copy.widgets]]) for (const w of list ?? []) {
    const k = `${w.type?.id}\u0000${normalizeName(w.name)}`;
    if (!groups.has(k)) groups.set(k, { source: [], copy: [] });
    groups.get(k)[side].push(w);
  }
  const pairs = new Map(), unpaired = [];
  for (const g of groups.values()) {
    const byId = (a, b) => Number(a.id) - Number(b.id);
    g.source.sort(byId); g.copy.sort(byId);
    if (g.source.length && g.source.length === g.copy.length) g.source.forEach((w, i) => pairs.set(String(w.id), String(g.copy[i].id)));
    else for (const w of g.source) unpaired.push({ widgetId: String(w.id), widget: w.name, reason: `${g.source.length} in the source and ${g.copy.length} in the copy` });
  }
  return { pairs, unpaired };
}

// What a copy needs so it works like its source at the new site: filter targets on the copy's
// widgets, shortcuts to the copies of linked dashboards, camera and live-count tiles on the mapped
// data sources, and every breakpoint's layout. Only fields still pointing at the source are changed.
// Zira saves breakpoints nobody arranged as a pile (y 9999, desktop widths); those are derived instead.
export const unpositioned = (bp, rows) => (rows ?? []).some(r => r.y >= 9999 || r.x + r.w > COLS[bp]);

export function planRelink({ source, copy, deviceMapping = {}, dashboardMapping = {}, targetDashboards = new Set() }) {
  const { pairs, unpaired } = pairWidgets(source, copy);
  const widgets = [], open = [];
  const dashMap = { ...Object.fromEntries(Object.entries(dashboardMapping).map(([k, v]) => [String(k), String(v)])), [String(source.id)]: String(copy.id) };
  for (const [sid, cid] of pairs) {
    const sw = source.widgets.find(w => String(w.id) === sid), cw = copy.widgets.find(w => String(w.id) === cid);
    const type = String(cw.type?.id), change = { widgetId: cid };
    // Zira's Duplicate drops descriptions; widgets relinked here get theirs back in the same save.
    if (["20", "7", "21", "22"].includes(type) && !(cw.description ?? "").trim() && typeof sw.description === "string" && sw.description.trim())
      change.description = sw.description;
    if (type === "20") {
      const list = settingsOf(cw)?.widgetsList ?? [];
      const mapped = list.map(t => pairs.get(String(t.id)) ?? (copy.widgets.some(w => String(w.id) === String(t.id)) ? String(t.id) : null));
      if (mapped.some(m => m == null)) open.push({ widgetId: cid, widget: cw.name, field: "filterTargets", reason: "some filter targets have no copy" });
      const targets = mapped.filter(Boolean);
      if (targets.length && targets.some((t, i) => t !== String(list[i]?.id))) change.filterTargets = [...new Set(targets)];
    }
    if (type === "7") {
      const shortcuts = [];
      (cw.components ?? []).forEach((c, index) => {
        const cta = c.arguments?.[0]?.cta, srcCta = sw.components?.[index]?.arguments?.[0]?.cta;
        if (String(cta?.entityType?.id) !== "19") return;
        const from = String(srcCta?.entity ?? cta.entity ?? "");
        const to = dashMap[from] ?? dashMap[String(cta.entity ?? "")];
        if (to && to !== String(cta.entity)) shortcuts.push({ index, dashboardId: to });
        else if (!to && !Object.values(dashMap).includes(String(cta.entity)) && !targetDashboards.has(String(cta.entity))) open.push({ widgetId: cid, widget: cw.name, field: `shortcuts[${index}]`, reason: `opens dashboard ${cta.entity}, which has no copy in the dashboard mapping` });
      });
      if (shortcuts.length) change.shortcuts = shortcuts;
    }
    if (type === "21" || type === "22") {
      const device = settingsOf(cw)?.deviceId == null ? null : String(settingsOf(cw).deviceId);
      if (device && Object.hasOwn(deviceMapping, device)) {
        if (deviceMapping[device] != null && String(deviceMapping[device]) !== device) change.deviceId = String(deviceMapping[device]);
      } else if (device && !Object.values(deviceMapping).map(String).includes(device))
        open.push({ widgetId: cid, widget: cw.name, field: "deviceId", reason: `shows data source ${device}, which is not in the data source mapping` });
    }
    if (Object.keys(change).length > 1) widgets.push(change);
  }
  // Every breakpoint of the source layout, on the copy's widget IDs. Breakpoints the source lacks are
  // derived from its lg layout so tablet and phone views are not an unpositioned pile.
  const layout = {};
  for (const [bp, rows] of Object.entries(source.configurationLayout ?? {})) {
    if (!Object.hasOwn(COLS, bp) || !Array.isArray(rows) || (bp !== "lg" && unpositioned(bp, rows))) continue;
    layout[bp] = rows.filter(r => pairs.has(String(r.i))).map(r => ({ ...cleanRow(r), i: pairs.get(String(r.i)) }));
  }
  const spec = { version: 1, ...(widgets.length ? { widgets } : {}) };
  const derive = ["md", "sm", "xs"].filter(bp => !layout[bp]?.length || unpositioned(bp, copy.configurationLayout?.[bp]));
  if (Object.keys(layout).length) {
    const current = copy.configurationLayout ?? {};
    if (layoutChanges(current, layout).length) spec.layout = layout;
    if (derive.length && layout.lg?.length) spec.copyLayout = { from: "lg", to: derive };
  }
  return { spec, pairs: Object.fromEntries(pairs), unpaired, open };
}
