#!/usr/bin/env node
// Scheduled Health Report: saves a fleet health monitor for selected sites (one company),
// runs it with the health-report engine and hands its timing to the host scheduler.
// Reads Zira only; the monitor, its state and its dashboards stay on this computer.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { idList, isMain, runCli } from "../../../scripts/client.mjs";
import { browse } from "../../../scripts/browse.mjs";
import { JOB_NAME, checkSchedule, hostCron, nextRun } from "../../../scripts/schedules.mjs";
import { liveClient } from "../../health-report/scripts/api.mjs";
import { PROFILES, assertConfig, statusOnly } from "../../health-report/scripts/config.mjs";
import { statusWarnings } from "../../health-report/scripts/status.mjs";
import { readJson, writePrivate } from "../../health-report/scripts/storage.mjs";

const ENGINE = fileURLToPath(new URL("../../health-report/scripts/health-report.mjs", import.meta.url));

const HELP = `Scheduled Health Report — recurring fleet health reports for selected Zira sites
node scripts/monitor.mjs sites --company-id ID
node scripts/monitor.mjs create --name NAME --company-id ID --site-ids A,B|all
    --frequency daily|weekdays|weekly [--day mon] --time HH:MM --timezone IANA
    [--profiles trimsaw,bandsaw,pallet-qa] [--delivery changes-only|all-runs] [--freshness 30] [--replace]
    [--checks full|status] [--battery-min 20]
node scripts/monitor.mjs run --name NAME
node scripts/monitor.mjs handoff --name NAME
node scripts/monitor.mjs list
node scripts/monitor.mjs remove --name NAME
Common: --profile prod|integ

create checks the sites against your authorized list, saves a report-only monitor and prints
the host scheduler handoff; it does not create a job. run checks every trimsaw, bandsaw and
Pallet QA device on those sites over the last 24 hours, writes the dashboard and prints what
changed since the previous run, with "notify" false when changes-only delivery should stay quiet.
--checks status saves a device-status monitor instead: reporting and device status (battery,
temperature, camera, network, power, errors) on every camera, with no count or trim checks.
Monitors: ${"$"}ZIRA_CONFIG_DIR/health-monitors (default ~/.config/zira). Dashboards:
${"$"}ZIRA_HEALTH_REPORTS_HOME (default ~/.cache/zira/health-reports)/NAME/report.html.
Exit 0 success, 2 invalid/failed, 3 incomplete coverage, 4 blocked (JSON explains).
`;

export function monitorsDir(env = process.env) {
  const base = env.ZIRA_CONFIG_DIR ? path.resolve(env.ZIRA_CONFIG_DIR)
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zira");
  return path.join(base, "health-monitors");
}

export function reportsHome(env = process.env) {
  return env.ZIRA_HEALTH_REPORTS_HOME ? path.resolve(env.ZIRA_HEALTH_REPORTS_HOME)
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "zira", "health-reports");
}

const checkName = name => {
  if (!JOB_NAME.test(String(name ?? ""))) throw new Error("--name uses lowercase letters, digits and hyphens (up to 60)");
  return name;
};
const files = (name, dir, home) => ({
  config: path.join(dir, name, "config.json"), state: path.join(dir, name, "state.json"),
  meta: path.join(dir, name, "monitor.json"), out: path.join(home, name),
  warnings: path.join(dir, name, "warnings.json"),
});

async function load(name, dir) {
  const f = files(checkName(name), dir, reportsHome());
  const config = await readJson(f.config, null), meta = await readJson(f.meta, null);
  if (!config || !meta) throw new Error(`No scheduled health report named ${name}; run list to see saved ones`);
  return { config, meta };
}

export async function sites({ get, companyId, profile }) {
  const r = await browse(get, "sites", { companyId, profile });
  return { kind: "health-monitor-sites", companyId, items: r.items.map(s => ({ id: s.id, name: s.name, url: s.url })) };
}

