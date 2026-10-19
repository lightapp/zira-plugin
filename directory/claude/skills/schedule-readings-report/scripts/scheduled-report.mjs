#!/usr/bin/env node
// Scheduled Readings Report: a guided, recurring report over one or more data sources at a
// site. It reuses the readings-report cache, query engine and page; adds type templates
// (pallet-qa, trimsaw, bandsaw, custom), a deterministic period-over-period digest and the
// host scheduler handoff. Reads Zira only; reports and saved jobs stay on this computer.
import os from "node:os";
import path from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { argValue, idList, isMain, liveSession, runCli } from "../../../scripts/client.mjs";
import { JOB_NAME, checkSchedule, hostCron, nextRun } from "../../../scripts/schedules.mjs";
import { readJson, writePrivate } from "../../health-report/scripts/storage.mjs";
import { formatLocal, runQuery } from "../../readings-report/scripts/query-core.mjs";
import { ROUTES, lastMs, writeReport } from "../../readings-report/scripts/readings.mjs";
import { LIMITS, fetchDataset, home, loadDataset, sources } from "../../readings-report/scripts/store.mjs";
import { DEFAULT_THRESHOLDS, KINDS, KIND_NAMES, M, buildSpec, plan } from "./templates.mjs";

const HELP = `Scheduled Readings Report — recurring reports over Zira data sources
node scripts/scheduled-report.mjs plan --company-id ID --site-id ID --device-ids A,B [--kinds A=pallet-qa,B=custom]
node scripts/scheduled-report.mjs create --name NAME --company-id ID --site-id ID --device-ids A,B
    --last 24h|7d|4w [--choices JSON|@FILE]
node scripts/scheduled-report.mjs run --name NAME
node scripts/scheduled-report.mjs schedule --name NAME --frequency daily|weekdays|weekly [--day mon]
    --time HH:MM --timezone IANA [--artifact-url URL]
node scripts/scheduled-report.mjs list
node scripts/scheduled-report.mjs remove --name NAME
Common: --profile prod|integ

plan classifies each data source (pallet-qa, trimsaw, bandsaw, custom) and lists the key numbers
and sections its template offers. create saves the job and builds the first report; run refetches
the last span plus the span before it, rebuilds the report with a computed summary and prints a
digest (each key number against the previous span, data-source freshness, flagged days).
schedule saves the timing and prints the host scheduler handoff; it does not create a job.
choices: {"title", "kinds": {"ID": "kind"}, "blocks": {"group key": ["block", ...]},
          "thresholds": {"failRatePct", "pendingStopMin", "quietMin"}, "extra": {"kpis", "sections"}}
Saved jobs: ${"$"}ZIRA_CONFIG_DIR/scheduled-reports (default ~/.config/zira). Reports: the readings
reports folder, with each job's newest copy at scheduled/NAME/latest.html under ${"$"}ZIRA_READINGS_HOME.
Exit 0 success, 2 invalid/failed, 3 incomplete coverage, 4 blocked (JSON explains).
`;

export function jobsDir(env = process.env) {
  const base = env.ZIRA_CONFIG_DIR ? path.resolve(env.ZIRA_CONFIG_DIR)
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zira");
  return path.join(base, "scheduled-reports");
}

const jobFile = (dir, name) => path.join(dir, `${name}.json`);
const checkName = name => {
  if (!JOB_NAME.test(String(name ?? ""))) throw new Error("--name uses lowercase letters, digits and hyphens (up to 60)");
  return name;
};

async function loadJob(dir, name) {
  const job = await readJson(jobFile(dir, checkName(name)), null);
  if (!job) throw new Error(`No scheduled report named ${name}; run list to see saved ones`);
  return job;
}

