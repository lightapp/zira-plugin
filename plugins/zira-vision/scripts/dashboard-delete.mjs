// Delete with backup: widgets of a next-generation dashboard (delete-widgets) or a whole dashboard
// (delete). Both preview by default and name everything that would go and everything that points at
// it. Apply needs the reviewed revision and a backup folder: the dashboard's full JSON is written and
// read back under the receipt lock before the first write, deletes run one at a time and stop at the
// first failure, and the dashboard is read back to check that only the chosen objects are gone.
// A delete cannot be undone from here: the backup is the record to rebuild from, not an undo.
import path from "node:path";
import {
  Blocked, ZiraApiError, definiteFailure, explain, fingerprint, guardedWrite, id, idList, link, normalizeName, resolveScope, resolveSite,
} from "./client.mjs";
import {
  KINDS, diffPaths, layoutChanges, loadDashboard, normalizeWidget, notEnabled, planLayout, revision, siteDashboardList, verifyWrites,
} from "./dashboard-edit.mjs";
import { guardAndBackUp, widgetWrite } from "./dashboard-rollout.mjs";

// The platform change that admits deletes for plugin sign-in. Until it is deployed the first delete is
// refused and the run stops with not_enabled before anything is written.
export const DELETE_PLATFORM_CHANGE = "Zira's plugin access update for dashboard deletes";
const READS = [["GET", /^\/sites\/list$/], ["GET", /^\/dashboards\/[1-9]\d*$/]];
// delete-widgets: the widget delete, the two existing update routes (unlink, layout) and reads. Never a dashboard delete.
export const DELETE_WIDGET_ROUTES = [...READS, ["DELETE", /^\/dashboards\/widgets\/[1-9]\d*$/],
  ["PUT", /^\/dashboards\/widgets\/[1-9]\d*$/], ["PUT", /^\/dashboards\/configuration-layout\/[1-9]\d*$/]];
// delete: reads and the one dashboard delete. No update route at all.
export const DELETE_DASHBOARD_ROUTES = [...READS, ["GET", /^\/dashboards\/list$/], ["DELETE", /^\/dashboards\/[1-9]\d*$/]];

const MAX_WIDGETS = 100;
const MAX_SCANNED = 300;
const BREAKPOINTS = ["lg", "md", "sm", "xs", "xxs"];
export const NOT_UNDONE = "A delete cannot be undone from the plugin: restore never recreates a deleted widget or dashboard. The backup file keeps the full dashboard as Zira returned it, to rebuild from by hand.";
const WIDGETS_NOT_CHECKED = "Not checked: AI reports and their schedules that read these widgets, and anything outside this dashboard.";
const DASHBOARD_NOT_CHECKED = "Not checked: AI reports and their schedules that read this dashboard, channel links, bookmarks, classic dashboards, dashboards at other sites and links saved outside Zira.";

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const obj = x => !!x && typeof x === "object" && !Array.isArray(x);
const canonical = x => Array.isArray(x) ? x.map(canonical) : obj(x)
  ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
