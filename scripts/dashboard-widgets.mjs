#!/usr/bin/env node
// Native dashboard widget authoring. No model service, arbitrary API proxy or delete route.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Blocked, fingerprint, guardedWrite, id, isMain, link, liveSession, normalizeName, receiptsFile, resolveSite, runCli, siteDataSources } from './client.mjs';
import { describeSources, metricList } from '../skills/readings-report/scripts/store.mjs';

export const ROUTES = [
  ['GET', /^\/sites\/list$/], ['GET', /^\/devices\/list$/], ['GET', /^\/devices\/all$/],
  ['GET', /^\/dashboards\/[1-9]\d*$/], ['POST', /^\/dashboards\/[1-9]\d*\/widgets$/],
  ['PUT', /^\/dashboards\/widgets\/[1-9]\d*$/], ['PUT', /^\/dashboards\/configuration-layout\/[1-9]\d*$/],
];
export const CHARTS = { '2': 'Column', '3': 'Pie', '4': 'Bar', '5': 'TimeSeries', '6': 'KPI', '7': 'KPI Table', '10': 'Grouped KPI' };
export const DIMENSIONS = ['meter_id', 'meter_name', 'event_date', 'inherit_from_widget', 'event_date_minutes', 'event_date_5_minutes', 'event_date_15_minutes', 'event_date_hour', 'event_date_day', 'event_date_week', 'event_date_month', 'event_date_num', 'event_date_month_num', 'event_date_hour_num', 'event_date_dow', 'reading_position'];
const TYPES = { dataResearch: ['15', 'DataResearch'], header: ['6', 'Header'], filter: ['20', 'Filter'], readings: ['17', 'ReadingsNextGen'], aiSummary: ['18', 'Agent NextGen'] };
export const ANSWER_STYLES = ['Use Emojis', 'Use Table', 'Write Shortly', 'Use Bullet Points', 'Include Comparisons', 'Use Colors', 'Drill down'];
const COMMON = ['name', 'description'];
const ANALYTIC = [...COMMON, 'chartType', 'groupBy', 'aggregations', 'customAgg', 'derivedMetrics', 'filters', 'drillDown', 'flatTable', 'sortBy', 'sortDirection', 'kpiTableSort', 'limit', 'limitUnit', 'multiYAxises', 'maxYAxises', 'withGauges', 'withColors', 'fontSize', 'isFormatTime', 'pieDisplay', 'isCenterLabel', 'agentQuestion', 'gaugesRange', 'colors', 'formatTime', 'stacking', 'pieColors', 'showInLegend'];
const FIELDS = { dataResearch: ANALYTIC, header: [...COMMON, 'fontSize', 'isCenterHeader'], filter: [...COMMON, 'hideHeader', 'displayType', 'interactionMode', 'quickFilterSelectionMode', 'filtersList', 'widgetsTargetKeys'], readings: [...COMMON, 'device', 'columnsSelected', 'filters', 'isKeepEditMode'], aiSummary: [...COMMON, 'question', 'answerStyle', 'answerExample', 'fontSize', 'widgetIds', 'widgetKeys'] };
const OPS = { numeric: ['1','2','4','5','6','10','11','12'], text: ['6','10','11','12'], image: ['1','2','4','5','6','10'], list: ['1','2','4','5','6','10','11','12'], timestamp: ['1','2','4','5','6','10'], boolean: ['1','2','4','5','6','10'] };
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const fields = (x, allowed, where) => { assert(obj(x), `${where} must be an object`); for (const k of Object.keys(x)) assert(allowed.includes(k), `Unknown ${where} field: ${k}`); };
const arr = (x, where, max = 100) => { assert(Array.isArray(x) && x.length <= max, `${where} must be an array of at most ${max} items`); return x; };
const string = (x, where, max = 2000) => assert(typeof x === 'string' && x.length <= max, `${where} must be a string of at most ${max} characters`);
const choice = (x, choices, where) => assert(choices.includes(x), `Invalid ${where}: ${x}`);
const canonical = x => Array.isArray(x) ? x.map(canonical) : obj(x) ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
export const revision = dashboard => fingerprint(canonical(dashboard));

