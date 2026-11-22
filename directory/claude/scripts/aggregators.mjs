#!/usr/bin/env node
// Zira aggregator data sources: a data source whose readings are a database view over other data sources'
// readings, one row per source and site-local day (each source's own site time zone and day start), with
// sums/averages/counts/min/max, groupings, metadata (site, saw) and static values. Zira web's
// DeviceAggregatorConfigDialog and form editor (applying "Aggregator") do the same; no custom service is involved.
// Routes: POST /forms/new + GET /forms/{id} (create), GET /devices/aggregator/{id} (read) and POST /devices/aggregator
// (attach a source or replace its config, then regenerate the view). Sources must be in the aggregator's company.
// Zira has no detach: a source once attached stays until removed in the database.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Blocked, fingerprint, guardedWrite, id, isMain, link, liveSession, normalizeName, receiptsFile, resolveSite, runCli, siteDataSources, text } from "./client.mjs";
import { describeSources } from "../skills/readings-report/scripts/store.mjs";

export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/],
  ["POST", /^\/forms\/new$/], ["GET", /^\/forms\/[1-9]\d*$/],
  ["GET", /^\/devices\/aggregator\/[1-9]\d*$/], ["POST", /^\/devices\/aggregator$/],
];
export const AGGREGATOR_APPLYING_ID = "9";
export const FUNCTIONS = ["count", "sum", "avg", "max", "min"];
export const METADATA = ["{{siteName}}", "{{siteId}}", "{{meterName}}", "{{meterId}}"];
export const TYPES = ["aggregatedMetric", "groupedMetric", "staticMetric", "metadataMetric", "null"];
export const STATIC_MAX = 30;
export const MAX_SOURCES = 200;
export const PLATFORM_CHANGE = "Zira's plugin access update for aggregator configs (platform devices stack, GET/POST /agent/aggregator)";
const OTHER_DEVICE_TYPE = "40";
// Units the form editor saves for aggregator fields (as saved on an existing aggregator).
const KINDS = {
  number: { type: "number", uom: { id: "2600", name: "Number" }, uomCategory: { id: "26", name: "Number", dataType: { id: "1", name: "numeric" } } },
  text: { type: "string", uom: { id: "2000", name: "Text" }, uomCategory: { id: "20", name: "Text", dataType: { id: "4", name: "text" } } },
  list: { type: "string", uom: { id: "3200", name: "List" }, uomCategory: { id: "32", name: "List", dataType: { id: "7", name: "list" } } },
};
// Units with their category and data type, as Zira web's form editor stores them (from its enumerations).
const UOMS = JSON.parse(await readFile(new URL("./uoms.json", import.meta.url), "utf8")).uoms;
const TYPE_OF = { numeric: "number", boolean: "boolean" };
const withCategory = uom => {
  const known = UOMS[String(uom?.id ?? "")];
  return known ? { ...known, uomCategory: { ...known.uomCategory } } : null;
};
const FORM_FIELDS = ["329", "330", "331"]; // Submission ID, Submission source, Submission time
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const obj = x => !!x && typeof x === "object" && !Array.isArray(x);
const canonical = x => Array.isArray(x) ? x.map(canonical) : obj(x) ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
const schemaMetrics = device => new Map((device?.meterSchema?.metrics ?? []).map(m => [String(m.metric?.id ?? m.metricId ?? ""), m]).filter(([k]) => id(k)));

// One source rule as Zira stores it; numbers for metric IDs, as the web dialog sends them.
export function normalizeRule(rule, where) {
  assert(obj(rule) && TYPES.includes(rule.type), `${where}: type must be one of ${TYPES.join(", ")}`);
  const allowed = { aggregatedMetric: ["type", "metricId", "aggregationFunction"], groupedMetric: ["type", "metricId"], staticMetric: ["type", "value"],
    metadataMetric: ["type", "value"], null: ["type"] }[rule.type];
  for (const k of Object.keys(rule)) assert(allowed.includes(k), `${where}: unknown field ${k} for ${rule.type}`);
  if (rule.type === "aggregatedMetric") {
    assert(FUNCTIONS.includes(rule.aggregationFunction), `${where}: aggregationFunction must be one of ${FUNCTIONS.join(", ")}`);
    if (rule.aggregationFunction === "count" && rule.metricId == null) return { type: rule.type, aggregationFunction: "count" };
  }
  if (["aggregatedMetric", "groupedMetric"].includes(rule.type)) {
    assert(id(String(rule.metricId ?? "")), `${where}: metricId must be the source metric's ID`);
    return { ...rule, metricId: Number(rule.metricId) };
  }
  if (rule.type === "staticMetric") assert(typeof rule.value === "string" && rule.value.trim() && rule.value.length <= STATIC_MAX, `${where}: static value must be 1–${STATIC_MAX} characters`);
  if (rule.type === "metadataMetric") assert(METADATA.includes(rule.value), `${where}: metadata value must be one of ${METADATA.join(", ")}`);
  return { ...rule };
}

