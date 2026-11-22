// One reviewed change applied to many dashboards (rollout), a dashboard set back to a backup
// (restore) and the server's sharing state (sharing). Everything previews by default. A rollout
// applies site by site: the reviewed revision must still match, the dashboard's full JSON is backed
// up and read back before its first write, each site has its own receipt and read-back, and the run
// stops at the first site that fails or cannot be verified. Nothing here deletes anything: deletes
// live in dashboard-delete.mjs (delete-widgets, delete), which reuses the backup guard below.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  Blocked, annotateReceipt, explain, fingerprint, guardedWrite, id, idList, link, liveSession, normalizeName, resolveScope, resolveSite, siteDataSources, text, dashboardInScope,
} from "./client.mjs";
import {
  EDIT_ROUTES, KINDS, PLATFORM_CHANGE, applyWrites, deriveLayout, diffPaths, layoutChanges, loadDashboard, normalizeWidget,
  planEdit, planLayout, revision, runWrites, siteDashboardList, unpositioned, validateEditSpec, verifyWrites, widgetBody,
} from "./dashboard-edit.mjs";
import { argumentDevice, verifyWidget } from "./dashboard-widgets.mjs";
import { usedMetrics } from "./dashboards.mjs";
import { describeSources, metricList } from "../skills/readings-report/scripts/store.mjs";

const CREATE_ROUTE = ["POST", /^\/dashboards\/[1-9]\d*\/widgets$/];
export const SHARING_ROUTES = [["GET", /^\/sites\/list$/], ["GET", /^\/dashboards\/[1-9]\d*$/]];
// Only a copySection plan may create widgets; every other change edits what exists.
export const rolloutRoutes = plan => plan?.change?.copySection ? [...EDIT_ROUTES, CREATE_ROUTE] : EDIT_ROUTES;

const COLS = { lg: 12, md: 12, sm: 6, xs: 2, xxs: 2 };
const ROW_KEYS = ["i", "x", "y", "w", "h", "minW", "minH", "maxW", "maxH", "static", "isDraggable", "isResizable", "resizeHandles", "isBounded"];
// Widget types the plugin can create from a saved widget: header, chart, readings, AI summary, filter.
const CREATE_TYPES = new Set(["6", "15", "17", "18", "20"]);
const DEPENDENT = new Set(["18", "20"]);
const AI_KEYS = ["description", "question", "answerStyle", "answerExample", "fontSize", "widgetIds"];
// A chart, readings or filter save rewrites the legacy filters envelope from the settings; it is not a change.
const MIRROR = /^components\[\d+\]\.arguments\[\d+\]\.filters(\.|\[|$)/;
// meter_id conditions: = and IN become IN over several data sources, ≠ and NOT IN become NOT IN.
const METER_OPS = { "1": "7", "6": "8", "7": "7", "8": "8" };
const MAX_SITES = 100;

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const obj = x => !!x && typeof x === "object" && !Array.isArray(x);
const fields = (x, allowed, where) => {
  assert(obj(x), `${where} must be an object`);
  for (const k of Object.keys(x)) assert(allowed.includes(k), `Unknown ${where} field: ${k}`);
};
const canonical = x => Array.isArray(x) ? x.map(canonical) : obj(x)
  ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
const same = (a, b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
const errorText = error => error?.status ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ""}` : error?.message ?? String(error);
const pickRow = row => Object.fromEntries(ROW_KEYS.filter(k => row[k] !== undefined).map(k => [k, k === "i" ? String(row[k]) : row[k]]));
const covers = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const typeOf = w => String(w?.type?.id ?? "");
const kindOf = w => KINDS[typeOf(w)] ?? w?.type?.name ?? `type ${typeOf(w)}`;
const argsOf = w => (w?.components ?? []).flatMap(c => c.arguments ?? []);
const settingsOf = w => w?.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings;
const describeWrite = w => ({ kind: w.kind, target: w.target, ...(w.widget ? { widget: w.widget, widgetType: w.widgetType } : {}),
  ...(w.diff ? { changes: w.diff } : {}), ...(w.changes ? { changes: w.changes } : {}),
  ...(w.dropped ? { droppedStaleRows: w.dropped } : {}), ...(w.unplaced ? { unplaced: w.unplaced } : {}), ...(w.overlapping ? { overlapping: w.overlapping } : {}),
  ...(w.needsPlatform ? { needsPlatform: PLATFORM_CHANGE } : {}) });
const platformFirst = writes => writes.sort((a, b) => Number(!a.needsPlatform) - Number(!b.needsPlatform) ||
  ["dashboard", "widget", "layout"].indexOf(a.kind) - ["dashboard", "widget", "layout"].indexOf(b.kind));
// Sign-in, pacing and limits stop the whole run; anything else is one site's problem.
const stopsEverything = error => ["sign_in", "rate_limit", "agent_pacing_blocked", "agent_route_unavailable", "busy"].includes(explain(error)?.reason);
// Several sites of one company read the site list once.
const rememberSites = call => {
  const seen = new Map();
  return (method, target, body) => {
    if (method !== "GET" || !target.startsWith("/sites/list")) return call(method, target, body);
    if (!seen.has(target)) seen.set(target, call(method, target, body));
    return seen.get(target);
  };
};

// ---- Data source mapping: one source data source to one or several target data sources ----

export function normalizeDeviceMapping(mapping = {}, where = "deviceMapping") {
  assert(obj(mapping), `${where} must map source data source IDs to a target ID or a list of target IDs`);
  const out = new Map();
  for (const [k, v] of Object.entries(mapping)) {
    assert(id(k), `${where} key "${k}" is not a data source ID`);
    const targets = (Array.isArray(v) ? v : [v]).map(t => String(t));
    // An empty list drops that data source: the target site has nothing in its place (fewer saws).
    assert(targets.length <= 50 && targets.every(t => id(t)) && new Set(targets).size === targets.length,
      `${where}[${k}] must be a data source ID, a list of distinct data source IDs, or [] to leave it out`);
    out.set(k, targets);
  }
  return out;
}

// A copy of the widget with its data source references mapped. meter_id conditions equal to a source
// become IN over its targets, and IN lists expand each member. A widget bound to one data source
// (readings list, camera tile, live count) is refused when its source maps to several or none. A source
// mapped to [] is dropped from IN / NOT IN lists; a condition left with no data source is refused. strict (a copy
// from another dashboard): every referenced data source must be in the mapping. Never guesses.
export function remapWidgetDevices(widget, mapping, { strict = false, sourceDevices = new Set(), chartDataSource, fallbackDevice } = {}) {
  const out = structuredClone(widget), type = typeOf(widget), label = `${kindOf(widget)} "${widget.name}" (widget ${widget.id})`;
  const problems = [], notes = [];
  const targetsOf = (source, what) => {
    if (mapping.has(source)) return mapping.get(source);
    if (strict) problems.push(`${label} ${what} data source ${source}, which is not in deviceMapping`);
    return null;
  };
  const single = (value, what) => {
    const source = String(value), targets = targetsOf(source, what);
    if (!targets) return value;
    if (!targets.length) {
      problems.push(`${label} ${what} data source ${source}, which deviceMapping leaves out ([]). Map ${source} to one data source for this dashboard, or leave this widget out.`);
      return value;
    }
    if (targets.length > 1) {
      problems.push(`${label} ${what} one data source (${source}) and deviceMapping gives it ${targets.length} (${targets.join(", ")}). It cannot show several: map ${source} to one data source for this dashboard, or leave this widget out.`);
      return value;
    }
    return targets[0];
  };
  const condition = f => {
    const list = Array.isArray(f.filterValue);
    const ids = (list ? f.filterValue : f.filterValue.split(",")).map(v => String(v).trim()).filter(Boolean);
    if (!ids.some(v => mapping.has(v)) && !strict) return;
    if (!ids.length) return;
    const op = String(f.operator ?? "");
    if (!Object.hasOwn(METER_OPS, op)) { problems.push(`${label} filters data sources with operator ${op || "(none)"}; only =, ≠, IN and NOT IN are mapped`); return; }
    const next = [...new Set(ids.flatMap(v => targetsOf(v, "filters on") ?? [v]))];
    if (!next.length) { problems.push(`${label} filters only on data source(s) ${ids.join(", ")}, which deviceMapping leaves out ([]); it would select no data source. Leave this widget out or map one of them.`); return; }
    if (next.join(",") === ids.join(",")) return;
    if (next.length > 1 && METER_OPS[op] !== op) f.operator = typeof f.operator === "number" ? Number(METER_OPS[op]) : METER_OPS[op];
    f.filterValue = list ? next : next.join(",");
  };
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!obj(value)) return;
    if (value.metric === "meter_id" && (typeof value.filterValue === "string" || Array.isArray(value.filterValue))) return condition(value);
    Object.values(value).forEach(walk);
  };
  for (const a of argsOf(out)) {
    const s = a.nextGenWidgetSettings;
    const mirrored = type !== "17" && obj(s) && same(a.filters, s);
    if (obj(s)) {
      walk(s);
      if (type === "17" && s.device != null) {
        s.device = single(s.device, "lists the readings of");
        if (obj(a.filters) && a.filters.deviceId != null) a.filters.deviceId = s.device;
      }
      if (["21", "22"].includes(type) && s.deviceId != null) s.deviceId = single(s.deviceId, "shows");
      if (mirrored) a.filters = structuredClone(s);
    }
    if (type !== "15") continue;
    // A chart's own data source field holds one data source; its filters decide what it reads.
    const from = a.device?.id == null || a.device.id === "" ? null : String(a.device.id);
    if (from != null && mapping.has(from)) {
      const targets = mapping.get(from);
      // Widening a data source to a list that still has it leaves the field as it is.
      if (targets.includes(from)) continue;
      if (!targets.length) {
        // Dropped source: like several targets, the field needs a stand-in, and only by choice.
        if (chartDataSource === "first-mapped" && fallbackDevice != null) {
          a.device = { id: String(fallbackDevice) };
          notes.push(`${label}: its chart data source field held ${from}, which deviceMapping leaves out; it is set to the target dashboard's first data source (${fallbackDevice})`);
        } else problems.push(`${label} names data source ${from} in its chart data source field and deviceMapping leaves it out ([]). Add "chartDataSource": "first-mapped" to put the target dashboard's first data source there (the chart's filters decide what it reads), or map ${from} to one data source.`);
      } else if (targets.length === 1) a.device = { id: targets[0] };
      else if (chartDataSource === "first-mapped") {
        a.device = { id: targets[0] };
        notes.push(`${label}: its chart data source field is set to ${targets[0]}, the first of the ${targets.length} data sources mapped from ${from}`);
      } else problems.push(`${label} names data source ${from} in its chart data source field and deviceMapping gives it ${targets.length} (${targets.join(", ")}). That field holds one data source. Add "chartDataSource": "first-mapped" to the change to put ${targets[0]} there (the chart's filters still select every mapped data source), or map ${from} to one data source.`);
    } else if (strict && from != null && sourceDevices.has(from)) {
      problems.push(`${label} names data source ${from} in its chart data source field, which is not in deviceMapping`);
    } else if (strict) {
      // Zira web saves a fixed placeholder there; the plugin saves the dashboard's first data source.
      if (fallbackDevice == null) { problems.push(`${label} needs a chart data source and the target dashboard has no data sources`); continue; }
      a.device = { id: String(fallbackDevice) };
      notes.push(`${label}: its chart data source field${from == null ? " was empty" : ` held ${from}, which is not a data source of the source dashboard`}; it is set to the target dashboard's first data source (${fallbackDevice})`);
    }
  }
  return { widget: out, problems, notes };
}

