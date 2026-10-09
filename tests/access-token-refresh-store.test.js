'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  refreshAccountAccessToken,
} = require('../src/session/access-token-refresh');
const {
  rotateOpenAiRefreshToken,
} = require('../src/session/refresh-token-rotation');

test('refresh token rotation uses OAuth form encoding and preserves rotated credentials', async () => {
  let request;
  const result = await rotateOpenAiRefreshToken({
    refreshToken: 'old-rt',
    clientId: 'client-test',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), {
    grant_type: 'refresh_token',
    refresh_token: 'old-rt',
    client_id: 'client-test',
  });
  assert.equal(result.accessToken, 'new-at');
  assert.equal(result.refreshToken, 'new-rt');
});

test('refresh token rotation classifies a reused token without exposing its value', async () => {
  await assert.rejects(
    rotateOpenAiRefreshToken({
      refreshToken: 'secret-old-rt',
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: 'refresh_token_reused', message: 'refresh token reused' },
      }), { status: 400, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => {
      assert.equal(error.code, 'REFRESH_TOKEN_REUSED');
      assert.equal(error.message, 'refresh token reused');
      assert.equal(error.message.includes('secret-old-rt'), false);
      return true;
    },
  );
});

test('access token refresh requires the database account store contract', async () => {
  await assert.rejects(
    refreshAccountAccessToken({ email: 'missing@example.com' }),
    { name: 'TypeError', message: 'accountStore is required' },
  );
});

test('access token refresh reads secret account state asynchronously', async () => {
  const calls = [];
  const accountStore = {
    async getByEmail(email, options) {
      calls.push({ email, options });
      return null;
    },
  };

  await assert.rejects(
    refreshAccountAccessToken({ accountStore, email: 'missing@example.com' }),
    { code: 'ACCESS_TOKEN_ACCOUNT_NOT_FOUND' },
  );
  assert.deepEqual(calls, [{
    email: 'missing@example.com',
    options: { includeSecret: true },
  }]);
});

test('access token refresh reports missing persisted cookies before opening a browser', async () => {
  const accountStore = {
    async getByEmail() {
      return { email: 'no-session@example.com', session: { cookies: [] } };
    },
  };

  await assert.rejects(
    refreshAccountAccessToken({ accountStore, email: 'no-session@example.com' }),
    { code: 'ACCESS_TOKEN_SESSION_MISSING' },
  );
});
