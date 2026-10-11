// Pure text for the Zira Device Status band, pane, status line and toasts.
// No engine or Node APIs, so node --test covers it directly.

const MIN = 60000;

export const REFRESH_MS = 10 * MIN;

export function ago(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 100);

// Merely installing the mod must not read the fleet. Manual refresh is separate.
export function startFleetRefresh(clock, refresh, enabled = false) {
  if (enabled !== true) return;
  clock.after(1, () => void refresh());
  clock.every(REFRESH_MS, () => void refresh());
}

export function fleetArgs(options = {}) {
  const args = ["--max-devices", "40"];
  const company = clean(options.default_company), site = clean(options.default_site);
  // Plugin settings are per install (zira@zira, a --plugin-dir copy, …), so they only
  // fill in when the account has no saved default scope; see scripts/fleet.mjs.
  if (company) args.push("--fallback-company", company);
  if (site) args.push("--fallback-site", site);
  return args;
}

// The script's JSON, or a failure the band can show. Never throws.
export function parseFleet({ exitCode, stdout = "", stderr = "" } = {}) {
  try {
    const r = JSON.parse(stdout);
    if (r && typeof r === "object" && typeof r.ok === "boolean" && (r.ok ? Array.isArray(r.devices) : typeof r.message === "string")) return r;
  } catch {}
  return { ok: false, needs: "error", message: clean(stderr) || `Device status failed (exit ${exitCode ?? "unknown"})` };
}

const offFor = (d, now) => (d.since && Number.isFinite(Date.parse(d.since)) ? now - Date.parse(d.since) : d.hours != null ? d.hours * 3600000 : null);

// One device row: marker, tone (alert | warn | dim | normal) and text.
export function deviceLine(d, now) {
  if (d.currentAlerts?.length) return { marker: "!", tone: "alert", text: `${d.state} · ${d.currentAlerts.map(w => clean(w.title)).join("; ")}` };
  if (d.state === "online") {
    const signal = d.lastSignal && Number.isFinite(Date.parse(d.lastSignal)) ? ` · last signal ${ago(now - Date.parse(d.lastSignal))} ago` : "";
    if (d.statusFreshness === "Last known" && d.statusWarnings?.length)
      return { marker: "?", tone: "warn", text: `online${signal} · verify last-known status` };
    return { marker: "○", tone: "dim", text: `online${signal}` };
  }
  if (d.state === "never") return { marker: "–", tone: "dim", text: "never reported" };
  if (d.state === "unknown") return { marker: "?", tone: "warn", text: `status unknown · ${clean(d.reason)}` };
  const off = offFor(d, now);
  const age = off === null ? "offline, age unknown" : `offline ${ago(off)}`;
  if (d.bucket === "new") return { marker: "●", tone: "alert", text: `${age} · new, check first` };
  if (d.bucket === "recent") return { marker: "●", tone: "warn", text: `${age} · check next` };
  if (d.bucket === "long") return { marker: "●", tone: "dim", text: `${age} · long offline, confirm it still matters` };
  return { marker: "●", tone: "warn", text: age };
}

