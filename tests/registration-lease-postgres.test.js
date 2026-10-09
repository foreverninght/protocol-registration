'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { migrate } = require('../tools/migrate');
const { RegistrationStore } = require('../src/db/registration-store');
const { AccountAssetStore } = require('../src/db/account-asset-store');
const { RegistrationRunner } = require('../src/registration/runner');
const { loadConfig } = require('../src/app/config');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';
const databaseTest = (name, fn) => test(name, {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
  timeout: 60000,
}, fn);
const guardFor = (task) => ({ jobId: task.id, workerId: task.claimedBy, attemptCount: task.attemptCount });
const lost = (error) => error.code === 'REGISTRATION_WORKER_LEASE_LOST';

async function fixture(t) {
  const url = new URL(connectionString);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'fixture database must be loopback');
  for (const key of ['host', 'hostaddr', 'port', 'service', 'options']) {
    assert.equal(url.searchParams.has(key), false, `fixture URL must not override ${key}`);
  }
  const databaseName = `registration_lease_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  let created = false;
  let pool;
  t.after(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) await admin.query(`drop database "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  });
  await admin.connect();
  await admin.query(`create database "${databaseName}" template template0`);
  created = true;
  url.pathname = `/${databaseName}`;
  url.search = '';
  const isolatedUrl = url.toString();
  await migrate(isolatedUrl);
  pool = new Pool({ connectionString: isolatedUrl, max: 6, connectionTimeoutMillis: 5000 });
  const registrations = new RegistrationStore({ pool });
  const assets = new AccountAssetStore({ pool });
  const create = async (password = 'fixture-password') => {
    const email = `lease-${randomUUID()}@example.test`;
    return registrations.createJob({
      id: randomUUID(), email, registrationPassword: password,
      mailboxSource: 'share_page', mailboxUrl: 'https://inbox.example.test/fixture',
    });
  };
  return { registrations, assets, create };
}

databaseTest('startup recovery leaves another live worker lease untouched', async (t) => {
  const { registrations, create } = await fixture(t);
  const job = await create();
  const first = await registrations.claimJob({ jobId: job.id, workerId: 'mail-com-registration-control:first' });
  await registrations.recoverExpiredJobs({ currentWorkerId: 'mail-com-registration-control:second' });
  assert.equal(await registrations.claimJob({ jobId: job.id, workerId: 'mail-com-registration-control:second' }), null);
  const current = await registrations.loadJob({ jobId: job.id });
  assert.equal(current.claimedBy, first.claimedBy);
  assert.equal(current.attemptCount, first.attemptCount);
  assert.equal(current.status, 'running');
});

