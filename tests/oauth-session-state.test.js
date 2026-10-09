'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hasUsableOauthSession, oauthSessionState } = require('../src/session/account-login-state');

test('OAuth session validity requires an unexpired structured auth cookie', () => {
  const now = Date.parse('2026-08-29T00:00:00.000Z');
  assert.equal(hasUsableOauthSession({
    cookies: [{ name: 'oai-client-auth-session', value: 'session', expires: now / 1000 + 60 }],
  }, now), true);
  assert.deepEqual(oauthSessionState({
    cookies: [{ name: 'oai-client-auth-session', value: 'session', expires: now / 1000 - 1 }],
  }, now), { stored: true, available: false, expired: true, status: 'expired' });
  assert.equal(hasUsableOauthSession({ cookie: 'oai-client-auth-session=legacy-string' }, now), false);
});
