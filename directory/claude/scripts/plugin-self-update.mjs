#!/usr/bin/env node
// Automatic update for the public ZIP installation in Claude Code. Runs detached from the
// SessionStart hook: downloads the release ZIP from the fixed public repository (no Git), checks
// every file against release.json, swaps the local marketplace folder the host already uses and
// lets the host's own plugin manager install it. Never reads Zira credentials, never edits host
// configuration files, and leaves internal, managed and Git sources alone.
import { promises as fs, existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInfo } from './build-info.mjs';
import { checkForUpdate, compareVersions, eligible, validateRelease } from './plugin-updates.mjs';

const REPOSITORY = new URL('https://github.com/lightapp/zira-plugin').pathname.slice(1);
const MAX_ZIP = 60 * 1024 * 1024, MAX_FILES = 6000, MAX_BYTES = 250 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const IDENTITY = ['version', 'audience', 'channel', 'sourceCommit', 'sourceDirty', 'releaseApproved'];
export const stateDir = () => path.join(os.homedir(), '.zira', 'plugin-updates');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// --- ZIP -------------------------------------------------------------------------------------
// Minimal reader for the archives GitHub serves: stored or deflated entries, no ZIP64, no
// encryption. Returns Map<name, { data, mode }> with the single top-level folder removed.
export function unzip(buffer, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12);
  let at = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff || size === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (count > maxFiles || at + size > end) throw new Error('Unexpected ZIP layout');
  const files = new Map(); let total = 0, top;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged ZIP directory');
    const host = buffer[at + 5], flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20), length = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const attributes = buffer.readUInt32LE(at + 38), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    const mode = host === 3 ? attributes >>> 16 : 0;
    if (flags & 1) throw new Error('Encrypted ZIP entry');
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
        name.split('/').some(part => part === '..' || part === '.'))
      throw new Error('Unsafe path in ZIP');
    if ((mode & 0o170000) === 0o120000) throw new Error('Symlink in ZIP');
    const slash = name.indexOf('/');
    if (slash < 0) throw new Error('Unexpected file at the top of the ZIP');
    top ??= name.slice(0, slash);
    if (name.slice(0, slash) !== top) throw new Error('More than one top-level folder in the ZIP');
    const inner = name.slice(slash + 1);
    if (!inner || inner.endsWith('/')) continue;
    if (packed === 0xffffffff || length === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    total += length;
    if (total > maxBytes) throw new Error('ZIP contents too large');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Damaged ZIP entry');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + packed > buffer.length) throw new Error('Damaged ZIP entry');
    const raw = buffer.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(length, 1) });
    else throw new Error('Unsupported ZIP compression');
    if (data.length !== length || files.has(inner)) throw new Error('Damaged ZIP entry');
    files.set(inner, { data, mode: mode & 0o111 ? 0o755 : 0o644 });
  }
  return files;
}

// --- Release ---------------------------------------------------------------------------------
// The same identity rules the publisher enforces, applied to the downloaded files before any of
// them is written into a folder a host reads.
export function verifyRelease(files, { version, channel, sourceCommit }) {
  const text = name => { const f = files.get(name); if (!f) throw new Error(`Release file missing: ${name}`); return f.data.toString('utf8'); };
  const manifest = JSON.parse(text('release.json'));
  if (manifest.format !== 'git' || manifest.repository !== REPOSITORY || manifest.audience !== 'public' ||
      manifest.channel !== channel || manifest.version !== version || manifest.sourceDirty !== false ||
      (sourceCommit && manifest.sourceCommit !== sourceCommit) || !manifest.files || typeof manifest.files !== 'object')
    throw new Error('Not the expected Zira public release');
  const actual = [...files.keys()].filter(name => name !== 'release.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('Extra or missing release files');
  for (const name of actual) if (digest(files.get(name).data) !== manifest.files[name]) throw new Error(`Checksum mismatch: ${name}`);
  const info = JSON.parse(text('build.json'));
  validateRelease(info, channel);
  for (const key of IDENTITY) if (info[key] !== manifest[key]) throw new Error(`Build identity mismatch: ${key}`);
  const plugins = ['zira'];
  for (const host of ['.claude-plugin', '.codex-plugin'])
    if (JSON.parse(text(`${host}/plugin.json`)).version !== version) throw new Error('Plugin version mismatch');
  for (const name of actual.filter(n => /^plugins\/[^/]+\/build\.json$/.test(n))) {
    const extra = JSON.parse(text(name)), folder = name.split('/')[1];
    for (const key of IDENTITY) if (extra[key] !== manifest[key]) throw new Error(`Build identity mismatch in ${folder}: ${key}`);
    if (extra.plugin !== folder || JSON.stringify(extra.restrictions) !== JSON.stringify(info.restrictions))
      throw new Error(`Plugin identity mismatch in ${folder}`);
    plugins.push(folder);
  }
  return { version, plugins };
}

async function download(fetchImpl, version) {
  // codeload is where github.com/…/archive/refs/tags/… redirects; asked directly, so no redirect is followed.
  const response = await fetchImpl(`https://codeload.github.com/${REPOSITORY}/zip/refs/tags/v${version}`, {
    signal: AbortSignal.timeout(120000), redirect: 'error', credentials: 'omit',
  });
  if (!response.ok) throw new Error('Release download unavailable');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > MAX_ZIP) throw new Error('Release download too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

// --- Host ------------------------------------------------------------------------------------
const configDir = env => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
function installed(env, name) {
  const entries = readJson(path.join(configDir(env), 'plugins', 'installed_plugins.json'))?.plugins?.[`${name}@zira`];
  return Array.isArray(entries) && entries.length ? entries : null;
}
export function claudeBinary(env = process.env) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [env.CLAUDE_CODE_EXECPATH,
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe)),
    path.join(os.homedir(), '.local', 'bin', exe), path.join(os.homedir(), '.claude', 'local', exe),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find(file => file && path.isAbsolute(file) && existsSync(file)) || null;
}

