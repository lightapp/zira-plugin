import { toolkit } from "./api.mjs";
import { boundedFetch } from "./limits.mjs";
import { id, timestamp } from "./config.mjs";

const ORIGINS = { prod: "https://api.zira.us", integ: "https://integ.api.zira.us" };
const PRIORITIES = { "5": "Low", "10": "Medium", "15": "High" };
const ROUTES = [
  ["GET", /^\/tasks\/(list|counters|[1-9]\d*)$/],
  ["POST", /^\/tasks\/new$/], ["PUT", /^\/tasks\/[1-9]\d*$/],
];
// The task API applies these to a feed post: sourceId makes it edit an existing post (any ID,
// with elevated rights), the others attach files/images, mention people or set the author.
// Agent task writes never send them; a data source is linked only through `device`.
export const POST_LINKED_FIELDS = Object.freeze(["sourceId", "fileIds", "imageIds", "mentions", "fromChannelId"]);

export class ZiraApiError extends Error {
  constructor(status, operation, { code, details } = {}) {
    super(`Zira ${operation} failed (HTTP ${status})`);
    this.status = status;
    this.operation = operation;
    if (code) this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// Refresh before sending a write; never replay a write, including after HTTP 401.
export async function internalTaskClient(profile = process.env.ZIRA_PROFILE ?? "prod", {
  auth, fetchImpl = globalThis.fetch, maxRequests = 100,
} = {}) {
  const origin = ORIGINS[profile];
  if (!origin) throw new Error("Choose prod or integ profile");
  const { getAuthorizationToken } = auth ?? await toolkit();
  const limited = boundedFetch({ maxRequests, fetchImpl: (url, options) =>
    fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) }) });
  return async (method, target, body) => {
    const pathname = target.split("?")[0];
    if (!ROUTES.some(([m, pattern]) => method === m && pattern.test(pathname)))
      throw new Error("Internal task route not allowed");
    const url = new URL(target, origin);
    if (url.origin !== origin || url.hash) throw new Error("Internal task route not allowed");
    if (body !== undefined && POST_LINKED_FIELDS.some(key => Object.hasOwn(Object(body), key)))
      throw new Error("Task writes must not carry feed-post fields");
    const send = async forceRefresh => limited(url.href, {
      method, redirect: "manual",
      headers: { Authorization: await getAuthorizationToken({ profileName: profile, forceRefresh, fetchImpl: limited }),
        Accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await send(false);
    if (response.status === 401 && method === "GET") {
      await response.body?.cancel();
      response = await send(true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ZiraApiError(response.status, `${method} ${pathname.replace(/\/[1-9]\d*/g, "/{id}")}`);
    }
    const raw = await response.text();
    if (raw.length > 8 * 1024 * 1024) throw new Error("Task response exceeds 8 MiB cap");
    try { return JSON.parse(raw); } catch { throw new Error("Invalid task JSON response"); }
  };
}

export function taskCreateBody({ name, description, siteId, deviceId, assigneeId, priorityId = "10", dueDate }) {
  if (!id(siteId) || (deviceId && !id(deviceId)) || (assigneeId && !id(assigneeId)) || !Object.hasOwn(PRIORITIES, priorityId))
    throw new Error("Invalid task scope, assignee or priority");
  return {
    name, description, formattedDescription: [{ type: "paragraph", children: [{ text: description }] }],
    site: { id: siteId }, type: { id: deviceId ? "3" : "1" }, status: { id: "5", name: "To Do" },
    priority: { id: priorityId, name: PRIORITIES[priorityId] }, timeSpentMandatory: false,
    ...(assigneeId ? { assignee: { id: assigneeId } } : {}),
    ...(deviceId ? { device: { id: deviceId } } : { system: { id: null }, device: { id: null } }),
    ...(dueDate ? { dueDate } : {}),
  };
}

export function taskUpdateBody(taskId, patch) {
  if (!id(taskId) || !patch || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) =>
    !["description", "priorityId", "dueDate"].includes(key) || typeof value !== "string"))
    throw new Error("Update only description, priorityId or dueDate; closure and reassignment require separate verified handling");
  if (patch.priorityId !== undefined && !Object.hasOwn(PRIORITIES, patch.priorityId)) throw new Error("Unknown task priority");
  if (patch.dueDate !== undefined && !timestamp(patch.dueDate)) throw new Error("Due date needs an ISO timestamp with an offset");
  return { id: taskId,
    ...(patch.description !== undefined ? { description: patch.description, formattedDescription: [{ type: "paragraph", children: [{ text: patch.description }] }] } : {}),
    ...(patch.priorityId !== undefined ? { priority: { id: patch.priorityId, name: PRIORITIES[patch.priorityId] } } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
  };
}
