// Local readings cache and datasets. Week chunks are cached per data source and reused by
// every dataset; a dataset is a manifest naming the sources, range and chunks it covers.
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { Blocked, ZiraApiError, fingerprint, id, link, resolveSite, siteDataSources } from "../../../scripts/client.mjs";
import { healthProfile } from "../../health-report/scripts/api.mjs";
import { readJson, writePrivate } from "../../health-report/scripts/storage.mjs";
import { formatLocal, readingValue } from "./query-core.mjs";
import { WEEK_MS, apiWeek, emptyWeek, fileWeek, listFiles, prepareFiles, weekKey, weeksBetween } from "./source.mjs";

export const LIMITS = { devices: 10, days: 366, apiDeviceWeeks: 20, fileDeviceWeeks: 530, requests: 400, prepareWaitSeconds: 60 };

export function home(env = process.env) {
  return env.ZIRA_READINGS_HOME
    ? path.resolve(env.ZIRA_READINGS_HOME)
    : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "zira", "readings");
}

const chunkFile = (root, profile, deviceId, week) => path.join(root, profile, "chunks", deviceId, `${week}.json.gz`);
const datasetFile = (root, profile, datasetId) => path.join(root, profile, "datasets", `${datasetId}.json`);

// A missing or damaged cache entry reads as absent and is fetched again.
async function readChunk(file) {
  try {
    return JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
  } catch {
    return null;
  }
}

async function writeChunk(file, chunk) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, gzipSync(JSON.stringify(chunk)), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}

// Accept explicit UTC/offset instants only; the agent converts "last week" with the site's zone.
export function parseRange(from, to, now = Date.now()) {
  const f = Date.parse(from), t = to ? Date.parse(to) : now;
  const zoned = s => typeof s === "string" && /T\d\d:\d\d(:\d\d(\.\d+)?)?([zZ]|[+-]\d\d:\d\d)$/.test(s);
  if (!zoned(from) || (to && !zoned(to)) || !Number.isFinite(f) || !Number.isFinite(t))
    throw new Error("--from/--to must be ISO instants with Z or an offset, such as 2026-09-01T00:00:00-05:00");
  if (f >= t) throw new Error("--from must be before --to");
  if (f > now) throw new Error("--from is in the future");
  if (t - f > LIMITS.days * 86400000) throw new Error(`One dataset covers at most ${LIMITS.days} days`);
  return { from: f, to: Math.min(t, now) };
}

// Zira's unit field also names value kinds ("Number", "List", "Text"); those are not units.
const NOT_UNITS = new Set(["number", "list", "text", "boolean", "date", "timestamp", "image", "attachment"]);
const cleanUnit = u => (u && !NOT_UNITS.has(String(u).toLowerCase()) ? String(u) : null);
const unitOf = m => cleanUnit(m.uom?.name ?? m.uom?.symbol ?? m.displaySymbol ?? null);

export function metricList(device) {
  return (device?.meterSchema?.metrics ?? [])
    .map(m => ({
      id: String(m.metric?.id ?? m.metricId ?? ""),
      name: String(m.displayName ?? m.metric?.name ?? m.metric?.id ?? ""),
      unit: unitOf(m),
      dataType: m.dataType?.name ?? (typeof m.dataType === "string" ? m.dataType : null),
      internal: m.isInternal === true,
    }))
    .filter(m => id(m.id));
}

// Metric definitions come from the device detail list, five data sources per request.
export async function describeSources(call, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const body = await call("GET", `/devices/all?${new URLSearchParams({ meterIds: chunk.join(","), expand: "true", isTemplate: "false" })}`);
    for (const d of body?.data ?? []) if (chunk.includes(String(d?.id))) out.set(String(d.id), d);
  }
  return out;
}

