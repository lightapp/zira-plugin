// Shared runtime for Zira action skills: bounded authenticated calls, scope checks,
// links, duplicate-safe write receipts and honest "continue in Zira" handoffs.
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { toolkit, pages } from "../skills/health-report/scripts/api.mjs";
import { boundedFetch } from "../skills/health-report/scripts/limits.mjs";
import { id } from "../skills/health-report/scripts/config.mjs";
import { readJson, writePrivate, withLock } from "../skills/health-report/scripts/storage.mjs";
import { originFor } from "./browse.mjs";
import { ZiraApiError } from "../skills/health-report/scripts/task-api.mjs";

export { id, originFor, ZiraApiError };

async function errorInfo(response) {
  try {
    const raw = await response.text();
    if (raw.length > 64 * 1024) return {};
    const body = JSON.parse(raw);
    const candidate = body?.error?.code ?? body?.internalErrorCode;
    const code = typeof candidate === "string" && /^[A-Z0-9_-]{1,64}$/i.test(candidate) ? candidate : undefined;
    // Admission errors are deliberately sanitized by the backend. Do not expose arbitrary
    // legacy SQL messages; legacy details remain available for the P0001 attachment flow.
    const message = code && typeof body?.error?.message === "string" ? text(body.error.message, 500) : undefined;
    return { code, message, details: code && typeof body.details === "string" ? body.details : undefined };
  } catch {
    return {};
  }
}

// A blocked result is an expected stop (authorization, duplicate, limit, uncertain write),
// reported as JSON with exit 4 so the skill can explain it and offer the web continuation.
export class Blocked extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

export const MAX_TEXT = 4000;
export const text = (value, max = MAX_TEXT) =>
  typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
export const normalizeName = value =>
  String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const idList = value => [...new Set(String(value ?? "").split(/[\s,]+/).filter(Boolean))];
export const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export function route(pathname, params = {}) {
  const q = new URLSearchParams(Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)]));
  return q.size ? `${pathname}?${q}` : pathname;
}

export function link(profile, pathname, params) {
  if (!/^\/[a-z-]+(\/[1-9]\d*)?$|^\/forms\/new$/.test(pathname)) throw new Error("Unsupported Zira link");
  return `${originFor(profile)}${route(pathname, params)}`;
}

export const assistantUrl = profile => `${originFor(profile)}/ai-assistant`;

// The web assistant does not receive chat state; the prompt is for the user to paste.
export function handoff(profile, { prompt, pageUrl, details } = {}) {
  return {
    assistantUrl: assistantUrl(profile),
    ...(pageUrl ? { pageUrl } : {}),
    ...(prompt ? { prompt } : {}),
    ...(details ? { details } : {}),
    note: "Opening Zira does not transfer this chat, select the site, or submit the prompt. Select the same company and site there.",
  };
}

