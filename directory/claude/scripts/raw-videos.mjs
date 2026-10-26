// Raw recordings a Vision camera uploaded to Zira: the read-only listing route, the file names Zira's
// Videos tab saves them under, and owner-only downloads. Shared by calibrate-trimsaw-from-video's
// `videos` and validate-trimsaw-sizes' `scene`. Nothing here writes to Zira.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Blocked, ZiraApiError, route } from "./client.mjs";
import { views, webOrigin } from "./datasets.mjs";
import { fetchDownload } from "./downloads.mjs";

// The read-only platform route that lists a data source's uploaded raw recordings with 15-minute links
// (platform 779e1b2f6). It replaces downloading clips from Zira's Videos tab by hand. Newest first, at
// most LIST_LIMIT per request, `hasMore` when the window held more.
export const RAW_VIDEO_ROUTES = [["GET", /^\/prod-vision\/[1-9]\d*\/raw-videos$/]];
export const LIST_LIMIT = 200;
export const CONFIRM_DOWNLOAD_BYTES = 1024 ** 3;

// The file name Zira's Videos tab saves a raw clip under (its key's day/session/name with "/" as "_"),
// so a downloaded clip matches a manual download and carries its site-local start.
export const rawVideoFileName = v => `${v.day}_${v.session}_${v.name}`;

// A recording's site-local start from its name, as the platform reads it: `[RAW_]yyyyMMdd_HHmmss_SSS[_partNNN].mp4`,
// optionally behind the Videos tab's `day_session_` prefix. Null for anything else (VAL_ copies, partial files).
const NAME = /^(?:\d{4}-\d{2}-\d{2}_\d{4}(?:-\d{2}){5}_)?(?:RAW_)?(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d{3}(?:_part(\d{3}))?\.mp4$/i;
export function parseRawVideoName(name) {
  const m = path.basename(String(name ?? "")).match(NAME);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, part] = m;
  const at = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (at.getUTCMonth() !== +mo - 1 || at.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return null;
  return { recordedAtLocal: `${y}-${mo}-${d}T${h}:${mi}:${s}`, part: part === undefined ? null : Number(part) };
}

export async function listRawVideos(call, dataSourceId, { from, to, limit = 100 } = {}) {
  const reply = await call("GET", route(`/prod-vision/${dataSourceId}/raw-videos`, { from, to, limit }));
  const body = reply?.data ?? reply ?? {}; // platform responses arrive as { data: … }
  return { videos: (body.videos ?? []).map(v => ({ ...v, file: rawVideoFileName(v) })), hasMore: !!body.hasMore, expiresAt: body.expiresAt ?? null };
}

// The data source page and its Videos tab, where RAW VIDEOS can be downloaded by hand.
export function rawVideoLinks(dataSourceId, profile = "prod") {
  if (!/^\d+$/.test(String(dataSourceId ?? ""))) throw new Error("--data-source-id is required");
  const origin = webOrigin(profile);
  const validation = views(origin, { id: dataSourceId, type: "Vision" }).validation.url;
  const videos = new URL(validation); videos.searchParams.set("tab", "videos"); // RAW VIDEOS lives on the Videos tab
  return { dataSource: `${origin}/data-sources/${dataSourceId}`, validation, videos: videos.href };
}

// Lists like listRawVideos; a route Zira does not offer (403/404) becomes a blocked result with the Videos tab.
export async function listOrExplain(call, dataSourceId, query, { profile = "prod" } = {}) {
  try {
    return await listRawVideos(call, dataSourceId, query);
  } catch (error) {
    if (error instanceof ZiraApiError && [403, 404].includes(error.status)) {
      const { dataSource, videos: videosTab } = rawVideoLinks(dataSourceId, profile);
      throw new Blocked("raw_videos_unavailable", `Zira did not offer this data source's raw videos to the plugin (HTTP ${error.status}). The raw-video API (platform 779e1b2f6) may not be deployed yet; download the clips from the data source's Videos tab, RAW VIDEOS, instead.`, { dataSource, videosTab });
    }
    throw error;
  }
}

// Over 1 GiB needs the user's go-ahead (--confirm).
export function confirmDownload(listed, files, confirm) {
  const bytes = files.reduce((n, f) => n + (listed.find(v => v.file === f)?.size ?? 0), 0);
  if (bytes > CONFIRM_DOWNLOAD_BYTES && !confirm)
    throw new Blocked("large_download", `That is ${Math.round(bytes / 1048576)} MB; re-run with --confirm or name fewer clips.`, { files });
  return bytes;
}

// Downloads the named clips into `dir` (owner-only), skipping ones already there at full size. Links
// last 15 minutes, so an expired one (HTTP 403) is listed again once and retried.
export async function downloadRawVideos(listed, files, dir, { relist, fetchImpl, log = () => {} } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let byFile = new Map(listed.map(v => [v.file, v]));
  const done = [], present = [];
  for (const file of files) {
    let v = byFile.get(file);
    if (!v) throw new Blocked("video_not_listed", `${file} is not among the listed raw videos; widen --from/--to or --limit.`);
    const target = path.join(dir, path.basename(v.file));
    try { if ((await stat(target)).size === v.size) { present.push(v.file); continue; } } catch {}
    for (let attempt = 0; ; attempt++) {
      log(`Downloading ${v.file} (${Math.round(v.size / 1048576)} MB)`);
      const response = await fetchDownload(v.url, { fetchImpl, maxRedirects: 5, signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (response.status === 403 && attempt === 0 && relist) {
        await response.body?.cancel();
        byFile = new Map((await relist()).map(x => [x.file, x])); v = byFile.get(file) ?? v;
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Download of ${v.file} failed (HTTP ${response.status})`);
      const partial = `${target}.partial`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
      if (v.size && (await stat(partial)).size !== v.size) { await rm(partial, { force: true }); throw new Error(`Download of ${v.file} was incomplete`); }
      await rename(partial, target);
      done.push(v.file);
      break;
    }
  }
  return { downloaded: done, alreadyPresent: present };
}
