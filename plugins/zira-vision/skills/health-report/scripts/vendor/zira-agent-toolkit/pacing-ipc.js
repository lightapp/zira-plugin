import { randomUUID } from 'node:crypto';
import { AgentPacingError, agentRoutePolicy, defaultAgentPacer } from './pacing.js';

export const IPC_ENV = 'ZIRA_AGENT_PACING_IPC';
export const IPC_MARKER = '1';
const PROTOCOL = 'zira-agent-pacing-v1';
const IPC_SINGLETON = Symbol.for('zira.agentRouteIpcPacer.v1');
const ORIGINS = new Set(['https://api.zira.us', 'https://integ.api.zira.us']);
const blocked = () => new AgentPacingError('Agent request pacing is unavailable; no request was sent.');
const available = channel => typeof channel?.send === 'function' && channel.connected === true;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);

function validateKey(key) {
  if (!key || !ORIGINS.has(key.origin)) throw blocked();
  agentRoutePolicy(key.route); // Only canonical templates: never concrete IDs, query strings or aliases.
  return { origin: key.origin, route: key.route };
}

function checkBound(maxPending) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 10000) throw new TypeError('Invalid IPC pacing queue bound.');
}

function send(channel, action, id, extra, failed) {
  if (!available(channel)) { failed(); return; }
  try {
    // A false return means backpressure, not a failed send. Never replay the message.
    channel.send({ protocol: PROTOCOL, action, id, ...extra }, error => { if (error) failed(); });
  } catch { failed(); }
}

function listen(channel, handlers) {
  if (typeof channel?.on !== 'function') return () => {};
  for (const [event, handler] of Object.entries(handlers)) channel.on(event, handler);
  return () => { for (const [event, handler] of Object.entries(handlers)) channel.removeListener(event, handler); };
}

// A child holds its parent's slot until its actual attempt settles. IPC never carries
// credentials, concrete URLs, payloads, response bodies or exception messages.
export function createIpcAgentPacer({ channel = process, maxPending = 1000 } = {}) {
  checkBound(maxPending);
  const pending = new Map();
  const unavailable = new Set();
  let closed = !available(channel), unlisten = () => {};
  const refs = () => { channel?.channel?.[pending.size ? 'ref' : 'unref']?.(); };
  const remove = entry => {
    pending.delete(entry.id); entry.signal?.removeEventListener('abort', entry.abort); refs();
  };
  const close = () => {
    if (closed) return;
    closed = true; unlisten();
    for (const entry of pending.values()) {
      if (entry.started) continue; // A sent write's result is never relabelled definitely unsent.
      if (available(channel)) send(channel, 'cancel', entry.id, {}, () => {});
      remove(entry); entry.reject(blocked());
    }
    for (const notify of unavailable) notify();
    unavailable.clear();
    refs();
  };
  const onMessage = message => {
    if (closed || message?.protocol !== PROTOCOL || !validId(message.id)) return;
    const entry = pending.get(message.id);
    if (!entry || entry.started) return;
    if (message.action === 'reject') { remove(entry); entry.reject(blocked()); return; }
    if (message.action !== 'grant') return;
    entry.started = true;
    entry.signal?.removeEventListener('abort', entry.abort);
    // Check cancellation again immediately before calling the attempt, including a
    // grant/abort race. Actual callback failures stay local and preserve their identity.
    Promise.resolve().then(() => {
      if (entry.signal?.aborted || closed) throw blocked();
      return entry.attempt();
    }).then(entry.resolve, entry.reject).finally(() => {
      remove(entry);
      if (available(channel)) send(channel, 'done', entry.id, {}, close);
    });
  };
  if (!closed) unlisten = listen(channel, { message: onMessage, disconnect: close, exit: close, close, error: close });
  refs();
  return {
    run(key, attempt, { signal } = {}) {
      try {
        key = validateKey(key);
        if (typeof attempt !== 'function') throw blocked();
        if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw blocked();
        if (closed || !available(channel) || signal?.aborted || pending.size >= maxPending) throw blocked();
      } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const entry = { ...key, id: randomUUID(), attempt, signal, resolve, reject, started: false };
        entry.abort = () => {
          if (entry.started || !pending.has(entry.id)) return;
          remove(entry);
          send(channel, 'cancel', entry.id, {}, close);
          reject(blocked());
        };
        pending.set(entry.id, entry); refs();
        signal?.addEventListener('abort', entry.abort, { once: true });
        send(channel, 'acquire', entry.id, key, close);
      });
    },
    assertAvailable() { if (closed || !available(channel)) throw blocked(); },
    onUnavailable(listener) {
      if (closed) { listener(); return () => {}; }
      unavailable.add(listener);
      return () => unavailable.delete(listener);
    },
    close,
  };
}