export async function create({ get, profile = "prod", name, companyId, siteIds, profiles = PROFILES, schedule, delivery = "changes-only",
  freshness = 30, replace = false, checks = "full", batteryMinimum, dir = monitorsDir(), home = reportsHome() }) {
  checkName(name);
  const f = files(name, dir, home);
  if (!replace && await readJson(f.config, null)) throw new Error(`A scheduled health report named ${name} exists; choose another name or pass --replace`);
  const s = checkSchedule(schedule);
  if (!["full", "status"].includes(checks)) throw new Error("--checks is full or status");
  const status = checks === "status";
  const bad = profiles.filter(p => !PROFILES.includes(p));
  if (!status && (!profiles.length || bad.length)) throw new Error(`--profiles takes ${PROFILES.join(", ")}`);
  const known = (await sites({ get, companyId, profile })).items;
  let chosen;
  if (siteIds === "all") chosen = "all";
  else {
    const missing = siteIds.filter(x => !known.some(k => k.id === x));
    if (!siteIds.length || missing.length) throw new Error(`Site ${missing.join(", ") || "(none)"} is not in your authorized list for company ${companyId}`);
    chosen = siteIds;
  }
  const config = {
    version: 1, monitorId: name, companyId: String(companyId), siteIds: chosen,
    ...(status ? { checks: "status", ...(batteryMinimum !== undefined ? { statusDefaults: { batteryMinimum } } : {}) } : { profiles }),
    freshnessMinutes: freshness, tasks: { mode: "report-only" }, devices: {},
    schedule: { ...s, delivery, allowTaskWrites: false },
  };
  assertConfig(config);
  const siteNames = chosen === "all" ? ["All authorized sites"] : chosen.map(x => known.find(k => k.id === x).name);
  const meta = { version: 1, name, profile, siteNames, createdAt: new Date().toISOString() };
  await writePrivate(f.config, config);
  await writePrivate(f.meta, meta);
  return { kind: "health-monitor-created", name, companyId: String(companyId), sites: siteNames, checks,
    ...(status ? { batteryMinimum: config.statusDefaults?.batteryMinimum ?? null } : { profiles }), config: f.config, ...handoff(config, meta) };
}

export function handoff(config, meta) {
  const s = config.schedule;
  const host = hostCron(s);
  const quiet = s.delivery === "changes-only";
  const where = meta.siteNames.length > 3 ? `${meta.siteNames.length} sites` : meta.siteNames.join(", ");
  const timing = { schedule: s, when: host.describe, hostCron: host.cron, hostZone: host.hostZone, nextRun: nextRun(s), note: host.note,
    instructions: "Create or update the host's scheduled job with this prompt and timing, then list it to confirm its ID and next run. This output alone schedules nothing." };
  if (statusOnly(config)) return {
    active: false, requiresHostScheduler: true,
    taskId: `zira-status-${config.monitorId}`.slice(0, 60), title: `Zira device status · ${meta.siteNames.join(", ")}`.slice(0, 80),
    description: `Zira device status check for ${where}`, ...timing,
    prompt: `Use the Zira plugin's device-status skill to run the saved status check "${config.monitorId}": run \`node scripts/device-status.mjs run --name ${config.monitorId}\` from that skill's directory. It reads Zira and writes only local files. If it fails with a sign-in or authentication error, do not retry; say the Zira sign-in needs renewing (any Zira skill, such as getting-started, signs in again). On HTTP 429 report the retry time and the missing coverage. ${quiet ? 'If the run prints "notify": false, reply with one line saying nothing changed and stop.' : ""} Otherwise lead with cameras that went offline recently, with how long and since when; then new status warnings (low battery, camera moved or off, power off, device error, no network), saying that values without a current heartbeat are last known and need checking on site; then warnings that cleared, long-offline cameras and coverage gaps. Link each data source by its url, and give the dashboard path. Do not create tasks, change devices or share the dashboard. Always call the product Zira. Do not commit anything to any repository; this is customer production data.`,
  };
  return {
    active: false, requiresHostScheduler: true,
    taskId: `zira-health-${config.monitorId}`.slice(0, 60), title: `Zira health · ${meta.siteNames.join(", ")}`.slice(0, 80),
    description: `Zira fleet health report for ${where}`,
    schedule: s, when: host.describe, hostCron: host.cron, hostZone: host.hostZone, nextRun: nextRun(s), note: host.note,
    prompt: `Use the Zira plugin's schedule-health-report skill to run the saved health report "${config.monitorId}": run \`node scripts/monitor.mjs run --name ${config.monitorId}\` from that skill's directory. It reads Zira and writes only local files. If it fails with a sign-in or authentication error, do not retry; say the Zira sign-in needs renewing (any Zira skill, such as getting-started, signs in again). On HTTP 429 report the retry time and the missing coverage. ${quiet ? 'If the run prints "notify": false, reply with one line saying nothing changed and stop.' : ""} Otherwise lead with what needs attention: devices that went down recently with how long and since when, before long-term outages; then new findings, recoveries and coverage gaps. Link each data source by its url, and give the dashboard path. Do not create tasks, change devices or share the dashboard. Always call the product Zira. Do not commit anything to any repository; this is customer production data.`,
    instructions: "Create or update the host's scheduled job with this prompt and timing, then list it to confirm its ID and next run. This output alone schedules nothing.",
  };
}