const same = (a, b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
const errorText = error => error?.status ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ""}` : error?.message ?? String(error);
const typeOf = w => String(w?.type?.id ?? "");
const kindOf = w => KINDS[typeOf(w)] ?? w?.type?.name ?? `type ${typeOf(w)}`;
const brief = w => ({ widgetId: String(w.id), widget: String(w.name ?? ""), widgetType: kindOf(w) });
const firstArgument = w => w?.components?.[0]?.arguments?.[0];
// Sign-in, pacing and limits stop a scan; anything else is one dashboard that could not be read.
const stopsEverything = error => ["sign_in", "rate_limit", "agent_pacing_blocked", "agent_route_unavailable", "busy"].includes(explain(error)?.reason);

// --widget-names "Cut time","Notes, old": comma-separated, with double quotes around a name that has a comma.
export function nameList(value) {
  const out = [];
  for (const m of String(value ?? "").matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|([^,]*))\s*(?:,|$)/g)) {
    const name = (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? "").trim();
    if (name) out.push(name);
    if (m.index + m[0].length >= String(value ?? "").length) break;
  }
  return out;
}

// ---- What points at a widget ----

// Dashboards a shortcut card opens: [{ index, dashboardId, displayText }].
export function shortcutTargets(widget) {
  if (typeOf(widget) !== "7") return [];
  return (widget.components ?? []).flatMap((c, index) => {
    const cta = c?.arguments?.[0]?.cta;
    return obj(cta) && String(cta.entityType?.id) === "19" && id(String(cta.entity ?? ""))
      ? [{ index, dashboardId: String(cta.entity), displayText: String(cta.displayText ?? "") }] : [];
  });
}

// Every place a remaining widget names one of `ids`. The two the plugin can edit are a filter's
// targets (widgetsList) and an AI summary's sources (widgetIds). Any other field whose name mentions
// widgets and holds one of the IDs is reported as "other": the plugin cannot remove it.
export function widgetReferences(dashboard, ids) {
  const gone = new Set([...ids].map(String));
  const out = [];
  for (const w of dashboard.widgets ?? []) {
    if (gone.has(String(w.id))) continue;
    const a = firstArgument(w), type = typeOf(w);
    const known = type === "20" ? [...(a?.nextGenWidgetSettings?.widgetsList ?? []), ...(a?.filters?.widgetsList ?? [])].map(t => String(t?.id ?? ""))
      : type === "18" ? (a?.filters?.widgetIds ?? []).map(String) : [];
    const hits = [...new Set(known.filter(t => gone.has(t)))];
    if (hits.length) out.push({ ...brief(w), field: type === "20" ? "filterTargets" : "widgetIds", references: hits, canUnlink: true });
    // Anything else: a deep look at fields named after widgets, outside the two lists above.
    const other = new Map();
    const collect = (value, where) => {
      if (Array.isArray(value)) return value.forEach((v, n) => collect(v, `${where}[${n}]`));
      const candidate = obj(value) ? value.id : value;
      if (["string", "number"].includes(typeof candidate) && gone.has(String(candidate))) other.set(where, String(candidate));
    };
    const walk = (value, where) => {
      if (Array.isArray(value)) return value.forEach((v, n) => walk(v, `${where}[${n}]`));
      if (!obj(value)) return;
      for (const [k, v] of Object.entries(value)) {
        const next = where ? `${where}.${k}` : k;
        if ((type === "20" && k === "widgetsList") || (type === "18" && k === "widgetIds")) continue;
        if (/widget/i.test(k) && k !== "nextGenWidgetSettings" && !/^systemWidgetType/.test(k)) collect(v, next);
        walk(v, next);
      }
    };
    walk({ uiSettings: w.uiSettings, components: w.components }, "");
    if (other.size) out.push({ ...brief(w), field: "other", references: [...new Set(other.values())], paths: [...other.keys()].slice(0, 10), canUnlink: false });
  }
  return out;
}

// The referencing widget without its links to deleted widgets. { widget } or { problem }.
function unlinked(widget, gone) {
  const w = structuredClone(widget), a = firstArgument(w), type = typeOf(w);
  const keep = t => !gone.has(String(obj(t) ? t.id : t));
  if (type === "20") {
    if (!obj(a?.nextGenWidgetSettings) || !Array.isArray(a.nextGenWidgetSettings.widgetsList))
      return { problem: `Filter "${widget.name}" (widget ${widget.id}) keeps its targets in a form the plugin cannot save. Change it in Zira first, or delete it too.` };
    for (const part of [a?.nextGenWidgetSettings, a?.filters]) if (obj(part) && Array.isArray(part.widgetsList)) part.widgetsList = part.widgetsList.filter(keep);
    if (!(a?.nextGenWidgetSettings?.widgetsList ?? []).length)
      return { problem: `Filter "${widget.name}" (widget ${widget.id}) would be left with no widgets to filter. Delete it too, or point it at other widgets first (dashboards edit, filterTargets).` };
  } else if (type === "18") {
    a.filters.widgetIds = a.filters.widgetIds.filter(keep);
    if (!a.filters.widgetIds.length)
      return { problem: `AI summary "${widget.name}" (widget ${widget.id}) would be left with no widgets to read. Delete it too, or give it other source widgets in Zira first.` };
  }
  return { widget: w };
}

// ---- delete-widgets: plan ----

function chosenWidgets(dashboard, { widgetIds, widgetNames }) {
  const ids = Array.isArray(widgetIds) ? widgetIds.map(String) : idList(widgetIds);
  const names = Array.isArray(widgetNames) ? widgetNames : nameList(widgetNames);
  assert(ids.length || names.length, 'Choose the widgets: --widget-ids A,B or --widget-names "X","Y"');
  assert(!(ids.length && names.length), "Give --widget-ids or --widget-names, not both");
  const all = dashboard.widgets ?? [], chosen = [];
  for (const wid of ids) {
    assert(id(wid), `"${wid}" is not a widget ID`);
    const w = all.find(x => String(x.id) === wid);
    assert(w, `Widget ${wid} is not on dashboard ${dashboard.id}`);
    chosen.push(w);
  }
  for (const name of names) {
    assert(normalizeName(name), "A widget name is empty");
    const hits = all.filter(w => normalizeName(w.name) === normalizeName(name));
    assert(hits.length === 1, hits.length ? `${hits.length} widgets are named "${name}" on dashboard ${dashboard.id} (${hits.map(w => w.id).join(", ")}); choose them with --widget-ids`
      : `No widget is named "${name}" on dashboard ${dashboard.id}`);
    chosen.push(hits[0]);
  }
  const unique = [...new Map(chosen.map(w => [String(w.id), w])).values()];
  assert(unique.length === chosen.length, "A widget is chosen twice");
  assert(unique.length <= MAX_WIDGETS, `Choose at most ${MAX_WIDGETS} widgets`);
  return unique;
}

// Everything a widget delete would do on one dashboard, in the order it would run. Pure: no calls.
// Refuses (Blocked "referenced") when a remaining widget points at a deleted one and unlink is off.
export function planDeleteWidgets({ dashboard, widgetIds, widgetNames, unlink = false, keepLayout = false }) {
  const chosen = chosenWidgets(dashboard, { widgetIds, widgetNames });
  const gone = new Set(chosen.map(w => String(w.id)));
  const references = widgetReferences(dashboard, gone);
  const referencedBy = wid => references.filter(r => r.references.includes(wid)).map(({ references: _r, paths: _p, canUnlink: _c, ...r }) => r);
  const deletes = chosen.map(w => ({ ...brief(w), referencedBy: referencedBy(String(w.id)),
    ...(typeOf(w) === "7" ? { opens: shortcutTargets(w) } : {}) }));
  const stuck = references.filter(r => !r.canUnlink);
  if (stuck.length)
    throw new Blocked("referenced", `${stuck.map(r => `${r.widgetType} "${r.widget}" (widget ${r.widgetId}) names widget ${r.references.join(", ")} in a setting the plugin cannot change`).join("; ")}. Change that in Zira first, or delete that widget too. Nothing was written.`,
      { dashboardId: String(dashboard.id), deletes, references });
  if (references.length && !unlink)
    throw new Blocked("referenced", `${references.length} remaining widget(s) on dashboard ${dashboard.id} point at the widgets to delete: ${references.map(r =>
      `${r.widgetType} "${r.widget}" (widget ${r.widgetId}) → ${r.references.join(", ")}`).join("; ")}. Add --unlink to remove those links as part of the delete (the preview shows each change), or delete those widgets too. Nothing was written.`,
    { dashboardId: String(dashboard.id), deletes, references });
  // Unlink: each referencing widget saved once without its links to the deleted widgets, through the existing update path.
  const problems = [], unlinks = [];
  const byWidget = new Map();
  for (const r of references) byWidget.set(r.widgetId, [...(byWidget.get(r.widgetId) ?? []), r]);
  for (const wid of byWidget.keys()) {
    const current = dashboard.widgets.find(w => String(w.id) === wid);
    const next = unlinked(current, gone);
    if (next.problem) { problems.push(next.problem); continue; }
    const planned = widgetWrite(current, next.widget);
    if (planned?.skip) problems.push(`${kindOf(current)} "${current.name}" (widget ${wid}) points at a widget to delete and cannot be saved by the plugin: ${planned.skip}`);
    else if (planned) unlinks.push({ ...planned.write, removes: byWidget.get(wid).flatMap(r => r.references) });
  }
  if (problems.length) throw new Error(`${problems.join("\n")}\nNothing was written.`);
  // Order. Widgets that point at others (AI summaries, filters) go before what they point at. A delete
  // always comes first, so before the platform change is deployed the run stops with nothing written;
  // widgets that remaining widgets point at are deleted only after those links are removed.
  const rank = w => ({ "18": 0, "20": 1 })[typeOf(w)] ?? 2;
  const write = w => ({ kind: "delete", target: String(w.id), widget: String(w.name ?? ""), widgetType: kindOf(w), method: "DELETE",
    path: `/dashboards/widgets/${w.id}`, needsPlatform: true });
  const ordered = [...chosen].sort((a, b) => rank(a) - rank(b));
  const linked = new Set(references.flatMap(r => r.references));
  const free = ordered.filter(w => !linked.has(String(w.id))).map(write), held = ordered.filter(w => linked.has(String(w.id))).map(write);
  const gate = free.length || !unlinks.length ? [] : held.splice(0, 1);
  // Layout: the same rows without the deleted widgets, on every breakpoint.
  const current = dashboard.configurationLayout ?? {};
  const rowsRemoved = Object.entries(current).flatMap(([bp, rows]) => (Array.isArray(rows) ? rows : [])
    .filter(r => gone.has(String(r.i))).map(r => ({ breakpoint: bp, widgetId: String(r.i) })));
  let layout = null, layoutNote = null;
  if (keepLayout) layoutNote = rowsRemoved.length ? "--keep-layout: the layout is not saved. The deleted widgets' rows stay in it until the next layout save drops them." : null;
  else if (rowsRemoved.length) {
    const odd = Object.keys(current).filter(bp => !BREAKPOINTS.includes(bp));
    // The platform's layout guard for plugin sign-in takes only dashboards that have a data source,
    // so a home page of shortcut cards cannot have its layout saved here.
    const noSources = !(dashboard.devices ?? []).length;
    let planned = null, reason = noSources ? "the dashboard has no data sources, and plugin sign-in can save a layout only on a dashboard that has one"
      : odd.length ? `it has a breakpoint the layout route does not take (${odd.join(", ")})` : null;
    if (!reason) try { planned = planLayout({ ...dashboard, widgets: (dashboard.widgets ?? []).filter(w => !gone.has(String(w.id))) }); } catch (error) { reason = error.message; }
    if (!planned)
      throw new Error(`The layout of dashboard ${dashboard.id} cannot be saved as it is: ${reason}. ${noSources ? "Add" : "Arrange it first (dashboards edit with copyLayout), or add"} --keep-layout to delete the widgets and leave the layout as it is; the deleted widgets' rows then stay in it until a later layout save drops them. Nothing was written.`);
    const changes = layoutChanges(current, planned.configurationLayout);
    const moved = changes.filter(c => c.after !== null);
    assert(!moved.length, `Removing the layout rows would also move widget ${moved.map(c => c.widgetId).join(", ")}; nothing was written`);
    layout = { kind: "layout", target: String(dashboard.id), method: "PUT", path: `/dashboards/configuration-layout/${dashboard.id}`,
      body: { configurationLayout: planned.configurationLayout }, changes, expected: planned.configurationLayout,
      dropped: planned.dropped.filter(d => !gone.has(d.widgetId)) };
  }
  const steps = [...free, ...gate, ...unlinks, ...held, ...(layout ? [layout] : [])];
  return { chosen, gone, deletes, references, unlinks, layout, rowsRemoved, layoutNote, steps, gated: gate.length > 0 };
}