export async function context({ call, companyId, siteId, dashboardId, profile = 'prod' }) {
  assert(id(dashboardId), 'Dashboard ID required');
  const site = await resolveSite(call, companyId, siteId);
  const dashboard = (await call('GET', `/dashboards/${dashboardId}`)).data;
  if (String(dashboard?.id) !== dashboardId || String(dashboard?.site?.id ?? dashboard?.siteId) !== siteId || String(dashboard?.type?.id) !== '3')
    throw new Blocked('scope', 'The selected dashboard must be a next-generation dashboard in the selected site.');
  const inventory = new Map((await siteDataSources(call, site)).map(d => [String(d.id), d]));
  const ids = (dashboard.devices ?? []).map(d => String(d.id));
  assert(ids.length > 0 && ids.length <= 50 && ids.every(x => inventory.has(x)), 'Dashboard data sources must belong to this site (maximum 50).');
  const details = await describeSources(call, ids);
  const metrics = new Map();
  for (const deviceId of ids) {
    const device = details.get(deviceId);
    assert(device, `Missing schema for data source ${deviceId}`);
    for (const m of metricList(device).filter(m => !m.internal)) {
      const raw = device.meterSchema.metrics.find(x => String(x.metric?.id ?? x.metricId) === m.id);
      const prior = metrics.get(m.id);
      metrics.set(m.id, { ...m, keyName: raw?.metric?.keyName ?? raw?.keyName ?? raw?.metric?.name ?? null, alias: `m${m.id}`, deviceIds: [...(prior?.deviceIds ?? []), deviceId], allowedValues: raw?.validationFormula?.allowedValues ?? null });
    }
  }
  return { kind: 'dashboard-widget-context', profile, site, dashboard, revision: revision(dashboard), url: link(profile, `/dashboards/${dashboardId}`), metrics: [...metrics.values()], dimensions: DIMENSIONS, chartTypes: CHARTS, supportedTypes: Object.keys(TYPES), aiSummarySources: (dashboard.widgets ?? []).filter(w => String(w.type?.id) === '15').map(w => ({ id:String(w.id), name:w.name })), answerStyles:ANSWER_STYLES };
}

