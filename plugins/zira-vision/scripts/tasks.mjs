#!/usr/bin/env node
// Show and create general Zira tasks, mirroring the Home Assistant task flows.
import { parseArgs } from "node:util";
import { internalTaskClient, taskCreateBody } from "../skills/health-report/scripts/task-api.mjs";
import { timestamp } from "../skills/health-report/scripts/config.mjs";
import {
  Blocked, argValue, currentUser, fingerprint, guardedWrite, id, isMain, link, liveSession,
  normalizeName, originFor, personName, receiptsFile, resolveSite, route, runCli, siteDataSources, siteMembers, text,
} from "./client.mjs";

const HELP = `Zira tasks — view and create general tasks
node scripts/tasks.mjs list [--company-id ID] [--site-id ID | --all-sites]
    [--status open|todo|in-progress|on-hold|done|cancelled|any] [--priority low|medium|high]
    [--assignee me|any|USER_ID] [--search TEXT] [--limit 1-50] [--cursor LAST_VALUE]
node scripts/tasks.mjs get --task-id ID [--company-id ID --site-id ID]
node scripts/tasks.mjs create --company-id ID --site-id ID --title TEXT --description TEXT
    --assignee me|none|USER_ID [--priority low|medium|high] [--due ISO] [--data-source-id ID]
    [--apply] [--allow-duplicate] [--allow-repeat] [--resolve-pending none|TASK_ID] [--receipts FILE]
Common: --profile prod|integ

Without a site, list queries all authorized sites, optionally within a company.
Use --assignee me for your tasks; --cursor continues the same filters on the next page.
Scope and task reads/writes use Zira browser sign-in and internal APIs only.
Missing API authorization stops the operation; no API-key fallback is supported.
create previews by default; --apply creates one task, notifies its assignee and reads it back.
--resolve-pending settles an earlier attempt with an unknown outcome, only after the user
checked Zira: none (no task was created) or the ID of the task that was created.
Exit 0 success, 2 invalid/failed, 3 partial list or unverified write, 4 blocked (JSON explains).
`;

export const STATUS = {
  open: ["5", "10", "15"], todo: ["5"], "in-progress": ["10"], "on-hold": ["15"],
  done: ["20"], cancelled: ["25"], any: [],
};
export const PRIORITY = { low: ["5", "Low"], medium: ["10", "Medium"], high: ["15", "High"] };

export const LOGIN_ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/users\/details$/], ["GET", /^\/users\/site-members$/],
  ["GET", /^\/devices\/list$/],
];

export function taskApi(call) {
  return {
    source: "login",
    list: params => call("GET", route("/tasks/list", { ...params, sortBy: "auditInfo.lastModifiedDate" })),
    count: async params => Number((await call("GET", route("/tasks/counters", params))).data?.[0]?.numberOfTasks),
    get: async taskId => (await call("GET", `/tasks/${taskId}`)).data,
    create: async draft => (await call("POST", "/tasks/new", taskCreateBody({
      name: draft.title, description: draft.description, siteId: draft.siteId,
      deviceId: draft.dataSource?.id, assigneeId: draft.assignee?.id, priorityId: draft.priority[0], dueDate: draft.dueDate,
    }))).data,
  };
}

export function formatTask(t, profile) {
  const taskId = String(t?.id ?? "");
  return {
    id: taskId,
    name: String(t?.name ?? t?.title ?? "Untitled task"),
    status: t?.status?.name ?? null,
    statusId: t?.status?.id != null ? String(t.status.id) : null,
    priority: t?.priority?.name ?? null,
    priorityId: t?.priority?.id != null ? String(t.priority.id) : null,
    assignee: t?.assignee ? personName(t.assignee) : null,
    assigneeId: t?.assignee?.id != null ? String(t.assignee.id) : null,
    siteId: String(t?.site?.id ?? ""),
    siteName: t?.site?.name ?? null,
    dueDate: t?.dueDate ?? null,
    updatedAt: t?.auditInfo?.lastModifiedDate ?? null,
    ...(t?.device?.id ? { dataSource: { id: String(t.device.id), name: t.device.name ?? null } } : {}),
    ...(id(taskId) ? { url: link(profile, `/tasks/${taskId}`) } : {}),
  };
}

