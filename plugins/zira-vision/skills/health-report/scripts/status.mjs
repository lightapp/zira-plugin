import { movementJournal } from "./movement.mjs";
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
  "externalPowerConnected",
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
  if (raw.storage && typeof raw.storage === "object") values.storage = storageValues(raw.storage);
  if (raw.cameraHealth?.schemaVersion === 1) {
    const h = raw.cameraHealth, out = { schemaVersion: 1 };
    for (const key of ["sampleAtEpochMs", "lastViewAtEpochMs", "lastUploadAtEpochMs"])
      if (Number.isSafeInteger(h[key]) && h[key] >= 0) out[key] = h[key];
    for (const key of ["cameraMoved", "externalPowerConnected", "wifiConnected", "ethernetConnected", "cellularConnected", "recentBump"])
      if (typeof h[key] === "boolean") out[key] = h[key];
    if (h.storage && typeof h.storage === "object") out.storage = storageValues(h.storage);
    if (h.movement !== undefined) out.movement = movementJournal(h.movement);
    values.cameraHealth = out;
  }
  return values;
}
function storageValues(raw) {
  const out = {};
  for (const key of ["freeBytes", "totalBytes", "appBytes", "appCodeBytes", "appDataBytes", "appCacheBytes", "sampleAtEpochMs"])
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) out[key] = raw[key];
  return out;
}
export function deviceStatus(raw, rule, current, now = Date.now()) {
  const values = statusValues(raw),
    warnings = [],
    assessedCodes = [];
  const health = raw?.cameraHealth;
  const age = now - health?.sampleAtEpochMs;
  const healthFresh = health?.schemaVersion === 1 && Number.isFinite(age) && age >= -60_000 && age <= 600_000;
  // Once this protocol is advertised, legacy defaults must not fill missing sensor evidence.
  if (health?.schemaVersion === 1) for (const key of ["cameraMoved", "externalPowerConnected", "wifiConnected", "ethernetConnected", "cellularConnected", "recentBump"])
    delete values[key];
  if (healthFresh) for (const key of ["cameraMoved", "externalPowerConnected", "wifiConnected", "ethernetConnected", "cellularConnected", "recentBump"])
    if (typeof health[key] === "boolean") values[key] = health[key];
  const storage = raw?.storage ?? (healthFresh ? health?.storage : null);
  const storageAge = now - storage?.sampleAtEpochMs;
  const storageFresh = Number.isFinite(storageAge) && storageAge >= -60_000 && storageAge <= 600_000;
  if (storage && typeof storage === "object") {
    values.storage = {};
    for (const key of ["freeBytes", "totalBytes", "appBytes", "appCodeBytes", "appDataBytes", "appCacheBytes", "sampleAtEpochMs"])
      if (Number.isSafeInteger(storage[key]) && storage[key] >= 0) values.storage[key] = storage[key];
    values.storage.freshness = current && storageFresh ? "current" : "last-known";
  }
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
    ["externalPowerConnected", false, "external-power-lost", "External power disconnected"],
    ["recentBump", true, "camera-bumped", "Camera reports a recent bump; inspect the mount"],
  ])
    check(code, typeof values[key] === "boolean", values[key] === bad, title);
  const links = [
    values.wifiConnected,
    values.cellularConnected,
    values.ethernetConnected,
  ];
  check(
    "cellular-only",
    links.every((x) => typeof x === "boolean"),
    values.cellularConnected === true && values.wifiConnected === false && values.ethernetConnected === false,
    "Cellular only; no Wi-Fi or Ethernet connected",
  );
  check(
    "low-storage",
    storageFresh && Number.isSafeInteger(values.storage?.freeBytes) && values.storage.freeBytes >= 0,
    values.storage?.freeBytes < 10 * 1024 ** 3,
    "Device storage below 10 GiB",
    { freeBytes: values.storage?.freeBytes, sampleAtEpochMs: values.storage?.sampleAtEpochMs },
  );
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
  if (typeof v.externalPowerConnected === "boolean") parts.push(`External power: ${v.externalPowerConnected ? "connected" : "disconnected"}`);
  if (v.storage) {
    const gib = x => Number.isSafeInteger(x) ? `${(x / 1024 ** 3).toFixed(1)} GiB` : "unavailable";
    parts.push(`Storage (${v.storage.freshness}): ${gib(v.storage.freeBytes)} free; app ${gib(v.storage.appBytes)}`);
  }
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
  if (typeof v.externalPowerConnected === "boolean") add("power", v.externalPowerConnected ? "Plugged in" : "Unplugged", "External power connection", "external-power-lost");
  if (Number.isSafeInteger(v.storage?.freeBytes)) add("power", `${(v.storage.freeBytes / 1024 ** 3).toFixed(1)} GiB free`, `Storage ${v.storage.freshness}; app ${Number.isSafeInteger(v.storage.appBytes) ? (v.storage.appBytes / 1024 ** 3).toFixed(1) + " GiB" : "usage unavailable"}`, "low-storage");
  if (warnings.has("cellular-only")) add("network", "Cellular only", "No Wi-Fi or Ethernet connected", "cellular-only");
  for (const [key, label] of [["wifiConnected", "Wi-Fi"], ["cellularConnected", "Cell"], ["ethernetConnected", "LAN"]])
    if (typeof v[key] === "boolean") add("network", `${label} ${v[key] ? "✓" : "—"}`, `${label}: ${v[key] ? "connected" : "disconnected"}`, "network-disconnected", !v[key]);
  if (typeof v.cameraOn === "boolean") add("camera", `◉ ${v.cameraOn ? "On" : "Off"}`, `Camera ${v.cameraOn ? "on" : "off"}`, "camera-off");
  if (status?.movement) add("camera", `${status.movement.incidents.filter(e => !e.acknowledgement).length} unreviewed movement incidents`, "Dated movement history; acknowledgement is not calibration", warnings.has("camera-bumped") ? "camera-bumped" : "camera-moved");
  else if (typeof v.cameraMoved === "boolean") add("camera", v.cameraMoved ? "↔ Moved" : "↔ No movement", `Camera movement ${v.cameraMoved ? "reported" : "not reported"}`, "camera-moved", !v.cameraMoved);
  if (typeof v.exceptionReported === "boolean") add("camera", v.exceptionReported ? "! Error" : "No error", `Device error ${v.exceptionReported ? "reported" : "not reported"}`, "device-exception", !v.exceptionReported);
  return groups;
}

// Each data source's status warnings, keyed so a scheduled run can tell new ones from old.
export function statusWarnings(report) {
  return (report.devices ?? []).flatMap((d) =>
    (d.deviceStatus?.warnings ?? []).map((w) => ({
      key: `${d.deviceKey ?? `${d.siteId}:${d.id}`}:${w.code}${w.evidence?.incidentId ? ":" + w.evidence.incidentId : ""}`,
      deviceKey: d.deviceKey,
      incidentId: w.evidence?.incidentId,
      atEpochMs: w.evidence?.atEpochMs,
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