// ---- Saving a whole widget as a given version of it (restore, remap, section copy) ----

// The save body for a widget in the one shape each existing write path accepts. AI summaries follow
// dashboard-widgets.mjs payload(); every other type goes through dashboard-edit.mjs widgetBody().
export function saveBody(widget) {
  if (typeOf(widget) !== "18") return widgetBody(widget);
  const parts = widget.components ?? [], c = parts[0], a = c?.arguments?.[0], s = a?.filters;
  if (parts.length !== 1 || (c.arguments ?? []).length !== 1 || !obj(s) || Object.keys(s).some(k => !AI_KEYS.includes(k)) ||
    (obj(a.nextGenWidgetSettings) && Object.keys(a.nextGenWidgetSettings).length) || a.cta)
    return { skip: "AI summary with settings the plugin cannot save" };
  return { body: { name: widget.name, type: widget.type, overrideDisplayRange: widget.overrideDisplayRange ?? null,
    overrideDisplayInterval: widget.overrideDisplayInterval ?? null, ...(widget.displayRangeOffset != null ? { displayRangeOffset: widget.displayRangeOffset } : {}),
    components: [{ type: c.type, placementIndex: 1, overrideDisplayRange: c.overrideDisplayRange ?? null, overrideDisplayInterval: c.overrideDisplayInterval ?? null,
      arguments: [{ type: a.type, placementIndex: 1, overrideDisplayRange: a.overrideDisplayRange ?? null, overrideDisplayInterval: a.overrideDisplayInterval ?? null,
        filters: structuredClone(s), func: null }] }] } };
}

const widgetDiff = (before, after) => diffPaths(normalizeWidget(before), normalizeWidget(after)).filter(d => typeOf(before) === "18" || !MIRROR.test(d.path));

// One widget update that makes `current` equal `desired`, in the shape planEdit's writes have, so
// applyWrites and verifyWrites handle it. null: nothing differs. { skip }: the plugin cannot save it.
export function widgetWrite(current, desired) {
  const diff = widgetDiff(current, desired);
  if (!diff.length) return null;
  const built = saveBody(desired);
  if (built.skip) return { skip: built.skip };
  const type = typeOf(current);
  return { write: { kind: "widget", target: String(current.id), widget: String(desired.name ?? ""), widgetType: kindOf(current), method: "PUT",
    path: `/dashboards/widgets/${current.id}`, body: built.body, diff, expected: normalizeWidget(desired), widgetTypeId: type,
    ...(built.needsPlatform ? { needsPlatform: true } : {}) } };
}

// ---- Backups ----

const slug = value => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";

