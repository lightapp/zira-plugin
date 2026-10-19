import { dataSourceUrl } from "./links.mjs";
const booleanFields = [
  "onLine",
  "staleStatus",
  "isCharging",
  "cameraMoved",
  "cameraOn",
  "deviceOn",
  "wifiConnected",
  "cellularConnected",
  "ethernetConnected",
  "exceptionReported",
];
export function statusValues(raw = {}) {
  raw ??= {};
  const values = {};
  for (const key of booleanFields)
    if (typeof raw[key] === "boolean") values[key] = raw[key];
  if (Number.isFinite(raw.battery) && raw.battery >= 0 && raw.battery <= 100)
    values.battery = raw.battery;
  if (Number.isFinite(raw.temperature)) values.temperature = raw.temperature;
  if (["C", "F", "K"].includes(raw.temperatureUnit))
    values.temperatureUnit = raw.temperatureUnit;
  return values;
}
export function deviceStatus(raw, rule, current) {
  const values = statusValues(raw),
    warnings = [],
    assessedCodes = [];
  const check = (code, available, bad, title, evidence = {}) => {
    if (!available) return;
    assessedCodes.push(code);
    if (bad) warnings.push({ code, title, evidence });
  };
  for (const [key, bad, code, title] of [
    ["cameraMoved", true, "camera-moved", "Camera reports movement"],
    ["cameraOn", false, "camera-off", "Camera reports off"],
    ["deviceOn", false, "device-off", "Device reports power off"],
    ["exceptionReported", true, "device-exception", "Device reports an error"],
  ])
    check(code, typeof values[key] === "boolean", values[key] === bad, title);
  const links = [
    values.wifiConnected,
    values.cellularConnected,
    values.ethernetConnected,
  ];
  check(
    "network-disconnected",
    links.every((x) => typeof x === "boolean"),
    links.every((x) => x === false),
    "No network interface reports connected",
  );
  check(
    "low-battery",
    Number.isFinite(rule?.batteryMinimum) &&
      Number.isFinite(values.battery) &&
      typeof values.isCharging === "boolean",
    values.battery < rule?.batteryMinimum && values.isCharging === false,
    "Battery below configured threshold",
    { battery: values.battery, threshold: rule?.batteryMinimum },
  );
  check(
    "high-temperature",
    Number.isFinite(rule?.temperatureMaximum) &&
      Number.isFinite(values.temperature) &&
      !!values.temperatureUnit &&
      rule?.temperatureUnit === values.temperatureUnit,
    values.temperature > rule?.temperatureMaximum,
    "Temperature above configured threshold",
    {
      temperature: values.temperature,
      unit: values.temperatureUnit,
      threshold: rule?.temperatureMaximum,
    },
  );
  return {
    freshness: current ? "current" : "last-known",
    values,
    warnings,
    assessedCodes: current ? assessedCodes : [],
  };
}
export function statusText(status) {
  if (!status || !Object.keys(status.values ?? {}).length)
    return "Device status unavailable";
  const v = status.values,
    parts = [];
  if (Number.isFinite(v.battery)) parts.push(`Battery ${v.battery}%`);
  if (typeof v.isCharging === "boolean")
    parts.push(v.isCharging ? "charging" : "not charging");
  if (Number.isFinite(v.temperature))
    parts.push(
      `Temperature ${v.temperature}${v.temperatureUnit ? `°${v.temperatureUnit}` : " (unit unavailable)"}`,
    );
  for (const [key, label, yes, no] of [
    ["onLine", "Connection", "online", "offline"],
    ["wifiConnected", "Wi-Fi", "connected", "disconnected"],
    ["cellularConnected", "Cellular", "connected", "disconnected"],
    ["ethernetConnected", "Ethernet", "connected", "disconnected"],
    ["cameraOn", "Camera", "on", "off"],
    ["cameraMoved", "Camera movement", "reported", "not reported"],
    ["deviceOn", "Power", "on", "off"],
    ["exceptionReported", "Device error", "reported", "not reported"],
  ])
    if (typeof v[key] === "boolean")
      parts.push(`${label}: ${v[key] ? yes : no}`);
  if (v.staleStatus === true) parts.push("backend marks status stale");
  return `${status.freshness === "current" ? "Current status" : "Last known status — freshness unverified"}: ${parts.join("; ")}`;
}

export function statusIndicators(status) {
  const v = status?.values ?? {};
  const warnings = new Set((status?.warnings ?? []).map((w) => w.code));
  const current = status?.freshness === "current";
  const groups = { power: [], network: [], camera: [] };
  const add = (group, label, detail, code, dim = false) => groups[group].push({
    label, title: `${current ? "Current" : "Last known, freshness unverified"}: ${detail}`,
    tone: warnings.has(code) ? (current ? "alert" : "review") : dim ? "dim" : "neutral",
  });
  if (Number.isFinite(v.battery)) add("power", `${v.isCharging === true ? "⚡" : "▱"} ${v.battery}%`, `Battery ${v.battery}%; ${v.isCharging === true ? "charging" : v.isCharging === false ? "not charging" : "charging status unavailable"}`, "low-battery");
  else if (typeof v.isCharging === "boolean") add("power", v.isCharging ? "⚡ Charging" : "Not charging", v.isCharging ? "Charging" : "Not charging");
  if (Number.isFinite(v.temperature)) {
    const unit = ["C", "F", "K"].includes(v.temperatureUnit) ? v.temperatureUnit : null;
    const value = `${v.temperature}${unit === "K" ? " K" : unit ? `°${unit}` : " ?"}`;
    add("power", `♨ ${value}`, `Temperature ${value}${unit ? "" : "; unit unavailable"}`, "high-temperature");
  }
  if (typeof v.deviceOn === "boolean") add("power", `⏻ ${v.deviceOn ? "On" : "Off"}`, `Power ${v.deviceOn ? "on" : "off"}`, "device-off");
  for (const [key, label] of [["wifiConnected", "Wi-Fi"], ["cellularConnected", "Cell"], ["ethernetConnected", "LAN"]])
    if (typeof v[key] === "boolean") add("network", `${label} ${v[key] ? "✓" : "—"}`, `${label}: ${v[key] ? "connected" : "disconnected"}`, "network-disconnected", !v[key]);
  if (typeof v.cameraOn === "boolean") add("camera", `◉ ${v.cameraOn ? "On" : "Off"}`, `Camera ${v.cameraOn ? "on" : "off"}`, "camera-off");
  if (typeof v.cameraMoved === "boolean") add("camera", v.cameraMoved ? "↔ Moved" : "↔ No movement", `Camera movement ${v.cameraMoved ? "reported" : "not reported"}`, "camera-moved", !v.cameraMoved);
  if (typeof v.exceptionReported === "boolean") add("camera", v.exceptionReported ? "! Error" : "No error", `Device error ${v.exceptionReported ? "reported" : "not reported"}`, "device-exception", !v.exceptionReported);
  return groups;
}

// Each data source's status warnings, keyed so a scheduled run can tell new ones from old.
export function statusWarnings(report) {
  return (report.devices ?? []).flatMap((d) =>
    (d.deviceStatus?.warnings ?? []).map((w) => ({
      key: `${d.deviceKey ?? `${d.siteId}:${d.id}`}:${w.code}`,
      code: w.code,
      title: w.title,
      freshness: d.deviceStatus.freshness,
      reporting: d.connectivity?.state === "reporting",
      site: d.siteName,
      device: String(d.name ?? d.id).trim(),
      id: d.id,
      url: dataSourceUrl(report, d.id),
    })),
  );
}