// Reads the aggregator, its schema and every named source; checks company and schemas.
async function load(call, { companyId, aggregatorId, sourceIds = [] }) {
  assert(id(String(aggregatorId ?? "")), "--aggregator-id is required");
  const current = (await call("GET", `/devices/aggregator/${aggregatorId}`))?.data;
  const target = current?.targetDevice;
  assert(String(target?.id ?? "") === String(aggregatorId), `Data source ${aggregatorId} is not a readable aggregator`);
  if (companyId != null) assert(String(target.companyId ?? target.site?.companyId ?? companyId) === String(companyId), "The aggregator belongs to another company");
  const attached = new Map((current.sourceDevices ?? []).filter(s => s && id(String(s.id ?? ""))).map(s => [String(s.id), s.aggregationConfig ?? {}]));
  const details = await describeSources(call, [...new Set([...sourceIds, ...attached.keys()])]);
  return { target, attached, details, company: String(target.companyId ?? companyId ?? "") };
}

// The exact POSTs that make the aggregator's sources match the spec (attach or replace changed configs).
export function planConfig(spec, { target, attached, details, company }) {
  assert(obj(spec), "Spec must be an object");
  for (const k of Object.keys(spec)) assert(["sources", "config", "perSource", "missingAsNull"].includes(k), `Unknown spec field ${k}`);
  const sources = (spec.sources ?? []).map(String);
  assert(sources.length > 0 && sources.length <= MAX_SOURCES && new Set(sources).size === sources.length && sources.every(id), `Give 1–${MAX_SOURCES} distinct source IDs`);
  assert(!sources.includes(String(target.id)), "An aggregator cannot be its own source");
  const targetMetrics = schemaMetrics(target);
  assert(obj(spec.config), "config maps each aggregator metric ID to a rule");
  const problems = [], writes = [], unchanged = [], nulled = [];
  for (const sid of sources) {
    const d = details.get(sid);
    if (!d || d.isDeleted) { problems.push(`Data source ${sid} is not readable`); continue; }
    if (String(d.companyId ?? "") !== company) { problems.push(`${d.name} (${sid}) belongs to another company`); continue; }
    const sourceMetrics = schemaMetrics(d);
    const config = {};
    // Every form-made aggregator also has the submission fields (ID, source, time); they carry nothing per day.
    const defaults = Object.fromEntries(FORM_FIELDS.filter(f => targetMetrics.has(f)).map(f => [f, { type: "null" }]));
    for (const [tm, raw] of Object.entries({ ...defaults, ...spec.config, ...(spec.perSource?.[sid] ?? {}) })) {
      const where = `${d.name} (${sid}) metric ${tm}`;
      if (!targetMetrics.has(String(tm))) { problems.push(`${where}: not a metric of the aggregator`); continue; }
      let rule = normalizeRule(raw, where);
      if (rule.metricId != null && !sourceMetrics.has(String(rule.metricId))) {
        if (spec.missingAsNull) { nulled.push({ source: sid, name: d.name, metric: String(tm), missing: String(rule.metricId) }); rule = { type: "null" }; }
        else { problems.push(`${where}: the source has no metric ${rule.metricId} (set missingAsNull, or a perSource rule)`); continue; }
      }
      config[String(tm)] = rule;
    }
    const missingTargets = [...targetMetrics.keys()].filter(tm => !config[tm]);
    if (missingTargets.length) problems.push(`${d.name} (${sid}): no rule for aggregator metrics ${missingTargets.join(", ")} (use {"type":"null"})`);
    const before = attached.get(sid);
    const site = { id: String(d.site?.id ?? ""), name: d.site?.name ?? null };
    if (before && JSON.stringify(canonical(before)) === JSON.stringify(canonical(config))) unchanged.push({ source: sid, name: d.name, site });
    else writes.push({ source: sid, name: d.name, site, action: before ? "replace" : "attach", body: { targetDeviceId: String(target.id), sourceDeviceId: sid, aggregationConfig: config } });
  }
  const leftAttached = [...attached.keys()].filter(sid => !sources.includes(sid)).map(sid => ({ source: sid, name: details.get(sid)?.name ?? null }));
  return { problems, writes, unchanged, nulled, leftAttached };
}

