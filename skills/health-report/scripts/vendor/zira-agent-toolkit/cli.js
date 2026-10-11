import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import process from 'node:process';

import { getAuthorizationToken, ziraRequest } from './api.js';
import {
  authorizationUrl,
  createPkce,
  createState,
  decodeJwt,
  exchangeAuthorizationCode,
  fetchAgentConfig,
  startCallbackServer,
  tokenNeedsRefresh
} from './auth.js';
import { credentialsPath, getProfile, readStore, removeProfile, saveProfile } from './credentials.js';

const HELP = `Zira agent toolkit

Usage:
  zira login [--profile prod|integ] [--no-browser] [--prompt-login]
  zira token [--profile prod|integ] [--type id|access] [--header]
  zira request [METHOD] PATH [--data JSON|--data-file FILE] [--header NAME:VALUE]
  zira status [--profile prod|integ]
  zira profiles
  zira logout [--profile prod|integ]

Environment:
  ZIRA_CREDENTIALS_FILE  Override the credentials file
  ZIRA_CONFIG_DIR        Override the credentials directory

Examples:
  zira login
  zira request GET /users/me
  zira request POST /tasks --data '{"name":"Inspect line 1"}'
  curl -H "Authorization: $(zira token)" https://api.zira.us/users/me
`;

const takeOption = (args, name, { repeat = false } = {}) => {
  const values = [];
  for (let index = 0; index < args.length;) {
    const argument = args[index];
    if (argument === name) {
      if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
      values.push(args[index + 1]);
      args.splice(index, 2);
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
      args.splice(index, 1);
    } else {
      index += 1;
    }
  }
  return repeat ? values : values.at(-1);
};

const takeFlag = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
};

const profileOption = (args) => takeOption(args, '--profile') || process.env.ZIRA_PROFILE || 'prod';

const assertNoArguments = (args) => {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
};

