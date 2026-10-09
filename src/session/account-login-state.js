'use strict';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCookie(cookie, fallbackDomain = '') {
  if (!isRecord(cookie)) return null;
  const name = String(cookie.name || '').trim();
  const value = String(cookie.value || '').trim();
  if (!name || !value) return null;
  const domain = String(cookie.domain || fallbackDomain || '').trim();
  if (!domain) return null;
  return {
    ...cookie,
    name,
    value,
    domain,
    path: String(cookie.path || '/').trim() || '/',
    secure: cookie.secure !== false,
  };
}

function cookiesFromHeader(header, domain) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return normalizeCookie({
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        domain,
        path: '/',
        secure: true,
      });
    })
    .filter(Boolean);
}

function cookieDedupeKey(cookie = {}) {
  return [
    String(cookie.domain || '').trim().replace(/^\./u, '').toLowerCase(),
    String(cookie.name || '').trim(),
    String(cookie.path || '/').trim() || '/',
  ].join('\n');
}

function oauthSessionState(oauthSession, nowMs = Date.now()) {
  const cookies = Array.isArray(oauthSession?.cookies) ? oauthSession.cookies : [];
  const authCookies = cookies.filter((cookie) => (
    String(cookie?.name || '').trim() === 'oai-client-auth-session'
      && Boolean(String(cookie?.value || '').trim())
  ));
  if (!authCookies.length) return { stored: false, available: false, expired: false, status: 'missing' };
  const explicit = String(oauthSession?.validationStatus || '').trim().toLowerCase();
  if (['expired', 'invalid', 'revoked'].includes(explicit)) {
    return { stored: true, available: false, expired: true, status: explicit };
  }
  const nowSeconds = nowMs / 1000;
  const available = authCookies.some((cookie) => {
    const expires = Number(cookie.expires ?? cookie.expirationDate ?? 0);
    return !Number.isFinite(expires) || expires <= 0 || expires > nowSeconds;
  });
  return {
    stored: true,
    available,
    expired: !available,
    status: available ? 'stored' : 'expired',
  };
}

function hasUsableOauthSession(oauthSession, nowMs = Date.now()) {
  return oauthSessionState(oauthSession, nowMs).available;
}

function addCookieSource(target, seen, cookies, { fallbackDomain = '', overrideExisting = true } = {}) {
  if (!Array.isArray(cookies)) return;
  for (const raw of cookies) {
    const cookie = normalizeCookie(raw, fallbackDomain);
    if (!cookie) continue;
    const key = cookieDedupeKey(cookie);
    const existingIndex = target.findIndex((item) => cookieDedupeKey(item) === key);
    if (existingIndex >= 0) {
      if (overrideExisting) target[existingIndex] = cookie;
      seen.add(key);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(cookie);
  }
}

function buildAccountLoginState(account = {}, { includeSessionContextHeader = true } = {}) {
  const sessionContext = isRecord(account.sessionContext) ? account.sessionContext : {};
  const cookies = [];
  const seen = new Set();
  if (includeSessionContextHeader) {
    addCookieSource(cookies, seen, cookiesFromHeader(sessionContext.cookie, 'chatgpt.com'));
  }
  addCookieSource(cookies, seen, Array.isArray(account.oauthSession?.cookies) ? account.oauthSession.cookies : []);
  // The structured browser jar is updated whenever the live browser rotates a
  // cookie.  It must win over the older raw header and OAuth snapshot.
  addCookieSource(cookies, seen, Array.isArray(account.session?.cookies) ? account.session.cookies : []);

  const userAgent = String(
    sessionContext.userAgent
      || sessionContext.user_agent
      || account.registrationEnvironment?.userAgent
      || account.registrationEnvironment?.user_agent
      || '',
  ).trim();
  const oaiDeviceId = String(
    sessionContext.oaiDeviceId
      || sessionContext.oai_device_id
      || sessionContext.deviceId
      || sessionContext.device_id
      || '',
  ).trim();
  const accessToken = String(account.tokens?.accessToken || account.accessToken || '').trim();
  const refreshToken = String(account.tokens?.refreshToken || account.refreshToken || '').trim();
  return {
    email: String(account.email || '').trim().toLowerCase(),
    cookies,
    sessionCookies: Array.isArray(account.session?.cookies) ? account.session.cookies : [],
    oauthCookies: Array.isArray(account.oauthSession?.cookies) ? account.oauthSession.cookies : [],
    sessionContext,
    sessionContextCookie: String(sessionContext.cookie || '').trim(),
    userAgent,
    oaiDeviceId,
    accessToken,
    refreshToken,
    proxy: account.registrationEnvironment?.proxy || null,
    proxyPoolId: account.registrationEnvironment?.proxyPoolId || null,
    hasChatgptSessionCookie: cookies.some((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./u, '').toLowerCase();
      return domain === 'chatgpt.com' && /next-auth\.session-token/u.test(String(cookie.name || ''));
    }),
    hasOauthClientSessionCookie: cookies.some((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./u, '').toLowerCase();
      return domain === 'auth.openai.com' && String(cookie.name || '') === 'oai-client-auth-session';
    }),
  };
}

function cookieDomainCounts(cookies = []) {
  const counts = {};
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const domain = String(cookie?.domain || '').trim() || '(missing)';
    counts[domain] = (counts[domain] || 0) + 1;
  }
  return counts;
}

function summarizeAccountLoginState(state = {}) {
  return {
    email: state.email || '',
    cookieCount: Array.isArray(state.cookies) ? state.cookies.length : 0,
    cookieDomains: cookieDomainCounts(state.cookies),
    sessionCookieCount: Array.isArray(state.sessionCookies) ? state.sessionCookies.length : 0,
    oauthCookieCount: Array.isArray(state.oauthCookies) ? state.oauthCookies.length : 0,
    sessionContextCookiePresent: Boolean(state.sessionContextCookie),
    sessionContextCookieLength: String(state.sessionContextCookie || '').length,
    userAgentPresent: Boolean(state.userAgent),
    oaiDeviceIdPresent: Boolean(state.oaiDeviceId),
    accessTokenPresent: Boolean(state.accessToken),
    refreshTokenPresent: Boolean(state.refreshToken),
    hasChatgptSessionCookie: Boolean(state.hasChatgptSessionCookie),
    hasOauthClientSessionCookie: Boolean(state.hasOauthClientSessionCookie),
    proxyPresent: Boolean(state.proxy),
    proxyPoolId: state.proxyPoolId || null,
  };
}

function accountLoginStateSummary(account = {}, options = {}) {
  return summarizeAccountLoginState(buildAccountLoginState(account, options));
}

module.exports = {
  normalizeCookie,
  cookiesFromHeader,
  buildAccountLoginState,
  summarizeAccountLoginState,
  accountLoginStateSummary,
  oauthSessionState,
  hasUsableOauthSession,
};
