'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  accountSessionCookieHeader,
  mergedSessionCookiePatch,
  mergeCookieHeaders,
  renewAccountSessionCookie,
  sessionTokenFromHeader,
} = require('../src/session/session-cookie-renewal');
const { buildAccountLoginState } = require('../src/session/account-login-state');

test('renewed session cookie overwrites both stored cookie locations', () => {
  const account = {
    session: {
      cookies: [
        { name: 'oai-did', value: 'device', domain: '.chatgpt.com', path: '/' },
        { name: '__Secure-next-auth.session-token', value: 'old-token', domain: '.chatgpt.com', path: '/' },
      ],
    },
    sessionContext: {
      cookie: 'oai-did=device; __Secure-next-auth.session-token=old-token; other=value',
    },
  };
  const patch = mergedSessionCookiePatch(account, {
    renewed_at: '2026-08-21T18:00:00Z',
    session_cookie: {
      value: 'new-token',
      expires: 1795111200,
      domain: '.chatgpt.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  }, 'old-token');
  assert.equal(
    patch.session.cookies.find((cookie) => cookie.name === '__Secure-next-auth.session-token').value,
    'new-token',
  );
  assert.equal(sessionTokenFromHeader(patch.sessionContext.cookie), 'new-token');
  assert.equal(patch.sessionContext.cookie.includes('old-token'), false);
  assert.equal(accountSessionCookieHeader(patch).includes('new-token'), true);
});


test('cookie sources are merged without dropping raw-header-only cookies', () => {
  const account = {
    session: {
      cookies: [
        { name: '__Secure-next-auth.session-token', value: 'jar-token', domain: '.chatgpt.com', path: '/' },
        { name: 'jar-only', value: 'jar-value', domain: '.chatgpt.com', path: '/' },
      ],
    },
    sessionContext: {
      cookie: 'raw-only=raw-value; __Secure-next-auth.session-token=stale-token; another=kept',
    },
  };
  const merged = accountSessionCookieHeader(account);
  assert.equal(merged.includes('raw-only=raw-value'), true);
  assert.equal(merged.includes('another=kept'), true);
  assert.equal(merged.includes('jar-only=jar-value'), true);
  assert.equal(sessionTokenFromHeader(merged), 'jar-token');
  assert.equal(merged.includes('stale-token'), false);
});

test('renewal updates only the session token and preserves cookies from both sources', () => {
  const account = {
    session: {
      cookies: [
        { name: '__Secure-next-auth.session-token', value: 'old-token', domain: '.chatgpt.com', path: '/' },
      ],
    },
    sessionContext: {
      cookie: 'csrf=csrf-value; route=route-value; __Secure-next-auth.session-token=old-token',
    },
  };
  const patch = mergedSessionCookiePatch(account, {
    renewed_at: '2026-08-22T00:00:00Z',
    session_cookie: {
      value: 'renewed-token',
      expires: 1795111200,
      domain: '.chatgpt.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  }, 'old-token');
  assert.equal(sessionTokenFromHeader(patch.sessionContext.cookie), 'renewed-token');
  assert.equal(patch.sessionContext.cookie.includes('csrf=csrf-value'), true);
  assert.equal(patch.sessionContext.cookie.includes('route=route-value'), true);
  assert.equal(patch.sessionContext.cookie.includes('old-token'), false);
});

test('mergeCookieHeaders lets the later source override only matching names', () => {
  assert.equal(
    mergeCookieHeaders('a=1; b=old; c=3', 'b=new; d=4'),
    'a=1; b=new; c=3; d=4',
  );
});

test('browser restore prefers the latest structured cookie over a stale raw header', () => {
  const state = buildAccountLoginState({
    session: {
      cookies: [
        { name: '__Secure-next-auth.session-token', value: 'fresh-token', domain: '.chatgpt.com', path: '/' },
      ],
    },
    sessionContext: {
      cookie: '__Secure-next-auth.session-token=stale-token; raw-only=kept',
    },
  });
  const sessionCookie = state.cookies.find((cookie) => cookie.name === '__Secure-next-auth.session-token');
  assert.equal(sessionCookie.value, 'fresh-token');
  assert.equal(state.cookies.some((cookie) => cookie.name === 'raw-only' && cookie.value === 'kept'), true);
});

test('renewal commits through the async account store with optimistic locking', async () => {
  const account = {
    email: 'renew@example.com',
    version: 4,
    session: {
      cookies: [{
        name: '__Secure-next-auth.session-token',
        value: 'old-token',
        domain: '.chatgpt.com',
        path: '/',
      }],
    },
    sessionContext: {},
    registrationEnvironment: { proxy: { id: 'proxy-1', poolId: 'pool-1' } },
  };
  const updates = [];
  const accountStore = {
    async getByEmail() { return structuredClone(account); },
    async updateByEmail(input) { updates.push(input); },
  };
  const proxy = { id: 'proxy-1', poolId: 'pool-1', country: 'US' };
  const proxyPools = {
    main: {
      listPools: () => [{ id: 'pool-1' }],
      listRaw: () => [proxy],
      pick: () => null,
    },
  };

  const result = await renewAccountSessionCookie({
    config: {},
    accountStore,
    proxyPools,
    email: account.email,
    renewalRunner: async () => ({
      ok: true,
      renewed_at: '2026-08-29T00:00:00.000Z',
      access_token: 'new-access-token',
      session_cookie: {
        name: '__Secure-next-auth.session-token',
        value: 'new-token',
        domain: '.chatgpt.com',
        path: '/',
        maxAge: 3600,
      },
    }),
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].email, account.email);
  assert.equal(updates[0].expectedVersion, 4);
  assert.equal(sessionTokenFromHeader(updates[0].patch.sessionContext.cookie), 'new-token');
  assert.equal(updates[0].patch.tokens.accessToken, 'new-access-token');
  assert.equal(result.maxAgeSeconds, 3600);
  assert.equal(result.cookieChanged, true);
});

test('renewal exposes an account version race as a session change conflict', async () => {
  const account = {
    email: 'race@example.com',
    version: 2,
    session: {
      cookies: [{
        name: '__Secure-next-auth.session-token',
        value: 'old-token',
        domain: '.chatgpt.com',
        path: '/',
      }],
    },
    registrationEnvironment: { proxy: { id: 'proxy-1', poolId: 'pool-1' } },
  };
  const accountStore = {
    async getByEmail() { return structuredClone(account); },
    async updateByEmail() {
      const error = new Error('version changed');
      error.code = 'ACCOUNT_VERSION_CONFLICT';
      throw error;
    },
  };
  const proxyPools = {
    main: {
      listPools: () => [{ id: 'pool-1' }],
      listRaw: () => [{ id: 'proxy-1', poolId: 'pool-1' }],
      pick: () => null,
    },
  };

  await assert.rejects(renewAccountSessionCookie({
    config: {},
    accountStore,
    proxyPools,
    email: account.email,
    renewalRunner: async () => ({
      session_cookie: {
        name: '__Secure-next-auth.session-token',
        value: 'new-token',
        domain: '.chatgpt.com',
        path: '/',
      },
    }),
  }), { code: 'SESSION_COOKIE_CHANGED_DURING_RENEWAL' });
});