export async function show({ call, profile = "prod", companyId, aggregatorId }) {
  const { target, attached, details } = await load(call, { companyId, aggregatorId });
  return { kind: "aggregator", profile, url: link(profile, `/data-sources/${target.id}`), id: String(target.id), name: target.name,
    site: { id: String(target.site?.id ?? ""), name: target.site?.name ?? null },
    metrics: [...schemaMetrics(target).entries()].map(([mid, m]) => ({ id: mid, name: m.displayName ?? m.metric?.name ?? null })),
    sources: [...attached.entries()].map(([sid, config]) => ({ id: sid, name: details.get(sid)?.name ?? null, site: details.get(sid)?.site?.name ?? null, config })),
    revision: fingerprint(canonical([...attached.entries()])) };
}

export async function configure({ call, profile = "prod", companyId, aggregatorId, spec, expected, apply = false, receipts }) {
  const loaded = await load(call, { companyId, aggregatorId, sourceIds: (spec?.sources ?? []).map(String) });
  const rev = fingerprint(canonical([...loaded.attached.entries()]));
  const plan = planConfig(spec, loaded);
  const url = link(profile, `/data-sources/${aggregatorId}`);
  const preview = { kind: "aggregator-config-preview", profile, url, revision: rev, aggregator: { id: String(aggregatorId), name: loaded.target.name },
    writes: plan.writes.map(({ body, ...w }) => ({ ...w, config: body.aggregationConfig })), unchanged: plan.unchanged.length, nulled: plan.nulled,
    ...(plan.leftAttached.length ? { leftAttached: plan.leftAttached, leftAttachedNote: "Zira cannot detach a source; these stay in the aggregator." } : {}),
    problems: plan.problems, refresh: plan.writes.length > 0, applied: false, platformNote: `Needs ${PLATFORM_CHANGE}.` };
  if (plan.problems.length) throw new Blocked("invalid_spec", `Fix the spec first: ${plan.problems.slice(0, 10).join("; ")}${plan.problems.length > 10 ? ` (+${plan.problems.length - 10} more)` : ""}`, { preview });
  if (!apply) return preview;
  assert(expected, "--expected REVISION from a reviewed preview is required with --apply");
  if (!plan.writes.length) return { ...preview, kind: "aggregator-config", state: "unchanged", applied: false };
  const key = fingerprint(canonical({ op: "aggregator-config", profile, aggregatorId: String(aggregatorId), spec, expected }));
  const outcome = await guardedWrite({ file: receipts, key, summary: { kind: "aggregator-config", aggregatorId: String(aggregatorId), sources: plan.writes.length }, links: () => ({ url }),
    precheck: async () => {
      const now = await load(call, { companyId, aggregatorId });
      if (fingerprint(canonical([...now.attached.entries()])) !== expected) throw new Blocked("conflict", "The aggregator changed since the preview; nothing was written.");
    },
    run: async progress => {
      const done = [];
      for (const w of plan.writes) { await call("POST", "/devices/aggregator", w.body); done.push(w.source); await progress({ done }); }
      await call("POST", "/devices/aggregator", { targetDeviceId: String(aggregatorId), sourceDeviceId: String(aggregatorId), aggregationConfig: {}, updateSqlCache: true });
      await progress({ done, refreshed: true });
      let after;
      try { after = await load(call, { companyId, aggregatorId }); } catch (error) { return { verified: false, readBack: error.message, receipt: { done, refreshed: true } }; }
      const mismatches = plan.writes.filter(w => JSON.stringify(canonical(after.attached.get(w.source) ?? null)) !== JSON.stringify(canonical(w.body.aggregationConfig))).map(w => w.source);
      return { verified: !mismatches.length, mismatches, receipt: { done, refreshed: true } };
    } });
  return { ...preview, kind: "aggregator-config", state: outcome.state === "created" ? (outcome.verified ? "configured" : "unverified") : outcome.state,
    applied: outcome.state === "created", verified: outcome.verified, mismatches: outcome.mismatches,
    note: "The view now covers these sources. Readings appear per source and site-local day; check a total against the sources' readings." };
}