export async function sources({ call, profile, companyId, siteId, search, deviceIds, withMetrics = false }) {
  const site = await resolveSite(call, companyId, siteId);
  let rows = await siteDataSources(call, site, search ? { textSearch: String(search).slice(0, 100) } : {});
  if (deviceIds?.length) rows = rows.filter(d => deviceIds.includes(String(d.id)));
  const items = rows.map(d => ({
    id: String(d.id), name: String(d.name ?? "Unnamed"),
    ...(typeof d.applying?.name === "string" ? { type: d.applying.name } : {}),
    url: link(profile, `/data-sources/${d.id}`),
  }));
  if (withMetrics) {
    if (items.length > 25) throw new Blocked("too_many", "More than 25 data sources match; search by name or pass --device-ids before reading metrics.", { count: items.length });
    const details = await describeSources(call, items.map(i => i.id));
    for (const item of items) {
      const detail = details.get(item.id);
      // Device type from its vision settings (trimsaw, bandsaw, pallet-qa); absent for others.
      const posting = healthProfile(detail?.cv?.settings);
      if (posting) item.deviceType = posting;
      item.metrics = metricList(detail).filter(m => !m.internal).map(({ internal, ...m }) => m);
    }
  }
  return { kind: "readings-sources", profile, site: { id: site.id, name: site.name, companyId }, items };
}

