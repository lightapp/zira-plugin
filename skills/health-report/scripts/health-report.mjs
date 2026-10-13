#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertConfig, questions, scheduleHandoff, id } from "./config.mjs";
import { assess, markdown } from "./engine.mjs";
import { attention, dashboardHtml } from "./dashboard.mjs";
import {
  liveClient,
  discover,
  collect,
  toolkit,
  normalizeDevice,
  agentData,
  dashboardWidgets,
} from "./api.mjs";
import { readJson, writePrivate, withLock } from "./storage.mjs";
import { prepareShare } from "./sharing.mjs";
import { internalTaskClient, ZiraApiError } from "./task-api.mjs";
import { taskDrafts, handleTasks, updateTask } from "./tasks.mjs";
const HELP = `health-report 0.3.51-preview.1 — Zira health checks for Codex and Claude Code

node scripts/health-report.mjs COMMAND [OPTIONS]
  auth status|login|logout ...                 Zira browser authentication
  questions [--config FILE]                  Next guided setup questions
  discover companies|sites|devices|users [--company-id ID --site-id ID]
  inspect --device-id ID --company-id ID       Sanitized mapping hints
  validate --config FILE
  run --config FILE --out DIR [--from ISO --to ISO] [--snapshot FILE]
      [--state FILE] [--max-devices 500] [--max-rows 50000]
  prepare-share --report FILE --out DIRECTORY  Prepare a local static site; does not publish
  tasks --config FILE --report FILE [--ledger FILE --apply | --offline]
  update-task --task-id ID --site-id ID --patch FILE [--apply]
  schedule --config FILE                     Host handoff only; never activates
  dashboard-widgets --dashboard-id ID [--company-id ID --site-id ID]
  agent-data --dashboard-id ID --widget-ids ID,ID --from ISO --to ISO [--interval "1 hours"]
    [--company-id ID --site-id ID]  At most 20 widgets / 7 days; exit 3 for incomplete evidence.

Common: --profile prod|integ (default prod). Task writes require --apply.
Tasks use browser sign-in and internal APIs. --offline returns local drafts without checking
duplicates. Use the same --profile as the report. run never writes remotely.
Exit: 0 success, 2 invalid input/request failed, 3 report contains unavailable coverage.
Reports/state are private local files. See references/configuration.md.
`;
function numberOption(x, fallback, max) {
  if (x === undefined) return fallback;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error("Invalid numeric cap");
  return n;
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "auth") {
    if (!["status", "login", "logout", "profiles"].includes(args[1]))
      throw new Error("Use auth status, login, logout or profiles");
    const { run } = await toolkit("cli.js");
    return run(args.slice(1));
  }
  const strings = [
    "config",
    "company-id",
    "device-id",
    "out",
    "from",
    "to",
    "snapshot",
    "state",
    "profile",
    "max-devices",
    "max-rows",
    "report",
    "ledger",
    "task-id",
    "site-id",
    "patch",
    "dashboard-id",
    "widget-ids",
    "interval",
  ];
  const { values: o, positionals } = parseArgs({
    args: args.slice(1),
    options: {
      ...Object.fromEntries(strings.map((k) => [k, { type: "string" }])),
      apply: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const emit = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  const config = o.config ? await readJson(o.config) : undefined;
  if (command === "questions") {
    emit(questions(config));
    return 0;
  }
  if (command === "validate") {
    assertConfig(config);
    emit({ valid: true, monitorId: config.monitorId });
    return 0;
  }
  if (command === "schedule") {
    emit(scheduleHandoff(config, path.resolve(o.config)));
    return 0;
  }
  if (command === "prepare-share") {
    emit(await prepareShare(o.report, o.out));
    return 0;
  }
  if (command === "discover") {
    emit(
      await discover(
        await liveClient(o.profile),
        positionals[0],
        o["company-id"],
        o["site-id"],
      ),
    );
    return 0;
  }
  if (command === "inspect") {
    if (!id(o["device-id"]) || !id(o["company-id"]))
      throw new Error("Device/company ID required");
    const get = await liveClient(o.profile);
    const d = (await get(`/devices/${o["device-id"]}`)).data;
    if (String(d?.companyId) !== o["company-id"])
      throw new Error("Device outside selected company");
    emit(normalizeDevice({}, d, { devices: {} }));
    return 0;
  }
  if (command === "dashboard-widgets") {
    emit(await dashboardWidgets(await liveClient(o.profile), {
      dashboardId: o["dashboard-id"], companyId: o["company-id"], siteId: o["site-id"],
    }));
    return 0;
  }
  if (command === "agent-data") {
    const result = await agentData(await liveClient(o.profile), {
      dashboardId: o["dashboard-id"], widgetIds: o["widget-ids"]?.split(","),
      from: o.from, to: o.to, interval: o.interval,
      companyId: o["company-id"], siteId: o["site-id"],
    });
    emit(result);
    return result.complete ? 0 : 3;
  }
  if (command === "run") {
    assertConfig(config);
    if (!o.out) throw new Error("--out is required");
    const stateFile =
      o.state ??
      path.join(path.resolve(o.out), `${config.monitorId}.state.json`);
    return withLock(`${stateFile}.lock`, async () => {
      const now = new Date().toISOString();
      const to = o.to ?? now,
        from = o.from ?? new Date(Date.parse(to) - 86400000).toISOString();
      const snapshot = o.snapshot
        ? await readJson(o.snapshot)
        : await collect(await liveClient(o.profile), config, {
            from,
            to,
            now,
            sourceProfile: o.profile ?? process.env.ZIRA_PROFILE ?? "prod",
            maxDevices: numberOption(o["max-devices"], 500, 2000),
            maxRows: numberOption(o["max-rows"], 50000, 100000),
          });
      const { report, state } = assess(
        snapshot,
        config,
        await readJson(stateFile, {}),
      );
      const jsonFile = path.join(path.resolve(o.out), "report.json"),
        mdFile = path.join(path.resolve(o.out), "report.md"),
        htmlFile = path.join(path.resolve(o.out), "report.html");
      await writePrivate(jsonFile, report);
      await writePrivate(mdFile, markdown(report));
      await writePrivate(htmlFile, dashboardHtml(report));
      await writePrivate(stateFile, state);
      const summary = (({ rows, ...rest }) => rest)(attention(report));
      const partial = !report.inventoryComplete || summary.coverageGaps > 0;
      emit({
        report: jsonFile,
        markdown: mdFile,
        dashboard: htmlFile,
        state: stateFile,
        totals: report.totals,
        attention: summary,
        findings: report.findings.length,
        partial,
      });
      return partial ? 3 : 0;
    });
  }
  if (command === "tasks") {
    const report = await readJson(o.report);
    const drafts = taskDrafts(report, config);
    if (o.offline) {
      if (o.apply) throw new Error("--offline cannot be combined with --apply");
      emit({ state: "offline-drafts", duplicatesChecked: false, drafts });
      return 0;
    }
    const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
    if (!["prod", "integ"].includes(profile) || report.sourceProfile !== profile)
      throw new Error("Task operations require the same prod/integ profile as the report; rerun a legacy report or use --offline for local drafts");
    const reportAge = Date.now() - Date.parse(report.assessedAt);
    if (
      o.apply &&
      (!Number.isFinite(reportAge) ||
        reportAge < 0 ||
        reportAge > config.freshnessMinutes * 60000)
    )
      throw new Error("Run a fresh report before creating tasks");
    const client = await internalTaskClient(profile);
    const get = o.apply ? await liveClient(profile) : null;
    const verifyAssignment = async (siteId, assigneeId, deviceId) => {
      const [sites, users, detail] = await Promise.all([
        discover(get, "sites", config.companyId),
        discover(get, "users", config.companyId, siteId),
        get(`/devices/${deviceId}`),
      ]);
      const d = detail.data;
      return (
        sites.some((s) => s.id === siteId) &&
        users.some((u) => u.id === assigneeId) &&
        String(d?.id) === deviceId &&
        String(d?.companyId) === config.companyId &&
        String(d?.site?.id) === siteId &&
        !d.isDeleted &&
        !d.isTemplate
      );
    };
    const result = await handleTasks({
      report,
      config,
      client,
      ledgerFile:
        o.ledger ??
        path.join(path.dirname(path.resolve(o.config)), "task-ledger.json"),
      apply: o.apply,
      verifyAssignment,
    });
    emit(result);
    return result.items.some((i) =>
      [
        "blocked",
        "uncertain",
        "needs-verification",
        "review-existing",
      ].includes(i.state),
    )
      ? 3
      : 0;
  }
  if (command === "update-task") {
    const result = await updateTask({
      client: await internalTaskClient(o.profile),
      taskId: o["task-id"],
      siteId: o["site-id"],
      patch: await readJson(o.patch),
      apply: o.apply,
    });
    emit(result);
    return result.state === "needs-verification" ? 3 : 0;
  }
  throw new Error("Unknown command; use help");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      const message = e instanceof ZiraApiError && [401, 403].includes(e.status)
        ? `${e.message}. Check browser sign-in, user/site permissions and the internal API authorizer; no API-key fallback is supported.`
        : e.message;
      process.stderr.write(`health-report: ${message}\n`);
      process.exitCode = 2;
    });
