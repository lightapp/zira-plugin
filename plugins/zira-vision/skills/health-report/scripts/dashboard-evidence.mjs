import { id, timestamp } from "./config.mjs";

const INTERVALS = new Set(["1 minutes", "5 minutes", "15 minutes", "1 hours", "1 days", "1 weeks", "1 months"]);
const intervalAliases = { hour: "1 hours", hourly: "1 hours", day: "1 days", daily: "1 days" };
const intervalIds = { 1: "1 minutes", 2: "5 minutes", 3: "15 minutes", 4: "1 hours", 5: "1 days", 6: "1 weeks", 7: "1 months" };
const day = 86400000;

// Match the web dashboard's site offset and production-day boundary, not the host's timezone.
export function todayWindow(dashboard, now = new Date().toISOString()) {
  if (!timestamp(now) || !Number.isFinite(dashboard.offset)) return null;
  const shift = Number(dashboard.defaultDayOffset ?? 0);
  if (!Number.isFinite(shift) || shift < 0 || shift >= 1440) return null;
  const current = Date.parse(now), offset = dashboard.offset * 60000;
  let start = Math.floor((current + offset) / day) * day + shift * 60000 - offset;
  if (start > current) start -= day;
  return { from: new Date(start).toISOString(), to: new Date(current).toISOString() };
}

export async function dashboardWidgets(get, { dashboardId, companyId, siteId, now }) {
  if (!id(dashboardId) || (companyId !== undefined && !id(companyId)) || (siteId !== undefined && !id(siteId)))
    throw new Error("Valid dashboard/company/site IDs required");
  const b = await get(`/dashboards/${dashboardId}`), d = b.data ?? b;
  if (String(d.id) !== dashboardId || String(d.type?.id ?? d.dashboardType?.id) !== "3")
    throw new Error("Expected selected next-generation dashboard");
  const actualCompany = String(d.companyId ?? d.company?.id ?? "");
  const actualSite = String(d.siteId ?? d.site?.id ?? "");
  if ((companyId && companyId !== actualCompany) || (siteId && siteId !== actualSite))
    throw new Error("Dashboard outside selected company/site");
  if (d.widgets != null && !Array.isArray(d.widgets)) throw new Error("Invalid dashboard widgets response");
  return {
    dashboardId, name: String(d.name ?? ""), companyId: actualCompany, siteId: actualSite,
    timezone: d.tzTimezoneName ?? null, offsetMinutes: d.offset ?? null,
    dayStartMinutes: d.defaultDayOffset ?? 0, firstDayOfWeek: d.firstDayOfWeek ?? null,
    defaultRange: d.defaultDisplayRange ?? null, defaultInterval: d.defaultDisplayInterval ?? null,
    suggestedInterval: intervalIds[d.defaultDisplayInterval?.id] ?? null,
    today: todayWindow(d, now),
    hasDashboardFilters: !!d.dataTable?.filters?.length,
    widgets: (d.widgets ?? []).map(w => {
      const a = w.components?.[0]?.arguments?.[0], s = a?.nextGenWidgetSettings;
      return {
        id: String(w.id), name: String(w.name ?? ""), type: w.type?.name ?? null,
        queryable: String(w.type?.id) === "15" && !!s,
        description: s?.description ?? w.description ?? null,
        rangeOverride: w.overrideDisplayRange ?? a?.overrideDisplayRange ?? null,
        intervalOverride: w.overrideDisplayInterval ?? a?.overrideDisplayInterval ?? null,
        hasFilters: !!s?.filters?.length,
        formulas: (s?.customAgg ?? []).map(x => ({ name: x.name ?? null, expression: x.exp })),
      };
    }),
  };
}

const payload = b => b?.data ?? b;
const deferred = b => !!(b?.noData || b?.sqsDelay || b?.withData === false || b?.data?.noData || b?.data?.sqsDelay || b?.data?.withData === false);
function rowsOf(b) {
  const p = payload(b);
  if (deferred(b)) return [];
  if (!Array.isArray(p?.kpis) || !Array.isArray(p?.charts)) throw new Error("Invalid agent data response");
  return [...p.kpis, ...p.charts];
}

export async function agentData(get, {
  dashboardId, widgetIds, from, to, interval = "1 hours", companyId, siteId,
}) {
  if (!id(dashboardId) || !Array.isArray(widgetIds) || !widgetIds.length ||
      widgetIds.length > 20 || !widgetIds.every(id) || new Set(widgetIds).size !== widgetIds.length ||
      !timestamp(from) || !timestamp(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 7 * day)
    throw new Error("Select 1–20 distinct widget IDs and an offset timestamp window greater than zero and at most 7 days");
  interval = intervalAliases[interval] ?? interval;
  if (!INTERVALS.has(interval)) throw new Error("Unsupported interval; use e.g. '1 hours' or '1 days'");
  const dashboard = await dashboardWidgets(get, { dashboardId, companyId, siteId });
  const selected = widgetIds.map(widgetId => {
    const w = dashboard.widgets.find(w => w.id === widgetId);
    if (!w?.queryable) throw new Error(`Widget ${widgetId} is absent or not an analytics widget on this dashboard`);
    return w;
  });
  // Backend CSV filtering compares UTC date strings. Normalize offsets before stripping the suffix.
  const utc = value => new Date(value).toISOString().slice(0, 19);
  const query = new URLSearchParams({ widgetIds: widgetIds.join(","), startDate: utc(from), endDate: utc(to), interval });
  const route = `/analysis/agent-data/${dashboardId}?`;
  let b = await get(route + query), rows = rowsOf(b), calculationRetried = false;
  // The legacy handler drops withData:false and returns empty arrays when calcEnv != service.
  // One synchronous calculation is bounded by the same IDs/window; never retry thrown auth/rate/transport errors.
  if (!rows.length) {
    query.set("force", "true");
    calculationRetried = true;
    b = await get(route + query);
    rows = rowsOf(b);
  }
  // Legacy responses identify widgets by name, not ID. Duplicate names cannot establish coverage.
  const coverage = selected.map(w => {
    const unique = dashboard.widgets.filter(x => x.name === w.name).length === 1;
    const matches = rows.filter(r => r.dashboard === dashboard.name && r.widget === w.name);
    return { id: w.id, name: w.name, status: !unique || matches.length > 1 ? "ambiguous" : matches.length ? "returned" : "missing" };
  });
  const unexpectedRows = rows.filter(r => r.dashboard !== dashboard.name || !selected.some(w => w.name === r.widget)).length;
  const complete = coverage.every(w => w.status === "returned") && unexpectedRows === 0;
  return {
    dashboardId, requestedWidgetIds: widgetIds, from, to, interval, calculationRetried,
    complete, coverage, unexpectedRows,
    status: !rows.length ? "unavailable" : complete ? "available" : "partial",
    data: deferred(b) ? { kpis: [], charts: [] } : payload(b),
    warning: "Missing or ambiguous widgets are unavailable evidence, not zero production. Configuration totals are not readings. Verify source attribution and matching period/filters before comparing with the browser.",
  };
}
