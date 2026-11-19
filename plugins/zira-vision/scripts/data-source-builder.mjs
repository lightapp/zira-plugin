// Build generic (custom) data sources with explicit shared metrics, and data source templates
// from them, the way Zira web's form editor and "Set as template" dialog do.
//
// Generic meters must use Zira's shared metrics (kw 1, v1 16, pf 29 …) so every meter compares
// across sites; the editor's name matching can silently create new site metrics instead. Here each
// field names its metric ID, which is checked against Zira before anything is written.
// Routes: GET /meterSchemas/metrics, POST /forms/new, GET /forms/{id}, POST /devices/template,
// GET /devices/template (platform branch feat/agent-meter-template-routes opts them in).
import { Blocked, fingerprint, guardedWrite, id, link, normalizeName, resolveSite, route, siteDataSources, text } from "./client.mjs";

export const BUILDER_ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/],
  ["GET", /^\/meterSchemas\/metrics$/], ["POST", /^\/forms\/new$/], ["GET", /^\/forms\/[1-9]\d*$/],
  ["POST", /^\/devices\/template$/], ["GET", /^\/devices\/template$/],
];

const CUSTOM_APPLYING_ID = "3";
const OTHER_DEVICE_TYPE = "40";
const POWER_METER_DEVICE_TYPE = "1";

// Units as Zira stores them (uom and its category), from existing meters' schemas.
export const UNITS = {
  kW: { uom: { id: "100", name: "Kilowatt" }, category: { id: "1", name: "Power" } },
  V: { uom: { id: "900", name: "Volt" }, category: { id: "9", name: "Electric Potential" } },
  A: { uom: { id: "800", name: "Ampere" }, category: { id: "8", name: "Current" } },
  PF: { uom: { id: "1700", name: "Power Factor" }, category: { id: "17", name: "Power Factor" } },
  kWh: { uom: { id: "200", name: "Kilowatt-hour" }, category: { id: "2", name: "Electric Energy" } },
  "m3/h": { uom: { id: "303", name: "Cubic Meter/Hour" }, category: { id: "3", name: "Flow" } },
  bar: { uom: { id: "501", name: "Bar" }, category: { id: "5", name: "Pressure" } },
  C: { uom: { id: "601", name: "Celsius" }, category: { id: "6", name: "Temperature" } },
  RH: { uom: { id: "1500", name: "Relative Humidity" }, category: { id: "15", name: "Humidity" } },
};

const f = (metricId, name, title, unit, extra = {}) => ({ metricId: `${metricId}`, name, title, unit, ...extra });

// The meter kinds of the generic collection service (zira-web src/lib/collection/catalog.js):
// one Zira template each. Calculated fields stay Zira's job (kWh: increasing counter).
export const METER_KINDS = {
  "power-3ph": {
    title: "3-phase power meter", deviceTypeId: POWER_METER_DEVICE_TYPE,
    description: "Power, voltage, current, power factor and energy of a 3-phase electrical meter.",
    fields: [
      f(1, "kw", "Power (Total)", "kW"), f(2, "kw1", "Power (Phase A)", "kW"), f(3, "kw2", "Power (Phase B)", "kW"),
      f(4, "kw3", "Power (Phase C)", "kW"), f(5, "max_kw", "Power (Max)", "kW"),
      f(16, "v1", "Volt (Phase A)", "V"), f(17, "v2", "Volt (Phase B)", "V"), f(18, "v3", "Volt (Phase C)", "V"),
      f(13, "a1", "Ampere (Phase A)", "A"), f(14, "a2", "Ampere (Phase B)", "A"), f(15, "a3", "Ampere (Phase C)", "A"),
      f(29, "pf", "Power Factor (Total)", "PF"), f(30, "pf1", "Power Factor (Phase A)", "PF"),
      f(31, "pf2", "Power Factor (Phase B)", "PF"), f(32, "pf3", "Power Factor (Phase C)", "PF"),
      f(7, "acc_kwh", "Accumulated kWh", "kWh"),
      f(6, "kwh", "kWh", "kWh", { calculationTypeId: "1" }),
    ],
  },
  flow: { title: "Flow meter", deviceTypeId: OTHER_DEVICE_TYPE, description: "Flow rate from a flow meter or a compressor controller.",
    fields: [f(8, "flow", "Flow", "m3/h")] },
  pressure: { title: "Pressure sensor", deviceTypeId: OTHER_DEVICE_TYPE, description: "Line pressure from a pressure sensor or a compressor controller.",
    fields: [f(10, "pressure", "Pressure", "bar")] },
  temperature: { title: "Temperature sensor", deviceTypeId: OTHER_DEVICE_TYPE, description: "A single temperature reading.",
    fields: [f(11, "temperature", "Temperature", "C")] },
  "temp-humidity": { title: "Temperature & humidity sensor", deviceTypeId: OTHER_DEVICE_TYPE, description: "Temperature and relative humidity from one sensor.",
    fields: [f(11, "temperature", "Temperature", "C"), f(27, "humidity", "Relative Humidity", "RH")] },
};