// Runs the health engine on a saved configuration file; exit 3 (partial coverage) still yields a report.
export async function runEngine({ configFile, out, state, profile, engine = ENGINE, spawnImpl = spawn }) {
  const args = [engine, "run", "--config", configFile, "--out", out, "--state", state, "--profile", profile];
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = "";
    child.stdout.on("data", d => { o += d; });
    child.stderr.on("data", d => { e += d; });
    child.on("error", reject);
    child.on("close", c => resolve({ code: c, stdout: o, stderr: e }));
  });
  let result;
  try { result = JSON.parse(stdout); } catch { result = null; }
  if (![0, 3].includes(code) || !result?.report) {
    if (result?.blocked) return { blocked: result };
    throw new Error((stderr || stdout || `health report exited ${code}`).trim().slice(0, 2000));
  }
  return { result, report: await readJson(result.report, {}) };
}

// What changed since the previous run; status reports also compare last-known warnings.
export function summarize({ config, report, result, previousWarnings = null }) {
  const findings = report.findings ?? [];
  const changes = {
    new: findings.filter(x => x.change === "new").map(x => ({ site: x.siteName, device: x.deviceName, title: x.title, severity: x.severity })),
    firstAssessment: findings.filter(x => x.change === "first-assessment").length,
    ongoing: findings.filter(x => x.change === "ongoing").length,
    recovered: (report.recovered ?? []).map(x => ({ site: x.siteName, device: x.deviceName, title: x.title })),
  };
  const status = statusOnly(config);
  const warnings = status ? statusWarnings(report) : null;
  if (status) {
    const now = new Set(warnings.map(w => w.key));
    // A warning clears only when that camera still reports status without it.
    const withStatus = new Set((report.devices ?? []).filter(d => Object.keys(d.deviceStatus?.values ?? {}).length).map(d => d.id));
    changes.newWarnings = previousWarnings ? warnings.filter(w => !previousWarnings.some(p => p.key === w.key)) : [];
    changes.clearedWarnings = (previousWarnings ?? []).filter(p => !now.has(p.key) && withStatus.has(p.id));
  }
  // Checks waiting for setup (counts, trim targets) mark every run partial; only a missed
  // inventory or a failed read is a change worth a message.
  const failed = report.inventoryComplete === false || (report.errors ?? []).length > 0;
  const notify = config.schedule?.delivery !== "changes-only" || failed || changes.new.length > 0 || changes.recovered.length > 0 ||
    changes.firstAssessment > 0 || (status && (!previousWarnings || changes.newWarnings.length > 0 || changes.clearedWarnings.length > 0));
  return { dashboard: result.dashboard, url: pathToFileURL(result.dashboard).href,
    totals: result.totals, attention: result.attention, findings: result.findings, changes, notify,
    ...(status ? { warnings } : {}),
    coverage: { inventoryComplete: report.inventoryComplete !== false, errors: (report.errors ?? []).length, checksNeedingSetup: !status && result.partial && !failed },
    complete: !failed };
}

