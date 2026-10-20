import { deviceStatus, statusText } from "./status.mjs";
import { dataSourceUrl } from "./links.mjs";
import { createHash } from "node:crypto";
import { assertConfig, finite, timestamp, id, statusOnly, windowValid } from "./config.mjs";
import { attention, ageLabel, KNOWN_DAYS, scopeLabel } from "./dashboard.mjs";
const minute = 60000;
// Readings and heartbeats are fetched after assessedAt, so a live source can be
// slightly ahead of it; beyond this many minutes a timestamp is in the future.
const CLOCK_SKEW_MINUTES = 5;
const age = (now, value) =>
  timestamp(value) ? (now - Date.parse(value)) / minute : null;
const mean = (rows) =>
  rows.reduce((s, r) => s + r.value * r.weight, 0) /
  rows.reduce((s, r) => s + r.weight, 0);
export function fingerprint(c) {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}
export function connectivity(d, c, now) {
  if (d.errors?.length)
    return { state: "unknown", reason: d.errors.join("; ") };
  const s = d.status ?? {},
    heartbeatAge = age(now, s.lastHeartbeat),
    readingAge = age(now, d.lastReadingAt);
  if (
    (heartbeatAge !== null && heartbeatAge < -CLOCK_SKEW_MINUTES) ||
    (readingAge !== null && readingAge < -CLOCK_SKEW_MINUTES)
  )
    return { state: "unknown", reason: "Source timestamp is in the future" };
  if (s.staleStatus === true) {
    if (
      readingAge !== null &&
      readingAge >= -CLOCK_SKEW_MINUTES &&
      readingAge <= c.freshnessMinutes
    )
      return {
        state: "unknown",
        reason: "Stale status conflicts with recent readings",
      };
    return {
      state: "not-reporting",
      reason: "Backend marks last known device status stale",
      since: s.lastHeartbeat ?? null,
    };
  }
  if (heartbeatAge !== null) {
    if (heartbeatAge > c.freshnessMinutes)
      return {
        state: "not-reporting",
        reason: "Heartbeat exceeded configured freshness threshold",
        since: s.lastHeartbeat,
      };
    if (s.onLine === false)
      return {
        state: "not-reporting",
        reason: "Fresh device status reports offline",
        since: null,
      };
    return { state: "reporting", reason: "Fresh heartbeat" };
  }
  if (
    readingAge !== null &&
    readingAge >= -CLOCK_SKEW_MINUTES &&
    readingAge <= c.freshnessMinutes &&
    s.onLine !== false
  )
    return {
      state: "reporting",
      reason: "Recent reading received; heartbeat time unavailable",
    };
  if (
    d.historyVerified === true &&
    d.neverReported === true &&
    !d.lastReadingAt &&
    !s.lastHeartbeat
  )
    return {
      state: "never-reported",
      reason: "Verified no reporting history for this installation",
    };
  return {
    state: "unknown",
    reason:
      "No authoritative heartbeat time or recent reading; last known online flag is insufficient",
  };
}
function countChecks(d, rule, now, add) {
  const r = rule?.counts;
  if (!r)
    return {
      state: "needs-setup",
      reason: "Confirm count metric, semantics, operating windows and limits",
    };
  if (d.profile === "pallet-qa" && r.uniqueCyclesConfirmed !== true)
    return {
      state: "needs-setup",
      reason: "Confirm completed unique pallet cycles",
    };
  if (!d.readings?.complete)
    return {
      state: "unavailable",
      reason: d.readings?.error ?? "Raw readings unavailable or capped",
    };
  const rows = d.readings.rows ?? [];
  let assessed = 0,
    invalid = 0,
    total = 0,
    unavailable = 0;
  const anomalies = [];
  for (const w of r.operatingWindows) {
    const start = Date.parse(w.from),
      end = Date.parse(w.to);
    if (end > now || end - start !== r.periodMinutes * minute) {
      unavailable++;
      continue;
    }
    if (
      start < Date.parse(d.readings.from) ||
      end > Date.parse(d.readings.to)
    ) {
      unavailable++;
      continue;
    }
    const selected = rows.filter(
      (x) => Date.parse(x.at) >= start && Date.parse(x.at) < end,
    );
    let value = 0,
      bad = false;
    if (r.kind === "increments") {
      for (const row of selected) {
        const v = row.values?.[r.metric];
        if (!finite(v) || v < 0) bad = true;
        else value += v;
      }
    } else {
      let prev = rows.filter((x) => Date.parse(x.at) < start).at(-1)?.values?.[
        r.metric
      ];
      if (!finite(prev) || prev < 0) bad = true;
      for (const row of selected) {
        const v = row.values?.[r.metric];
        if (!finite(v) || v < 0) {
          bad = true;
          continue;
        }
        if (v < prev && r.counterReset !== "zero") bad = true;
        value += v >= prev ? v - prev : v;
        prev = v;
      }
    }
    if (bad) {
      invalid++;
      continue;
    }
    assessed++;
    total += value;
    if (value < r.minimum || value > r.maximum)
      anomalies.push({
        from: w.from,
        to: w.to,
        value,
        minimum: r.minimum,
        maximum: r.maximum,
        metric: r.metric,
      });
  }
  if (anomalies.length)
    add(
      "counts",
      "count-range",
      `Counts outside expected ${r.minimum}–${r.maximum} in ${anomalies.length} operating window(s)`,
      { ...anomalies[0], windows: anomalies },
      "warning",
    );
  if (invalid)
    add(
      "counts",
      "invalid-counts",
      "Invalid or ambiguous count readings",
      { windows: invalid },
      "warning",
    );
  return {
    state: !assessed
      ? invalid
        ? "partial"
        : "unavailable"
      : invalid || unavailable
        ? "partial"
        : "assessed",
    assessedWindows: assessed,
    unavailableWindows: unavailable,
    total,
    reason: assessed
      ? "Compared completed operating windows with confirmed limits"
      : "No complete eligible operating window; partial periods are not compared",
  };
}
function measurementChecks(d, rule, now, add) {
  if (d.profile !== "trimsaw") return { state: "not-applicable" };
  const r = rule?.measurements;
  if (!r)
    return {
      state: "needs-setup",
      reason:
        "Approved target assignment, units, tolerances and version-aware cut filter required",
    };
  if (r.version !== d.appVersion)
    return {
      state: "needs-setup",
      reason: "Device app version differs from approved measurement mapping",
    };
  if (!d.readings?.complete)
    return {
      state: "unavailable",
      reason: d.readings?.error ?? "Measurement readings unavailable or capped",
    };
  const groups = new Map();
  let unknown = 0,
    invalid = 0,
    count = 0;
  for (const row of d.readings.rows) {
    if (
      Date.parse(row.at) <
        Date.parse(d.readings.analysisFrom ?? d.readings.from) ||
      Date.parse(row.at) >= Date.parse(d.readings.to) ||
      Date.parse(row.at) > now
    )
      continue;
    const v = row.values ?? {};
    if (v[r.filterMetric] == null) {
      invalid++;
      continue;
    }
    if (v[r.filterMetric] !== r.filterEquals) continue;
    const key = String(v[r.targetKeyMetric] ?? "");
    if (!Object.hasOwn(r.targets, key)) {
      unknown++;
      continue;
    }
    const value = v[r.actualMetric],
      weight = r.granularity === "grouped-mean" ? v[r.weightMetric] : 1;
    if (!finite(value) || value <= 0 || !finite(weight) || weight <= 0) {
      invalid++;
      continue;
    }
    const g = groups.get(key) ?? [];
    g.push({ value, weight, at: row.at });
    groups.set(key, g);
    count++;
  }
  if (unknown)
    add(
      "measurements",
      "unknown-target",
      "Readings have unassigned expected sizes",
      { rows: unknown },
      "warning",
    );
  if (invalid)
    add(
      "measurements",
      "invalid-measurements",
      "Missing or invalid measurement/filter values",
      { rows: invalid },
      "warning",
    );
  let assessedTargets = 0;
  const assessedTargetKeys = [];
  for (const [key, samples] of groups) {
    if (samples.length < r.minSamples) continue;
    assessedTargets++;
    assessedTargetKeys.push(key);
    const t = r.targets[key],
      value = mean(samples),
      mid = Math.floor(samples.length / 2);
    const early = mean(samples.slice(0, mid)),
      late = mean(samples.slice(mid));
    const evidence = {
      targetKey: key,
      expected: t.expected,
      lower: t.lower,
      upper: t.upper,
      mean: value,
      earlyMean: early,
      lateMean: late,
      unit: r.unit,
      rows: samples.length,
      granularity: r.granularity,
    };
    if (value < t.lower || value > t.upper)
      add(
        "measurements",
        "measurement-offset",
        `Mean cut size ${value.toFixed(3)} ${r.unit} outside approved tolerance`,
        evidence,
        "warning",
        key,
      );
    else if (
      r.warningMargin !== undefined &&
      Math.abs(late - t.expected) > Math.abs(early - t.expected) &&
      (late <= t.lower + r.warningMargin || late >= t.upper - r.warningMargin)
    )
      add(
        "measurements",
        "measurement-drift",
        "Cut-size mean moving toward the tolerance limit",
        evidence,
        "warning",
        key,
      );
    if (r.granularity === "individual") {
      const outliers = samples.filter(
        (x) => x.value < t.lower || x.value > t.upper,
      ).length;
      if (outliers)
        add(
          "measurements",
          "measurement-outliers",
          "Individual measurements outside tolerance",
          { ...evidence, outliers },
          "warning",
          key,
        );
    }
  }
  return {
    state:
      unknown || invalid
        ? "partial"
        : assessedTargets
          ? "assessed"
          : "learning",
    rows: count,
    assessedTargets,
    assessedTargetKeys,
    reason:
      r.granularity === "grouped-mean"
        ? "Grouped means cannot establish individual-board failure rate"
        : "Individual measurement observations",
  };
}
export function assess(snapshot, config, previous = {}) {
  assertConfig(config);
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.devices) ||
    !windowValid(snapshot.window)
  )
    throw new Error("Invalid snapshot version, devices or window");
  if (snapshot.companyId !== config.companyId)
    throw new Error("Snapshot company does not match monitor");
  if (!timestamp(snapshot.assessedAt))
    throw new Error("Snapshot requires an assessment timestamp with timezone");
  const now = Date.parse(snapshot.assessedAt),
    configHash = fingerprint(config);
  const comparable =
    previous.monitorId === config.monitorId &&
    previous.companyId === config.companyId &&
    previous.configHash === configHash;
  if (
    comparable &&
    Date.parse(snapshot.assessedAt) < Date.parse(previous.assessedAt)
  )
    throw new Error(
      "Snapshot predates saved state; replay with an isolated state file",
    );
  const previousDevices = comparable ? (previous.devices ?? {}) : {};
  const devices = [],
    findings = [],
    excluded = [];
  const keys = new Set();
  for (let d of snapshot.devices ?? []) {
    if (
      d.companyId !== config.companyId ||
      (config.siteIds !== "all" && !config.siteIds.includes(d.siteId))
    ) {
      excluded.push({
        id: d.id,
        reason: "Outside configured company/site scope",
      });
      continue;
    }
    const inScope = statusOnly(config)
      ? d.camera === true
      : config.profiles.includes(d.profile);
    if (d.excluded || (!inScope && !d.errors?.length)) {
      excluded.push({
        id: d.id,
        name: d.name,
        reason:
          d.excluded ??
          (statusOnly(config)
            ? "Not a camera: no device status"
            : "Use case not confirmed/in scope"),
      });
      continue;
    }
    if (!id(d.id) || !id(d.siteId))
      throw new Error("Invalid device/site identity");
    if (d.readings?.complete) {
      if (
        !windowValid(d.readings) ||
        !Array.isArray(d.readings.rows) ||
        d.readings.rows.some((r) => !timestamp(r.at))
      )
        throw new Error("Invalid complete readings");
      d = {
        ...d,
        readings: {
          ...d.readings,
          rows: [...d.readings.rows].sort(
            (a, b) => Date.parse(a.at) - Date.parse(b.at),
          ),
        },
      };
    }
    const identity = d.identity ?? `data-source:${d.id}`;
    const deviceKey = `${d.siteId}:${d.id}:${identity}`;
    if (keys.has(deviceKey))
      throw new Error("Duplicate device identity in snapshot");
    keys.add(deviceKey);
    const conn = connectivity(d, config, now),
      checks = {};
    const add = (
      check,
      code,
      title,
      evidence,
      severity = "warning",
      target = "",
    ) => {
      const key = `${config.companyId}:${deviceKey}:${code}:${target}`;
      findings.push({
        key,
        deviceId: d.id,
        siteId: d.siteId,
        siteName: d.siteName,
        deviceName: d.name,
        identity,
        check,
        code,
        title,
        severity,
        evidence,
        firstSeen:
          (comparable ? previous.findings?.[key]?.firstSeen : null) ??
          snapshot.assessedAt,
        change: comparable
          ? previous.findings?.[key]
            ? "ongoing"
            : "new"
          : "first-assessment",
      });
    };
    if (conn.state === "not-reporting")
      add(
        "connectivity",
        "not-reporting",
        "Device not reporting",
        {
          reason: conn.reason,
          lastHeartbeat: d.status?.lastHeartbeat ?? null,
          lastReading: d.lastReadingAt ?? null,
        },
        "warning",
      );
    checks.connectivity = {
      state: conn.state === "unknown" ? "unavailable" : "assessed",
      reason: conn.reason,
    };
    const rule = config.devices?.[d.id];
    const heartbeatAge = age(now, d.status?.lastHeartbeat);
    const currentStatus =
      heartbeatAge !== null &&
      heartbeatAge >= -CLOCK_SKEW_MINUTES &&
      heartbeatAge <= config.freshnessMinutes &&
      d.status?.staleStatus !== true &&
      !d.errors?.length;
    const status = deviceStatus(
      d.status,
      { ...config.statusDefaults, ...rule },
      currentStatus,
    );
    checks.hardware = {
      state:
        currentStatus && status.assessedCodes.length
          ? "assessed"
          : "unavailable",
      assessedCodes: status.assessedCodes,
      reason: currentStatus
        ? "Only available, configured sensors evaluated"
        : "Hardware flags are last known; heartbeat time unavailable or stale",
    };
    if (currentStatus)
      for (const warning of status.warnings)
        add("hardware", warning.code, warning.title, {
          ...warning.evidence,
          lastHeartbeat: d.status.lastHeartbeat,
        });
    if (!statusOnly(config)) {
      checks.counts = countChecks(d, rule, now, add);
      checks.measurements = measurementChecks(d, rule, now, add);
    }
    const old = previousDevices[deviceKey];
    const transition =
      old?.state === "not-reporting" && conn.state === "reporting"
        ? "recovered"
        : old && old.state === "reporting" && conn.state === "not-reporting"
          ? "new"
          : null;
    devices.push({
      id: d.id,
      siteId: d.siteId,
      siteName: d.siteName,
      name: d.name,
      profile: d.profile,
      identity,
      deviceKey,
      connectivity: conn,
      transition,
      lastReadingAt: d.lastReadingAt ?? null,
      lastHeartbeat: d.status?.lastHeartbeat ?? null,
      checks,
      deviceStatus: status,
    });
  }
  const recovered = [];
  const currentKeys = new Set(findings.map((f) => f.key));
  if (comparable)
    for (const [key, old] of Object.entries(previous.findings ?? {})) {
      const d = devices.find(
        (x) =>
          x.id === old.deviceId &&
          x.identity === old.identity &&
          x.siteId === old.siteId,
      );
      const checked = d?.checks[old.check];
      const exactEvidence =
        old.check === "hardware"
          ? checked?.assessedCodes?.includes(old.code)
          : old.check === "measurements" && old.evidence?.targetKey
            ? checked?.assessedTargetKeys?.includes(old.evidence.targetKey)
            : true;
      if (
        !currentKeys.has(key) &&
        checked?.state === "assessed" &&
        exactEvidence &&
        (old.check !== "connectivity" || d.connectivity.state === "reporting")
      )
        recovered.push({ ...old, recoveredAt: snapshot.assessedAt });
    }
  const totals = {
    reporting: 0,
    "not-reporting": 0,
    "never-reported": 0,
    unknown: 0,
  };
  devices.forEach((d) => totals[d.connectivity.state]++);
  const unverified = comparable
    ? Object.values(previous.findings ?? {}).filter(
        (f) =>
          !currentKeys.has(f.key) && !recovered.some((x) => x.key === f.key),
      )
    : [];
  const report = {
    version: 1,
    sourceProfile: snapshot.sourceProfile ?? "fixture",
    unverified,
    engineVersion: "0.3.51-preview.13",
    monitorId: config.monitorId,
    checks: config.checks ?? "full",
    companyId: config.companyId,
    companyName: snapshot.companyName ?? null,
    configHash,
    assessedAt: snapshot.assessedAt,
    window: snapshot.window,
    inventoryComplete: snapshot.complete === true,
    errors: snapshot.errors ?? [],
    totals,
    devices,
    findings,
    recovered,
    excluded,
  };
  const carried = comparable
    ? Object.fromEntries(
        Object.entries(previous.findings ?? {}).filter(
          ([key]) => !recovered.some((f) => f.key === key),
        ),
      )
    : {};
  const state = {
    monitorId: config.monitorId,
    companyId: config.companyId,
    configHash,
    assessedAt: snapshot.assessedAt,
    devices: {
      ...previousDevices,
      ...Object.fromEntries(
        devices
          .filter((d) => d.connectivity.state !== "unknown")
          .map((d) => [d.deviceKey, { state: d.connectivity.state }]),
      ),
    },
    findings: {
      ...carried,
      ...Object.fromEntries(findings.map((f) => [f.key, f])),
    },
  };
  return { report, state };
}
const sourceLink = (r, id, name) => {
  const url = dataSourceUrl(r, id);
  return url ? `[${safe(name)}](${url})` : safe(name);
};
const safe = (s) =>
  String(s ?? "")
    .replace(/[\r\n<>`]/g, " ")
    .replace(/([\[\]*_])/g, "\\$1");
function ageText(value, at) {
  const n = age(Date.parse(at), value);
  return n === null
    ? "unknown"
    : n < 60
      ? `${Math.max(0, Math.floor(n))}m ago`
      : n < 1440
        ? `${Math.floor(n / 60)}h ago`
        : `${Math.floor(n / 1440)}d ago`;
}
export function markdown(r) {
  const a = attention(r);
  const lines = [
    `# ${statusOnly(r) ? "Device status" : "Health report"} — ${scopeLabel(r)}`,
    `As of ${r.assessedAt} · monitor ${safe(r.monitorId)}`,
    "",
    `**${a.needsCheck} data sources need attention; ${a.counts.long} long-inactive; ${a.counts.unknown} could not check.**`,
  ];
  const rowLine = (x) =>
    `- ${safe(x.siteName)} — ${sourceLink(r, x.id, x.name)} (#${x.id}): **${safe(x.issues.map((f) => f.title).join("; ") || x.reason)}**${(x.downHours ?? x.signalHours) !== null ? `; last signal ${ageLabel(x.downHours ?? x.signalHours)} ago (${safe(x.since)})` : ""}. ${safe(x.statusText)}`;
  for (const [label, rows] of [
    [
      "Needs attention — current alerts and recent reporting loss",
      a.rows.filter((x) => x.needsCheck),
    ],
    [
      "Needs verification — status or reporting evidence incomplete",
      a.rows.filter(
        (x) =>
          !x.needsCheck &&
          ["review", "undated", "unknown", "never"].includes(x.bucket),
      ),
    ],
    [
      `Long-inactive — over ${KNOWN_DAYS} days; confirm relevance`,
      a.rows.filter((x) => x.bucket === "long"),
    ],
  ])
    if (rows.length) lines.push("", `## ${label}`, ...rows.map(rowLine));
  for (const [label, items] of [
    ["Unresolved — current evidence unavailable", r.unverified ?? []],
    ["Recovered", r.recovered ?? []],
  ]) {
    if (items.length)
      lines.push(
        "",
        `## ${label}`,
        ...items.map(
          (f) =>
            `- ${safe(f.siteName)} — ${sourceLink(r, f.deviceId, f.deviceName)} (#${f.deviceId}): ${safe(f.title)}`,
        ),
      );
  }
  lines.push(
    "",
    "## Coverage",
    "",
    `${r.devices.length} data sources: ${r.totals.reporting} reporting, ${r.totals["not-reporting"]} not reporting, ${r.totals["never-reported"]} never reported, ${r.totals.unknown} could not check. Reporting is not proof of overall device health.`,
    "Recency is time since the last available signal, not a proven outage start. Long-inactive sources remain unresolved; age alone does not establish decommissioning.",
    ...(r.inventoryComplete
      ? []
      : ["**Inventory incomplete: this is a partial report.**"]),
    ...(r.errors ?? []).map((e) => `- ${safe(e)}`),
  );
  // A status report states last-known hardware once instead of on every camera.
  const lastKnown = statusOnly(r)
    ? r.devices.filter((d) => d.checks.hardware?.state === "unavailable").length
    : 0;
  if (lastKnown)
    lines.push(
      `Device status is last known for ${lastKnown} of ${r.devices.length} cameras: Zira sent no current heartbeat time, so their values may be out of date.`,
    );
  for (const d of r.devices) {
    const gaps = Object.entries(d.checks).filter(
      ([k, v]) =>
        !["assessed", "not-applicable"].includes(v.state) &&
        !(lastKnown && k === "hardware"),
    );
    if (gaps.length)
      lines.push(
        `- ${safe(d.siteName)} — ${sourceLink(r, d.id, d.name)} (#${d.id}): ${gaps.map(([k, v]) => `${k}: ${v.state} — ${safe(v.reason)}`).join("; ")}`,
      );
  }
  lines.push("", "## Full online-status list");
  const labels = {
    reporting: "Reporting",
    "not-reporting": "Not reporting",
    "never-reported": "Never reported",
    unknown: "Could not check",
  };
  const rank = new Map(a.rows.map((d, i) => [d.id, i]));
  let site;
  for (const d of [...r.devices].sort(
    (a, b) =>
      String(a.siteName).localeCompare(String(b.siteName)) ||
      rank.get(a.id) - rank.get(b.id),
  )) {
    if (site !== d.siteId) {
      site = d.siteId;
      lines.push("", `### ${safe(d.siteName)} (#${d.siteId})`);
    }
    lines.push(
      `- ${sourceLink(r, d.id, d.name)} (#${d.id}) — ${labels[d.connectivity.state]}${d.transition ? " · " + d.transition : ""}; last heartbeat: ${safe(d.lastHeartbeat ?? "unavailable")} (${ageText(d.lastHeartbeat, r.assessedAt)}); last reading: ${safe(d.lastReadingAt ?? "unavailable")} (${ageText(d.lastReadingAt, r.assessedAt)}). ${safe(statusText(d.deviceStatus))}`,
    );
  }
  if (r.excluded.length)
    lines.push(
      "",
      "## Exclusions",
      ...r.excluded.map(
        (d) =>
          `- ${sourceLink(r, d.id, d.name ?? d.id)} (#${safe(d.id)}) — ${safe(d.reason)}`,
      ),
    );
  return lines.join("\n") + "\n";
}