// Plan, fetch and cache every week each data source needs, then write the dataset manifest.
export async function fetchDataset({
  call, profile, companyId, siteId, deviceIds, from, to, source = "auto", refresh = false,
  root = home(), now = Date.now(), download, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {},
}) {
  if (!["auto", "files", "api"].includes(source)) throw new Error("--source must be auto, files or api");
  const ids = [...new Set(deviceIds.map(String))];
  if (!ids.length || ids.some(x => !id(x))) throw new Error("Give one or more data source IDs");
  if (ids.length > LIMITS.devices) throw new Error(`Select at most ${LIMITS.devices} data sources per dataset`);
  const range = parseRange(from, to, now);
  const site = await resolveSite(call, companyId, siteId);
  const inSite = new Map((await siteDataSources(call, site)).map(d => [String(d.id), d]));
  const missing = ids.filter(x => !inSite.has(x));
  if (missing.length) throw new Blocked("scope", `Data source ${missing.join(", ")} is not in the selected site`);
  const details = await describeSources(call, ids);
  const weeks = weeksBetween(range.from, range.to);
  const plan = ids.flatMap(deviceId => weeks.map(w => ({ deviceId, start: w, end: w + WEEK_MS })));
  const notes = [];
  const chunks = new Map();
  const key = (d, w) => `${d}:${w}`;

  // Reading files first: list once per five sources, prepare stale weeks, wait briefly, list again.
  let filesState = source === "api" ? "skipped" : "unknown", failedDownloads = 0;
  if (source !== "api") {
    if (plan.length > LIMITS.fileDeviceWeeks) throw new Error(`At most ${LIMITS.fileDeviceWeeks} source-weeks per dataset; shorten the range or select fewer sources`);
    const list = async () => {
      const found = new Map();
      for (let i = 0; i < ids.length; i += 5)
        for (const f of await listFiles(call, ids.slice(i, i + 5), weeks[0], range.to))
          if (ids.includes(f.deviceId)) found.set(key(f.deviceId, f.start), f);
      return found;
    };
    try {
      let files = await list();
      filesState = "available";
      const stale = () => plan.filter(p => files.get(key(p.deviceId, p.start))?.outOfDate);
      if (stale().length) {
        for (const deviceId of [...new Set(stale().map(p => p.deviceId))]) await prepareFiles(call, deviceId, weeks[0], range.to);
        log(`Asked Zira to prepare ${stale().length} reading files; waiting up to ${LIMITS.prepareWaitSeconds}s`);
        for (let waited = 0; stale().length && waited < LIMITS.prepareWaitSeconds; waited += 10) {
          await sleep(10000);
          files = await list();
        }
      }
      for (const p of plan) {
        const f = files.get(key(p.deviceId, p.start));
        const file = chunkFile(root, profile, p.deviceId, weekKey(p.start));
        if (f?.outOfDate || (f && !f.url)) continue; // left for analysis/data
        const version = f ? f.version : "empty";
        const cached = refresh ? null : await readChunk(file);
        if (cached?.source === "file" && cached.version === version) { chunks.set(key(p.deviceId, p.start), cached); continue; }
        let chunk;
        try {
          chunk = f ? await fileWeek(f, { download }) : emptyWeek(p.deviceId, p.start, version);
        } catch (error) {
          if (source === "files") throw error;
          failedDownloads++;
          continue; // read from analysis/data instead
        }
        await writeChunk(file, chunk);
        chunks.set(key(p.deviceId, p.start), chunk);
      }
      if (failedDownloads) notes.push(`${failedDownloads} reading files could not be downloaded, so those weeks came from analysis/data.`);
    } catch (error) {
      if (!(error instanceof ZiraApiError) || source === "files" && ![401, 403].includes(error.status)) throw error;
      if ([401, 403].includes(error.status)) {
        filesState = "not-enabled";
        if (source === "files") throw new Blocked("authorization", "Reading files are not enabled for plugin sign-in yet; nothing was downloaded. Use --source api for ranges up to a few weeks.");
        notes.push("Reading files are not enabled for plugin sign-in yet, so readings came from analysis/data.");
      } else {
        filesState = "unavailable";
        notes.push(`Reading files were unavailable (${error.message}), so readings came from analysis/data.`);
      }
    }
  }

  // Everything else from analysis/data. Completed weeks are reused from the cache; the
  // current week is cached for this dataset but read again by the next fetch.
  const rest = plan.filter(p => !chunks.has(key(p.deviceId, p.start)));
  const needed = [];
  for (const p of rest) {
    const cached = refresh ? null : await readChunk(chunkFile(root, profile, p.deviceId, weekKey(p.start)));
    // With files available, a week left here has a newer or stale file, so its cached copy is outdated.
    if (cached?.final && !(filesState === "available" && cached.source === "file")) chunks.set(key(p.deviceId, p.start), cached);
    else needed.push(p);
  }
  if (needed.length > LIMITS.apiDeviceWeeks)
    throw new Blocked("too_large", `This needs ${needed.length} source-weeks from analysis/data (limit ${LIMITS.apiDeviceWeeks} per fetch while reading files are unavailable). Shorten the range or select fewer data sources, then fetch the rest separately; cached weeks are reused.`, { needed: needed.length, limit: LIMITS.apiDeviceWeeks, filesState });
  for (const p of needed) {
    log(`Reading ${p.deviceId} week of ${weekKey(p.start)} from analysis/data`);
    const chunk = await apiWeek(call, p.deviceId, p.start, p.end, now);
    await writeChunk(chunkFile(root, profile, p.deviceId, weekKey(p.start)), chunk);
    chunks.set(key(p.deviceId, p.start), chunk);
  }

  const devices = ids.map(deviceId => {
    const listed = inSite.get(deviceId), detail = details.get(deviceId);
    const own = plan.filter(p => p.deviceId === deviceId).map(p => chunks.get(key(p.deviceId, p.start)));
    const seen = new Set(own.flatMap(c => Object.keys(c.cols)));
    const metrics = metricList(detail).filter(m => !m.internal || seen.has(m.id)).map(({ internal, ...m }) => m);
    for (const m of seen) if (!metrics.some(x => x.id === m)) metrics.push({ id: m, name: m, unit: null, dataType: null });
    return {
      id: deviceId, name: String(listed?.name ?? detail?.name ?? deviceId),
      ...(typeof listed?.applying?.name === "string" ? { type: listed.applying.name } : {}),
      url: link(profile, `/data-sources/${deviceId}`),
      metrics: metrics.map(m => ({ ...m, present: seen.has(m.id) })),
    };
  });
  const all = [...chunks.values()];
  const offsets = new Set();
  for (const c of all) for (let i = 0; i < c.u.length; i += Math.max(1, Math.floor(c.u.length / 50))) offsets.add(Math.round((c.t[i] - c.u[i]) / 60000));
  const utcOnly = all.some(c => c.rows && c.timeBasis === "utc");
  if (utcOnly) notes.push("Some readings had no site time; those weeks use UTC.");
  const invalid = all.reduce((n, c) => n + (c.invalid ?? 0) + (c.foreign ?? 0), 0);
  if (invalid) notes.push(`${invalid} readings were skipped (missing time or a different data source).`);
  const datasetId = `ds-${fingerprint({ profile, ids: [...ids].sort(), from: range.from, to: range.to }).slice(0, 10)}`;
  const manifest = {
    kind: "readings-dataset", version: 1, id: datasetId, profile,
    company: { id: companyId }, site: { id: site.id, name: site.name },
    from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(),
    siteOffsetMinutes: [...offsets].sort((a, b) => a - b),
    timeBasis: utcOnly ? "mixed" : "site", files: filesState,
    devices,
    chunks: plan.map(p => {
      const c = chunks.get(key(p.deviceId, p.start));
      return { deviceId: p.deviceId, week: weekKey(p.start), source: c.source, rows: c.rows, final: c.final, version: c.version };
    }),
    fetchedAt: new Date(now).toISOString(),
    complete: invalid === 0,
    notes,
  };
  await writePrivate(datasetFile(root, profile, datasetId), manifest);
  return manifest;
}