const describeStep = w => w.kind === "delete" ? { step: "delete", ...brief({ id: w.target, name: w.widget }), widgetType: w.widgetType, needsPlatform: DELETE_PLATFORM_CHANGE }
  : w.kind === "widget" ? { step: "unlink", widgetId: w.target, widget: w.widget, widgetType: w.widgetType, removes: w.removes, changes: w.diff,
    ...(w.needsPlatform ? { needsPlatform: true } : {}) }
    : { step: "layout", dashboardId: w.target, rowsRemoved: w.changes.filter(c => c.after === null && !w.dropped.some(d => d.breakpoint === c.breakpoint && d.widgetId === c.widgetId))
      .map(c => ({ breakpoint: c.breakpoint, widgetId: c.widgetId })), ...(w.dropped.length ? { droppedStaleRows: w.dropped } : {}) };

// ---- delete-widgets: verify ----

const settingsView = d => ({ name: d?.name ?? null, description: d?.description || null, isShared: d?.isShared ?? null, isLocked: d?.isLocked ?? null,
  isPrivate: d?.isPrivate ?? null, lazyLoading: d?.lazyLoading ?? null, range: d?.defaultDisplayRange?.id == null ? null : String(d.defaultDisplayRange.id),
  interval: d?.defaultDisplayInterval?.id == null ? null : String(d.defaultDisplayInterval.id), type: d?.type?.id == null ? null : String(d.type.id),
  site: d?.site?.id == null ? null : String(d.site.id) });

