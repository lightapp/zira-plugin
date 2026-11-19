// Shared camera review receipts and private daily evidence, using the normal Zira login.
import { toolkit } from './api.mjs';
import { boundedFetch } from './limits.mjs';
import { createHash } from 'node:crypto';
import { movementJournal, acknowledgeMovement } from './movement.mjs';

import { liveSession } from '../../../scripts/client.mjs';
export async function healthCloudClient(profile, options = {}) {
  const request=await liveSession(profile,{...options,maxRequests:options.maxRequests ?? 120,
    allow:[['GET',/^\/prod-vision\/[1-9]\d*\/(health-history|movement-reviews)$/],
      ['PUT',/^\/prod-vision\/[1-9]\d*\/movement-reviews\/[a-f0-9]{64}$/]]});
  return async (...args) => {
    const result=await request(...args);
    return Object.hasOwn(result,'data') ? result.data : result;
  };
}

const idFor = (profile, companyId, siteId, deviceId, journalId, eventId) => createHash('sha256')
  .update(JSON.stringify([profile, companyId, siteId, deviceId, journalId, eventId])).digest('hex');
function validReceipt(a, { profile, companyId, siteId, deviceId, journalId, eventIds }) {
  return a && a.companyId === companyId && a.siteId === siteId && a.deviceId === deviceId && a.journalId === journalId &&
    eventIds.includes(a.eventId) && a.incidentId === idFor(profile, companyId, siteId, deviceId, journalId, a.eventId) &&
    Number.isSafeInteger(a.atEpochMs) && a.atEpochMs > 0 && Number.isSafeInteger(a.acknowledgedAtEpochMs) && a.acknowledgedAtEpochMs > 0 &&
    typeof a.reviewedBy === 'string' && a.reviewedBy.length > 0 && typeof a.note === 'string' && a.note.length <= 500;
}
export async function loadCloudMovementLedger(report, { request } = {}) {
  const ledger = { scope: 'aws-shared', acknowledgements: {}, unavailable: [] };
  let count = 0, serviceError;
  for (const d of report.devices ?? []) {
    const journal = movementJournal(d.deviceStatus?.values?.cameraHealth?.movement);
    if (!journal?.events.length) continue;
    try {
      if (serviceError) throw new Error(serviceError);
      if (++count > 500) throw new Error('Shared review lookup capped at 500 cameras');
      request ??= await healthCloudClient(report.sourceProfile);
      const eventIds = journal.events.map(e => e.id);
      const result = await request('GET', `/prod-vision/${d.id}/movement-reviews?${new URLSearchParams({ journalId: journal.journalId, eventIds: eventIds.join(',') })}`);
      if (result?.scope !== 'aws-shared' || result.companyId !== report.companyId || result.siteId !== d.siteId ||
          result.deviceId !== d.id || result.journalId !== journal.journalId || !Array.isArray(result.acknowledgements) || result.acknowledgements.length > 64)
        throw new Error('Shared review response scope mismatch');
      const scope = { profile: report.sourceProfile, companyId: report.companyId, siteId: d.siteId, deviceId: d.id, journalId: journal.journalId, eventIds };
      for (const a of result.acknowledgements) {
        if (!validReceipt(a, scope)) throw new Error('Invalid shared review receipt');
        ledger.acknowledgements[a.incidentId] = a;
      }
    } catch (error) {
      serviceError ??= error.message;
      ledger.unavailable.push({ deviceKey: d.deviceKey, reason: error.message });
    }
  }
  return ledger;
}

export async function acknowledgeCloudMovement(options, { request } = {}) {
  const preview = await acknowledgeMovement({ ...options, apply: false });
  const result = { ...preview, scope: 'aws-shared', receipts: [],
    effect: 'These exact incidents are reviewed for authorized users on every computer. New incident IDs still alert; camera calibration and counts are unchanged.' };
  if (!options.apply) return result;
  if (options.report.movement?.acknowledgementScope !== 'aws-shared') throw new Error('Refresh a live cloud movement report before acknowledging; offline/local reports cannot write cloud reviews');
  request ??= await healthCloudClient(options.profile, { maxRequests: 220 });
  for (const e of preview.incidents) {
    const scope = { profile: options.profile, companyId: options.companyId, siteId: e.siteId, deviceId: e.deviceId, journalId: e.journalId, eventIds: [e.eventId] };
    const body = { journalId: e.journalId, eventId: e.eventId, atEpochMs: e.atEpochMs, kind: e.kind, timeUncertain: e.timeUncertain, note: preview.note };
    try {
      const response = await request('PUT', `/prod-vision/${e.deviceId}/movement-reviews/${e.incidentId}`, body);
      if (response?.scope !== 'aws-shared' || !validReceipt(response.receipt, scope)) throw new Error('Invalid shared acknowledgement receipt');
      result.receipts.push(response.receipt);
    } catch (error) {
      // A previous PUT may have committed. Query its exact identity once; never replay it.
      try {
        const response = await request('GET', `/prod-vision/${e.deviceId}/movement-reviews?${new URLSearchParams({ journalId: e.journalId, eventIds: String(e.eventId) })}`);
        const saved = response?.scope === 'aws-shared' && response.acknowledgements?.find(a => validReceipt(a, scope));
        if (!saved) throw error;
        result.receipts.push(saved);
      } catch {
        return { ...result, complete: false, applied: false, uncertainIncidentId: e.incidentId,
          error: `${error.message}. Refresh the report to reconcile this incident before another write. Earlier receipts remain acknowledged.` };
      }
    }
  }
  return { ...result, applied: true, complete: true };
}

export async function cloudHealthHistory({ profile = 'prod', deviceId, from, to, limit = 30, after }, { request } = {}) {
  if (!/^[1-9]\d*$/.test(String(deviceId))) throw new Error('An exact data source ID is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 30 || [from, to].filter(x => x !== undefined).some(x => typeof x !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(x) || !Number.isFinite(Date.parse(x))))
    throw new Error('History needs 1-30 archives and ISO dates with explicit offsets');
  const q = new URLSearchParams({ limit: String(limit), ...(after ? {after} : {}), ...(from ? { from: String(Date.parse(from)) } : {}), ...(to ? { to: String(Date.parse(to)) } : {}) });
  request ??= await healthCloudClient(profile);
  return request('GET', `/prod-vision/${deviceId}/health-history?${q}`);
}
