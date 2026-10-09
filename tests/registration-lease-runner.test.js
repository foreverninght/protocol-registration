'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RegistrationRunner, assertConfiguredRegistrationCompletion } = require('../src/registration/runner');
const { RegistrationStore, jobStatusFromEvent, redactEventValue, deriveWorkflowStage } = require('../src/db/registration-store');
const { loadConfig } = require('../src/app/config');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const job = { id: 'lease-fixture', email: 'lease@example.test', status: 'running', claimedBy: 'worker-a', attemptCount: 3, mode: 'register', entryBranch: 'freepp', mailboxSource: 'share_page' };
  const events = [];
  const writes = [];
  const registrations = {
    async loadJob() { return { ...job }; },
    async assertLease({ guard }) {
      assert.equal(guard.attemptCount, 3);
      if (guard.workerId !== job.claimedBy) throw Object.assign(new Error('lease changed'), { code: 'REGISTRATION_WORKER_LEASE_LOST' });
    },
    async appendEvent({ event, guard }) {
      await this.assertLease({ guard });
      events.push(event);
      job.status = jobStatusFromEvent(event, job.status);
    },
    async renewLease() { return false; },
  };
  const assets = {
    async saveProgress(input) { writes.push(['progress', input]); },
    async completeRegistration(input) { writes.push(['completed', input]); },
    async getByJob() { return { email: job.email }; },
    async abandonScratchByEmail(...input) { writes.push(['abandoned', input]); },
  };
  const runner = new RegistrationRunner({
    config: loadConfig({}), registrationStore: registrations, accountAssetStore: assets,
    mailboxStore: {}, runtimeStateStore: new MemoryRuntimeStateStore(),
    proxyPools: { main: { async pickNext() { return null; } } },
    ...overrides,
  });
  runner.mailboxProviderForTask = async () => ({ provider: {} });
  return { runner, job, events, writes, registrations };
}