export const launchBrowser = async (url, { platform = process.platform, spawnImpl = spawn, env = process.env } = {}) => {
  const commands = platform === 'darwin'
    ? [['open', [url]]]
    : platform === 'win32'
      // Keep the URL out of shell source, including &, quotes, $() and percent signs.
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:ZIRA_BROWSER_URL"]]]
      : [['xdg-open', [url]]];

  for (const [command, arguments_] of commands) {
    const launched = await new Promise((resolve) => {
      const child = spawnImpl(command, arguments_, {
        detached: platform !== 'win32', stdio: 'ignore', shell: false, windowsHide: true,
        env: platform === 'win32' ? { ...env, ZIRA_BROWSER_URL: url } : env,
      });
      if (platform === 'win32') child.once('exit', code => resolve(code === 0));
      else child.once('spawn', () => {
        // xdg-open can stay alive until the browser closes. Preserve non-blocking login.
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    });
    if (launched) return true;
  }
  return false;
};

const login = async (args) => {
  const profileName = profileOption(args);
  const noBrowser = takeFlag(args, '--no-browser');
  const promptLogin = takeFlag(args, '--prompt-login');
  const timeoutSeconds = Number(takeOption(args, '--timeout') || 300);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  assertNoArguments(args);

  process.stderr.write(`Loading Zira ${profileName} login configuration...\n`);
  const config = await fetchAgentConfig({ profile: profileName });
  const pkce = createPkce();
  const state = createState();
  const nonce = createState();
  const callback = await startCallbackServer({
    redirectUri: config.redirectUri,
    expectedState: state,
    timeoutMs: timeoutSeconds * 1000
  });
  const url = authorizationUrl(config, { challenge: pkce.challenge, state, nonce, promptLogin });

  if (!noBrowser && await launchBrowser(url)) {
    process.stderr.write('Browser opened. Complete sign-in to continue.\n');
  } else {
    process.stderr.write(`Open this URL to sign in:\n${url}\n`);
  }

  let claims;
  try {
    const code = await callback.wait;
    const tokens = await exchangeAuthorizationCode(config, code, pkce.verifier);
    const profile = { ...config, ...tokens };
    claims = decodeJwt(profile.idToken);
    if (claims.nonce !== nonce) {
      throw new Error('The ID token nonce did not match the login request');
    }

    const userName = claims.email || claims['cognito:username'] || claims.sub || 'Zira user';
    await callback.confirm(userName);
    await saveProfile(profileName, profile);
  } catch (error) {
    callback.fail(error instanceof Error ? error.message : 'Login could not be completed.');
    throw error;
  } finally {
    callback.close();
  }

  process.stdout.write(`${claims.email || claims['cognito:username'] || claims.sub || 'Zira user'} logged in (${profileName}).\n`);
  return 0;
};

const token = async (args) => {
  const profileName = profileOption(args);
  const tokenType = takeOption(args, '--type') || 'id';
  const includeHeader = takeFlag(args, '--header');
  if (!['id', 'access'].includes(tokenType)) throw new Error('--type must be id or access');
  assertNoArguments(args);

  const value = await getAuthorizationToken({ profileName, tokenType });
  process.stdout.write(`${includeHeader ? 'Authorization: ' : ''}${value}\n`);
  return 0;
};

const parseHeaders = (values) => {
  const headers = new Headers();
  for (const value of values) {
    const separator = value.indexOf(':');
    if (separator <= 0) throw new Error(`Invalid header: ${value}`);
    const name = value.slice(0, separator).trim();
    if (name.toLowerCase() === 'authorization') {
      throw new Error('Authorization is managed by the Zira toolkit');
    }
    headers.append(name, value.slice(separator + 1).trim());
  }
  return headers;
};

const request = async (args) => {
  const profileName = profileOption(args);
  const data = takeOption(args, '--data');
  const dataFile = takeOption(args, '--data-file');
  const headerValues = takeOption(args, '--header', { repeat: true });
  const output = takeOption(args, '--output') || 'body';
  if (data !== undefined && dataFile !== undefined) {
    throw new Error('Use only one of --data and --data-file');
  }
  if (!['body', 'json'].includes(output)) throw new Error('--output must be body or json');

  let method = 'GET';
  if (args[0] && /^[A-Za-z]+$/.test(args[0]) && args[1]) {
    method = args.shift().toUpperCase();
  }
  const requestPath = args.shift();
  if (!requestPath) throw new Error('request requires a path');
  assertNoArguments(args);

  let body = data;
  if (dataFile === '-') {
    body = await new Promise((resolve, reject) => {
      let contents = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { contents += chunk; });
      process.stdin.on('end', () => resolve(contents));
      process.stdin.on('error', reject);
    });
  } else if (dataFile) {
    body = await fs.readFile(dataFile, 'utf8');
  }

  const headers = parseHeaders(headerValues);
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await ziraRequest(requestPath, { method, headers, body, profileName });
  const responseBody = await response.text();
  if (output === 'json') {
    let parsedBody = responseBody;
    try { parsedBody = responseBody ? JSON.parse(responseBody) : null; } catch { /* keep text */ }
    process.stdout.write(`${JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: parsedBody
    }, null, 2)}\n`);
  } else if (responseBody) {
    process.stdout.write(responseBody.endsWith('\n') ? responseBody : `${responseBody}\n`);
  }
  if (!response.ok) {
    process.stderr.write(`Zira API returned HTTP ${response.status}.\n`);
    return 1;
  }
  return 0;
};

const status = async (args) => {
  const profileName = profileOption(args);
  assertNoArguments(args);
  const profile = await getProfile(profileName);
  if (!profile) {
    process.stdout.write(`${JSON.stringify({ profile: profileName, loggedIn: false }, null, 2)}\n`);
    return 1;
  }
  const claims = decodeJwt(profile.idToken);
  process.stdout.write(`${JSON.stringify({
    profile: profileName,
    loggedIn: true,
    needsRefresh: tokenNeedsRefresh(profile),
    user: claims.email || claims['cognito:username'] || claims.sub,
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : profile.expiresAt
  }, null, 2)}\n`);
  return 0;
};

const profiles = async (args) => {
  assertNoArguments(args);
  const store = await readStore(credentialsPath());
  const result = Object.entries(store.profiles).map(([name, profile]) => ({
    name,
    user: decodeJwt(profile.idToken).email || decodeJwt(profile.idToken)['cognito:username'],
    needsRefresh: tokenNeedsRefresh(profile)
  }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
};

const logout = async (args) => {
  const profileName = profileOption(args);
  assertNoArguments(args);
  const removed = await removeProfile(profileName);
  process.stdout.write(removed ? `Logged out (${profileName}).\n` : `Profile "${profileName}" was not logged in.\n`);
  return 0;
};

export const run = async (arguments_) => {
  const args = [...arguments_];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('0.1.0\n');
    return 0;
  }

  const commands = { login, token, request, status, profiles, logout };
  if (!commands[command]) {
    throw new Error(`Unknown command "${command}". Run \`zira help\` for usage.`);
  }
  return commands[command](args);
};
