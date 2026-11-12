import { performance } from 'node:perf_hooks';
import { AGENT_ROUTES } from './routes.js';

const policy = (rate, burst) => Object.freeze({ rate, burst, intervalMs: 1000 / rate });
const reads = policy(2, 8);
const heavyReads = policy(0.5, 2);
const writes = policy(0.5, 2);
const creation = policy(0.1, 1);
const imports = policy(0.02, 1);
const credentials = policy(0.1, 1);
const heavyRoutes = new Set([
  'GET /prod-vision/{deviceId}/health-history', 'GET /prod-vision/{deviceId}/movement-reviews',
  'GET /analysis/data/{id}', 'GET /analysis/agent-data/{id}',
  'GET /meters-data/readings-files',
  'GET /prod-vision/{deviceId}/snapshot-sessions',
  'GET /prod-vision/{deviceId}/snapshot-sessions/{day}/{session}/files',
  'GET /prod-vision/{deviceId}/raw-videos',
  'GET /prod-vision/{deviceId}/datasets/stats',
]);
const creationRoutes = new Set([
  'POST /devices/from-template', 'POST /devices/copy', 'POST /dashboards/copy',
  'POST /schedules/new', 'POST /files/signed-uploads/create',
  'GET /meters-data/prepare-readings-files',
  // A merge builds a dataset version; a training start launches a paid GPU job.
  'POST /prod-vision/dataset-merge', 'GET /prod-vision/{deviceId}/train-model/{fileId}',
  // An annotation review starts a paid AI labelling job.
  'POST /prod-vision/{deviceId}/annotation-review-jobs',
  // A model evaluation starts a cloud job that runs models on dataset versions.
  'POST /prod-vision/{deviceId}/model-evaluation-jobs',
]);
const importRoute = 'POST /prod-vision/{deviceId}/assets-to-hub';
const credentialRoute = 'GET /prod-vision/iot-client-creds';
const origins = new Set(['https://api.zira.us', 'https://integ.api.zira.us']);

export const AGENT_ROUTE_POLICIES = Object.freeze(Object.fromEntries(AGENT_ROUTES.map(route => [
  route,
  route === importRoute ? imports : route === credentialRoute ? credentials :
    heavyRoutes.has(route) ? heavyReads : creationRoutes.has(route) ? creation :
      route.startsWith('GET ') ? reads : writes,
])));

// This error means actual dispatch has not happened. The scheduler creates it
// before the callback starts; transports may also assert availability after async
// preparation, strictly before fetch. Callback errors otherwise pass through:
// a timeout or disconnect cannot prove a write failed.
export class AgentPacingError extends Error {
  constructor(message = 'Agent request was stopped before sending.') {
    super(message);
    this.name = 'AgentPacingError';
    this.code = 'AGENT_PACING_BLOCKED';
    this.requestSent = false;
  }
}

export function agentRoutePolicy(route) {
  if (typeof route !== 'string' || !Object.hasOwn(AGENT_ROUTE_POLICIES, route))
    throw new AgentPacingError('Unknown agent pacing route; no request was sent.');
  return AGENT_ROUTE_POLICIES[route];
}

function sleepUntil(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new AgentPacingError('Queued agent request was cancelled before sending.')); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}

// Deliberately smoother than the proposed server token buckets: do not spend the
// burst allowance. One callback runs per origin/route, then a full refill interval
// elapses AFTER it settles. Authentication and other local queues inside a callback
// therefore cannot bunch requests previously admitted by this scheduler.
export function createAgentPacer({
  now = () => performance.now(), sleep = sleepUntil, maxQueued = 1000,
} = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function' ||
      !Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 1000)
    throw new TypeError('Agent pacing requires a clock, sleep function and queue bound of 1–1000.');
  const buckets = new Map();
  let closed = false, queued = 0, lastTime = -Infinity;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new Error('Invalid pacing clock');
    lastTime = Math.max(lastTime, value);
    return lastTime;
  };
  const discard = (bucket, entry, error) => {
    const index = bucket.queue.indexOf(entry);
    if (index < 0) return;
    bucket.queue.splice(index, 1); queued--;
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.reject(error);
    if (index === 0) bucket.waiting?.abort();
  };
  const stop = message => {
    if (closed) return;
    closed = true;
    for (const bucket of buckets.values()) {
      bucket.waiting?.abort();
      for (const entry of [...bucket.queue]) discard(bucket, entry, new AgentPacingError(message));
    }
  };
  const assertAvailable = () => {
    if (closed) throw new AgentPacingError('Agent pacing is closed; no request was sent.');
  };
  const drain = async bucket => {
    if (bucket.running || closed) return;
    bucket.running = true;
    try {
      while (bucket.queue.length && !closed) {
        const entry = bucket.queue[0];
        if (entry.signal?.aborted) {
          discard(bucket, entry, new AgentPacingError('Queued agent request was cancelled before sending.'));
          continue;
        }
        let delay;
        try { delay = Math.max(0, bucket.nextAt - clock()); }
        catch { stop('Agent pacing clock failed; queued requests were not sent.'); break; }
        if (delay > 0) {
          const controller = new AbortController();
          bucket.waiting = controller;
          try { await sleep(delay, { signal: controller.signal }); }
          catch {
            if (!controller.signal.aborted) stop('Agent pacing wait failed; queued requests were not sent.');
          } finally { bucket.waiting = null; }
          continue;
        }
        bucket.queue.shift(); queued--;
        entry.signal?.removeEventListener('abort', entry.abort);
        // No await separates this final cancellation check from invoking the callback.
        if (entry.signal?.aborted) {
          entry.reject(new AgentPacingError('Queued agent request was cancelled before sending.'));
          continue;
        }
        let result, failure, failed = false;
        try { result = await entry.attempt(); }
        catch (error) { failure = error; failed = true; }
        try { bucket.nextAt = clock() + bucket.intervalMs; }
        catch { stop('Agent pacing clock failed; queued requests were not sent.'); }
        if (failed) entry.reject(failure);
        else entry.resolve(result);
      }
    } finally { bucket.running = false; }
  };
  return {
    assertAvailable,
    run({ origin, route } = {}, attempt, { signal } = {}) {
      try {
        assertAvailable();
        if (!origins.has(origin)) throw new AgentPacingError('Untrusted agent pacing origin; no request was sent.');
        const { intervalMs } = agentRoutePolicy(route);
        if (typeof attempt !== 'function') throw new AgentPacingError('An agent request callback is required.');
        if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
          throw new AgentPacingError('Invalid agent request cancellation signal.');
        if (signal?.aborted) throw new AgentPacingError('Queued agent request was cancelled before sending.');
        if (queued >= maxQueued) throw new AgentPacingError('Agent request queue is full; no request was sent.');
        const key = `${origin}\n${route}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { queue: [], running: false, waiting: null, nextAt: -Infinity, intervalMs };
          buckets.set(key, bucket);
        }
        return new Promise((resolve, reject) => {
          const entry = { attempt, signal, resolve, reject };
          entry.abort = () => discard(bucket, entry, new AgentPacingError('Queued agent request was cancelled before sending.'));
          bucket.queue.push(entry); queued++;
          signal?.addEventListener('abort', entry.abort, { once: true });
          void drain(bucket);
        });
      } catch (error) { return Promise.reject(error); }
    },
    close() { stop('Agent pacing is closed; queued requests were not sent.'); },
  };
}

const defaultKey = Symbol.for('zira.agentRoutePacer.v1');
export function defaultAgentPacer() {
  return globalThis[defaultKey] ??= createAgentPacer();
}