// Live calls use the plugin's browser sign-in. Each helper passes an allowlist so a
// skill cannot turn this into an arbitrary API proxy.
export async function liveSession(profile, { allow, maxRequests = 30, auth, fetchImpl = globalThis.fetch } = {}) {
  originFor(profile);
  const { getAuthorizationToken } = auth ?? await toolkit();
  const origin = profile === "prod" ? "https://api.zira.us" : "https://integ.api.zira.us";
  const fetchLimited = boundedFetch({
    maxRequests,
    fetchImpl: (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) }),
  });
  return async (method, target, body) => {
    const pathname = target.split("?")[0];
    if (!allow?.some(([m, pattern]) => m === method && pattern.test(pathname)))
      throw new Error(`Route not allowed for this action: ${method} ${pathname}`);
    const url = new URL(target, origin);
    if (url.origin !== origin || url.hash) throw new Error("Route not allowed for this action");
    // Refresh before sending. Only a read can be replayed after a 401; a write
    // has one attempt so local receipts can safely track an uncertain outcome.
    const send = async forceRefresh => fetchLimited(url.href, {
      method, redirect: "manual",
      headers: { Authorization: await getAuthorizationToken({ profileName: profile, forceRefresh, fetchImpl: fetchLimited }),
        Accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await send(false);
    if (response.status === 401 && method === "GET") {
      await response.body?.cancel();
      response = await send(true);
    }
    if (!response.ok)
      throw new ZiraApiError(response.status, `${method} ${pathname.replace(/\/[1-9]\d*/g, "/{id}")}`, await errorInfo(response));
    const raw = await response.text();
    if (raw.length > 8 * 1024 * 1024) throw new Error("API response exceeds 8 MiB cap");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON response");
    }
  };
}

const SIGN_IN_ERROR = /not logged in|run `zira login`|Unable to refresh profile/i;

// Convert expected failures into a Blocked stop; anything else stays an ordinary error.
export function explain(error, { profile = "prod", handoffInfo } = {}) {
  if (error instanceof Blocked) return error;
  const next = handoffInfo ? { handoff: handoff(profile, handoffInfo) } : {};
  if (error?.code === "HEALTH_REQUEST_LIMIT" && !(error instanceof ZiraApiError))
    return new Blocked("rate_limit", error.message, { ...next, retry: "Wait for the stated retry time; do not switch identities or scopes." });
  if (SIGN_IN_ERROR.test(error?.message ?? ""))
    return new Blocked("sign_in", "Zira sign-in is required. Run the health-report `auth login` command and let the user finish browser sign-in.", next);
  if (error instanceof ZiraApiError) {
    if ([401, 403].includes(error.status))
      return new Blocked("authorization", `${error.operation} was rejected (HTTP ${error.status}). If other Zira skills work with this sign-in, this API has not been enabled for plugin sign-in or this user lacks permission; nothing was changed.`, { status: error.status, ...next });
    if (error.status === 404)
      return new Blocked("not_found", `${error.operation} returned HTTP 404: the record is missing or not visible to this user.`, { status: 404, ...next });
    if (error.status === 409)
      return new Blocked("conflict", `${error.operation} returned HTTP 409: a conflicting record already exists.`, { status: 409, ...next });
  }
  return null;
}

// A 4xx, limit or sign-in denial was never executed; network, timeout and 5xx outcomes are unknown.
export const definiteFailure = error =>
  error instanceof Blocked ||
  SIGN_IN_ERROR.test(error?.message ?? "") ||
  (error?.code === "HEALTH_REQUEST_LIMIT" && !(error instanceof ZiraApiError)) ||
  (error instanceof ZiraApiError && error.status >= 400 && error.status < 500 && error.status !== 408);

export async function listAll(call, pathname, params, maxPages = 10) {
  return pages(target => call("GET", target), pathname, params, maxPages);
}

export async function siteDataSources(call, site, params = {}) {
  const rows = await listAll(call, "/devices/list", { siteIds: site.id, companyIds: site.companyId, ...params });
  return rows.filter(d => {
    const company = d?.company?.id ?? d?.companyId;
    return id(String(d?.id ?? "")) && !d.isDeleted && !d.isTemplate &&
      String(d.site?.id ?? d.siteId ?? "") === site.id && (company == null || String(company) === site.companyId);
  });
}

export async function resolveSite(call, companyId, siteId) {
  if (!id(companyId)) throw new Error("Company ID required");
  if (!id(siteId)) throw new Error("Site ID required");
  const sites = await listAll(call, "/sites/list", { companyIds: companyId });
  const row = sites.find(s => String(s.id) === siteId && !s.isDeleted);
  if (!row || String(row.company?.id ?? row.companyId ?? "") !== companyId)
    throw new Blocked("scope", "Site is not an authorized site of the selected company");
  return {
    id: siteId,
    name: String(row.name ?? "Unnamed site"),
    companyId,
    channelId: id(String(row.channelId ?? "")) ? String(row.channelId) : null,
  };
}

// The site's system (used to attach new data sources) lives on its channel context.
export async function siteSystem(call, site) {
  if (!site.channelId) return null;
  try {
    const channel = (await call("GET", `/channels/${site.channelId}`)).data ?? {};
    const ctx = channel.context ?? {};
    return String(ctx.site ?? "") === site.id && id(String(ctx.system ?? "")) ? String(ctx.system) : null;
  } catch {
    return null;
  }
}

export const personName = user =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.name || user?.email || "User";

export async function currentUser(call) {
  const user = (await call("GET", "/users/details")).data;
  if (!id(String(user?.id ?? ""))) throw new Error("Current user details are unavailable");
  return { id: String(user.id), name: personName(user) };
}

export async function siteMembers(call, siteId) {
  const rows = await listAll(call, "/users/site-members", { siteIds: siteId, includeIndirectUsers: "true", includeInactive: "false" });
  return rows
    .filter(u => id(String(u?.id ?? "")) && !u.isDeleted && u.isActive !== false && !u.isFakeEmail)
    .map(u => ({ id: String(u.id), name: personName(u) }));
}

export function receiptsFile(file, env = process.env) {
  if (file) return path.resolve(file);
  const dir = env.ZIRA_STATE_DIR
    ? path.resolve(env.ZIRA_STATE_DIR)
    : env.ZIRA_CONFIG_DIR
      ? path.resolve(env.ZIRA_CONFIG_DIR)
      : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zira");
  return path.join(dir, "action-receipts.json");
}

// A lock left behind by a process that no longer exists is stale and removed once.
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
async function withActionLock(file, fn) {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withLock(lock, fn);
    } catch (error) {
      if (!/holds this state lock/.test(error?.message ?? "")) throw error;
      let holder = null;
      try { holder = JSON.parse(await readFile(lock, "utf8")); } catch { /* being written or unreadable */ }
      if (attempt || !Number.isInteger(holder?.pid) || alive(holder.pid))
        throw new Blocked("busy", `Another Zira action is using ${lock}. Wait for it to finish; if no Zira helper is running, remove that lock file.`);
      await unlink(lock).catch(() => {});
    }
  }
}

