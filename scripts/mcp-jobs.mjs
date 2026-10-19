import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildInfo } from './build-info.mjs';
import { catalog, invocation } from './mcp-catalog.mjs';

const MAX_OUTPUT = 512 * 1024;
const MAX_JOBS = 64;
const MAX_RUNNING = 4;
const MAX_AGE = 30 * 60 * 1000;
export const jobTools = [{
  name: 'job_status', description: 'Read a Zira local job, including browser-login progress and final results. Poll an existing job_id; never restart a write because it is still running. Jobs belong to this server session.',
  inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

// Defense in depth for diagnostics. Credential files are never read by this transport.
export function redact(text) {
  return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/("?(?:access_token|id_token|refresh_token|client_secret|secretAccessKey|sessionToken)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}

export class Jobs {
  constructor({ info = buildInfo(), spawnImpl = spawn, waitMs = 750, maxAge = MAX_AGE } = {}) {
    this.info = info; this.entries = catalog(info); this.spawn = spawnImpl;
    this.waitMs = waitMs; this.maxAge = maxAge; this.jobs = new Map(); this.closed = false;
  }
  tools() { return [...this.entries.map(e => e.tool), ...jobTools]; }
  snapshot(job) {
    return { job_id: job.id, tool: job.tool, status: job.status,
      ...(job.status === 'running' ? { next: 'Call job_status with this job_id. Do not repeat the original call.' } : { exit_code: job.code }),
      stdout: redact(job.out), stderr: redact(job.err), output_truncated: job.truncated,
      ...(job.reason ? { reason: job.reason, next: 'The outcome may be partial. Inspect saved results/receipts before any retry; cancellation does not undo a write.' } : {}) };
  }
  async call(name, input) {
    if (this.closed) throw new Error('Server is closing.');
    if (name === 'job_status') {
      if (!input || typeof input.job_id !== 'string' || Object.keys(input).some(k => k !== 'job_id')) throw new Error('Provide only job_id.');
      const job = this.jobs.get(input.job_id);
      if (!job) throw new Error('Unknown job in this server session. Do not automatically retry a write.');
      return this.snapshot(job);
    }
    const entry = this.entries.find(e => e.name === name);
    if (!entry) throw new Error('Unknown Zira tool.');
    const args = invocation(entry, input, this.info);
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= MAX_RUNNING) throw new Error('Four jobs are already running. Poll them before starting more.');
    for (const [id, job] of this.jobs) if (job.status !== 'running' && Date.now() - job.finished > this.maxAge) this.jobs.delete(id);
    if (this.jobs.size >= MAX_JOBS) throw new Error('This session has reached its job limit. Read existing results and restart the server before starting more work.');
    const env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.PYTHONPATH; delete env.PYTHONSTARTUP;
    const job = { id: randomUUID(), tool: name, status: 'running', out: '', err: '', size: 0, truncated: false };
    this.jobs.set(job.id, job);
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const complete = (code, reason) => {
      if (job.status !== 'running') return;
      clearTimeout(job.timer); job.code = code; job.status = code === 0 ? 'completed' : 'failed';
      job.reason = reason ?? job.reason; job.finished = Date.now(); finish();
    };
    try {
      job.child = this.spawn(process.execPath, [path.join(this.info.pluginRoot, entry.script), ...args], {
        cwd: this.info.pluginRoot, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const append = (key, chunk) => {
        const room = Math.max(0, MAX_OUTPUT - job.size);
        const bytes = Buffer.from(chunk); job[key] += bytes.subarray(0, room).toString('utf8'); job.size += Math.min(room, bytes.length);
        if (bytes.length > room) job.truncated = true; // Keep draining; never kill a write for verbose output.
      };
      job.child.stdout.setEncoding('utf8'); job.child.stderr.setEncoding('utf8');
      job.child.stdout.on('data', data => append('out', data));
      job.child.stderr.on('data', data => append('err', data));
      job.child.on('error', () => complete(null, 'Unable to start the packaged runtime.'));
      job.child.on('close', (code, signal) => complete(code, signal ? `Runtime stopped (${signal}).` : undefined));
      job.child.stdin.on('error', () => {});
      job.child.stdin.end(input.input === undefined ? '' : JSON.stringify(input.input));
      job.timer = setTimeout(() => this.stop(job, 'Runtime exceeded the 30-minute job limit.'), this.maxAge);
      job.timer.unref();
    } catch { complete(null, 'Unable to start the packaged runtime.'); }
    let timer;
    await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, this.waitMs); })]);
    clearTimeout(timer);
    return this.snapshot(job);
  }
  stop(job, reason) {
    if (job.status !== 'running' || job.stopping) return;
    job.stopping = true;
    job.reason = reason;
    const kill = signal => {
      const pid = job.child?.pid;
      if (!pid) { job.child?.kill(signal); return; }
      if (process.platform === 'win32') {
        // taskkill's /T includes Python children. Only our numeric child PID is supplied.
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        killer.on('error', () => job.child?.kill(signal));
      } else {
        try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') job.child?.kill(signal); }
      }
    };
    kill('SIGTERM');
    const force = setTimeout(() => kill('SIGKILL'), 1500);
    if (!job.child?.pid) force.unref();
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) this.stop(job, 'MCP connection closed.');
  }
}
