#!/usr/bin/env node
// Schedule a Zira dashboard AI report like the Home Assistant flow
// (scheduledReport.server.js): dashboards → schedule → widgets → wording → people → create.
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  Blocked, ZiraApiError, argValue, currentUser, fingerprint, guardedWrite, id, idList, isMain, link, listAll,
  liveSession, normalizeName, originFor, receiptsFile, resolveSite, route, runCli, siteMembers, text,
} from "./client.mjs";

const HELP = `Zira AI reports — scheduled dashboard summaries
node scripts/ai-report.mjs dashboards --company-id ID --site-id ID
node scripts/ai-report.mjs widgets --company-id ID --site-id ID --dashboard-ids ID,ID
node scripts/ai-report.mjs people --company-id ID --site-id ID
node scripts/ai-report.mjs create --plan FILE [--apply] [--allow-repeat] [--resolve-pending none|CHANNEL_ID] [--receipts FILE]
node scripts/ai-report.mjs draft --plan FILE [--apply] [--allow-repeat] [--resolve-pending none|CHANNEL_ID] [--receipts FILE]
node scripts/ai-report.mjs show --company-id ID --site-id ID --channel-id ID --agent-id ID
node scripts/ai-report.mjs update-draft --company-id ID --site-id ID --channel-id ID --agent-id ID --changes FILE [--apply]
node scripts/ai-report.mjs schedule --plan FILE --channel-id ID --agent-id ID [--apply] [--resolve-pending none|SCHEDULE_ID]
Common: --profile prod|integ

Plan JSON: {"companyId","siteId","name","dashboardIds":[],"widgetIds":[],
  "schedule":{"preset":"weekdays|endOfDay|daily|weekly|monthly"} or {"period":"week|month","days":[],"time":"HH:MM"},
  optional "covers" in the schedule: today|day(yesterday)|thisWeek|week(last week)|thisMonth|month(last month);
  today/this week/this month run up to when the report is sent. Default: monthly → last month,
  one day a week → last week, otherwise yesterday before 12:00 and today from 12:00.
  "question","answerStyle":[],"recipientIds":["me", USER_ID...]}
Previews include "sample": the covered window (UTC) and the analytics widgets to read with
health-report's agent-data for a sample report written in chat (windows over 7 days keep the latest 7).
draft creates only the report channel and AI agent (no schedule, no recipients) for review on the
agent page; show reads it back with page edits; update-draft applies {"name","question",
"answerStyle","widgetIds","covers"} changes on top; schedule adds the schedule and recipients
(plan: companyId, siteId, schedule, recipientIds) using the agent's current wording and period.
create previews the confirmation card by default. --apply creates the report channel,
AI agent, schedule and followers (they receive each report by post, notification and email).
A same-name report channel at the site blocks creation. --resolve-pending settles an earlier
attempt with an unknown or partial outcome after the user checked (or cleaned up) Zira.
Exit 0 success, 2 invalid/failed, 3 partial or unverified, 4 blocked (JSON explains).
`;

export const AGENT_WIDGET_TYPE_IDS = ["19", "15", "11"];
export const ANSWER_STYLES = ["Use Emojis", "Use Table", "Write Shortly", "Use Bullet Points", "Include Comparisons", "Use Colors", "Drill down"];
export const MAX_REPORT_DASHBOARDS = 5;
const REPORT_TARGETS = [1, 2, 3, 4];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// today/thisWeek/thisMonth run up to the moment the report is sent (the agent backend stops the range at "now").
export const REPORT_RANGES = {
  day: { rangeId: "2", intervalId: "4", label: "yesterday" },
  today: { rangeId: "1", intervalId: "4", label: "today", soFar: true },
  week: { rangeId: "14", intervalId: "5", label: "last week" },
  thisWeek: { rangeId: "3", intervalId: "5", label: "this week", soFar: true },
  month: { rangeId: "8", intervalId: "5", label: "last month" },
  thisMonth: { rangeId: "7", intervalId: "5", label: "this month", soFar: true },
};
export const SCHEDULE_PRESETS = {
  weekdays: { period: "week", days: [1, 2, 3, 4, 5], time: "07:00", covers: "day" },
  endOfDay: { period: "week", days: [1, 2, 3, 4, 5], time: "17:00", covers: "today" },
  daily: { period: "week", days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", covers: "day" },
  weekly: { period: "week", days: [1], time: "07:00", covers: "week" },
  monthly: { period: "month", days: [1], time: "07:00", covers: "month" },
};
export const FOCUS_PRESETS = {
  summary: { brief: "A short summary of how the period went: the main numbers, what went well, and what needs attention.", answerStyle: ["Use Bullet Points", "Write Shortly", "Include Comparisons"] },
  kpis: { brief: "The key KPIs for the period in a table, compared with their targets or thresholds where the widgets show them.", answerStyle: ["Use Table", "Include Comparisons", "Use Colors"] },
  exceptions: { brief: "Only what went wrong or looks unusual: drops, spikes, stoppages and anomalies, with where they happened. Say clearly when nothing needs attention.", answerStyle: ["Write Shortly", "Use Bullet Points", "Drill down", "Use Emojis"] },
};

export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/users\/details$/], ["GET", /^\/users\/site-members$/],
  ["GET", /^\/dashboards\/list$/], ["GET", /^\/dashboards\/[1-9]\d*$/], ["GET", /^\/system-types$/],
  ["GET", /^\/systems\/[1-9]\d*$/], ["POST", /^\/systems\/new$/], ["POST", /^\/systems\/[1-9]\d*\/attach-meter$/],
  ["PUT", /^\/dashboards\/[1-9]\d*\/system$/], ["POST", /^\/agents\/new$/], ["PUT", /^\/agents\/[1-9]\d*$/],
  ["POST", /^\/schedules\/new$/], ["PUT", /^\/channels\/[1-9]\d*\/addChannelFollowers$/],
  ["GET", /^\/channels\/all$/], ["GET", /^\/channels\/[1-9]\d*$/], ["GET", /^\/agents\/[1-9]\d*$/], ["GET", /^\/schedules\/[1-9]\d*$/],
  ["GET", /^\/channels\/followers\/get$/],
];