test('lease loss aborts sidecar signal and prevents stale progress, failure and cleanup', async (t) => {
  const entered = deferred();
  const release = deferred();
  let heartbeat;
  let signal;
  t.mock.method(globalThis, 'setInterval', (callback) => {
    heartbeat = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const f = fixture({ freeppRegistrationRunner: async (input) => {
    signal = input.signal;
    entered.resolve();
    await release.promise;
    return { accessToken: 'fixture-access', email: input.task.email };
  } });
  const run = f.runner.runClaimed({ ...f.job });
  const rejection = assert.rejects(run, { code: 'REGISTRATION_WORKER_LEASE_LOST' });
  await entered.promise;
  f.job.claimedBy = 'worker-b';
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'REGISTRATION_WORKER_LEASE_LOST');
  release.resolve();
  await rejection;
  assert.deepEqual(f.writes, []);
  assert.equal(f.events.some((event) => event.type === 'registration.failed'), false);
  assert.equal(f.job.status, 'running');
  assert.equal(f.runner.running.size, 0);
});

test('same worker stale runClaimed generation is rejected before sidecar starts', async () => {
  let started = false;
  const f = fixture({ freeppRegistrationRunner: async () => { started = true; } });
  await assert.rejects(f.runner.runClaimed({ ...f.job, attemptCount: 2 }), { code: 'REGISTRATION_CLAIM_STALE' });
  assert.equal(started, false);
  assert.deepEqual(f.events, []);
});

test('unverified activated TOTP secret is persisted before configured completion fails', async () => {
  const f = fixture({
    changeEmailSettings: { getSecretConfig: () => ({ setupTotp2fa: true }) },
    freeppRegistrationRunner: async () => ({
      email: 'lease@example.test', accessToken: 'fixture-access',
      totpSecret: 'JBSWY3DPEHPK3PXP', totpActivated: true, totpVerified: false,
      totpError: { code: 'TOTP_VERIFICATION_FAILED', message: 'fixture verification failed' },
    }),
  });
  await f.runner.runClaimed({ ...f.job });
  const progress = f.writes.find(([kind]) => kind === 'progress')[1];
  assert.equal(progress.patch.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(progress.patch.totpVerified, false);
  assert.equal(progress.guard.attemptCount, 3);
  assert.equal(f.writes.some(([kind]) => kind === 'completed'), false);
  assert.equal(f.job.status, 'failed');
  assert.ok(f.events.some((event) => event.error?.code === 'REGISTRATION_POST_STEPS_INCOMPLETE'));
  assert.throws(() => assertConfiguredRegistrationCompletion({
    registrationExtras: { setupTotp2fa: true },
    freeppResult: { totpSecret: 'fixture-secret', totpVerified: false },
  }), { code: 'REGISTRATION_POST_STEPS_INCOMPLETE' });
});

test('registration event redaction covers TOTP recovery enrollment identifiers', () => {
  assert.deepEqual(redactEventValue({ totpEnrollmentSessionId: 'private', nested: { enrollment_session_id: 'private' } }), {
    totpEnrollmentSessionId: '[REDACTED]', nested: { enrollment_session_id: '[REDACTED]' },
  });
});

for (const replacement of [
  { owner: 'worker-b', attempt: 4 },
  { owner: 'worker-a', attempt: 4 },
]) {
  test(`claim rejects a load that changed to ${replacement.owner} generation ${replacement.attempt}`, async () => {
    let queries = 0;
    const store = new RegistrationStore({ pool: {
      async query(sql) {
        queries += 1;
        if (queries === 1) {
          assert.match(sql, /returning r\.id, r\.claimed_by, r\.attempt_count/);
          return { rows: [{ id: 'fixture-job', claimed_by: 'worker-a', attempt_count: 3 }] };
        }
        return { rows: [{
          id: 'fixture-job', status: 'running', claimed_by: replacement.owner,
          attempt_count: replacement.attempt, email: 'fixture@example.test',
        }] };
      },
    } });
    assert.equal(await store.claimJob({ jobId: 'fixture-job', workerId: 'worker-a' }), null);
    assert.equal(queries, 2);
  });
}

test('claim returns only the owner and generation from its atomic update', async () => {
  let queries = 0;
  const store = new RegistrationStore({ pool: {
    async query() {
      queries += 1;
      return { rows: [{
        id: 'fixture-job', claimed_by: 'worker-a', attempt_count: 3,
        ...(queries > 1 ? { status: 'running', email: 'fixture@example.test' } : {}),
      }] };
    },
  } });
  const task = await store.claimJob({ jobId: 'fixture-job', workerId: 'worker-a' });
  assert.equal(task.claimedBy, 'worker-a');
  assert.equal(task.attemptCount, 3);
});

for (const accessToken of ['fixture-access', '']) {
  test(`completion failure preserves credentials before gates with access token=${Boolean(accessToken)}`, async () => {
    let attempts = 0;
    const completionError = { code: 'FREEPP_FINAL_AT_VALIDATION_FAILED', message: 'fixture final validation failed' };
    const f = fixture({
      changeEmailSettings: { getSecretConfig: () => ({ setupPassword: true, setupTotp2fa: true, validateOauthSession: true }) },
      freeppRegistrationRunner: async () => {
        attempts += 1;
        return {
          email: 'lease@example.test', password: ' fixture-created-password ', passwordStatus: 'has_password',
          accessToken, totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: true, totpActivated: true,
          totpEnrollmentSessionId: 'fixture-enrollment', completionError,
          finalAtValidation: { status: 'invalid' },
        };
      },
    });
    await f.runner.runClaimed({ ...f.job });
    const saved = f.writes.find(([kind]) => kind === 'progress')[1].patch;
    assert.equal(saved.password, ' fixture-created-password ');
    assert.equal(saved.totpSecret, 'JBSWY3DPEHPK3PXP');
    assert.equal(saved.totpEnrollmentSessionId, 'fixture-enrollment');
    assert.deepEqual(saved.completionError, completionError);
    assert.equal(saved.tokens.accessToken, accessToken);
    assert.equal(attempts, 1);
    assert.equal(f.job.status, 'failed');
    assert.equal(f.writes.some(([kind]) => kind === 'completed'), false);
    assert.equal(f.events.some((event) => event.type === 'registration.retrying_proxy'), false);
    assert.ok(f.events.some((event) => event.type === 'registration.failed' && event.error.code === completionError.code));
  });
}

test('repair completion failure preserves new password, TOTP and session without proxy replay', async () => {
  let attempts = 0;
  const completionError = { code: 'FREEPP_CHANGE_EMAIL_FAILED', message: 'fixture strict email change failed' };
  const f = fixture({
    proxyQualityChecker: async () => ({}),
    proxyPools: { main: { async pickNext() { return { id: 'fixture-proxy' }; } } },
    freeppCredentialRepairRunner: async () => {
      attempts += 1;
      return {
        password: ' repaired-password ', passwordStatus: 'has_password',
        totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: true, totpActivated: true,
        totpEnrollmentSessionId: 'repair-enrollment',
        sessionToken: 'new-session', refreshToken: 'new-refresh',
        finalAtValidation: { status: 'invalid' }, completionError,
      };
    },
  });
  f.job.mode = 'credential_repair';
  f.runner.accountAssetStore.getByEmail = async () => ({
    email: f.job.email, status: 'registered', passwordStatus: 'no_password', totpStatus: 'missing',
  });
  f.runner.accountAssetStore.updateByEmail = async (input) => { f.writes.push(['repair-patch', input]); };
  await f.runner.runClaimed({ ...f.job });
  const saved = f.writes.find(([kind, input]) => kind === 'repair-patch' && input.patch.totpSecret)[1].patch;
  assert.equal(saved.password, ' repaired-password ');
  assert.equal(saved.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(saved.totpEnrollmentSessionId, 'repair-enrollment');
  assert.equal(saved.tokens.sessionToken, 'new-session');
  assert.equal(saved.tokens.refreshToken, 'new-refresh');
  assert.ok(saved.session.cookies.some((cookie) => cookie.value === 'new-session'));
  assert.deepEqual(saved.completionError, completionError);
  assert.equal(f.job.status, 'failed');
  assert.equal(attempts, 1);
  assert.equal(f.events.some((event) => event.type === 'credential_repair.completed'), false);
  assert.ok(f.events.some((event) => event.type === 'credential_repair.failed' && event.error.code === completionError.code));
});

test('strict email change failure overrides complete assets and eligibility workflow projections', () => {
  for (const stage of ['eligibility', 'payment_method', 'completed', 'sold']) {
    assert.equal(deriveWorkflowStage({
      lifecycle_stage: 'registered', password_status: 'has_password', totp_status: 'enabled',
      access_token_available: true, session_available: true, final_at_status: 'valid',
      eligibility_status: 'eligible', payment_method_status: 'available', mail_com_stage: stage,
      completion_failed: true, completion_error_code: 'FREEPP_CHANGE_EMAIL_FAILED',
    }, { status: 'failed', active: false, rawJobStatus: 'failed' }), 'unrepairable');
  }
});

test('credential repair reads access-token evidence from the private account shape', async () => {
  let attempts = 0;
  const f = fixture({
    proxyQualityChecker: async () => ({}),
    proxyPools: { main: { async pickNext() { return { id: 'fixture-proxy' }; } } },
    freeppCredentialRepairRunner: async () => {
      attempts += 1;
      return { accessToken: 'new-access', sessionToken: 'new-session', finalAtValidation: { status: 'valid' } };
    },
  });
  f.job.mode = 'credential_repair';
  f.runner.accountAssetStore.getByEmail = async () => ({
    email: f.job.email, status: 'registration_in_progress',
    passwordStatus: 'has_password', totpStatus: 'enabled',
    tokens: { accessToken: 'old-access' }, sessionAvailable: false,
  });
  f.runner.accountAssetStore.updateByEmail = async (input) => { f.writes.push(['repair-patch', input]); };
  await f.runner.runClaimed({ ...f.job });
  assert.equal(attempts, 1);
  assert.equal(f.job.status, 'completed');
  const saved = f.writes.find(([kind]) => kind === 'repair-patch')[1].patch;
  assert.equal(saved.tokens.accessToken, 'new-access');
  assert.ok(saved.session.cookies.some((cookie) => cookie.value === 'new-session'));
});
