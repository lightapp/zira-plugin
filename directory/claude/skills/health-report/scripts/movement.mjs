// Dated movement incidents and local review receipts. No device commands or calibration writes.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writePrivate, withLock } from './storage.mjs';
import { dataSourceUrl } from './links.mjs';

const DAY = 86400000;
export const movementCode = code => ['camera-moved', 'camera-bumped'].includes(code);
const positive = n => Number.isSafeInteger(n) && n > 0 && n < 4102444800000;
export function movementJournal(raw) {
  if (!raw || raw.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(raw.journalId ?? '') ||
      !positive(raw.sinceAtEpochMs) || !positive(raw.completeSinceAtEpochMs) ||
      !Number.isSafeInteger(raw.lastObservedAtEpochMs) || raw.lastObservedAtEpochMs < 0 ||
      !Array.isArray(raw.events) || raw.events.length > 64) return null;
  const ids = new Set();
  for (const e of raw.events) {
    if (!Number.isSafeInteger(e.id) || e.id < 1 || ids.has(e.id) || !['bump', 'tilt'].includes(e.kind) ||
        !positive(e.atEpochMs) || typeof e.timeUncertain !== 'boolean') return null;
    ids.add(e.id);
  }
  return { schemaVersion: 1, journalId: raw.journalId, sinceAtEpochMs: raw.sinceAtEpochMs,
    completeSinceAtEpochMs: raw.completeSinceAtEpochMs, lastObservedAtEpochMs: raw.lastObservedAtEpochMs,
    events: raw.events.map(e => ({ id: e.id, kind: e.kind, atEpochMs: e.atEpochMs, timeUncertain: e.timeUncertain })) };
}

