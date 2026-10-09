'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureBrowserSigninRequest,
  replaySigninInBrowserContext,
  requestUrlHasBrowserContext,
} = require('../src/registration/steps/context-protocol-email-entry');

const COMPLETE_SIGNIN_URL = 'https://chatgpt.com/api/auth/signin/openai?auth_session_logging_id=log-1&ext-oai-did=did-1&login_hint=test%40example.com';

test('context protocol requires browser-generated signin identifiers', () => {
  assert.equal(requestUrlHasBrowserContext(COMPLETE_SIGNIN_URL), true);
  assert.equal(requestUrlHasBrowserContext('https://chatgpt.com/api/auth/signin/openai?login_hint=test%40example.com'), false);
});

test('context protocol captures and aborts the real browser signin request', async () => {
  let handler = null;
  let unrouteHandler = null;
  let aborted = false;
  const request = {
    method: () => 'POST',
    url: () => COMPLETE_SIGNIN_URL,
    headers: () => ({ accept: 'application/json', cookie: 'secret=1' }),
    postData: () => 'csrfToken=csrf&json=true',
  };
  const page = {
    async route(_pattern, value) { handler = value; },
    async unroute(_pattern, value) { unrouteHandler = value; },
  };
  const captured = await captureBrowserSigninRequest({
    page,
    timeoutMs: 1000,
    click: async () => handler({
      request: () => request,
      async abort() { aborted = true; },
    }),
  });
  assert.equal(captured.url, COMPLETE_SIGNIN_URL);
  assert.equal(captured.postData, 'csrfToken=csrf&json=true');
  assert.equal(aborted, true);
  assert.equal(unrouteHandler, handler);
});

test('context protocol accepts only successful replay with authorize url', async () => {
  const page = {
    async evaluate() {
      return {
        status: 200,
        url: 'https://chatgpt.com/api/auth/signin/openai',
        json: { url: 'https://auth.openai.com/authorize?state=real-state' },
        bodySample: '',
      };
    },
  };
  const result = await replaySigninInBrowserContext({
    page,
    request: { method: 'POST', url: COMPLETE_SIGNIN_URL, headers: {}, postData: 'csrfToken=csrf&json=true' },
    timeoutMs: 1000,
  });
  assert.equal(result.status, 200);
  assert.match(result.authorizeUrl, /^https:\/\/auth\.openai\.com\/authorize/u);
});

test('context protocol rejects replay without authorize url', async () => {
  const page = {
    async evaluate() {
      return { status: 200, json: {}, bodySample: '{}' };
    },
  };
  await assert.rejects(
    replaySigninInBrowserContext({
      page,
      request: { method: 'POST', url: COMPLETE_SIGNIN_URL, headers: {}, postData: 'csrfToken=csrf&json=true' },
      timeoutMs: 1000,
    }),
    { code: 'CONTEXT_PROTOCOL_SIGNIN_FAILED' },
  );
});
