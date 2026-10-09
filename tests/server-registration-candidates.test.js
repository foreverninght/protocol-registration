'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { loadConfig } = require('../src/app/config');
const { RegistrationStore } = require('../src/db/registration-store');
const { MailboxStore } = require('../src/db/mailbox-store');
const { AccountAssetStore } = require('../src/db/account-asset-store');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');
const serverModule = process.env.SIGNLIST_SERVER_UNDER_TEST
  ? require(path.resolve(process.env.SIGNLIST_SERVER_UNDER_TEST))
  : require('../src/app/server');
const { createServerApp } = serverModule;

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';

function requestJson(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(new URL(pathname, baseUrl), {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('email inventory and mail.com workflow fields use PostgreSQL only', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const stageEmail = `mail-stage-${suffix}@example.com`;
  const candidateEmail = `candidate-${suffix}@example.com`;
  const startedEmail = `started-${suffix}@example.com`;
  const historicalEmail = `historical-${suffix}@example.com`;
  const collisionEmail = `collision-${suffix}@example.com`;
  const pool = new Pool({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  const mailboxStore = new MailboxStore({ connectionString });
  const accountAssetStore = new AccountAssetStore({ connectionString });
  let app = null;
  t.after(async () => {
    if (app) await new Promise((resolve) => app.close(resolve));
    await Promise.all([
      pool.end(),
      registrationStore.close(),
      mailboxStore.close(),
      accountAssetStore.close(),
    ]);
  });

  const mailbox = await mailboxStore.upsertMailbox({
    email: `mailbox-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  await mailboxStore.replaceMailComDomainCatalog({ domains: [
    { domain: `active-${suffix}.com`, state: 'active' },
    { domain: `hidden-${suffix}.com`, state: 'hidden' },
    { domain: `blocked-${suffix}.com`, state: 'hidden' },
  ] });
  await pool.query(`
    insert into mail_com_domain_failures(
      domain, consecutive_otp_timeout_tasks, blacklisted, last_failure_kind, last_error
    ) values ($1, 2, true, 'otp_timeout', 'fixture timeout')
  `, [`blocked-${suffix}.com`]);
  const stageAccount = await pool.query(`
    insert into accounts(email, lifecycle_stage, source, account_snapshot_json)
    values ($1, 'registered', 'mail_com_split', '{}'::jsonb)
    returning id
  `, [stageEmail]);
  await pool.query(`
    insert into registration_candidates(email, mailbox_source, status)
    values ($1, 'mail_com_split', 'ready')
  `, [stageEmail]);
  await pool.query(`
    insert into email_aliases(mailbox_id, email, status, account_id)
    values ($1, $2, 'registered', $3), ($1, $4, 'abandoned', null)
  `, [mailbox.id, stageEmail, stageAccount.rows[0].id, collisionEmail]);
  const historicalAccount = await pool.query(`
    insert into accounts(email, lifecycle_stage, source, account_snapshot_json)
    values ($1, 'registered', 'manual', '{}'::jsonb)
    returning id
  `, [historicalEmail]);
  const historicalJobId = randomUUID();
  await pool.query(`
    insert into registration_jobs(id, account_id, status, step, branch, mode, mailbox_source)
    values ($1, $2, 'failed', 'failed', 'freepp', 'register', 'manual')
  `, [historicalJobId, historicalAccount.rows[0].id]);
  await pool.query(`
    insert into registration_job_inputs(job_id, registration_password)
    values ($1, 'historical-secret')
  `, [historicalJobId]);
  await registrationStore.importCandidates([
    { email: startedEmail, mailboxSource: 'manual' },
    { email: collisionEmail, mailboxSource: 'manual' },
  ]);
  const startedJobId = randomUUID();
  await registrationStore.createJob({
    id: startedJobId,
    email: startedEmail,
    registrationPassword: 'registration-secret',
    mailboxSource: 'manual',
  });
  await registrationStore.appendEvent({ jobId: startedJobId, event: {
    type: 'registration.failed',
    status: 'failed',
    step: 'failed',
    error: { code: 'TEST_TERMINAL', message: 'terminal fixture' },
  } });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-candidate-server-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ SIGNLIST_CLEAN_DATA_DIR: dataDir, SIGNLIST_PORT: '0' });
  app = await createServerApp({
    config,
    registrationStore,
    mailboxStore,
    accountAssetStore,
    runtimeStateStore: new MemoryRuntimeStateStore(),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;

  const publicConfig = await requestJson(base, 'GET', '/api/config');
  const publicDomains = publicConfig.body.mailbox.mailComSplit.sharedAvailableDomains;
  assert.equal(publicDomains.filter((entry) => entry.domain.endsWith(`-${suffix}.com`)).length, 3);
  assert.deepEqual(publicDomains.find((entry) => entry.domain === `blocked-${suffix}.com`), {
    domain: `blocked-${suffix}.com`,
    state: 'HIDDEN',
    blacklisted: true,
    noCodeBlacklisted: true,
    noTrialBlacklisted: false,
    consecutiveOtpTimeoutTasks: 2,
    consecutiveNoTrialTasks: 0,
    failureUpdatedAt: publicDomains.find((entry) => entry.domain === `blocked-${suffix}.com`).failureUpdatedAt,
  });
  assert.ok(publicDomains.find((entry) => entry.domain === `blocked-${suffix}.com`).failureUpdatedAt);

  const candidatesBeforeReject = await registrationStore.listCandidates();
  const rejected = await requestJson(base, 'POST', '/api/emails/import', {
    emails: 'valid@example.com\ninvalid-line',
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'REGISTRATION_CANDIDATE_LINES_INVALID');
  assert.deepEqual(await registrationStore.listCandidates(), candidatesBeforeReject);

  const imported = await requestJson(base, 'POST', '/api/emails/import', {
    emails: `${candidateEmail}\n${candidateEmail.toUpperCase()}`,
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported.length, 1);
  assert.equal(imported.body.duplicateLines.length, 1);
  const candidate = imported.body.imported[0];

  let inventory = await requestJson(base, 'GET', '/api/emails');
  assert.equal(inventory.status, 200);
  assert.ok(inventory.body.some((entry) => entry.id === candidate.id && entry.sourceOfTruth === 'postgresql'));
  assert.ok(inventory.body.some((entry) => entry.email === startedEmail && entry.status === 'started'));
  assert.equal(inventory.body.some((entry) => entry.email === historicalEmail), false);
  assert.deepEqual(
    inventory.body
      .filter((entry) => entry.email === collisionEmail)
      .map((entry) => entry.mailboxSource)
      .sort(),
    ['manual'],
  );
  const currentAccounts = await requestJson(base, 'GET', '/api/accounts?summary=1&currentEmails=1');
  assert.equal(currentAccounts.status, 200);
  assert.equal(currentAccounts.body.some((entry) => entry.email === historicalEmail), false);
  assert.ok(currentAccounts.body.some((entry) => entry.id === stageAccount.rows[0].id));
  assert.ok(currentAccounts.body.some((entry) => entry.email === startedEmail));
  const currentTasks = await requestJson(base, 'GET', '/api/tasks?summary=1&latestByEmail=1&currentEmails=1');
  assert.equal(currentTasks.status, 200);
  assert.ok(currentTasks.body.some((entry) => entry.id === startedJobId));
  assert.equal(currentTasks.body.some((entry) => entry.id === historicalJobId), false);

  const protectedDelete = await requestJson(base, 'DELETE', `/api/emails/${randomUUID()}`);
  assert.equal(protectedDelete.status, 409);
  assert.equal(protectedDelete.body.error, 'REGISTRATION_CANDIDATE_SELECTION_INVALID');

  const beforeStageChange = inventory.body.find((entry) => entry.email === stageEmail);
  const stage = await requestJson(base, 'PUT', `/api/emails/${encodeURIComponent(stageEmail)}/mail-com-stage`, { stage: 'gcash' });
  assert.equal(stage.status, 404);
  assert.equal(stage.body.error, 'feature_disabled');
  const sold = await requestJson(base, 'PUT', `/api/emails/${encodeURIComponent(stageEmail)}/gcash-sold`, { sold: true });
  assert.equal(sold.status, 404);
  assert.equal(sold.body.error, 'feature_disabled');

  inventory = await requestJson(base, 'GET', '/api/emails');
  const mailAccount = inventory.body.find((entry) => entry.email === stageEmail);
  assert.equal(mailAccount.accountId, stageAccount.rows[0].id);
  assert.equal(mailAccount.mailComStage, beforeStageChange.mailComStage);
  assert.equal(mailAccount.gcashSold, beforeStageChange.gcashSold);

  const deleted = await requestJson(base, 'DELETE', `/api/emails/${candidate.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: 1, requested: 1 });
  inventory = await requestJson(base, 'GET', '/api/emails');
  assert.equal(inventory.body.some((entry) => entry.id === candidate.id), false);
});
