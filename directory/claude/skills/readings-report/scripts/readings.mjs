#!/usr/bin/env node
// Readings Report: fetch a site's readings into a local cache, query them, and build an
// interactive HTML report. Reads Zira only; reports and the cache stay on this computer.
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { argValue, idList, isMain, liveSession, runCli } from "../../../scripts/client.mjs";
import { launchBrowser } from "../../../scripts/datasets.mjs";
import { readJson, writePrivate } from "../../health-report/scripts/storage.mjs";
import { formatLocal, runQuery, tableCells } from "./query-core.mjs";
import { buildReport, checkSpec, specMetrics } from "./report.mjs";
import { liveUrl, logFor, servable, sidecarFor, startHelper } from "./serve.mjs";
import { LIMITS, fetchDataset, home, listDatasets, loadDataset, profileData, readDataset, sources } from "./store.mjs";

const HELP = `Readings Report — local readings analysis and interactive HTML reports
node scripts/readings.mjs sources --company-id ID --site-id ID [--search TEXT] [--device-ids A,B] [--metrics]
node scripts/readings.mjs fetch --company-id ID --site-id ID --device-ids A,B --from ISO [--to ISO]
    [--source auto|files|api] [--refresh]
node scripts/readings.mjs datasets
node scripts/readings.mjs describe --dataset ID [--device-ids A,B]
node scripts/readings.mjs query --dataset ID --query JSON|@FILE [--max-rows N]
node scripts/readings.mjs report --dataset ID --spec FILE [--save NAME --last 7d|24h|4w]
node scripts/readings.mjs report --saved NAME [--summary-file FILE]
node scripts/readings.mjs saved
node scripts/readings.mjs reports [--limit 10]
node scripts/readings.mjs open --report FILE
node scripts/readings.mjs serve --report FILE [--open] [--idle-minutes 120] [--stop]
Common: --profile prod|integ

fetch takes ISO instants with Z or an offset. It uses Zira's weekly reading files when they are
enabled for plugin sign-in, and analysis/data otherwise (at most ${LIMITS.apiDeviceWeeks} source-weeks per fetch).
Completed weeks are cached under ${"$"}ZIRA_READINGS_HOME (default ~/.cache/zira/readings) and reused.
Queries and reports run locally on the cached readings; nothing is written to Zira.
Every report is a saved HTML file (its file url always opens it); reports lists recent ones.
serve hands one report out on 127.0.0.1 so the page can load more dates with this sign-in. It
starts a helper in the background, prints its url and returns; running it again reuses the same
helper and url. The helper keeps running while the page is open and stops after the idle time
or with --stop.
Exit 0 success, 2 invalid/failed, 3 incomplete, 4 blocked (JSON explains).
`;

export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/],
  ["GET", /^\/analysis\/data\/[1-9]\d*$/],
  ["GET", /^\/meters-data\/readings-files$/], ["GET", /^\/meters-data\/prepare-readings-files$/],
];

export function savedDir(env = process.env) {
  const base = env.ZIRA_CONFIG_DIR ? path.resolve(env.ZIRA_CONFIG_DIR)
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zira");
  return path.join(base, "readings-reports");
}

const reportsDir = (root = home()) => path.join(root, "reports");
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "report";

export function lastMs(value) {
  const m = /^([1-9]\d{0,2})(h|d|w)$/.exec(String(value ?? ""));
  if (!m) throw new Error("--last is a span such as 24h, 7d or 4w");
  const ms = Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
  if (ms > LIMITS.days * 86400e3) throw new Error(`--last covers at most ${LIMITS.days} days`);
  return ms;
}

async function readText(file, what, max = 2 * 1024 * 1024) {
  const p = path.resolve(String(file ?? ""));
  if (!file) throw new Error(`${what} is required`);
  if ((await stat(p)).size > max) throw new Error(`${what} is larger than ${max / 1024 / 1024} MiB`);
  return readFile(p, "utf8");
}

