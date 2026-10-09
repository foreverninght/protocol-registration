'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { setTimeout: delay } = require('node:timers/promises');
const { loadConfig } = require('../src/app/config');
const { RegistrationRunner } = require('../src/registration/runner');
const { MailComRegistrationControl } = require('../src/mailbox/mail-com-registration-control');
const { waitForVerificationCode } = require('../src/mailbox/mailbox-poller');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

class MemoryRegistrationStore {
  constructor() {
    this.jobs = new Map([1, 2].map((index) => {
      const job = {
        id: `synthetic-job-${index}`, accountId: `synthetic-account-${index}`,
        email: `account${index}@example.test`, status: 'queued', mode: 'register',
        mailboxSource: 'share_page', mailboxUrl: `https://mail.example.test/inbox/${index}`,
        registrationPassword: `dummy-password-${index}`, entryBranch: 'freepp',
        proxyPoolId: 'synthetic-pool',
      };
      return [job.id, job];
    }));
    this.events = new Map([...this.jobs.keys()].map((id) => [id, []]));
  }

  async claimNextJob({ workerId, mode }) {
    const job = [...this.jobs.values()].find((item) => item.status === 'queued' && (!mode || item.mode === mode));
    if (!job) return null;
    Object.assign(job, { status: 'running', claimedBy: workerId });
    return structuredClone(job);
  }

  async loadJob({ jobId }) { return structuredClone(this.jobs.get(jobId)); }

  async appendEvent({ jobId, event }) {
    const job = this.jobs.get(jobId);
    this.events.get(jobId).push(structuredClone(event));
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      if (event.status) job.status = event.status === 'succeeded' ? 'completed' : event.status;
      if (event.step) job.step = event.step;
    }
  }
}

class MemoryAccountAssetStore {
  constructor(registrations, failPersistence) {
    this.registrations = registrations;
    this.failPersistence = failPersistence;
    this.accounts = new Map();
    this.progress = new Map();
    this.completions = [];
    this.abandoned = [];
  }

  async saveProgress({ jobId, patch }) {
    if (this.failPersistence && jobId === 'synthetic-job-1') {
      throw Object.assign(new Error('synthetic persistence failure'), { code: 'SYNTHETIC_WRITE_FAILED' });
    }
    this.progress.set(jobId, structuredClone(patch));
    this.accounts.set(jobId, structuredClone(patch));
  }

  async completeRegistration({ jobId, account, event }) {
    assert.equal(this.registrations.jobs.get(jobId).status, 'running');
    assert.ok(this.progress.has(jobId), 'progress must be persisted before completion');
    this.accounts.set(jobId, structuredClone({ ...account, status: 'registered' }));
    this.completions.push(jobId);
    await this.registrations.appendEvent({
      jobId, event: { ...event, type: 'registration.completed', status: 'succeeded', step: 'completed' },
    });
  }

  async getByJob(jobId) { return structuredClone(this.accounts.get(jobId) || null); }
  async transitionWorkflow({ jobId, stage }) {
    this.accounts.get(jobId).workflowStage = stage;
  }
  async abandonScratchByEmail(email) { this.abandoned.push(email); }
}

async function until(predicate, description) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    await delay(5);
  }
}