export const isNavHub = name =>
  /🏠|🏡/.test(String(name ?? "")) || /\b(home|landing page|home page|index page|menu page|site map|sitemap|navigation hub)\b/i.test(String(name ?? ""));

// Same default as zira-web: a daily report from 12:00 is an end-of-day report about that day.
export const defaultCovers = ({ period, days, time }) =>
  period === "month" ? "month" : days.length === 1 ? "week" : time >= "12:00" ? "today" : "day";

function scheduleCovers(input, schedule) {
  if (input?.covers == null) return schedule.covers ?? defaultCovers(schedule);
  if (!Object.hasOwn(REPORT_RANGES, input.covers)) throw new Error(`Schedule covers must be one of: ${Object.keys(REPORT_RANGES).join(", ")}`);
  return input.covers;
}

export function normalizeSchedule(input) {
  if (input?.preset) {
    if (!Object.hasOwn(SCHEDULE_PRESETS, input.preset)) throw new Error("Unknown schedule preset");
    const preset = SCHEDULE_PRESETS[input.preset];
    return { ...preset, covers: scheduleCovers(input, preset) };
  }
  const period = input?.period;
  if (!["week", "month"].includes(period)) throw new Error("Schedule period must be week or month");
  const [min, max] = period === "month" ? [1, 31] : [0, 6];
  const days = [...new Set(input.days ?? [])].map(Number).sort((a, b) => a - b);
  if (!days.length || !days.every(d => Number.isInteger(d) && d >= min && d <= max)) throw new Error(`Schedule days must be ${min}-${max}`);
  const time = String(input.time ?? "07:00");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Schedule time must be HH:MM (24-hour)");
  return { period, days, time, covers: scheduleCovers(input, { period, days, time }) };
}

const ordinal = d => `${d}${[1, 21, 31].includes(d) ? "st" : [2, 22].includes(d) ? "nd" : [3, 23].includes(d) ? "rd" : "th"}`;
export function describeSchedule(s) {
  if (s.period === "month") return `On the ${s.days.map(ordinal).join(", ")} of every month at ${s.time}`;
  if (s.days.length === 7) return `Every day at ${s.time}`;
  if (s.days.join() === "1,2,3,4,5") return `Every weekday at ${s.time}`;
  return `Every ${s.days.map(d => WEEKDAYS[d]).join(", ")} at ${s.time}`;
}

const widgetName = w => {
  const settings = w?.components?.[0]?.arguments?.[0]?.nextGenWidgetSettings;
  return String(w?.name || settings?.name || settings?.embeddedWidgetConfig?.name || "Widget");
};

export async function reportDashboards({ call, profile = "prod", companyId, siteId }) {
  const site = await resolveSite(call, companyId, siteId);
  const rows = await listAll(call, "/dashboards/list", { siteIds: site.id, dashboardTypeIds: "3" });
  const items = rows.filter(d => id(String(d?.id ?? "")) && d.name && !d.isDeleted && !isNavHub(d.name) &&
      String(d.site?.id ?? d.siteId ?? site.id) === site.id)
    .map(d => ({ id: String(d.id), name: String(d.name), url: link(profile, `/dashboards/${d.id}`) }));
  return { kind: "report-dashboards", profile, site: { id: site.id, name: site.name }, items,
    ...(items.length ? {} : { next: "An AI report reads a dashboard; build one first with the build-dashboard skill." }) };
}

async function chosenDashboards(call, site, dashboardIds) {
  const ids = idList(dashboardIds);
  if (!ids.length || !ids.every(id)) throw new Error("Choose one or more dashboard IDs");
  if (ids.length > MAX_REPORT_DASHBOARDS) throw new Error(`A report reads at most ${MAX_REPORT_DASHBOARDS} dashboards`);
  const details = [];
  for (const dashboardId of ids) {
    const d = (await call("GET", `/dashboards/${dashboardId}`)).data;
    if (String(d?.id ?? "") !== dashboardId || String(d.site?.id ?? d.siteId ?? "") !== site.id)
      throw new Blocked("scope", "A chosen dashboard is not in the selected site", { dashboardId });
    if (String(d.type?.id ?? d.dashboardType?.id ?? d.dashboardTypeId ?? "") !== "3")
      throw new Blocked("scope", "AI reports read next-generation dashboards only", { dashboardId });
    details.push(d);
  }
  return details;
}