// The form-editor body for a new aggregator. Field units come from a source that has the metric (so number,
// text, list and boolean fields keep the sources' own types); fields no source has use the given kind.
export function aggregatorBody(spec, siteId, details) {
  const known = new Map();
  for (const d of details.values()) for (const [mid, m] of schemaMetrics(d)) if (!known.has(mid)) known.set(mid, m);
  const properties = {}, order = [];
  spec.fields.forEach((f, i) => {
    const mid = String(f.metricId), from = known.get(mid);
    const kind = KINDS[f.kind ?? ""] ?? null;
    assert(from || kind, `Field ${i + 1} (metric ${mid}): no source has this metric; give kind number, text or list`);
    // Source schemas carry the unit without its category; the catalogue adds category and data type.
    const unit = kind ? { ...kind.uom, uomCategory: kind.uomCategory } : withCategory(from?.uom);
    assert(unit?.uomCategory?.dataType, `Field ${i + 1} (metric ${mid}): unknown unit ${from?.uom?.name ?? "?"}; give kind number, text or list`);
    const type = kind?.type ?? TYPE_OF[unit.uomCategory.dataType.name] ?? "string";
    const key = `f${i + 1}_${mid}`;
    const name = from?.displayName ?? f.title ?? from?.metric?.name ?? null;
    properties[key] = { type, title: text(f.title, 120) || name || `Metric ${mid}`, isHide: false,
      uom: unit, uomCategory: unit.uomCategory,
      metric: { id: mid, keyName: from?.metric?.name ?? null, name }, displayFactor: 1, tagName: null, registerType: null,
      ...(Array.isArray(f.enum) ? { enum: f.enum.map(String).slice(0, 500) } : {}) };
    order.push(key);
  });
  return { title: spec.title, description: spec.description ?? "", siteId: `${siteId}`, type: "object", deviceTypeId: OTHER_DEVICE_TYPE,
    applyingId: AGGREGATOR_APPLYING_ID, properties, order, required: [], targetChannels: null, linkedFormId: null, webhookUrl: null,
    isFormTask: false, reEvaluate: false, isPrivate: false };
}

export async function create({ call, profile = "prod", companyId, siteId, spec, apply = false, receipts }) {
  const site = await resolveSite(call, companyId, siteId);
  assert(obj(spec) && text(spec.title, 120), "Spec needs a title");
  assert(Array.isArray(spec.fields) && spec.fields.length > 0 && spec.fields.length <= 100, "Spec needs 1–100 fields");
  const mids = spec.fields.map(f => String(f.metricId));
  assert(mids.every(id) && new Set(mids).size === mids.length, "Each field needs a distinct metricId");
  const like = (spec.like ?? []).map(String).slice(0, 20);
  const details = like.length ? await describeSources(call, like) : new Map();
  const body = aggregatorBody(spec, site.id, details);
  const same = (await siteDataSources(call, site)).filter(d => normalizeName(d.name) === normalizeName(spec.title));
  const preview = { kind: "aggregator-draft", profile, site: { id: site.id, name: site.name }, title: spec.title,
    fields: Object.values(body.properties).map(p => ({ metric: p.metric.id, title: p.title, unit: p.uom?.name ?? null, type: p.type })),
    ...(same.length ? { nameTaken: true } : {}), applied: false };
  if (!apply) return preview;
  if (same.length) throw new Blocked("duplicate", `A data source named "${spec.title}" already exists at ${site.name}.`);
  const outcome = await guardedWrite({ file: receipts, key: fingerprint({ op: "aggregator-create", profile, siteId: site.id, title: normalizeName(spec.title), fields: mids }),
    resolveField: "dataSourceId", summary: { kind: "aggregator", siteId: site.id, name: spec.title },
    reconcile: async () => { const f = (await siteDataSources(call, site)).filter(d => normalizeName(d.name) === normalizeName(spec.title)); return f.length === 1 ? { dataSourceId: String(f[0].id) } : null; },
    run: async progress => {
      const res = await call("POST", "/forms/new", body);
      const created = `${res?.data?.id ?? res?.data ?? ""}`;
      assert(id(created), "Create returned no data source ID; check the site's data sources before retrying");
      await progress({ dataSourceId: created });
      let saved = null; try { saved = (await call("GET", `/forms/${created}`))?.data; } catch { /* reported as unverified */ }
      const got = new Set(Object.values(saved?.properties ?? {}).map(p => String(p?.metric?.id ?? "")));
      // A new form's read-back has no applyingId (2026-11-22); the data source's own "applying" says Aggregator.
      let device = null; try { device = (await call("GET", `/devices/all?meterIds=${created}`))?.data?.[0]; } catch { /* reported as unverified */ }
      const isAggregator = [saved?.applyingId, device?.applying?.id].some(v => String(v ?? "") === AGGREGATOR_APPLYING_ID);
      return { receipt: { dataSourceId: created }, dataSourceId: created, verified: !!saved && isAggregator && mids.every(m => got.has(m)) };
    } });
  const dsId = outcome.dataSourceId ?? outcome.receipt?.dataSourceId;
  return { ...preview, kind: "aggregator", state: outcome.state === "created" ? (outcome.verified ? "created" : "unverified") : outcome.state,
    applied: outcome.state === "created", dataSourceId: dsId, url: link(profile, `/data-sources/${dsId}`) };
}

