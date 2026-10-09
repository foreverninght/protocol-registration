'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkProxyGeo } = require('../src/proxies/proxy-geo-preflight');
const { createSharePageMailboxProvider } = require('../src/mailbox/providers/share-page-provider');

test('proxy geo preflight enforces an absolute deadline before socket assignment', async () => {
  let destroyed = false;
  function request() {
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = (error) => {
      destroyed = true;
      req.emit('error', error);
    };
    return req;
  }

  const startedAt = Date.now();
  await assert.rejects(
    checkProxyGeo({ host: 'stalled.proxy', port: 8080 }, { timeoutMs: 30, request }),
    (error) => error.code === 'PROXY_GEO_TIMEOUT',
  );
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(destroyed, true);
});

test('share page provider parses the refreshed HTML response without a stale fallback request', async () => {
  const calls = [];
  const html = '<time>2026-09-21 15:26:08</time><pre>Your temporary ChatGPT verification code 123456</pre>';
  const provider = createSharePageMailboxProvider({
    shareUrl: 'https://mailbox.example/messages/token/address',
    async fetchImpl(url) {
      calls.push(String(url));
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });

  const messages = await provider.listMessages();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /[?&]refresh=1/u);
  assert.match(calls[0], /[?&]_=/u);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /123456/u);
});

test('mailbox polling accepts a new message whose second-resolution timestamp precedes the request baseline', async () => {
  const { waitForVerificationCode } = require('../src/mailbox/mailbox-poller');
  const after = Date.parse('2026-09-21T08:23:46.569Z');
  const result = await waitForVerificationCode({
    provider: {
      async listMessages() {
        return [{
          id: 'new-mail',
          receivedAt: '2026-09-21T08:23:44.000Z',
          subject: 'Your temporary ChatGPT verification code',
          sender: 'ChatGPT',
          text: '654321',
        }];
      },
    },
    email: 'alias@example.com',
    after,
    seenIds: ['old-mail'],
    seenCodes: ['123456'],
    timeoutMs: 1000,
    intervalMs: 250,
  });
  assert.equal(result.code, '654321');
});

test('server resumes recovered registration jobs through the shared queue after constructing the runner', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'server.js'), 'utf8');
  assert.match(source, /const recoveredRegistrationJobs = await registrationStore.recoverExpiredJobs/);
  const runnerOffset = source.indexOf('const runner = new RegistrationRunner');
  const queueOffset = source.indexOf('mailComRegistrationControl = new MailComRegistrationControl');
  const pollingOffset = source.indexOf('mailComRegistrationControl.startQueuePolling()');
  assert.ok(runnerOffset >= 0);
  assert.ok(queueOffset > runnerOffset);
  assert.ok(pollingOffset > queueOffset);
  assert.match(source.slice(queueOffset, pollingOffset), /runner,|runner:/);
});

test('job recovery includes previously queued retry_waiting jobs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'registration-store.js'), 'utf8');
  assert.match(source, /where status = 'retry_waiting'[\s\S]+?next_run_at <= now()/u);
  assert.ok(source.includes('if (!recovered.includes(job.id)) recovered.push(job.id)'));
});