// One attachment belongs to one child. Request IDs from another child can never
// complete/cancel this child's slots. Closing it cancels queued work and releases
// started slots through the pacer's normal completion/cooldown path.
export function attachPacingCoordinator(channel, pacer, { maxPending = 1000 } = {}) {
  checkBound(maxPending);
  const pending = new Map();
  let closed = !available(channel), stopping = false, unlisten = () => {}, detachUpstream = () => {};
  const refs = () => { channel?.channel?.[pending.size ? 'ref' : 'unref']?.(); };
  const close = () => {
    if (closed) return;
    closed = true; unlisten(); detachUpstream();
    for (const entry of pending.values()) { entry.controller.abort(); entry.finish?.(); }
    pending.clear(); refs();
    if (available(channel)) channel.disconnect?.();
  };
  const reject = id => send(channel, 'reject', id, {}, close);
  const onMessage = message => {
    if (closed || message?.protocol !== PROTOCOL || !validId(message.id)) return;
    const entry = pending.get(message.id);
    if (message.action === 'done') { if (entry?.started) entry.finish(); return; }
    if (message.action === 'cancel') {
      if (entry) { entry.controller.abort(); entry.finish?.(); }
      return;
    }
    if (message.action !== 'acquire') return;
    if (entry) return; // No duplicate grants or scheduler submissions.
    let key;
    try {
      if (stopping || pending.size >= maxPending || Object.keys(message).some(k => !['protocol', 'action', 'id', 'origin', 'route'].includes(k))) throw blocked();
      key = validateKey(message);
    } catch { reject(message.id); return; }
    const next = { controller: new AbortController(), started: false };
    pending.set(message.id, next); refs();
    Promise.resolve().then(() => pacer.run(key, () => {
      if (closed || stopping || next.controller.signal.aborted) throw blocked();
      pacer.assertAvailable?.();
      next.started = true;
      return new Promise(resolve => {
        next.finish = resolve;
        send(channel, 'grant', message.id, {}, close);
      });
    }, { signal: next.controller.signal })).catch(() => {
      if (!closed && !next.controller.signal.aborted) reject(message.id);
    }).finally(() => {
      if (pending.get(message.id) === next) pending.delete(message.id);
      refs();
    });
  };
  if (!closed) unlisten = listen(channel, { message: onMessage, disconnect: close, exit: close, close, error: close });
  if (!closed) detachUpstream = pacer.onUnavailable?.(() => {
    close();
    // A nested child must see its authority disappear too, including after grant
    // while it is still waiting for credentials or its workflow request limiter.
    if (available(channel)) channel.disconnect?.();
  }) ?? (() => {});
  refs();
  return {
    cancelQueued() {
      stopping = true;
      for (const [id, entry] of pending) if (!entry.started) {
        entry.controller.abort(); reject(id);
      }
    },
    close,
  };
}

export function runtimeAgentPacer() {
  if (!Object.hasOwn(process.env, IPC_ENV)) return defaultAgentPacer();
  // A spoofed/stale marker never silently becomes a separate local budget.
  if (process.env[IPC_ENV] !== IPC_MARKER) return createIpcAgentPacer({ channel: null });
  return globalThis[IPC_SINGLETON] ??= createIpcAgentPacer();
}