// The read-back against the dashboard before: deleted widgets are gone, widgets whose delete did not
// run are still there, saved unlinks and the layout hold what was planned, and nothing else differs.
export function verifyDeletion(before, saved, { done, pending = [] }) {
  const problems = [];
  const now = new Map((saved?.widgets ?? []).map(w => [String(w.id), w]));
  const deleted = new Set(done.filter(w => w.kind === "delete").map(w => w.target));
  const edited = new Set(done.filter(w => w.kind === "widget").map(w => w.target));
  for (const wid of deleted) if (now.has(wid)) problems.push({ target: wid, kind: "delete", diff: [{ path: "", note: "widget still on the dashboard after its delete" }] });
  const open = new Set(pending.filter(w => w.kind === "delete").map(w => w.target));
  problems.push(...verifyWrites(before, saved, done.filter(w => w.kind !== "delete")));
  for (const w of before.widgets ?? []) {
    const wid = String(w.id);
    if (deleted.has(wid) || edited.has(wid)) continue;
    const actual = now.get(wid);
    // A delete that failed with an unknown outcome is reported by the caller, not as a side effect.
    if (!actual) { if (!open.has(wid)) problems.push({ target: wid, kind: "widget", widget: w.name, note: "a widget outside the delete is gone", diff: [{ path: "", note: "widget missing" }] }); continue; }
    const diff = diffPaths(normalizeWidget(w), normalizeWidget(actual));
    if (diff.length) problems.push({ target: wid, kind: "widget", widget: w.name, note: "a widget outside the delete differs", diff: diff.slice(0, 20) });
  }
  const known = new Set((before.widgets ?? []).map(w => String(w.id)));
  for (const wid of now.keys()) if (!known.has(wid)) problems.push({ target: wid, kind: "widget", note: "a widget that was not there before", diff: [{ path: "", note: "unexpected widget" }] });
  const settings = diffPaths(settingsView(before), settingsView(saved));
  if (settings.length) problems.push({ target: String(before.id), kind: "dashboard", note: "dashboard settings differ", diff: settings });
  if (!same((before.devices ?? []).map(d => String(d.id)).sort(), (saved?.devices ?? []).map(d => String(d.id)).sort()))
    problems.push({ target: String(before.id), kind: "dashboard", diff: [{ path: "devices", note: "data sources changed" }] });
  if (done.some(w => w.kind === "layout")) {
    const left = Object.entries(saved?.configurationLayout ?? {}).flatMap(([bp, rows]) => (Array.isArray(rows) ? rows : []).filter(r => deleted.has(String(r.i))).map(r => `${bp}:${r.i}`));
    if (left.length) problems.push({ target: String(before.id), kind: "layout", diff: [{ path: "", note: `rows of deleted widgets remain: ${left.join(", ")}` }] });
  } else {
    const diff = layoutChanges(before.configurationLayout ?? {}, saved?.configurationLayout ?? {});
    if (diff.length) problems.push({ target: String(before.id), kind: "layout", note: "the layout was not saved by this run but differs", diff: diff.slice(0, 40) });
  }
  return problems;
}

