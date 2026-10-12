// Pure state and text for the Zira Live panel: it reads `scripts/remote.mjs watch --jsonl`
// lines and draws counts, status and a short trend. No engine or Node APIs.

import { clean } from "./fleet-view.mjs";

export const LIVE_MINUTES = 10;
const MAX_POINTS = 120;
const IDENTITY = /^[a-z]{2}(-[a-z]+)+-\d:[0-9a-f-]{36}$/;
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The model's or command's request, checked before anything runs.
export function liveTarget(input = {}) {
  const deviceId = String(input.dataSourceId ?? input.deviceId ?? "").trim();
  if (!/^[1-9]\d{0,11}$/.test(deviceId)) throw new Error("dataSourceId must be a Zira data source ID");
  const identity = input.identity ? String(input.identity).trim() : null;
  if (identity && !IDENTITY.test(identity)) throw new Error("identity must be a camera identity such as us-west-2:…");
  const minutes = input.minutes === undefined ? LIVE_MINUTES : Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error("minutes must be 1 to 60");
  const profile = input.profile === "integ" ? "integ" : "prod";
  return { deviceId, identity, minutes, profile };
}

export function liveArgs(t) {
  return ["--device-id", t.deviceId, ...(t.identity ? ["--identity", t.identity] : []), "--seconds", String(t.minutes * 60), "--jsonl", "--profile", t.profile];
}

export function startLive(target, now) {
  return { target, dataSource: null, camera: target.identity, liveUrl: null, state: "connecting", message: null,
    latest: null, points: [], messages: 0, startedAt: now, endsAt: now + target.minutes * 60000 };
}

const values = obj => obj && typeof obj === "object"
  ? Object.fromEntries(Object.entries(obj).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)).slice(0, 12)
    .map(([k, v]) => [clean(k), typeof v === "string" ? clean(v) : v]))
  : {};

// Folds one JSONL line from the watcher into the panel state; anything unreadable is ignored.
export function reduceLive(state, line) {
  let m;
  try { m = JSON.parse(line); } catch { return state; }
  if (!state || !m || typeof m !== "object") return state;
  if (m.type === "start")
    return { ...state, dataSource: { id: clean(m.dataSource?.id), name: clean(m.dataSource?.name), site: clean(m.dataSource?.site) },
      camera: clean(m.camera) || state.camera, liveUrl: typeof m.liveUrl === "string" && /^https?:\/\//.test(m.liveUrl) ? m.liveUrl : null,
      state: "waiting" };
  if (m.type === "live") {
    const latest = { at: typeof m.at === "string" ? m.at : null, status: m.status ? clean(m.status) : null, units: num(m.units),
      shiftCount: num(m.shiftCount), trigger: m.trigger ? clean(m.trigger) : null, values: values(m.lastReading?.values) };
    const points = [...state.points, { at: latest.at ?? new Date().toISOString(), units: latest.units, shiftCount: latest.shiftCount }].slice(-MAX_POINTS);
    return { ...state, state: "live", latest, points, messages: state.messages + 1 };
  }
  if (m.type === "end") return { ...state, state: "ended" };
  if (m.type === "error") return { ...state, state: "error", message: clean(m.message) || "Live data stopped", liveUrl: state.liveUrl ?? (typeof m.liveUrl === "string" ? m.liveUrl : null) };
  return state;
}

export const endLive = state => (state && !["error", "ended"].includes(state.state) ? { ...state, state: "ended" } : state);
export const failLive = (state, message) => (state ? { ...state, state: "error", message: clean(message) } : state);

const BARS = "▁▂▃▄▅▆▇█";
// A text trend of a counter (terminal); each point is the change since the previous one.
export function sparkline(points, key = "units", width = 40) {
  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1][key], b = points[i][key];
    if (a !== null && b !== null) deltas.push(Math.max(0, b - a));
  }
  const shown = deltas.slice(-width);
  if (!shown.length) return "";
  const max = Math.max(...shown, 1);
  return shown.map(d => BARS[Math.min(7, Math.round((d / max) * 7))]).join("");
}

// The same trend as a small SVG for surfaces that draw one; colors follow the theme's text color.
export function trendSvg(points, key = "units", width = 320, height = 56) {
  const series = points.filter(p => p[key] !== null);
  if (series.length < 2) return null;
  const t0 = Date.parse(series[0].at), t1 = Date.parse(series.at(-1).at);
  const lo = Math.min(...series.map(p => p[key])), hi = Math.max(...series.map(p => p[key]), lo + 1);
  const x = p => (t1 > t0 ? ((Date.parse(p.at) - t0) / (t1 - t0)) * (width - 8) + 4 : 4);
  const y = p => height - 6 - ((p[key] - lo) / (hi - lo)) * (height - 12);
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<circle cx="${x(series.at(-1)).toFixed(1)}" cy="${y(series.at(-1)).toFixed(1)}" r="2.5" fill="currentColor"/></svg>`;
}

const secondsAgo = (at, now) => (at && Number.isFinite(Date.parse(at)) ? Math.max(0, Math.round((now - Date.parse(at)) / 1000)) : null);

export function liveHeadline(state, now) {
  if (!state) return "No camera selected. Ask Claude to open the live panel for a camera.";
  const left = Math.max(0, Math.ceil((state.endsAt - now) / 60000));
  if (state.state === "connecting") return "Connecting to the camera…";
  if (state.state === "waiting") return "Waiting for live data from the camera…";
  if (state.state === "error") return state.message ?? "Live data stopped.";
  const age = secondsAgo(state.latest?.at, now);
  const fresh = age === null ? "" : age < 90 ? `updated ${age} s ago` : `last update ${Math.round(age / 60)} min ago`;
  if (state.state === "ended") return `Stopped${fresh ? ` · ${fresh}` : ""}.`;
  return `Live · ${fresh || "waiting for the next update"} · ${left} min left`;
}

// Current values as a Markdown table: counts first, then the last reading's fields.
export function liveTable(state) {
  const l = state?.latest;
  if (!l) return "";
  const first = state.points.find(p => p.units !== null), change = l.units !== null && first ? l.units - first.units : null;
  const rows = [["Status", l.status ?? "—"], ["Units", l.units ?? "—"], ["Shift count", l.shiftCount ?? "—"],
    ...(change !== null ? [["Units since panel opened", change >= 0 ? `+${change}` : change]] : []),
    ...Object.entries(l.values).map(([k, v]) => [k, v === null ? "—" : String(v)])];
  const cell = v => String(v).replace(/\|/g, "\\|");
  return ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`)].join("\n");
}
