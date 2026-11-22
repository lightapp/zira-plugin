// Zira web's Embedded/Custom widget (type 19), as zira-web CreateEmbeddedCustomWidget.js buildEmbeddedWidget saves it.
// - embedded (component 9): shows another dashboard's Data Research widget live, from any site of the company.
// - custom (component 8): a local Data Research chart on data sources chosen from any site of the company.
// Both keep the web's fixed placeholder source on the argument. Platform admission (assistantAccess widgetScope.ts
// validateEmbedded) checks the same company and caller visibility again before the write.
import { id } from './client.mjs';
import { describeSources, metricList } from '../skills/readings-report/scripts/store.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const EMBEDDED_TYPE = ['19', 'EmbeddedCustomWidget'];
export const PLACEHOLDER_SOURCE = { id: '21267' };
export const MODES = { embedded: { id: '9', name: 'Embedded External' }, custom: { id: '8', name: 'Embedded Local' } };
// Zira web's shared data-research chartTypes `dataResearch-<name>` for each Data Research chart.
export const SUBTYPES = { '2': 'column', '3': 'pie', '4': 'bar', '5': 'line', '6': 'kpi', '7': 'kpi-table', '10': 'kpi-group' };
export const EMBEDDED_FIELDS = ['dashboardId', 'sourceWidgetId'];
export const CUSTOM_FIELDS = ['devices'];
export const MAX_CUSTOM_SOURCES = 100;
export const EMBEDDED_PLATFORM_CHANGE = "Zira's plugin access update for company-level dashboards (Embedded and Custom widgets)";

export const companyOf = ctx => String(ctx.dashboard.companyId ?? ctx.site?.companyId ?? '');
export const modeOf = widget => String(widget?.components?.[0]?.type?.id ?? '');

// Metric descriptions for a set of data sources, keyed by metric ID, as context() builds them for the dashboard's own.
export function metricsOf(ids, details) {
  const metrics = new Map();
  for (const deviceId of ids) {
    const device = details.get(deviceId);
    assert(device, `Missing schema for data source ${deviceId}`);
    for (const m of metricList(device).filter(m => !m.internal)) {
      const raw = device.meterSchema.metrics.find(x => String(x.metric?.id ?? x.metricId) === m.id);
      const prior = metrics.get(m.id);
      metrics.set(m.id, { ...m, keyName: raw?.metric?.keyName ?? raw?.keyName ?? raw?.metric?.name ?? null, alias: `m${m.id}`, deviceIds: [...(prior?.deviceIds ?? []), deviceId],
        allowedValues: raw?.validationFormula?.allowedValues ?? null, vlookupConfigs: { ...prior?.vlookupConfigs, [deviceId]: raw?.validationFormula?.vlookupConfig ?? null } });
    }
  }
  return [...metrics.values()];
}

// Reads every dashboard and data source the batch's embedded/custom widgets name, and checks that each one is
// readable, not deleted and in the edited dashboard's company. Sets ctx.embedded = { dashboards, sources }.
export async function resolveReferences(call, ctx, widgets) {
  const company = companyOf(ctx);
  const dashboards = new Map(), sources = new Map();
  const embedded = widgets.filter(w => w?.type === 'embedded'), custom = widgets.filter(w => w?.type === 'custom');
  const dashboardIds = [...new Set(embedded.map(w => String(w.settings?.dashboardId ?? '')))];
  const sourceIds = [...new Set(custom.flatMap(w => (Array.isArray(w.settings?.devices) ? w.settings.devices : []).map(String)))];
  assert(dashboardIds.length <= 20 && dashboardIds.every(id), 'Embedded widgets need valid dashboardId values (at most 20 dashboards per batch)');
  assert(sourceIds.length <= MAX_CUSTOM_SOURCES * 2 && sourceIds.every(id), 'Custom widgets need valid data source IDs');
  if ((dashboardIds.length || sourceIds.length) && !company) throw new Error('The dashboard has no company; embedded and custom widgets cannot be checked');
  for (const did of dashboardIds) {
    assert(did !== String(ctx.dashboard.id), 'An embedded widget cannot show a widget of the same dashboard');
    const d = (await call('GET', `/dashboards/${did}`)).data;
    assert(String(d?.id) === did && !d.isDeleted, `Dashboard ${did} is not readable`);
    assert(['2', '3'].includes(String(d.type?.id)), `Dashboard ${did} is not a dashboard Zira can embed from`);
    assert(String(d.companyId ?? '') === company, `Dashboard ${did} belongs to another company`);
    const siteId = d.site?.id ?? d.siteId;
    // A company-level source dashboard has no site; the saved reference then names none.
    dashboards.set(did, { id: did, name: d.name, site: siteId == null ? null : { id: String(siteId), name: d.site?.name ?? null },
      widgets: (d.widgets ?? []).map(w => ({ id: String(w.id), name: w.name, type: String(w.type?.id) })) });
  }
  const details = sourceIds.length ? await describeSources(call, sourceIds) : new Map();
  for (const sid of sourceIds) {
    const d = details.get(sid);
    assert(d && !d.isDeleted, `Data source ${sid} is not readable`);
    assert(String(d.companyId ?? '') === company, `Data source ${sid} belongs to another company`);
    sources.set(sid, { id: sid, name: d.name, site: { id: String(d.site?.id ?? ''), name: d.site?.name ?? null } });
  }
  ctx.embedded = { dashboards, sources, details };
  return ctx.embedded;
}