for (const sameWorker of [false, true]) {
  databaseTest(`stale claim cannot write or renew after ${sameWorker ? 'same' : 'different'} worker reclaims`, async (t) => {
    const { registrations, assets, create } = await fixture(t);
    const job = await create();
    const first = await registrations.claimJob({ jobId: job.id, workerId: 'worker-first' });
    const stale = guardFor(first);
    await assets.saveProgress({ jobId: job.id, patch: { password: 'original' }, guard: stale });
    await registrations.pool.query("update registration_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [job.id]);
    await assert.rejects(registrations.appendEvent({ jobId: job.id, event: { type: 'fixture.expired' }, guard: stale }), lost);
    assert.equal(await registrations.renewLease({ jobId: job.id, workerId: first.claimedBy, guard: stale }), false);
    await registrations.recoverExpiredJobs();
    const second = await registrations.claimJob({ jobId: job.id, workerId: sameWorker ? first.claimedBy : 'worker-second' });
    assert.ok(second.attemptCount > first.attemptCount);
    const before = await registrations.loadJob({ jobId: job.id, includeEvents: true });
    for (const operation of [
      () => registrations.appendEvent({ jobId: job.id, event: { type: 'registration.failed', status: 'failed' }, guard: stale }),
      () => assets.saveProgress({ jobId: job.id, patch: { password: 'stale' }, guard: stale }),
      () => assets.completeRegistration({ jobId: job.id, account: { password: 'stale' }, guard: stale }),
      () => assets.updateByEmail({ email: job.email, patch: { password: 'stale' }, guard: stale }),
      () => assets.abandonScratchByEmail(job.email, { guard: stale }),
      () => registrations.recordMailboxDeliveryFailure({ accountId: job.accountId, guard: stale }),
    ]) await assert.rejects(operation(), lost);
    assert.equal(await registrations.renewLease({ jobId: job.id, workerId: stale.workerId, guard: stale }), false);
    assert.equal(await registrations.releaseClaim({ jobId: job.id, workerId: stale.workerId, attemptCount: stale.attemptCount }), false);
    const after = await registrations.loadJob({ jobId: job.id, includeEvents: true });
    assert.deepEqual(after, before);
    assert.equal((await assets.getByEmail(job.email, { includeSecret: true })).password, 'original');
    const guard = guardFor(second);
    assert.equal(await registrations.renewLease({ jobId: job.id, workerId: second.claimedBy, guard }), true);
    await registrations.appendEvent({ jobId: job.id, event: { type: 'fixture.current', status: 'running' }, guard });
    await assets.saveProgress({ jobId: job.id, patch: { password: 'current' }, guard });
    await assets.completeRegistration({ jobId: job.id, account: { password: 'current' }, guard });
    await assert.rejects(assets.updateByEmail({ email: job.email, patch: { password: 'stale' }, guard: { ...stale, allowTerminal: true } }), lost);
    await assets.transitionWorkflow({ jobId: job.id, stage: 'eligibility', guard: { ...guard, allowTerminal: true } });
    assert.equal((await assets.getByEmail(job.email, { includeSecret: true })).password, 'current');
    await assets.updateByEmail({ email: job.email, patch: { password: 'management' } });
    assert.equal((await assets.getByEmail(job.email, { includeSecret: true })).password, 'management');
  });
}

databaseTest('releaseClaim only releases the current live claim', async (t) => {
  const { registrations, create } = await fixture(t);
  const job = await create();
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'stop-fixture' });
  assert.equal(await registrations.releaseClaim({ jobId: job.id, workerId: claimed.claimedBy, attemptCount: claimed.attemptCount }), true);
  const released = await registrations.loadJob({ jobId: job.id });
  assert.equal(released.status, 'retry_waiting');
  assert.equal(released.claimedBy, null);
  assert.equal(released.leaseExpiresAt, null);
  assert.equal(await registrations.releaseClaim({ jobId: job.id, workerId: claimed.claimedBy, attemptCount: claimed.attemptCount }), false);
});

for (const state of ['expired', 'delivery_failed', 'stale', 'available']) {
  databaseTest(`credential repair admission validates mailbox state: ${state}`, async (t) => {
    const { registrations, assets, create } = await fixture(t);
    const job = await create();
    const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'repair-fixture' });
    await assets.completeRegistration({ jobId: job.id, guard: guardFor(claimed), account: {
      passwordStatus: 'no_password', tokens: { accessToken: 'fixture-access' },
      mailboxRepairability: {
        status: state === 'stale' ? 'available' : state,
        checkedAt: new Date(Date.now() - (state === 'stale' ? 11 * 60000 : 0)).toISOString(),
      },
    } });
    const automatic = await registrations.createCredentialRepairJob({ email: job.email, automatic: true });
    if (state === 'available') {
      assert.ok(automatic);
      const repair = await registrations.claimJob({ jobId: automatic.id, workerId: 'repair-worker' });
      assert.equal(repair.mode, 'credential_repair');
      await registrations.appendEvent({ jobId: repair.id, guard: guardFor(repair), event: {
        type: 'credential_repair.completed', status: 'succeeded', step: 'completed',
      } });
      assert.equal((await registrations.loadJob({ jobId: repair.id })).status, 'completed');
      return;
    }
    assert.equal(automatic, null);
    const manual = await registrations.createCredentialRepairJob({ email: job.email });
    assert.ok(manual);
    assert.equal(await registrations.claimJob({ jobId: manual.id, workerId: 'repair-worker' }), null);
    await assets.updateByEmail({ email: job.email, patch: {
      mailboxRepairability: { status: 'available', checkedAt: new Date().toISOString() },
    } });
    assert.equal((await registrations.claimJob({ jobId: manual.id, workerId: 'repair-worker' })).id, manual.id);
  });
}

