// Download links have their own authorization. Never attach Zira credentials, and
// validate each destination before a request, including redirects from short links.
const S3_HOST = /^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;
const SHORT_LINK_ORIGINS = new Set(['https://api.zira.us', 'https://integ.api.zira.us']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function downloadUrl(value, { allowShortLinks = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid download link'); }
  const storage = S3_HOST.test(url.hostname);
  const shortLink = allowShortLinks && SHORT_LINK_ORIGINS.has(url.origin)
    && /^\/public\/short-link\/[^/]+$/.test(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!storage && !shortLink))
    throw new Error('Untrusted download destination; expected a Zira S3 download or approved short link');
  return url;
}

export async function fetchDownload(value, {
  fetchImpl = globalThis.fetch, signal, allowShortLinks = false, maxRedirects = 0,
} = {}) {
  let url = downloadUrl(value, { allowShortLinks });
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(url.href, { redirect: 'manual', signal });
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel();
    if (hop >= maxRedirects) throw new Error('Download redirect limit exceeded');
    const location = response.headers.get('location');
    if (!location) throw new Error('Download redirect is missing its destination');
    url = downloadUrl(new URL(location, url).href, { allowShortLinks });
  }
}