// Validates a spec ({ title, description, deviceTypeId, fields: [{ metricId, name, title, unit, calculationTypeId? }] }).
export function normalizeSpec(spec) {
  const title = text(spec?.title, 120);
  if (!title) throw new Error("The data source needs a title");
  const fields = Array.isArray(spec?.fields) ? spec.fields : [];
  if (!fields.length || fields.length > 100) throw new Error("Give between 1 and 100 fields");
  const names = new Set(), metrics = new Set();
  const out = fields.map((field, i) => {
    const metricId = `${field?.metricId ?? ""}`;
    const name = `${field?.name ?? ""}`;
    if (!id(metricId)) throw new Error(`Field ${i + 1}: metricId must be a metric ID`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`Field ${i + 1}: name must be a lowercase key such as kw or acc_kwh`);
    if (names.has(name) || metrics.has(metricId)) throw new Error(`Field ${i + 1}: ${name} / metric ${metricId} is used twice`);
    names.add(name); metrics.add(metricId);
    const unit = UNITS[field?.unit];
    if (!unit) throw new Error(`Field ${i + 1}: unit must be one of ${Object.keys(UNITS).join(", ")}`);
    const fieldTitle = text(field?.title, 120);
    if (!fieldTitle) throw new Error(`Field ${i + 1}: title is required`);
    const calc = field?.calculationTypeId == null ? null : `${field.calculationTypeId}`;
    if (calc !== null && !id(calc)) throw new Error(`Field ${i + 1}: calculationTypeId must be an ID`);
    return { metricId, name, title: fieldTitle, unit: field.unit, calculationTypeId: calc };
  });
  const deviceTypeId = `${spec?.deviceTypeId ?? OTHER_DEVICE_TYPE}`;
  if (!id(deviceTypeId)) throw new Error("deviceTypeId must be an ID");
  return { title, description: text(spec?.description ?? "", 2000) ?? "", deviceTypeId, fields: out };
}

// Looks up metrics by ID: shared (public) metrics and the site's own.
export async function lookupMetrics(call, { siteId, metricIds = [], search }) {
  const params = { includePublic: "true", limit: "100" };
  if (siteId) params.siteIds = siteId;
  if (metricIds.length) params.metricIds = metricIds.join(",");
  if (search) params.textSearch = search;
  const res = await call("GET", route("/meterSchemas/metrics", params));
  const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  return rows.map(m => ({
    id: `${m.id ?? m.metricId ?? ""}`, name: m.name ?? m.metricName ?? null, keyName: m.keyName ?? null,
    scope: m.site?.id || m.siteId ? "site" : m.company?.id || m.companyId ? "company" : "shared",
    siteId: m.site?.id ?? m.siteId ?? null, category: m.uomCategory?.name ?? null,
  })).filter(m => id(m.id));
}

