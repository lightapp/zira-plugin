export const PROFILES = ["trimsaw", "bandsaw", "pallet-qa"];
export const TASK_MODES = ["report-only", "draft", "automatic"];
// "status" checks reporting and device status only, on every camera instead of the profiles.
export const CHECK_SETS = ["full", "status"];
export const statusOnly = (c) => c?.checks === "status";
export const id = (value) =>
  typeof value === "string" && /^[1-9]\d*$/.test(value);
export const finite = (value) =>
  typeof value === "number" && Number.isFinite(value);
export function timestamp(value) {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function windowValid(w) {
  return (
    w &&
    timestamp(w.from) &&
    timestamp(w.to) &&
    Date.parse(w.from) < Date.parse(w.to)
  );
}
export function validateConfig(c) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(c?.version === 1, "version must be 1");
  need(
    typeof c?.monitorId === "string" &&
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.monitorId),
    "monitorId must be a stable lowercase name",
  );
  need(id(c?.companyId), "companyId must be a positive ID string");
  need(
    c?.siteIds === "all" ||
      (Array.isArray(c?.siteIds) &&
        c.siteIds.length > 0 &&
        c.siteIds.every(id)),
    'siteIds must be "all" or a nonempty ID array',
  );
  need(
    c?.checks === undefined || CHECK_SETS.includes(c.checks),
    "checks must be full or status",
  );
  if (statusOnly(c))
    need(
      c.profiles === undefined,
      "status checks cover every camera; leave out profiles",
    );
  else
    need(
      Array.isArray(c?.profiles) &&
        c.profiles.length > 0 &&
        c.profiles.every((v) => PROFILES.includes(v)),
      "profiles must include supported use cases",
    );
  if (c?.statusDefaults !== undefined) {
    const d = c.statusDefaults;
    need(
      d && typeof d === "object" && !Array.isArray(d) &&
        Object.keys(d).every((k) => k === "batteryMinimum"),
      "statusDefaults supports batteryMinimum only",
    );
    if (d?.batteryMinimum !== undefined)
      need(
        finite(d.batteryMinimum) &&
          d.batteryMinimum >= 0 &&
          d.batteryMinimum <= 100,
        "Battery minimum must be 0–100",
      );
  }
  need(
    TASK_MODES.includes(c?.tasks?.mode),
    "choose tasks.mode: report-only, draft or automatic",
  );
  if (c?.tasks?.mode !== "report-only")
    need(
      id(c?.tasks?.assigneeId),
      "tasks.assigneeId is required when tasks are enabled",
    );
  need(
    finite(c?.freshnessMinutes) &&
      c.freshnessMinutes >= 1 &&
      c.freshnessMinutes <= 1440,
    "freshnessMinutes must be 1–1440",
  );
  need(
    !c?.devices || (typeof c.devices === "object" && !Array.isArray(c.devices)),
    "devices must be an object",
  );
  for (const [deviceId, rule] of Object.entries(c?.devices ?? {})) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push("Device rule must be an object");
      continue;
    }
    if (rule.batteryMinimum !== undefined)
      need(
        finite(rule.batteryMinimum) &&
          rule.batteryMinimum >= 0 &&
          rule.batteryMinimum <= 100,
        "Battery minimum must be 0–100",
      );
    if (rule.temperatureMaximum !== undefined)
      need(
        finite(rule.temperatureMaximum) &&
          ["C", "F"].includes(rule.temperatureUnit),
        "Temperature limit requires a finite value and C/F unit",
      );
    need(id(deviceId), "device rule keys must be ID strings");
    if (rule.profile !== undefined)
      need(
        PROFILES.includes(rule.profile) && rule.profileConfirmed === true,
        `device ${deviceId}: confirm profile override`,
      );
    const counts = rule.counts;
    if (counts) {
      need(
        counts.confirmed === true && typeof counts.metric === "string",
        `device ${deviceId}: confirm count metric semantics`,
      );
      need(
        ["increments", "counter"].includes(counts.kind),
        `device ${deviceId}: count kind must be increments or counter`,
      );
      if (rule.profile === "pallet-qa")
        need(
          counts.uniqueCyclesConfirmed === true,
          `device ${deviceId}: confirm unique pallet cycles`,
        );
      need(
        finite(counts.minimum) &&
          counts.minimum >= 0 &&
          finite(counts.maximum) &&
          counts.maximum >= counts.minimum,
        `device ${deviceId}: count limits must be finite and ordered`,
      );
      need(
        finite(counts.periodMinutes) && counts.periodMinutes > 0,
        `device ${deviceId}: limits require periodMinutes`,
      );
      need(
        Array.isArray(counts.operatingWindows) &&
          counts.operatingWindows.length > 0 &&
          counts.operatingWindows.every(windowValid),
        `device ${deviceId}: supply explicit operatingWindows with timezone`,
      );
      if (counts.kind === "counter")
        need(
          counts.counterReset === "unknown" || counts.counterReset === "zero",
          `device ${deviceId}: declare counterReset behavior`,
        );
    }
    const m = rule.measurements;
    if (m) {
      need(
        m.confirmed === true && m.independentTargets === true,
        `device ${deviceId}: independently approved measurement targets required`,
      );
      need(
        ["mm", "cm", "in", "ft"].includes(m.unit),
        `device ${deviceId}: supported measurement unit required`,
      );
      need(
        typeof m.actualMetric === "string" &&
          typeof m.targetKeyMetric === "string" &&
          m.actualMetric !== m.targetKeyMetric,
        `device ${deviceId}: separate actual and target-assignment fields required`,
      );
      need(
        typeof m.filterMetric === "string" &&
          ["string", "number", "boolean"].includes(typeof m.filterEquals),
        `device ${deviceId}: version-aware cut filter required`,
      );
      need(
        typeof m.version === "string" && m.version.length > 0,
        `device ${deviceId}: measurement app version required`,
      );
      need(
        ["individual", "grouped-mean"].includes(m.granularity),
        `device ${deviceId}: declare granularity`,
      );
      if (m.granularity === "grouped-mean")
        need(
          typeof m.weightMetric === "string",
          `device ${deviceId}: grouped means require weightMetric`,
        );
      need(
        Number.isInteger(m.minSamples) && m.minSamples >= 2,
        `device ${deviceId}: minSamples >= 2 required`,
      );
      need(
        m.targets &&
          Object.keys(m.targets).length > 0 &&
          Object.values(m.targets).every(
            (t) =>
              t &&
              finite(t.expected) &&
              t.expected > 0 &&
              finite(t.lower) &&
              finite(t.upper) &&
              t.lower > 0 &&
              t.lower <= t.expected &&
              t.expected <= t.upper,
          ),
        `device ${deviceId}: positive, ordered target/tolerance values required`,
      );
      if (m.warningMargin !== undefined)
        need(
          finite(m.warningMargin) && m.warningMargin >= 0,
          `device ${deviceId}: warningMargin must be nonnegative`,
        );
    }
  }
  if (c?.schedule) {
    need(
      ["daily", "weekdays", "weekly"].includes(c.schedule.frequency) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(c.schedule.time ?? ""),
      "schedule requires daily, weekdays or weekly frequency and HH:MM time",
    );
    if (c.schedule.frequency === "weekly")
      need(
        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(c.schedule.day),
        "weekly schedule requires day mon–sun",
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: c.schedule.timezone }).format();
      need(
        typeof c.schedule.timezone === "string",
        "schedule.timezone required",
      );
    } catch {
      errors.push("invalid schedule.timezone");
    }
    need(
      ["all-runs", "changes-only"].includes(c.schedule.delivery),
      "choose schedule.delivery",
    );
    if (c?.tasks?.mode === "automatic")
      need(
        c.schedule.allowTaskWrites === true,
        "explicit schedule.allowTaskWrites required for recurring automatic tasks",
      );
  }
  return errors;
}
export function assertConfig(c) {
  const errors = validateConfig(c);
  if (errors.length) throw new Error(errors.join("; "));
  return c;
}
export function questions(c = {}) {
  if (!id(c.companyId))
    return [
      {
        key: "companyId",
        question:
          "Which company should I check? Choose from authorized companies.",
      },
    ];
  if (!c.siteIds)
    return [
      {
        key: "siteIds",
        question: "Check all sites in this company, or selected sites?",
      },
    ];
  if (!TASK_MODES.includes(c.tasks?.mode))
    return [
      {
        key: "tasks.mode",
        question: "Should I open tasks for issues needing follow-up?",
        choices: TASK_MODES,
      },
    ];
  if (c.tasks.mode !== "report-only" && !id(c.tasks.assigneeId))
    return [
      {
        key: "tasks.assigneeId",
        question: "Who should receive the tasks? Choose a verified Zira user.",
      },
    ];
  if (c.schedule && !c.schedule.timezone)
    return [
      {
        key: "schedule.timezone",
        question:
          "Which timezone should this daily time use? Site-local schedules need separate timezone groups.",
      },
    ];
  return [];
}
export function scheduleHandoff(c, configPath) {
  assertConfig(c);
  if (!c.schedule) throw new Error("No schedule configured");
  return {
    active: false,
    requiresHostScheduler: true,
    monitorId: c.monitorId,
    schedule: c.schedule,
    prompt: `Use the health-report skill. Load the saved monitor configuration at ${JSON.stringify(configPath)}. Run ${c.monitorId} for company ID ${c.companyId}, ${c.siteIds === "all" ? "all authorized sites" : "site IDs " + c.siteIds.join(", ")}. Use the saved task policy (${c.tasks.mode}) and rules. Report all missing coverage and errors. Lead with the attention summary: devices that went down recently, with how long each has been down, before long-term outages. Link or attach the regenerated report.html dashboard. ${c.schedule.delivery === "changes-only" ? "Notify only for new/worsened findings, recovery, execution failure or required user action; stay quiet for unchanged non-actionable state." : "Return the full report after every run."} Do not ask setup questions during unattended execution; report missing requirements. Do not change equipment or enable new remedies.`,
    instructions:
      "Create or update the host scheduler, then verify its ID, timezone and next run. This output alone does not create a schedule. Ensure the configuration, runtime and credentials are available at execution time.",
  };
}