// Decide, without touching the network or the disk, whether this installation is one the
// updater manages: Claude Code, the public build, installed from a local folder that holds an
// extracted public release of the same channel.
export function target({ info = buildInfo(), env = process.env } = {}) {
  const no = reason => ({ managed: false, reason });
  if (!eligible(info)) return no('not a public release');
  if (!env.CLAUDE_PLUGIN_ROOT && !env.CLAUDE_CODE_ENTRYPOINT && !env.CLAUDECODE) return no('not Claude Code');
  const market = readJson(path.join(configDir(env), 'plugins', 'known_marketplaces.json'))?.zira;
  const source = market?.source?.source === 'directory' && typeof market.source.path === 'string' ? market.source.path : null;
  if (!source || !path.isAbsolute(source)) return no('installed from another kind of source');
  const sourceInfo = readJson(path.join(source, 'build.json'));
  if (!eligible(sourceInfo) || sourceInfo.channel !== info.channel || !existsSync(path.join(source, 'release.json')))
    return no('the source folder is not a public Zira release');
  if (!installed(env, 'zira')) return no('zira is not installed from this source');
  const binary = claudeBinary(env);
  if (!binary) return no('the claude command was not found');
  return { managed: true, source, binary, plugins: ['zira', ...(installed(env, 'zira-vision') ? ['zira-vision'] : [])] };
}