export async function metrics({ call, profile = "prod", companyId, siteId, metricIds, search }) {
  const site = await resolveSite(call, companyId, siteId);
  const ids = (metricIds ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (ids.some(x => !id(x)) || ids.length > 100) throw new Error("--metric-ids takes up to 100 metric IDs");
  return { kind: "metrics", profile, site: { id: site.id, name: site.name }, items: await lookupMetrics(call, { siteId: site.id, metricIds: ids, search: text(search, 200) }) };
}

const fieldProperty = (field, metric) => {
  const unit = UNITS[field.unit];
  return {
    title: field.name,
    description: field.title,
    type: "number",
    metric: { id: field.metricId, name: metric?.name ?? field.name },
    uom: unit.uom,
    uomCategory: unit.category,
    ...(field.calculationTypeId ? { metricCalculationType: { id: field.calculationTypeId } } : {}),
  };
};

// The body Zira web's form editor sends to POST /forms/new for a custom data source.
export function formBody(spec, siteId, metricsById) {
  const properties = Object.fromEntries(spec.fields.map(field => [field.name, fieldProperty(field, metricsById.get(field.metricId))]));
  return {
    title: spec.title, description: spec.description, siteId: `${siteId}`, type: "object",
    deviceTypeId: spec.deviceTypeId, applyingId: CUSTOM_APPLYING_ID, properties,
    order: spec.fields.map(field => field.name), required: [],
    targetChannels: null, linkedFormId: null, webhookUrl: null, isFormTask: null, reEvaluate: false, isPrivate: false,
  };
}

const sameName = async (call, site, name) =>
  (await siteDataSources(call, site)).filter(d => normalizeName(d.name) === normalizeName(name)).map(d => ({ id: d.id, name: d.name }));

// Field metrics of a saved form, keyed by field name.
const savedFieldMetrics = form => Object.fromEntries(Object.entries(form?.properties ?? {}).map(([k, p]) => [k, `${p?.metric?.id ?? ""}`]));

export async function createCustom({ call, profile = "prod", companyId, siteId, spec: rawSpec, kind, name, apply = false, allowRepeat = false, receipts, resolve }) {
  const base = kind ? METER_KINDS[kind] : rawSpec;
  if (kind && !base) throw new Error(`Kind must be one of ${Object.keys(METER_KINDS).join(", ")}`);
  const spec = normalizeSpec({ ...base, title: name ?? base?.title });
  const site = await resolveSite(call, companyId, siteId);
  const found = await lookupMetrics(call, { siteId: site.id, metricIds: spec.fields.map(x => x.metricId) });
  const metricsById = new Map(found.map(m => [m.id, m]));
  const missing = spec.fields.filter(x => !metricsById.has(x.metricId)).map(x => `${x.name} (metric ${x.metricId})`);
  if (missing.length) throw new Blocked("not_found", `These metrics are not shared or at this site: ${missing.join(", ")}`, { missing });
  const foreign = spec.fields.filter(x => metricsById.get(x.metricId).scope === "site" && `${metricsById.get(x.metricId).siteId}` !== site.id);
  if (foreign.length) throw new Blocked("not_found", `Metrics of another site cannot be used: ${foreign.map(x => x.name).join(", ")}`);
  const duplicates = await sameName(call, site, spec.title);
  const preview = {
    site: { id: site.id, name: site.name }, title: spec.title, deviceTypeId: spec.deviceTypeId,
    fields: spec.fields.map(x => ({ name: x.name, title: x.title, unit: x.unit, metric: { id: x.metricId, name: metricsById.get(x.metricId).name, scope: metricsById.get(x.metricId).scope }, calculated: !!x.calculationTypeId })),
  };
  if (!apply) return { kind: "custom-data-source-draft", profile, preview, duplicates, applied: false };
  const body = formBody(spec, site.id, metricsById);
  const key = fingerprint({ op: "custom-data-source", profile, siteId: site.id, title: normalizeName(spec.title), fields: spec.fields });
  const outcome = await guardedWrite({
    file: receipts, key, allowRepeat, resolve, resolveField: "dataSourceId",
    summary: { kind: "custom-data-source", siteId: site.id, name: spec.title },
    precheck: async () => {
      const current = await sameName(call, site, spec.title);
      if (current.length) throw new Blocked("duplicate", `A data source named "${spec.title}" already exists in ${site.name}. Choose a different name.`, { duplicates: current });
    },
    reconcile: async () => {
      const current = await sameName(call, site, spec.title);
      return current.length === 1 ? { dataSourceId: current[0].id } : null;
    },
    run: async progress => {
      const res = await call("POST", "/forms/new", body);
      const createdId = `${res?.data?.id ?? res?.data ?? ""}`;
      if (!id(createdId)) throw new Error("Create returned no data source ID; check the site's data sources before retrying");
      await progress({ dataSourceId: createdId });
      const warnings = [];
      let saved = null;
      try { saved = (await call("GET", `/forms/${createdId}`))?.data; }
      catch (error) { warnings.push(`Read-back failed (${error.status ? `HTTP ${error.status}` : error.message}); open the data source to check its metrics.`); }
      const got = savedFieldMetrics(saved);
      const mismatched = spec.fields.filter(x => got[x.name] !== x.metricId).map(x => `${x.name}: expected metric ${x.metricId}, saved ${got[x.name] || "none"}`);
      if (saved && mismatched.length) warnings.push(`Some fields are not on the requested metric: ${mismatched.join("; ")}`);
      return { receipt: { dataSourceId: createdId }, dataSourceId: createdId, verified: !!saved && !mismatched.length, warnings };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state)) {
    const dsId = outcome.receipt.dataSourceId;
    return { kind: "custom-data-source", profile, applied: false, state: outcome.state, dataSourceId: dsId,
      url: link(profile, `/data-sources/${dsId}`), message: "This data source was already created; nothing new was written." };
  }
  return { kind: "custom-data-source", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    dataSourceId: outcome.dataSourceId, warnings: outcome.warnings, preview, url: link(profile, `/data-sources/${outcome.dataSourceId}`) };
}

// Zira web's "Set as template" (CreateDataSourceTemplateDialog): a template made from a copy of a data
// source. Scope: site (default), company, or global (Zira admins).
export async function makeTemplate({ call, profile = "prod", companyId, siteId, sourceId, name, description, scope = "site", apply = false, allowRepeat = false, receipts, resolve }) {
  if (!["site", "company", "global"].includes(scope)) throw new Error("--scope must be site, company or global");
  if (!id(sourceId ?? "")) throw new Error("--source-id is required");
  const site = await resolveSite(call, companyId, siteId);
  const source = (await call("GET", route("/devices/all", { meterIds: sourceId, expand: "true", onlyMeters: "false" })))?.data?.[0];
  if (!source || `${source.id}` !== `${sourceId}` || `${source.site?.id ?? ""}` !== site.id)
    throw new Blocked("not_found", "That data source is not at the selected site");
  const templateName = text(name ?? source.name, 120);
  if (!templateName) throw new Error("A template name is required");
  const body = {
    name: templateName, deviceId: `${source.id}`, description: text(description ?? "", 2000) || null, icon: null, imageId: null,
    siteId: scope === "site" ? site.id : null, companyId: scope === "global" ? null : site.companyId,
    categoryIds: null, createNew: true,
  };
  const preview = { source: { id: `${source.id}`, name: source.name }, name: templateName, scope, site: { id: site.id, name: site.name } };
  if (!apply) return { kind: "data-source-template-draft", profile, preview, applied: false };
  const key = fingerprint({ op: "data-source-template", profile, sourceId: `${source.id}`, name: normalizeName(templateName), scope });
  const outcome = await guardedWrite({
    file: receipts, key, allowRepeat, resolve, resolveField: "templateId",
    summary: { kind: "data-source-template", sourceId: `${source.id}`, name: templateName, scope },
    run: async progress => {
      const res = await call("POST", "/devices/template", body);
      const templateId = `${res?.data?.id ?? res?.data ?? ""}`;
      if (!id(templateId)) throw new Error("Template create returned no ID; check the templates list in Zira before retrying");
      await progress({ templateId });
      let saved = null;
      try { saved = (await call("GET", route("/devices/template", { deviceTemplateIds: templateId, expand: "true" })))?.data?.[0]; } catch { /* reported below */ }
      const verified = `${saved?.id ?? ""}` === templateId && normalizeName(saved?.name) === normalizeName(templateName);
      return { receipt: { templateId }, templateId, verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "data-source-template", profile, applied: false, state: outcome.state, templateId: outcome.receipt.templateId, message: "This template was already created; nothing new was written." };
  return { kind: "data-source-template", profile, applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified, templateId: outcome.templateId, preview,
    next: "Add the template ID to TEMPLATE_IDS in zira-web src/lib/collection/catalog.js for this stack." };
}