async function jsonArg(value, what) {
  const raw = String(value ?? "").startsWith("@") ? await readText(value.slice(1), what) : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

export async function describe({ datasetId, profile, deviceIds, root }) {
  const manifest = await readDataset(datasetId, { profile, root });
  const data = await loadDataset(manifest, { devices: deviceIds?.length ? deviceIds : null, root });
  return {
    kind: "readings-profile", dataset: manifest.id, site: manifest.site, from: manifest.from, to: manifest.to,
    siteOffsetMinutes: manifest.siteOffsetMinutes, notes: manifest.notes, devices: profileData(data),
  };
}

export async function query({ datasetId, profile, query: q, maxRows = 200, root }) {
  const manifest = await readDataset(datasetId, { profile, root });
  const data = await loadDataset(manifest, { root });
  const result = runQuery(data, q);
  const cells = tableCells(result);
  return {
    kind: "readings-query", dataset: manifest.id, columns: result.columns, rows: cells.slice(0, maxRows),
    meta: { ...result.meta, printedRows: Math.min(maxRows, cells.length) },
    units: Object.fromEntries((q.measures ?? []).filter(m => data.metrics[m.metric]?.unit).map(m => [m.metric, data.metrics[m.metric].unit])),
  };
}

export async function renderHtml({ spec, manifest, root = home(), now = new Date(), helper = null }) {
  const metrics = Object.fromEntries(manifest.devices.flatMap(d => d.metrics.map(m => [m.id, m])));
  const checked = checkSpec(spec, metrics);
  const data = await loadDataset(manifest, { metrics: specMetrics(checked), root });
  return { checked, html: buildReport({ spec, manifest, data, generatedAt: now.toISOString(), helper }) };
}

export async function writeReport({ spec, manifest, root = home(), now = new Date() }) {
  const { checked, html } = await renderHtml({ spec, manifest, root, now });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(reportsDir(root), `${slug(checked.title)}-${stamp}.html`);
  await writePrivate(file, html);
  // Lets `serve` rebuild this report with more dates.
  await writePrivate(sidecarFor(file), { version: 1, dataset: manifest.id, profile: manifest.profile, spec });
  return { kind: "readings-report", path: file, url: pathToFileURL(file).href, bytes: Buffer.byteLength(html),
    sections: checked.sections.length, kpis: checked.kpis.length, dataset: manifest.id };
}

export async function report({ call, profile, datasetId, specFile, save, last, saved, summaryFile, root, configDir = savedDir(), now = new Date(), log }) {
  if (saved) {
    if (!NAME.test(saved)) throw new Error("Saved report names use lowercase letters, digits and hyphens");
    const entry = await readJson(path.join(configDir, `${saved}.json`), null);
    if (!entry) throw new Error(`No saved report named ${saved}`);
    const s = entry.source;
    const manifest = await fetchDataset({ call: await call(s.profile), profile: s.profile, companyId: s.companyId, siteId: s.siteId,
      deviceIds: s.deviceIds, from: new Date(now - lastMs(s.last)).toISOString(), to: now.toISOString(), root, now: now.getTime(), log });
    const spec = { ...entry.spec, range: undefined };
    if (summaryFile) spec.summary = await readText(summaryFile, "--summary-file", 64 * 1024);
    else if (spec.summary) spec.summary = `**This summary was written for an earlier run; the key numbers and charts are current.**\n\n${spec.summary}`;
    return { ...await writeReport({ spec, manifest, root, now }), saved, complete: manifest.complete };
  }
  const manifest = await readDataset(datasetId, { profile, root });
  const spec = await jsonArg(`@${specFile}`, "--spec");
  const out = await writeReport({ spec, manifest, root, now });
  if (save) {
    if (!NAME.test(save)) throw new Error("--save names use lowercase letters, digits and hyphens");
    lastMs(last);
    const entry = { version: 1, name: save, savedAt: now.toISOString(),
      source: { profile: manifest.profile, companyId: manifest.company.id, siteId: manifest.site.id, deviceIds: manifest.devices.map(d => d.id), last },
      spec: { ...spec, range: undefined } };
    await writePrivate(path.join(configDir, `${save}.json`), entry);
    out.savedAs = save;
  }
  return out;
}

export async function listSaved(configDir = savedDir()) {
  let names = [];
  try { names = (await readdir(configDir)).filter(n => /\.json$/.test(n)); } catch { return { kind: "readings-saved", items: [] }; }
  const items = [];
  for (const n of names) {
    const e = await readJson(path.join(configDir, n), null);
    if (e?.name) items.push({ name: e.name, title: e.spec?.title, last: e.source?.last, siteId: e.source?.siteId, deviceIds: e.source?.deviceIds, savedAt: e.savedAt });
  }
  return { kind: "readings-saved", items };
}

export async function openReport({ report: file, root = home(), launcher = launchBrowser }) {
  const p = path.resolve(String(file ?? ""));
  if (path.dirname(p) !== reportsDir(root) || !p.endsWith(".html")) throw new Error("--report must be an HTML file in the readings reports folder");
  await stat(p);
  await launcher(pathToFileURL(p).href);
  return { kind: "readings-report-open", opened: true, path: p };
}

export async function listReports({ root = home(), limit = 10 } = {}) {
  const dir = reportsDir(root);
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith(".html")); } catch { return { kind: "readings-reports", items: [] }; }
  const files = await Promise.all(names.map(async n => ({ file: path.join(dir, n), mtime: (await stat(path.join(dir, n))).mtimeMs })));
  files.sort((a, b) => b.mtime - a.mtime);
  const items = await Promise.all(files.slice(0, limit).map(async ({ file, mtime }) => {
    const state = await readJson(sidecarFor(file), null);
    return { title: state?.spec?.title ?? path.basename(file, ".html"), path: file, url: pathToFileURL(file).href,
      liveUrl: await liveUrl(state), updatedAt: new Date(mtime).toISOString() };
  }));
  return { kind: "readings-reports", items, more: Math.max(0, files.length - limit) };
}