export async function readDataset(datasetId, { profile = "prod", root = home() } = {}) {
  if (!/^ds-[0-9a-f]{10}$/.test(String(datasetId))) throw new Error("Unknown dataset ID");
  const manifest = await readJson(datasetFile(root, profile, datasetId), null);
  if (!manifest) throw new Error(`Dataset ${datasetId} is not in the local cache for ${profile}; fetch it again`);
  return manifest;
}

export async function listDatasets({ profile = "prod", root = home() } = {}) {
  const dir = path.join(root, profile, "datasets");
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter(n => /^ds-[0-9a-f]{10}\.json$/.test(n))) {
    const m = await readJson(path.join(dir, n), null);
    if (m) out.push({ id: m.id, site: m.site, devices: m.devices.map(d => ({ id: d.id, name: d.name })), from: m.from, to: m.to, fetchedAt: m.fetchedAt,
      rows: m.chunks.reduce((s, c) => s + c.rows, 0) });
  }
  return out.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
}

// Load a dataset's rows for the query engine, clipped to its UTC range. Only the requested
// metrics are kept, so a report embeds no more than its charts use.
export async function loadDataset(manifest, { metrics = null, devices = null, root = home() } = {}) {
  const from = Date.parse(manifest.from), to = Date.parse(manifest.to);
  const out = { devices: [], metrics: {} };
  for (const d of manifest.devices) {
    // Datasets saved before value kinds were filtered may still list "Number" as a unit.
    for (const m of d.metrics) if (!out.metrics[m.id]) out.metrics[m.id] = { name: m.name, unit: cleanUnit(m.unit), dataType: m.dataType };
    if (devices && !devices.includes(d.id)) continue;
    const t = [], u = [], cols = {};
    for (const c of manifest.chunks.filter(c => c.deviceId === d.id)) {
      const chunk = await readChunk(chunkFile(root, manifest.profile, d.id, c.week));
      if (!chunk) throw new Error(`Cached week ${c.week} of data source ${d.id} is missing; fetch the dataset again`);
      const keep = metrics ?? Object.keys(chunk.cols);
      for (let i = 0; i < chunk.u.length; i++) {
        if (chunk.u[i] < from || chunk.u[i] >= to) continue;
        const n = t.length;
        t.push(chunk.t[i]); u.push(chunk.u[i]);
        for (const k of keep) {
          const v = chunk.cols[k]?.[i] ?? null;
          if (v !== null) (cols[k] ??= [])[n] = v;
        }
      }
    }
    for (const k of Object.keys(cols)) for (let i = 0; i < t.length; i++) if (cols[k][i] === undefined) cols[k][i] = null;
    out.devices.push({ id: d.id, name: d.name, t, u, cols });
  }
  return out;
}

// A compact profile of each metric so the agent can choose charts and describe the data.
export function profileData(data, { maxValues = 5 } = {}) {
  return data.devices.map(d => ({
    id: d.id, name: d.name, readings: d.t.length,
    first: d.t.length ? formatLocal(d.t[0], "raw") : null,
    last: d.t.length ? formatLocal(d.t[d.t.length - 1], "raw") : null,
    metrics: Object.entries(d.cols).map(([k, col]) => {
      let n = 0, nums = 0, sum = 0, min = null, max = null;
      const counts = new Map();
      for (const raw of col) {
        const v = readingValue(raw);
        if (v === null) continue;
        n++;
        if (typeof v === "number") {
          nums++; sum += v;
          if (min === null || v < min) min = v;
          if (max === null || v > max) max = v;
        } else if (counts.size < 1000 || counts.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const meta = data.metrics[k] ?? {};
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxValues).map(([value, count]) => ({ value: String(value).slice(0, 80), count }));
      return {
        id: k, name: meta.name ?? k, ...(meta.unit ? { unit: meta.unit } : {}), values: n, empty: d.t.length - n,
        ...(nums ? { numeric: nums, min, max, avg: Number((sum / nums).toPrecision(6)) } : {}),
        ...(top.length ? { text: top, distinct: counts.size >= 1000 ? "1000+" : counts.size } : {}),
      };
    }).sort((a, b) => b.values - a.values),
  }));
}
