#!/usr/bin/env node
// Zira's generic collection from chat: gateways (collection endpoints), bindings (a data source on a
// gateway), metric maps, meter profiles, status, test reads and the back-off release, over the collection
// API (platform src/collection). Reads write nothing. Every write previews first, applies once with --apply
// under a receipt and reads back. Secret values (a database login) never pass through here: a connection
// only holds { "$secret": "<key>" } references, and secret-steps names the AWS parameter a Zira admin fills.
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "node:util";
import {
  Blocked, ZiraApiError, argValue, fingerprint, guardedWrite, id, isMain, link, liveSession, normalizeName, originFor,
  receiptsFile, resolveSite, route, runCli, text,
} from "../../../scripts/client.mjs";
import { buildInfo } from "../../../scripts/build-info.mjs";
import {
  PUBLIC_PROTOCOL, checkAddress, checkConnection, checkMaps, formats, invalid, parameterName, privateHost, protocolOf,
  safeConnection, secretRefs,
} from "./collection-formats.mjs";

const HELP = `Zira collection — connect a Modbus TCP meter or a PostgreSQL database to a data source
node scripts/collection.mjs formats [--protocol modbus_tcp|postgres]
node scripts/collection.mjs gateways --company-id ID --site-id ID
node scripts/collection.mjs status --company-id ID --site-id ID [--data-source-ids ID,...] [--binding-ids ID,...]
node scripts/collection.mjs profiles [--protocol P] [--company-id ID]
node scripts/collection.mjs profile --profile-id ID
node scripts/collection.mjs create-gateway --company-id ID --site-id ID --name TEXT --protocol P --connection JSON|@FILE
    [--poll-interval-s N] [--timeout-ms N] [--retries N] [--disabled] [--apply]
node scripts/collection.mjs update-gateway --company-id ID --site-id ID --endpoint-id ID [--name TEXT] [--connection JSON|@FILE]
    [--poll-interval-s N] [--timeout-ms N] [--retries N] [--enable|--disable] [--apply]
node scripts/collection.mjs create-binding --company-id ID --site-id ID --endpoint-id ID --data-source-id ID
    --address JSON|@FILE [--profile-id ID] [--apply]
node scripts/collection.mjs set-maps --company-id ID --site-id ID --binding-id ID --maps JSON|@FILE [--apply]
node scripts/collection.mjs update-binding --company-id ID --site-id ID --binding-id ID [--address JSON|@FILE]
    [--endpoint-id ID] [--enable|--disable] [--apply]
node scripts/collection.mjs test-read --company-id ID --site-id ID (--binding-id ID
    | --endpoint-id ID --address JSON|@FILE --maps JSON|@FILE
    | --protocol P --connection JSON|@FILE --address JSON|@FILE --maps JSON|@FILE)
node scripts/collection.mjs release --company-id ID --site-id ID --endpoint-id ID [--apply]
node scripts/collection.mjs secret-steps --company-id ID --site-id ID --endpoint-id ID
Common: --profile prod|integ, --receipts FILE

A gateway is a collection endpoint (a Modbus TCP gateway or a database); a binding connects one data
source to it; maps say where each metric is read. formats shows every format with an example: run it
first. JSON can be given inline or as @FILE (an absolute path).
Writes preview by default. --apply writes once under a receipt and reads back; repeating an applied
write returns already-done. New bindings are always created disabled; postgres gateways too.
test-read reads the meter or database once through the collector and saves nothing, but it connects
to the customer's equipment. A connection never holds a secret value: user and password are
{"$secret": "<key>"} references, and a plain value is refused before anything is sent. secret-steps
names the AWS parameter a Zira admin creates for the gateway; it takes no values.
Exit 0 success, 2 invalid/failed, 3 unverified write, 4 blocked (JSON explains).
`;

export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/all$/],
  ["GET", /^\/collection\/endpoints$/], ["POST", /^\/collection\/endpoints$/], ["PATCH", /^\/collection\/endpoints\/[1-9]\d*$/],
  ["POST", /^\/collection\/endpoints\/[1-9]\d*\/release$/],
  ["GET", /^\/collection\/bindings$/], ["GET", /^\/collection\/bindings\/[1-9]\d*$/], ["POST", /^\/collection\/bindings$/],
  ["PATCH", /^\/collection\/bindings\/[1-9]\d*$/], ["PUT", /^\/collection\/bindings\/[1-9]\d*\/metric-maps$/],
  ["GET", /^\/collection\/profiles$/], ["GET", /^\/collection\/profiles\/[1-9]\d*$/],
  ["GET", /^\/collection\/status$/], ["POST", /^\/collection\/test-read$/],
];

// Gateway timing: zira-web's endpoint form defaults, with the collector's 60-second minimum interval.
export const GATEWAY_DEFAULTS = { pollIntervalS: 60, timeoutMs: 3000, retries: 2 };
const LIMITS = { pollIntervalS: [60, 3600], timeoutMs: [100, 60000], retries: [0, 5] };
const MAX_IDS = 10;
const REGIONS = { prod: "us-west-2", integ: "eu-west-1" };

const unwrap = res => res && typeof res === "object" && "data" in res ? res.data : res;
const str = v => v === null || v === undefined ? null : String(v);
const ids = (value, option) => {
  if (value === undefined) return [];
  const list = [...new Set(String(value).split(/[\s,]+/).filter(Boolean))];
  if (!list.length || list.length > MAX_IDS || list.some(x => !id(x))) throw invalid(`${option} takes 1-${MAX_IDS} comma-separated IDs`);
  return list;
};
const needId = (value, option) => {
  if (!id(String(value ?? ""))) throw invalid(`${option} is required (an ID)`);
  return String(value);
};

function intOption(value, key, option) {
  if (value === undefined) return undefined;
  const n = Number(value), [min, max] = LIMITS[key];
  if (!/^\d+$/.test(String(value)) || n < min || n > max) throw invalid(`${option} must be a whole number between ${min} and ${max}`);
  return n;
}

// JSON given inline or as @FILE. A parse error never repeats the text: it may hold something private.
export async function jsonArg(value, option, { read = readFile } = {}) {
  if (value === undefined) return undefined;
  let raw = String(value);
  if (raw.startsWith("@")) {
    try { raw = await read(raw.slice(1), "utf8"); } catch { throw invalid(`${option}: cannot read the file ${raw.slice(1)}`); }
  }
  try { return JSON.parse(raw); } catch { throw invalid(`${option} is not valid JSON (check the quotes, commas and braces)`); }
}