export async function reportWidgets({ call, profile = "prod", companyId, siteId, dashboardIds }) {
  const site = await resolveSite(call, companyId, siteId);
  const dashboards = await chosenDashboards(call, site, dashboardIds);
  const items = dashboards.flatMap(d => (d.widgets ?? [])
    .filter(w => AGENT_WIDGET_TYPE_IDS.includes(String(w?.type?.id)) && id(String(w?.id ?? "")))
    .map(w => ({ id: String(w.id), name: widgetName(w), typeId: String(w.type.id), dashboardId: String(d.id), dashboardName: String(d.name ?? "") })));
  return { kind: "report-widgets", profile, site: { id: site.id, name: site.name }, items,
    ...(items.length ? {} : { next: "These dashboards have no charts or KPI widgets the AI can read; choose other dashboards." }) };
}

export async function reportPeople({ call, companyId, siteId }) {
  const site = await resolveSite(call, companyId, siteId);
  let me = null;
  try { me = await currentUser(call); } catch { /* shown as unavailable */ }
  return { kind: "report-people", site: { id: site.id, name: site.name }, me, members: await siteMembers(call, site.id) };
}

const readableWidgets = dashboards => new Map(dashboards.flatMap(d => (d.widgets ?? [])
  .filter(w => AGENT_WIDGET_TYPE_IDS.includes(String(w?.type?.id)))
  .map(w => [String(w.id), { id: String(w.id), name: widgetName(w), dashboardName: String(d.name ?? "") }])));

function checkAnswerStyle(styles) {
  const answerStyle = [...new Set(styles ?? [])];
  if (!answerStyle.every(s => ANSWER_STYLES.includes(s))) throw new Error(`answerStyle entries must be from: ${ANSWER_STYLES.join(", ")}`);
  return answerStyle;
}

function checkWidgets(ids, available) {
  const widgetIds = [...new Set((ids ?? []).map(String))];
  if (!widgetIds.length) throw new Error("Choose at least one widget for the report to read");
  const unknown = widgetIds.filter(w => !available.has(w));
  if (unknown.length) throw new Blocked("scope", "Some widgets are not readable widgets of the chosen dashboards", { unknown });
  return widgetIds;
}

async function resolveRecipients(call, site, recipientIds) {
  const requested = [...new Set((recipientIds?.length ? recipientIds : ["me"]).map(String))];
  const recipients = [];
  if (requested.includes("me")) {
    const me = await currentUser(call);
    recipients.push({ ...me, name: `${me.name} (you)` });
  }
  const others = requested.filter(r => r !== "me" && !recipients.some(x => x.id === r));
  if (others.length) {
    if (!others.every(id)) throw new Error("Recipients must be me or user IDs");
    const members = new Map((await siteMembers(call, site.id)).map(m => [m.id, m]));
    const outside = others.filter(o => !members.has(o));
    if (outside.length) throw new Blocked("recipients", "Some recipients are not active members of this site", { outside });
    recipients.push(...others.map(o => members.get(o)));
  }
  return recipients;
}

const DAY = 86400000;
const SAMPLE_MAX_DAYS = 7;
const SAMPLE_INTERVALS = { day: "1 hours", today: "1 hours", week: "1 days", thisWeek: "1 days", month: "1 days", thisMonth: "1 days" };

// The window a run starting now would read, in the dashboard's fixed site offset and production-day start
// (the same rule as the backend's timeSpanAdapter and health-report's todayWindow). Returns UTC ISO times.
export function coveredWindow(dashboard, covers, now = new Date()) {
  const offset = Number(dashboard?.offset ?? 0) * 60000;
  const shift = Number(dashboard?.defaultDayOffset ?? 0) * 60000;
  const firstDay = Number.isInteger(dashboard?.firstDayOfWeek) ? dashboard.firstDayOfWeek : 1;
  if (!Number.isFinite(offset) || !Number.isFinite(shift) || !Object.hasOwn(REPORT_RANGES, covers)) return null;
  const wallNow = now.getTime() + offset;
  let dayStart = Math.floor(wallNow / DAY) * DAY + shift;
  if (dayStart > wallNow) dayStart -= DAY;
  const date = new Date(dayStart - shift);
  const weekStart = dayStart - ((date.getUTCDay() - firstDay + 7) % 7) * DAY;
  const monthStart = (y, m) => Date.UTC(y, m, 1) + shift;
  const thisMonth = monthStart(date.getUTCFullYear(), date.getUTCMonth());
  const [from, to] = {
    today: [dayStart, wallNow], day: [dayStart - DAY, dayStart],
    thisWeek: [weekStart, wallNow], week: [weekStart - 7 * DAY, weekStart],
    thisMonth: [thisMonth, wallNow], month: [monthStart(date.getUTCFullYear(), date.getUTCMonth() - 1), thisMonth],
  }[covers];
  const iso = wall => new Date(wall - offset).toISOString();
  return { from: iso(from), to: iso(to) };
}

