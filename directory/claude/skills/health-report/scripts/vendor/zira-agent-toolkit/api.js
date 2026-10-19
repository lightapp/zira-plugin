import { getProfile, saveProfile, credentialsPath } from './credentials.js';
import { refreshTokens, tokenNeedsRefresh, validateApiBase, validateOAuthEndpoint } from './auth.js';

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

const authenticatedUrl = (apiBaseUrl, requestPath) => {
  const base = new URL(`${apiBaseUrl.replace(/\/$/, '')}/`);
  const url = new URL(requestPath.replace(/^\//, ''), base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error(`Refusing to send credentials outside ${base.origin}`);
  }
  return url;
};

const send = (url, { method, headers, body, profile, fetchImpl }) => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Authorization', profile.idToken);
  requestHeaders.set('Accept', requestHeaders.get('Accept') || 'application/json');
  return fetchImpl(url, {
    method,
    headers: requestHeaders,
    body,
    redirect: 'manual'
  });
};

export const ziraRequest = async (requestPath, {
  method = 'GET',
  headers = {},
  body,
  profileName = 'prod',
  credentialsFile = credentialsPath(),
  fetchImpl = globalThis.fetch
} = {}) => {
  let profile = await loadAuthenticatedProfile({ profileName, credentialsFile, fetchImpl });
  const url = authenticatedUrl(profile.apiBaseUrl, requestPath);
  const request = { method: method.toUpperCase(), headers, body, profile, fetchImpl };
  let response = await send(url, request);

  if (response.status === 401) {
    profile = await loadAuthenticatedProfile({
      profileName,
      credentialsFile,
      fetchImpl,
      forceRefresh: true
    });
    response = await send(url, { ...request, profile });
  }

  return response;
};
