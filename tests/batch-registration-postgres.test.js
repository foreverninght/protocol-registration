'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { Client, Pool } = require('pg');
const { migrate } = require('../tools/migrate');
const { loadConfig } = require('../src/app/config');
const { RegistrationStore } = require('../src/db/registration-store');
const { AccountAssetStore } = require('../src/db/account-asset-store');
const { MailboxStore } = require('../src/db/mailbox-store');
const { RuntimeStateStore } = require('../src/db/runtime-state-store');
const { RegistrationRunner } = require('../src/registration/runner');
const { MailComRegistrationControl } = require('../src/mailbox/mail-com-registration-control');
const { waitForVerificationCode } = require('../src/mailbox/mailbox-poller');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';
const databaseOptions = {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
  timeout: 60000,
};

async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    await delay(10);
  }
}

async function withDatabase(run) {
  const url = new URL(connectionString);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'fixture database must be loopback');
  for (const key of ['host', 'hostaddr', 'port', 'service', 'options']) {
    assert.equal(url.searchParams.has(key), false, `fixture URL must not override ${key}`);
  }
  const fixtureId = randomUUID().replaceAll('-', '');
  const databaseName = `batch_registration_${fixtureId}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  let created = false;
  let pool;
  let dataDir;
  try {
    await admin.connect();
    await admin.query(`create database "${databaseName}" template template0`);
    created = true;
    url.pathname = `/${databaseName}`;
    url.search = '';
    const isolatedUrl = url.toString();
    await migrate(isolatedUrl);
    pool = new Pool({ connectionString: isolatedUrl, max: 12, connectionTimeoutMillis: 5000 });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-batch-registration-'));
    await run({
      fixtureId, dataDir, pool, databasePort: Number(url.port || 5432),
      registrations: new RegistrationStore({ pool }),
      assets: new AccountAssetStore({ pool }),
      mailboxes: new MailboxStore({ pool }),
      runtime: new RuntimeStateStore({ pool }),
    });
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) await admin.query(`drop database "${databaseName}"`);
      } finally {
        try { await admin.end(); }
        finally { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); }
      }
    }
  }
}

function blockNonDatabaseNetwork(t, databasePort) {
  const attempts = [];
  const deny = () => {
    attempts.push('unexpected network');
    throw Object.assign(new Error('synthetic fixture forbids external network'), { retryableProxy: false });
  };
  for (const owner of [http, https]) {
    t.mock.method(owner, 'request', deny);
    t.mock.method(owner, 'get', deny);
  }
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof values[0] === 'object'
      ? values[0] : { port: values[0], host: values[1] };
    if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)
      || Number(options.port) !== databasePort) return deny();
    return connect.apply(this, args);
  });
  return attempts;
}

async function assertBatchSaved(f, inputs, consumed) {
  for (const input of inputs) {
    const job = await f.registrations.loadJob({ jobId: input.id, includeEvents: true });
    const account = await f.assets.getByJob(input.id, { includeSecret: true });
    assert.equal(job.status, 'completed');
    assert.equal(job.attemptCount, 1, 'proxy retry retains the same job claim');
    assert.ok(job.completedAt);
    assert.equal(job.leaseExpiresAt, null);
    assert.equal(account.email, input.email);
    assert.equal(account.lastTaskId, input.id);
    assert.equal(account.status, 'registered');
    assert.equal(account.password, input.registrationPassword);
    assert.equal(account.passwordStatus, 'has_password');
    assert.equal(account.hasTotp, true);
    assert.equal(account.totpSecret, input.totpSecret);
    assert.equal(account.tokens.accessToken, `synthetic-access-${input.id}`);
    assert.equal(account.tokens.refreshToken, `synthetic-refresh-${input.id}`);
    assert.equal(account.tokens.sessionToken, `synthetic-session-${input.id}`);
    assert.equal(account.sessionAvailable, true);
    assert.ok(account.session.cookies.some((cookie) => cookie.name === '__Secure-next-auth.session-token'
      && cookie.value === `synthetic-session-${input.id}`));
    assert.equal(account.oauthSessionAvailable, true);
    assert.equal(account.oauthSession.cookies[0].value, `synthetic-oauth-${input.id}`);
    assert.equal(job.events.filter((event) => event.type === 'registration.completed').length, 1);
    assert.equal(job.events.filter((event) => event.type === 'mailbox.code_found' && event.email === input.email).length,
      input.index === 1 ? 2 : 1);
    assert.equal(job.events.filter((event) => event.type === 'registration.retrying_proxy').length,
      input.index === 1 ? 1 : 0);
    assert.deepEqual(job.events.map((event) => event.sequence), job.events.map((_, index) => index + 1));
    const evidence = await f.runtime.listEvidence({ taskId: input.id });
    assert.equal(evidence.filter((event) => event.type === 'registration.completed').length, 1);
    assert.ok(evidence.some((event) => event.type === 'mailbox.code_found'));
    assert.ok(fs.existsSync(path.join(f.dataDir, 'evidence', input.id)));
    assert.equal(consumed.get(input.id).length, input.index === 1 ? 2 : 1);
    assert.equal(new Set(consumed.get(input.id)).size, consumed.get(input.id).length);
  }
  const count = await f.pool.query('select count(*)::int as count from accounts where email = any($1::text[])',
    [inputs.map((input) => input.email)]);
  assert.equal(count.rows[0].count, 3);
}

test('PostgreSQL global queue atomically claims mixed-source jobs once across independent stores', databaseOptions, async () => {
  await withDatabase(async (f) => {
    const sources = ['manual', 'share_page', 'icloud_sheex'];
    const jobs = await Promise.all(sources.map((mailboxSource, index) => f.registrations.createJob({
      id: randomUUID(), email: `synthetic-claim-${f.fixtureId}-${index}@example.test`,
      registrationPassword: 'synthetic-claim-password', mailboxSource,
      mailboxUrl: mailboxSource === 'manual' ? null : `https://mail.example.test/claim/${f.fixtureId}/${index}`,
    })));
    const stores = Array.from({ length: 12 }, () => new RegistrationStore({ pool: f.pool }));
    const results = await Promise.all(stores.map((store, index) => store.claimNextJob({
      mailboxSource: '', workerId: `atomic-fixture:${f.fixtureId}:${index}`,
    })));
    const claimed = results.filter(Boolean);
    assert.equal(claimed.length, 3);
    assert.equal(new Set(claimed.map((job) => job.id)).size, 3);
    assert.deepEqual(claimed.map((job) => job.id).sort(), jobs.map((job) => job.id).sort());
    assert.deepEqual(claimed.map((job) => job.mailboxSource).sort(), sources.sort());
    for (const job of claimed) {
      const persisted = await f.registrations.loadJob({ jobId: job.id });
      assert.equal(persisted.status, 'running');
      assert.equal(persisted.claimedBy, job.claimedBy);
      assert.equal(persisted.attemptCount, 1);
      assert.ok(new Date(persisted.leaseExpiresAt).getTime() > Date.now());
      assert.equal(await f.registrations.claimJob({ jobId: job.id, workerId: 'duplicate-fixture' }), null);
    }
    assert.equal(await f.registrations.claimNextJob({ workerId: 'empty-fixture' }), null);
  });
});