// A receipt left by an attempt that did not finish while the dashboard still has the reviewed revision.
const unfinished = (error, what) => error instanceof Blocked && ["partial_write", "uncertain_write"].includes(error.reason)
  ? new Blocked(error.reason, `An earlier attempt of this exact ${what} did not finish and its outcome is recorded as unknown. Check the dashboard in Zira against its backup. To try again, add --resolve-pending none. Nothing new was written.`, error.details)
  : error;

const lockedStop = (dashboard, allowLocked, what) => {
  if (dashboard.isLocked === true && !allowLocked)
    throw new Blocked("locked", `Dashboard ${dashboard.id} is locked against changes in Zira. Unlock it there, or add --allow-locked if deleting ${what} is intended. Nothing was written.`, { dashboardId: String(dashboard.id) });
};

// ---- delete-widgets ----

export async function deleteWidgets({ call, profile = "prod", companyId, siteId, dashboardId, widgetIds, widgetNames, unlink = false, keepLayout = false,
  allowLocked = false, expected, apply = false, backupDir, receipts, resolve, now = () => new Date() }) {
  const site = await resolveScope(call, companyId, siteId);
  const dashboard = await loadDashboard(call, site, dashboardId);
  lockedStop(dashboard, allowLocked, "its widgets");
  const plan = planDeleteWidgets({ dashboard, widgetIds, widgetNames, unlink: !!unlink, keepLayout: !!keepLayout });
  const url = link(profile, `/dashboards/${dashboard.id}`), rev = revision(dashboard);
  const remaining = (dashboard.widgets ?? []).length - plan.chosen.length;
  const preview = { kind: "dashboard-delete-widgets-preview", profile, url, revision: rev,
    dashboard: { id: String(dashboard.id), name: dashboard.name, site: { id: site.id, name: site.name }, widgets: (dashboard.widgets ?? []).length },
    deletes: plan.deletes, remainingWidgets: remaining,
    ...(plan.unlinks.length ? { unlink: plan.unlinks.map(describeStep) } : {}),
    layout: plan.layout ? describeStep(plan.layout) : { step: "none", ...(plan.layoutNote ? { note: plan.layoutNote } : { note: "No layout row belongs to these widgets." }) },
    steps: plan.steps.map((w, n) => `${n + 1}. ${w.kind === "delete" ? `delete ${w.widgetType} "${w.widget}" (${w.target})` : w.kind === "widget" ? `unlink ${w.widgetType} "${w.widget}" (${w.target}) from ${w.removes.join(", ")}` : "save the layout without the deleted widgets' rows"}`),
    ...(plan.gated ? { orderNote: "Every chosen widget is linked from a remaining widget. One delete still runs first, so that before the platform change is deployed the run stops with nothing written; its links are removed in the next step." } : {}),
    ...(remaining === 0 ? { emptyNote: "This deletes every widget of the dashboard; the dashboard itself stays, empty." } : {}),
    warning: NOT_UNDONE, notChecked: WIDGETS_NOT_CHECKED,
    platformNote: `Widget deletes are admitted for plugin sign-in once ${DELETE_PLATFORM_CHANGE} is deployed; until then apply stops with not_enabled before anything is written.`,
    next: "Review the list. To apply, run again with --apply --expected REVISION --backup-dir DIR. Nothing was written.",
    applied: false };
  if (!apply) return preview;
  assert(expected, "--expected REVISION from a reviewed preview is required with --apply");
  assert(backupDir, "--backup-dir DIR is required with --apply: the dashboard is backed up before the first delete");
  if (expected !== rev) throw new Blocked("conflict", `Dashboard ${dashboard.id} changed since the preview. Preview again and review it; nothing was written.`, { dashboardId: String(dashboard.id) });
  let backup = null;
  const ids = [...plan.gone].sort();
  let outcome;
  try {
    outcome = await guardedWrite({
      file: receipts, resolve,
      key: fingerprint(canonical({ op: "dashboard-delete-widgets", profile, dashboardId: String(dashboard.id), widgets: ids, unlink: !!unlink, keepLayout: !!keepLayout, expected })),
      summary: { kind: "dashboard-delete-widgets", dashboardId: String(dashboard.id), siteId: site.id, widgets: ids },
      links: () => ({ url }),
      precheck: guardAndBackUp({ call, dashboardId: String(dashboard.id), rev: expected, backupDir, label: "delete-widgets", profile, now, onBackup: file => { backup = file; } }),
      run: async progress => {
        const done = [];
        let failed = null;
        for (const w of plan.steps) {
          try {
            await call(w.method, w.path, w.body);
            done.push(w);
            await progress({ [`${w.kind}:${w.target}`]: w.kind === "delete" ? "deleted" : "saved" });
          } catch (error) { failed = { write: w, error }; break; }
        }
        const notTried = plan.steps.slice(done.length + (failed ? 1 : 0));
        // Refused before anything was written: no receipt stays behind.
        if (failed && !done.length && definiteFailure(failed.error)) {
          if (failed.write.kind === "delete" && notEnabled(failed.write, failed.error))
            throw new Blocked("not_enabled", `Widgets cannot be deleted with plugin sign-in until ${DELETE_PLATFORM_CHANGE} is deployed, or this user cannot change dashboard ${dashboard.id} (${errorText(failed.error)}). Nothing was changed.`,
              { platformChange: DELETE_PLATFORM_CHANGE, status: failed.error.status, ...(backup ? { backup } : {}) });
          throw failed.error;
        }
        let saved = null, readBack = null;
        try { saved = (await call("GET", `/dashboards/${dashboard.id}`)).data ?? null; } catch (error) { readBack = `Read-back failed (${errorText(error)})`; }
        // A delete with an unknown outcome (timeout, 5xx) may have run: the read-back says which.
        const unknown = failed && !definiteFailure(failed.error) && failed.write.kind === "delete";
        const happened = unknown && saved && !(saved.widgets ?? []).some(w => String(w.id) === failed.write.target);
        const problems = saved ? verifyDeletion(dashboard, saved, { done, pending: failed ? [failed.write] : [] }) : [];
        const complete = !failed && !notTried.length && !!saved && !problems.length;
        return {
          partial: !complete,
          receipt: { dashboardId: String(dashboard.id), ...(backup ? { backup } : {}),
            deleted: done.filter(w => w.kind === "delete").map(w => w.target), saved: done.filter(w => w.kind !== "delete").map(w => `${w.kind}:${w.target}`),
            ...(complete ? {} : { unverified: !failed && !notTried.length }) },
          done: done.map(describeStep), complete, verified: !!saved && !problems.length,
          ...(failed ? { failed: [{ ...describeStep(failed.write), error: errorText(failed.error),
            ...(unknown ? { outcome: saved ? (happened ? "the widget is gone: the delete ran although its answer was lost" : "the widget is still on the dashboard") : "unknown" } : {}),
            ...(notEnabled(failed.write, failed.error) && failed.write.kind === "delete" ? { notEnabled: `needs ${DELETE_PLATFORM_CHANGE} deployed, or this user cannot change the dashboard` } : {}) }] } : {}),
          ...(notTried.length ? { notTried: notTried.map(describeStep) } : {}),
          ...(problems.length ? { mismatches: problems } : {}), ...(readBack ? { readBack } : {}),
        };
      },
    });
  } catch (error) { throw unfinished(error, "delete"); }
  const base = { kind: "dashboard-delete-widgets", profile, url, ...(backup ? { backup } : {}) };
  if (outcome.state === "already-done") return { ...base, state: "already-done", applied: false, receipt: outcome.receipt };
  const stopped = !!(outcome.failed || outcome.notTried);
  return { ...base, applied: outcome.done.length > 0, state: outcome.complete ? "deleted" : stopped ? "partial" : "unverified",
    verified: outcome.verified, complete: outcome.complete, done: outcome.done, failed: outcome.failed ?? [], notTried: outcome.notTried ?? [],
    ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}), ...(outcome.readBack ? { readBack: outcome.readBack } : {}),
    ...(outcome.complete ? {} : { next: `The run stopped at the first step that failed or could not be verified; later steps were not tried. Compare dashboard ${dashboard.id} in Zira with its backup, then preview again: the widgets already deleted are no longer listed.` }),
    warning: NOT_UNDONE };
}