const HELP = `Zira aggregator data sources (daily roll-ups of many data sources, computed by Zira's database)
node scripts/aggregators.mjs show --company-id ID --aggregator-id ID
node scripts/aggregators.mjs create --company-id ID --site-id ID --spec FILE [--apply] [--receipts FILE]
  spec: {title, description?, like:[source IDs whose field units to copy], fields:[{metricId, title?, kind?: number|text|list, enum?}]}
node scripts/aggregators.mjs configure --company-id ID --aggregator-id ID --spec FILE [--apply --expected REVISION] [--receipts FILE]
  spec: {sources:[IDs], config:{<aggregator metric ID>: rule}, perSource?:{<source ID>:{<metric ID>: rule}}, missingAsNull?: true}
  rule: {type:"aggregatedMetric", metricId, aggregationFunction: count|sum|avg|max|min} | {type:"groupedMetric", metricId}
      | {type:"metadataMetric", value:"{{siteName}}"|"{{siteId}}"|"{{meterName}}"|"{{meterId}}"} | {type:"staticMetric", value:"≤30 chars"} | {type:"null"}
Rows are per source and site-local day (the source site's time zone and day start). Sources must be in the aggregator's
company; Zira cannot detach a source. Preview by default; --apply posts each changed source once, regenerates the view
and reads the configs back. Common: --profile prod|integ. JSON stdout. Exit 0 ok, 2 failed, 3 unverified, 4 blocked.
`;
async function main() {
  const { values: o, positionals: [command] } = parseArgs({ allowPositionals: true, options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, "aggregator-id": { type: "string" }, spec: { type: "string" },
    apply: { type: "boolean" }, expected: { type: "string" }, receipts: { type: "string" }, profile: { type: "string", default: "prod" } } });
  if (!command || command === "help") { process.stdout.write(HELP); return; }
  assert(["show", "create", "configure"].includes(command), "Choose show, create or configure");
  const call = await liveSession(o.profile, { allow: ROUTES, maxRequests: 600 });
  const spec = o.spec ? JSON.parse(await readFile(o.spec, "utf8")) : undefined;
  const common = { call, profile: o.profile, companyId: o["company-id"] };
  if (command === "show") return show({ ...common, aggregatorId: o["aggregator-id"] });
  assert(spec, "--spec FILE is required");
  if (command === "create") return create({ ...common, siteId: o["site-id"], spec, apply: !!o.apply, receipts: receiptsFile(o.receipts) });
  return configure({ ...common, aggregatorId: o["aggregator-id"], spec, expected: o.expected, apply: !!o.apply, receipts: receiptsFile(o.receipts) });
}
if (isMain(import.meta)) runCli(main, { profile: () => process.argv.includes("integ") ? "integ" : "prod" });