const SELF = fileURLToPath(import.meta.url);

/** Start this report's helper as its own process (or reuse a running one) and return its address. */
export async function serveDetached({ report: file, profile, idleMinutes, root = home(), waitMs = 20000, node = process.execPath, script = SELF, env = process.env }) {
  const { file: p, state } = await servable(file, root);
  const out = { kind: "readings-helper", path: p, savedUrl: pathToFileURL(p).href, idleMinutes };
  const running = await liveUrl(state);
  if (running) return { ...out, url: running, reused: true };
  const log = await open(logFor(p), "a", 0o600);
  try {
    const child = spawn(node, [script, "serve", "--report", p, "--foreground", "--idle-minutes", String(idleMinutes), "--profile", profile],
      { detached: true, stdio: ["ignore", log.fd, log.fd], env });
    let exited = null;
    child.once("exit", code => { exited = code ?? 1; });
    child.unref();
    for (const end = Date.now() + waitMs; Date.now() < end && exited === null;) {
      await new Promise(r => setTimeout(r, 200));
      const url = await liveUrl(await readJson(sidecarFor(p), null), { timeoutMs: 500 });
      if (url) return { ...out, url, reused: false, pid: child.pid };
    }
    const tail = (await readFile(logFor(p), "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ");
    if (exited === null) child.kill();
    throw new Error(`The report helper did not start${tail ? `: ${tail}` : ""}`);
  } finally {
    await log.close();
  }
}

export async function stopHelper({ report: file, root = home() }) {
  const { file: p, state } = await servable(file, root);
  // Only signal the recorded process while it still answers as this report's helper.
  const running = await liveUrl(state);
  if (running && Number.isInteger(state.helper.pid)) process.kill(state.helper.pid, "SIGTERM");
  return { kind: "readings-helper-stopped", path: p, wasRunning: !!running };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    profile: { type: "string" }, "company-id": { type: "string" }, "site-id": { type: "string" }, search: { type: "string" },
    "device-ids": { type: "string" }, metrics: { type: "boolean" }, from: { type: "string" }, to: { type: "string" },
    source: { type: "string" }, refresh: { type: "boolean" }, dataset: { type: "string" }, query: { type: "string" },
    "max-rows": { type: "string" }, spec: { type: "string" }, save: { type: "string" }, last: { type: "string" },
    saved: { type: "string" }, "summary-file": { type: "string" }, report: { type: "string" },
    open: { type: "boolean" }, "idle-minutes": { type: "string" }, foreground: { type: "boolean" }, stop: { type: "boolean" },
    limit: { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const session = p => liveSession(p, { allow: ROUTES, maxRequests: LIMITS.requests });
  const log = message => process.stderr.write(`${message}\n`);
  switch (args[0]) {
    case "sources":
      return sources({ call: await session(profile), profile, companyId: o["company-id"], siteId: o["site-id"],
        search: o.search, deviceIds: idList(o["device-ids"]), withMetrics: !!o.metrics });
    case "fetch": {
      const m = await fetchDataset({ call: await session(profile), profile, companyId: o["company-id"], siteId: o["site-id"],
        deviceIds: idList(o["device-ids"]), from: o.from, to: o.to, source: o.source ?? "auto", refresh: !!o.refresh, log });
      return { ...m, chunks: undefined, weeks: m.chunks.length, readings: m.chunks.reduce((s, c) => s + c.rows, 0),
        fromFiles: m.chunks.filter(c => c.source === "file").length, fromApi: m.chunks.filter(c => c.source === "api").length,
        siteFrom: formatLocal(Date.parse(m.from) + (m.siteOffsetMinutes[0] ?? 0) * 60000, "raw"),
        siteTo: formatLocal(Date.parse(m.to) + (m.siteOffsetMinutes[0] ?? 0) * 60000, "raw") };
    }
    case "datasets": return { kind: "readings-datasets", profile, items: await listDatasets({ profile }) };
    case "describe": return describe({ datasetId: o.dataset, profile, deviceIds: idList(o["device-ids"]) });
    case "query": {
      const max = o["max-rows"] ? Number(o["max-rows"]) : 200;
      if (!(max >= 1 && max <= 5000 && Number.isInteger(max))) throw new Error("--max-rows must be 1-5000");
      return query({ datasetId: o.dataset, profile, query: await jsonArg(o.query, "--query"), maxRows: max });
    }
    case "report":
      if (!o.saved && (!o.dataset || !o.spec)) throw new Error("report needs --dataset and --spec, or --saved NAME");
      if (o.save && !o.last) throw new Error("--save needs --last, the span each rerun covers (such as 7d)");
      return report({ call: session, profile, datasetId: o.dataset, specFile: o.spec, save: o.save, last: o.last,
        saved: o.saved, summaryFile: o["summary-file"], log });
    case "saved": return listSaved();
    case "reports": {
      const limit = o.limit ? Number(o.limit) : 10;
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new Error("--limit must be 1-100");
      return listReports({ limit });
    }
    case "open": return openReport({ report: o.report });
    case "serve": {
      const idleMinutes = o["idle-minutes"] ? Number(o["idle-minutes"]) : 120;
      if (!(idleMinutes >= 1 && idleMinutes <= 720)) throw new Error("--idle-minutes must be 1-720");
      if (o.stop) return stopHelper({ report: o.report });
      if (!o.foreground) {
        const out = await serveDetached({ report: o.report, profile, idleMinutes });
        if (o.open) await launchBrowser(out.url);
        return out;
      }
      const helper = await startHelper({ report: o.report, session, idleMinutes, log,
        render: async ({ spec, manifest, helper: bounds }) => (await renderHtml({ spec, manifest, helper: bounds })).html });
      console.log(JSON.stringify({ kind: "readings-helper", url: helper.url, idleMinutes, foreground: true }));
      if (o.open) await launchBrowser(helper.url);
      for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => helper.close());
      await helper.closed;
      return { kind: "readings-helper-stopped" };
    }
    default: throw new Error(`Unknown command ${args[0]}; run with --help`);
  }
}

if (isMain(import.meta)) runCli(main, { profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod" });