async function jsonArg(value, what) {
  if (value === undefined) return {};
  const raw = String(value).startsWith("@") ? await readFile(path.resolve(value.slice(1)), "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

const kindList = value => Object.fromEntries(idList(value).map(pair => {
  const [id, kind] = pair.split("=");
  if (!KINDS.includes(kind)) throw new Error(`--kinds takes ID=kind with kind ${KINDS.join(", ")}`);
  return [id, kind];
}));

export async function planReport({ call, profile, companyId, siteId, deviceIds, kinds = {} }) {
  if (!deviceIds?.length) throw new Error("Give the data sources with --device-ids");
  if (deviceIds.length > LIMITS.devices) throw new Error(`Select at most ${LIMITS.devices} data sources`);
  const found = await sources({ call, profile, companyId, siteId, deviceIds, withMetrics: true });
  const missing = deviceIds.filter(x => !found.items.some(i => i.id === x));
  if (missing.length) throw new Error(`Data source ${missing.join(", ")} is not in the selected site`);
  return { kind: "scheduled-report-plan", site: found.site, groups: plan(found.items, kinds), thresholds: DEFAULT_THRESHOLDS, sources: found.items };
}

// Resolves bar series once the result's columns are known, then drops the template marker.
function finalize(spec, data) {
  for (const s of spec.sections) {
    if (!s.chart?.barSeries) continue;
    delete s.chart.barSeries;
    const { columns } = runQuery(data, { ...s.chart.query });
    const first = columns[0] === "time" ? 1 : columns.length > 1 && s.chart.query.groupBy ? 1 : 0;
    s.chart.option = { ...(s.chart.option ?? {}), series: columns.slice(first).slice(0, 8).map(() => ({ type: "bar" })) };
  }
  return spec;
}

const siteIso = ms => formatLocal(ms, "raw").replace(" ", "T");
const fmtNum = (v, unit) => (v === null || v === undefined ? "no data"
  : `${v.toLocaleString("en-US", { maximumFractionDigits: unit === "%" || Math.abs(v) < 100 ? 1 : 0 })}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`);
const ago = min => (min < 120 ? `${Math.round(min)} min` : min < 6000 ? `${(min / 60).toFixed(min < 600 ? 1 : 0)} h` : `${Math.round(min / 1440)} days`);

// Each key number for this span and the one before, freshness per data source, flagged days.
export function digest({ job, manifest, data, now = Date.now() }) {
  const t = { ...DEFAULT_THRESHOLDS, ...(job.thresholds ?? {}) };
  const off = (manifest.siteOffsetMinutes?.[0] ?? 0) * 60000;
  const span = lastMs(job.source.last), siteNow = now + off;
  const cur = { from: siteIso(siteNow - span), to: siteIso(siteNow) }, prev = { from: siteIso(siteNow - 2 * span), to: cur.from };
  const one = (q, r) => {
    const res = runQuery(data, { ...q, interval: "all", groupBy: undefined, ...r });
    const v = res.rows[0]?.at(-1);
    return typeof v === "number" ? v : null;
  };
  const kpis = job.digest.map(k => {
    const now_ = one(k.query, cur), before = one(k.query, prev);
    let change = null, direction = null;
    if (now_ !== null && before !== null) {
      change = k.unit === "%" ? { points: +(now_ - before).toFixed(2) } : before ? { percent: +((100 * (now_ - before)) / before).toFixed(1) } : null;
      const d = now_ - before;
      direction = Math.abs(d) < 1e-9 ? "same" : k.compare === "neutral" ? (d > 0 ? "up" : "down") : (d > 0) === (k.compare === "higher") ? "better" : "worse";
    }
    return { label: k.label, unit: k.unit, current: now_, previous: before, change, direction };
  });
  const forms = new Set(job.groups.filter(g => g.form).flatMap(g => g.deviceIds));
  const sources = data.devices.map(d => {
    const lastT = d.t.length ? d.t[d.t.length - 1] : null;
    const age = lastT === null ? null : (siteNow - lastT) / 60000;
    // Forms are filled a few times a shift: judge them by entries in the span, not minutes.
    const form = forms.has(d.id);
    const state = lastT === null ? "no-readings"
      : form ? (lastT >= siteNow - span ? "active" : "no-submissions")
      : age <= t.quietMin ? "live" : age <= t.offlineMin ? "quiet" : "offline";
    return { id: d.id, name: String(d.name).trim(), form, url: manifest.devices.find(x => x.id === d.id)?.url ?? null, state,
      lastReading: lastT === null ? null : siteIso(lastT).replace("T", " ").slice(0, 16),
      quietFor: age === null ? null : age < 0 ? "0 min" : ago(age),
      ...(age !== null && age < -5 ? { clockNote: "Readings are time-stamped ahead of this computer's clock; treat as live." } : {}) };
  });
  const daily = [];
  for (const g of job.groups) {
    const ids = g.deviceIds;
    const has = id => g.metricIds.includes(id);
    if (g.kind === "pallet-qa" && has(M.units) && has(M.disposition)) {
      const r = runQuery(data, { interval: "day", groupBy: "device", pivot: false, devices: ids, ...cur, measures: [
        { metric: M.units, op: "sum", label: "units" },
        { metric: M.units, op: "share", where: { metric: M.disposition, op: "=", value: "Fail" }, label: "rate" }] });
      for (const [day, device, units, rate] of r.rows)
        if (units >= t.minUnitsForRate && rate > t.failRatePct)
          daily.push({ type: "fail-rate", day: formatLocal(day, "day"), source: device, value: +rate.toFixed(1), units,
            text: `${formatLocal(day, "day")}: ${device} failed ${rate.toFixed(1)}% of ${units.toLocaleString("en-US")} pallets (above ${t.failRatePct}%)` });
    }
    // Vision stops carry the reason in Event; downtime forms in a "… Reason" list.
    const reason = has(M.status) && has(M.event) ? M.event : g.metricIds.find(id => id !== M.event && /reason/i.test(job.metrics[id]?.name ?? ""));
    if (reason && has(M.duration)) {
      const r = runQuery(data, { interval: "day", groupBy: "device", pivot: false, devices: ids, ...cur,
        filters: [...(reason === M.event ? [{ metric: M.status, op: "=", value: "Stop" }] : []), { metric: reason, op: "contains", value: "pending reason" }],
        measures: [{ metric: M.duration, op: "sum", label: "min" }] });
      for (const [day, device, min] of r.rows)
        if (min > t.pendingStopMin)
          daily.push({ type: "pending-reason", day: formatLocal(day, "day"), source: device, value: Math.round(min),
            text: `${formatLocal(day, "day")}: ${device} stopped ${ago(min)} with no reason entered ("Pending Reason")` });
    }
  }
  // A problem on three or more days of one source is one line, not one per day.
  const flags = [];
  const byKey = {};
  for (const f of daily) (byKey[`${f.type}\u0000${f.source}`] ??= []).push(f);
  for (const list of Object.values(byKey)) {
    if (list.length < 3) { flags.push(...list); continue; }
    const { type, source } = list[0];
    const worst = list.reduce((a, b) => (b.value > a.value ? b : a));
    flags.push({ type, source, days: list.map(f => f.day), value: worst.value,
      text: type === "fail-rate"
        ? `${source.trim()}: fail rate above ${t.failRatePct}% on ${list.length} days, worst ${worst.value}% on ${worst.day}`
        : `${source.trim()}: stops with no reason entered ("Pending Reason") on ${list.length} days, ${ago(list.reduce((n, f) => n + f.value, 0))} in total, most on ${worst.day} (${ago(worst.value)})` });
  }
  for (const f of flags) f.text = f.text.replace(f.source, String(f.source).trim());
  const days = Math.round((2 * span) / 86400e3);
  for (const s of sources)
    if (["offline", "no-readings", "no-submissions"].includes(s.state))
      flags.push({ type: s.form ? "no-submissions" : "offline", source: s.name,
        text: s.form
          ? s.lastReading ? `${s.name}: no form submissions in the last ${job.source.last} (last one ${s.lastReading})` : `${s.name}: no form submissions in the last ${days} days`
          : s.lastReading ? `${s.name} has sent no readings for ${s.quietFor} (since ${s.lastReading} site time); treat it as offline` : `${s.name} sent no readings in the last ${days} days; treat it as offline` });
  return { period: cur, previousPeriod: prev, span: job.source.last, kpis, sources, flags, coverage: { complete: manifest.complete !== false, notes: manifest.notes ?? [] } };
}

// The report's summary, written from the digest so every number in it is computed.
export function summaryText(d) {
  const p = s => s.replace("T", " ").slice(0, 16);
  const lines = [`**${p(d.period.from)} – ${p(d.period.to)} site time**, compared with the ${d.span} before.`, ""];
  for (const k of d.kpis) {
    const ch = !k.change ? "" : k.change.points !== undefined ? ` (${k.change.points >= 0 ? "+" : "−"}${Math.abs(k.change.points).toFixed(1)} pts` : ` (${k.change.percent >= 0 ? "+" : "−"}${Math.abs(k.change.percent).toFixed(1)}%`;
    lines.push(`- **${k.label}: ${fmtNum(k.current, k.unit)}**${ch ? `${ch} vs ${fmtNum(k.previous, k.unit)}${["worse", "better"].includes(k.direction) ? `, ${k.direction}` : ""})` : ""}`);
  }
  lines.push("", "### Data sources", "");
  for (const s of d.sources)
    lines.push(`- ${s.name}: ${s.form ? (s.state === "active" ? `last submission ${s.lastReading}` : s.lastReading ? `no submissions this period (last ${s.lastReading})` : "no submissions in this period") : s.state === "live" ? `live, last reading ${s.lastReading}` : s.state === "no-readings" ? "no readings in this period" : `${s.state === "quiet" ? "quiet" : "**offline**"} for ${s.quietFor}, since ${s.lastReading}`}`);
  if (d.flags.length) {
    lines.push("", "### Worth a look", "");
    for (const f of d.flags.slice(0, 12)) lines.push(`- ${f.text}`);
    if (d.flags.length > 12) lines.push(`- ${d.flags.length - 12} more in the sections below`);
  }
  if (!d.coverage.complete) lines.push("", "**Coverage is incomplete:** some readings could not be read, so numbers may be low.");
  return lines.join("\n");
}

async function build({ call, job, root, now, log }) {
  const span = lastMs(job.source.last);
  if (2 * span > LIMITS.days * 86400e3) throw new Error("The span and the one before it must fit in a year");
  const s = job.source;
  const manifest = await fetchDataset({ call, profile: s.profile, companyId: s.companyId, siteId: s.siteId, deviceIds: s.deviceIds,
    from: new Date(now - 2 * span).toISOString(), to: new Date(now).toISOString(), root, now, log });
  const data = await loadDataset(manifest, { root });
  const d = digest({ job, manifest, data, now });
  const { spec } = buildSpec({ title: job.title, groups: job.groups, metrics: job.metrics, extra: job.extra });
  spec.range = d.period;
  spec.summary = summaryText(d);
  const out = await writeReport({ spec: finalize(spec, data), manifest, root, now: new Date(now) });
  const latest = path.join(root, "scheduled", job.name, "latest.html");
  await mkdir(path.dirname(latest), { recursive: true, mode: 0o700 });
  await copyFile(out.path, latest);
  return { report: out.path, latest, url: pathToFileURL(latest).href, digest: d, complete: d.coverage.complete,
    readings: data.devices.reduce((n, x) => n + x.t.length, 0) };
}

export async function create({ call, profile, companyId, siteId, deviceIds, name, last, choices = {}, dir = jobsDir(), root = home(), now = Date.now(), log = () => {} }) {
  checkName(name);
  lastMs(last);
  const p = await planReport({ call, profile, companyId, siteId, deviceIds, kinds: choices.kinds ?? {} });
  const metrics = {};
  for (const s of p.sources) for (const m of s.metrics) metrics[m.id] ??= { name: m.name, unit: m.unit ?? null, dataType: m.dataType ?? null };
  const groups = p.groups.map(g => {
    const chosen = choices.blocks?.[g.key] ?? choices.blocks?.[g.kind];
    const known = g.blocks.map(b => b.id);
    const bad = (chosen ?? []).filter(b => !known.includes(b));
    if (bad.length) throw new Error(`${g.name} has no block ${bad.join(", ")}; choose from ${known.join(", ")}`);
    const ids = g.sources.map(x => x.id);
    return { key: g.key, kind: g.kind, name: g.name, form: g.form, deviceIds: ids, blocks: chosen ?? g.blocks.filter(b => b.default).map(b => b.id),
      metricIds: [...new Set(p.sources.filter(x => ids.includes(x.id)).flatMap(x => x.metrics.map(m => m.id)))] };
  });
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(choices.thresholds ?? {})) {
    if (!(k in DEFAULT_THRESHOLDS) || !(Number.isFinite(v) && v >= 0)) throw new Error(`threshold ${k} must be one of ${Object.keys(DEFAULT_THRESHOLDS).join(", ")} with a number ≥ 0`);
    thresholds[k] = v;
  }
  const names = p.sources.map(x => x.name.trim());
  const title = String(choices.title ?? `${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" & ")} · last ${last}`).slice(0, 140);
  const { digest: dg } = buildSpec({ title, groups, metrics, extra: choices.extra ?? null });
  const job = { version: 1, name, title, savedAt: new Date(now).toISOString(),
    source: { profile, companyId: String(companyId), siteId: String(siteId), siteName: p.site.name, deviceIds: p.sources.map(x => x.id), last },
    sources: p.sources.map(x => ({ id: x.id, name: x.name, url: x.url })), groups, metrics, thresholds, digest: dg,
    extra: choices.extra ?? null, schedule: null, delivery: { artifactUrl: null } };
  const first = await build({ call, job, root, now, log });
  await writePrivate(jobFile(dir, name), job);
  return { kind: "scheduled-report-created", name, title, site: p.site, groups: groups.map(g => ({ key: g.key, name: g.name, sources: g.deviceIds, blocks: g.blocks })), ...first };
}

