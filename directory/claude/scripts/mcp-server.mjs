#!/usr/bin/env node
// MCP 2025-06-18 stdio: no listening socket, npm install, shell or remote execution service.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Jobs } from './mcp-jobs.mjs';

export function startServer({ input = process.stdin, output = process.stdout, jobs = new Jobs() } = {}) {
  let initialized = false, ready = false, buffer = '', closed = false;
  const pending = new Set();
  const send = message => { if (!closed) output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  const error = (id, code, message) => send({ id, error: { code, message } });
  const close = () => { closed = true; jobs.close(); input.pause(); };
  async function receive(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid request');
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && initialized) ready = true;
      // A tool call starts a separately tracked local job; cancellation of the RPC response
      // does not cancel/replay a possibly committed write. Jobs finish and remain pollable.
      return;
    }
    if (!(typeof id === 'string' || typeof id === 'number' && Number.isSafeInteger(id))) return error(null, -32600, 'Invalid request id');
    if (pending.has(id)) return error(id, -32600, 'Duplicate in-flight request id');
    pending.add(id);
    try {
      let result;
      if (method === 'ping') result = {};
      else if (method === 'initialize') {
        if (initialized || !params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) return error(id, -32602, 'Invalid initialization');
        initialized = true;
        result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'zira', version: jobs.info.version },
          instructions: 'Use Zira skills for workflows. Tools run packaged code locally with existing Zira sign-in. Preview writes and apply only with user authorization. Long calls return job_id; poll job_status and never repeat a pending write. Missing or interrupted results do not prove no write occurred.' };
      } else if (!ready) return error(id, -32000, 'Initialize the connection first');
      else if (method === 'tools/list') {
        if (params?.cursor) return error(id, -32602, 'This catalog is not paginated');
        result = { tools: jobs.tools() };
      } else if (method === 'tools/call') {
        if (!params || typeof params.name !== 'string') return error(id, -32602, 'Tool name required');
        if (!jobs.tools().some(t => t.name === params.name)) return error(id, -32602, 'Unknown tool');
        try {
          const value = await jobs.call(params.name, params.arguments ?? {});
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.status === 'failed' };
        } catch (failure) {
          result = { content: [{ type: 'text', text: failure.message }], isError: true };
        }
      } else return error(id, -32601, 'Method not found');
      send({ id, result });
    } finally { pending.delete(id); }
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) { error(null, -32600, 'Message too large'); close(); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); continue; }
      if (pending.size >= 16) { error(message.id ?? null, -32000, 'Too many pending requests'); continue; }
      void receive(message).catch(() => error(message.id ?? null, -32603, 'Internal error'));
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024) { error(null, -32600, 'Message too large'); close(); }
  });
  input.on('end', close); input.on('error', close); output.on('error', close);
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = startServer();
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