// A rule the collection database refused (P0001) was rolled back: nothing was saved.
function apiRefusal(error, what) {
  if (error instanceof ZiraApiError && error.code === "P0001")
    return new Blocked("refused", `Zira refused ${what}: a collection rule was not met (one binding per data source, gateway and data source on one site, writable metrics only, or a stale version). Nothing was saved.`,
      typeof error.details === "string" ? { details: text(error.details, 500) } : {});
  if (error instanceof ZiraApiError && error.status === 500 && /UniqueConstraint/i.test(error.code ?? ""))
    return new Blocked("duplicate", `Zira refused ${what}: the same name or data source already exists. Nothing was saved.`);
  return error;
}

// The site network (VPN) a gateway is read through, or null when the collector reaches it directly.
const networkView = e => e.network || e.networkId != null
  ? { id: str(e.network?.id ?? e.networkId), name: e.network?.name ?? null, status: e.network?.status ?? null } : null;

// The networks the site's gateways already use: what the user can choose from in Zira.
const siteNetworks = rows => [...new Map(rows.map(networkView).filter(n => n && n.id).map(n => [n.id, n])).values()];

// A gateway at a private address with no network cannot be reached, and the network is chosen in Zira, not here.
// This is the hand-off: why, the page to open, what to do there, and how the work continues in chat afterwards.
export function networkStep(profile, site, e, { rows = [], dataSourceId } = {}) {
  if (!privateHost(e.connection?.host) || networkView(e)) return null;
  const known = siteNetworks(rows), usable = known.filter(n => n.status === null || n.status === "active");
  const networksUrl = site?.channelId ? link(profile, `/channels/${site.channelId}`, { tab: "network" }) : null;
  const meterUrl = dataSourceId ? link(profile, `/data-sources/${dataSourceId}`, { tab: "collection" }) : null;
  const named = usable.map(n => `"${n.name ?? `network ${n.id}`}"`).join(" or ");
  return {
    needed: true,
    why: `${e.connection.host} is a private address, so Zira reaches this gateway only through the site's network (the VPN between Zira and the plant). ` +
      "This gateway has no network yet, so reads fail until it has one.",
    siteNetworks: known,
    inZira: usable.length
      ? `This site already has ${named}. In Zira, open the meter's data source, Collection tab, choose Edit and use Change network next to the gateway. It takes a minute and needs a site admin.`
      : "This site has no network yet. In Zira, open the site's Gateways & networks tab and choose Request a network: Zira reviews the request, sets up the VPN and sends the VPN configuration for the site's device. That is done once per site, usually with the site's IT.",
    ...(networksUrl ? { networksUrl } : {}), ...(meterUrl ? { meterUrl } : {}),
    meanwhile: usable.length ? "Everything else can be prepared here first: the meter's connection and register maps."
      : "The gateway, the meter's connection and its register maps can be prepared here now, so only the test read waits for the network.",
    thenHere: "Ask the user to say when it is done. Then run gateways: when this gateway shows a network, continue with the test read. Do not ask them to repeat anything already entered.",
  };
}

// The public plugin sets up Modbus TCP meters; database collection is set up by Zira.
export function assertAvailable(command, protocol, info = buildInfo()) {
  if (info.audience !== "public") return;
  if (command === "secret-steps" || (protocol !== undefined && protocol !== PUBLIC_PROTOCOL && Object.hasOwn(formats().protocols, protocol)))
    throw new Blocked("unavailable", "Database collection is set up by Zira for now. Ask your Zira contact to connect the database; " +
      "meters over Modbus TCP can be connected here. Nothing was changed.");
}

const gatewayView = e => ({
  id: str(e.id), name: e.name ?? null, protocol: e.protocol ?? null, connection: safeConnection(e.connection ?? null),
  network: networkView(e),
  pollIntervalS: e.pollIntervalS ?? null, timeoutMs: e.timeoutMs ?? null, retries: e.retries ?? null,
  isEnabled: e.isEnabled ?? null, bindingCount: e.bindingCount ?? null, companyId: str(e.companyId), version: e.version ?? null,
});

// The gateway's last collector run, in plain words.
export function runView(run, now = Date.now()) {
  if (!run) return null;
  const next = run.nextPollAt ? Date.parse(run.nextPollAt) : NaN;
  const failures = Number(run.consecutiveFailures ?? 0);
  return {
    lastRunAt: run.lastFinishedAt ?? run.lastStartedAt ?? null, lastDurationMs: run.lastDurationMs ?? null,
    lastError: run.lastError ?? null, failuresInARow: failures, nextTryAt: run.nextPollAt ?? null,
    waiting: failures > 0 && Number.isFinite(next) && next > now,
  };
}

// One binding's state: off, not-polled-yet, ok, failing, or data-source-deleted.
export function health(row) {
  if (row.isDataSourceDeleted) return "data-source-deleted";
  if (row.isEnabled === false || row.isEndpointEnabled === false) return "off";
  if (!row.lastPollAt) return "not-polled-yet";
  if (row.lastError) return "failing";
  return row.lastOkAt ? "ok" : "failing";
}

async function endpointAt(call, site, endpointId) {
  const rows = unwrap(await call("GET", route("/collection/endpoints", { siteIds: site.id, ids: endpointId }))) ?? [];
  const row = rows.find(e => str(e.id) === endpointId);
  if (!row || str(row.siteId) !== site.id || (row.companyId != null && str(row.companyId) !== site.companyId))
    throw new Blocked("scope", `Gateway ${endpointId} is not a gateway of ${site.name} that this user can see`);
  return row;
}

async function bindingAt(call, site, bindingId) {
  const row = unwrap(await call("GET", `/collection/bindings/${bindingId}`));
  if (!row || str(row.id) !== bindingId || str(row.siteId) !== site.id)
    throw new Blocked("scope", `Binding ${bindingId} is not a binding of ${site.name} that this user can see`);
  return row;
}

const isCalculated = m => Boolean(m?.metricCalculationType?.id || /\$[0-9]+/.test(String(m?.valueExpression ?? "")));

