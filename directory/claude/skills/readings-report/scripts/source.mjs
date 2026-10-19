// Fetch one data source's readings as week chunks, the same shape next-gen dashboards use:
// weekly reading files (CSV via a pre-signed S3 link) when Zira has them ready, and
// analysis/data (compressed JSON, at most 7 days per request) for the rest.
import { downloadUrl, fetchDownload } from "../../../scripts/downloads.mjs";
import { unzipSync } from "node:zlib";
import { ZiraApiError } from "../../../scripts/client.mjs";
import { parseLocal, readingValue } from "./query-core.mjs";

export const WEEK_MS = 7 * 86400000;
export const DAY_MS = 86400000;
const RESERVED = new Set(["event_date", "event_date_with_offset", "event_date_at_site", "meter_id", "meter_name"]);
const MAX_ROWS_PER_CHUNK = 400000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

// Monday 00:00 UTC, matching the reading files' weekly boundaries.
export function weekStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
}

export function weeksBetween(fromMs, toMs) {
  const weeks = [];
  for (let w = weekStart(fromMs); w < toMs; w += WEEK_MS) weeks.push(w);
  return weeks;
}

// Zira's API takes UTC wall-clock strings without a zone suffix.
export const apiTime = ms => new Date(ms).toISOString().slice(0, 19);
export const weekKey = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

// Reading files write event_date as "2026-09-30 06:17:46.573+00" (Postgres timestamptz);
// analysis/data rows use ISO strings. Zone-less times are UTC.
export function utcMs(row) {
  const value = row.event_date;
  if (typeof value !== "string" || !value) return NaN;
  const iso = value.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00").replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? Date.parse(iso) : parseLocal(iso.replace(/\.\d+$/, ""));
}

// Site wall-clock ms. Reading files carry it exactly as event_date_epoch (the site's local time
// read as UTC, verified against live files); otherwise event_date_at_site, which may hold only
// minutes, gives the offset (rounded to 15 minutes) for the exact UTC time.
function siteMs(u, row) {
  const epoch = Number(row.event_date_epoch);
  if (row.event_date_epoch !== undefined && row.event_date_epoch !== "" && Number.isFinite(epoch) && Math.abs(epoch - u) <= 15 * 3600e3) return epoch;
  const local = parseLocal(String(row.event_date_at_site ?? "").trim().replace(/\.\d+$/, "").replace(/[zZ]$/, "").slice(0, 19));
  if (!Number.isFinite(local)) return null;
  return u + Math.round((local - u) / 900000) * 900000;
}

// Turn API or CSV rows into a columnar chunk. Site time comes from event_date_at_site;
// without it the chunk falls back to UTC and says so.
export function toChunk(rows, deviceId, { start, end, source, version = null, final }) {
  if (rows.length > MAX_ROWS_PER_CHUNK) throw new Error(`More than ${MAX_ROWS_PER_CHUNK} readings in one week for data source ${deviceId}`);
  const kept = [];
  let invalid = 0, foreign = 0, siteTime = true;
  for (const row of rows) {
    if (row.meter_id !== undefined && row.meter_id !== null && row.meter_id !== "" && String(row.meter_id) !== String(deviceId)) { foreign++; continue; }
    const u = utcMs(row);
    if (!Number.isFinite(u)) { invalid++; continue; }
    if (u < start || u >= end) continue;
    const t = siteMs(u, row);
    if (t === null) siteTime = false;
    kept.push([u, t ?? u, row]);
  }
  kept.sort((a, b) => a[0] - b[0]);
  const cols = {};
  kept.forEach(([, , row], i) => {
    for (const [key, raw] of Object.entries(row)) {
      if (RESERVED.has(key) || !/^\d+$/.test(key)) continue;
      const v = readingValue(raw);
      if (v === null) continue;
      (cols[key] ??= new Array(kept.length).fill(null))[i] = v;
    }
  });
  return {
    v: 1, deviceId: String(deviceId), week: weekKey(start), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    source, version, final, fetchedAt: new Date().toISOString(), timeBasis: siteTime || !kept.length ? "site" : "utc",
    rows: kept.length, invalid, foreign,
    u: kept.map(k => k[0]), t: kept.map(k => k[1]), cols,
  };
}