function checkFilters(filters, metrics, devices) {
  for (const group of arr(filters, 'filters', 30)) {
    assert(arr(group, 'OR group', 30).length, 'An OR group cannot be empty');
    for (const f of group) {
      fields(f, ['id', 'metric', 'operator', 'filterValue', 'vlookupByLabel'], 'filter');
      assert(metrics.has(f.metric), `Unknown filter metric ${f.metric}`);
      choice(f.operator, ['1','2','3','4','5','6','7','8','9','10','11','12','100','101','102','103','104','110','201','202'], 'filter operator');
      string(f.filterValue, 'filterValue');
      if (f.metric === 'meter_id') {
        assert(['1','6','7','8'].includes(f.operator), 'meter_id requires equality or membership');
        const values = f.filterValue.split(',').map(s => s.trim());
        assert(values.length && values.every(v => devices.has(v)), 'A meter_id filter references a source outside this dashboard');
      }
    }
  }
}
function checkExpression(exp, allowed, where, calculated = false) {
  string(exp, where, 2000); assert(exp.trim(), `${where} is empty`);
  // Expressions stay mathJS data, never executed by this helper. Reject assignments, access,
  // unknown symbols and forward references; runtime/browser evaluation is a separate check.
  const stripped = exp.replace(/'[^']*'|"[^"]*"/g, '').replace(/\b\d+(?:\.\d+)?[eE][+-]?\d+\b/g, '0');
  assert(!/[;{}]|(?<![<>=!])=(?!=)|[A-Za-z_]\w*\s*[.]/.test(stripped), `Unsupported ${where} syntax`);
  const helpers = new Set(['text','round','floor','ceil','abs','min','max','sqrt','pow','log','exp','and','or','not','true','false','null']);
  if (!calculated) for (const helper of ['snap','snapLabel','nearest','correct','roundTo','clamp']) helpers.add(helper);
  if (calculated) for (const helper of ['sum','mean','median','count','std','variance','gt','coalesce','safeNum','safeDivide','benchmark','linearRegression','linearRegressionSlope','lr','kpiDefault','datesDiff','datesDiffNum','formatDuration','formatDate','formatNumberToDuration','now','acc','accumulate','avgLine','syncZeros','downtimeCalc','timeToNow','sortedSlice','IN','t','interval','dashboardFromDate','dashboardToDate']) helpers.add(helper);
  for (const word of stripped.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []) assert(allowed.has(word) || helpers.has(word) || calculated && /^(multi_|acc_)/.test(word) && allowed.has(word.replace(/^(multi_|acc_)/,'')), `Unknown symbol ${word} in ${where}`);
}
function series(s, prefix, ids) {
  assert(new RegExp(`^${prefix}_?[a-fA-F0-9]{8}$`).test(s.id) && !ids.has(s.id), `Invalid or duplicate series id ${s.id}`);
  ids.add(s.id);
  if (s.hide != null) choice(s.hide, ['on','hide','off'], 'series visibility');
  if (s.timeSeriesChartType != null) choice(s.timeSeriesChartType, ['2','5'], 'series chart type');
  if (s.yAxis != null) assert(Number.isInteger(s.yAxis) && s.yAxis >= 0 && s.yAxis <= 10, 'Invalid yAxis');
  if (s.color != null) assert(/^#[0-9a-f]{6}$/i.test(s.color), 'Series color must be a hex color');
}
export function validateSpec(spec, ctx) {
  fields(spec, ['version','widgets'], 'spec'); assert(spec.version === 1, 'Spec version must be 1');
  const widgets = arr(spec.widgets, 'widgets', 20); assert(widgets.length, 'Choose at least one widget');
  const keys = new Set(), targets = new Set(), names = new Set();
  const devices = new Set(ctx.dashboard.devices.map(d => String(d.id)));
  const base = new Map(ctx.metrics.map(m => [m.id, m]));
  for (const dim of [...DIMENSIONS, 'time']) base.set(dim, { dataType: dim === 'meter_name' ? 'text' : 'numeric' });
  const normalized = structuredClone(widgets);
  for (const w of normalized) {
    fields(w, ['key','type','settings','widgetId','layout'], 'widget');
    assert(typeof w.key === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(w.key) && !keys.has(w.key), 'Each widget needs a unique stable key'); keys.add(w.key);
    if (w.layout != null) fields(w.layout, ['lg','md','sm','xs'], 'layout breakpoints');
    choice(w.type, Object.keys(TYPES), 'widget type'); fields(w.settings, FIELDS[w.type], `${w.type} settings`);
    const s = w.settings;
    string(s.name, 'name', 120); assert(s.name.trim(), 'Widget name is required');
    if (s.description != null) string(s.description, 'description', 4000);
    assert(!names.has(normalizeName(s.name)), 'Widget names in a draft must be distinct'); names.add(normalizeName(s.name));
    if (w.widgetId != null) {
      assert(id(w.widgetId) && !targets.has(w.widgetId), 'Duplicate or invalid update target'); targets.add(w.widgetId);
      const old = ctx.dashboard.widgets?.find(x => String(x.id) === w.widgetId);
      assert(old && String(old.type?.id) === TYPES[w.type][0], 'Update target must belong to this dashboard and retain its type');
    } else assert(!(ctx.dashboard.widgets ?? []).some(x => normalizeName(x.name) === normalizeName(s.name)), `Widget name already exists: ${s.name}`);
    const metrics = new Map(base);
    if (w.type === 'aiSummary') {
      string(s.question, 'AI summary question', 16000); assert(s.question.trim(), 'AI summary question is required');
      s.answerStyle ??= []; s.answerExample ??= ''; s.fontSize ??= 1; s.widgetIds ??= []; s.widgetKeys ??= [];
      assert(arr(s.answerStyle, 'answerStyle', ANSWER_STYLES.length).every(v => ANSWER_STYLES.includes(v)) && new Set(s.answerStyle).size === s.answerStyle.length, 'Invalid or duplicate answerStyle');
      string(s.answerExample, 'answerExample', 32000);
      assert(Number.isFinite(s.fontSize) && s.fontSize >= 0.5 && s.fontSize <= 3 && Math.abs(s.fontSize * 10 - Math.round(s.fontSize * 10)) < 1e-8, 'AI summary fontSize must be 0.5–3 in steps of 0.1');
      arr(s.widgetIds, 'AI summary widgetIds'); arr(s.widgetKeys, 'AI summary widgetKeys');
      assert(s.widgetIds.length + s.widgetKeys.length > 0 && s.widgetIds.length + s.widgetKeys.length <= 100, 'Choose 1–100 AI summary source widgets');
      assert(new Set(s.widgetIds).size === s.widgetIds.length && new Set(s.widgetKeys).size === s.widgetKeys.length, 'Duplicate AI summary source');
      for (const wid of s.widgetIds) assert(id(wid) && ctx.dashboard.widgets?.some(x => String(x.id) === wid && String(x.type?.id) === '15'), 'AI summary sources must be analytical widgets in this dashboard');
    }
    if (w.type === 'dataResearch') {
      choice(s.chartType, Object.keys(CHARTS), 'chartType');
      s.derivedMetrics ??= []; s.customAgg ??= []; s.groupBy ??= []; s.filters ??= [];
      const allowed = new Set(ctx.metrics.flatMap(m => [m.alias, m.keyName].filter(Boolean)));
      for (const d of arr(s.derivedMetrics, 'derivedMetrics', 30)) {
        fields(d, ['id','name','exp','dataType'], 'derived field');
        assert(/^D_?[a-fA-F0-9]{8}$/.test(d.id) && !metrics.has(d.id), 'Invalid or duplicate derived field id');
        choice(d.dataType, ['text','numeric'], 'derived dataType'); string(d.name, 'derived name', 120);
        checkExpression(d.exp, allowed, 'derived expression'); metrics.set(d.id, d);
      }
      assert(arr(s.groupBy, 'groupBy', 2).every(g => metrics.has(g)), 'Unknown grouping metric');
      assert(s.chartType !== '6' || !s.groupBy.length, 'KPI must have no grouping');
      assert(s.chartType !== '10' || s.groupBy.length === 1, 'Grouped KPI requires one grouping');
      const ids = new Set();
      assert(arr(s.aggregations, 'aggregations', 30).length, 'At least one base aggregation is required');
      for (const a of s.aggregations) {
        fields(a, ['id','metric','operator','name','label','defaultName','color','timeSeriesChartType','hide','yAxis','filters'], 'aggregation');
        assert(metrics.has(a.metric), `Unknown aggregation metric ${a.metric}`);
        choice(a.operator, OPS[metrics.get(a.metric).dataType] ?? OPS.numeric, 'aggregation operator');
        if (a.label != null) { assert(a.name == null || a.name === a.label, 'Use one aggregation name'); a.name = a.label; delete a.label; }
        if (a.name != null) string(a.name, 'aggregation name', 120);
        if (a.timeSeriesChartType != null) assert(['2','5'].includes(s.chartType), 'Series chart overrides are only for column/time-series widgets');
        series(a, 'A', ids); a.filters ??= []; checkFilters(a.filters, metrics, devices);
      }
      for (const c of arr(s.customAgg, 'customAgg', 30)) {
        fields(c, ['id','name','exp','displayExp','color','hide','timeSeriesChartType','yAxis','filters'], 'custom aggregation');
        if (c.timeSeriesChartType != null) assert(['2','5'].includes(s.chartType), 'Series chart overrides are only for column/time-series widgets');
        checkExpression(c.exp, ids, 'custom expression', true); assert(c.exp === c.displayExp, 'displayExp must equal exp'); series(c, 'C', ids);
        if (c.filters) checkFilters(c.filters, metrics, devices);
      }
      for (const [key, values] of Object.entries({ sortBy:['0','1','2'], sortDirection:['1','2'], limitUnit:['1','2'], stacking:['0','1','2','3'] })) if (s[key] != null) choice(s[key], values, key);
      for (const key of ['drillDown','flatTable','multiYAxises','withGauges','withColors','isFormatTime','isCenterLabel','showInLegend']) if (s[key] != null) assert(typeof s[key] === 'boolean', `${key} must be boolean`);
      for (const key of ['limit','fontSize','maxYAxises']) if (s[key] != null) assert(Number.isFinite(s[key]) && s[key] >= 0, `${key} must be a nonnegative number`);
      if (s.drillDown) assert(s.groupBy.length === 2, 'Drilldown needs two grouping dimensions');
      if (s.pieDisplay) assert(arr(s.pieDisplay, 'pieDisplay', 2).every(v => ['value','percentage'].includes(v)), 'Invalid pieDisplay');
      if (s.formatTime) { fields(s.formatTime, ['measured','display'], 'formatTime'); choice(s.formatTime.measured,['days','hours','minutes','seconds'],'measured duration'); choice(s.formatTime.display,['days','hours','minutes','formatted'],'display duration'); }
      if (s.pieColors) assert(arr(s.pieColors,'pieColors',100).every(c => /^#[0-9a-f]{6}$/i.test(c)), 'Invalid pie palette');
      if (s.colors) { fields(s.colors,['low','medium','high'],'colors'); for(const band of Object.values(s.colors)) { fields(band,['from','to','color'],'color range'); if(Object.keys(band).length) assert(Number.isFinite(Number(band.from)) && Number(band.to) >= Number(band.from) && /^#[0-9a-f]{6}$/i.test(band.color),'Invalid color range'); } }
      if (s.gaugesRange) assert(Number.isFinite(s.gaugesRange.min) && s.gaugesRange.max > s.gaugesRange.min, 'Invalid gauge range');
      checkFilters(s.filters, metrics, devices);
    }
    if (w.type === 'readings') {
      assert(devices.has(s.device), 'Readings device must belong to dashboard');
      assert(arr(s.columnsSelected, 'columnsSelected').every(c => c === 'time' || ctx.metrics.some(m => m.id === c && m.deviceIds.includes(s.device))), 'Unknown reading column for device');
      assert(s.isKeepEditMode !== true, 'Dashboard authoring does not enable reading edit mode');
      s.filters ??= []; checkFilters(s.filters, metrics, devices);
    }
    if (w.type === 'filter') {
      choice(s.displayType ?? 'toggles', ['toggles','dropdown','radio'], 'filter displayType');
      choice(s.interactionMode ?? 'inline', ['inline','quick-filter','mixed'], 'filter interactionMode');
      choice(s.quickFilterSelectionMode ?? 'single', ['single','multiple'], 'filter selection mode');
      for (const f of arr(s.filtersList, 'filtersList', 30)) {
        fields(f, ['id','name','isActive','isDefaultActive','isHideValue','interactionMode','filters'], 'filter choice'); string(f.id, 'filter id', 80); string(f.name, 'filter name', 120);
        if (f.isActive != null) assert(typeof f.isActive === 'boolean', 'Filter isActive must be boolean');
        if (f.isDefaultActive != null) assert(typeof f.isDefaultActive === 'boolean', 'isDefaultActive must be boolean');
        if (f.interactionMode != null) choice(f.interactionMode, ['inline','quick-filter'], 'filter item interactionMode'); checkFilters(f.filters, metrics, devices);
      }
      assert(arr(s.widgetsTargetKeys, 'filter targets').length, 'Choose filter targets');
    }
    if (w.type === 'header') {
      if (s.fontSize != null) assert([1,2,3].includes(s.fontSize), 'Invalid header fontSize');
      if (s.isCenterHeader != null) assert(typeof s.isCenterHeader === 'boolean', 'isCenterHeader must be boolean');
    }
  }
  for (const w of normalized.filter(w => w.type === 'filter')) for (const key of w.settings.widgetsTargetKeys) {
    const target = normalized.find(x => x.key === key);
    assert(target && ['dataResearch','readings'].includes(target.type), `Unknown/non-data filter target ${key}`);
  }
  for (const w of normalized.filter(w => w.type === 'aiSummary')) for (const key of w.settings.widgetKeys) {
    const target = normalized.find(x => x.key === key);
    assert(target?.type === 'dataResearch', `Unknown/non-analytical AI summary source ${key}`);
    assert(!target.widgetId || !w.settings.widgetIds.includes(target.widgetId), 'Duplicate AI summary source through widgetIds and widgetKeys');
  }
  return normalized;
}

export function payload(w, ctx, mapping = {}) {
  const s = structuredClone(w.settings), [typeId, typeName] = TYPES[w.type];
  const old = w.widgetId ? ctx.dashboard.widgets.find(x => String(x.id) === w.widgetId) : null;
  const base = { name: s.name, description: s.description ?? '', type: { id: typeId, name: typeName }, overrideDisplayRange: old?.overrideDisplayRange ?? null, overrideDisplayInterval: old?.overrideDisplayInterval ?? null, ...(old?.displayRangeOffset != null ? {displayRangeOffset:old.displayRangeOffset} : {}) };
  if (w.type === 'header') return { ...base, components: [], uiSettings: { fontSize: s.fontSize ?? 1, isCenterHeader: s.isCenterHeader ?? false, description: s.description ?? '' } };
  let component = w.type === 'dataResearch' ? { id: s.chartType, name: CHARTS[s.chartType] } : w.type === 'aiSummary' ? { id:'16', name:'List' } : { id: w.type === 'filter' ? '10' : '8', name: w.type === 'filter' ? 'Filter' : 'Forms' };
  if (w.type === 'filter') {
    s.widgetsList = s.widgetsTargetKeys.map(key => { assert(mapping[key], `Unresolved widget ${key}`); return mapping[key]; }); delete s.widgetsTargetKeys;
  }
  if (w.type === 'readings') s.chartType = '17';
  const argument = { type: w.type === 'readings' ? { id: '10', name: 'Filter' } : component, placementIndex: 1, overrideDisplayRange: null, overrideDisplayInterval: null, nextGenWidgetSettings: s, filters: s, func: null };
  if (w.type === 'aiSummary') {
    s.widgetIds = [...s.widgetIds, ...s.widgetKeys.map(key => { assert(mapping[key], `Unresolved widget ${key}`); return mapping[key].id; })];
    delete s.widgetKeys; delete s.name;
    s.description ??= '';
    // AgentNextGen reads filters, not nextGenWidgetSettings. Do not create a legacy agent record.
    delete argument.nextGenWidgetSettings;
    delete base.description;
  }
  // Use the scoped source, never the web helper's historical hardcoded device id.
  if (w.type === 'readings') argument.filters = { deviceId:s.device, columnsSelected:s.columnsSelected, isKeepEditMode:s.isKeepEditMode ?? false, filters:s.filters };
  if (w.type === 'dataResearch') argument.device = { id: String(ctx.dashboard.devices[0].id) };
  const previous = old?.components?.[0], previousArg = previous?.arguments?.[0];
  if (previousArg) for (const k of ['overrideDisplayRange','overrideDisplayInterval','displayRangeOffset']) if (previousArg[k] !== undefined) argument[k] = previousArg[k];
  return { ...base, components: [{ type: component, placementIndex: 1, overrideDisplayRange: previous?.overrideDisplayRange ?? null, overrideDisplayInterval: previous?.overrideDisplayInterval ?? null, arguments: [argument] }] };
}

export function layoutFor(widgets, dashboard, mapping) {
  const result = structuredClone(dashboard.configurationLayout ?? {});
  for (const [bp, cols] of Object.entries({ lg:12, md:12, sm:6, xs:2 })) {
    const rows = result[bp] ??= [];
    let y = Math.max(0, ...rows.map(r => r.y + r.h)), x = 0, rowHeight = 0;
    for (const w of widgets) {
      const wid = mapping[w.key].id;
      if (w.widgetId && !w.layout?.[bp]) continue;
      const oldIndex = rows.findIndex(r => r.i === wid);
      let box = w.layout?.[bp];
      if (!box) {
        const kpi = w.type === 'dataResearch' && w.settings.chartType === '6';
        const width = Math.min(cols, w.type === 'header' ? cols : kpi ? 3 : 6), height = ['header','filter'].includes(w.type) ? 2 : kpi ? 4 : 7;
        if (x + width > cols) { y += rowHeight; x = 0; rowHeight = 0; }
        box = { x, y, w:width, h:height }; x += width; rowHeight = Math.max(rowHeight, height);
      }
      fields(box, ['x','y','w','h'], 'layout');
      assert(['x','y','w','h'].every(k => Number.isInteger(box[k])) && box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 && box.x + box.w <= cols, `Invalid layout at ${bp}`);
      const item = { i: wid, ...box };
      assert(!rows.some((r, n) => n !== oldIndex && item.x < r.x + r.w && item.x + item.w > r.x && item.y < r.y + r.h && item.y + item.h > r.y), `Layout overlap at ${bp}`);
      if (oldIndex >= 0) rows[oldIndex] = item; else rows.push(item);
    }
  }
  return result;
}
function subset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v,i) => subset(actual[i],v));
  if (obj(expected)) return obj(actual) && Object.entries(expected).every(([k,v]) => subset(actual[k],v));
  return actual === expected;
}
// Enum labels and inherited-range null envelopes are expanded by the API. Verify the
// authored semantic fields, not response-only labels/audit metadata or the legacy UI copy.
export function verifyWidget(actual, expected) {
  if (!actual || actual.name !== expected.name || String(actual.type?.id) !== expected.type.id) return false;
  if (expected.type.id === '6') return subset(actual.uiSettings, expected.uiSettings);
  if (expected.type.id !== '18' && actual.description !== expected.description && (actual.description ?? '') !== (expected.description ?? '')) return false;
  const a = actual.components, e = expected.components;
  return Array.isArray(a) && a.length === e.length && e.every((c,i) => String(a[i].type?.id) === c.type.id &&
    a[i].arguments?.length === c.arguments.length && c.arguments.every((arg,j) =>
      String(a[i].arguments[j].type?.id) === arg.type.id && (expected.type.id === '18'
        ? subset(a[i].arguments[j].filters, arg.filters)
        : subset(a[i].arguments[j].nextGenWidgetSettings, arg.nextGenWidgetSettings))));
}
export async function author({ call, companyId, siteId, dashboardId, profile = 'prod', spec, expected, apply = false, receipts }) {
  const ctx = await context({ call, companyId, siteId, dashboardId, profile });
  // Exact successful retries are returned before revalidating names/revisions against post-write state.
  const key = fingerprint(canonical({ op:'dashboard-widgets', profile, companyId, siteId, dashboardId, spec, expected }));
  if (apply) {
    const stored = await readFile(receipts, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stored?.actions?.[key]?.state === 'done') return { state:'already-done', applied:false, url:ctx.url, receipt:stored.actions[key] };
    if (['pending','partial'].includes(stored?.actions?.[key]?.state)) throw new Blocked('uncertain_write', 'An earlier attempt is pending or partial. Inspect its receipt and dashboard; do not replay the batch.', { receipt: stored.actions[key], url:ctx.url });
  }
  if (expected && expected !== ctx.revision) throw new Blocked('conflict', 'Dashboard changed since the preview. Read context and review a fresh preview.');
  const widgets = validateSpec(spec, ctx);
  const mapping = Object.fromEntries(widgets.map(w => [w.key, { id:w.widgetId ?? w.key, name:w.settings.name }]));
  const planned = widgets.map(w => ({ key:w.key, action:w.widgetId ? 'update' : 'create', widgetId:w.widgetId, payload:payload(w, ctx, mapping) }));
  const plannedLayout = layoutFor(widgets, ctx.dashboard, mapping);
  const preview = { kind:'dashboard-widgets-preview', url:ctx.url, revision:ctx.revision, widgets:planned, configurationLayout:plannedLayout, notifications:false, applied:false };
  if (!apply) return preview;
  assert(expected, '--expected REVISION from a reviewed preview is required with --apply');
  const outcome = await guardedWrite({ file:receipts, key, summary:{ kind:'dashboard-widgets', dashboardId, siteId, widgetCount:widgets.length }, links:() => ({ url:ctx.url }),
    precheck: async () => {
      const latest = (await call('GET', `/dashboards/${dashboardId}`)).data;
      if (revision(latest) !== expected) throw new Blocked('conflict', 'Dashboard changed before saving; nothing written.');
    },
    run: async progress => {
      const savedPayloads = [];
      const dependent = w => ['filter','aiSummary'].includes(w.type);
      for (const w of [...widgets].sort((a,b) => Number(dependent(a)) - Number(dependent(b)))) {
        const body = payload(w, ctx, mapping);
        const response = await call(w.widgetId ? 'PUT' : 'POST', w.widgetId ? `/dashboards/widgets/${w.widgetId}` : `/dashboards/${dashboardId}/widgets`, body);
        const value = response?.data;
        const wid = w.widgetId ?? String(obj(value) ? value.id ?? value.widgetId ?? '' : value ?? '');
        assert(id(wid), `Save ${w.key} returned no widget ID; stop and inspect dashboard`);
        mapping[w.key] = { id:wid, name:w.settings.name };
        await progress({ [w.key]:wid }); savedPayloads.push({ id:wid, body });
      }
      const configurationLayout = layoutFor(widgets, ctx.dashboard, mapping);
      await call('PUT', `/dashboards/configuration-layout/${dashboardId}`, { configurationLayout });
      let saved;
      try { saved = (await call('GET', `/dashboards/${dashboardId}`)).data; } catch (error) { return { verified:false, readBack:error.message, receipt:{ dashboardId, mapping } }; }
      const mismatches = savedPayloads.filter(p => !verifyWidget(saved?.widgets?.find(w => String(w.id) === p.id), p.body)).map(p => p.id);
      const layoutVerified = Object.entries(configurationLayout).every(([bp, rows]) => rows.every(r => (saved?.configurationLayout?.[bp] ?? []).some(a => subset(a, r))));
      return { verified:!mismatches.length && layoutVerified, mismatches, layoutVerified, receipt:{ dashboardId, mapping }, mapping };
    },
  });
  return { kind:'dashboard-widgets', ...outcome, state:outcome.state === 'created' ? outcome.verified ? 'created' : 'unverified' : outcome.state, applied:outcome.state === 'created', url:ctx.url, note:'Saved configuration read-back is separate from data/render verification. Open the dashboard and compare values with scoped readings.' };
}

const HELP = `Native Zira widgets — preview by default; no deletion or device changes.
context --company-id ID --site-id ID --dashboard-id ID [--out FILE]
save --company-id ID --site-id ID --dashboard-id ID --spec FILE
  [--apply --expected REVISION] [--receipts FILE]
Common: --profile prod|integ
Spec: {version:1, widgets:[{key,type,settings,widgetId?,layout?}]}.
Types: dataResearch (KPI/grouped KPI/table/column/bar/pie/time series), header, filter, readings, aiSummary.
aiSummary stores a question and selected analytical widgets; it does not run AI or schedule reports.
context reads metric schemas and saved widgets; save validates and previews exact payload/layout.
--apply saves once with receipt and read-back. Partial/unknown writes stop; never replay a batch.
JSON stdout; errors stderr. Exit 0 success, 2 invalid/failed, 3 unverified, 4 blocked.
`;
async function main() {
  const { values:o, positionals:[command] } = parseArgs({ allowPositionals:true, options:{
    'company-id':{type:'string'}, 'site-id':{type:'string'}, 'dashboard-id':{type:'string'}, profile:{type:'string',default:'prod'}, out:{type:'string'}, spec:{type:'string'}, apply:{type:'boolean'}, expected:{type:'string'}, receipts:{type:'string'},
  } });
  if (!command || command === 'help') { console.log(HELP); return; }
  assert(['context','save'].includes(command), 'Unknown command');
  const options = { call:await liveSession(o.profile, { allow:ROUTES, maxRequests:80 }), profile:o.profile, companyId:o['company-id'], siteId:o['site-id'], dashboardId:o['dashboard-id'] };
  let result;
  if (command === 'context') result = await context(options);
  else {
    assert(o.spec, '--spec required'); const raw = await readFile(o.spec, 'utf8'); assert(raw.length <= 256*1024, 'Spec exceeds 256 KiB');
    result = await author({ ...options, spec:JSON.parse(raw), apply:!!o.apply, expected:o.expected, receipts:receiptsFile(o.receipts) });
  }
  if (o.out) { await writeFile(o.out, JSON.stringify(result,null,2), { mode:0o600 }); return { kind:result.kind, out:o.out, revision:result.revision, url:result.url, state:result.state, applied:result.applied, verified:result.verified, complete:result.complete }; }
  return result;
}
if (isMain(import.meta)) runCli(main, { profile:() => process.argv.includes('integ') ? 'integ' : 'prod' });