async function dataSourceAt(call, site, dataSourceId) {
  const rows = unwrap(await call("GET", route("/devices/all", { meterIds: dataSourceId, expand: "true", onlyMeters: "false" }))) ?? [];
  const row = rows.find(d => str(d?.id) === dataSourceId);
  if (!row || row.isDeleted || row.isTemplate || str(row.site?.id) !== site.id)
    throw new Blocked("scope", `Data source ${dataSourceId} is not a data source of ${site.name} that this user can see`);
  const metrics = (row.meterSchema?.metrics ?? []).filter(m => id(str(m.metric?.id) ?? "") && !isCalculated(m) && !m.isInternal)
    .map(m => ({ metricId: str(m.metric.id), name: m.displayName ?? m.metric?.name ?? null }));
  return { id: dataSourceId, name: String(row.name ?? ""), metrics };
}

async function statusRows(call, params) {
  return unwrap(await call("GET", route("/collection/status", params))) ?? [];
}

const changesOf = (current, wanted) => Object.fromEntries(Object.entries(wanted)
  .filter(([k, v]) => v !== undefined && !isDeepStrictEqual(current[k] ?? null, v)));

const stamp = (kind, profile, rest) => ({ kind, profile, ...rest });

// ---------------------------------------------------------------------------------------------------- reads

export async function gateways({ call, profile = "prod", companyId, siteId, now = Date.now() }) {
  const site = await resolveSite(call, companyId, siteId);
  const rows = (unwrap(await call("GET", route("/collection/endpoints", { siteIds: site.id }))) ?? []).filter(e => str(e.siteId) === site.id);
  const runs = new Map();
  if (rows.length) for (const s of await statusRows(call, { siteIds: site.id })) if (s.endpointRun) runs.set(str(s.endpointId), s.endpointRun);
  return stamp("collection-gateways", profile, { site: { id: site.id, name: site.name },
    networks: siteNetworks(rows),
    gateways: rows.map(e => ({ ...gatewayView(e), ...(networkStep(profile, site, e, { rows }) ? { networkStep: networkStep(profile, site, e, { rows }) } : {}),
      lastRun: runView(runs.get(str(e.id)), now) })) });
}

export async function status({ call, profile = "prod", companyId, siteId, dataSourceIds, bindingIds, now = Date.now() }) {
  const dsIds = ids(dataSourceIds, "--data-source-ids"), bIds = ids(bindingIds, "--binding-ids");
  const site = await resolveSite(call, companyId, siteId);
  const bindings = (unwrap(await call("GET", route("/collection/bindings", { siteIds: site.id,
    ...(dsIds.length ? { dataSourceIds: dsIds.join(",") } : {}), ...(bIds.length ? { ids: bIds.join(",") } : {}) }))) ?? [])
    .filter(b => str(b.siteId) === site.id && (!dsIds.length || dsIds.includes(str(b.dataSourceId))) && (!bIds.length || bIds.includes(str(b.id))));
  const rows = bindings.length ? await statusRows(call, { siteIds: site.id, ...(bIds.length ? { bindingIds: bIds.join(",") } : {}) }) : [];
  const byBinding = new Map(rows.map(s => [str(s.bindingId), s]));
  const items = bindings.map(b => {
    const s = byBinding.get(str(b.id)) ?? {};
    const row = { ...s, isEnabled: b.isEnabled, isDataSourceDeleted: b.isDataSourceDeleted ?? s.isDataSourceDeleted };
    return {
      bindingId: str(b.id), dataSource: { id: str(b.dataSourceId), name: b.dataSourceName ?? null },
      gateway: { id: str(b.endpointId), name: b.endpointName ?? null, protocol: b.protocol ?? null, isEnabled: s.isEndpointEnabled ?? null },
      address: b.address ?? null, isEnabled: b.isEnabled ?? null, maps: b.metricMapCount ?? null,
      profile: b.profile ? { id: str(b.profile.id), name: b.profile.name ?? null, version: b.profile.version ?? null } : null,
      health: health(row), lastPollAt: s.lastPollAt ?? null, lastOkAt: s.lastOkAt ?? null, lastError: s.lastError ?? null,
      failedMetrics: s.failedMetrics ?? null, gatewayRun: runView(s.endpointRun, now),
      ...(b.isDataSourceDeleted ? { link: null } : { link: link(profile, `/data-sources/${b.dataSourceId}`) }),
    };
  });
  const missing = dsIds.filter(d => !bindings.some(b => str(b.dataSourceId) === d));
  return stamp("collection-status", profile, { site: { id: site.id, name: site.name }, bindings: items,
    ...(missing.length ? { noBinding: missing } : {}),
    note: "Only health \"ok\" with a recent lastOkAt shows the collector saved a reading. Polls run every minute at most; check again a few minutes after a change." });
}

export async function profiles({ call, profile = "prod", protocol, companyId }) {
  if (protocol !== undefined) protocolOf(protocol);
  if (companyId !== undefined && !id(companyId)) throw invalid("--company-id must be an ID");
  const rows = unwrap(await call("GET", route("/collection/profiles", { protocol, companyId }))) ?? [];
  return stamp("collection-profiles", profile, { profiles: rows.filter(p => p.isLatest !== false).map(p => ({
    id: str(p.id), name: p.name ?? null, manufacturer: p.manufacturer ?? null, model: p.model ?? null, protocol: p.protocol ?? null,
    version: p.version ?? null, scope: p.isGlobal || p.companyId == null ? "all companies" : `company ${p.companyId}`,
    templateId: str(p.templateId), maps: p.mapCount ?? null })) });
}

export async function profileDetail({ call, profile = "prod", profileId }) {
  const pid = needId(profileId, "--profile-id");
  const p = unwrap(await call("GET", `/collection/profiles/${pid}`));
  if (!p || str(p.id) !== pid) throw new Blocked("not_found", `Profile ${pid} is not visible to this user`);
  return stamp("collection-profile", profile, { profile: { id: pid, name: p.name ?? null, manufacturer: p.manufacturer ?? null, model: p.model ?? null,
    protocol: p.protocol ?? null, version: p.version ?? null, scope: p.isGlobal || p.companyId == null ? "all companies" : `company ${p.companyId}`,
    templateId: str(p.templateId) },
    maps: (p.maps ?? []).map(m => ({ metricId: str(m.metricId), metricKey: m.metricKey ?? null, metricName: m.metricName ?? null,
      source: m.source, scale: m.scale ?? 1, valueOffset: m.valueOffset ?? 0 })) });
}

