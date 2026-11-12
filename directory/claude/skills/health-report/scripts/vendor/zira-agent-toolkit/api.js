import { getProfile, saveProfile, credentialsPath } from './credentials.js';
import { refreshTokens, tokenNeedsRefresh, validateApiBase, validateOAuthEndpoint } from './auth.js';
import { AGENT_ROUTES } from './routes.js';
import { runtimeAgentPacer } from './pacing-ipc.js';
import { AgentPacingError } from './pacing.js';
export { AGENT_ROUTES } from './routes.js';
const routeParameters = {
  incidentId: '[a-f0-9]{64}',
  id: '[1-9]\\d*', fileId: '[1-9]\\d*', deviceId: '[1-9]\\d*', jobId: '[1-9]\\d*', modelId: '[1-9]\\d*',
  day: '\\d{4}-\\d{2}-\\d{2}', session: '(?:\\d{4}-\\d{2}-\\d{2}-)?\\d{2}-\\d{2}(?:-\\d{2})?'
};
const agentRoutePatterns = AGENT_ROUTES.map(route => {
  const [method, pathname] = route.split(' ');
  return [route, method, new RegExp(`^${pathname.replace(/\{([^}]+)\}/g, (_, key) => routeParameters[key])}$`)];
});

export class AgentRouteUnavailableError extends Error {
  constructor() {
    super('This operation is unavailable through agent sign-in; no API request was sent. Continue in Zira if supported.');
    this.name = 'AgentRouteUnavailableError';
    this.code = 'AGENT_ROUTE_UNAVAILABLE';
  }
}

// This is the sole customer-data URL boundary, shared by the CLI and plugin.
// Callers supply logical root-relative paths, never already-prefixed/absolute URLs.
// Validate before credentials are loaded; never normalize traversal into an allowed route.
export const resolveAgentRoute = (apiBaseUrl, requestPath, { method = 'GET', profileName } = {}) => {
  const origin = validateApiBase(apiBaseUrl, profileName);
  if (typeof requestPath !== 'string' || typeof method !== 'string' ||
      !requestPath.startsWith('/') || requestPath.startsWith('//') || /[\u0000-\u0020\u007f#\\]/.test(requestPath))
    throw new AgentRouteUnavailableError();
  const pathname = requestPath.split('?')[0];
  const segments = pathname.slice(1).split('/');
  if (!/^[A-Za-z0-9/_.:-]+$/.test(pathname) || segments.some(s => !s || s === '.' || s === '..') ||
      segments[1] === 'agent')
    throw new AgentRouteUnavailableError();
  const match = agentRoutePatterns.find(([, m, pattern]) => m === method.toUpperCase() && pattern.test(pathname));
  if (!match) throw new AgentRouteUnavailableError();
  const url = new URL(requestPath, origin);
  url.pathname = `/${segments[0]}/agent/${segments.slice(1).join('/')}`;
  return { url, origin, route: match[0] };
};
export const agentApiUrl = (...args) => resolveAgentRoute(...args).url;

const loadAuthenticatedProfile = async ({
  profileName = 'prod',
  credentialsFile = credentialsPath(),
  fetchImpl = globalThis.fetch,
  forceRefresh = false
} = {}) => {
  let profile = await getProfile(profileName, credentialsFile);
  if (!profile) {
    throw new Error(`Profile "${profileName}" is not logged in; run \`zira login --profile ${profileName}\``);
  }

  // Cached metadata is untrusted too, including when the ID token is still fresh.
  validateApiBase(profile.apiBaseUrl, profileName);
  validateOAuthEndpoint(profile.tokenEndpoint, 'tokenEndpoint', profileName);

  if (forceRefresh || tokenNeedsRefresh(profile)) {
    try {
      profile = await refreshTokens(profile, fetchImpl);
      await saveProfile(profileName, profile, credentialsFile);
    } catch (error) {
      throw new Error(`Unable to refresh profile "${profileName}"; run \`zira login --profile ${profileName}\` again`, {
        cause: error
      });
    }
  }
  return profile;
};

export const getAuthorizationToken = async (options = {}) => {
  const profile = await loadAuthenticatedProfile(options);
  return options.tokenType === 'access' ? profile.accessToken : profile.idToken;
};

const send = (url, { method, headers, body, profile, fetchImpl }) => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Authorization', profile.idToken);
  requestHeaders.set('Accept', requestHeaders.get('Accept') || 'application/json');
  return fetchImpl(url, {
    method,
    headers: requestHeaders,
    body,
    redirect: 'manual',
    // Starts after route pacing and credential preparation. Plugin fetch wrappers
    // replace this with their own dispatch-time deadline after any local queue.
    signal: AbortSignal.timeout(30000)
  });
};

export const ziraRequest = async (requestPath, {
  method = 'GET',
  headers = {},
  body,
  profileName = 'prod',
  credentialsFile = credentialsPath(),
  fetchImpl = globalThis.fetch,
  pacer,
  signal
} = {}) => {
  // The profile pins are validated again against cached metadata below. Mapping first
  // also prevents unsupported routes from reading credentials or refreshing a session.
  const origin = profileName === 'integ' ? 'https://integ.api.zira.us' : 'https://api.zira.us';
  const { url, route } = resolveAgentRoute(origin, requestPath, { method, profileName });
  const routePacer = pacer ?? runtimeAgentPacer();
  const request = { method: method.toUpperCase(), headers, body, fetchImpl };
  const refreshFetch = (url, options) => {
    routePacer.assertAvailable?.();
    return fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) });
  };
  const attempt = forceRefresh => routePacer.run({ origin, route }, async () => {
    // Prepare credentials after the route wait. OAuth itself is not route-paced.
    fetchImpl.assertAvailable?.();
    const profile = await loadAuthenticatedProfile({ profileName, credentialsFile, fetchImpl: refreshFetch, forceRefresh });
    fetchImpl.assertAvailable?.();
    routePacer.assertAvailable?.();
    if (signal?.aborted) throw new AgentPacingError();
    return send(url, { ...request, profile });
  }, { signal });
  let response = await attempt(false);

  if (response.status === 401 && request.method === 'GET') {
    await response.body?.cancel();
    response = await attempt(true);
  }

  return response;
};
