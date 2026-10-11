// Local report helper: serves one readings report on 127.0.0.1 and lets that page load more
// dates with the plugin's sign-in. It reads Zira only and answers nothing but its own page.
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { Blocked, explain } from "../../../scripts/client.mjs";
import { readJson, writePrivate } from "../../health-report/scripts/storage.mjs";
import { formatLocal, parseLocal } from "./query-core.mjs";
import { LIMITS, fetchDataset, home, readDataset } from "./store.mjs";

const DAY = 86400e3;
const MAX_BODY = 4096;
const iso = ms => new Date(ms).toISOString();
const siteText = (ms, off) => formatLocal(ms + off, "raw").replace(" ", "T");

export const sidecarFor = file => file.replace(/\.html$/, ".spec.json");
export const logFor = file => file.replace(/\.html$/, ".serve.log");

/** A report file in the readings reports folder with the sidecar `serve` needs. */
export async function servable(report, root = home()) {
  const file = path.resolve(String(report ?? ""));
  if (path.dirname(file) !== path.join(root, "reports") || !file.endsWith(".html")) throw new Error("--report must be an HTML file in the readings reports folder");
  await stat(file);
  const state = await readJson(sidecarFor(file), null);
  if (!state?.dataset || !state.spec) throw new Error("This report was built before reports could be served; build it again with readings.mjs report");
  return { file, state };
}

/** The address of this report's helper when one is answering now, otherwise null. */
export async function liveUrl(state, { timeoutMs = 1500 } = {}) {
  const { port, token } = state?.helper ?? {};
  if (!Number.isInteger(port) || !/^[A-Za-z0-9_-]{24}$/.test(token ?? "")) return null;
  const url = `http://127.0.0.1:${port}/r/${token}/`;
  try {
    const res = await fetch(`${url}ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 204 ? url : null;
  } catch {
    return null;
  }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Start the helper for a report written by `readings.mjs report`. Returns { url, close, closed }.
 * `render(state, helperBounds)` builds the page; `session(profile)` gives a Zira call function.
 */
export async function startHelper({
  report, root = home(), session, render, now = () => Date.now(), idleMinutes = 120, port = 0, log = () => {}, fetch = fetchDataset,
}) {
  const { file, state } = await servable(report, root);
  const sidecar = sidecarFor(file);
  // A report keeps its address across helper restarts, so a tab left open keeps working.
  const saved = state.helper ?? {};
  const token = /^[A-Za-z0-9_-]{24}$/.test(saved.token ?? "") ? saved.token : randomBytes(18).toString("base64url");
  const base = `/r/${token}/`;
  let busy = false, timer, host, finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const idle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { log("Report helper idle; stopping"); close(); }, idleMinutes * 60000);
    timer.unref?.();
  };

  const page = async () => {
    const manifest = await readDataset(state.dataset, { profile: state.profile, root });
    const off = (manifest.siteOffsetMinutes?.[0] ?? 0) * 60000;
    const t = now();
    return render({ spec: state.spec, manifest, helper: { min: siteText(t - LIMITS.days * DAY, off), max: siteText(t, off) } });
  };

  const extend = async body => {
    let wanted;
    try { wanted = JSON.parse(body); } catch { throw new Blocked("invalid", "Send JSON with from and to"); }
    const from = parseLocal(wanted?.from), to = parseLocal(wanted?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Blocked("invalid", "Choose a start before the end");
    const manifest = await readDataset(state.dataset, { profile: state.profile, root });
    const off = (manifest.siteOffsetMinutes?.[0] ?? 0) * 60000;
    const t = now();
    // Keep what the report already holds and add the requested dates.
    const start = Math.min(from - off, Date.parse(manifest.from));
    const end = Math.min(Math.max(to - off, Date.parse(manifest.to)), t);
    if (end - start > LIMITS.days * DAY) throw new Blocked("too_large", `One report holds at most ${LIMITS.days} days; choose a later start or ask in chat for a separate report.`);
    log(`Loading ${iso(start)} – ${iso(end)} for the report`);
    const call = await session(manifest.profile);
    const next = await fetch({
      call, profile: manifest.profile, companyId: manifest.company.id, siteId: manifest.site.id,
      deviceIds: manifest.devices.map(d => d.id), from: iso(start), to: iso(end), root, now: t, log,
    });
    state.dataset = next.id;
    const label = v => v.replace("T", " ").slice(0, 16);
    const written = state.spec.summaryFor ?? `${label(siteText(Date.parse(manifest.from), off))} – ${label(siteText(Date.parse(manifest.to), off))}`;
    state.spec = { ...state.spec, range: { from: wanted.from, to: wanted.to }, ...(state.spec.summary ? { summaryFor: written } : {}) };
    await writePrivate(sidecar, state);
    // The saved file is the copy that still opens once the helper stops, so it holds the new dates too.
    await writePrivate(file, await render({ spec: state.spec, manifest: await readDataset(next.id, { profile: state.profile, root }), helper: null }));
    return { ok: true, dataset: next.id, readings: next.chunks.reduce((n, c) => n + c.rows, 0), notes: next.notes };
  };

  const server = http.createServer(async (req, res) => {
    idle();
    try {
      // Only this page, addressed exactly as handed out (no DNS rebinding, no other origins).
      if (req.headers.host !== host) return send(res, 421, { message: "Wrong host" });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === base || url.pathname === `${base}index.html`) {
        if (req.method !== "GET") return send(res, 405, { message: "Method not allowed" });
        return send(res, 200, await page(), "text/html; charset=utf-8");
      }
      // The open page checks in every few minutes, so the helper stays up while someone has it open.
      if (url.pathname === `${base}ping`) {
        if (req.method !== "GET") return send(res, 405, { message: "Method not allowed" });
        res.writeHead(204, { "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname === `${base}extend`) {
        if (req.method !== "POST") return send(res, 405, { message: "Method not allowed" });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { message: "Send JSON" });
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${host}`) || ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]))
          return send(res, 403, { message: "Only this report can load dates" });
        if (busy) return send(res, 409, { message: "Already loading; wait for it to finish" });
        busy = true;
        try {
          return send(res, 200, await extend(await readBody(req)));
        } finally {
          busy = false;
        }
      }
      return send(res, 404, { message: "Not found" });
    } catch (error) {
      const blocked = explain(error, { profile: state.profile });
      const status = error.status ?? (blocked ? (["authorization", "sign_in"].includes(blocked.reason) ? 401 : blocked.reason === "rate_limit" ? 429 : 400) : 500);
      log(`Report helper: ${error.message}`);
      return send(res, status, { message: blocked?.message ?? error.message, ...(blocked ? { reason: blocked.reason } : {}) });
    }
  });

  const listen = p => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const preferred = port || (Number.isInteger(saved.port) && saved.port > 1023 && saved.port < 65536 ? saved.port : 0);
  try {
    await listen(preferred);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || !preferred) throw error;
    log(`Port ${preferred} is busy; using another, so open the new url`);
    await listen(0);
  }
  host = `127.0.0.1:${server.address().port}`;
  state.helper = { port: server.address().port, token, pid: process.pid };
  await writePrivate(sidecar, state);
  function close() {
    clearTimeout(timer);
    server.close(() => finish());
    server.closeAllConnections?.();
  }
  idle();
  return { url: `http://${host}${base}`, close, closed };
}