export function checkEmbedded(s) {
  assert(id(String(s.dashboardId ?? '')) && id(String(s.sourceWidgetId ?? '')), 'Embedded widgets need dashboardId and sourceWidgetId');
}
// The source widget must be a Data Research widget of the referenced dashboard.
export function embeddedTarget(s, ctx) {
  const ref = ctx.embedded?.dashboards.get(String(s.dashboardId));
  assert(ref, `Dashboard ${s.dashboardId} was not resolved`);
  const source = ref.widgets.find(w => w.id === String(s.sourceWidgetId));
  assert(source?.type === '15', `Widget ${s.sourceWidgetId} is not a Data Research widget of dashboard ${s.dashboardId}`);
  return { ref, source };
}
// A custom widget's own data sources and their metrics, for the shared Data Research checks.
export function customScope(s, ctx) {
  const devices = s.devices;
  assert(Array.isArray(devices) && devices.length > 0 && devices.length <= MAX_CUSTOM_SOURCES, `Custom widgets need 1–${MAX_CUSTOM_SOURCES} data sources`);
  assert(devices.every(d => typeof d === 'string' && id(d)) && new Set(devices).size === devices.length, 'Custom widget devices must be distinct data source IDs (strings)');
  return { devices: new Set(devices), metrics: metricsOf(devices, ctx.embedded.details) };
}

// Exact save body. Updates keep the widget's own saved time span when it uses one (timeSpanType 'custom').
export function embeddedPayload(w, ctx, base, old) {
  const s = w.settings, mode = MODES[w.type];
  const previous = old?.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings;
  const time = previous?.timeSpanType === 'custom' && previous.timeSpan ? { timeSpanType: 'custom', timeSpan: structuredClone(previous.timeSpan) } : { timeSpanType: 'default' };
  let settings;
  if (w.type === 'embedded') {
    const { ref, source } = embeddedTarget(s, ctx);
    settings = { name: s.name, ...(ref.site ? { site: ref.site } : {}), dashboard: { id: ref.id, name: ref.name }, widget: { id: source.id, name: source.name }, filters: [], chartType: mode.id, ...time };
  } else {
    const { name, description, devices, ...chart } = structuredClone(s);
    settings = { devices: devices.map(d => ({ id: d, name: ctx.embedded.sources.get(d)?.name ?? null })), filters: [], chartType: mode.id,
      chartSubTypeName: SUBTYPES[chart.chartType], ...time, embeddedWidgetConfig: { name, ...(description ? { description } : {}), ...chart } };
  }
  const argument = { type: mode, placementIndex: 1, overrideDisplayRange: null, overrideDisplayInterval: null, device: { ...PLACEHOLDER_SOURCE }, nextGenWidgetSettings: settings, func: null };
  return { ...base, type: { id: EMBEDDED_TYPE[0], name: EMBEDDED_TYPE[1] },
    components: [{ type: mode, placementIndex: 1, overrideDisplayRange: null, overrideDisplayInterval: null, arguments: [argument] }] };
}