export async function secretSteps({ call, profile = "prod", companyId, siteId, endpointId }) {
  const eid = needId(endpointId, "--endpoint-id");
  const site = await resolveSite(call, companyId, siteId);
  const e = await endpointAt(call, site, eid);
  return stamp("collection-secret-steps", profile, secretPlan(profile, e));
}

function secretPlan(profile, e) {
  const refs = secretRefs(e.connection ?? null);
  const gateway = { id: str(e.id), name: e.name ?? null, protocol: e.protocol ?? null, isEnabled: e.isEnabled ?? null };
  if (!refs.length) return { gateway, needed: false, message: "This gateway's connection refers to no secret values; nothing is needed from an admin." };
  const keys = [...new Set(refs.map(r => r.key))];
  return {
    gateway, needed: true,
    parameter: { name: parameterName(str(e.companyId), str(e.id)), type: "SecureString", encryption: "the default aws/ssm key", region: REGIONS[profile] },
    keys, references: refs,
    valueShape: Object.fromEntries(keys.map(k => [k, `<${k}>`])),
    forTheAdmin: `Please create the AWS Systems Manager Parameter Store parameter ${parameterName(str(e.companyId), str(e.id))} in ${REGIONS[profile]} ` +
      `(type SecureString, default aws/ssm key). Its value is one JSON object with the keys ${keys.join(" and ")}, for example ` +
      `${JSON.stringify(Object.fromEntries(keys.map(k => [k, "..."])))}. Use a database user that can only read what the queries need. Tell me when it exists.`,
    rules: "Never send the values in chat or in a command. Wait for the admin's confirmation, then run a test read.",
  };
}

// --------------------------------------------------------------------------------------------------- writes

const writeOptions = ({ apply = false, receipts }) => ({ apply, receipts });

const siteGateways = async (call, site) =>
  (unwrap(await call("GET", route("/collection/endpoints", { siteIds: site.id }))) ?? []).filter(e => str(e.siteId) === site.id);
const sameName = (rows, name) => rows.filter(e => normalizeName(e.name) === normalizeName(name)).map(e => ({ id: str(e.id), name: e.name }));
const sameNameGateways = async (call, site, name) => sameName(await siteGateways(call, site), name);

