'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openChatgptHome } = require('../src/registration/steps/open-chatgpt');

function response(status) {
  return { status: () => status };
}

test('browser waits for a detected Cloudflare challenge to clear', async () => {
  const pages = [
    '<script src="/cdn-cgi/challenge-platform/orchestrate"></script>',
    '<script>window._cf_chl_opt = {}</script>',
    '<html><body><main>ChatGPT login</main></body></html>',
  ];
  const page = {
    async goto() { return response(403); },
    async content() { return pages.shift() || '<main>ChatGPT login</main>'; },
    url() { return 'https://chatgpt.com/auth/login'; },
  };

  const result = await openChatgptHome({
    page,
    timeoutMs: 30000,
    challengeTimeoutMs: 2000,
    challengePollMs: 1,
    sleep: async () => {},
  });

  assert.equal(result.challengeResolved, true);
  assert.equal(result.status, null);
});

test('browser rejects an ordinary HTTP error without challenge waiting', async () => {
  const page = {
    async goto() { return response(403); },
    async content() { return '<html><body>Forbidden</body></html>'; },
  };
  await assert.rejects(
    openChatgptHome({ page, timeoutMs: 30000 }),
    { code: 'CHATGPT_HOME_HTTP_ERROR' },
  );
});

test('browser rejects a challenge that does not clear within the bounded window', async () => {
  const page = {
    async goto() { return response(403); },
    async content() { return '<script>window._cf_chl_opt = {}</script>'; },
  };
  await assert.rejects(
    openChatgptHome({
      page,
      timeoutMs: 30000,
      challengeTimeoutMs: 5,
      challengePollMs: 1,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    }),
    { code: 'CHATGPT_HOME_CHALLENGE_TIMEOUT' },
  );
});