// Runs the health engine with the saved monitor, then summarizes what changed.
export async function run({ name, dir = monitorsDir(), home = reportsHome(), engine = ENGINE, spawnImpl = spawn }) {
  const { config, meta } = await load(name, dir);
  const f = files(name, dir, home);
  const ran = await runEngine({ configFile: f.config, out: f.out, state: f.state, profile: meta.profile, engine, spawnImpl });
  if (ran.blocked) return { ...ran.blocked, complete: false };
  const previousWarnings = statusOnly(config) ? await readJson(f.warnings, null) : null;
  const summary = summarize({ config, report: ran.report, result: ran.result, previousWarnings });
  if (summary.warnings) await writePrivate(f.warnings, summary.warnings);
  return { kind: "health-monitor-run", name, sites: meta.siteNames, ...summary };
}

export async function list({ dir = monitorsDir() } = {}) {
  let names = [];
  try { names = await readdir(dir); } catch { /* none yet */ }
  const items = [];
  for (const n of names) {
    const config = await readJson(path.join(dir, n, "config.json"), null), meta = await readJson(path.join(dir, n, "monitor.json"), null);
    if (config && meta) items.push({ name: n, sites: meta.siteNames, checks: config.checks ?? "full", profiles: config.profiles ?? null, delivery: config.schedule?.delivery,
      schedule: config.schedule ? hostCron(config.schedule).describe : null, nextRun: config.schedule ? nextRun(config.schedule) : null });
  }
  return { kind: "health-monitors", items };
}

export async function remove({ name, dir = monitorsDir() }) {
  await load(name, dir);
  await rm(path.join(dir, name), { recursive: true });
  return { kind: "health-monitor-removed", name, note: "Saved monitor and its comparison state removed; dashboards stay on disk. Delete the host's scheduled task too." };
}

export function batteryOption(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error("--battery-min is 0-100 (percent)");
  return n;
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, name: { type: "string" }, "company-id": { type: "string" }, "site-ids": { type: "string" },
    profiles: { type: "string" }, frequency: { type: "string" }, day: { type: "string" }, time: { type: "string" },
    timezone: { type: "string" }, delivery: { type: "string" }, freshness: { type: "string" }, replace: { type: "boolean" },
    checks: { type: "string" }, "battery-min": { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  switch (args[0]) {
    case "sites": return sites({ get: await liveClient(profile), companyId: o["company-id"], profile });
    case "create": {
      const freshness = o.freshness ? Number(o.freshness) : 30;
      if (!(Number.isInteger(freshness) && freshness >= 1 && freshness <= 1440)) throw new Error("--freshness is 1-1440 minutes");
      if (o.delivery && !["changes-only", "all-runs"].includes(o.delivery)) throw new Error("--delivery is changes-only or all-runs");
      const batteryMinimum = batteryOption(o["battery-min"]);
      return create({ get: await liveClient(profile), profile, name: o.name, companyId: o["company-id"],
        siteIds: o["site-ids"] === "all" ? "all" : idList(o["site-ids"]), profiles: o.profiles ? idList(o.profiles) : PROFILES,
        schedule: { frequency: o.frequency, day: o.day, time: o.time, timezone: o.timezone },
        delivery: o.delivery ?? "changes-only", freshness, replace: !!o.replace, checks: o.checks ?? "full", batteryMinimum });
    }
    case "run": return run({ name: o.name });
    case "handoff": {
      const { config, meta } = await load(o.name, monitorsDir());
      return { kind: "health-monitor-handoff", name: o.name, ...handoff(config, meta) };
    }
    case "list": return list();
    case "remove": return remove({ name: o.name });
    default: throw new Error(`Unknown command ${args[0]}; run with --help`);
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => process.env.ZIRA_PROFILE ?? "prod" });