databaseTest('pending TOTP verification retains its secret and remains eligible for repair', async (t) => {
  const { registrations, assets, create } = await fixture(t);
  const job = await create();
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'totp-fixture' });
  const guard = guardFor(claimed);
  await assets.saveProgress({ jobId: job.id, guard, patch: {
    status: 'registration_in_progress', password: 'fixture-password', passwordStatus: 'has_password',
    tokens: { accessToken: 'fixture-access' }, sessionAvailable: true,
    totpSecret: 'JBSWY3DPEHPK3PXP', hasTotp: true, totpActivated: true, totpVerified: false,
    totpEnrollmentSessionId: 'fixture-private-enrollment',
    totpSetupError: { code: 'TOTP_VERIFICATION_PENDING' },
    mailboxRepairability: { status: 'available', checkedAt: new Date().toISOString() },
  } });
  await registrations.appendEvent({ jobId: job.id, guard, event: { type: 'registration.failed', status: 'failed' } });
  await assets.abandonScratchByEmail(job.email, { guard: { ...guard, allowTerminal: true } });
  const pending = await assets.getByEmail(job.email, { includeSecret: true });
  assert.equal(pending.totpStatus, 'failed');
  assert.equal(pending.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(pending.totpActivated, true);
  assert.equal(pending.totpVerified, false);
  assert.equal(pending.totpEnrollmentSessionId, 'fixture-private-enrollment');
  assert.equal(JSON.stringify(await assets.getByEmail(job.email)).includes('fixture-private-enrollment'), false);
  const snapshot = await registrations.pool.query('select account_snapshot_json from accounts where id = $1', [job.accountId]);
  assert.equal(JSON.stringify(snapshot.rows).includes('fixture-private-enrollment'), false);
  const repair = await registrations.createCredentialRepairJob({ email: job.email, automatic: true });
  assert.ok(repair);
  assert.equal(repair.options.repairTotp, true);
  const repairedClaim = await registrations.claimJob({ jobId: repair.id, workerId: 'totp-repair-fixture' });
  await assets.updateByEmail({ email: job.email, guard: guardFor(repairedClaim), patch: {
    hasTotp: true, totpVerified: true, totpSetupError: null,
  } });
  const repaired = await assets.getByEmail(job.email, { includeSecret: true });
  assert.equal(repaired.totpStatus, 'enabled');
  assert.equal(repaired.totpSecret, pending.totpSecret);
});

databaseTest('registration input and account credentials preserve password whitespace', async (t) => {
  const { registrations, assets, create } = await fixture(t);
  const password = '  fixture-password\t ';
  const job = await create(password);
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'password-fixture' });
  assert.equal(claimed.registrationPassword, password);
  await assets.saveProgress({ jobId: job.id, guard: guardFor(claimed), patch: { password } });
  assert.equal((await assets.getByEmail(job.email, { includeSecret: true })).password, password);
  await assets.completeRegistration({ jobId: job.id, guard: guardFor(claimed), account: { password } });
  assert.equal((await assets.getByEmail(job.email, { includeSecret: true })).password, password);
});

databaseTest('completion failure without tokens persists credentials and recovers by login repair', async (t) => {
  const { registrations, assets, create } = await fixture(t);
  const job = await create();
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'partial-fixture' });
  let registrationsStarted = 0;
  let repairsStarted = 0;
  const runner = new RegistrationRunner({
    config: loadConfig({}), registrationStore: registrations, accountAssetStore: assets,
    mailboxStore: {}, runtimeStateStore: new MemoryRuntimeStateStore(),
    proxyPools: { main: { async pickNext() { return { id: 'fixture-proxy' }; } } },
    proxyQualityChecker: async () => ({}),
    freeppRegistrationRunner: async () => {
      registrationsStarted += 1;
      return {
        email: job.email, password: ' partial-password ', passwordStatus: 'has_password',
        totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: true, totpActivated: true,
        completionError: { code: 'FREEPP_FINAL_AT_VALIDATION_FAILED', message: 'fixture invalid AT' },
        finalAtValidation: { status: 'invalid' },
      };
    },
    freeppCredentialRepairRunner: async () => {
      repairsStarted += 1;
      return { accessToken: 'repaired-access', sessionToken: 'repaired-session', finalAtValidation: { status: 'valid' } };
    },
  });
  runner.mailboxProviderForTask = async () => ({ provider: {} });
  await runner.runClaimed(claimed);
  const partial = await assets.getByEmail(job.email, { includeSecret: true });
  assert.equal(partial.registrationCreated, true);
  assert.notEqual(partial.lifecycleStage, 'abandoned');
  assert.equal(partial.password, ' partial-password ');
  assert.equal(partial.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(partial.tokens.accessToken, '');
  assert.equal(partial.sessionAvailable, false);
  assert.equal((await assets.getByEmail(job.email)).accessTokenAvailable, false);
  assert.equal((await registrations.loadJob({ jobId: job.id })).status, 'failed');
  await registrations.recordMailboxRepairability({ accountId: job.accountId, status: 'available' });
  const repair = await registrations.createCredentialRepairJob({ email: job.email, automatic: true });
  assert.ok(repair);
  const repairing = await registrations.claimJob({ jobId: repair.id, workerId: 'partial-repair-fixture' });
  await runner.runClaimed(repairing);
  const recovered = await assets.getByEmail(job.email, { includeSecret: true });
  assert.equal(recovered.completionError, null);
  assert.equal(recovered.finalAtValidation.status, 'valid');
  assert.equal(recovered.tokens.accessToken, 'repaired-access');
  assert.ok(recovered.session.cookies.some((cookie) => cookie.value === 'repaired-session'));
  assert.equal(recovered.lifecycleStage, 'registered');
  assert.equal((await registrations.loadJob({ jobId: repair.id })).status, 'completed');
  assert.equal(registrationsStarted, 1);
  assert.equal(repairsStarted, 1);
});