export function decodeReadings(body) {
  let b = body && Object.hasOwn(body, "data") ? body.data : body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(unzipSync(Buffer.from(b, "base64"), { maxOutputLength: 256 * 1024 * 1024 }).toString("utf8"));
    } catch {
      throw new Error("Cannot decode compressed readings");
    }
  }
  if (b === null) return [];
  if (!Array.isArray(b)) throw new Error("Unknown raw-reading response shape");
  return b;
}

// RFC 4180 CSV with a header row; quoted fields may hold commas, quotes and newlines.
export function parseCsv(textBody) {
  const rows = [];
  let field = "", row = [], quoted = false;
  const s = textBody.charCodeAt(0) === 0xfeff ? textBody.slice(1) : textBody;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("Reading file ends inside a quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header?.includes("event_date")) throw new Error("Reading file has no event_date column");
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// Pre-signed links carry their own authorization: never send the Zira sign-in to S3.
export async function downloadFile(url, { fetchImpl = globalThis.fetch } = {}) {
  try { downloadUrl(url); } catch { throw new Error("Reading file link is not a Zira S3 download"); }
  const response = await fetchDownload(url, { fetchImpl, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Reading file download failed (HTTP ${response.status})`);
  const size = Number(response.headers?.get?.("content-length") ?? 0);
  if (size > MAX_FILE_BYTES) throw new Error("Reading file exceeds 512 MiB");
  const body = await response.text();
  if (body.length > MAX_FILE_BYTES) throw new Error("Reading file exceeds 512 MiB");
  return body;
}

// One week from analysis/data. A week too large for one response is retried as days.
export async function apiWeek(call, deviceId, start, end, now) {
  const stop = Math.min(end, now);
  const read = async (from, to) => decodeReadings(await call("GET",
    `/analysis/data/${deviceId}?${new URLSearchParams({ startTime: apiTime(from), endTime: apiTime(to), force: "true" })}`));
  let rows;
  try {
    rows = stop > start ? await read(start, stop) : [];
  } catch (error) {
    const tooLarge = error instanceof ZiraApiError ? [413, 502, 504].includes(error.status) : /exceeds|decode/i.test(error.message);
    if (!tooLarge) throw error;
    rows = [];
    for (let d = start; d < stop; d += DAY_MS) rows.push(...await read(d, Math.min(d + DAY_MS, stop)));
  }
  return toChunk(rows, deviceId, { start, end, source: "api", final: end <= now - 3600000 });
}

// Reading files for up to 5 data sources over the weeks in [from, to).
export async function listFiles(call, deviceIds, from, to) {
  const body = await call("GET", `/meters-data/readings-files?${new URLSearchParams({ meterIds: deviceIds.join(","), startDate: apiTime(from), endDate: apiTime(to) })}`);
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!list) throw new Error("Unknown reading-file list shape");
  return list.map(f => ({
    deviceId: String(f.id ?? f.meterId ?? ""), fileName: String(f.fileName ?? ""), version: f.version == null ? null : String(f.version),
    outOfDate: f.outOfDate !== false, start: Date.parse(`${String(f.startDate).slice(0, 10)}T00:00:00Z`), url: typeof f.url === "string" ? f.url : null,
  })).filter(f => f.deviceId && Number.isFinite(f.start) && !/\(\d+\)$/.test(f.fileName));
}

export async function prepareFiles(call, deviceId, from, to) {
  await call("GET", `/meters-data/prepare-readings-files?${new URLSearchParams({ meterId: deviceId, startDate: apiTime(from), endDate: apiTime(to) })}`);
}

export async function fileWeek(file, { download = downloadFile } = {}) {
  const rows = parseCsv(await download(file.url));
  return toChunk(rows, file.deviceId, { start: file.start, end: file.start + WEEK_MS, source: "file", version: file.version, final: true });
}

export const emptyWeek = (deviceId, start, version) =>
  toChunk([], deviceId, { start, end: start + WEEK_MS, source: "file", version, final: true });