// ---- delete: a whole dashboard ----

// Shortcut cards on the site's other next-generation dashboards that open this dashboard. Reads only.
export async function shortcutLinksTo({ call, site, dashboardId }) {
  const others = (await siteDashboardList(call, site)).filter(d => id(String(d?.id ?? "")) && String(d.id) !== String(dashboardId) && !d.isDeleted);
  const linkedFrom = [], unread = [];
  for (const d of others.slice(0, MAX_SCANNED)) {
    let board = null;
    try { board = (await call("GET", `/dashboards/${d.id}`)).data ?? null; } catch (error) {
      if (stopsEverything(error)) throw error;
      unread.push({ dashboardId: String(d.id), dashboard: String(d.name ?? ""), error: errorText(error) });
      continue;
    }
    for (const w of board?.widgets ?? []) for (const t of shortcutTargets(w)) if (t.dashboardId === String(dashboardId))
      linkedFrom.push({ dashboardId: String(d.id), dashboard: String(board.name ?? d.name ?? ""), widgetId: String(w.id), widget: String(w.name ?? ""), shortcut: t.index, displayText: t.displayText });
  }
  for (const d of others.slice(MAX_SCANNED)) unread.push({ dashboardId: String(d.id), dashboard: String(d.name ?? ""), error: `not scanned: more than ${MAX_SCANNED} dashboards at this site` });
  return { scanned: Math.min(others.length, MAX_SCANNED) - unread.filter(u => !/^not scanned/.test(u.error)).length, linkedFrom, unread };
}

