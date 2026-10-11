#!/usr/bin/env node
// Package-local tool discovery and explicit dependency setup. No Zira or GitHub access.
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildInfo } from '../../../scripts/build-info.mjs';
const bundled = fileURLToPath(new URL('../tool/', import.meta.url));
const checkout = fileURLToPath(new URL('../../../../../tools/opencv-ring-inspector/', import.meta.url));
export function resolveTool(override) {
  if (override && buildInfo().audience === 'public') throw new Error('Tool overrides require an internal developer build.');
  // A packaged build must never silently fall back to nearby source if damaged.
  const packaged = buildInfo().channel !== 'local';
  const directory = override ? path.resolve(override) : packaged || existsSync(bundled) ? bundled : checkout;
  for (const name of ['inspect_rings.py', 'inspect_grain.py', 'inspect_motion.py', 'grain_review.html', 'grain_review.js', 'requirements.txt', 'README.md'])
    if (!existsSync(path.join(directory, name))) throw new Error(`Missing ${name}. Reinstall the complete Zira package; no private checkout is needed for packaged builds.`);
  return directory;
}
export function runtimeStatus({ runtime, toolRoot, run = spawnSync } = {}) {
  const tool = resolveTool(toolRoot);
  runtime = path.resolve(runtime || path.join(os.homedir(), '.cache/zira/inspect-nail-images/runtime'));
  const python = path.join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const requirements = path.join(tool, 'requirements.txt');
  const versions = Object.fromEntries(readFileSync(requirements, 'utf8').split('\n').filter(line => /^[\w-]+==/.test(line)).map(line => line.trim().split('==')));
  const probe = run(python, ['-c', 'import json,sys,cv2,numpy; from importlib.metadata import version; print(json.dumps({"python":sys.version.split()[0],"numpy":version("numpy"),"opencv-python-headless":version("opencv-python-headless")}))'], { encoding: 'utf8', timeout: 10000 });
  let installed = null;
  try { if (probe.status === 0) installed = JSON.parse(probe.stdout); } catch { /* invalid runtime */ }
  const ready = Boolean(installed && Object.entries(versions).every(([key, value]) => installed[key] === value));
  return { kind: 'inspect-nail-images-runtime', ready, tool, readme: path.join(tool, 'README.md'), requirements, runtime, python, installed,
    ...(ready ? {} : { next: 'Install Python 3.12, then run this helper with setup --python PATH. This downloads the pinned packages into a dedicated environment; ask before setup.' }) };
}
export function setup(options = {}) {
  const status = runtimeStatus(options);
  if (status.ready) return status;
  // Refuse an existing incompatible environment: never change another feature's dependencies.
  if (existsSync(status.runtime)) throw new Error('The runtime folder already exists but has different or incomplete dependencies. Choose a new --runtime directory.');
  const python = options.python || 'python3.12';
  const probe = spawnSync(python, ['-c', 'import sys; assert sys.version_info >= (3,10)'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('Python 3.10+ is required (3.12 tested). Install Python and pass --python PATH.');
  if (status.runtime === status.tool || status.runtime.startsWith(buildInfo().pluginRoot)) throw new Error('Keep the runtime outside the replaceable plugin.');
  for (const [command, args] of [[python, ['-m', 'venv', status.runtime]], [status.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', status.requirements]]]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) throw new Error('Dependency setup failed. Check the diagnostic above; use a new runtime folder when retrying.');
  }
  const result = runtimeStatus(options);
  if (!result.ready) throw new Error('Installed dependency versions do not match the pinned requirements.');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { runtime: { type: 'string' }, python: { type: 'string' }, 'tool-root': { type: 'string' } } });
    const options = { ...values, toolRoot: values['tool-root'] };
    if (!['status', 'setup'].includes(positionals[0])) throw new Error('Use status or setup [--python PATH] [--runtime DIRECTORY]; --tool-root is for internal developers only.');
    console.log(JSON.stringify(positionals[0] === 'setup' ? setup(options) : runtimeStatus(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
