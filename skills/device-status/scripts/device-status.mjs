#!/usr/bin/env node
// Device Status: basic camera health for chosen sites (online, battery, temperature, camera,
// network, power, errors) without count or trim checks. Runs the health-report engine in its
// status mode and reuses the health monitor for schedules. Reads Zira; writes only local files.
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { idList, isMain, runCli } from "../../../scripts/client.mjs";
import { liveClient } from "../../health-report/scripts/api.mjs";
import { assertConfig } from "../../health-report/scripts/config.mjs";
import { attention } from "../../health-report/scripts/dashboard.mjs";
import { readJson, writePrivate, withLock } from "../../health-report/scripts/storage.mjs";
import * as monitor from "../../schedule-health-report/scripts/monitor.mjs";

export const DEFAULT_BATTERY_MIN = 20;

const HELP = `Device Status — basic status of every Zira camera at chosen sites
node scripts/device-status.mjs sites --company-id ID
node scripts/device-status.mjs check --company-id ID --site-ids A,B|all [--battery-min 20] [--freshness 30]
node scripts/device-status.mjs schedule --name NAME --company-id ID --site-ids A,B|all
    --frequency daily|weekdays|weekly [--day mon] --time HH:MM --timezone IANA
    [--delivery changes-only|all-runs] [--battery-min 20] [--freshness 30] [--replace]
node scripts/device-status.mjs run --name NAME
node scripts/device-status.mjs handoff --name NAME
node scripts/device-status.mjs list
node scripts/device-status.mjs remove --name NAME
Common: --profile prod|integ

check reads every camera (any vision device; forms and custom sources have no device status)
and reports whether it is online plus its battery and charging, temperature, camera on/moved,
Wi-Fi/cellular/LAN, power and device errors, then writes a dashboard. Battery below
--battery-min (default ${DEFAULT_BATTERY_MIN}%, 0 turns it off) while not charging is a warning. Status without
a current heartbeat is last known: shown and flagged for checking, never a current alert.
Repeating a check on the same scope says what changed since the last one.
schedule saves a status-only monitor and prints the host scheduler handoff; it creates no job.
Dashboards: ${"$"}ZIRA_HEALTH_REPORTS_HOME (default ~/.cache/zira/health-reports).
Exit 0 success, 2 invalid/failed, 3 incomplete coverage, 4 blocked (JSON explains).
`;

const batteryMinimum = value => monitor.batteryOption(value) ?? DEFAULT_BATTERY_MIN;
const freshnessOption = value => {
  const n = value === undefined ? 30 : Number(value);
  if (!(Number.isInteger(n) && n >= 1 && n <= 1440)) throw new Error("--freshness is 1-1440 minutes");
  return n;
};

// One folder per company and site selection, so a repeated check compares with the last one.
export function scopeKey(companyId, siteIds) {
  const sites = siteIds === "all" ? "all" : [...siteIds].sort((a, b) => a - b).join("-");
  const key = `status-${companyId}-${sites}`;
  return key.length <= 60 ? key : `status-${companyId}-${createHash("sha256").update(sites).digest("hex").slice(0, 12)}`;
}

async function authorizedSites(get, companyId, siteIds, profile) {
  const known = (await monitor.sites({ get, companyId, profile })).items;
  if (siteIds === "all") return { chosen: "all", names: ["All authorized sites"] };
  const missing = siteIds.filter(x => !known.some(k => k.id === x));
  if (!siteIds.length || missing.length) throw new Error(`Site ${missing.join(", ") || "(none)"} is not in your authorized list for company ${companyId}`);
  return { chosen: siteIds, names: siteIds.map(x => known.find(k => k.id === x).name) };
}

// Cameras to look at first, from the dashboard's own buckets, plus warnings grouped by kind.
export function digest(report, warnings) {
  const rows = attention(report).rows;
  const camera = r => ({ site: r.siteName, device: String(r.name).trim(), url: r.url,
    since: r.since, hours: r.downHours === null ? null : Math.round(r.downHours * 10) / 10 });
  // Reporting cameras first: an offline camera's warning is the last value it sent before going quiet.
  const byKind = {};
  for (const w of [...(warnings ?? [])].sort((a, b) => b.reporting - a.reporting))
    (byKind[w.code] ??= { title: w.title, cameras: [] }).cameras.push({ site: w.site, device: w.device, url: w.url, freshness: w.freshness, reporting: w.reporting });
  return {
    offlineRecently: rows.filter(r => ["new", "recent", "undated"].includes(r.bucket)).map(camera),
    warningsByKind: byKind,
    offlineLong: rows.filter(r => r.bucket === "long").map(camera),
    couldNotCheck: rows.filter(r => r.bucket === "unknown").map(camera),
    neverReported: rows.filter(r => r.bucket === "never").map(camera),
    lastKnownStatus: rows.filter(r => r.statusFreshness === "Last known").length,
    noStatus: rows.filter(r => r.statusFreshness === "Unavailable").length,
  };
}