// The dashboard is gone when the site's list no longer has it and reading it no longer returns it.
async function dashboardGone(call, site, dashboardId) {
  const listed = (await siteDashboardList(call, site)).some(d => String(d.id) === String(dashboardId) && !d.isDeleted);
  let readable = false;
  try {
    const d = (await call("GET", `/dashboards/${dashboardId}`)).data;
    readable = obj(d) && String(d.id ?? "") === String(dashboardId) && !d.isDeleted;
  } catch (error) { if (!(error instanceof ZiraApiError && [403, 404].includes(error.status))) throw error; }
  return { gone: !listed && !readable, listed, readable };
}

export async function deleteDashboard({ call, profile = "prod", companyId, siteId, dashboardId, allowLinked = false, allowLocked = false, expected, apply = false,
  backupDir, receipts, resolve, now = () => new Date() }) {
  const site = await resolveScope(call, companyId, siteId);
  const dashboard = await loadDashboard(call, site, dashboardId);
  lockedStop(dashboard, allowLocked, "it");
  const url = link(profile, `/dashboards/${dashboard.id}`), rev = revision(dashboard);
  const links = await shortcutLinksTo({ call, site, dashboardId: String(dashboard.id) });
  const linkDetails = { dashboardId: String(dashboard.id), linkedFrom: links.linkedFrom, ...(links.unread.length ? { unread: links.unread } : {}) };
  if (links.linkedFrom.length && !allowLinked)
    throw new Blocked("linked", `${links.linkedFrom.length} shortcut card(s) at ${site.name} open dashboard ${dashboard.id} "${dashboard.name}": ${links.linkedFrom.map(l =>
      `"${l.displayText || l.widget}" on dashboard ${l.dashboardId} "${l.dashboard}"`).join("; ")}. They would open a missing dashboard. Point them elsewhere first (dashboards edit, shortcuts), or add --allow-linked. Nothing was written.`, linkDetails);
  if (links.unread.length && !allowLinked)
    throw new Blocked("linked", `${links.unread.length} dashboard(s) at ${site.name} could not be read, so their shortcut cards were not checked (${links.unread.map(u => u.dashboardId).join(", ")}). Try again, or add --allow-linked. Nothing was written.`, linkDetails);
  const preview = { kind: "dashboard-delete-preview", profile, url, revision: rev,
    dashboard: { id: String(dashboard.id), name: dashboard.name, site: { id: site.id, name: site.name }, isShared: dashboard.isShared ?? null, isLocked: dashboard.isLocked ?? null,
      dataSources: (dashboard.devices ?? []).map(d => ({ id: String(d.id), name: String(d.name ?? "") })) },
    deletes: { dashboard: String(dashboard.id), widgets: (dashboard.widgets ?? []).map(brief) },
    shortcutScan: { dashboardsRead: links.scanned, linkedFrom: links.linkedFrom, ...(links.unread.length ? { unread: links.unread } : {}) },
    ...(links.linkedFrom.length || links.unread.length ? { linkWarning: links.linkedFrom.length
      ? `--allow-linked: ${links.linkedFrom.length} shortcut card(s) will open a missing dashboard after this delete.`
      : "--allow-linked: some dashboards could not be read, so their shortcut cards were not checked." } : {}),
    warning: NOT_UNDONE, notChecked: DASHBOARD_NOT_CHECKED,
    platformNote: `Dashboard deletes are admitted for plugin sign-in once ${DELETE_PLATFORM_CHANGE} is deployed; until then apply stops with not_enabled before anything is written.`,
    next: "Review what goes. To apply, run again with --apply --expected REVISION --backup-dir DIR. Nothing was written.",
    applied: false };
  if (!apply) return preview;
  assert(expected, "--expected REVISION from a reviewed preview is required with --apply");
  assert(backupDir, "--backup-dir DIR is required with --apply: the dashboard is backed up before it is deleted");
  if (expected !== rev) throw new Blocked("conflict", `Dashboard ${dashboard.id} changed since the preview. Preview again and review it; nothing was written.`, { dashboardId: String(dashboard.id) });
  let backup = null, outcome;
  const write = { kind: "dashboard", needsPlatform: true };
  try {
    outcome = await guardedWrite({
      file: receipts, resolve,
      key: fingerprint(canonical({ op: "dashboard-delete", profile, dashboardId: String(dashboard.id), expected })),
      summary: { kind: "dashboard-delete", dashboardId: String(dashboard.id), siteId: site.id, name: String(dashboard.name ?? "") },
      links: () => ({ url }),
      precheck: guardAndBackUp({ call, dashboardId: String(dashboard.id), rev: expected, backupDir, label: "delete", profile, now, onBackup: file => { backup = file; } }),
      run: async progress => {
        let failure = null;
        try { await call("DELETE", `/dashboards/${dashboard.id}`); } catch (error) {
          if (definiteFailure(error)) {
            if (notEnabled(write, error))
              throw new Blocked("not_enabled", `Dashboards cannot be deleted with plugin sign-in until ${DELETE_PLATFORM_CHANGE} is deployed, or this user cannot change dashboard ${dashboard.id} (${errorText(error)}). Nothing was changed.`,
                { platformChange: DELETE_PLATFORM_CHANGE, status: error.status, ...(backup ? { backup } : {}) });
            throw error;
          }
          failure = error;
        }
        let state = null, readBack = null;
        try { state = await dashboardGone(call, site, String(dashboard.id)); } catch (error) { readBack = `Read-back failed (${errorText(error)})`; }
        // An unknown outcome with the dashboard still there stays an uncertain receipt.
        if (failure && state && !state.gone) throw failure;
        if (state?.gone) await progress({ [`dashboard:${dashboard.id}`]: "deleted" });
        const verified = !!state?.gone;
        return { partial: !verified, receipt: { dashboardId: String(dashboard.id), ...(backup ? { backup } : {}), deleted: verified, ...(verified ? {} : { unverified: true }) },
          verified, complete: verified, ...(failure ? { answerLost: errorText(failure) } : {}),
          ...(state && !state.gone ? { mismatches: [{ target: String(dashboard.id), kind: "dashboard", diff: [{ path: "", note: state.listed ? "still in the site's dashboard list" : "still readable" }] }] } : {}),
          ...(readBack ? { readBack } : {}) };
      },
    });
  } catch (error) { throw unfinished(error, "delete"); }
  const base = { kind: "dashboard-delete", profile, dashboard: { id: String(dashboard.id), name: dashboard.name }, ...(backup ? { backup } : {}) };
  if (outcome.state === "already-done") return { ...base, state: "already-done", applied: false, receipt: outcome.receipt };
  return { ...base, applied: true, state: outcome.complete ? "deleted" : "unverified", verified: outcome.verified, complete: outcome.complete,
    ...(links.linkedFrom.length ? { brokenShortcuts: links.linkedFrom } : {}),
    ...(outcome.answerLost ? { note: `The delete's answer was lost (${outcome.answerLost}); the read-back shows the dashboard is gone.` } : {}),
    ...(outcome.mismatches ? { mismatches: outcome.mismatches } : {}), ...(outcome.readBack ? { readBack: outcome.readBack } : {}),
    ...(outcome.complete ? {} : { next: `The delete was sent but the read-back did not confirm that dashboard ${dashboard.id} is gone. Check ${site.name}'s dashboards in Zira before anything else; do not run it again.` }),
    warning: NOT_UNDONE };
}

