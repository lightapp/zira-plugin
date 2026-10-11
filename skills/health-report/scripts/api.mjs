import { statusValues } from "./status.mjs";
import { boundedFetch } from "./limits.mjs";
import { inflateSync } from "node:zlib";
import { assertConfig, id, statusOnly, timestamp } from "./config.mjs";
export async function toolkit(module = "api.js") {
  if (!["api.js", "cli.js"].includes(module))
    throw new Error("Unknown authentication module");
  return import(
    new URL(`./vendor/zira-agent-toolkit/${module}`, import.meta.url).href
  );
}
export async function liveClient(
  profileName = process.env.ZIRA_PROFILE ?? "prod",
) {
  const { ziraRequest } = await toolkit();
  const fetchLimited = boundedFetch({
    fetchImpl: (url, options) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
  });
  return async (route) => {
    const response = await ziraRequest(route, {
      profileName,
      fetchImpl: fetchLimited,
    });
    if (!response.ok)
      throw new Error(`Zira read failed (HTTP ${response.status})`);
    const text = await response.text();
    if (text.length > 32 * 1024 * 1024)
      throw new Error("API response exceeds 32 MiB cap");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON response");
    }
  };
}
export async function pages(get, route, params = {}, maxPages = 100) {
  const rows = [],
    seen = new Set();
  let cursor;
  for (let n = 0; n < maxPages; n++) {
    const q = new URLSearchParams({
      ...params,
      limit: "100",
      ...(cursor ? { lastValue: cursor } : {}),
    });
    const b = await get(`${route}?${q}`);
    if (b.data === null) return rows;
    if (!Array.isArray(b.data))
      throw new Error("List response is missing data array");
    rows.push(...b.data);
    if (!b.lastValue) return rows;
    if (seen.has(b.lastValue))
      throw new Error("Pagination cursor repeated; inventory incomplete");
    seen.add(b.lastValue);
    cursor = b.lastValue;
  }
  throw new Error("Pagination cap reached; inventory incomplete");
}
export async function discover(get, kind, companyId, siteId) {
  if (!["companies", "sites", "devices", "users"].includes(kind))
    throw new Error("Choose companies, sites, devices or users");
  if (kind !== "companies" && !id(companyId))
    throw new Error("company ID required");
  if (kind === "users") {
    if (!id(siteId))
      throw new Error("A site ID is required for assignee discovery");
    const sites = await discover(get, "sites", companyId);
    if (!sites.some((s) => s.id === siteId))
      throw new Error("Site outside selected company");
    const users = await pages(get, "/users/site-members", {
      siteIds: siteId,
      includeIndirectUsers: "true",
      includeInactive: "false",
    });
    return users
      .filter((u) => !u.isDeleted && u.isActive !== false)
      .map((u) => ({
        id: String(u.id),
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name,
        siteId,
        companyId,
      }));
  }
  let all;
  if (kind === "devices") {
    const sites = await discover(get, "sites", companyId);
    if (siteId && !sites.some(s => s.id === siteId)) throw new Error("Site outside selected company");
    all = await devicesForSites(get, companyId, siteId ? [siteId] : sites.map(s => s.id));
  } else {
    all = await pages(get, `/${kind}/list`, kind === "companies" ? {} : { companyIds: companyId });
  }
  return all
    .filter(
      (x) =>
        !x.isDeleted &&
        (kind === "companies" ||
          String(x.company?.id ?? x.companyId ?? "") === companyId),
    )
    .map((x) => ({
      id: String(x.id),
      name: x.name ?? [x.firstName, x.lastName].filter(Boolean).join(" "),
      companyId: String(x.company?.id ?? x.companyId ?? ""),
      siteId: x.site?.id ? String(x.site.id) : undefined,
      siteName: x.site?.name,
      template: x.isTemplate === true,
    }));
}
async function devicesForSites(get, companyId, siteIds) {
  if (siteIds.length > 1000) throw new Error("Select at most 1000 sites per run");
  const devices = new Map();
  for (const siteId of [...new Set(siteIds)]) {
    if (!id(siteId)) throw new Error("Invalid site ID");
    const rows = await pages(get, "/devices/list", { companyIds: companyId, siteIds: siteId });
    for (const row of rows) {
      if (String(row.company?.id) === companyId && String(row.site?.id) === siteId)
        devices.set(String(row.id), row);
    }
  }
  return [...devices.values()];
}
function numericRows(raw, maxRows) {
  let b = raw && Object.hasOwn(raw, "data") ? raw.data : raw;
  if (typeof b === "string") {
    try {
      b = JSON.parse(
        inflateSync(Buffer.from(b, "base64"), {
          maxOutputLength: 32 * 1024 * 1024,
        }).toString("utf8"),
      );
    } catch {
      throw new Error("Cannot decode bounded compressed readings");
    }
  }
  if (b === null) return [];
  if (!Array.isArray(b)) throw new Error("Unknown raw-reading response shape");
  if (b.length > maxRows)
    throw new Error("Reading cap reached; no complete assessment");
  return b;
}
const normalizeAt = (s) =>
  typeof s === "string" && /^\d{4}-\d\d-\d\dT/.test(s) && timestamp(s)
    ? new Date(s).toISOString()
    : null;