// One pane table row: status, last seen and the few hardware values worth reading.
// Normal values (power on, camera on, no movement, no error, unused links) stay out;
// warnings go to notes. Ages are "seen X ago", never a claimed outage start.
// markLastKnown labels last-known rows when the site mixes current and last-known status.
export function paneRow(d, now, markLastKnown = false) {
  const signal = d.lastSignal && Number.isFinite(Date.parse(d.lastSignal)) ? now - Date.parse(d.lastSignal) : offFor(d, now);
  const alerts = (d.currentAlerts ?? []).map(w => clean(w.title));
  let dot = "🟢", status = "Online";
  if (alerts.length) [dot, status] = ["🔴", "Alert"];
  else if (d.state === "never") [dot, status] = ["⚪", "Never reported"];
  else if (d.state === "unknown") [dot, status] = ["🟡", "Unknown"];
  else if (d.state === "offline")
    [dot, status] = d.bucket === "new" ? ["🔴", "Offline · new"] : d.bucket === "long" ? ["⚪", "Offline · long"] : ["🟠", "Offline"];
  const row = { status: `${dot} ${status}`, seen: signal === null ? "—" : `${ago(signal)} ago`, battery: "—", temp: "—", network: "—", notes: [...alerts] };
  if ((d.statusFreshness ?? "Unavailable") === "Unavailable") row.notes.push("no device status");
  const flagged = i => i.tone === "alert" || i.tone === "review";
  for (const i of [...(d.indicators?.power ?? []), ...(d.indicators?.camera ?? [])]) {
    const label = clean(i.label);
    if (/%$/.test(label)) row.battery = `${label.replace(/^▱ /, "")}${flagged(i) ? " ⚠" : ""}`;
    else if (label.startsWith("♨")) row.temp = `${label.replace(/^♨ /, "").replace(/ \?$/, "")}${flagged(i) ? " ⚠" : ""}`;
    else if (!QUIET.has(label) || flagged(i)) row.notes.push(label);
  }
  // Wi-Fi, Cell and LAN collapse into the connected links, or "none".
  const network = d.indicators?.network ?? [];
  const links = network.filter(i => clean(i.label).endsWith("✓")).map(i => clean(i.label).replace(/ ✓$/, ""));
  if (network.length) row.network = links.length ? links.join(" + ") : `none${network.some(flagged) ? " ⚠" : ""}`;
  if (d.statusFreshness !== "Current" && d.statusWarnings?.length) row.notes.push(`verify: ${d.statusWarnings.map(w => clean(w.title)).join("; ")}`);
  if (markLastKnown && d.statusFreshness === "Last known") row.notes.push("last known");
  row.notes = [...new Set(row.notes.filter(n => !alerts.length || !n.startsWith("!")))];
  return row;
}

const QUIET = new Set(["⏻ On", "◉ On", "↔ No movement", "No error"]);