const describeCreated = created => Object.entries(created).map(([k, v]) => `${k} ${v}`).join(", ");

// One receipt per intended write. `pending` means the outcome is unknown: reconcile it from
// Zira, or let the user resolve it (`resolve: "none"` or the record's ID) after checking Zira.
// `partial` means some records of a multi-step write exist. Repeats get their own slot so
// the original receipt survives.
export async function guardedWrite({
  file, key, summary, allowRepeat = false, reconcile, precheck, run, resolve, resolveField = "recordId", links = () => ({}), resume,
}) {
  if (resume && (resolve !== undefined || allowRepeat)) throw new Error("Resume cannot be combined with resolve-pending or allow-repeat");
  return withActionLock(file, async () => {
    const store = await readJson(file, { version: 1, actions: {} });
    if (store.version !== 1 || typeof store.actions !== "object") throw new Error("Unsupported receipts file");
    const save = () => writePrivate(file, store);
    let slot = key;
    if (allowRepeat) for (let n = 2; store.actions[slot]?.state === "done"; n++) slot = `${key}#${n}`;
    let prior = store.actions[slot];
    if (resolve !== undefined) {
      if (!["pending", "partial"].includes(prior?.state)) throw new Error("There is no uncertain or partial attempt of this action to resolve");
      if (resolve === "none") {
        delete store.actions[slot];
        await save();
        prior = undefined;
      } else if (id(resolve)) {
        store.actions[slot] = { ...prior, state: "done", resolvedAt: new Date().toISOString(), resolvedByUser: true, [resolveField]: resolve };
        await save();
        return { state: "reconciled", receipt: store.actions[slot] };
      } else throw new Error("Resolve with none or the ID of the record found in Zira");
    }
    if (prior?.state === "done") return { state: "already-done", receipt: prior };
    // Only an opted-in domain recovery may continue a partial operation. It must inspect
    // the existing records read-only, under the same lock, before returning a seed.
    if (resume && !["partial", "pending"].includes(prior?.state))
      throw new Blocked("missing_receipt", "No unfinished receipt matches this action; nothing was written.");
    const seed = resume ? await resume(structuredClone(prior)) : undefined;
    if (prior?.state === "partial" && !resume)
      throw new Blocked("partial_write", "A previous attempt created only part of this setup. Finish or remove those records in Zira; nothing new was written.", { receipt: prior, ...links(prior.created ?? {}) });
    if (prior?.state === "pending" && !resume) {
      const found = reconcile ? await reconcile(prior) : null;
      if (!found)
        throw new Blocked("uncertain_write", "A previous attempt of this exact write has an unknown outcome and Zira shows no single matching record. Check Zira, then resolve it; nothing new was written.", { receipt: prior });
      const { partial, created = {}, ...fields } = found;
      store.actions[slot] = { ...prior, ...fields, created: { ...prior.created, ...created }, state: partial ? "partial" : "done", reconciledAt: new Date().toISOString() };
      await save();
      if (partial)
        throw new Blocked("partial_write", "A previous attempt created part of this setup. Finish or remove it in Zira; nothing new was written.", { receipt: store.actions[slot], ...links(store.actions[slot].created) });
      return { state: "reconciled", receipt: store.actions[slot] };
    }
    // Duplicate checks run only for a fresh write; what they saw helps a later reconcile.
    const checked = resume ? undefined : await precheck?.();
    const entry = resume ? { ...prior, state: "pending", resumedAt: new Date().toISOString() }
      : { state: "pending", at: new Date().toISOString(), summary, created: {}, ...(checked ? { precheck: checked } : {}) };
    store.actions[slot] = entry;
    await save();
    // Multi-step writes record each created record as soon as it exists.
    const progress = async fields => {
      Object.assign(entry.created, fields);
      await save();
    };
    try {
      const result = await run(progress, seed);
      Object.assign(entry, { state: result.partial ? "partial" : "done", doneAt: new Date().toISOString() }, result.receipt ?? {});
      await save();
      return { state: result.partial ? "partial" : "created", ...result };
    } catch (error) {
      const madeSomething = Object.keys(entry.created).some(key => key !== "pendingWrite");
      if (!madeSomething) {
        if (definiteFailure(error)) delete store.actions[slot];
        else Object.assign(entry, { failure: error.message });
        await save();
        throw error;
      }
      Object.assign(entry, { state: "partial", failure: error.message });
      await save();
      throw new Blocked("unverified_write", `Zira created ${describeCreated(entry.created)}, then a later step failed (${error.message}). Check it in Zira; do not rerun.`, { created: entry.created, ...links(entry.created) });
    }
  });
}

// Read one --name value from argv for error reporting, after parseArgs has validated it.
export function argValue(name, argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

export function isMain(meta) {
  return process.argv[1] && existsSync(process.argv[1]) && meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

// Exit 0 success, 2 invalid/failed, 3 incomplete or partial, 4 blocked (JSON explains).
export async function runCli(main, { profile, handoffInfo } = {}) {
  try {
    const result = await main();
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
    process.exitCode = result?.complete === false || ["partial", "unverified"].includes(result?.state) ? 3 : 0;
  } catch (error) {
    const chosen = profile?.();
    const where = ["prod", "integ"].includes(chosen) ? chosen : "prod";
    const blocked = explain(error, { profile: where, handoffInfo: handoffInfo?.() });
    if (blocked) {
      console.log(JSON.stringify({ blocked: blocked.reason, message: blocked.message, ...blocked.details }, null, 2));
      process.exitCode = 4;
    } else {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