export async function run({ session, name, dir = jobsDir(), root = home(), now = Date.now(), log = () => {} }) {
  const job = await loadJob(dir, name);
  const out = await build({ call: await session(job.source.profile), job, root, now, log });
  return { kind: "scheduled-report-run", name, title: job.title, site: job.source.siteName, schedule: job.schedule,
    artifactUrl: job.delivery?.artifactUrl ?? null, ...out };
}

export function handoff(job) {
  const s = job.schedule;
  const host = hostCron(s);
  const publish = job.delivery?.artifactUrl
    ? ` Then read the artifact ${job.delivery.artifactUrl} with the Artifact tool and publish the run's "latest" file to that same url so the link stays the same; do not create a new artifact or change its icon or sharing.`
    : " Give the run's latest report path.";
  return {
    active: false, requiresHostScheduler: true,
    taskId: `zira-${job.name}`.slice(0, 60), title: job.title, description: `Zira scheduled report: ${job.title}`,
    schedule: s, when: host.describe, hostCron: host.cron, hostZone: host.hostZone, nextRun: nextRun(s), note: host.note,
    prompt: `Use the Zira plugin's schedule-readings-report skill to run the saved report "${job.name}": run \`node scripts/scheduled-report.mjs run --name ${job.name}\` from that skill's directory. It reads Zira and writes only local files. If it fails with a sign-in or authentication error, do not retry; say the Zira sign-in needs renewing (any Zira skill, such as getting-started, signs in again). On HTTP 429 report the retry time. Do not publish or share a report built from an error.${publish} Report back in 3-6 short lines from the run's "digest": the period, each key number against the previous ${job.source.last} (with "better"/"worse"), every data source that is quiet or offline with how long and since when (more than a day means offline), and the flagged days. Say "incomplete" if coverage is incomplete. Always call the product Zira. Do not commit anything to any repository; this is customer production data.`,
    instructions: "Create or update the host's scheduled job with this prompt and timing, then list it to confirm its ID and next run. This output alone schedules nothing.",
  };
}