// --- Switch ----------------------------------------------------------------------------------
const settingsFile = dir => path.join(dir, 'auto-update.json');
export function autoUpdateEnabled({ env = process.env, dir = stateDir() } = {}) {
  return env.ZIRA_AUTO_UPDATE !== '0' && env.ZIRA_CHECK_UPDATES !== '0' && readJson(settingsFile(dir))?.enabled !== false;
}
export function setAutoUpdate(enabled, { dir = stateDir() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile(dir), JSON.stringify({ enabled: !!enabled, changedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { automaticUpdates: enabled ? 'on' : 'off' };
}

// --- Outcome ---------------------------------------------------------------------------------
const outcomeFile = dir => path.join(dir, 'auto.json');
export const lastOutcome = (dir = stateDir()) => readJson(outcomeFile(dir));
async function record(dir, value) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(outcomeFile(dir), JSON.stringify(value) + '\n', { mode: 0o600 });
}
// One line for the first session that runs the new version; null when there is nothing new to say.
export function announce({ info = buildInfo(), dir = stateDir() } = {}) {
  const last = lastOutcome(dir);
  if (!last || last.status !== 'updated' || last.announced || last.to !== info.version) return null;
  try { writeFileSync(outcomeFile(dir), JSON.stringify({ ...last, announced: true }) + '\n', { mode: 0o600 }); } catch {}
  const notes = Array.isArray(last.notes) && last.notes.length ? ` What changed: ${last.notes.join(' ')}` : '';
  return `Zira updated itself to ${last.to} (was ${last.from}).${notes}`;
}
// True when this version already failed to install in the last day: fall back to the manual notice.
export function recentlyFailed(version, { now = Date.now(), dir = stateDir() } = {}) {
  const last = lastOutcome(dir);
  return last?.status === 'failed' && last.to === version && now - Date.parse(last.at) < DAY;
}

function run(file, args, env) {
  return new Promise((resolve, reject) => execFile(file, args, { env, timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(`${args.join(' ')}: ${String(stderr || stdout || error.message).trim().slice(0, 300)}`)) : resolve(stdout)));
}
async function write(directory, files) {
  for (const [name, { data, mode }] of files) {
    const file = path.join(directory, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { mode });
  }
}

export async function selfUpdate({ info = buildInfo(), env = process.env, fetchImpl = fetch, now = Date.now(),
  dir = stateDir(), check = checkForUpdate, runCommand = run } = {}) {
  if (!autoUpdateEnabled({ env, dir })) return { status: 'disabled' };
  const where = target({ info, env });
  if (!where.managed) return { status: 'not_managed', reason: where.reason };
  const update = await check({ info, env, fetchImpl, now });
  if (update.status !== 'available') return { status: update.status };
  if (recentlyFailed(update.latestVersion, { now, dir })) return { status: 'waiting', reason: 'the last attempt failed less than a day ago' };

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'auto.lock');
  try {
    const stat = await fs.stat(lock).catch(() => null);
    if (stat && now - stat.mtimeMs > 20 * 60 * 1000) await fs.rm(lock, { force: true });
    await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch { return { status: 'busy' }; }

  const { source, binary, plugins } = where;
  const staging = `${source}.staging`, previous = `${source}.previous`;
  const base = { from: info.version, to: update.latestVersion, at: new Date(now).toISOString(), notes: update.notes };
  let swapped = false;
  try {
    const files = unzip(await download(fetchImpl, update.latestVersion));
    const release = verifyRelease(files, { version: update.latestVersion, channel: info.channel });
    const missing = plugins.filter(name => !release.plugins.includes(name));
    if (missing.length) throw new Error(`The new release has no ${missing.join(', ')} plugin`);
    await fs.rm(staging, { recursive: true, force: true });
    await write(staging, files);
    await fs.rm(previous, { recursive: true, force: true });
    await fs.rename(source, previous);
    await fs.rename(staging, source); swapped = true;
    await runCommand(binary, ['plugin', 'marketplace', 'update', 'zira'], env);
    for (const name of plugins) await runCommand(binary, ['plugin', 'update', `${name}@zira`], env);
    for (const name of plugins)
      if (!installed(env, name)?.some(entry => entry.version === update.latestVersion))
        throw new Error(`${name} is not at ${update.latestVersion} after the host update`);
    const outcome = { status: 'updated', ...base, plugins, announced: false };
    await record(dir, outcome);
    return outcome;
  } catch (error) {
    // Put the old source back so the host and the folder agree again; the installed plugin was
    // either left alone or is refreshed from the restored folder on the next attempt.
    if (swapped) {
      try {
        await fs.rm(staging, { recursive: true, force: true });
        await fs.rename(source, staging); await fs.rename(previous, source);
        await fs.rm(staging, { recursive: true, force: true });
        await runCommand(binary, ['plugin', 'marketplace', 'update', 'zira'], env).catch(() => {});
      } catch {}
    } else await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    const outcome = { status: 'failed', ...base, error: String(error.message).slice(0, 300) };
    await record(dir, outcome).catch(() => {});
    return outcome;
  } finally { await fs.rm(lock, { force: true }).catch(() => {}); }
}

// Start the updater without waiting for it: the hook returns at once and the session is never held.
export function startInBackground({ env = process.env, spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), 'run'],
      { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref?.();
    return true;
  } catch { return false; }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command = 'status', ...rest] = process.argv.slice(2);
  if (rest.length || !['run', 'status', 'on', 'off', 'help'].includes(command)) { console.error('Use plugin-self-update.mjs run|status|on|off|help'); process.exitCode = 2; }
  else if (command === 'help') console.log('Automatic updates for the public Zira plugin in Claude Code. run installs a newer public release now; status shows whether automatic updates apply here and the last result; on/off switches them. ZIRA_AUTO_UPDATE=0 also switches them off.');
  else if (command === 'on' || command === 'off') console.log(JSON.stringify(setAutoUpdate(command === 'on')));
  else if (command === 'status') {
    const where = target();
    console.log(JSON.stringify({ automaticUpdates: autoUpdateEnabled() ? 'on' : 'off', managed: where.managed,
      ...(where.managed ? { plugins: where.plugins } : { reason: where.reason }), last: lastOutcome() }));
  } else {
    try { console.log(JSON.stringify(await selfUpdate())); }
    catch (error) { console.log(JSON.stringify({ status: 'failed', error: String(error.message).slice(0, 300) })); }
  }
}
