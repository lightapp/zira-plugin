// Native persisted contracts from zira-web IndicatorWidget/utils.js and ShortcutWidget/utils.ts.
// Historical last-reading indicators use filters, NOT LiveData nextGenWidgetSettings.
import { id } from './client.mjs';
const assert = (ok,message) => { if (!ok) throw new Error(message); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const fields = (x,allowed,where) => { assert(object(x),`${where} must be an object`); for (const k of Object.keys(x)) assert(allowed.includes(k),`Unknown ${where} field: ${k}`); };
const text = (x,max,where) => assert(typeof x === 'string' && x.length <= max,`Invalid ${where}`);
const list = (x,max,where) => { assert(Array.isArray(x) && x.length <= max,`Invalid ${where}`); return x; };
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k,canonical(x[k])])) : x;
const BOOLEANS = ['withMetricName','withSecondaryName','isPrimaryComma','isSecondaryComma','withTime','withSubmitter','isCenterLabel','hideHeader','displayAsTable'];
export const INDICATOR_FIELDS = ['deviceId','siteId','primaryMetric','secondaryMetric','primaryLabel','secondaryLabel','fontSize','tableMetrics','conditions','vlookupConfig','secondaryVlookupConfig',...BOOLEANS];
export const SHORTCUT_FIELDS = ['hideHeader','shortcuts'];
const CONDITION_FLAGS = ['popupAlert','isColor','isBackgroundColor','isBackgroundColorAlert','isAutoDismissAlert','popupForm','isFormCustomizeFields'];
const CONDITION_FIELDS = ['formula','color','backgroundColor','backgroundColorAlert','popupAlertTitle','autoDismissAlertSeconds','popupFormTitle','formCustomizeFields',...CONDITION_FLAGS];
const metricOperators = type => {
  const nil = ['IS NULL','IS NOT NULL'];
  if (type === 'numeric') return ['=','<>','>','<','>=','<=',...nil];
  if (type === 'boolean') return ['=',...nil];
  if (type === 'list') return ['=','<>',...nil];
  if (['text','timestamp'].includes(type)) return ['EQUALS','NOT EQUALS','CONTAINS','NOT CONTAINS','STARTS WITH','NOT STARTS WITH','ENDS WITH','NOT ENDS WITH',...nil];
  return ['FILLED',...nil];
};
export function indicatorSettings(settings,ctx,previous) {
  const {name,description,...changes} = settings;
  // Partial indicator edits retain colors, labels, table order and optional settings.
  const s = {...structuredClone(previous ?? {}),...changes};
  fields(s,INDICATOR_FIELDS,'indicator settings');
  // A company-level dashboard's indicator names its data source's own site.
  const siteId = ctx.site?.kind === 'company' ? String(ctx.sourceSites?.[s.deviceId] ?? '') : String(ctx.site?.id ?? ctx.dashboard.site?.id ?? ctx.dashboard.siteId);
  assert(s.siteId == null || s.siteId === siteId,'Indicator site must match the dashboard'); s.siteId = siteId;
  assert(id(s.deviceId) && ctx.dashboard.devices.some(d => String(d.id) === s.deviceId),'Indicator device must belong to dashboard');
  const metrics = new Map(ctx.metrics.filter(m => m.deviceIds.includes(s.deviceId)).map(m => [m.id,m]));
  const metric = value => { assert(id(value) && metrics.has(value),`Unknown indicator metric ${value} for selected device`); return metrics.get(value); };
  for (const k of BOOLEANS) if (s[k] != null) assert(typeof s[k] === 'boolean',`${k} must be boolean`);
  for (const k of ['primaryMetric','secondaryMetric']) if (s[k] != null && s[k] !== '') metric(s[k]);
  for (const k of ['primaryLabel','secondaryLabel']) if (s[k] != null) text(s[k],200,k);
  if (s.fontSize != null) assert(Number.isFinite(s.fontSize) && s.fontSize >= 0.5 && s.fontSize <= 3,'Indicator fontSize must be 0.5–3');
  if (s.tableMetrics != null) {
    const seen = new Set();
    for (const row of list(s.tableMetrics,50,'tableMetrics')) {
      if (typeof row !== 'string') { fields(row,['metricId','displayName'],'table metric'); if (row.displayName != null) text(row.displayName,200,'displayName'); }
      const mid = typeof row === 'string' ? row : row.metricId; metric(mid);
      assert(!seen.has(mid),'Duplicate indicator table metric'); seen.add(mid);
    }
  }
  assert(s.displayAsTable ? s.tableMetrics?.length : !!s.primaryMetric,'Choose an indicator primaryMetric or tableMetrics');
  // Lookup configurations are drawn from the selected metric's schema, never invented.
  for (const [key,metricKey] of [['vlookupConfig','primaryMetric'],['secondaryVlookupConfig','secondaryMetric']]) if (s[key] != null) {
    const m = metric(s[metricKey]);
    assert(JSON.stringify(canonical(s[key])) === JSON.stringify(canonical(m.vlookupConfigs?.[s.deviceId])),`Indicator ${key} must match the selected metric schema`);
    assert(ctx.dashboard.devices.some(d => String(d.id) === String(s[key].deviceId)),'Indicator lookup device must belong to dashboard');
  }
  if (s.conditions != null) for (const condition of list(s.conditions,30,'indicator conditions')) {
    fields(condition,CONDITION_FIELDS,'indicator condition');
    for (const flag of CONDITION_FLAGS) if (condition[flag] != null) assert(typeof condition[flag] === 'boolean',`${flag} must be boolean`);
    assert(!condition.popupForm && !condition.isFormCustomizeFields && condition.formCustomizeFields == null,'Indicator form popups are not supported');
    for (const key of ['color','backgroundColor','backgroundColorAlert']) if (condition[key] != null && condition[key] !== '') assert(/^#[0-9a-f]{6}$/i.test(condition[key]),`Invalid ${key}`);
    for (const key of ['popupAlertTitle','popupFormTitle']) if (condition[key] != null) text(condition[key],1000,key);
    if (condition.autoDismissAlertSeconds != null) assert(Number.isFinite(condition.autoDismissAlertSeconds) && condition.autoDismissAlertSeconds > 0 && condition.autoDismissAlertSeconds <= 3600,'Invalid alert duration');
    const rows = list(condition.formula,30,'indicator formula'); assert(rows.length,'Indicator formula is empty');
    rows.forEach((row,index) => {
      fields(row,['metric','operator','value','contact'],'indicator formula row'); fields(row.metric,['id'],'condition metric');
      const m = metric(row.metric.id);
      assert(metricOperators(m.dataType).includes(row.operator),'Invalid indicator operator for metric type');
      assert(index === rows.length-1 ? row.contact == null : ['AND','OR'].includes(row.contact),'Use AND/OR between formula rows and null on the last');
      assert(row.value == null || ['string','number','boolean'].includes(typeof row.value),'Invalid indicator comparison value');
      if (typeof row.value === 'string') text(row.value,2000,'indicator comparison value');
      if (typeof row.value === 'number') assert(Number.isFinite(row.value),'Invalid indicator comparison number');
      if (!['IS NULL','IS NOT NULL'].includes(row.operator)) assert(row.value != null && row.value !== '', 'Indicator comparison value is required');
    });
  }
  assert(Buffer.byteLength(JSON.stringify(s)) <= 64*1024,'Indicator settings exceed 64 KiB');
  return {name,...(description !== undefined ? {description} : {}),...s};
}

export function shortcutSettings(settings,ctx) {
  if (settings.hideHeader != null) assert(typeof settings.hideHeader === 'boolean','hideHeader must be boolean');
  const rows = list(settings.shortcuts,20,'shortcuts'); assert(rows.length,'Choose at least one shortcut');
  for (const row of rows) {
    fields(row,['title','description','dashboardId','url','displayModeId'],'shortcut');
    text(row.title,200,'shortcut title'); assert(row.title.trim(),'Shortcut title is required');
    if (row.description != null) text(row.description,1000,'shortcut description');
    assert((row.dashboardId != null) !== (row.url != null),'Choose exactly one shortcut dashboardId or url');
    assert(row.displayModeId == null || row.displayModeId === '1','Shortcut displayModeId must be null or 1 (new tab)');
    if (row.dashboardId != null) assert(id(row.dashboardId) && ctx.shortcutTargets?.some(d => String(d.id) === row.dashboardId),'Shortcut dashboard must be readable in the selected site');
    else {
      text(row.url,2000,'shortcut URL');
      let url; try { url = new URL(row.url); } catch { throw new Error('Invalid shortcut URL'); }
      assert(['https:','http:'].includes(url.protocol) && !url.username && !url.password,'Shortcut URLs require HTTP(S) without credentials');
    }
  }
  return settings;
}
const rangeKeys = ['overrideDisplayRange','overrideDisplayInterval','displayRangeOffset'];
const ranges = old => Object.fromEntries(rangeKeys.map(k => [k,old?.[k] ?? null]));
export function operationalPayload(w,ctx,base,old) {
  const {name:_,description:__,...s} = structuredClone(w.settings);
  if (w.type === 'indicator') {
    const c = old?.components?.[0], a = c?.arguments?.[0];
    return {...base,components:[{type:{id:'13',name:'LastReading'},placementIndex:1,...ranges(c),arguments:[{
      type:{id:'13',name:'LastReading'},placementIndex:1,...ranges(a),func:null,filters:s,
    }]}]};
  }
  return {...base,components:s.shortcuts.map((row,index) => ({type:{id:'9',name:'Shortcut'},placementIndex:index+1,...ranges(),arguments:[{
    type:{id:'11',name:'CallToAction'},placementIndex:1,...ranges(),overrideChartConfig:null,func:null,
    ...(index === 0 ? {filters:{hideHeader:s.hideHeader ?? false}} : {}),
    cta:{entityType:{id:row.dashboardId ? '19' : '6',name:row.dashboardId ? 'Dashboard' : 'Link'},entity:row.dashboardId ?? row.url,
      actionType:{id:'1',name:'Open'},displayText:row.title,displayMode:row.displayModeId ? {id:row.displayModeId} : null,
      properties:row.description ? {description:row.description} : null},
  }]}))};
}