// What to read for the in-chat sample: the covered window (the latest days when it is longer than
// agent-data allows) and the dashboards' analytics widgets, at most 20 per request.
function sampleRequest(dashboards, widgetIds, covers, now = new Date()) {
  const window = coveredWindow(dashboards[0], covers, now);
  if (!window) return null;
  const clipped = Date.parse(window.to) - Date.parse(window.from) > SAMPLE_MAX_DAYS * DAY;
  const from = clipped ? new Date(Date.parse(window.to) - SAMPLE_MAX_DAYS * DAY).toISOString() : window.from;
  const wanted = new Set(widgetIds);
  const requests = [], notSampled = [];
  for (const d of dashboards) {
    const ids = (d.widgets ?? []).filter(w => wanted.has(String(w.id)));
    const readable = ids.filter(w => String(w?.type?.id) === "15").map(w => String(w.id));
    notSampled.push(...ids.filter(w => String(w?.type?.id) !== "15").map(widgetName));
    for (let i = 0; i < readable.length; i += 20)
      requests.push({ dashboardId: String(d.id), widgetIds: readable.slice(i, i + 20) });
  }
  return { period: REPORT_RANGES[covers].label, from, to: window.to, interval: SAMPLE_INTERVALS[covers], clipped, requests, notSampled };
}

const coverage = range => `covering ${range.label}${range.soFar ? " up to when it is sent" : ""}`;
const timeSpanFor = range => ({ defaultDisplayRange: range.rangeId, defaultDisplayInterval: range.intervalId, isFixedRange: false, isFixedInterval: false });

// Validates a plan against live, authorized site data and returns the confirmation card.
export async function resolvePlan(call, plan, now = new Date()) {
  if (!plan || typeof plan !== "object") throw new Error("Plan must be a JSON object");
  const site = await resolveSite(call, String(plan.companyId ?? ""), String(plan.siteId ?? ""));
  const name = text(plan.name, 80);
  if (!name) throw new Error("A report name (its email subject) is required");
  const question = text(plan.question);
  if (!question) throw new Error("The report instructions (question) are required");
  const answerStyle = checkAnswerStyle(plan.answerStyle);
  const schedule = normalizeSchedule(plan.schedule);
  const dashboards = await chosenDashboards(call, site, (plan.dashboardIds ?? []).map(String).join(","));
  const available = readableWidgets(dashboards);
  const widgetIds = checkWidgets(plan.widgetIds, available);
  const recipients = await resolveRecipients(call, site, plan.recipientIds);
  const range = REPORT_RANGES[schedule.covers];
  return {
    site, name, question, answerStyle, schedule, range, recipients,
    dashboards: dashboards.map(d => ({ id: String(d.id), name: String(d.name ?? "") })),
    widgets: widgetIds.map(w => available.get(w)),
    sample: sampleRequest(dashboards, widgetIds, schedule.covers, now),
    card: {
      name, site: site.name,
      dashboards: dashboards.map(d => String(d.name ?? "")),
      when: `${describeSchedule(schedule)} (site local time), ${coverage(range)}`,
      widgets: widgetIds.length,
      sentTo: recipients.map(r => r.name),
      answerStyle,
      question,
      delivery: "A new channel is created for the report; its followers get each report as a post, notification and email.",
    },
  };
}

async function linkDashboard(call, dashboardId, systemId) {
  const attach = () => call("PUT", `/dashboards/${dashboardId}/system`, { systemId });
  try {
    await attach();
    return true;
  } catch (error) {
    // P0001 lists private devices that must join the channel's system first.
    if (!(error instanceof ZiraApiError) || error.code !== "P0001") return false;
    let devices = [];
    try { devices = JSON.parse(error.details ?? "[]"); } catch { return false; }
    devices = Array.isArray(devices) ? devices.filter(d => d?.isPrivate && !d?.isAttach && id(String(d?.id ?? ""))) : [];
    if (!devices.length || devices.length > 20) return false;
    try {
      for (const d of devices)
        await call("POST", `/systems/${systemId}/attach-meter`, { meter: { id: String(d.id) }, associationType: { id: String(d.typeId) === "1" ? "5" : "1" } });
      await attach();
      return true;
    } catch {
      return false;
    }
  }
}

async function channelType(call, site) {
  try {
    const walk = types => types.flatMap(t => [t, ...walk(t?.children ?? [])]);
    const types = (await call("GET", route("/system-types", { siteIds: site.id, includeIndirect: "true", includePublic: "true" }))).data ?? [];
    return String(walk(types).find(t => /scheduled\s*reports?/i.test(t?.name ?? ""))?.id ?? "1");
  } catch {
    return "1";
  }
}

function createdLinks(profile, created) {
  return {
    ...(created.channelId ? { channelUrl: link(profile, `/channels/${created.channelId}`) } : {}),
    ...(created.scheduled ? { scheduleUrl: link(profile, `/channels/${created.channelId}`, { tab: "scheduler" }) } : {}),
    ...(created.agentId ? { agentUrl: link(profile, `/ai-agents/${created.agentId}`, { fromChannel: created.channelId }) } : {}),
  };
}

// Report channels at the site whose name matches; a second report of the same name is refused.
async function sameNameReportChannels(call, site, name) {
  const rows = await listAll(call, "/channels/all", { entityTypeIds: "5", siteIds: site.id, includePublic: "true", onlyFollowing: "false", textSearch: name.slice(0, 80) });
  return rows.filter(c => id(String(c?.id ?? "")) && normalizeName(c.name) === normalizeName(name) &&
      String(c.context?.site ?? c.site?.id ?? site.id) === site.id)
    .map(c => ({ channelId: String(c.id), name: String(c.name) }));
}