function filters({ status = "open", priority, assigneeId, search }) {
  if (!Object.hasOwn(STATUS, status)) throw new Error("Unknown status filter");
  if (priority && !Object.hasOwn(PRIORITY, priority)) throw new Error("Unknown priority filter");
  return {
    statusIds: STATUS[status].join(","),
    priorityIds: priority ? PRIORITY[priority][0] : undefined,
    assigneeIds: assigneeId,
    textSearch: search ? text(search, 200) : undefined,
  };
}

async function resolveAssigneeFilter(call, assignee) {
  if (!assignee || assignee === "any") return undefined;
  if (assignee === "me") return (await currentUser(call)).id;
  if (!id(assignee)) throw new Error("Assignee must be me, any or a user ID");
  return assignee;
}

export async function listTasks({ call, tasks, profile = "prod", companyId, siteId, allSites = false, status, priority, assignee, search, limit = 20, cursor }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Limit must be 1-50");
  if (companyId !== undefined && !id(companyId)) throw new Error("Invalid company ID");
  if (allSites && siteId !== undefined) throw new Error("Choose a site or --all-sites, not both");
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.length || cursor.length > 16384)) throw new Error("Invalid page cursor");
  const site = siteId === undefined ? null : await resolveSite(call, companyId, siteId);
  const assigneeIds = await resolveAssigneeFilter(call, assignee);
  const query = { ...filters({ status, priority, assigneeId: assigneeIds, search }),
    companyIds: companyId, siteIds: site?.id };
  // The task API enforces visibility across companies/sites. No site enumeration,
  // chunking or fixed site-count cap is needed for an all-authorized task query.
  const body = await tasks.list({ ...query, limit: String(limit), sortDesc: "true", lastValue: cursor });
  if (body.data !== null && !Array.isArray(body.data)) throw new Error("Task list response is missing data array");
  if (body.lastValue != null && typeof body.lastValue !== "string") throw new Error("Invalid task page cursor");
  const nextCursor = body.lastValue || null;
  if (cursor && nextCursor === cursor) throw new Error("Task pagination did not advance; narrow the request");
  const items = [];
  let excluded = 0;
  for (const row of body.data ?? []) {
    const task = formatTask(row, profile);
    if (!id(task.id) || !id(task.siteId) || (site && task.siteId !== site.id)) { excluded++; continue; }
    items.push(task);
  }
  let total = null;
  // The counters endpoint ignores text search, so a count would overstate a search.
  if (tasks.count && !query.textSearch) {
    try {
      const n = await tasks.count(query);
      if (Number.isFinite(n)) total = n;
    } catch { /* The count is optional context; the list stays authoritative. */ }
  }
  const sites = site ? [site] : [...new Map(items.map(t => [t.siteId, { id: t.siteId, name: t.siteName }])).values()];
  return {
    kind: "tasks", profile, source: tasks.source, companyId,
    scope: site ? "site" : companyId ? "company" : "all-authorized",
    sites: sites.map(s => ({ id: s.id, name: s.name })),
    filters: { status: status ?? "open", priority: priority ?? null, assignee: assignee ?? "any", search: search ?? null },
    total, nextCursor,
    complete: !nextCursor && excluded === 0 && items.length <= limit,
    excluded, items: items.slice(0, limit),
  };
}

export async function getTask({ call, tasks, profile = "prod", companyId, siteId, taskId }) {
  if (!id(taskId)) throw new Error("Task ID required");
  const selectedSite = siteId === undefined ? null : await resolveSite(call, companyId, siteId);
  const task = formatTask(await tasks.get(taskId), profile);
  if (task.id !== taskId || !id(task.siteId) || (selectedSite && task.siteId !== selectedSite.id))
    throw new Blocked("scope", "Task is unavailable or outside the selected site");
  const site = selectedSite ?? (companyId === undefined
    ? { id: task.siteId, name: task.siteName }
    : await resolveSite(call, companyId, task.siteId));
  return { kind: "task", profile, site, task };
}

