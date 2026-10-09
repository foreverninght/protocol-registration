'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { MailboxStore } = require('../src/db/mailbox-store');
const { RegistrationRunner } = require('../src/registration/runner');
const {
  legacyMailComDomainProjection,
  restoreLegacyMailComDomains,
} = require('../tools/restore_legacy_mail_com_domains');

test('automatic alias reservation is owned by the database and excludes both blacklists', async () => {
  let reservationSql = '';
  const client = {
    async query(sql) {
      if (/^\s*(begin|commit|rollback)\s*$/iu.test(sql)) return { rows: [] };
      reservationSql = sql;
      return { rows: [{ domain: 'hidden.example', state: 'hidden', last_alias_created_at: new Date() }] };
    },
    release() {},
  };
  const store = new MailboxStore({ pool: { async connect() { return client; } } });

  const selected = await store.reserveMailComDomain();

  assert.equal(selected.domain, 'hidden.example');
  assert.match(reservationSql, /d\.state = 'hidden'/u);
  assert.match(reservationSql, /coalesce\(f\.blacklisted, false\) = false/u);
  assert.match(reservationSql, /coalesce\(f\.no_trial_blacklisted, false\) = false/u);
});

test('legacy projection restores the three lists without generic failure inference', () => {
  const projected = legacyMailComDomainProjection({
    domains: ['manual.example'],
    sharedAvailableDomains: [
      { domain: 'active.example', state: 'ACTIVE' },
      { domain: 'hidden.example', state: 'DEACTIVATED' },
      { domain: 'blocked.example', state: 'UNKNOWN' },
    ],
    domainFailures: {
      'ignored.example': { consecutiveFailures: 99, lastFailureKind: 'proxy' },
      'blocked.example': {
        consecutiveFailures: 20,
        consecutiveOtpTimeoutTasks: 2,
        blacklisted: true,
        lastFailureKind: 'otp_timeout',
      },
    },
  });
  assert.deepEqual(projected.domains, [
    { domain: 'active.example', state: 'active' },
    { domain: 'blocked.example', state: 'hidden' },
    { domain: 'hidden.example', state: 'hidden' },
    { domain: 'manual.example', state: 'active' },
  ]);
  assert.deepEqual(projected.failures.map((entry) => ({
    domain: entry.domain,
    count: entry.consecutiveOtpTimeoutTasks,
    blacklisted: entry.blacklisted,
  })), [{ domain: 'blocked.example', count: 2, blacklisted: true }]);
});

test('legacy blacklist without two OTP timeout tasks is rejected', () => {
  assert.throws(() => legacyMailComDomainProjection({
    sharedAvailableDomains: [{ domain: 'unsafe.example', state: 'UNKNOWN' }],
    domainFailures: {
      'unsafe.example': { blacklisted: true, consecutiveOtpTimeoutTasks: 0 },
    },
  }), { code: 'LEGACY_MAIL_COM_BLACKLIST_EVIDENCE_INVALID' });
});

test('legacy domain dry-run never connects to or writes PostgreSQL jobs', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error('must not connect'); } };
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-com-domain-dry-run-'));
  const settingsFile = path.join(dir, 'mail-com-split.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    sharedAvailableDomains: [{ domain: 'hidden.example', state: 'UNKNOWN' }],
  }));
  try {
    const summary = await restoreLegacyMailComDomains({ pool, settingsFile, apply: false });
    assert.equal(summary.domains, 1);
    assert.equal(summary.postCutoverJobsRead, false);
    assert.equal(summary.applied, false);
    assert.equal(connected, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty suffix responses cannot erase the saved global catalog', async () => {
  let connected = false;
  const store = new MailboxStore({ pool: {
    async connect() { connected = true; throw new Error('must not connect'); },
    async query() { throw new Error('must not query'); },
  } });
  await assert.rejects(store.replaceMailComDomainCatalog({ domains: [] }), {
    code: 'MAIL_COM_DOMAIN_CATALOG_EMPTY',
  });
  assert.equal(connected, false);
});

test('runner records only terminal mailbox-code timeouts and resets on success', async () => {
  const calls = [];
  const runner = Object.create(RegistrationRunner.prototype);
  runner.mailboxStore = {
    async recordMailComDomainRegistrationResult(input) {
      calls.push(input);
      return input;
    },
  };
  const task = {
    id: randomUUID(),
    email: 'alias@hidden.example',
    mailboxSource: 'mail_com_split',
  };
  await runner.recordTerminalMailComDomainResult(task, {
    ok: false,
    error: Object.assign(new Error('proxy failed'), { code: 'PROXY_FAILED' }),
  });
  await runner.recordTerminalMailComDomainResult(task, {
    ok: false,
    error: Object.assign(new Error('no code'), { code: 'MAILBOX_CODE_TIMEOUT' }),
  });
  await runner.recordTerminalMailComDomainResult(task, { ok: true });
  assert.deepEqual(calls.map(({ ok, failureKind }) => ({ ok, failureKind })), [
    { ok: false, failureKind: 'proxy_failed' },
    { ok: false, failureKind: 'otp_timeout' },
    { ok: true, failureKind: '' },
  ]);
  assert.ok(calls.every((entry) => entry.jobId === task.id && entry.domain === 'hidden.example'));
});

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';
test('OTP timeout evidence is job-deduplicated and success resets it', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const store = new MailboxStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const domain = `${suffix}.example`;
  await store.replaceMailComDomainCatalog({ domains: [{ domain, state: 'hidden' }] });
  const firstJob = randomUUID();
  const secondJob = randomUUID();
  assert.equal((await store.recordMailComDomainRegistrationResult({
    domain, jobId: firstJob, failureKind: 'otp_timeout', error: new Error('first'),
  })).consecutiveOtpTimeoutTasks, 1);
  assert.equal((await store.recordMailComDomainRegistrationResult({
    domain, jobId: firstJob, failureKind: 'otp_timeout', error: new Error('duplicate'),
  })).consecutiveOtpTimeoutTasks, 1);
  const blacklisted = await store.recordMailComDomainRegistrationResult({
    domain, jobId: secondJob, failureKind: 'otp_timeout', error: new Error('second'),
  });
  assert.equal(blacklisted.consecutiveOtpTimeoutTasks, 2);
  assert.equal(blacklisted.blacklisted, true);
  const reset = await store.recordMailComDomainRegistrationResult({ domain, jobId: secondJob, ok: true });
  assert.equal(reset.consecutiveOtpTimeoutTasks, 0);
  assert.equal(reset.blacklisted, false);
});