const cell = value => clean(value).replace(/\s+/g, " ").replace(/[\\|*_`[\]<>#~]/g, c => `\\${c}`) || "—";

// The pane's device table as Markdown, which every surface draws with real rows and columns.
// Empty columns (no temperatures, no notes) are dropped.
export function paneTable(fleet, now) {
  const mixed = fleet.counts.lastKnown > 0 && fleet.counts.lastKnown < fleet.counts.total;
  const rows = fleet.devices.map(d => ({ d, ...paneRow(d, now, mixed) }));
  const columns = [
    ["Device", r => (/^https:\/\//.test(r.d.url ?? "") ? `[${cell(r.d.name)}](${encodeURI(r.d.url)})` : cell(r.d.name))],
    ["Status", r => cell(r.status)],
    ["Last seen", r => cell(r.seen)],
    ["Battery", r => cell(r.battery)],
    ["Temp", r => cell(r.temp)],
    ["Network", r => cell(r.network)],
    ["Notes", r => cell(r.notes.join("; "))],
  ].filter(([name, get]) => name === "Device" || name === "Status" || rows.some(r => get(r) !== "—"));
  return [
    `| ${columns.map(([name]) => name).join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows.map(r => `| ${columns.map(([, get]) => get(r)).join(" | ")} |`),
  ].join("\n");
}

// Pane subtitle: counts and when it was checked.
export function paneCounts(fleet, now) {
  const c = fleet.counts;
  return [
    `${c.online}/${c.total} online`,
    c.offline && `${c.offline} offline${c.newOffline ? ` (${c.newOffline} new)` : ""}`,
    c.unknown && `${c.unknown} unknown`,
    c.never && `${c.never} never reported`,
    c.currentAlerts && `${c.currentAlerts} with alerts`,
    `checked ${ago(now - Date.parse(fleet.assessedAt))} ago`,
  ].filter(Boolean).join(" · ");
}

// One footnote for what the markers and hardware values mean, only when it applies.
export function paneNote(fleet) {
  const c = fleet.counts, notes = [];
  if (c.unknown) notes.push(`Unknown: no heartbeat in ${fleet.freshnessMinutes} min`);
  if (c.lastKnown) notes.push(`battery, temperature and network are last known${c.lastKnown < c.total ? ` for ${c.lastKnown} of ${c.total}` : ""}, not verified`);
  if (!fleet.complete) notes.push(fleet.omitted ? `${fleet.omitted} data sources not read` : "some data sources could not be read");
  return notes.join(" · ");
}

const NEEDS = {
  "sign-in": "sign in to see device status (say \"get started\")",
  company: "choose a default company and site (say \"set my default Zira site\")",
  site: "choose a default site (say \"set my default Zira site\")",
};

// Status line and band text for a fleet result.
export function summary(fleet, now) {
  if (!fleet) return { status: "Zira · checking devices…", band: "Device Status · checking devices…", tone: "dim" };
  if (!fleet.ok) {
    const hint = NEEDS[fleet.needs] ?? `couldn't check devices: ${clean(fleet.message)}`;
    return { status: `Zira · ${fleet.needs === "sign-in" ? "not signed in" : "device status unavailable"}`, band: `Device Status · ${hint}`, tone: "dim" };
  }
  const { counts, site } = fleet;
  const siteName = clean(site.name);
  const checked = `checked ${ago(now - Date.parse(fleet.assessedAt))} ago`;
  const partial = fleet.complete ? "" : " · partial";
  if (!counts.total) return { status: `Zira · ${siteName} · no cameras`, band: `Device Status · ${siteName} · no cameras · ${checked}${partial}`, tone: "dim" };
  if (counts.currentAlerts) {
    const first = fleet.devices.find(d => d.currentAlerts?.length);
    return { status: `Zira · ${siteName} · ${counts.currentAlerts} with current alerts · ${counts.offline} offline`,
      band: `Device Status · ${siteName} · ${counts.currentAlerts} with current alerts${first ? ` · ${clean(first.name)}: ${first.currentAlerts.map(w => clean(w.title)).join("; ")}` : ""} · ${checked}${partial}`,
      tone: "alert" };
  }
  const down = fleet.devices.filter(d => d.state === "offline");
  if (!down.length) {
    const extra = [counts.unknown && `${counts.unknown} unknown`, counts.never && `${counts.never} never reported`].filter(Boolean).join(", ");
    return {
      status: `Zira · ${siteName} · ${counts.online}/${counts.total} online`,
      band: `Device Status · ${siteName} · ${counts.online === counts.total ? "all " : ""}${counts.online} online${extra ? ` · ${extra}` : ""}${counts.lastKnown ? ` · ${counts.lastKnown} last known` : ""} · ${checked}${partial}`,
      tone: "dim",
    };
  }
  const worst = down[0];
  const line = deviceLine(worst, now);
  const more = down.length > 1 ? ` (+${down.length - 1} more offline)` : "";
  return {
    status: `Zira · ${siteName} · ${down.length} offline${counts.newOffline ? ` (${counts.newOffline} new)` : ""}`,
    band: `Device Status · ${siteName} · ${clean(worst.name)} ${line.text}${more} · ${checked}${partial}`,
    tone: counts.newOffline ? "alert" : "dim",
  };
}

// Toast lines for devices that changed between two results of the same site.
export function changes(previous, next) {
  if (!previous?.ok || !next?.ok || previous.site.id !== next.site.id) return [];
  const before = new Map(previous.devices.map(d => [d.id, d.state]));
  const out = [];
  for (const d of next.devices) {
    const was = before.get(d.id);
    if (was === "online" && d.state === "offline") out.push(`Zira: ${clean(d.name)} went offline`);
    if (was === "offline" && d.state === "online") out.push(`Zira: ${clean(d.name)} is back online`);
  }
  return out.length > 3 ? [`Zira: ${out.length} data sources changed status at ${clean(next.site.name)}`] : out;
}