// Best-effort read-back of what the API accepted; `null` means that record was not readable.
async function readBack(call, r, created) {
  const check = async fn => { try { return await fn(); } catch { return null; } };
  const agent = await check(async () => {
    const a = (await call("GET", `/agents/${created.agentId}`)).data ?? {};
    const widgetIds = (a.dataConfig?.widgetIds ?? []).map(String);
    return String(a.id ?? created.agentId) === created.agentId && text(a.question) === r.question &&
      r.widgets.every(w => widgetIds.includes(w.id));
  });
  const schedule = id(created.scheduleId ?? "") ? await check(async () => {
    const sch = (await call("GET", `/schedules/${created.scheduleId}`)).data ?? {};
    return String(sch.id ?? created.scheduleId) === created.scheduleId && sch.isActive !== false;
  }) : null;
  const followers = await check(async () => {
    const rows = (await call("GET", route("/channels/followers/get", { channelId: created.channelId, limit: "100" }))).data ?? [];
    const ids = new Set(rows.map(f => String(f?.id ?? f?.userId ?? f?.user?.id ?? "")));
    return r.recipients.every(p => ids.has(p.id));
  });
  return { channel: true, agent, schedule, followers };
}

// Channel, dashboard links and the AI agent: everything a report needs before it is scheduled.
// `ctx.step` names the step in progress so a failure can say what was left unfinished.
async function createChannelAndAgent(call, r, ctx) {
  const { created, progress } = ctx;
  ctx.step = "the report channel";
  const typeId = await channelType(call, r.site);
  created.systemId = String((await call("POST", "/systems/new", {
    name: r.name, site: { id: r.site.id, name: r.site.name }, type: { id: typeId }, description: `AI report: ${describeSchedule(r.schedule)}`,
  })).data ?? "");
  if (!id(created.systemId)) throw new Error("The report channel was not created");
  await progress({ systemId: created.systemId });
  created.channelId = String((await call("GET", `/systems/${created.systemId}`)).data?.channelId ?? "");
  if (!id(created.channelId)) throw new Error("The report channel ID could not be read");
  await progress({ channelId: created.channelId });
  const unlinked = [];
  for (const d of r.dashboards) if (!(await linkDashboard(call, d.id, created.systemId))) unlinked.push(d.name);
  ctx.step = "the AI agent";
  const dataConfig = { timeSpan: timeSpanFor(r.range), postTypes: [], dashboards: r.dashboards.map(d => ({ id: d.id })) };
  created.agentId = String((await call("POST", "/agents/new", { name: r.name, description: "", channelId: created.channelId, dataConfig })).data ?? "");
  if (!id(created.agentId)) throw new Error("The AI agent was not created");
  await progress({ agentId: created.agentId });
  // agents/new keeps only the legacy shape; next-gen fields need this follow-up.
  await call("PUT", `/agents/${created.agentId}`, {
    name: r.name, description: "", question: r.question,
    dataConfig: { ...dataConfig, widgetIds: r.widgets.map(w => w.id), answerStyle: r.answerStyle, answerExample: [], fontSize: null },
  });
  return unlinked;
}

// The schedule with its AI Report action, then the recipients as channel followers.
async function scheduleAndFollow(call, { site, name, schedule, recipients }, ctx) {
  const { created, progress } = ctx;
  ctx.step = "the schedule";
  const scheduleId = String((await call("POST", "/schedules/new", {
    systemId: created.systemId, siteId: site.id, isActive: true, name,
    scheduleTypeId: schedule.period === "week" ? "2" : "3",
    daysToRun: schedule.days, hourToRun: `${schedule.time}:00`, recurrent: 1,
    actions: [{
      isEnabled: true, typeId: "10", name, agentId: created.agentId,
      publishConfiguration: {
        name, targets: REPORT_TARGETS, toChannelId: created.channelId, fromChannelId: created.channelId,
        message: "{{agentAnswer()}}",
        formattedMessage: [{ type: "paragraph", children: [{ text: "" }, { type: "agentAnswer", children: [{ text: "{{agentAnswer()}}" }] }, { text: " " }] }],
        postTypeId: "15",
      },
    }],
  })).data ?? "");
  created.scheduled = true;
  if (id(scheduleId)) created.scheduleId = scheduleId;
  await progress({ scheduled: true, ...(id(scheduleId) ? { scheduleId } : {}) });
  ctx.step = "the people";
  await call("PUT", route(`/channels/${created.channelId}/addChannelFollowers`, { userIds: recipients.map(p => p.id).join(",") }));
  created.followersAdded = true;
}

const unlinkedWarning = names => names?.length
  ? { warnings: [`Could not link ${names.join(", ")} to the report channel. The report still reads them; link them from the channel's Dashboards tab.`] } : {};

function duplicateGuards(call, profile, r) {
  return {
    precheck: async () => {
      const existing = await sameNameReportChannels(call, r.site, r.name);
      if (existing.length)
        throw new Blocked("duplicate", `A report channel named "${r.name}" already exists at ${r.site.name}. Use a different name, or edit that report in Zira.`,
          { existing: existing.map(c => ({ ...c, url: link(profile, `/channels/${c.channelId}`) })) });
    },
    // An unknown first step may have left a channel; if exactly one appeared, the setup is partial.
    reconcile: async () => {
      const found = await sameNameReportChannels(call, r.site, r.name);
      return found.length === 1 ? { partial: true, created: { channelId: found[0].channelId } } : null;
    },
  };
}