// Health-check profile from a device detail's cv.settings.PostingMode; undefined when not covered.
export const healthProfile = (settings) =>
  ({ TRIM_SAW: "trimsaw", BAND_SAW: "bandsaw", PALLET_QA: "pallet-qa" })[settings?.PostingMode];
export function normalizeDevice(list, d, config) {
  const c = d.cv ?? {},
    s = c.settings ?? {},
    raw = c.status ?? list.cvStatus ?? {};
  const mode = healthProfile(s);
  const r = config.devices?.[String(d.id)] ?? {};
  const profile = r.profileConfirmed ? r.profile : mode;
  return {
    id: String(d.id),
    name: String(d.name ?? list.name ?? d.id),
    companyId: String(d.companyId ?? list.company?.id ?? ""),
    siteId: String(d.site?.id ?? list.site?.id ?? ""),
    siteName: String(d.site?.name ?? list.site?.name ?? ""),
    profile,
    // A vision device carries a cv block; forms and custom sources have no device status.
    camera: !!(d.cv || list.cvStatus),
    identity: r.identity ?? null,
    appVersion: typeof raw.version === "string" ? raw.version : null,
    lastReadingAt: normalizeAt(d.timestamp),
    excluded:
      d.isDeleted || list.isDeleted
        ? "Deleted"
        : d.isTemplate || list.isTemplate
          ? "Template"
          : undefined,
    status: {
      ...statusValues(raw),
      lastHeartbeat: normalizeAt(raw.lastHeartbeat),
      ...(typeof raw.exception === "string" ||
      typeof raw.exception === "boolean"
        ? { exceptionReported: !!raw.exception }
        : {}),
    },
    mappingHints: {
      postingMode: s.PostingMode ?? null,
      deviceUnit: s.UOM ?? null,
      metrics: (d.meterSchema?.metrics ?? [])
        .map((m) => ({
          id: String(m.metric?.id ?? ""),
          name: m.displayName ?? m.metric?.name,
          unit: m.uom?.name,
        }))
        .filter((m) => id(m.id)),
    },
  };
}
export async function collect(
  get,
  config,
  {
    from,
    to,
    now = new Date().toISOString(),
    sourceProfile = "prod",
    maxDevices = 500,
    maxRows = 50000,
  } = {},
) {
  assertConfig(config);
  if (
    !timestamp(from) ||
    !timestamp(to) ||
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) > Date.parse(now)
  )
    throw new Error("Provide a completed UTC/offset from/to range");
  if (Date.parse(to) - Date.parse(from) > 7 * 86400000)
    throw new Error("One live raw-data run is capped at 7 days");
  const siteIds = config.siteIds === "all"
    ? (await discover(get, "sites", config.companyId)).map(s => s.id)
    : config.siteIds;
  const listed = await devicesForSites(get, config.companyId, siteIds);
  const scoped = listed.filter(
    (x) =>
      String(x.company?.id ?? "") === config.companyId &&
      (config.siteIds === "all" ||
        config.siteIds.includes(String(x.site?.id))) &&
      !x.isDeleted &&
      !x.isTemplate,
  );
  const selected = scoped.slice(0, maxDevices);
  const devices = [];
  const errors = [];
  let index = 0;
  const worker = async () => {
    while (index < selected.length) {
      const list = selected[index++];
      try {
        const d = (await get(`/devices/${list.id}`)).data;
        if (!d || String(d.id) !== String(list.id))
          throw new Error("Device detail identity mismatch");
        const normalized = normalizeDevice(list, d, config);
        if (
          normalized.companyId !== config.companyId ||
          normalized.siteId !== String(list.site?.id)
        )
          throw new Error("Device scope changed between inventory and detail");
        const rule = config.devices?.[normalized.id];
        if (
          !statusOnly(config) &&
          config.profiles.includes(normalized.profile) &&
          (rule?.counts || rule?.measurements)
        ) {
          const requestFrom =
            rule.counts?.kind === "counter"
              ? new Date(
                  Date.parse(from) - rule.counts.periodMinutes * 60000,
                ).toISOString()
              : from;
          try {
            const b = await get(
              `/analysis/data/${normalized.id}?${new URLSearchParams({ startTime: requestFrom, endTime: to, force: "true" })}`,
            );
            const raw = numericRows(b, maxRows);
            const metrics = new Set(
              [
                rule.counts?.metric,
                rule.measurements?.actualMetric,
                rule.measurements?.targetKeyMetric,
                rule.measurements?.filterMetric,
                rule.measurements?.weightMetric,
              ].filter(Boolean),
            );
            let invalid = false;
            const rows = [];
            const ids = new Set();
            for (const row of raw) {
              const at = normalizeAt(row.event_date);
              if (!at || String(row.meter_id) !== normalized.id) {
                invalid = true;
                continue;
              }
              const eventId = row["329"];
              if (eventId !== undefined && eventId !== null && eventId !== "") {
                if (ids.has(eventId)) {
                  invalid = true;
                  continue;
                }
                ids.add(eventId);
              }
              const values = Object.fromEntries(
                [...metrics].map((k) => [k, row[k] ?? null]),
              );
              rows.push({ at, values });
            }
            rows.sort((a, b) => a.at.localeCompare(b.at));
            normalized.readings = {
              from: requestFrom,
              analysisFrom: from,
              to,
              complete: !invalid,
              rows,
              source: "analysis/data",
            };
          } catch (error) {
            normalized.readings = {
              from,
              to,
              complete: false,
              rows: [],
              error:
                error.code === "HEALTH_REQUEST_LIMIT"
                  ? error.message
                  : "Raw readings request failed or exceeded cap",
            };
          }
        }
        devices.push(normalized);
      } catch (e) {
        devices.push({
          id: String(list.id),
          name: list.name,
          siteId: String(list.site?.id),
          siteName: list.site?.name,
          companyId: config.companyId,
          profile: config.devices?.[String(list.id)]?.profile,
          errors: [e.message],
          excluded: undefined,
        });
        errors.push(`Device #${list.id}: ${e.message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (scoped.length > maxDevices)
    errors.push(
      `${scoped.length - maxDevices} devices omitted by cap; inventory incomplete`,
    );
  return {
    version: 1,
    sourceProfile,
    companyId: config.companyId,
    companyName: scoped.find((x) => x.company?.name)?.company?.name ?? null,
    assessedAt: now,
    window: { from, to },
    complete: scoped.length <= maxDevices && errors.length === 0,
    errors,
    devices,
  };
}
export { agentData, dashboardWidgets } from "./dashboard-evidence.mjs";