export async function check({ get, profile = "prod", companyId, siteIds, battery = DEFAULT_BATTERY_MIN, freshness = 30,
  home = monitor.reportsHome(), engine, spawnImpl }) {
  const { chosen, names } = await authorizedSites(get, String(companyId), siteIds, profile);
  const key = scopeKey(String(companyId), chosen);
  const out = path.join(home, key);
  const f = { config: path.join(out, "config.json"), state: path.join(out, "state.json"), warnings: path.join(out, "warnings.json") };
  const config = {
    version: 1, monitorId: key, companyId: String(companyId), siteIds: chosen, checks: "status",
    statusDefaults: { batteryMinimum: battery }, freshnessMinutes: freshness, tasks: { mode: "report-only" }, devices: {},
  };
  assertConfig(config);
  return withLock(`${f.state}.check.lock`, async () => {
    await writePrivate(f.config, config);
    const ran = await monitor.runEngine({ configFile: f.config, out, state: f.state, profile, engine, spawnImpl });
    if (ran.blocked) return { ...ran.blocked, complete: false };
    const previousWarnings = await readJson(f.warnings, null);
    const s = monitor.summarize({ config, report: ran.report, result: ran.result, previousWarnings });
    await writePrivate(f.warnings, s.warnings);
    const { notify, warnings, ...rest } = s;
    return { kind: "device-status-check", companyId: String(companyId), sites: names, batteryMinimum: battery,
      firstCheck: previousWarnings === null, ...rest, ...digest(ran.report, warnings) };
  });
}

export async function run({ name, dir, home, engine, spawnImpl }) {
  const r = await monitor.run({ name, dir, home, engine, spawnImpl });
  if (!r.dashboard) return r;
  const report = await readJson(path.join(path.dirname(r.dashboard), "report.json"), {});
  const { warnings, ...rest } = r;
  return { ...rest, kind: "device-status-run", ...digest(report, warnings) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, name: { type: "string" }, "company-id": { type: "string" }, "site-ids": { type: "string" },
    frequency: { type: "string" }, day: { type: "string" }, time: { type: "string" }, timezone: { type: "string" },
    delivery: { type: "string" }, freshness: { type: "string" }, "battery-min": { type: "string" }, replace: { type: "boolean" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const siteIds = () => o["site-ids"] === "all" ? "all" : idList(o["site-ids"]);
  switch (args[0]) {
    case "sites": return monitor.sites({ get: await liveClient(profile), companyId: o["company-id"], profile });
    case "check":
      return check({ get: await liveClient(profile), profile, companyId: o["company-id"], siteIds: siteIds(),
        battery: batteryMinimum(o["battery-min"]), freshness: freshnessOption(o.freshness) });
    case "schedule": {
      if (o.delivery && !["changes-only", "all-runs"].includes(o.delivery)) throw new Error("--delivery is changes-only or all-runs");
      const made = await monitor.create({ get: await liveClient(profile), profile, name: o.name, companyId: o["company-id"], siteIds: siteIds(),
        schedule: { frequency: o.frequency, day: o.day, time: o.time, timezone: o.timezone }, delivery: o.delivery ?? "changes-only",
        freshness: freshnessOption(o.freshness), replace: !!o.replace, checks: "status", batteryMinimum: batteryMinimum(o["battery-min"]) });
      return { ...made, kind: "device-status-scheduled" };
    }
    case "run": return run({ name: o.name });
    case "handoff": return monitor.main(["handoff", "--name", o.name]);
    case "list": {
      const all = await monitor.list();
      return { kind: "device-status-monitors", items: all.items.filter(i => i.checks === "status") };
    }
    case "remove": return monitor.remove({ name: o.name });
    default: throw new Error(`Unknown command ${args[0]}; run with --help`);
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => process.env.ZIRA_PROFILE ?? "prod" });