function partialResult(kind, profile, outcome) {
  return { kind, profile, applied: true, state: "partial", failedStep: outcome.failedStep, reason: outcome.reason,
    created: outcome.created, ...createdLinks(profile, outcome.created),
    message: `Creating ${outcome.failedStep} failed. Already created records remain; finish or remove them in Zira instead of re-running.` };
}

export async function createReport({ call, profile = "prod", plan, apply = false, allowRepeat = false, receipts, resolve, now }) {
  const r = await resolvePlan(call, plan, now);
  if (!apply) return { kind: "ai-report-draft", profile, applied: false, confirm: r.card, sample: r.sample };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "channelId",
    key: fingerprint({ op: "ai-report", profile, siteId: r.site.id, name: normalizeName(r.name), schedule: r.schedule, dashboards: r.dashboards.map(d => d.id).sort() }),
    summary: { kind: "ai-report", siteId: r.site.id, name: r.name },
    links: created => createdLinks(profile, created),
    ...duplicateGuards(call, profile, r),
    run: async progress => {
      const ctx = { created: {}, progress, step: "the report channel" };
      try {
        const unlinked = await createChannelAndAgent(call, r, ctx);
        await scheduleAndFollow(call, r, ctx);
        return { receipt: ctx.created, created: ctx.created, unlinkedDashboards: unlinked, verified: await readBack(call, r, ctx.created) };
      } catch (error) {
        if (!ctx.created.systemId) throw error;
        return { partial: true, receipt: ctx.created, created: ctx.created, failedStep: ctx.step, reason: error.message };
      }
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state)) {
    const created = { ...(outcome.receipt.created ?? {}), ...(outcome.receipt.channelId ? { channelId: outcome.receipt.channelId } : {}) };
    return { kind: "ai-report", profile, applied: false, state: outcome.state, ...createdLinks(profile, created),
      message: "This exact report was already created; nothing new was written." };
  }
  if (outcome.state === "partial") return partialResult("ai-report", profile, outcome);
  const confirmed = Object.values(outcome.verified).every(v => v === true);
  return {
    kind: "ai-report", profile, applied: true, state: confirmed ? "created" : "unverified", confirm: r.card, created: outcome.created,
    verified: outcome.verified,
    ...createdLinks(profile, outcome.created),
    ...unlinkedWarning(outcome.unlinkedDashboards),
    ...(confirmed ? {} : { message: "Zira accepted every step, but some parts could not be read back (verified shows which). Check them from the links; do not create the report again." }),
    next: "The first report arrives at the next scheduled time. More people can be added from the channel's People tab.",
  };
}

/****************************   Draft → review in Zira → schedule   **********************************/

const DRAFT_DELIVERY = "Creates the report channel and its AI agent only. Nothing is scheduled and nobody is emailed until you schedule it.";

// A draft is the channel and agent without a schedule, so the user can preview and edit it on the agent page first.
export async function draftReport({ call, profile = "prod", plan, apply = false, allowRepeat = false, receipts, resolve, now }) {
  const r = await resolvePlan(call, plan, now);
  const card = { ...r.card, delivery: DRAFT_DELIVERY };
  delete card.sentTo;
  if (!apply) return { kind: "ai-report-draft", profile, applied: false, draft: true, confirm: card, sample: r.sample };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "channelId",
    key: fingerprint({ op: "ai-report-draft", profile, siteId: r.site.id, name: normalizeName(r.name), dashboards: r.dashboards.map(d => d.id).sort() }),
    summary: { kind: "ai-report-draft", siteId: r.site.id, name: r.name },
    links: created => createdLinks(profile, created),
    ...duplicateGuards(call, profile, r),
    run: async progress => {
      const ctx = { created: {}, progress, step: "the report channel" };
      try {
        const unlinked = await createChannelAndAgent(call, r, ctx);
        const verified = await readBack(call, { ...r, recipients: [] }, ctx.created);
        return { receipt: ctx.created, created: ctx.created, unlinkedDashboards: unlinked, verified: { channel: true, agent: verified.agent } };
      } catch (error) {
        if (!ctx.created.systemId) throw error;
        return { partial: true, receipt: ctx.created, created: ctx.created, failedStep: ctx.step, reason: error.message };
      }
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state)) {
    const created = { ...(outcome.receipt.created ?? {}), ...(outcome.receipt.channelId ? { channelId: outcome.receipt.channelId } : {}) };
    return { kind: "ai-report-draft", profile, applied: false, state: outcome.state, ...draftIds(created), ...createdLinks(profile, created),
      message: "This draft was already created; nothing new was written. Use show to see it, or schedule it." };
  }
  if (outcome.state === "partial") return partialResult("ai-report-draft", profile, outcome);
  return {
    kind: "ai-report-draft", profile, applied: true, state: outcome.verified.agent === true ? "drafted" : "unverified",
    confirm: card, ...draftIds(outcome.created), verified: outcome.verified, ...createdLinks(profile, outcome.created),
    ...unlinkedWarning(outcome.unlinkedDashboards),
    next: "Open agentUrl to preview the report and its sample answer. Edit it there or ask for changes here, then schedule it.",
  };
}

const draftIds = created => ({ channelId: created.channelId, agentId: created.agentId });

