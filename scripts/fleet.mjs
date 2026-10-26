#!/usr/bin/env node
// Device Status for the Claude band/pane, read-only. Keep this filename/API compatible;
// assessments use the same status-only engine and battery default as the Device Status skill.
import { parseArgs } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discover, liveClient, normalizeDevice, pages } from "../skills/health-report/scripts/api.mjs";
import { assess } from "../skills/health-report/scripts/engine.mjs";
import { loadMovementLedger, reviewMovement } from "../skills/health-report/scripts/movement.mjs";
import { DEFAULT_BATTERY_MIN } from "../skills/device-status/scripts/device-status.mjs";
import { attention } from "../skills/health-report/scripts/dashboard.mjs";
import { originFor } from "./browse.mjs";
import { preferences } from "./preferences.mjs";

const HELP = `Zira Device Status — read-only, cameras at one site
node scripts/fleet.mjs [--company NAME|ID] [--site NAME|ID] [--profile prod|integ]
  --company, --site     Name (exact, or a unique partial match, case-insensitive) or ID.
                        Defaults: the account's saved Zira defaults (preferences.mjs), else
                        --fallback-company/--fallback-site, else the only one.
  --fallback-company, --fallback-site
                        Legacy Claude Code plugin-settings defaults, used only when the
                        account has no saved default scope.
  --max-devices N       Read at most N data sources (default 40, 1–100)
  --freshness-minutes N Heartbeat age that counts as offline (default 30, 1–1440)
  --battery-min N       Low battery warning while not charging (default 20%, 0 disables)

JSON stdout: { ok: true, company, site, assessedAt, complete, counts, devices } or
{ ok: false, needs: "sign-in"|"company"|"site"|"error", message, choices? }.
About four API reads plus one per data source; 429 stops without retrying.
Exit 0: complete, 2: failed or needs a choice, 3: coverage incomplete.
`;

const STATE = { reporting: "online", "not-reporting": "offline", "never-reported": "never", unknown: "unknown" };

export function pick(items, wanted, kind) {
  const q = String(wanted ?? "").trim().toLowerCase();
  const names = list => list.map(i => i.name).sort().slice(0, 20);
  if (!q) return items.length === 1 ? { item: items[0] }
    : { needs: kind, message: items.length ? `Choose a ${kind}: save a default company and site (say "set my default Zira site")` : `No ${kind} is available to this sign-in`, choices: names(items) };
  const exact = items.filter(i => i.id === q || i.name.toLowerCase() === q);
  const matches = exact.length ? exact : items.filter(i => i.name.toLowerCase().includes(q));
  if (matches.length === 1) return { item: matches[0] };
  return { needs: kind, message: matches.length ? `"${wanted}" matches several ${kind}s` : `No ${kind} matches "${wanted}"`, choices: names(matches.length ? matches : items) };
}