databaseTest('complete-looking assets with failed final AT remain failed and enter login repair', async (t) => {
  const { registrations, assets, create } = await fixture(t);
  const job = await create();
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'invalid-at-fixture' });
  const guard = guardFor(claimed);
  await assets.saveProgress({ jobId: job.id, guard, patch: {
    registrationCreated: true, password: 'fixture-password', passwordStatus: 'has_password',
    totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: true, hasTotp: true,
    tokens: { accessToken: 'invalid-access' }, sessionAvailable: true,
    completionError: { code: 'FREEPP_FINAL_AT_VALIDATION_FAILED', message: 'fixture invalid AT' },
    finalAtValidation: { status: 'invalid' },
    mailboxRepairability: { status: 'available', checkedAt: new Date().toISOString() },
  } });
  await registrations.appendEvent({ jobId: job.id, guard, event: {
    type: 'registration.failed', status: 'failed', error: { code: 'FREEPP_FINAL_AT_VALIDATION_FAILED', message: 'fixture invalid AT' },
  } });
  const view = await registrations.registrationViews({ emails: [job.email] });
  assert.equal(view.byEmail[job.email].status, 'failed');
  assert.equal(view.byEmail[job.email].detail, 'fixture invalid AT');
  assert.equal(view.byEmail[job.email].workflowStage, 'repair');
  const repair = await registrations.createCredentialRepairJob({ email: job.email, automatic: true });
  assert.ok(repair);
  assert.equal(repair.options.repairLogin, true);
});

databaseTest('strict email change failure stays visible despite complete eligible credentials', async (t) => {
  const { registrations, assets, create } = await fixture(t);
  const job = await create();
  const claimed = await registrations.claimJob({ jobId: job.id, workerId: 'strict-email-fixture' });
  const guard = guardFor(claimed);
  await assets.saveProgress({ jobId: job.id, guard, patch: {
    registrationCreated: true, password: 'fixture-password', passwordStatus: 'has_password',
    totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: true, hasTotp: true,
    tokens: { accessToken: 'fixture-access' }, sessionAvailable: true,
    trialEligibility: { status: 'eligible' }, mailComStage: 'completed',
    completionError: { code: 'FREEPP_CHANGE_EMAIL_FAILED', message: 'fixture strict email failed' },
    finalAtValidation: { status: 'valid' },
    mailboxRepairability: { status: 'available', checkedAt: new Date().toISOString() },
  } });
  await registrations.appendEvent({ jobId: job.id, guard, event: {
    type: 'registration.failed', status: 'failed', error: { code: 'FREEPP_CHANGE_EMAIL_FAILED', message: 'fixture strict email failed' },
  } });
  const view = await registrations.registrationViews({ emails: [job.email] });
  assert.equal(view.byEmail[job.email].status, 'failed');
  assert.equal(view.byEmail[job.email].workflowStage, 'unrepairable');
  assert.equal(view.byEmail[job.email].detail, 'fixture strict email failed');
  assert.equal(await registrations.createCredentialRepairJob({ email: job.email, automatic: true }), null);
});