export async function createGateway({ call, profile = "prod", companyId, siteId, name, protocol, connection, pollIntervalS, timeoutMs, retries,
  disabled = false, ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const gatewayName = text(name ?? "", 120);
  if (!gatewayName) throw invalid("--name is required");
  protocolOf(protocol);
  if (connection === undefined) throw invalid("--connection is required; run formats for its format");
  checkConnection(protocol, connection);
  const timing = {
    pollIntervalS: intOption(pollIntervalS, "pollIntervalS", "--poll-interval-s") ?? GATEWAY_DEFAULTS.pollIntervalS,
    timeoutMs: intOption(timeoutMs, "timeoutMs", "--timeout-ms") ?? GATEWAY_DEFAULTS.timeoutMs,
    retries: intOption(retries, "retries", "--retries") ?? GATEWAY_DEFAULTS.retries,
  };
  const site = await resolveSite(call, companyId, siteId);
  // A gateway with secret references waits for its parameter: it is always created disabled.
  const needsSecrets = secretRefs(connection).length > 0;
  const isEnabled = !(disabled || needsSecrets);
  const body = { siteId: site.id, name: gatewayName, protocol, connection, ...timing, isEnabled };
  const existing = await siteGateways(call, site);
  const duplicates = sameName(existing, gatewayName);
  const step = networkStep(profile, site, { connection }, { rows: existing });
  const preview = { site: { id: site.id, name: site.name }, gateway: { ...body, connection: safeConnection(connection) },
    ...(step ? { networkStep: step } : {}),
    ...(needsSecrets ? { secrets: `Created disabled: it refers to secret values (${secretRefs(connection).map(r => r.key).join(", ")}). After it is created, secret-steps names the AWS parameter a Zira admin must create.` } : {}) };
  if (!apply) {
    if (duplicates.length) throw new Blocked("duplicate", `A gateway named "${gatewayName}" already exists in ${site.name}. Reuse it or choose another name.`, { duplicates });
    return stamp("collection-gateway-draft", profile, { applied: false, preview, next: "Show this preview; after the user approves it, rerun with --apply." });
  }
  const key = fingerprint({ op: "collection-gateway", profile, siteId: site.id, name: normalizeName(gatewayName) });
  const outcome = await guardedWrite({
    file: receipts, key, resolveField: "endpointId",
    summary: { kind: "collection-gateway", siteId: site.id, name: gatewayName, protocol },
    precheck: async () => {
      const current = await sameNameGateways(call, site, gatewayName);
      if (current.length) throw new Blocked("duplicate", `A gateway named "${gatewayName}" already exists in ${site.name}. Reuse it or choose another name.`, { duplicates: current });
    },
    reconcile: async () => {
      const found = await sameNameGateways(call, site, gatewayName);
      return found.length === 1 ? { endpointId: found[0].id } : null;
    },
    run: async progress => {
      let created;
      try { created = unwrap(await call("POST", "/collection/endpoints", body)); } catch (error) { throw apiRefusal(error, "this gateway"); }
      const endpointId = str(created?.id);
      if (!id(endpointId ?? "")) throw new Error("Zira returned no gateway ID; run gateways before trying again");
      await progress({ endpointId });
      let saved = null;
      try { saved = await endpointAt(call, site, endpointId); } catch { /* reported as unverified */ }
      const verified = !!saved && saved.protocol === protocol && normalizeName(saved.name) === normalizeName(gatewayName) &&
        isDeepStrictEqual(saved.connection, connection) && saved.isEnabled === isEnabled;
      return { receipt: { endpointId }, endpointId, saved, verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-gateway", profile, { applied: false, state: outcome.state, endpointId: outcome.receipt.endpointId,
      message: "This gateway was already created; nothing new was written. Run gateways to see it." });
  const saved = outcome.saved;
  return stamp("collection-gateway", profile, { applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    endpointId: outcome.endpointId, gateway: saved ? gatewayView(saved) : null,
    ...(needsSecrets && saved ? { secretSteps: secretPlan(profile, saved) } : {}),
    ...(step ? { networkStep: step } : {}),
    next: needsSecrets ? "Give the user secretSteps.forTheAdmin to pass to a Zira admin, and wait for the admin's confirmation before any test read."
      : step ? "Create the binding for the data source (create-binding) and its maps now. Then give the user networkStep (its links and what to do in Zira), wait until they say it is done, check gateways, and only then test read."
      : "Create the binding for the data source (create-binding), then its maps, then a test read." });
}

export async function updateGateway({ call, profile = "prod", companyId, siteId, endpointId, name, connection, pollIntervalS, timeoutMs, retries,
  enable, disable, ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const eid = needId(endpointId, "--endpoint-id");
  if (enable && disable) throw invalid("Choose --enable or --disable, not both");
  const site = await resolveSite(call, companyId, siteId);
  const e = await endpointAt(call, site, eid);
  if (connection !== undefined) checkConnection(e.protocol, connection);
  const wanted = {
    name: name === undefined ? undefined : text(name, 120) || (() => { throw invalid("--name cannot be empty"); })(),
    connection,
    pollIntervalS: intOption(pollIntervalS, "pollIntervalS", "--poll-interval-s"),
    timeoutMs: intOption(timeoutMs, "timeoutMs", "--timeout-ms"),
    retries: intOption(retries, "retries", "--retries"),
    isEnabled: enable ? true : disable ? false : undefined,
  };
  if (Object.values(wanted).every(v => v === undefined)) throw invalid("Give at least one change: --name, --connection, --poll-interval-s, --timeout-ms, --retries, --enable or --disable");
  const changes = changesOf(e, wanted);
  const shown = v => v && typeof v === "object" ? safeConnection(v) : v;
  const preview = { gateway: gatewayView(e), changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { before: shown(e[k] ?? null), after: shown(v) }])),
    ...(changes.isEnabled === true && secretRefs(changes.connection ?? e.connection).length ? { warning: "Enable it only after the admin confirmed its secret parameter exists and a test read worked." } : {}) };
  if (!Object.keys(changes).length) return stamp("collection-gateway-update", profile, { applied: false, state: "unchanged", gateway: gatewayView(e), message: "The gateway already has these values; nothing to write." });
  if (!apply) return stamp("collection-gateway-update-draft", profile, { applied: false, preview, next: "Show the before → after; after the user approves it, rerun with --apply." });
  const key = fingerprint({ op: "collection-gateway-update", profile, endpointId: eid, version: e.version ?? null, changes });
  const outcome = await guardedWrite({
    file: receipts, key, summary: { kind: "collection-gateway-update", endpointId: eid, keys: Object.keys(changes) },
    run: async () => {
      try { await call("PATCH", `/collection/endpoints/${eid}`, changes); } catch (error) { throw apiRefusal(error, "this gateway change"); }
      let saved = null;
      try { saved = await endpointAt(call, site, eid); } catch { /* unverified */ }
      const verified = !!saved && Object.entries(changes).every(([k, v]) => isDeepStrictEqual(saved[k], v));
      return { receipt: { endpointId: eid }, saved, verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-gateway-update", profile, { applied: false, state: outcome.state, message: "This change was already applied; nothing new was written." });
  return stamp("collection-gateway-update", profile, { applied: true, state: outcome.verified ? "updated" : "unverified", verified: outcome.verified,
    preview, gateway: outcome.saved ? gatewayView(outcome.saved) : null });
}

async function bindingForDataSource(call, site, dataSourceId) {
  return (unwrap(await call("GET", route("/collection/bindings", { dataSourceIds: dataSourceId }))) ?? [])
    .filter(b => str(b.dataSourceId) === dataSourceId);
}

const bindingView = b => ({
  id: str(b.id), dataSource: { id: str(b.dataSourceId), name: b.dataSourceName ?? null },
  gateway: { id: str(b.endpointId), name: b.endpointName ?? null }, protocol: b.protocol ?? null, address: b.address ?? null,
  isEnabled: b.isEnabled ?? null, version: b.version ?? null, maps: b.metricMapCount ?? b.metricMaps?.length ?? null,
  profile: b.profile ? { id: str(b.profile.id), name: b.profile.name ?? null, version: b.profile.version ?? null } : null,
});

export async function createBinding({ call, profile = "prod", companyId, siteId, endpointId, dataSourceId, address, profileId, ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const eid = needId(endpointId, "--endpoint-id"), dsId = needId(dataSourceId, "--data-source-id");
  const pid = profileId === undefined ? null : needId(profileId, "--profile-id");
  if (address === undefined) throw invalid("--address is required; run formats for its format");
  const site = await resolveSite(call, companyId, siteId);
  const e = await endpointAt(call, site, eid);
  checkAddress(e.protocol, address);
  const ds = await dataSourceAt(call, site, dsId);
  let chosen = null;
  if (pid) {
    const p = unwrap(await call("GET", `/collection/profiles/${pid}`));
    if (!p || str(p.id) !== pid) throw new Blocked("not_found", `Profile ${pid} is not visible to this user`);
    if (p.protocol !== e.protocol) throw invalid(`Profile ${p.name ?? pid} is for ${p.protocol}, but the gateway uses ${e.protocol}`);
    chosen = { id: pid, name: p.name ?? null, version: p.version ?? null, maps: (p.maps ?? []).length };
  }
  const taken = rows => new Blocked("duplicate", `${ds.name} already has a binding (${rows[0].id}); a data source has one binding. Change it with update-binding or set-maps.`,
    { existing: rows.map(bindingView) });
  const body = { endpointId: eid, dataSourceId: dsId, address, isEnabled: false, ...(pid ? { profileId: pid } : {}) };
  const preview = { site: { id: site.id, name: site.name }, gateway: gatewayView(e), dataSource: { id: ds.id, name: ds.name }, address,
    profile: chosen, isEnabled: false, writableMetrics: ds.metrics,
    note: chosen ? "The profile's maps are copied in; metrics the data source does not have are skipped and listed." : "It starts with no maps: add them with set-maps." };
  if (!apply) {
    const existing = await bindingForDataSource(call, site, dsId);
    if (existing.length) throw taken(existing);
    return stamp("collection-binding-draft", profile, { applied: false, preview, next: "Show this preview; after the user approves it, rerun with --apply." });
  }
  const key = fingerprint({ op: "collection-binding", profile, dataSourceId: dsId, endpointId: eid, address, profileId: pid });
  const outcome = await guardedWrite({
    file: receipts, key, resolveField: "bindingId",
    summary: { kind: "collection-binding", dataSourceId: dsId, endpointId: eid },
    precheck: async () => {
      const current = await bindingForDataSource(call, site, dsId);
      if (current.length) throw taken(current);
    },
    reconcile: async () => {
      const found = await bindingForDataSource(call, site, dsId);
      return found.length === 1 ? { bindingId: str(found[0].id) } : null;
    },
    run: async progress => {
      let created;
      try { created = unwrap(await call("POST", "/collection/bindings", body)); } catch (error) { throw apiRefusal(error, "this binding"); }
      const bindingId = str(created?.id);
      if (!id(bindingId ?? "")) throw new Error("Zira returned no binding ID; run status before trying again");
      await progress({ bindingId });
      let saved = null;
      try { saved = await bindingAt(call, site, bindingId); } catch { /* unverified */ }
      const verified = !!saved && str(saved.dataSourceId) === dsId && str(saved.endpointId) === eid && saved.isEnabled === false &&
        isDeepStrictEqual(saved.address, address);
      return { receipt: { bindingId }, bindingId, saved, skipped: created?.skippedMetricIds ?? [], verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-binding", profile, { applied: false, state: outcome.state, bindingId: outcome.receipt.bindingId,
      message: "This binding was already created; nothing new was written. Run status to see it." });
  return stamp("collection-binding", profile, { applied: true, state: outcome.verified ? "created" : "unverified", verified: outcome.verified,
    bindingId: outcome.bindingId, binding: outcome.saved ? bindingView(outcome.saved) : null,
    ...(outcome.skipped.length ? { skippedMetricIds: outcome.skipped.map(String), skippedNote: "The profile maps these metrics, but the data source does not have them; they were not copied." } : {}),
    next: "It is disabled. Check its maps (set-maps if needed), run a test read, then enable it with update-binding --enable." });
}

// Stored JSON (jsonb) does not keep key order, so maps compare with sorted keys.
const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const mapKey = m => JSON.stringify([str(m.metricId), canonical(m.source), Number(m.scale ?? 1), Number(m.valueOffset ?? 0), m.isEnabled ?? true]);
const sameMaps = (a, b) => a.length === b.length && isDeepStrictEqual(a.map(mapKey).sort(), b.map(mapKey).sort());

export async function setMaps({ call, profile = "prod", companyId, siteId, bindingId, maps, ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const bid = needId(bindingId, "--binding-id");
  if (maps === undefined) throw invalid("--maps is required; run formats for its format");
  const site = await resolveSite(call, companyId, siteId);
  const b = await bindingAt(call, site, bid);
  const wanted = checkMaps(b.protocol, maps);
  const version = Number(b.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("The binding has no version; open it in Zira");
  const current = (b.metricMaps ?? []).map(m => ({ metricId: str(m.metricId), name: m.metricName ?? null, source: m.source,
    scale: m.scale ?? 1, valueOffset: m.valueOffset ?? 0, isEnabled: m.isEnabled ?? true }));
  const names = new Map(current.map(m => [m.metricId, m.name]));
  const preview = { binding: bindingView(b), before: current, after: wanted.map(m => ({ ...m, name: names.get(m.metricId) ?? null })),
    note: "These maps replace all of the binding's maps. Whether the binding is on or off does not change." };
  if (sameMaps(current, wanted)) return stamp("collection-maps", profile, { applied: false, state: "unchanged", binding: bindingView(b), message: "The binding already has exactly these maps; nothing to write." });
  if (!apply) return stamp("collection-maps-draft", profile, { applied: false, preview, next: "Show the maps; after the user approves them, rerun with --apply." });
  const key = fingerprint({ op: "collection-maps", profile, bindingId: bid, version, maps: wanted });
  const outcome = await guardedWrite({
    file: receipts, key, summary: { kind: "collection-maps", bindingId: bid, version, count: wanted.length },
    run: async () => {
      let res;
      try { res = unwrap(await call("PUT", `/collection/bindings/${bid}/metric-maps`, { version, maps: wanted })); } catch (error) { throw apiRefusal(error, "these maps"); }
      let saved = null;
      try { saved = await bindingAt(call, site, bid); } catch { /* unverified */ }
      const verified = !!saved && sameMaps(saved.metricMaps ?? [], wanted);
      return { receipt: { bindingId: bid, version: res?.version ?? null }, saved, verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-maps", profile, { applied: false, state: outcome.state, message: "These maps were already saved; nothing new was written." });
  return stamp("collection-maps", profile, { applied: true, state: outcome.verified ? "updated" : "unverified", verified: outcome.verified,
    binding: outcome.saved ? bindingView(outcome.saved) : null, maps: wanted.length,
    next: "Run a test read (test-read --binding-id) before enabling the binding." });
}

export async function updateBinding({ call, profile = "prod", companyId, siteId, bindingId, address, endpointId, enable, disable, ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const bid = needId(bindingId, "--binding-id");
  if (enable && disable) throw invalid("Choose --enable or --disable, not both");
  const eid = endpointId === undefined ? undefined : needId(endpointId, "--endpoint-id");
  if (address === undefined && eid === undefined && !enable && !disable) throw invalid("Give at least one change: --address, --endpoint-id, --enable or --disable");
  const site = await resolveSite(call, companyId, siteId);
  const b = await bindingAt(call, site, bid);
  let target = null;
  if (eid !== undefined && eid !== str(b.endpointId)) {
    target = await endpointAt(call, site, eid);
    if (target.protocol !== b.protocol) throw invalid(`A binding moves only to a gateway with the same protocol (${b.protocol}); gateway ${eid} uses ${target.protocol}`);
  }
  if (address !== undefined) checkAddress(b.protocol, address);
  const changes = changesOf({ ...b, endpointId: str(b.endpointId) }, { endpointId: eid, address, isEnabled: enable ? true : disable ? false : undefined });
  const warnings = [];
  if (changes.isEnabled === true && !(b.metricMapCount ?? b.metricMaps?.length)) warnings.push("The binding has no maps: it will read nothing until set-maps adds them.");
  if (changes.isEnabled === true) {
    const gateway = target ?? await endpointAt(call, site, str(b.endpointId));
    if (gateway.isEnabled === false) warnings.push(`Its gateway ${gateway.name ?? gateway.id} is off: nothing is collected until update-gateway --enable.`);
  }
  const preview = { binding: bindingView(b), changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { before: k === "endpointId" ? str(b.endpointId) : b[k] ?? null, after: v }])), warnings };
  if (!Object.keys(changes).length) return stamp("collection-binding-update", profile, { applied: false, state: "unchanged", binding: bindingView(b), message: "The binding already has these values; nothing to write." });
  if (!apply) return stamp("collection-binding-update-draft", profile, { applied: false, preview, next: "Show the before → after; after the user approves it, rerun with --apply." });
  const key = fingerprint({ op: "collection-binding-update", profile, bindingId: bid, version: b.version ?? null, changes });
  const outcome = await guardedWrite({
    file: receipts, key, summary: { kind: "collection-binding-update", bindingId: bid, keys: Object.keys(changes) },
    run: async () => {
      try { await call("PATCH", `/collection/bindings/${bid}`, changes); } catch (error) { throw apiRefusal(error, "this binding change"); }
      let saved = null;
      try { saved = await bindingAt(call, site, bid); } catch { /* unverified */ }
      const verified = !!saved && Object.entries(changes).every(([k, v]) => isDeepStrictEqual(k === "endpointId" ? str(saved[k]) : saved[k], v));
      return { receipt: { bindingId: bid }, saved, verified };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-binding-update", profile, { applied: false, state: outcome.state, message: "This change was already applied; nothing new was written." });
  return stamp("collection-binding-update", profile, { applied: true, state: outcome.verified ? "updated" : "unverified", verified: outcome.verified,
    preview, binding: outcome.saved ? bindingView(outcome.saved) : null,
    ...(changes.isEnabled === true ? { next: "Run status in a few minutes: only a successful poll (health ok, lastOkAt) shows it is collecting." } : {}) });
}

// One real read through the collector; nothing is saved. Three forms, as the API takes them.
export async function testRead({ call, profile = "prod", companyId, siteId, bindingId, endpointId, protocol, connection, address, maps }) {
  const site = await resolveSite(call, companyId, siteId);
  let body, names = new Map(), form, gateway = null, dataSourceId;
  if (bindingId !== undefined) {
    if ([endpointId, protocol, connection, address, maps].some(v => v !== undefined)) throw invalid("--binding-id reads the saved binding as it is; give no other gateway, address or maps options with it");
    const bid = needId(bindingId, "--binding-id");
    const b = await bindingAt(call, site, bid);
    names = new Map((b.metricMaps ?? []).map(m => [str(m.metricId), m.metricName ?? null]));
    body = { bindingId: bid }; form = "saved binding"; gateway = { id: str(b.endpointId) }; dataSourceId = id(str(b.dataSourceId) ?? "") ? str(b.dataSourceId) : undefined;
  } else if (endpointId !== undefined) {
    if (protocol !== undefined || connection !== undefined) throw invalid("Use --endpoint-id (a saved gateway) or --protocol with --connection (a typed gateway), not both");
    const eid = needId(endpointId, "--endpoint-id");
    if (address === undefined || maps === undefined) throw invalid("--endpoint-id needs --address and --maps");
    const e = await endpointAt(call, site, eid);
    checkAddress(e.protocol, address);
    body = { endpointId: eid, address, maps: checkMaps(e.protocol, maps) }; form = "saved gateway"; gateway = e;
  } else {
    if (protocol === undefined || connection === undefined || address === undefined || maps === undefined)
      throw invalid("Give --binding-id, or --endpoint-id with --address and --maps, or --protocol, --connection, --address and --maps");
    checkConnection(protocol, connection);
    if (secretRefs(connection).length)
      throw invalid("A gateway with secret references can only be test-read once it is saved: its values are stored under the gateway's ID. Create it first (create-gateway; it is created disabled), then test with --endpoint-id.");
    checkAddress(protocol, address);
    body = { siteId: site.id, protocol, connection, address, maps: checkMaps(protocol, maps) }; form = "typed gateway"; gateway = { connection };
  }
  const r = unwrap(await call("POST", "/collection/test-read", body)) ?? {};
  const metrics = (r.metrics ?? []).map(m => ({ metricId: str(m.metricId), name: names.get(str(m.metricId)) ?? null, raw: m.raw ?? null, value: m.value ?? null, error: m.error ?? null }));
  const failed = metrics.filter(m => m.error).length;
  const error = r.error ?? null;
  const hints = [];
  if (error && /unknown protocol/i.test(error)) hints.push(`The collector has no driver for ${r.protocol ?? protocol ?? "this protocol"} yet: that part of Zira is not deployed. Say so; do not retry.`);
  // A failed read of a gateway that still has no network: say what to do in Zira instead of guessing at the meter.
  let step = null;
  if (error || failed) {
    try {
      const rows = await siteGateways(call, site);
      const e = gateway?.connection ? gateway : rows.find(r => str(r.id) === gateway?.id);
      if (e) step = networkStep(profile, site, e, { rows, dataSourceId });
    } catch { /* the read's own error is reported */ }
    if (step) hints.push("This gateway has no network yet: that is the most likely cause. Give the user networkStep (the links and what to do in Zira), wait until they say it is done, then test again.");
  }
  if (error && /parameter|secret/i.test(error)) hints.push("The gateway's secret parameter is missing, incomplete or unreadable: ask the Zira admin to check it (secret-steps gives its name and keys). Never ask for the values.");
  return stamp("collection-test-read", profile, { form, ok: !error && metrics.length > 0 && !failed, error, durationMs: r.durationMs ?? null,
    protocol: r.protocol ?? null, read: metrics.length - failed, failed, metrics, ...(hints.length ? { hints } : {}), ...(step ? { networkStep: step } : {}),
    note: "One read through the collector. Nothing was saved or posted to Zira." });
}

export async function release({ call, profile = "prod", companyId, siteId, endpointId, now = Date.now(), ...rest }) {
  const { apply, receipts } = writeOptions(rest);
  const eid = needId(endpointId, "--endpoint-id");
  const site = await resolveSite(call, companyId, siteId);
  const e = await endpointAt(call, site, eid);
  const runOf = async () => (await statusRows(call, { endpointIds: eid })).find(s => str(s.endpointId) === eid && s.endpointRun)?.endpointRun ?? null;
  const run = await runOf();
  const view = runView(run, now);
  const preview = { gateway: gatewayView(e), lastRun: view,
    effect: "Ends the waiting time: the collector tries this gateway again within a minute. Fix the cause first, and test-read it." };
  if (!view?.waiting)
    return stamp("collection-release", profile, { applied: false, state: "not-needed", preview,
      message: view ? "The gateway is not waiting after failures; it is tried at its normal interval. Nothing to release." : "The collector has not run this gateway yet; nothing to release." });
  if (!apply) return stamp("collection-release-draft", profile, { applied: false, preview, next: "Show this; after the user approves it, rerun with --apply." });
  const key = fingerprint({ op: "collection-release", profile, endpointId: eid, nextTryAt: view.nextTryAt, failures: view.failuresInARow, lastRunAt: view.lastRunAt });
  const outcome = await guardedWrite({
    file: receipts, key, summary: { kind: "collection-release", endpointId: eid, failures: view.failuresInARow },
    run: async () => {
      let res;
      try { res = unwrap(await call("POST", `/collection/endpoints/${eid}/release`, {})); } catch (error) {
        if (error instanceof ZiraApiError && error.status === 404)
          throw new Blocked("not_deployed", "Zira has no release for gateways yet (HTTP 404): that part of the collection service is not deployed. Nothing was changed; do not retry.");
        throw apiRefusal(error, "the release");
      }
      let after = null;
      try { after = runView(await runOf(), now); } catch { /* reported below */ }
      return { receipt: { endpointId: eid, released: res?.released ?? null }, released: res?.released ?? null, after };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return stamp("collection-release", profile, { applied: false, state: outcome.state, message: "This back-off was already released; nothing new was sent. Run status to see the next try." });
  return stamp("collection-release", profile, { applied: true, state: outcome.released === true ? "released" : outcome.released === false ? "already-due" : "unverified",
    released: outcome.released, before: view, after: outcome.after,
    next: "The collector tries it within a minute. Run status in a few minutes; only a successful poll shows it collects again." });
}

// ---------------------------------------------------------------------------------------------------- CLI

const COMMANDS = ["formats", "gateways", "status", "profiles", "profile", "create-gateway", "update-gateway", "create-binding", "set-maps",
  "update-binding", "test-read", "release", "secret-steps"];

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const command = args[0];
  if (!COMMANDS.includes(command)) throw invalid(`Choose ${COMMANDS.join(", ")}`);
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, "endpoint-id": { type: "string" }, "binding-id": { type: "string" },
    "data-source-id": { type: "string" }, "profile-id": { type: "string" }, "data-source-ids": { type: "string" }, "binding-ids": { type: "string" },
    name: { type: "string" }, protocol: { type: "string" }, connection: { type: "string" }, address: { type: "string" }, maps: { type: "string" },
    "poll-interval-s": { type: "string" }, "timeout-ms": { type: "string" }, retries: { type: "string" },
    disabled: { type: "boolean" }, enable: { type: "boolean" }, disable: { type: "boolean" },
    apply: { type: "boolean" }, receipts: { type: "string" }, profile: { type: "string" },
  } });
  const info = buildInfo();
  assertAvailable(command, o.protocol, info);
  if (command === "formats") return formats(o.protocol, { publicBuild: info.audience === "public" });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  // Parse JSON options before signing in, so a refused value is never sent anywhere.
  const json = {
    connection: await jsonArg(o.connection, "--connection"), address: await jsonArg(o.address, "--address"), maps: await jsonArg(o.maps, "--maps"),
  };
  if (json.connection !== undefined && o.protocol !== undefined) checkConnection(o.protocol, json.connection);
  const call = await liveSession(profile, { allow: ROUTES, maxRequests: 30 });
  const scope = { call, profile, companyId: o["company-id"], siteId: o["site-id"] };
  const write = { apply: !!o.apply, receipts: receiptsFile(o.receipts) };
  const timing = { pollIntervalS: o["poll-interval-s"], timeoutMs: o["timeout-ms"], retries: o.retries };
  switch (command) {
    case "gateways": return gateways(scope);
    case "status": return status({ ...scope, dataSourceIds: o["data-source-ids"], bindingIds: o["binding-ids"] });
    case "profiles": return profiles({ call, profile, protocol: o.protocol, companyId: o["company-id"] });
    case "profile": return profileDetail({ call, profile, profileId: o["profile-id"] });
    case "secret-steps": return secretSteps({ ...scope, endpointId: o["endpoint-id"] });
    case "create-gateway": return createGateway({ ...scope, name: o.name, protocol: o.protocol, connection: json.connection, ...timing, disabled: !!o.disabled, ...write });
    case "update-gateway": return updateGateway({ ...scope, endpointId: o["endpoint-id"], name: o.name, connection: json.connection, ...timing,
      enable: !!o.enable, disable: !!o.disable, ...write });
    case "create-binding": return createBinding({ ...scope, endpointId: o["endpoint-id"], dataSourceId: o["data-source-id"], address: json.address,
      profileId: o["profile-id"], ...write });
    case "set-maps": return setMaps({ ...scope, bindingId: o["binding-id"], maps: json.maps, ...write });
    case "update-binding": return updateBinding({ ...scope, bindingId: o["binding-id"], address: json.address, endpointId: o["endpoint-id"],
      enable: !!o.enable, disable: !!o.disable, ...write });
    case "test-read": return testRead({ ...scope, bindingId: o["binding-id"], endpointId: o["endpoint-id"], protocol: o.protocol,
      connection: json.connection, address: json.address, maps: json.maps });
    default: return release({ ...scope, endpointId: o["endpoint-id"], ...write });
  }
}

// A blocked step continues on the data source's page in Zira when one is named.
function handoffInfo() {
  const ds = argValue("data-source-id");
  const profile = ["prod", "integ"].includes(argValue("profile") ?? "prod") ? argValue("profile") ?? "prod" : "prod";
  return id(ds ?? "") ? { pageUrl: link(profile, `/data-sources/${ds}`), details: "The data source's Collection tab in Zira shows the same settings." } : undefined;
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod", handoffInfo });