export function movementWindow({ from, to, days = 7, now = Date.now() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be 1-30');
  const parse = value => {
    if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new Error('Movement timestamps require ISO dates with an explicit offset');
    return Date.parse(value);
  };
  const end = to === undefined ? now : parse(to);
  const start = from === undefined ? end - days * DAY : parse(from);
  if (start >= end || end - start > 30 * DAY || end > now + 60000) throw new Error('Movement window must be in the past and at most 30 days');
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

export function movementLedgerFile(profile, companyId, home = process.env.ZIRA_HEALTH_REPORTS_HOME ?? path.join(os.homedir(), '.cache', 'zira', 'health-reports')) {
  if (!['prod', 'integ'].includes(profile) || !/^[1-9][0-9]*$/.test(String(companyId))) throw new Error('Invalid movement ledger scope');
  return path.join(home, 'movement-reviews', `${profile}-${companyId}.json`);
}
export async function loadMovementLedger(profile, companyId, home) {
  const ledger = await readJson(movementLedgerFile(profile, companyId, home), { version: 1, profile, companyId: String(companyId), acknowledgements: {} });
  if (ledger.version !== 1 || ledger.profile !== profile || ledger.companyId !== String(companyId) ||
      !ledger.acknowledgements || typeof ledger.acknowledgements !== 'object' || Array.isArray(ledger.acknowledgements) ||
      Object.keys(ledger.acknowledgements).length > 10000) throw new Error('Invalid movement review ledger; preserve it for repair');
  for (const [key, a] of Object.entries(ledger.acknowledgements))
    if (!/^[a-f0-9]{64}$/.test(key) || a?.incidentId !== key || !positive(a.atEpochMs) || !positive(a.acknowledgedAtEpochMs))
      throw new Error('Invalid movement acknowledgement; preserve ledger for repair');
  return ledger;
}

export function reviewMovement(report, state, { ledger = { acknowledgements: {} }, window = movementWindow({ now: Date.parse(report.assessedAt) }) } = {}) {
  const from = Date.parse(window.from), to = Date.parse(window.to);
  const now = Date.parse(report.assessedAt), open = [], acknowledged = [], uncertain = [], older = [], coverageGaps = [], supportedDevices = [];
  const previous = { ...(state?.findings ?? Object.fromEntries(report.findings.map(f => [f.key, f]))) };
  for (const d of report.devices ?? []) {
    const raw = d.deviceStatus?.values?.cameraHealth?.movement;
    const journal = movementJournal(raw);
    const camera = { siteId: d.siteId, deviceId: d.id, site: d.siteName, device: d.name, url: dataSourceUrl(report, d.id) };
    if (!journal) { coverageGaps.push({ ...camera, reason: 'No supported dated movement history; legacy movement flags cannot establish a weekly incident' }); continue; }
    supportedDevices.push(d.deviceKey);
    const healthAt = d.deviceStatus.values.cameraHealth.sampleAtEpochMs;
    if (journal.completeSinceAtEpochMs > from || journal.lastObservedAtEpochMs < to - 600000 ||
        journal.lastObservedAtEpochMs > now + 60000 || !positive(healthAt) || healthAt < to - 600000 || healthAt > now + 60000 ||
        journal.events.some(e => e.atEpochMs > now + 60000))
      coverageGaps.push({ ...camera, reason: 'History starts later, was capped, has a sensor/restart gap, or is stale',
        completeSince: new Date(journal.completeSinceAtEpochMs).toISOString(), lastObservedAtEpochMs: journal.lastObservedAtEpochMs });
    const items = journal.events.map(e => {
      const incidentId = createHash('sha256').update(JSON.stringify([report.sourceProfile, report.companyId, d.siteId, d.id, journal.journalId, e.id])).digest('hex');
      return { ...camera, incidentId, journalId: journal.journalId, eventId: e.id, kind: e.kind, atEpochMs: e.atEpochMs,
        observedAt: new Date(e.atEpochMs).toISOString(), timeUncertain: e.timeUncertain, acknowledgement: ledger.acknowledgements[incidentId] ?? null };
    });
    const inWindow = items.filter(e => e.atEpochMs >= from && e.atEpochMs <= to);
    const pending = inWindow.filter(e => !e.acknowledgement && !e.timeUncertain);
    open.push(...pending); acknowledged.push(...inWindow.filter(e => e.acknowledgement));
    uncertain.push(...inWindow.filter(e => !e.acknowledgement && e.timeUncertain));
    older.push(...items.filter(e => e.atEpochMs < from && !e.acknowledgement));
    d.deviceStatus.movement = { window, incidents: inWindow, olderUnreviewed: items.filter(e => e.atEpochMs < from && !e.acknowledgement).length };
    // Keep the physical flag visible as evidence, but derive attention from dated, unreviewed incidents.
    d.deviceStatus.warnings = (d.deviceStatus.warnings ?? []).filter(w => !movementCode(w.code));
    for (const e of inWindow.filter(e => !e.acknowledgement)) {
      const code = e.kind === 'bump' ? 'camera-bumped' : 'camera-moved';
      const title = `${e.kind === 'bump' ? 'Camera bump' : 'Camera position change'} observed ${e.observedAt}${e.timeUncertain ? '; occurrence time unknown after a gap' : ''}`;
      const evidence = { incidentId: e.incidentId, atEpochMs: e.atEpochMs, timeUncertain: e.timeUncertain };
      d.deviceStatus.warnings.push({ code, title, evidence });
    }
    // A review or elapsed reporting window is not physical recovery.
    const belongs = f => f.deviceId === d.id && f.siteId === d.siteId && movementCode(f.code);
    report.findings = report.findings.filter(f => !belongs(f));
    report.unverified = (report.unverified ?? []).filter(f => !belongs(f));
    report.recovered = (report.recovered ?? []).filter(f => !belongs(f));
    if (state) for (const [key, f] of Object.entries(state.findings ?? {})) if (belongs(f)) delete state.findings[key];
    if (d.deviceStatus.freshness === 'current') for (const w of d.deviceStatus.warnings.filter(w => movementCode(w.code))) {
      const key = `${report.companyId}:${d.deviceKey}:${w.code}:${w.evidence.incidentId}`;
      const f = { key, deviceId: d.id, siteId: d.siteId, siteName: d.siteName, deviceName: d.name, identity: d.identity,
        check: 'hardware', code: w.code, title: w.title, severity: 'warning', evidence: w.evidence,
        firstSeen: previous[key]?.firstSeen ?? report.assessedAt,
        change: state ? (previous[key] ? 'ongoing' : 'new') : (previous[key]?.change ?? 'new') };
      report.findings.push(f); if (state) state.findings[key] = f;
    }
  }
  const sort = a => a.sort((x, y) => y.atEpochMs - x.atEpochMs);
  report.movement = { window, open: sort(open), acknowledged: sort(acknowledged), uncertain: sort(uncertain), olderUnreviewed: sort(older),
    coverageGaps, supportedDevices, acknowledgementScope: 'This computer; shared by local plugin checks and monitors. Does not acknowledge cloud notifications or recalibrate devices.' };
  return report.movement;
}

export async function acknowledgeMovement({ report, incidentIds, profile, companyId, note, apply = false, home, now = Date.now() }) {
  if (report.sourceProfile !== profile || report.companyId !== String(companyId)) throw new Error('Report scope/profile mismatch');
  if (!Array.isArray(incidentIds) || !incidentIds.length || incidentIds.length > 100 || new Set(incidentIds).size !== incidentIds.length)
    throw new Error('Select 1-100 exact incident IDs from the report');
  if (typeof note !== 'string' || !note.trim() || note.length > 500) throw new Error('Supply a review note (1-500 characters)');
  const available = [...(report.movement?.open ?? []), ...(report.movement?.uncertain ?? []), ...(report.movement?.olderUnreviewed ?? []), ...(report.movement?.acknowledged ?? [])];
  const chosen = incidentIds.map(id => {
    const incident = available.find(e => e.incidentId === id);
    if (!incident || !positive(incident.atEpochMs) || incident.atEpochMs > now) throw new Error('Incident is not in the reviewed report');
    return incident;
  });
  const result = { kind: 'movement-acknowledgement', applied: false, scope: 'local-computer', incidents: chosen, note: note.trim(),
    effect: 'These exact incidents stop appearing as unreviewed. New incident IDs still alert. History and calibration remain intact.' };
  if (!apply) return result;
  const file = movementLedgerFile(profile, companyId, home);
  return withLock(`${file}.lock`, async () => {
    const ledger = await loadMovementLedger(profile, companyId, home);
    // Receipt retention exceeds the device journal; do not evict current acknowledgements to meet the cap.
    for (const [key, a] of Object.entries(ledger.acknowledgements)) if (now - a.atEpochMs > 90 * DAY) delete ledger.acknowledgements[key];
    for (const e of chosen) ledger.acknowledgements[e.incidentId] ??= { incidentId: e.incidentId, atEpochMs: e.atEpochMs,
      acknowledgedAtEpochMs: now, siteId: e.siteId, deviceId: e.deviceId, journalId: e.journalId, eventId: e.eventId, note: note.trim() };
    if (Object.keys(ledger.acknowledgements).length > 10000) throw new Error('Local acknowledgement capacity reached; no changes saved');
    await writePrivate(file, ledger);
    const saved = await loadMovementLedger(profile, companyId, home);
    if (chosen.some(e => !saved.acknowledgements[e.incidentId])) throw new Error('Acknowledgement readback failed');
    return { ...result, applied: true, ledger: file };
  });
}
