#!/usr/bin/env node
import { assertProfile } from "./build-info.mjs";
import { parseArgs } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discover, healthProfile, liveClient, pages } from "../skills/health-report/scripts/api.mjs";
import { id } from "../skills/health-report/scripts/config.mjs";

const ORIGINS = { prod: "https://my.zira.us", integ: "https://zira-webinteg.zira.us" };
const HELP = `Zira inventory — read-only browsing
node scripts/browse.mjs menu|companies|sites|devices|dashboards|collection
  --company-id ID       Required for sites, devices, dashboards and collection
  --site-id ID          Required for devices and collection; for dashboards, leave it out to list the
                        company-level dashboards (the company channel's Dashboards tab, no site)
  --device-ids ID,...   collection only: read just these data sources (from this site)
  --profile prod|integ  Defaults to ZIRA_PROFILE, then prod
  --health-profiles     devices only: also read each device (within the cap) and add
                        healthProfile trimsaw|bandsaw|pallet-qa, null (not covered by
                        health checks) or "unknown" (cap reached)

menu makes no API calls. Lists require the health-report browser login.
At most 20 API reads per invocation; 429 stops without retrying.
JSON stdout contains safe names, IDs and links, never full settings.
collection is the exception: it returns each data source's legacy collection
settings (collector, host, port, unit ID, meter schema and register map) so they
can be reviewed or migrated. Credential-like fields are always removed. When the
cap is reached, "remaining" lists the IDs to pass back with --device-ids.
Exit 0: complete, 2: failed/invalid input, 3: coverage incomplete.
`;

export function originFor(profile) {
  assertProfile(profile);
  if (!Object.hasOwn(ORIGINS, profile)) throw new Error("Choose prod or integ profile");
  return ORIGINS[profile];
}

const SECRET = /pass|secret|token|cred|auth|cookie|private|cert|signature|apikey|api_key|accesskey|access_key|(^|[_-])key$|key(id|s)?$/i;