export async function scheduleJob({ name, schedule, artifactUrl, dir = jobsDir() }) {
  const job = await loadJob(dir, name);
  job.schedule = checkSchedule(schedule);
  if (artifactUrl !== undefined) {
    if (artifactUrl && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/.test(artifactUrl)) throw new Error("--artifact-url must be a claude.ai artifact link");
    job.delivery = { artifactUrl: artifactUrl || null };
  }
  await writePrivate(jobFile(dir, name), job);
  return { kind: "scheduled-report-handoff", name, ...handoff(job) };
}

export async function list({ dir = jobsDir() } = {}) {
  let files = [];
  try { files = (await readdir(dir)).filter(f => f.endsWith(".json")); } catch { /* none yet */ }
  const items = [];
  for (const f of files) {
    const j = await readJson(path.join(dir, f), null);
    if (j?.name) items.push({ name: j.name, title: j.title, site: j.source?.siteName, sources: j.sources?.map(s => s.name), last: j.source?.last,
      schedule: j.schedule ? hostCron(j.schedule).describe : null, nextRun: j.schedule ? nextRun(j.schedule) : null, artifactUrl: j.delivery?.artifactUrl ?? null });
  }
  return { kind: "scheduled-reports", items };
}

export async function remove({ name, dir = jobsDir() }) {
  const job = await loadJob(dir, name);
  await rm(jobFile(dir, name));
  return { kind: "scheduled-report-removed", name, title: job.title, note: "Saved job removed; reports stay on disk. Delete the host's scheduled task too." };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, "company-id": { type: "string" }, "site-id": { type: "string" }, "device-ids": { type: "string" },
    kinds: { type: "string" }, name: { type: "string" }, last: { type: "string" }, choices: { type: "string" },
    frequency: { type: "string" }, day: { type: "string" }, time: { type: "string" }, timezone: { type: "string" },
    "artifact-url": { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const session = p => liveSession(p, { allow: ROUTES, maxRequests: LIMITS.requests });
  const log = message => process.stderr.write(`${message}\n`);
  switch (args[0]) {
    case "plan": {
      const out = await planReport({ call: await session(profile), profile, companyId: o["company-id"], siteId: o["site-id"],
        deviceIds: idList(o["device-ids"]), kinds: kindList(o.kinds) });
      return { ...out, sources: out.sources.map(s => ({ id: s.id, name: s.name, url: s.url, metrics: s.metrics.length })) };
    }
    case "create":
      if (!o.last) throw new Error("create needs --last, the span each run covers (such as 7d)");
      return create({ call: await session(profile), profile, companyId: o["company-id"], siteId: o["site-id"],
        deviceIds: idList(o["device-ids"]), name: o.name, last: o.last, choices: await jsonArg(o.choices, "--choices"), log });
    case "run": return run({ session, name: o.name, log });
    case "schedule":
      return scheduleJob({ name: o.name, schedule: { frequency: o.frequency, day: o.day, time: o.time, timezone: o.timezone }, artifactUrl: o["artifact-url"] });
    case "list": return list();
    case "remove": return remove({ name: o.name });
    default: throw new Error(`Unknown command ${args[0]}; run with --help`);
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