const rangeById = rangeId => Object.entries(REPORT_RANGES).find(([, range]) => range.rangeId === String(rangeId ?? ""));

// Reads a draft live, so edits made on the agent page are what gets scheduled.
async function readDraft(call, site, channelId, agentId) {
  if (!id(channelId) || !id(agentId)) throw new Error("--channel-id and --agent-id are required");
  const channel = (await call("GET", `/channels/${channelId}`)).data ?? {};
  const ctx = channel.context ?? {};
  if (String(ctx.site ?? "") !== site.id || !id(String(ctx.system ?? "")))
    throw new Blocked("scope", "The report channel is not a channel of the selected site", { channelId });
  const agent = (await call("GET", `/agents/${agentId}`)).data ?? {};
  if (String(agent.id ?? agentId) !== agentId || String(agent.channel?.id ?? agent.channelId ?? "") !== channelId)
    throw new Blocked("scope", "The AI agent does not belong to that report channel", { channelId, agentId });
  const dataConfig = agent.dataConfig ?? {};
  const covers = rangeById(dataConfig.timeSpan?.defaultDisplayRange);
  return {
    systemId: String(ctx.system), channelId, agentId, agent,
    name: text(agent.name, 80) || text(channel.name, 80),
    question: text(agent.question),
    answerStyle: (dataConfig.answerStyle ?? []).map(String),
    widgetIds: (dataConfig.widgetIds ?? []).map(String),
    dashboardIds: (dataConfig.dashboards ?? []).map(d => String(d?.id ?? "")).filter(id),
    covers: covers?.[0] ?? null,
    range: covers?.[1] ?? null,
  };
}

async function draftCard(call, profile, site, draft, now = new Date()) {
  const dashboards = draft.dashboardIds.length ? await chosenDashboards(call, site, draft.dashboardIds.join(",")) : [];
  const available = readableWidgets(dashboards);
  return {
    sample: dashboards.length && draft.covers ? sampleRequest(dashboards, draft.widgetIds, draft.covers, now) : null,
    name: draft.name, site: site.name,
    dashboards: dashboards.map(d => String(d.name ?? "")),
    covering: draft.range ? coverage(draft.range).replace(/^covering /, "") : "a period set on the agent page",
    widgets: draft.widgetIds.map(w => available.get(w)?.name ?? `Widget ${w}`),
    answerStyle: draft.answerStyle,
    question: draft.question,
    agentUrl: link(profile, `/ai-agents/${draft.agentId}`, { fromChannel: draft.channelId }),
  };
}

export async function showDraft({ call, profile = "prod", companyId, siteId, channelId, agentId }) {
  const site = await resolveSite(call, companyId, siteId);
  const draft = await readDraft(call, site, channelId, agentId);
  return { kind: "ai-report-draft-state", profile, channelId, agentId, draft: await draftCard(call, profile, site, draft) };
}

// Applies changes asked for in chat on top of the agent's current state (page edits are kept).
export async function updateDraft({ call, profile = "prod", companyId, siteId, channelId, agentId, changes, apply = false, receipts }) {
  if (!changes || typeof changes !== "object") throw new Error("Changes must be a JSON object");
  const site = await resolveSite(call, companyId, siteId);
  const draft = await readDraft(call, site, channelId, agentId);
  const next = { ...draft };
  if (changes.name !== undefined && !(next.name = text(changes.name, 80))) throw new Error("The report name cannot be empty");
  if (changes.question !== undefined && !(next.question = text(changes.question))) throw new Error("The report instructions cannot be empty");
  if (changes.answerStyle !== undefined) next.answerStyle = checkAnswerStyle(changes.answerStyle);
  if (changes.widgetIds !== undefined) {
    const dashboards = await chosenDashboards(call, site, draft.dashboardIds.join(","));
    next.widgetIds = checkWidgets(changes.widgetIds, readableWidgets(dashboards));
  }
  if (changes.covers !== undefined) {
    if (!Object.hasOwn(REPORT_RANGES, changes.covers)) throw new Error(`covers must be one of: ${Object.keys(REPORT_RANGES).join(", ")}`);
    next.covers = changes.covers;
    next.range = REPORT_RANGES[changes.covers];
  }
  const card = await draftCard(call, profile, site, next);
  if (!apply) return { kind: "ai-report-draft-update", profile, applied: false, channelId, agentId, draft: card };
  const dataConfig = { ...(draft.agent.dataConfig ?? {}), widgetIds: next.widgetIds, answerStyle: next.answerStyle,
    ...(next.range ? { timeSpan: timeSpanFor(next.range) } : {}) };
  // Each update is its own write; identical later updates must still apply after other edits.
  await guardedWrite({
    file: receipts, allowRepeat: true,
    key: fingerprint({ op: "ai-report-draft-update", profile, agentId, changes }),
    summary: { kind: "ai-report-draft-update", agentId },
    run: async () => {
      await call("PUT", `/agents/${agentId}`, { name: next.name, description: draft.agent.description ?? "", question: next.question, dataConfig });
      return { receipt: { agentId } };
    },
  });
  const saved = await readDraft(call, site, channelId, agentId);
  const verified = saved.question === next.question && next.widgetIds.every(w => saved.widgetIds.includes(w));
  return { kind: "ai-report-draft-update", profile, applied: true, state: verified ? "updated" : "unverified", channelId, agentId,
    draft: await draftCard(call, profile, site, saved) };
}