// The dashboard exactly as Zira returned it, written once (never over an existing file) and read back.
export async function writeBackup({ dir, dashboard, label, profile = "prod", now = () => new Date() }) {
  assert(dir, "--backup-dir DIR is required with --apply");
  const taken = now();
  const stamp = taken.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const folder = path.resolve(dir);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${dashboard.id}-${stamp}-before-${slug(label)}.json`);
  const record = { kind: "dashboard-backup", version: 1, profile, takenAt: taken.toISOString(), label: String(label ?? ""), revision: revision(dashboard), dashboard };
  try { await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" }); } catch (error) {
    throw new Error(`The backup ${file} could not be written (${error.code ?? error.message}); nothing was written to dashboard ${dashboard.id}.`);
  }
  let back = null;
  try { back = JSON.parse(await readFile(file, "utf8")); } catch { /* compared below */ }
  if (!back || JSON.stringify(back) !== JSON.stringify(record) || revision(back.dashboard) !== record.revision)
    throw new Error(`The backup ${file} did not read back equal to the dashboard; nothing was written to dashboard ${dashboard.id}.`);
  return file;
}

// A backup written here, or a hand-made file holding the GET /dashboards/{id} answer.
export function backupDashboard(parsed) {
  const d = parsed?.kind === "dashboard-backup" ? parsed.dashboard : obj(parsed?.data) && parsed.data.widgets !== undefined ? parsed.data : parsed;
  assert(obj(d) && id(String(d.id ?? "")) && Array.isArray(d.widgets), "The backup file must hold a dashboard as Zira returned it (with id and widgets)");
  return { dashboard: d, takenAt: parsed?.kind === "dashboard-backup" ? parsed.takenAt ?? null : null, label: parsed?.kind === "dashboard-backup" ? parsed.label ?? null : null };
}

// ---- Copy a section: a header and the widgets below it, up to the next header ----

// until: the name of a widget below the header where the section ends early (that widget and the
// ones after it stay out), for a dashboard whose next part has no header of its own.
export function sectionOf(dashboard, headerName, until) {
  const widgets = new Map((dashboard.widgets ?? []).map(w => [String(w.id), w]));
  const seen = new Set();
  const rows = [...(dashboard.configurationLayout?.lg ?? [])].filter(r => widgets.has(String(r.i)) && !seen.has(String(r.i)) && seen.add(String(r.i)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const isHeader = r => typeOf(widgets.get(String(r.i))) === "6";
  const wanted = normalizeName(headerName);
  const matches = rows.filter(r => isHeader(r) && normalizeName(widgets.get(String(r.i)).name) === wanted);
  assert(matches.length === 1, matches.length ? `Dashboard ${dashboard.id} has ${matches.length} headers named "${headerName}"; a section needs one`
    : `Dashboard ${dashboard.id} has no header named "${headerName}" in its desktop layout`);
  const start = rows.indexOf(matches[0]);
  const next = rows.findIndex((r, n) => n > start && isHeader(r));
  let picked = rows.slice(start, next < 0 ? rows.length : next);
  if (until !== undefined) {
    const stop = picked.findIndex((r, n) => n > 0 && normalizeName(widgets.get(String(r.i)).name) === normalizeName(until));
    assert(stop > 0, `No widget named "${until}" in the "${headerName}" section of dashboard ${dashboard.id}; until must name a widget of that section`);
    assert(picked.filter(r => normalizeName(widgets.get(String(r.i)).name) === normalizeName(until)).length === 1, `Several widgets named "${until}" in the "${headerName}" section of dashboard ${dashboard.id}; until must name one`);
    picked = picked.slice(0, stop);
  }
  return { header: widgets.get(String(matches[0].i)), widgets: picked.map(r => widgets.get(String(r.i))), rows: picked };
}

const placeholder = sourceId => `new:${sourceId}`;
const swapLinks = (widget, idOf) => {
  const w = structuredClone(widget), a = w.components?.[0]?.arguments?.[0];
  const real = v => typeof v === "string" && v.startsWith("new:") ? idOf(v.slice(4)) : v;
  if (typeOf(w) === "20" && Array.isArray(a?.nextGenWidgetSettings?.widgetsList)) {
    a.nextGenWidgetSettings.widgetsList = a.nextGenWidgetSettings.widgetsList.map(t => ({ ...t, id: real(t.id) }));
    if (obj(a.filters) && Array.isArray(a.filters.widgetsList)) a.filters.widgetsList = a.filters.widgetsList.map(t => ({ ...t, id: real(t.id) }));
  }
  if (typeOf(w) === "18" && Array.isArray(a?.filters?.widgetIds)) a.filters.widgetIds = a.filters.widgetIds.map(real);
  return w;
};

// Where the section's rows go on every breakpoint of the target: below everything, or above a named
// header (rows from that header down move by the section's height). Breakpoints the target never
// arranged are laid out from its desktop layout, as relink does.
function sectionLayout({ source, target, section, position, idOf }) {
  const targetIds = new Set((target.widgets ?? []).map(w => String(w.id)));
  const sectionIds = section.widgets.map(w => String(w.id));
  const current = target.configurationLayout ?? {};
  const desktop = section.rows.map(pickRow);
  let anchor = null;
  if (position.above) {
    const headers = (target.widgets ?? []).filter(w => typeOf(w) === "6" && normalizeName(w.name) === normalizeName(position.above));
    assert(headers.length === 1, `${headers.length ? `${headers.length} headers` : "No header"} named "${position.above}" on dashboard ${target.id}; cannot place the section above it`);
    anchor = String(headers[0].id);
  }
  const changes = {}, derive = [], notes = [];
  for (const bp of [...new Set(["lg", "md", "sm", "xs", ...Object.keys(current).filter(k => Object.hasOwn(COLS, k))])]) {
    const rows = (Array.isArray(current[bp]) ? current[bp] : []).filter(r => targetIds.has(String(r.i)));
    if (bp !== "lg" && ((!rows.length && targetIds.size) || unpositioned(bp, rows))) { derive.push(bp); continue; }
    const saved = Array.isArray(source.configurationLayout?.[bp]) && !unpositioned(bp, source.configurationLayout[bp]) ? source.configurationLayout[bp] : [];
    const own = sectionIds.map(s => saved.find(r => String(r.i) === s)).filter(Boolean);
    const from = bp === "lg" ? desktop : own.length === sectionIds.length ? own.map(pickRow) : deriveLayout(desktop, COLS.lg, COLS[bp]);
    const top = Math.min(...from.map(r => r.y)), height = Math.max(...from.map(r => r.y + r.h)) - top;
    let base = Math.max(0, ...rows.filter(r => r.y < 9999).map(r => r.y + r.h));
    const moved = [];
    if (anchor) {
      const at = rows.find(r => String(r.i) === anchor);
      if (at) { base = at.y; for (const r of rows) if (r.y >= base) moved.push({ i: String(r.i), y: r.y + height }); }
      else {
        assert(bp !== "lg", `Header "${position.above}" is not placed in the desktop layout of dashboard ${target.id}`);
        notes.push(`${bp}: header "${position.above}" is not placed there, so the section goes to the bottom`);
      }
    }
    changes[bp] = [...moved, ...from.map(r => ({ ...r, i: idOf(String(r.i)), y: base + r.y - top }))];
  }
  const virtual = { ...target, widgets: [...(target.widgets ?? []), ...sectionIds.map(s => ({ id: idOf(s) }))] };
  const planned = planLayout(virtual, changes, derive.length ? { from: "lg", to: derive } : undefined);
  const fresh = new Set(sectionIds.map(idOf));
  for (const [bp, rows] of Object.entries(planned.configurationLayout)) for (const a of rows) if (fresh.has(a.i)) {
    const hit = rows.find(b => !fresh.has(b.i) && covers(a, b));
    assert(!hit, `At ${bp} the section would cover widget ${hit?.i} on dashboard ${target.id}. Use position "bottom", or arrange that part of the dashboard in Zira first.`);
  }
  return { ...planned, derive, notes };
}

export function validateCopySection(spec) {
  fields(spec, ["source", "header", "until", "position", "rename", "chartDataSource", "extendFilters", "replace"], "copySection");
  assert(spec.replace === undefined, "copySection replace is not supported: a rollout never deletes. A dashboard that already has the header is refused; remove the old section there first with delete-widgets (its own preview, backup and approval), then run the rollout.");
  fields(spec.source, ["companyId", "siteId", "dashboardId"], "copySection.source");
  for (const k of ["companyId", "siteId", "dashboardId"]) assert(id(String(spec.source[k] ?? "")), `copySection.source.${k} must be an ID`);
  assert(typeof spec.header === "string" && normalizeName(spec.header), "copySection.header must name the section's header widget");
  if (spec.until !== undefined) assert(typeof spec.until === "string" && normalizeName(spec.until), "copySection.until must name the widget where the section ends (it is not copied)");
  if (spec.position !== undefined) assert(spec.position === "bottom" || /^above-header:\s*\S/.test(String(spec.position)), 'copySection.position must be "bottom" or "above-header:<header name>"');
  if (spec.rename !== undefined) assert(obj(spec.rename) && Object.values(spec.rename).every(v => typeof v === "string" && text(v, 120)), "copySection.rename must map a section widget's name to its new name");
  if (spec.chartDataSource !== undefined) assert(spec.chartDataSource === "first-mapped", 'copySection.chartDataSource may only be "first-mapped"');
  if (spec.extendFilters !== undefined) assert(typeof spec.extendFilters === "boolean", "copySection.extendFilters must be true or false");
  return spec;
}

// Everything a section copy would create and change on one target dashboard. Pure: no calls.
// Throws one error listing every problem; nothing is planned around a problem.
export function planCopySection({ source, target, spec, mapping = new Map(), targetMetricIds = null }) {
  validateCopySection(spec);
  const section = sectionOf(source, spec.header, spec.until);
  const existing = target.widgets ?? [];
  if (String(source.id) === String(target.id)) throw new Error(`Dashboard ${target.id} is the source of the section; it is not copied onto itself`);
  if (existing.some(w => typeOf(w) === "6" && normalizeName(w.name) === normalizeName(section.header.name)))
    throw new Blocked("duplicate", `Dashboard ${target.id} already has a header named "${section.header.name}". The section is not added twice and a rollout never deletes; remove the old section first with delete-widgets (its own preview and backup), then run the rollout again.`, { dashboardId: String(target.id) });
  const problems = [], notes = [];
  const targetDevices = new Set((target.devices ?? []).map(d => String(d.id)));
  const outside = [...new Set([...mapping.values()].flat())].filter(t => !targetDevices.has(t));
  if (outside.length) problems.push(`deviceMapping names data sources that are not data sources of dashboard ${target.id}: ${outside.join(", ")}. Add them to the dashboard in Zira first.`);
  const sourceDevices = new Set((source.devices ?? []).map(d => String(d.id)));
  const sectionIds = new Set(section.widgets.map(w => String(w.id)));
  const rename = spec.rename ?? {};
  for (const name of Object.keys(rename)) if (!section.widgets.some(w => w.name === name)) problems.push(`rename lists "${name}", which is not a widget of the section`);
  const names = new Map(section.widgets.map(w => [String(w.id), text(Object.hasOwn(rename, w.name) ? rename[w.name] : String(w.name ?? ""), 120)]));
  const taken = new Set(existing.map(w => normalizeName(w.name)));
  const items = [];
  for (const w of section.widgets) {
    const type = typeOf(w), sid = String(w.id), name = names.get(sid);
    if (!CREATE_TYPES.has(type)) { problems.push(`${kindOf(w)} widget "${w.name}" is in the section; the plugin cannot create that widget type yet`); continue; }
    if (!name) problems.push(`Widget ${sid} of the section has no name`);
    if (taken.has(normalizeName(name))) problems.push(`A widget named "${name}" already exists on dashboard ${target.id} (or twice in the section); give the copy another name with "rename": {"${w.name}": "…"}`);
    taken.add(normalizeName(name));
    const r = remapWidgetDevices(w, mapping, { strict: true, sourceDevices, chartDataSource: spec.chartDataSource, fallbackDevice: target.devices?.[0]?.id });
    problems.push(...r.problems); notes.push(...r.notes);
    const copy = r.widget, a = copy.components?.[0]?.arguments?.[0];
    if (name !== w.name) {
      copy.name = name;
      for (const part of [a?.nextGenWidgetSettings, type === "18" ? null : a?.filters]) if (obj(part) && typeof part.name === "string") part.name = name;
    }
    const link = t => {
      if (sectionIds.has(String(t))) return placeholder(t);
      problems.push(`${kindOf(w)} "${w.name}" points at widget ${t}, which is outside the copied section; it cannot be linked on the target`);
      return String(t);
    };
    if (type === "20" && obj(a?.nextGenWidgetSettings)) {
      const mirrored = same(a.filters, a.nextGenWidgetSettings);
      a.nextGenWidgetSettings.widgetsList = (a.nextGenWidgetSettings.widgetsList ?? []).map(t => ({ id: link(t.id), name: names.get(String(t.id)) ?? String(t.name ?? "") }));
      if (mirrored) a.filters = structuredClone(a.nextGenWidgetSettings);
    }
    if (type === "18" && obj(a?.filters)) a.filters.widgetIds = (a.filters.widgetIds ?? []).map(link);
    const built = saveBody(copy);
    if (built.skip) { problems.push(`${kindOf(w)} "${w.name}": ${built.skip}`); continue; }
    items.push({ sourceId: sid, name, type, source: w, widget: copy, ...(built.needsPlatform ? { needsPlatform: true } : {}) });
  }
  if (targetMetricIds) for (const [metric, used] of usedMetrics({ widgets: items.map(i => i.widget) }))
    if (!targetMetricIds.has(metric)) problems.push(`Metric ${metric} (used by ${[...used].join(", ")}) is not on the data sources of dashboard ${target.id}; those widgets would show no data`);
  // Filters outside the section that also apply to its widgets: the target's filter with the same
  // name gets the new widgets too. Without one, it is listed for a decision instead of guessed.
  const extend = [], open = [];
  for (const f of source.widgets ?? []) {
    if (sectionIds.has(String(f.id)) || !["18", "20"].includes(typeOf(f))) continue;
    const a = f.components?.[0]?.arguments?.[0];
    const linked = (typeOf(f) === "20" ? (a?.nextGenWidgetSettings?.widgetsList ?? []).map(t => String(t.id)) : (a?.filters?.widgetIds ?? []).map(String))
      .filter(t => sectionIds.has(t) && items.some(i => i.sourceId === t));
    if (!linked.length) continue;
    const twins = existing.filter(w => typeOf(w) === typeOf(f) && normalizeName(w.name) === normalizeName(f.name));
    const blocked = typeOf(f) === "18" ? "AI summaries are not extended; add the new widgets to it in Zira if it should read them"
      : spec.extendFilters === false ? "extendFilters is off; choose the new widgets in the filter in Zira"
      : twins.length !== 1 ? `${twins.length ? "several filters" : "no filter"} named "${f.name}" on dashboard ${target.id}; choose the new widgets in the right filter in Zira`
      : widgetBody(twins[0]).skip;
    if (blocked) open.push({ widget: String(f.name ?? ""), field: typeOf(f) === "20" ? "filterTargets" : "widgetIds",
      reason: `in the source it also applies to ${linked.length} widget(s) of this section: ${blocked}` });
    else extend.push({ widgetId: String(twins[0].id), widget: String(twins[0].name ?? ""), adds: linked });
  }
  const position = /^above-header:/.test(spec.position ?? "") ? { above: String(spec.position).slice("above-header:".length).trim() } : {};
  let layout = null;
  try { layout = sectionLayout({ source, target, section, position, idOf: placeholder }); } catch (error) { problems.push(error.message); }
  if (problems.length) throw new Error([...new Set(problems)].join("\n"));
  const order = [...items.filter(i => !DEPENDENT.has(i.type)), ...items.filter(i => DEPENDENT.has(i.type))];
  return { kind: "copySection", header: section.header.name, position: position.above ? `above-header:${position.above}` : "bottom", creates: order, extend, open, notes: [...notes, ...layout.notes],
    preview: layout, layout: idOf => sectionLayout({ source, target, section, position, idOf }) };
}

function describeCopySection(plan, target) {
  const names = new Map(plan.creates.map(c => [c.sourceId, c.name]));
  return {
    section: plan.header, position: plan.position,
    creates: plan.creates.map(c => ({ sourceWidgetId: c.sourceId, widget: c.name, widgetType: KINDS[c.type], changes: widgetDiff(c.source, c.widget),
      ...(c.needsPlatform ? { needsPlatform: PLATFORM_CHANGE } : {}) })),
    ...(plan.extend.length ? { filterTargets: plan.extend.map(e => ({ widgetId: e.widgetId, widget: e.widget, adds: e.adds.map(s => names.get(s)) })) } : {}),
    layout: layoutChanges(target.configurationLayout, plan.preview.configurationLayout),
    ...(plan.preview.derive.length ? { derivedBreakpoints: plan.preview.derive } : {}), ...(plan.preview.dropped.length ? { droppedStaleRows: plan.preview.dropped } : {}),
    ...(plan.notes.length ? { notes: plan.notes } : {}), ...(plan.open.length ? { open: plan.open } : {}),
  };
}

// Create the section's widgets once each, extend the matching filters, save the layout, read back.
// Runs inside guardedWrite: a failure after the first create leaves a partial receipt and is never replayed.
async function runCopySection({ call, dashboardId, before, plan, progress }) {
  const ids = new Map(), created = [];
  const idOf = sid => { assert(ids.has(sid), `Widget ${sid} of the section has not been created`); return ids.get(sid); };
  for (const item of plan.creates) {
    const { body } = saveBody(swapLinks(item.widget, idOf));
    const value = (await call("POST", `/dashboards/${dashboardId}/widgets`, body))?.data;
    const wid = String(obj(value) ? value.id ?? value.widgetId ?? "" : value ?? "");
    assert(id(wid), `Creating "${item.name}" returned no widget ID; check dashboard ${dashboardId} in Zira before anything else`);
    ids.set(item.sourceId, wid);
    await progress({ [`widget:${item.sourceId}`]: wid });
    created.push({ id: wid, body, item });
  }
  let middle = null, extended = [];
  if (plan.extend.length) {
    middle = (await call("GET", `/dashboards/${dashboardId}`)).data ?? {};
    const spec = { version: 1, widgets: plan.extend.map(e => {
      const now = (settingsOf((middle.widgets ?? []).find(w => String(w.id) === e.widgetId))?.widgetsList ?? []).map(t => String(t.id));
      return { widgetId: e.widgetId, filterTargets: [...new Set([...now, ...e.adds.map(idOf)])] };
    }) };
    extended = planEdit({ spec, dashboard: middle }).writes;
    const result = await runWrites(call, extended, { progress });
    if (result.failed.length) throw result.failed[0].error;
  }
  const layout = plan.layout(idOf);
  await call("PUT", `/dashboards/configuration-layout/${dashboardId}`, { configurationLayout: layout.configurationLayout });
  await progress({ [`layout:${dashboardId}`]: "saved" });
  const receipt = { dashboardId: String(dashboardId), created: Object.fromEntries(ids) };
  const summary = created.map(c => ({ widgetId: c.id, widget: c.item.name, widgetType: KINDS[c.item.type] }));
  let saved = null;
  try { saved = (await call("GET", `/dashboards/${dashboardId}`)).data ?? null; } catch (error) {
    return { receipt, created: summary, partial: true, unverified: true, complete: false, verified: false, readBack: `Read-back failed (${errorText(error)})` };
  }
  const mismatches = [];
  for (const c of created) {
    const actual = (saved?.widgets ?? []).find(w => String(w.id) === c.id);
    const device = c.body.components?.[0]?.arguments?.[0]?.device?.id;
    if (!verifyWidget(actual, c.body) || (c.item.type === "15" && argumentDevice(actual) !== (device == null ? null : String(device))))
      mismatches.push({ target: c.id, kind: "widget", widget: c.item.name, diff: [{ path: "", note: actual ? "saved widget differs from what was sent" : "widget missing after save" }] });
  }
  if (extended.length) mismatches.push(...verifyWrites(middle, saved, extended));
  mismatches.push(...verifyWrites(before, saved, [{ kind: "layout", target: String(dashboardId), expected: layout.configurationLayout }]));
  const touched = new Set(plan.extend.map(e => e.widgetId));
  for (const w of before.widgets ?? []) {
    if (touched.has(String(w.id))) continue;
    const actual = (saved?.widgets ?? []).find(x => String(x.id) === String(w.id));
    const diff = actual ? diffPaths(normalizeWidget(w), normalizeWidget(actual)) : [{ path: "", note: "widget missing after save" }];
    if (diff.length) mismatches.push({ target: String(w.id), kind: "widget", widget: w.name, note: "a widget outside the change differs", diff: diff.slice(0, 20) });
  }
  if ((saved?.widgets ?? []).length !== (before.widgets ?? []).length + created.length)
    mismatches.push({ target: String(dashboardId), kind: "dashboard", diff: [{ path: "widgets", note: `expected ${(before.widgets ?? []).length + created.length} widgets, found ${(saved?.widgets ?? []).length}` }] });
  // An unverified section keeps an unfinished receipt, so a later run stops at this dashboard instead of passing it as done.
  return { receipt, created: summary, ...(extended.length ? { saved: extended.map(describeWrite) } : {}), complete: !mismatches.length, verified: !mismatches.length,
    ...(mismatches.length ? { partial: true, unverified: true, mismatches } : {}) };
}

// ---- Change kinds: edit (by widget ID or name), remapDataSources, copySection ----

function resolveEditSpec(spec, dashboard) {
  const out = { ...structuredClone(spec) };
  if (spec.widgets !== undefined) {
    assert(Array.isArray(spec.widgets), "widgets must be a list of changes");
    out.widgets = spec.widgets.map(change => {
      assert(obj(change), "widget change must be an object");
      const { widgetName, widgetType, ...rest } = change;
      if (widgetName === undefined) { assert(widgetType === undefined, "widgetType goes with widgetName"); return rest; }
      assert(rest.widgetId === undefined, "Give a widget change widgetId or widgetName, not both");
      assert(widgetType === undefined || Object.values(KINDS).includes(widgetType), `Unknown widgetType: ${widgetType}`);
      const hits = (dashboard.widgets ?? []).filter(w => normalizeName(w.name) === normalizeName(widgetName) && (widgetType === undefined || KINDS[typeOf(w)] === widgetType));
      assert(hits.length === 1, `${hits.length ? `${hits.length} widgets are` : "No widget is"} named "${widgetName}"${widgetType ? ` (${widgetType})` : ""} on dashboard ${dashboard.id}`);
      return { widgetId: String(hits[0].id), ...rest };
    });
  }
  return validateEditSpec(out);
}

function planRemap({ dashboard, mapping, options = {} }) {
  assert(mapping.size, `remapDataSources needs a deviceMapping for dashboard ${dashboard.id}`);
  const onDashboard = new Set((dashboard.devices ?? []).map(d => String(d.id)));
  const outside = [...new Set([...mapping.values()].flat())].filter(t => !onDashboard.has(t));
  assert(!outside.length, `deviceMapping names data sources that are not data sources of dashboard ${dashboard.id}: ${outside.join(", ")}. Add them to the dashboard in Zira first.`);
  const only = options.widgetNames ? new Set(options.widgetNames.map(normalizeName)) : null;
  if (only) for (const name of options.widgetNames) assert((dashboard.widgets ?? []).some(w => normalizeName(w.name) === normalizeName(name)), `No widget is named "${name}" on dashboard ${dashboard.id}`);
  const writes = [], problems = [], notes = [];
  for (const w of dashboard.widgets ?? []) {
    if (only && !only.has(normalizeName(w.name))) continue;
    const r = remapWidgetDevices(w, mapping, { chartDataSource: options.chartDataSource });
    problems.push(...r.problems);
    const planned = r.problems.length ? null : widgetWrite(w, r.widget);
    if (planned?.skip) problems.push(`${kindOf(w)} "${w.name}" (widget ${w.id}) uses a mapped data source and cannot be saved by the plugin: ${planned.skip}`);
    else if (planned) { writes.push(planned.write); notes.push(...r.notes); }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return { writes: platformFirst(writes), notes };
}

export function validatePlan(plan) {
  fields(plan, ["version", "label", "change", "sites", "skip"], "plan");
  assert(plan.version === 1, "Plan version must be 1");
  if (plan.label !== undefined) assert(typeof plan.label === "string" && plan.label.trim() && plan.label.length <= 80, "label must be a short text");
  fields(plan.change, ["edit", "copySection", "remapDataSources"], "change");
  assert(Object.keys(plan.change).length === 1, "change must be exactly one of edit, copySection or remapDataSources");
  if (plan.change.edit) {
    assert(obj(plan.change.edit) && plan.change.edit.version === 1, "change.edit must be an edit spec with version 1");
    assert(plan.change.edit.widgets === undefined || Array.isArray(plan.change.edit.widgets), "change.edit.widgets must be a list");
    for (const w of plan.change.edit.widgets ?? []) assert(obj(w) && (w.widgetId === undefined) !== (w.widgetName === undefined), "Each widget change needs widgetId or widgetName (the widget's name on every dashboard of the plan)");
  }
  if (plan.change.copySection) validateCopySection(plan.change.copySection);
  if (plan.change.remapDataSources) {
    fields(plan.change.remapDataSources, ["widgetNames", "chartDataSource"], "remapDataSources");
    const r = plan.change.remapDataSources;
    if (r.widgetNames !== undefined) assert(Array.isArray(r.widgetNames) && r.widgetNames.length && r.widgetNames.every(n => typeof n === "string" && normalizeName(n)), "remapDataSources.widgetNames must list widget names");
    if (r.chartDataSource !== undefined) assert(r.chartDataSource === "first-mapped", 'remapDataSources.chartDataSource may only be "first-mapped"');
  }
  assert(Array.isArray(plan.sites) && plan.sites.length > 0 && plan.sites.length <= MAX_SITES, `sites must list 1–${MAX_SITES} dashboards`);
  const seen = new Set();
  for (const s of plan.sites) {
    fields(s, ["companyId", "siteId", "dashboardId", "label", "deviceMapping"], "site");
    for (const k of ["companyId", "siteId", "dashboardId"]) assert(id(String(s[k] ?? "")), `Each site needs ${k} as an ID`);
    assert(!seen.has(String(s.dashboardId)), `Dashboard ${s.dashboardId} is listed twice`);
    seen.add(String(s.dashboardId));
    if (s.label !== undefined) assert(typeof s.label === "string" && s.label.length <= 120, "site label must be text");
    if (s.deviceMapping !== undefined) normalizeDeviceMapping(s.deviceMapping, `deviceMapping of dashboard ${s.dashboardId}`);
    if (plan.change.edit) assert(s.deviceMapping === undefined, "deviceMapping applies to copySection and remapDataSources, not to an edit");
  }
  if (plan.skip !== undefined) {
    assert(Array.isArray(plan.skip) && plan.skip.every(d => seen.has(String(d))), "skip must list dashboard IDs of this plan's sites");
  }
  return plan;
}

const changeKind = plan => Object.keys(plan.change)[0];

// Load one site's dashboard and plan the change on it. Reads only.
async function planSite({ call, profile, plan, entry, shared, skipPlatform }) {
  const site = await resolveSite(call, String(entry.companyId), String(entry.siteId));
  const dashboard = await loadDashboard(call, site, String(entry.dashboardId));
  const base = { entry, site, dashboard, rev: revision(dashboard), url: link(profile, `/dashboards/${dashboard.id}`) };
  const kind = changeKind(plan);
  if (kind === "copySection") {
    const spec = plan.change.copySection;
    shared.source ??= (async () => loadDashboard(call, await resolveSite(call, String(spec.source.companyId), String(spec.source.siteId)), String(spec.source.dashboardId)))();
    const source = await shared.source;
    const deviceIds = (dashboard.devices ?? []).map(d => String(d.id)).filter(d => id(d));
    const described = deviceIds.length ? await describeSources(call, deviceIds) : new Map();
    const targetMetricIds = new Set([...described.values()].flatMap(d => metricList(d).map(m => m.id)));
    const copy = planCopySection({ source, target: dashboard, spec, mapping: normalizeDeviceMapping(entry.deviceMapping ?? {}), targetMetricIds });
    return { ...base, copy, describe: describeCopySection(copy, dashboard), nothing: false };
  }
  let planned, notes = [];
  if (kind === "remapDataSources") {
    planned = { ...planRemap({ dashboard, mapping: normalizeDeviceMapping(entry.deviceMapping ?? {}), options: plan.change.remapDataSources }), skipped: [] };
    notes = planned.notes;
  } else {
    const spec = resolveEditSpec(plan.change.edit, dashboard);
    const needsDevices = (spec.widgets ?? []).some(w => w.deviceId !== undefined);
    const needsDashboards = (spec.widgets ?? []).some(w => w.shortcuts) || spec.dashboard?.name !== undefined;
    const siteDashboards = needsDashboards ? await siteDashboardList(call, site) : [];
    const siteDeviceIds = needsDevices ? new Set((await siteDataSources(call, site)).map(d => String(d.id))) : new Set();
    planned = planEdit({ spec, dashboard, siteDashboards, siteDeviceIds });
    assert(!planned.skipped.length, planned.skipped.map(s => `Widget "${s.widget}" (${s.widgetId}) cannot be saved by the plugin: ${s.reason}`).join("\n"));
  }
  const deferred = skipPlatform ? planned.writes.filter(w => w.needsPlatform) : [];
  const writes = planned.writes.filter(w => !deferred.includes(w));
  return { ...base, writes, nothing: !writes.length,
    describe: { writes: writes.map(describeWrite), ...(deferred.length ? { deferred: deferred.map(describeWrite) } : {}), ...(notes.length ? { notes } : {}) } };
}

const siteKey = ({ profile, plan, entry, rev, skipPlatform }) => fingerprint(canonical({ op: "dashboard-rollout", profile, change: plan.change,
  dashboardId: String(entry.dashboardId), deviceMapping: entry.deviceMapping ?? null, expected: rev, skipPlatform: !!skipPlatform }));
const readReceipts = async file => {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const briefSite = (entry, extra = {}) => ({ dashboardId: String(entry.dashboardId), ...(entry.label ? { label: entry.label } : {}), ...extra });

// The check and backup that run under the receipt lock, immediately before a dashboard's first write.
export const guardAndBackUp = ({ call, dashboardId, rev, backupDir, label, profile, now, onBackup }) => async () => {
  const latest = (await call("GET", `/dashboards/${dashboardId}`)).data;
  if (revision(latest) !== rev) throw new Blocked("conflict", `Dashboard ${dashboardId} changed since the preview; nothing was written to it. Preview again and review it.`, { dashboardId: String(dashboardId) });
  onBackup(await writeBackup({ dir: backupDir, dashboard: latest, label, profile, now }));
};

export async function rollout({ call: rawCall, profile = "prod", plan, expected, apply = false, backupDir, skipPlatform = false, receipts, now = () => new Date() }) {
  validatePlan(plan);
  const call = rememberSites(rawCall);
  const kind = changeKind(plan), label = plan.label ?? kind;
  const planKey = fingerprint(canonical({ profile, change: plan.change, skipPlatform: !!skipPlatform }));
  const skip = new Set((plan.skip ?? []).map(String));
  const skipped = plan.sites.filter(s => skip.has(String(s.dashboardId))).map(s => briefSite(s, { state: "skipped" }));
  const active = plan.sites.filter(s => !skip.has(String(s.dashboardId)));
  assert(active.length, "Every site of the plan is listed under skip; nothing to do");
  let reviewed = null, stored = null;
  if (apply) {
    assert(expected, "--expected FILE (the reviewed preview's revisions per dashboard) is required with --apply");
    assert(backupDir, "--backup-dir DIR is required with --apply: each dashboard is backed up before its first write");
    reviewed = obj(expected.expected) ? expected.expected : expected;
    assert(obj(reviewed) && reviewed.version === 1 && obj(reviewed.revisions), "--expected must hold a rollout preview or its expected {version, planKey, revisions}");
    if (reviewed.planKey !== planKey) throw new Blocked("conflict", "The plan differs from the one that was previewed (change, profile or --skip-platform). Preview it again and review it; nothing was written.");
    stored = await readReceipts(receipts);
  }
  // Phase 1, reads only: plan every site. One failing site refuses the whole plan.
  const shared = {}, planned = [], invalid = [], changed = [];
  for (const entry of active) {
    const dashboardId = String(entry.dashboardId);
    const rev = reviewed?.revisions[dashboardId];
    if (apply) {
      if (typeof rev !== "string" || !rev) { invalid.push(briefSite(entry, { error: "the reviewed preview has no revision for this dashboard" })); continue; }
      const key = siteKey({ profile, plan, entry, rev, skipPlatform });
      const prior = stored?.actions?.[key];
      if (prior?.state === "done" && !prior.unverified) { planned.push({ entry, rev, key, alreadyDone: prior }); continue; }
      if (["pending", "partial", "done"].includes(prior?.state)) {
        invalid.push(briefSite(entry, { error: `an earlier attempt of this exact change is ${prior.state === "done" ? "saved but was not verified" : prior.state}; check that dashboard in Zira against its backup, then list it under skip to go on with the others`, receipt: prior }));
        continue;
      }
    }
    try {
      const site = await planSite({ call, profile, plan, entry, shared, skipPlatform });
      if (apply && site.rev !== rev) changed.push(briefSite(entry, { reviewed: rev, now: site.rev }));
      else planned.push({ ...site, key: apply ? siteKey({ profile, plan, entry, rev, skipPlatform }) : null });
    } catch (error) {
      if (stopsEverything(error)) throw error;
      invalid.push(briefSite(entry, { error: errorText(error), ...(error instanceof Blocked ? { blocked: error.reason } : {}) }));
    }
  }
  if (invalid.length)
    throw new Error(`${invalid.length} of ${active.length} dashboard(s) cannot take this change; nothing was written anywhere.\n${invalid.map(s =>
      `- dashboard ${s.dashboardId}${s.label ? ` (${s.label})` : ""}: ${s.error.split("\n").join("\n    ")}`).join("\n")}\nFix the plan, or list a dashboard under "skip" to leave it out.`);
  if (changed.length)
    throw new Blocked("conflict", `${changed.length} dashboard(s) changed since the preview (${changed.map(s => s.dashboardId).join(", ")}). Preview again and review it; nothing was written anywhere.`, { changed });
  const view = s => briefSite(s.entry, { site: { id: s.site.id, name: s.site.name }, dashboard: s.dashboard.name, url: s.url, revision: s.rev,
    state: s.nothing ? "nothing-to-do" : "planned", ...s.describe });
  if (!apply) {
    const sites = planned.map(view);
    return { kind: "dashboard-rollout-preview", profile, label, change: kind, sites, ...(skipped.length ? { skipped } : {}),
      expected: { version: 1, planKey, revisions: Object.fromEntries(planned.map(s => [String(s.entry.dashboardId), s.rev])) },
      ...(planned.some(s => (s.writes ?? []).some(w => w.needsPlatform)) ? { platformNote: `Writes marked needsPlatform are admitted for plugin sign-in once ${PLATFORM_CHANGE} is deployed; until then that dashboard stops with not_enabled before anything is written to it. Use --skip-platform to apply the rest.` } : {}),
      next: "Review every site's changes. To apply, save this output (or its expected object) to a file and run rollout again with --apply --expected FILE --backup-dir DIR. Nothing was written.",
      applied: false };
  }
  // Phase 2: one site at a time. Stop at the first site that fails or cannot be verified.
  const done = [], failed = [], notTried = [];
  for (const s of planned) {
    if (failed.length) { notTried.push(briefSite(s.entry)); continue; }
    if (s.alreadyDone) { done.push(briefSite(s.entry, { state: "already-done", receipt: s.alreadyDone })); continue; }
    if (s.nothing) { done.push(briefSite(s.entry, { state: "nothing-to-do", url: s.url })); continue; }
    const dashboardId = String(s.dashboard.id);
    let backup = null;
    const precheck = guardAndBackUp({ call, dashboardId, rev: s.rev, backupDir, label, profile, now, onBackup: file => { backup = file; } });
    const summary = { kind: "dashboard-rollout", change: kind, label, dashboardId, siteId: s.site.id };
    try {
      const outcome = s.copy
        ? await guardedWrite({ file: receipts, key: s.key, summary, precheck, links: () => ({ url: s.url }),
          run: progress => runCopySection({ call, dashboardId, before: s.dashboard, plan: s.copy, progress }) })
        : await applyWrites({ call, dashboardId, before: s.dashboard, writes: s.writes, receipts, key: s.key, summary, precheck });
      const result = briefSite(s.entry, { url: s.url, ...(backup ? { backup } : {}) });
      if (outcome.state === "already-done") done.push({ ...result, state: "already-done", receipt: outcome.receipt });
      else {
        const details = { verified: !!outcome.verified, ...(outcome.created ? { created: outcome.created } : {}), ...(outcome.saved ? { saved: outcome.saved } : {}),
          ...(outcome.failed ? { failed: outcome.failed } : {}), ...(outcome.notTried ? { notTried: outcome.notTried } : {}),
          ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}), ...(outcome.readBack ? { readBack: outcome.readBack } : {}) };
        if (outcome.complete) done.push({ ...result, state: "updated", ...details });
        else {
          // The receipt remembers that the save was not confirmed, so a later run stops here again.
          // If that note cannot be saved, say so loudly: a rerun would otherwise report this dashboard as already done.
          let receiptWarning = null;
          try {
            if (!(await annotateReceipt(receipts, s.key, { unverified: true }))) receiptWarning = "no receipt was found to mark as unverified";
          } catch (error) { receiptWarning = `the receipt could not be marked unverified (${errorText(error)})`; }
          failed.push({ ...result, state: outcome.state === "partial" && !outcome.unverified ? "partial" : "unverified", ...details,
            ...(receiptWarning ? { receiptWarning: `${receiptWarning}. A later rerun may report dashboard ${dashboardId} as already-done; check it in Zira against its backup instead of trusting that.` } : {}),
            next: `Compare dashboard ${dashboardId} in Zira with its backup before anything else; restore --backup previews setting it back.` });
        }
      }
    } catch (error) {
      const blocked = explain(error, { profile });
      failed.push(briefSite(s.entry, { url: s.url, state: "failed", ...(backup ? { backup } : {}), error: blocked?.message ?? errorText(error),
        ...(blocked ? { blocked: blocked.reason, ...blocked.details } : {}) }));
    }
  }
  const complete = !failed.length && !notTried.length;
  return { kind: "dashboard-rollout", profile, label, change: kind, applied: done.some(s => s.state === "updated") || failed.some(s => s.state !== "failed" || s.blocked === "unverified_write"),
    state: complete ? "updated" : "stopped", complete, done, failed, notTried, ...(skipped.length ? { skipped } : {}),
    ...(complete ? {} : { next: "The run stopped at the first dashboard that failed or could not be verified; later dashboards were not touched. Check the failed dashboard, then preview again: dashboards already done answer already-done." }) };
}

// ---- Restore a dashboard to a backup ----

const settingsView = d => ({ name: d.name ?? null, description: d.description || null, isShared: d.isShared ?? null, isLocked: d.isLocked ?? null,
  isPrivate: d.isPrivate ?? null, lazyLoading: d.lazyLoading ?? null, range: d.defaultDisplayRange?.id == null ? null : String(d.defaultDisplayRange.id),
  interval: d.defaultDisplayInterval?.id == null ? null : String(d.defaultDisplayInterval.id) });

// Every write that sets the dashboard back to the backup with the plugin's existing write paths,
// and everything those paths cannot set back. Pure: no calls.
export function planRestore({ current, backup, siteDashboards = [] }) {
  assert(String(backup.id) === String(current.id), `The backup is of dashboard ${backup.id}, not dashboard ${current.id}`);
  const writes = [], cannotRestore = [];
  const was = settingsView(backup), is = settingsView(current), changes = {};
  for (const k of Object.keys(was)) {
    if (same(was[k], is[k])) continue;
    const one = { [k]: was[k] };
    try {
      assert(was[k] !== null || k === "description", "the backup has no value for it");
      planEdit({ spec: { version: 1, dashboard: one }, dashboard: current, siteDashboards });
      changes[k] = was[k];
    } catch (error) { cannotRestore.push({ what: `dashboard ${k}`, backup: was[k], now: is[k], reason: error.message }); }
  }
  if (Object.keys(changes).length) writes.push(...planEdit({ spec: { version: 1, dashboard: changes }, dashboard: current, siteDashboards }).writes);
  const had = (backup.devices ?? []).map(d => String(d.id)).sort(), has = (current.devices ?? []).map(d => String(d.id)).sort();
  if (!same(had, has)) cannotRestore.push({ what: "dashboard data sources", backup: had, now: has, reason: "the plugin has no write path for a dashboard's data source list; change it in Zira" });
  const now = new Map((current.widgets ?? []).map(w => [String(w.id), w])), then = new Map((backup.widgets ?? []).map(w => [String(w.id), w]));
  for (const [wid, old] of then) {
    const live = now.get(wid), item = { what: "widget", widgetId: wid, widget: String(old.name ?? ""), widgetType: kindOf(old) };
    if (!live) { cannotRestore.push({ ...item, reason: "deleted since the backup; creating it again would give it a new ID and break its links, so it is not recreated" }); continue; }
    if (typeOf(live) !== typeOf(old)) { cannotRestore.push({ ...item, reason: "its widget type changed since the backup" }); continue; }
    const a = old.components?.[0]?.arguments?.[0];
    const links = typeOf(old) === "20" ? (a?.nextGenWidgetSettings?.widgetsList ?? []).map(t => String(t.id)) : typeOf(old) === "18" ? (a?.filters?.widgetIds ?? []).map(String) : [];
    const gone = links.filter(t => !now.has(t));
    const planned = widgetWrite(live, old);
    if (!planned) continue;
    if (gone.length) cannotRestore.push({ ...item, reason: `the backup links it to widget(s) deleted since (${gone.join(", ")})` });
    else if (planned.skip) cannotRestore.push({ ...item, reason: planned.skip });
    else writes.push(planned.write);
  }
  const added = [...now.values()].filter(w => !then.has(String(w.id)));
  for (const w of added) cannotRestore.push({ what: "widget", widgetId: String(w.id), widget: String(w.name ?? ""), widgetType: kindOf(w),
    reason: `added since the backup; restore never deletes, so it stays, below the restored layout. To remove it, run delete-widgets --widget-ids ${w.id} (its own preview and backup), then preview the restore again.` });
  const layout = {};
  for (const [bp, rows] of Object.entries(backup.configurationLayout ?? {})) {
    if (!Object.hasOwn(COLS, bp) || !Array.isArray(rows)) continue;
    if (unpositioned(bp, rows)) { if (!same(rows, current.configurationLayout?.[bp])) cannotRestore.push({ what: `layout ${bp}`, reason: "the backup holds no arranged layout for this breakpoint" }); continue; }
    const kept = rows.filter(r => now.has(String(r.i))).map(pickRow);
    const below = Math.max(0, ...kept.map(r => r.y + r.h));
    const extra = (current.configurationLayout?.[bp] ?? []).filter(r => now.has(String(r.i)) && !then.has(String(r.i)) && r.y < 9999).map(pickRow);
    const top = Math.min(...extra.map(r => r.y));
    layout[bp] = [...kept, ...extra.map(r => ({ ...r, y: below + r.y - top }))];
  }
  for (const bp of Object.keys(current.configurationLayout ?? {})) if (Object.hasOwn(COLS, bp) && !Array.isArray(backup.configurationLayout?.[bp]) && (current.configurationLayout[bp] ?? []).length)
    cannotRestore.push({ what: `layout ${bp}`, reason: "the backup has no layout for this breakpoint; the current one stays" });
  if (Object.keys(layout).length) {
    // Only a row that moves is a restore; planEdit also tidies stored rows, which is not one.
    try { writes.push(...planEdit({ spec: { version: 1, layout }, dashboard: current }).writes.filter(w => w.changes.length)); }
    catch (error) { cannotRestore.push({ what: "layout", reason: error.message }); }
  }
  return { writes: platformFirst(writes), cannotRestore };
}

export async function restoreDashboard({ call, profile = "prod", companyId, siteId, dashboardId, backup, backupFile, expected, apply = false, backupDir,
  skipPlatform = false, receipts, now = () => new Date() }) {
  const site = await resolveScope(call, companyId, siteId);
  const current = await loadDashboard(call, site, dashboardId);
  const { dashboard: old, takenAt, label } = backupDashboard(backup);
  const oldSite = old.site?.id ?? old.siteId;
  assert(site.kind === "company" ? oldSite == null : oldSite == null || String(oldSite) === site.id,
    site.kind === "company" ? `The backup is of a dashboard at site ${oldSite}, not a company-level dashboard` : `The backup is of a dashboard at site ${oldSite}, not ${site.name}`);
  const renamed = normalizeName(old.name) !== normalizeName(current.name);
  const plan = planRestore({ current, backup: old, siteDashboards: renamed ? await siteDashboardList(call, site) : [] });
  const deferred = skipPlatform ? plan.writes.filter(w => w.needsPlatform) : [];
  const writes = plan.writes.filter(w => !deferred.includes(w));
  const url = link(profile, `/dashboards/${dashboardId}`), rev = revision(current);
  const needsPlatform = writes.filter(w => w.needsPlatform).map(w => ({ kind: w.kind, target: w.target, ...(w.widget ? { widget: w.widget, widgetType: w.widgetType } : {}) }));
  const preview = { kind: "dashboard-restore-preview", profile, url, revision: rev, dashboard: { id: String(current.id), name: current.name },
    backup: { ...(backupFile ? { file: backupFile } : {}), takenAt, label, revision: revision(old), sameAsNow: revision(old) === rev },
    writes: writes.map(describeWrite), ...(deferred.length ? { deferred: deferred.map(describeWrite) } : {}),
    cannotRestore: plan.cannotRestore,
    ...(needsPlatform.length ? { needsPlatform, platformNote: `These settings are saved by plugin sign-in only once ${PLATFORM_CHANGE} is deployed; until then apply stops with not_enabled before writing anything. Use --skip-platform to restore the rest now.` } : {}),
    note: "Restore sets back what the plugin can edit: dashboard settings, each remaining widget's saved settings and the layout. It never deletes; cannotRestore lists what stays different from the backup.",
    applied: false };
  if (!apply) return preview;
  if (!expected) throw new Error("--expected REVISION from a reviewed preview is required with --apply");
  assert(backupDir, "--backup-dir DIR is required with --apply: the dashboard is backed up before it is set back");
  if (!writes.length) return { kind: "dashboard-restore", profile, url, state: "nothing-to-do", applied: false, cannotRestore: plan.cannotRestore };
  let saved = null;
  const guard = guardAndBackUp({ call, dashboardId: String(dashboardId), rev: expected, backupDir, label: "restore", profile, now, onBackup: file => { saved = file; } });
  const outcome = await applyWrites({
    call, dashboardId: String(dashboardId), before: current, writes, receipts,
    key: fingerprint(canonical({ op: "dashboard-restore", profile, dashboardId: String(dashboardId), backup: revision(old), expected, skipPlatform: !!skipPlatform })),
    summary: { kind: "dashboard-restore", dashboardId: String(dashboardId), siteId: site.id, writes: writes.length },
    precheck: async () => {
      if (expected !== rev) throw new Blocked("conflict", "The dashboard changed since the preview. Preview again and review it; nothing was written.");
      await guard();
    },
  });
  if (outcome.state === "already-done") return { kind: "dashboard-restore", profile, url, state: "already-done", applied: false, receipt: outcome.receipt };
  return { kind: "dashboard-restore", profile, url, applied: true, state: outcome.complete ? "updated" : outcome.state === "partial" ? "partial" : "unverified",
    verified: outcome.verified, complete: outcome.complete, backup: saved, saved: outcome.saved, ...(outcome.failed ? { failed: outcome.failed } : {}),
    ...(outcome.notTried ? { notTried: outcome.notTried } : {}), ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}),
    ...(outcome.readBack ? { readBack: outcome.readBack } : {}), cannotRestore: plan.cannotRestore };
}

// ---- Sharing: the server's value ----

export const SHARING_NOTE = "Read from Zira's server just now. Private in the dashboard's settings means not shared: private = !isShared. The web editor's settings dialog can show an older cached value; this server value is the truth.";

export async function sharing({ call: rawCall, profile = "prod", companyId, siteId, dashboardIds, sites, now = () => new Date() }) {
  const call = rememberSites(rawCall);
  const wanted = sites ? sites.map(s => ({ companyId: String(s.companyId ?? ""), siteId: String(s.siteId ?? ""), dashboardId: String(s.dashboardId ?? "") }))
    : idList(dashboardIds).map(d => ({ companyId, siteId: siteId ?? "", dashboardId: d }));
  // Without --site-id the dashboards are the company's company-level dashboards.
  assert(sites || id(String(companyId ?? "")), "sharing needs --company-id (and --site-id for a site's dashboards) with --dashboard-ids, or --plan FILE");
  assert(wanted.length > 0 && wanted.length <= 200, "Choose 1–200 dashboards (--dashboard-ids A,B,… with --company-id and --site-id, or --plan FILE)");
  assert(wanted.every(w => id(w.dashboardId)), "Dashboard IDs must be IDs");
  const dashboards = [];
  for (const w of wanted) {
    try {
      const site = await resolveScope(call, w.companyId, w.siteId);
      const d = (await call("GET", `/dashboards/${w.dashboardId}`)).data ?? {};
      if (String(d.id ?? "") !== w.dashboardId || !dashboardInScope(d, site))
        throw new Blocked("scope", `Dashboard ${w.dashboardId} is not a dashboard of ${site.name} that this user can see`);
      const shared = typeof d.isShared === "boolean" ? d.isShared : null;
      dashboards.push({ id: w.dashboardId, name: String(d.name ?? ""), site: { id: site.id, name: site.name }, private: shared === null ? null : !shared,
        isShared: shared, isPrivate: typeof d.isPrivate === "boolean" ? d.isPrivate : null, url: link(profile, `/dashboards/${w.dashboardId}`) });
    } catch (error) {
      if (stopsEverything(error)) throw error;
      dashboards.push({ id: w.dashboardId, error: explain(error, { profile })?.message ?? errorText(error) });
    }
  }
  const unread = dashboards.filter(d => d.error).length;
  return { kind: "dashboard-sharing", profile, readAt: now().toISOString(), dashboards, note: SHARING_NOTE, ...(unread ? { complete: false, unread } : {}) };
}

// ---- CLI (reached through dashboards.mjs) ----

const readJsonFile = async (file, what, max) => {
  const raw = await readFile(file, "utf8");
  assert(raw.length <= max, `${what} exceeds ${Math.round(max / 1024)} KiB`);
  try { return JSON.parse(raw); } catch { throw new Error(`${what} is not valid JSON: ${file}`); }
};

export async function rolloutCommand(command, o, { profile, receipts, session = liveSession }) {
  if (command === "sharing") {
    const plan = o.plan ? await readJsonFile(o.plan, "Plan", 1024 * 1024) : null;
    assert(!plan || Array.isArray(plan.sites), "--plan FILE needs sites: [{companyId, siteId, dashboardId}]");
    return sharing({ call: await session(profile, { allow: SHARING_ROUTES, maxRequests: 420 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardIds: o["dashboard-ids"] ?? o["dashboard-id"], sites: plan?.sites });
  }
  if (command === "restore") {
    assert(o.backup, "--backup FILE required: a backup written by rollout/restore, or a saved GET /dashboards/{id} answer");
    const backup = await readJsonFile(o.backup, "Backup", 8 * 1024 * 1024);
    return restoreDashboard({ call: await session(profile, { allow: EDIT_ROUTES, maxRequests: 400 }), profile, companyId: o["company-id"], siteId: o["site-id"],
      dashboardId: o["dashboard-id"], backup, backupFile: path.resolve(o.backup), expected: o.expected, apply: !!o.apply, backupDir: o["backup-dir"],
      skipPlatform: !!o["skip-platform"], receipts });
  }
  assert(command === "rollout", "Choose rollout, restore or sharing");
  assert(o.plan, "--plan FILE required");
  const plan = validatePlan(await readJsonFile(o.plan, "Plan", 1024 * 1024));
  const expected = o.expected ? await readJsonFile(o.expected, "Expected revisions", 8 * 1024 * 1024) : undefined;
  return rollout({ call: await session(profile, { allow: rolloutRoutes(plan), maxRequests: 1000 }), profile, plan, expected, apply: !!o.apply,
    backupDir: o["backup-dir"], skipPlatform: !!o["skip-platform"], receipts });
}