// Same-title tasks at the site in any status; `open` is the subset a duplicate check cares about.
async function sameNameTasks(tasks, profile, siteId, title) {
  const body = await tasks.list({ siteIds: siteId, textSearch: title.slice(0, 200), limit: "50" });
  const all = (body.data ?? []).map(t => formatTask(t, profile))
    .filter(t => t.siteId === siteId && normalizeName(t.name) === normalizeName(title));
  return { all, open: all.filter(t => STATUS.open.includes(t.statusId ?? "5")) };
}

export async function createTask({
  call, tasks, profile = "prod", companyId, siteId, title, description, assignee, priority = "medium",
  dueDate, dataSourceId, apply = false, allowDuplicate = false, allowRepeat = false, receipts, resolve,
}) {
  const site = await resolveSite(call, companyId, siteId);
  const draft = {
    siteId: site.id,
    title: text(title, 200),
    description: text(description),
    priority: PRIORITY[priority],
    dueDate: dueDate || undefined,
  };
  if (!draft.title) throw new Error("A task title is required");
  if (!draft.description) throw new Error("A task description is required; ask the user what the task is about");
  if (!draft.priority) throw new Error("Priority must be low, medium or high");
  if (dueDate && !timestamp(dueDate)) throw new Error("Due date needs an ISO timestamp with an offset");
  if (!["me", "none"].includes(assignee) && !id(assignee)) throw new Error("Choose --assignee me, none or a site member's user ID");
  if (assignee === "me") draft.assignee = await currentUser(call);
  else if (assignee !== "none") {
    const member = (await siteMembers(call, site.id)).find(u => u.id === assignee);
    if (!member) throw new Blocked("assignee", "That user is not an active member of the selected site; choose a site member or leave the task unassigned");
    draft.assignee = member;
  }
  if (dataSourceId) {
    if (!id(dataSourceId)) throw new Error("Invalid data source ID");
    const ds = (await siteDataSources(call, site)).find(d => String(d.id) === dataSourceId);
    if (!ds) throw new Blocked("scope", "Data source is not in the selected site");
    draft.dataSource = { id: dataSourceId, name: String(ds.name ?? "") };
  }
  const duplicates = (await sameNameTasks(tasks, profile, site.id, draft.title)).open;
  const preview = {
    site: { id: site.id, name: site.name },
    title: draft.title,
    description: draft.description,
    priority: draft.priority[1],
    status: "To Do",
    assignee: draft.assignee ?? null,
    dataSource: draft.dataSource ?? null,
    dueDate: draft.dueDate ?? null,
    notifies: draft.assignee ? `${draft.assignee.name} is notified when the task is created` : "No assignee is notified",
  };
  if (!apply) return { kind: "task-draft", profile, source: tasks.source, preview, duplicates, applied: false };
  const key = fingerprint({ op: "create-task", profile, siteId: site.id, title: normalizeName(draft.title), description: draft.description, assignee: draft.assignee?.id ?? null, dataSource: draft.dataSource?.id ?? null });
  // Only a task that did not exist before this attempt can be the result of that attempt.
  const findCreated = async prior => {
    const before = new Set(prior.precheck?.existingIds ?? []);
    const candidates = (await sameNameTasks(tasks, profile, site.id, draft.title)).all.filter(t => !before.has(t.id));
    return candidates.length === 1 ? { taskId: candidates[0].id } : null;
  };
  const outcome = await guardedWrite({
    file: receipts, key, allowRepeat, resolve, resolveField: "taskId", reconcile: findCreated,
    precheck: async () => {
      const current = await sameNameTasks(tasks, profile, site.id, draft.title);
      if (current.open.length && !allowDuplicate)
        throw new Blocked("duplicate", "An open task with the same title already exists at this site. Reuse it, or confirm a separate task explicitly.", { duplicates: current.open });
      return { existingIds: current.all.map(t => t.id) };
    },
    summary: { kind: "task", siteId: site.id, title: draft.title },
    run: async progress => {
      const taskId = String(await tasks.create(draft) ?? "");
      if (!id(taskId)) throw new Error("Create returned no task ID; check the site's tasks before retrying");
      await progress({ taskId });
      let saved = null, readBack = null;
      try {
        saved = formatTask(await tasks.get(taskId), profile);
      } catch (error) {
        readBack = `Read-back failed (${error.status ? `HTTP ${error.status}` : error.message})`;
      }
      const verified = !!saved && saved.id === taskId && saved.siteId === site.id && normalizeName(saved.name) === normalizeName(draft.title) &&
        (!draft.assignee || saved.assigneeId === draft.assignee.id) &&
        (!saved.priorityId || saved.priorityId === draft.priority[0]) &&
        (!draft.dataSource || saved.dataSource?.id === draft.dataSource.id);
      return { receipt: { taskId }, taskId, verified, task: saved, ...(readBack ? { readBack } : {}) };
    },
  });
  if (outcome.state === "already-done" || outcome.state === "reconciled") {
    const taskId = outcome.receipt.taskId;
    return { kind: "task", profile, applied: false, state: outcome.state, taskId, url: link(profile, `/tasks/${taskId}`),
      message: "This exact task was already created; nothing new was written." };
  }
  return {
    kind: "task", profile, source: tasks.source, applied: true, state: outcome.verified ? "created" : "unverified",
    verified: outcome.verified, taskId: outcome.taskId, url: link(profile, `/tasks/${outcome.taskId}`),
    task: outcome.task, preview, ...(outcome.readBack ? { readBack: outcome.readBack } : {}),
    ...(outcome.verified ? {} : { message: "Zira accepted the task, but reading it back did not confirm every field. Open the link to check it; do not create it again." }),
  };
}