// Schedules a reviewed draft with the agent's current wording, widgets and period.
export async function scheduleDraft({ call, profile = "prod", plan, channelId, agentId, apply = false, allowRepeat = false, receipts, resolve }) {
  if (!plan || typeof plan !== "object") throw new Error("Plan must be a JSON object");
  const site = await resolveSite(call, String(plan.companyId ?? ""), String(plan.siteId ?? ""));
  const draft = await readDraft(call, site, channelId, agentId);
  if (!draft.question || !draft.widgetIds.length) throw new Error("The draft agent has no instructions or widgets; finish it on the agent page first");
  if (!draft.range) throw new Blocked("scope", "The agent page uses a period an AI report cannot schedule. Set it to today, yesterday, this or last week, or this or last month.", { agentId });
  const schedule = normalizeSchedule({ ...(plan.schedule ?? {}), covers: draft.covers });
  if (plan.schedule?.covers != null && plan.schedule.covers !== draft.covers)
    throw new Error(`The draft covers ${draft.range.label}. Change the period with update-draft (covers) before scheduling.`);
  const recipients = await resolveRecipients(call, site, plan.recipientIds);
  const card = {
    ...(await draftCard(call, profile, site, draft)),
    when: `${describeSchedule(schedule)} (site local time), ${coverage(draft.range)}`,
    sentTo: recipients.map(p => p.name),
    delivery: "Schedules the report in its channel; its followers get each report as a post, notification and email.",
  };
  if (!apply) return { kind: "ai-report-schedule", profile, applied: false, channelId, agentId, confirm: card };
  const created = { systemId: draft.systemId, channelId, agentId };
  const outcome = await guardedWrite({
    file: receipts, allowRepeat, resolve, resolveField: "scheduleId",
    key: fingerprint({ op: "ai-report-schedule", profile, siteId: site.id, channelId, agentId }),
    summary: { kind: "ai-report-schedule", siteId: site.id, channelId, name: draft.name },
    links: c => createdLinks(profile, { ...created, ...c }),
    run: async progress => {
      const ctx = { created, progress, step: "the schedule" };
      try {
        await scheduleAndFollow(call, { site, name: draft.name, schedule, recipients }, ctx);
        const verified = await readBack(call, { question: draft.question, widgets: draft.widgetIds.map(w => ({ id: w })), recipients }, created);
        return { receipt: created, created, verified };
      } catch (error) {
        if (!created.scheduled) throw error;
        return { partial: true, receipt: created, created, failedStep: ctx.step, reason: error.message };
      }
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "ai-report-schedule", profile, applied: false, state: outcome.state, ...createdLinks(profile, { ...created, scheduled: true }),
      message: "This draft was already scheduled; nothing new was written." };
  if (outcome.state === "partial") return partialResult("ai-report-schedule", profile, outcome);
  const confirmed = Object.values(outcome.verified).every(v => v === true);
  return {
    kind: "ai-report", profile, applied: true, state: confirmed ? "created" : "unverified", confirm: card, created: outcome.created,
    verified: outcome.verified, ...createdLinks(profile, outcome.created),
    ...(confirmed ? {} : { message: "Zira accepted every step, but some parts could not be read back (verified shows which). Check them from the links; do not schedule the draft again." }),
    next: "The first report arrives at the next scheduled time. More people can be added from the channel's People tab.",
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, "dashboard-ids": { type: "string" },
    plan: { type: "string" }, apply: { type: "boolean" }, "allow-repeat": { type: "boolean" },
    receipts: { type: "string" }, profile: { type: "string" }, "resolve-pending": { type: "string" },
    "channel-id": { type: "string" }, "agent-id": { type: "string" }, changes: { type: "string" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const call = await liveSession(profile, { allow: ROUTES, maxRequests: 80 });
  const scope = { call, profile, companyId: o["company-id"], siteId: o["site-id"] };
  if (args[0] === "dashboards") return reportDashboards(scope);
  if (args[0] === "widgets") return reportWidgets({ ...scope, dashboardIds: o["dashboard-ids"] });
  if (args[0] === "people") return reportPeople(scope);
  const write = { apply: !!o.apply, allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) };
  const draft = { channelId: o["channel-id"], agentId: o["agent-id"] };
  const json = async (file, flag) => {
    if (!file) throw new Error(`--${flag} FILE required`);
    return JSON.parse(await readFile(file, "utf8"));
  };
  if (args[0] === "create") return createReport({ call, profile, plan: await json(o.plan, "plan"), ...write });
  if (args[0] === "draft") return draftReport({ call, profile, plan: await json(o.plan, "plan"), ...write });
  if (args[0] === "show") return showDraft({ ...scope, ...draft });
  if (args[0] === "update-draft") return updateDraft({ ...scope, ...draft, changes: await json(o.changes, "changes"), apply: write.apply, receipts: write.receipts });
  if (args[0] === "schedule") return scheduleDraft({ call, profile, plan: await json(o.plan, "plan"), ...draft, ...write });
  throw new Error("Choose dashboards, widgets, people, create, draft, show, update-draft or schedule");
}

if (isMain(import.meta))
  runCli(main, {
    profile: () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod",
    handoffInfo: () => ({ prompt: "Schedule an AI report" }),
  });