// ---- CLI (reached through dashboards.mjs) ----

export async function deleteCommand(command, o, { profile, receipts, session }) {
  const common = { profile, companyId: o["company-id"], siteId: o["site-id"], dashboardId: o["dashboard-id"], expected: o.expected, apply: !!o.apply,
    backupDir: o["backup-dir"] ? path.resolve(o["backup-dir"]) : undefined, allowLocked: !!o["allow-locked"], receipts, resolve: o["resolve-pending"] };
  if (command === "delete-widgets") {
    assert(!o["allow-linked"], "--allow-linked belongs to delete (a whole dashboard)");
    return deleteWidgets({ ...common, call: await session(profile, { allow: DELETE_WIDGET_ROUTES, maxRequests: 260 }),
      widgetIds: o["widget-ids"], widgetNames: o["widget-names"], unlink: !!o.unlink, keepLayout: !!o["keep-layout"] });
  }
  assert(command === "delete", "Choose delete-widgets or delete");
  for (const k of ["widget-ids", "widget-names", "unlink", "keep-layout"]) assert(o[k] === undefined, `--${k} belongs to delete-widgets; delete removes the whole dashboard`);
  return deleteDashboard({ ...common, call: await session(profile, { allow: DELETE_DASHBOARD_ROUTES, maxRequests: 420 }), allowLinked: !!o["allow-linked"] });
}