function fixture(t, { concurrency = 2, retryProxy = false, failPersistence = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-registration-'));
  const registrations = new MemoryRegistrationStore();
  const assets = new MemoryAccountAssetStore(registrations, failPersistence);
  const runtime = new MemoryRuntimeStateStore();
  const networkAttempts = [];
  const denyNetwork = () => {
    networkAttempts.push('blocked');
    throw Object.assign(new Error('external network forbidden by synthetic test'), { retryableProxy: false });
  };
  for (const [owner, method] of [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net.Socket.prototype, 'connect'], [tls, 'connect'],
  ]) t.mock.method(owner, method, denyNetwork);

  const deliveries = new Map();
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://mail.example.test');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('refresh'), '1');
    assert.match(url.pathname, /^\/inbox\/[12]$/);
    fetches.push(url.pathname);
    const message = deliveries.get(url.pathname);
    return new Response(JSON.stringify({ messages: message ? [message] : [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  const proxyChecks = [];
  const selections = [];
  const quarantined = [];
  const attempts = new Map();
  const consumed = new Map();
  const waiting = new Set();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const proxies = [1, 2].map((index) => ({
    id: `synthetic-proxy-${index}`, host: 'proxy.example.test', port: 9000 + index,
    poolId: 'synthetic-pool', country: 'US',
  }));
  const config = { ...loadConfig({}), dataDir, profile: 'registration-only' };
  const runner = new RegistrationRunner({
    config, registrationStore: registrations, accountAssetStore: assets,
    mailboxStore: {}, runtimeStateStore: runtime,
    changeEmailSettings: { getSecretConfig: () => ({
      setupPassword: true, setupTotp2fa: true, validateOauthSession: true,
    }) },
    proxyPools: { main: {
      listPools: () => [{ id: 'synthetic-pool', countries: ['US'] }],
      async pickNext({ excludeIds }) {
        const proxy = proxies.find((item) => !excludeIds.includes(item.id));
        selections.push({ excludeIds: [...excludeIds], selected: proxy?.id });
        return proxy || null;
      },
      async markBad(id) { quarantined.push(id); return { cooldownUntil: '2099-01-01T00:00:00Z' }; },
      async markChecked() {},
    } },
    proxyQualityChecker: async (proxy, options) => {
      proxyChecks.push(proxy.id);
      assert.equal(options.expectedCountry, 'US');
      return { geo: { ip: '192.0.2.1', countryCode: 'US', timezone: 'America/New_York', latencyMs: 1 } };
    },
    freeppRegistrationRunner: async ({ task, mailbox, proxy, startedAt, update, entryBranch }) => {
      assert.equal(entryBranch, 'freepp');
      assert.equal(mailbox.source, 'share_page');
      assert.equal(typeof mailbox.provider?.listMessages, 'function');
      const attempt = (attempts.get(task.id) || 0) + 1;
      attempts.set(task.id, attempt);
      const index = task.id.endsWith('-1') ? 1 : 2;
      const inboxPath = `/inbox/${index}`;
      const messageId = `${task.id}-message-${attempt}`;
      const code = String(410000 + index * 100 + attempt);
      const baseline = await mailbox.provider.listMessages({ email: task.email });
      deliveries.set(inboxPath, {
        id: messageId, subject: 'Your temporary ChatGPT verification code',
        from: 'OpenAI <noreply@example.test>', text: `Your verification code is ${code}`,
        date: new Date(Math.max(Date.now(), startedAt) + 1).toISOString(),
      });
      const found = await waitForVerificationCode({
        provider: mailbox.provider, email: task.email, after: startedAt,
        seenIds: baseline.map((mail) => mail.id), timeoutMs: 1000, intervalMs: 250, onEvent: update,
      });
      assert.equal(found.code, code);
      assert.equal(found.mail.id, messageId);
      consumed.set(task.id, [...(consumed.get(task.id) || []), found.mail.id]);
      if (retryProxy && index === 1 && attempt === 1) {
        assert.equal(proxy.id, 'synthetic-proxy-1');
        throw Object.assign(new Error('synthetic proxy connection reset'), { code: 'PROXY_CONNECT_FAILED' });
      }
      waiting.add(task.id);
      await gate;
      return {
        email: task.email, password: task.registrationPassword, passwordStatus: 'has_password',
        accessToken: `dummy-access-${index}`, refreshToken: `dummy-refresh-${index}`,
        sessionToken: `dummy-session-${index}`, totpSecret: index === 1 ? 'JBSWY3DPEHPK3PXP' : 'GEZDGNBVGY3TQOJQ',
        oauthSession: { cookies: [{ name: 'oai-client-auth-session', value: `dummy-oauth-${index}`, domain: 'auth.example.test', path: '/' }] },
      };
    },
  });
  const control = new MailComRegistrationControl({
    mailboxStore: { async getPoolSettings() { return { concurrency, enabled: false, targetCount: 0 }; } },
    registrationStore: registrations, runner, queueSource: '',
  });
  t.after(async () => {
    control.stop();
    release();
    await until(() => control.activeRuns.size === 0 && !control.dbDrainRunning, 'queue cleanup');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { registrations, assets, runtime, runner, control, release, waiting, attempts, consumed, fetches,
    selections, proxyChecks, quarantined, networkAttempts };
}

function assertSaved(f, index) {
  const id = `synthetic-job-${index}`;
  assert.equal(f.registrations.jobs.get(id).status, 'completed');
  const account = f.assets.accounts.get(id);
  assert.ok(account, 'account must be persisted');
  assert.equal(account.email, `account${index}@example.test`);
  assert.equal(account.lastTaskId, id);
  assert.equal(account.status, 'registered');
  assert.equal(account.password, `dummy-password-${index}`);
  assert.equal(account.passwordStatus, 'has_password');
  assert.equal(account.hasTotp, true);
  assert.equal(account.totpSecret, index === 1 ? 'JBSWY3DPEHPK3PXP' : 'GEZDGNBVGY3TQOJQ');
  assert.equal(account.tokens.accessToken, `dummy-access-${index}`);
  assert.equal(account.tokens.refreshToken, `dummy-refresh-${index}`);
  assert.equal(account.tokens.sessionToken, `dummy-session-${index}`);
  assert.equal(account.sessionAvailable, true);
  assert.equal(account.session.sourceTaskId, id);
  assert.ok(account.session.cookies.some((cookie) => cookie.name === '__Secure-next-auth.session-token' && cookie.value === `dummy-session-${index}`));
  assert.equal(account.oauthSessionAvailable, true);
  assert.equal(account.oauthSession.cookies[0].value, `dummy-oauth-${index}`);
  assert.equal(f.assets.progress.get(id).tokens.accessToken, `dummy-access-${index}`);
  const events = f.registrations.events.get(id);
  assert.ok(events.some((event) => event.type === 'mailbox.code_found' && event.email === account.email));
  assert.equal(events.filter((event) => event.type === 'registration.completed').length, 1);
  assert.ok(f.runtime.evidence.get(id).some((event) => event.type === 'registration.completed'));
}

test('full protocol flow automatically reads two mailboxes concurrently, retries proxy, and persists separate credential assets', { timeout: 10000 }, async (t) => {
  const f = fixture(t, { retryProxy: true });
  assert.equal((await f.control.drainDatabaseQueue()).claimed, 2);
  await until(() => f.waiting.size === 2, 'two live protocol flows waiting after automatic OTP');
  assert.equal(f.control.activeRuns.size, 2);
  assert.equal(f.runner.running.size, 2);
  assert.equal((await f.control.drainDatabaseQueue()).claimed, 0);
  assert.equal(f.assets.accounts.size, 0);
  assert.deepEqual([...f.attempts.values()].sort(), [1, 2]);
  f.release();
  await until(() => f.control.activeRuns.size === 0 && !f.control.dbDrainRunning, 'both completed tasks release slots');
  assert.equal(f.runner.running.size, 0);
  assert.equal(f.control.lastError, null);
  assertSaved(f, 1);
  assertSaved(f, 2);
  assert.equal(f.assets.accounts.size, 2);
  assert.equal(f.assets.completions.length, 2);
  assert.equal(f.consumed.get('synthetic-job-1').length, 2);
  assert.equal(f.consumed.get('synthetic-job-2').length, 1);
  assert.equal(f.fetches.length, 6);
  assert.equal(f.proxyChecks.length, 3);
  assert.deepEqual(f.quarantined, ['synthetic-proxy-1']);
  assert.ok(f.selections.some((selection) => selection.selected === 'synthetic-proxy-2' && selection.excludeIds.includes('synthetic-proxy-1')));
  assert.equal(f.assets.accounts.get('synthetic-job-1').registrationEnvironment.proxyAttempt, 2);
  assert.equal(f.assets.accounts.get('synthetic-job-2').registrationEnvironment.proxyAttempt, 1);
  assert.equal(f.registrations.events.get('synthetic-job-1').filter((event) => event.type === 'registration.retrying_proxy').length, 1);
  assert.deepEqual(f.networkAttempts, []);
});

test('persistence failure prevents success and proxy replay, then releases the queue slot for the next automatic registration', { timeout: 10000 }, async (t) => {
  const f = fixture(t, { concurrency: 1, failPersistence: true });
  assert.equal((await f.control.drainDatabaseQueue()).claimed, 1);
  await until(() => f.waiting.size === 1, 'first protocol flow reaches automatic OTP');
  assert.equal(f.control.activeRuns.size, 1);
  assert.equal(f.registrations.jobs.get('synthetic-job-2').status, 'queued');
  assert.equal(f.attempts.has('synthetic-job-2'), false);
  f.release();
  await until(() => f.registrations.jobs.get('synthetic-job-2').status === 'completed' && f.control.activeRuns.size === 0 && !f.control.dbDrainRunning, 'failed task releases slot and queue continues');
  assert.equal(f.registrations.jobs.get('synthetic-job-1').status, 'failed');
  assert.equal(f.assets.accounts.has('synthetic-job-1'), false);
  assert.deepEqual(f.assets.abandoned, ['account1@example.test']);
  assert.deepEqual(f.assets.completions, ['synthetic-job-2']);
  assert.equal(f.attempts.get('synthetic-job-1'), 1);
  assert.equal(f.attempts.get('synthetic-job-2'), 1);
  const events = f.registrations.events.get('synthetic-job-1');
  assert.ok(events.some((event) => event.type === 'registration.failed' && event.error.code === 'SYNTHETIC_WRITE_FAILED'));
  assert.equal(events.some((event) => event.type === 'registration.completed' || event.type === 'registration.retrying_proxy'), false);
  assertSaved(f, 2);
  assert.equal(f.control.lastError, null);
  assert.equal(f.runner.running.size, 0);
  assert.equal(f.proxyChecks.length, 2);
  assert.deepEqual(f.quarantined, []);
  assert.deepEqual(f.networkAttempts, []);
});