// Copies plain settings, dropping credential-like keys at any depth and bounding size.
export function sanitize(value, depth = 0) {
  if (value == null || ["string", "number", "boolean"].includes(typeof value))
    return typeof value === "string" ? value.slice(0, 500) : value;
  if (depth >= 5 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET.test(k)) continue;
    const clean = sanitize(v, depth + 1);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

const named = x => (x && typeof x === "object" && x.name != null ? String(x.name) : null);

export function collectionSettings(d) {
  const schema = d.meterSchema && typeof d.meterSchema === "object" ? d.meterSchema : null;
  return {
    collector: named(d.collector), collectorType: named(d.collectorType),
    collectionEnabled: d.collectionEnabled ?? null,
    connection: { host: d.ipAddress ?? null, port: d.port ?? null, unitId: d.slaveId ?? null,
      endpointDevice: d.endpointDevice?.id != null ? { id: String(d.endpointDevice.id), name: named(d.endpointDevice) } : null,
      communicationType: named(d.communicationType) ?? d.communicationType ?? null,
      readingIntervalSeconds: d.readingInterval ?? null },
    deviceType: named(d.type), manufacturer: named(d.manufacturer), model: named(d.model),
    meterSchema: schema && {
      id: schema.id != null ? String(schema.id) : null, name: named(schema), protocol: named(schema.type),
      accessType: named(schema.modbusAccessType), isHolding: schema.modbusIsHolding ?? null,
      registerOffset: schema.modbusRegisterOffset ?? null, customSchema: d.isCustomSchema ?? null,
      metrics: (Array.isArray(schema.metrics) ? schema.metrics : []).slice(0, 200).map(m => ({
        metricId: m.metric?.id != null ? String(m.metric.id) : null, metric: named(m.metric),
        displayName: m.displayName ?? null, unit: named(m.uom), displaySymbol: m.displaySymbol?.trim?.() ?? null,
        registerType: named(m.registerType), baseRegister: m.baseRegister ?? null,
        littleEndian: m.isLittleEndian ?? null, displayFactor: m.displayFactor ?? null,
        formula: m.denormalizeFormula ?? null, valueExpression: m.valueExpression ?? null,
        analogRange: m.analogRangeMin == null && m.analogRangeMax == null ? null : [m.analogRangeMin, m.analogRangeMax],
        analogOutput: m.analogOutputMin == null && m.analogOutputMax == null ? null : [m.analogOutputMin, m.analogOutputMax],
      })) },
    collectionInfo: d.collectionInfo == null ? null : sanitize(d.collectionInfo),
    modbus: d.modbus == null ? null : sanitize(d.modbus),
    plcSettings: d.plcSettings == null ? null : sanitize(d.plcSettings),
    lastReadingAt: typeof d.timestamp === "string" ? d.timestamp : null,
    activityStatus: named(d.activityStatus),
  };
}

export async function browse(get, kind, { companyId, siteId, profile = "prod", healthProfiles = false, deviceIds } = {}) {
  const origin = originFor(profile);
  if (!["companies", "sites", "devices", "dashboards", "collection"].includes(kind))
    throw new Error("Choose companies, sites, devices, dashboards or collection");
  if (kind !== "companies" && !id(companyId)) throw new Error("Company ID required");
  if (["devices", "collection"].includes(kind) && !id(siteId)) throw new Error("Site ID required");
  if (kind === "dashboards" && siteId != null && siteId !== "" && !id(siteId)) throw new Error("Site ID must be an ID");
  if (deviceIds != null && (kind !== "collection" || !Array.isArray(deviceIds) || !deviceIds.length || !deviceIds.every(x => id(x))))
    throw new Error("--device-ids takes a comma-separated list of data source IDs, for collection only");
  let requests = 0;
  const boundedGet = async route => {
    if (requests >= 20) throw new Error("Local request cap reached; narrow the scope before trying again");
    requests++;
    return get(route);
  };
  let rows, excluded = 0;
  if (kind === "dashboards" && !id(siteId)) {
    // Company-level dashboards: next-generation dashboards of the company without a site.
    const raw = await pages(boundedGet, "/dashboards/list", { companyIds: companyId, dashboardTypeIds: "3" });
    rows = raw.filter(d => !d.isDeleted && (d.site?.id ?? d.siteId) == null && String(d.company?.id ?? d.companyId ?? "") === companyId &&
      String(d.dashboardType?.id ?? d.dashboardTypeId ?? d.type?.id ?? d.typeId ?? "3") === "3");
    excluded = raw.filter(d => !d.isDeleted).length - rows.length;
  } else if (["devices", "dashboards", "collection"].includes(kind)) {
    const sites = await discover(boundedGet, "sites", companyId);
    if (!sites.some(s => s.id === siteId)) throw new Error("Site outside selected company");
    const listKind = kind === "collection" ? "devices" : kind;
    const raw = await pages(boundedGet, `/${listKind}/list`, { siteIds: siteId,
      ...(kind === "dashboards" ? { dashboardTypeIds: "3" } : { companyIds: companyId, applyingIds: "1,3,7,9,10,11" }) });
    rows = raw.filter(d => {
      const company = d.company?.id ?? d.companyId;
      return !d.isDeleted && !d.isTemplate &&
        String(d.site?.id ?? d.siteId ?? "") === siteId &&
        (company == null || String(company) === companyId) &&
        (kind !== "dashboards" || String(d.dashboardType?.id ?? d.dashboardTypeId ?? d.type?.id ?? d.typeId ?? "") === "3");
    });
    excluded = raw.filter(d => !d.isDeleted && !d.isTemplate).length - rows.length;
  } else {
    const raw = await pages(boundedGet, `/${kind}/list`, kind === "sites" ? { companyIds: companyId } : {});
    rows = raw.filter(x => !x.isDeleted && !x.isTemplate && (kind === "companies" || String(x.company?.id ?? x.companyId ?? "") === companyId));
    excluded = raw.filter(x => !x.isDeleted && !x.isTemplate).length - rows.length;
  }
  const items = [];
  for (const row of rows) {
    const entityId = String(row.id ?? "");
    if (!id(entityId)) { excluded++; continue; }
    const url = kind === "sites" && id(String(row.channelId ?? ""))
      ? `${origin}/channels/${row.channelId}?tab=posts`
      : ["devices", "dashboards", "collection"].includes(kind)
        ? `${origin}/${kind === "dashboards" ? "dashboards" : "data-sources"}/${entityId}` : undefined;
    const type = ["devices", "collection"].includes(kind) && typeof row.applying?.name === "string" ? row.applying.name : undefined;
    items.push({ id: entityId, name: String(row.name ?? "Unnamed"),
      ...(companyId ? { companyId } : {}), ...(siteId ? { siteId } : {}),
      ...(url ? { url } : {}), ...(type ? { type } : {}) });
  }
  if (kind === "collection") {
    let selected = items;
    if (deviceIds) {
      const wanted = new Set(deviceIds);
      selected = items.filter(item => wanted.has(item.id));
      const missing = deviceIds.filter(x => !items.some(item => item.id === x));
      if (missing.length) throw new Error(`Not data sources of this site: ${missing.join(", ")}`);
    }
    const read = [], remaining = [];
    for (const item of selected) {
      if (requests >= 20) { remaining.push(item.id); continue; }
      const detail = (await boundedGet(`/devices/${item.id}`))?.data ?? {};
      if (String(detail.id ?? "") !== item.id || String(detail.site?.id ?? detail.siteId ?? "") !== siteId)
        throw new Error(`Data source ${item.id} detail is outside the selected site`);
      read.push({ ...item, settings: collectionSettings(detail) });
    }
    return { kind, profile, complete: excluded === 0 && remaining.length === 0, excluded, requests,
      remaining, items: read };
  }
  let profilesComplete;
  if (kind === "devices" && healthProfiles) {
    profilesComplete = true;
    for (const item of items) {
      if (requests >= 20) { item.healthProfile = "unknown"; profilesComplete = false; continue; }
      const detail = (await boundedGet(`/devices/${item.id}`))?.data ?? {};
      item.healthProfile = healthProfile(detail.cv?.settings) ?? null;
    }
  }
  return { kind, profile, complete: excluded === 0, excluded, requests,
    ...(profilesComplete === undefined ? {} : { profilesComplete }), items };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) {
    process.stdout.write(HELP); return 0;
  }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, profile: { type: "string" },
    "health-profiles": { type: "boolean" }, "device-ids": { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const origin = originFor(profile);
  if (args[0] === "menu") {
    console.log(JSON.stringify({ profile, assistantUrl: `${origin}/ai-assistant`,
      helpUrl: "https://help.zira.us/docs", websiteUrl: "https://zira.us" }, null, 2));
    return 0;
  }
  const result = await browse(await liveClient(profile), args[0], {
    companyId: o["company-id"], siteId: o["site-id"], profile, healthProfiles: o["health-profiles"],
    deviceIds: o["device-ids"] == null ? undefined : o["device-ids"].split(",").map(x => x.trim()).filter(Boolean),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 3;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 2;
  });
}