const clampInt = (value, fallback, min, max) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected a whole number ${min}–${max}`);
  return n;
};

// Scope precedence matches references/preferences.md: explicit, then the account's saved pair
// (empty names stay cleared), then legacy plugin settings. Unreadable preferences fall back.
export async function defaultScope(get, { company, site, fallbackCompany, fallbackSite, profile = "prod", env = process.env } = {}) {
  if (company || site) return { company, site, source: "request" };
  let values = {};
  try {
    ({ values } = await preferences({ command: "show", profile, env, call: (method, route) => get(route) }));
  } catch (error) {
    if (/429|allowance|retry after|not logged in|zira login|unable to refresh/i.test(error.message)) throw error;
  }
  if (Object.hasOwn(values, "default_company"))
    return { company: values.default_company, site: values.default_site, source: "saved" };
  return { company: fallbackCompany, site: fallbackSite, source: fallbackCompany || fallbackSite ? "plugin-settings" : "none" };
}

export async function fleet(get, { company, site, profile = "prod", maxDevices = 40, freshnessMinutes = 30, batteryMinimum = DEFAULT_BATTERY_MIN, now = new Date().toISOString() } = {}) {
  originFor(profile);
  const c = pick(await discover(get, "companies"), company, "company");
  if (!c.item) return { ok: false, ...c };
  const s = pick(await discover(get, "sites", c.item.id), site, "site");
  if (!s.item) return { ok: false, company: c.item.name, ...s };
  const companyId = c.item.id, siteId = s.item.id;
  const config = { version: 1, monitorId: "device-status-panel", companyId, siteIds: [siteId],
    checks: "status", statusDefaults: { batteryMinimum }, freshnessMinutes, tasks: { mode: "report-only" }, devices: {} };
  const listed = (await pages(get, "/devices/list", { companyIds: companyId, siteIds: siteId }))
    .filter(d => !d.isDeleted && !d.isTemplate && String(d.site?.id ?? d.siteId ?? "") === siteId &&
      String(d.company?.id ?? d.companyId ?? companyId) === companyId && /^[1-9]\d*$/.test(String(d.id ?? "")));
  const selected = listed.slice(0, maxDevices), at = Date.parse(now), devices = [];
  let errors = 0;
  for (const list of selected) {
    let d;
    try {
      const detail = (await get(`/devices/${list.id}`))?.data;
      if (!detail || String(detail.id) !== String(list.id)) throw new Error("Device detail identity mismatch");
      d = normalizeDevice(list, detail, config);
      if (d.companyId !== companyId || d.siteId !== siteId) throw new Error("Device scope changed between inventory and detail");
    } catch (error) {
      if (/429|allowance|retry after/i.test(error.message)) throw error;
      errors++;
      d = { id: String(list.id), name: String(list.name ?? list.id), companyId, siteId, siteName: s.item.name, status: {}, errors: [error.message] };
    }
    devices.push({ ...d, type: typeof list.applying?.name === "string" ? list.applying.name : null });
  }
  const complete = listed.length <= maxDevices && errors === 0;
  const { report } = assess({ version: 1, companyId, companyName: c.item.name, assessedAt: now,
    window: { from: new Date(at - 3600000).toISOString(), to: now }, sourceProfile: profile,
    complete, devices }, config);
  reviewMovement(report, null, { ledger: await loadMovementLedger(profile, companyId) });
  const { rows, needsCheck } = attention(report);
  const byId = new Map(report.devices.map(d => [d.id, d]));
  const types = new Map(devices.map(d => [d.id, d.type]));
  const out = rows.map(r => {
    const d = byId.get(r.id);
    return {
      id: r.id, name: r.name, type: types.get(r.id),
      state: STATE[d.connectivity.state],
      bucket: r.bucket,
      since: r.since ?? null,
      hours: r.downHours === null ? null : Math.round(r.downHours * 10) / 10,
      lastSignal: d.lastHeartbeat ?? d.lastReadingAt ?? null,
      reason: r.reason,
      url: r.url,
      statusFreshness: r.statusFreshness,
      statusText: r.statusText,
      indicators: r.indicators,
      statusWarnings: r.statusWarnings,
      currentAlerts: r.issues.filter(i => i.check === "hardware").map(i => ({ code: i.code, title: i.title })),
    };
  });
  const counts = { total: out.length, online: 0, offline: 0, never: 0, unknown: 0, newOffline: 0,
    currentAlerts: 0, lastKnown: 0, unavailable: 0, needsCheck };
  for (const d of out) {
    counts[d.state]++;
    if (d.bucket === "new") counts.newOffline++;
    if (d.currentAlerts.length) counts.currentAlerts++;
    if (d.statusFreshness === "Last known") counts.lastKnown++;
    if (d.statusFreshness === "Unavailable") counts.unavailable++;
  }
  return {
    ok: true, profile,
    company: { id: companyId, name: c.item.name },
    site: { id: siteId, name: s.item.name },
    assessedAt: now, freshnessMinutes, batteryMinimum,
    complete,
    omitted: Math.max(0, listed.length - maxDevices),
    counts, devices: out,
  };
}

export function failure(error) {
  const message = String(error?.message ?? error).slice(0, 300);
  return { ok: false, needs: /not logged in|zira login|unable to refresh/i.test(message) ? "sign-in" : "error", message };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return 0; }
  let result;
  try {
    const { values: o } = parseArgs({ args, options: {
      company: { type: "string" }, site: { type: "string" }, profile: { type: "string" },
      "fallback-company": { type: "string" }, "fallback-site": { type: "string" },
      "max-devices": { type: "string" }, "freshness-minutes": { type: "string" }, "battery-min": { type: "string" },
    } });
    const profile = o.profile ?? env.ZIRA_PROFILE ?? "prod";
    originFor(profile);
    const get = await liveClient(profile);
    const scope = await defaultScope(get, { company: o.company, site: o.site, profile, env,
      fallbackCompany: o["fallback-company"] ?? env.CLAUDE_PLUGIN_OPTION_DEFAULT_COMPANY,
      fallbackSite: o["fallback-site"] ?? env.CLAUDE_PLUGIN_OPTION_DEFAULT_SITE });
    result = await fleet(get, {
      company: scope.company,
      site: scope.site,
      profile,
      maxDevices: clampInt(o["max-devices"], 40, 1, 100),
      freshnessMinutes: clampInt(o["freshness-minutes"], 30, 1, 1440),
      batteryMinimum: clampInt(o["battery-min"], DEFAULT_BATTERY_MIN, 0, 100),
    });
    result.scopeSource = scope.source;
  } catch (error) {
    result = failure(error);
  }
  console.log(JSON.stringify(result, null, 2));
  return !result.ok ? 2 : result.complete ? 0 : 3;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; });
}