test('PostgreSQL batch runs three automatic mailbox flows concurrently and persists credentials after proxy retry', databaseOptions, async (t) => {
  await withDatabase(async (f) => {
    const networkAttempts = blockNonDatabaseNetwork(t, f.databasePort);
    const inputs = [1, 2, 3].map((index) => ({
      id: randomUUID(), index,
      email: `synthetic-${f.fixtureId}-${index}@example.test`,
      mailboxSource: 'share_page',
      mailboxUrl: `https://mail.example.test/inbox/${f.fixtureId}/${index}`,
      registrationPassword: `synthetic-password-${f.fixtureId}-${index}`,
      totpSecret: ['JBSWY3DPEHPK3PXP', 'GEZDGNBVGY3TQOJQ', 'MFRGGZDFMZTWQ2LK'][index - 1],
    }));
    const byId = new Map(inputs.map((input) => [input.id, input]));
    const deliveries = new Map();
    const fetches = [];
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://mail.example.test');
      assert.ok(inputs.some((item) => new URL(item.mailboxUrl).pathname === url.pathname));
      assert.equal(url.searchParams.get('format'), 'json');
      assert.equal(url.searchParams.get('refresh'), '1');
      fetches.push(url.pathname);
      return new Response(JSON.stringify({ messages: deliveries.get(url.pathname) || [] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const attempts = new Map();
    const consumed = new Map();
    const waiting = new Set();
    const quarantined = [];
    const selections = [];
    const proxyChecks = [];
    const errors = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const proxies = [1, 2].map((index) => ({
      id: `synthetic-proxy-${index}`, host: 'proxy.example.test', port: 9000 + index,
      poolId: 'synthetic-pool', country: 'US',
    }));
    const config = loadConfig({});
    const runner = new RegistrationRunner({
      config: { ...config, dataDir: f.dataDir, profile: 'registration-only',
        browser: { ...config.browser, maxProxyAttempts: 2 } },
      registrationStore: f.registrations, accountAssetStore: f.assets,
      mailboxStore: f.mailboxes, runtimeStateStore: f.runtime,
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
      freeppRegistrationRunner: syntheticProtocol,
    });
    const control = new MailComRegistrationControl({
      mailboxStore: f.mailboxes, registrationStore: f.registrations, runner, queueSource: '',
      workerId: `batch-fixture:${f.fixtureId}`, onError: (error) => errors.push(error),
    });
    async function syntheticProtocol({ task, mailbox, proxy, startedAt, update, entryBranch }) {
      const input = byId.get(task.id);
      assert.ok(input, 'protocol only receives this fixture batch');
      assert.equal(task.email, input.email);
      assert.equal(entryBranch, 'freepp');
      assert.equal(mailbox.source, 'share_page');
      assert.equal(typeof mailbox.provider?.listMessages, 'function');
      const attempt = (attempts.get(task.id) || 0) + 1;
      attempts.set(task.id, attempt);
      const inboxPath = new URL(input.mailboxUrl).pathname;
      const baseline = await mailbox.provider.listMessages({ email: task.email });
      const syntheticCode = String(410000 + input.index * 100 + attempt);
      const messageId = `${task.id}-synthetic-message-${attempt}`;
      const message = {
        id: messageId, subject: 'Your temporary ChatGPT verification code',
        from: 'OpenAI <noreply@example.test>', text: `Your verification code is ${syntheticCode}`,
        date: new Date(Math.max(Date.now(), startedAt) + 1).toISOString(),
      };
      deliveries.set(inboxPath, [...(deliveries.get(inboxPath) || []), message]);
      const found = await waitForVerificationCode({
        provider: mailbox.provider, email: task.email, after: startedAt,
        seenIds: baseline.map((mail) => mail.id), timeoutMs: 1000, intervalMs: 250, onEvent: update,
      });
      assert.equal(found.code, syntheticCode);
      assert.equal(found.mail.id, messageId);
      consumed.set(task.id, [...(consumed.get(task.id) || []), found.mail.id]);
      if (input.index === 1 && attempt === 1) {
        assert.equal(proxy.id, 'synthetic-proxy-1');
        throw Object.assign(new Error('synthetic proxy connection reset'), { code: 'PROXY_CONNECT_FAILED' });
      }
      if (input.index === 1) assert.equal(proxy.id, 'synthetic-proxy-2');
      waiting.add(task.id);
      await gate;
      return {
        email: task.email, password: task.registrationPassword, passwordStatus: 'has_password',
        accessToken: `synthetic-access-${task.id}`, refreshToken: `synthetic-refresh-${task.id}`,
        sessionToken: `synthetic-session-${task.id}`, totpSecret: input.totpSecret,
        oauthSession: { cookies: [{ name: 'oai-client-auth-session',
          value: `synthetic-oauth-${task.id}`, domain: 'auth.example.test', path: '/' }] },
      };
    }
    try {
      await f.mailboxes.updatePoolSettings({ enabled: false, targetCount: 3, concurrency: 3 });
      const imported = await f.registrations.importCandidates(inputs);
      assert.equal(imported.imported.length, 3);
      assert.deepEqual(imported.existing, []);
      assert.equal((await f.registrations.listCandidates()).length, 3);
      const jobs = await Promise.all(inputs.map((input) => f.registrations.createJob({
        ...input, entryBranch: 'freepp', proxyPoolId: 'synthetic-pool',
      })));
      assert.ok(jobs.every((job) => job.status === 'queued'));
      assert.equal(new Set(jobs.map((job) => job.accountId)).size, 3);
      assert.equal((await f.registrations.listCandidates()).length, 0);
      const started = await f.registrations.listCandidates({ status: 'started' });
      assert.deepEqual(started.map((item) => item.generatedTaskId).sort(), inputs.map((item) => item.id).sort());
      assert.equal((await control.drainDatabaseQueue()).claimed, 3);
      await until(() => waiting.size === 3, 'three concurrent automatic OTP flows');
      assert.equal(control.activeRuns.size, 3);
      assert.equal(runner.running.size, 3);
      assert.equal((await control.drainDatabaseQueue()).claimed, 0);
      for (const input of inputs) {
        const job = await f.registrations.loadJob({ jobId: input.id });
        assert.equal(job.claimedBy, control.workerId);
        assert.equal(job.attemptCount, 1);
        assert.notEqual(job.status, 'completed');
        assert.equal((await f.assets.getByJob(input.id)).accessTokenAvailable, false);
      }
      assert.deepEqual(inputs.map((item) => attempts.get(item.id)), [2, 1, 1]);
      release();
      await until(() => !control.activeRuns.size && !control.dbDrainRunning && !control.mailboxRepairCheckRunning,
        'all database completions and follow-up drains');
      assert.equal(runner.running.size, 0);
      assert.equal(control.lastError, null);
      assert.deepEqual(errors, []);
      await assertBatchSaved(f, inputs, consumed);
      assert.equal(fetches.length, 8);
      assert.equal(proxyChecks.length, 4);
      assert.deepEqual(quarantined, ['synthetic-proxy-1']);
      assert.ok(selections.some((item) => item.selected === 'synthetic-proxy-2'
        && item.excludeIds.includes('synthetic-proxy-1')));
      assert.deepEqual(networkAttempts, []);
      assert.equal((await f.registrations.registrationSummary()).completed, 3);
    } finally {
      control.stop();
      release();
      await until(() => !control.activeRuns.size && !control.dbDrainRunning && !control.mailboxRepairCheckRunning,
        'fixture runners stop before database removal');
    }
  });
});