async function sources(profile) {
  const call = await liveSession(profile, { allow: LOGIN_ROUTES });
  return { call, tasks: taskApi(await internalTaskClient(profile, { maxRequests: 30 })) };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, "all-sites": { type: "boolean" },
    "task-id": { type: "string" }, status: { type: "string" }, priority: { type: "string" },
    assignee: { type: "string" }, search: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" },
    title: { type: "string" }, description: { type: "string" }, due: { type: "string" },
    "data-source-id": { type: "string" }, apply: { type: "boolean" }, "allow-duplicate": { type: "boolean" },
    "allow-repeat": { type: "boolean" }, receipts: { type: "string" }, profile: { type: "string" },
    "resolve-pending": { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const scope = { profile, companyId: o["company-id"], siteId: o["site-id"] };
  if (args[0] === "list")
    return listTasks({ ...(await sources(profile)), ...scope, allSites: !!o["all-sites"], status: o.status,
      priority: o.priority, assignee: o.assignee, search: o.search, limit: o.limit ? Number(o.limit) : 20, cursor: o.cursor });
  if (args[0] === "get") return getTask({ ...(await sources(profile)), ...scope, taskId: o["task-id"] });
  if (args[0] === "create")
    return createTask({ ...(await sources(profile)), ...scope, title: o.title, description: o.description,
      assignee: o.assignee, priority: o.priority ?? "medium", dueDate: o.due, dataSourceId: o["data-source-id"],
      apply: !!o.apply, allowDuplicate: !!o["allow-duplicate"], allowRepeat: !!o["allow-repeat"],
      resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) });
  throw new Error("Choose list, get or create");
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => process.argv[2] === "create"
      ? { prompt: `create task: ${[argValue("title"), argValue("description")].filter(Boolean).join(" — ")}`.trim() }
      : { prompt: "show my open tasks" },
  });
