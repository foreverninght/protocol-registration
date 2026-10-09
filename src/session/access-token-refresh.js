'use strict';

const { restoreSessionWithCookies } = require('./restore-session');
const { cookieHeaderFromCookies } = require('./session-cookie-renewal');
const { buildAccountLoginState } = require('./account-login-state');

class AccessTokenRefreshError extends Error {
  constructor(message, { code = 'ACCESS_TOKEN_REFRESH_FAILED', status = null } = {}) {
    super(message);
    this.name = 'AccessTokenRefreshError';
    this.code = code;
    this.status = status;
    this.retryableProxy = false;
  }
}

async function refreshAccountAccessToken({ config, accountStore, email, proxy = null }) {
  if (!accountStore) throw new TypeError('accountStore is required');
  const account = await accountStore.getByEmail(email, { includeSecret: true });
  if (!account) throw new AccessTokenRefreshError('account was not found', { code: 'ACCESS_TOKEN_ACCOUNT_NOT_FOUND' });
  const loginState = buildAccountLoginState(account);
  if (!loginState.cookies.length && !account.session?.cookies?.length) {
    throw new AccessTokenRefreshError('account has no saved session cookies', { code: 'ACCESS_TOKEN_SESSION_MISSING' });
  }
  let restored = null;
  try {
    restored = await restoreSessionWithCookies({
      config,
      proxy,
      cookies: loginState.cookies.length ? loginState.cookies : account.session.cookies,
      expectedEmail: email,
      collectorFactory: null,
    });
    const refreshedAt = new Date().toISOString();
    await accountStore.updateByEmail({ email, patch: {
      status: account.status || 'registered',
      session: { ...account.session, cookies: restored.cookies, refreshedAt },
      sessionContext: {
        ...(account.sessionContext || {}),
        cookie: cookieHeaderFromCookies(restored.cookies),
        refreshedAt,
      },
      tokens: { ...(account.tokens || {}), accessToken: restored.accessToken, refreshedAt },
      accessTokenLastRefreshedAt: refreshedAt,
      sessionAvailable: true,
    } });
    return {
      refreshedAt,
      sessionStatus: restored.sessionStatus,
      email: restored.email,
      accessToken: restored.accessToken,
      accessTokenAvailable: Boolean(restored.accessToken),
    };
  } finally {
    await restored?.browserSession?.close?.().catch(() => {});
  }
}

module.exports = {
  AccessTokenRefreshError,
  refreshAccountAccessToken,
};
