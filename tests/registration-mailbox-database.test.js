'use strict';

const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MailboxStore } = require('../src/db/mailbox-store');
const { RegistrationStore } = require('../src/db/registration-store');
const { AccountAssetStore } = require('../src/db/account-asset-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';
const databaseTest = (name, fn) => test(name, {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, fn);

databaseTest('mailbox domains, aliases, and observed sessions remain mailbox-owned', async (t) => {
  const store = new MailboxStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await store.upsertMailbox({
    email: `main-${suffix}@example.com`,
    password: 'mailbox-secret',
  });

  const domains = await store.replaceDomains({ mailboxId: mailbox.id, domains: [
    { domain: `hidden-${suffix}.com`, state: 'DEACTIVATED' },
    { domain: `active-${suffix}.com`, state: 'ACTIVE' },
  ] });
  assert.deepEqual(domains.map(({ domain, state }) => ({ domain, state })), [
    { domain: `active-${suffix}.com`, state: 'active' },
    { domain: `hidden-${suffix}.com`, state: 'deactivated' },
  ]);

  const aliasEmail = `alias-${suffix}@hidden-${suffix}.com`;
  const reserved = await store.reserveAliasForCreation({ mailboxId: mailbox.id, email: aliasEmail });
  assert.equal(reserved.status, 'creating');
  assert.equal(reserved.mailboxId, mailbox.id);
  assert.equal((await store.markAliasCreated({ aliasId: reserved.id })).alias.status, 'unused');

  await store.recordSessionState({ mailboxId: mailbox.id, status: 'open' });
  assert.equal((await store.getMailbox({ mailboxId: mailbox.id })).sessionStatus, 'open');
  await store.resetObservedOpenSessions('integration restart');
  const reset = await store.getMailbox({ mailboxId: mailbox.id });
  assert.equal(reset.sessionStatus, 'closed');
  assert.equal(reset.lastError, 'integration restart');
});

databaseTest('mail inventory is alias-owned and never includes unrelated historical accounts', async (t) => {
  const store = new MailboxStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await store.upsertMailbox({
    email: `inventory-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const active = await store.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `active-${suffix}@example.com`,
  });
  await store.markAliasCreated({ aliasId: active.id });
  const abandoned = await store.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `abandoned-${suffix}@example.com`,
  });
  await store.markAliasCreationFailed({ aliasId: abandoned.id, error: new Error('creation failed') });

  const inventory = await store.listEmailInventory();
  const owned = inventory.filter((entry) => entry.mailboxId === mailbox.id);
  assert.deepEqual(owned.map((entry) => entry.email).sort(), [active.email, abandoned.email].sort());
  assert.ok(owned.every((entry) => entry.mailboxSource === 'mail_com_split'));
  assert.ok(owned.every((entry) => entry.aliasId && entry.id === entry.aliasId));
});

databaseTest('registration ownership, claim concurrency, event redaction, and terminal evidence are strict', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `owner-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  await mailboxStore.replaceDomains({ mailboxId: mailbox.id, domains: [
    { domain: `owned-${suffix}.com`, state: 'hidden' },
  ] });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `job-${suffix}@owned-${suffix}.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });

  const jobId = randomUUID();
  const job = await registrationStore.createJob({
    id: jobId,
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
    proxyPoolId: 'one-pool',
  });
  assert.equal(job.mailboxId, mailbox.id);
  assert.equal(job.aliasId, alias.id);
  assert.equal(job.registrationPassword, undefined);
  assert.equal((await registrationStore.loadJob({ jobId, includeSecret: true })).registrationPassword, 'registration-secret');

  const claims = await Promise.all([
    registrationStore.claimJob({ jobId, workerId: `worker-a-${suffix}` }),
    registrationStore.claimJob({ jobId, workerId: `worker-b-${suffix}` }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);

  await registrationStore.appendEvent({ jobId, event: {
    type: 'registration.network',
    status: 'running',
    step: 'mailbox_polling',
    message: 'Authorization: Bearer live-token',
    password: 'event-password',
    otpCode: '123456',
  } });
  await registrationStore.appendEvent({ jobId, event: {
    type: 'registration.failed',
    status: 'failed',
    step: 'failed',
    error: { code: 'OTP_TIMEOUT', message: 'mailbox did not receive a current code' },
  } });
  await registrationStore.appendEvent({ jobId, event: {
    type: 'registration.completed',
    status: 'completed',
    step: 'completed',
  } });

  const failed = await registrationStore.loadJob({ jobId, includeEvents: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'OTP_TIMEOUT');
  assert.equal(failed.events.length, 4);
  assert.deepEqual(failed.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(failed.events[1].password, '[REDACTED]');
  assert.equal(failed.events[1].otpCode, '[REDACTED]');
  assert.equal(failed.events[1].message, 'Authorization: [REDACTED]');
});

databaseTest('refill run owns alias creation and queues all staged jobs atomically', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `refill-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const run = await mailboxStore.createRefillRun({ targetCount: 1, preferredMailboxId: mailbox.id });
  await assert.rejects(
    mailboxStore.createRefillRun({ targetCount: 1 }),
    { code: 'ALIAS_REFILL_ALREADY_ACTIVE' },
  );
  await mailboxStore.startRefillRun({ refillRunId: run.id });
  const reserved = await mailboxStore.reserveAliasForRefill({
    refillRunId: run.id,
    mailboxId: mailbox.id,
    email: `refill-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreating({ aliasId: reserved.alias.id, refillItemId: reserved.item.id });
  await mailboxStore.markAliasCreated({ aliasId: reserved.alias.id, refillItemId: reserved.item.id });

  const jobId = randomUUID();
  const staged = await registrationStore.createRefillJob({
    refillItemId: reserved.item.id,
    id: jobId,
    email: reserved.alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: reserved.alias.id,
  });
  assert.equal(staged.status, 'staged');
  assert.equal((await mailboxStore.getRefillRun({ refillRunId: run.id })).items[0].jobId, jobId);

  assert.deepEqual(await mailboxStore.queueRefillRunJobs({ refillRunId: run.id }), {
    refillRunId: run.id,
    queued: 1,
  });
  assert.equal((await registrationStore.loadJob({ jobId })).status, 'queued');
  const finished = await mailboxStore.finishRefillRun({ refillRunId: run.id });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.finalPoolCount >= 1, true);
});

databaseTest('a registered alias can retain explicit cleanup-required evidence', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `cleanup-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `cleanup-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });
  const job = await registrationStore.createJob({
    id: randomUUID(),
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
  });
  await mailboxStore.pool.query(
    "update email_aliases set status = 'registered' where id = $1 and status = 'registering'",
    [alias.id],
  );

  const result = await mailboxStore.markAliasCleanupRequired({
    aliasId: alias.id,
    error: Object.assign(new Error('session renewal failed'), {
      code: 'MAIL_COM_SESSION_RENEWAL_FAILED',
    }),
  });

  assert.equal(result.alias.status, 'cleanup_required');
  assert.equal((await registrationStore.loadJob({ jobId: job.id })).mailboxSource, 'mail_com_split');
});

databaseTest('a registered alias can be archived after confirmed remote removal', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `release-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `release-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });
  const job = await registrationStore.createJob({
    id: randomUUID(),
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
  });
  await mailboxStore.pool.query(
    "update email_aliases set status = 'registered' where id = $1 and status = 'registering'",
    [alias.id],
  );

  const result = await mailboxStore.markAliasAbandoned({ aliasId: alias.id });

  assert.equal(result.alias.status, 'abandoned');
  assert.equal((await registrationStore.loadJob({ jobId: job.id })).mailboxSource, 'mail_com_split');
});

databaseTest('remote observation never returns a terminal account alias to the unused pool', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `observed-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `observed-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });
  await registrationStore.createJob({
    id: randomUUID(),
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
  });
  await mailboxStore.markAliasAbandoned({ aliasId: alias.id });

  await mailboxStore.reconcileObservedAliases({ mailboxId: mailbox.id, emails: [alias.email] });

  assert.equal((await mailboxStore.getAlias({ aliasId: alias.id })).status, 'cleanup_required');
  const run = await mailboxStore.createRefillRun({ targetCount: 1 });
  await mailboxStore.startRefillRun({ refillRunId: run.id });
  assert.equal(await mailboxStore.reserveExistingAliasForRefill({
    refillRunId: run.id,
    mailboxId: mailbox.id,
  }), null);
  await mailboxStore.finishRefillRun({ refillRunId: run.id, error: new Error('fixture complete') });
});

databaseTest('remote observation recovers terminal missing aliases but blocks active ownership', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `snapshot-${suffix}@example.com`,
    password: 'mailbox-secret',
  });

  const terminalAlias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `terminal-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: terminalAlias.id });
  const terminalJob = await registrationStore.createJob({
    id: randomUUID(),
    email: terminalAlias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: terminalAlias.id,
  });
  await mailboxStore.pool.query(
    "update registration_jobs set status = 'completed', step = 'completed', completed_at = now() where id = $1",
    [terminalJob.id],
  );
  await mailboxStore.pool.query(
    "update email_aliases set status = 'registered' where id = $1 and status = 'registering'",
    [terminalAlias.id],
  );

  await mailboxStore.reconcileObservedAliases({ mailboxId: mailbox.id, emails: [] });
  assert.equal((await mailboxStore.getAlias({ aliasId: terminalAlias.id })).status, 'cleanup_required');

  const activeAlias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `active-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: activeAlias.id });
  await registrationStore.createJob({
    id: randomUUID(),
    email: activeAlias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: activeAlias.id,
  });

  await assert.rejects(
    mailboxStore.reconcileObservedAliases({ mailboxId: mailbox.id, emails: [] }),
    { code: 'MAILBOX_ALIAS_REMOTE_MISSING' },
  );
  assert.equal((await mailboxStore.getAlias({ aliasId: activeAlias.id })).status, 'registering');
});

databaseTest('remote observation marks an observed terminal alias for cleanup', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `terminal-observed-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `terminal-observed-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });
  const job = await registrationStore.createJob({
    id: randomUUID(),
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
  });
  await mailboxStore.pool.query(
    "update registration_jobs set status = 'failed', step = 'failed', completed_at = now() where id = $1",
    [job.id],
  );

  await mailboxStore.reconcileObservedAliases({ mailboxId: mailbox.id, emails: [alias.email] });

  assert.equal((await mailboxStore.getAlias({ aliasId: alias.id })).status, 'cleanup_required');
});

databaseTest('retired mailboxes retain history but reject every new alias reservation', async (t) => {
  const store = new MailboxStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await store.upsertMailbox({
    email: `retired-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const retired = await store.retireMailbox({ mailboxId: mailbox.id, reason: 'CATS request conflict fixture' });

  assert.ok(retired.retiredAt);
  assert.equal((await store.getMailbox({ mailboxId: mailbox.id })).retirementReason, 'CATS request conflict fixture');
  assert.equal((await store.listMailboxes({ provider: 'mail_com' })).some((item) => item.id === mailbox.id), false);
  await assert.rejects(
    store.reserveAliasForCreation({ mailboxId: mailbox.id, email: `blocked-${suffix}@example.com` }),
    { code: 'MAILBOX_RETIRED' },
  );

  const run = await store.createRefillRun({ targetCount: 1 });
  await store.startRefillRun({ refillRunId: run.id });
  await assert.rejects(
    store.reserveAliasForRefill({
      refillRunId: run.id,
      mailboxId: mailbox.id,
      email: `refill-blocked-${suffix}@example.com`,
    }),
    { code: 'MAILBOX_RETIRED' },
  );
  await store.finishRefillRun({ refillRunId: run.id, error: new Error('fixture complete') });
});

databaseTest('mail.com terminal workflow transitions and discards usable inventory atomically', async (t) => {
  const mailboxStore = new MailboxStore({ connectionString });
  const registrationStore = new RegistrationStore({ connectionString });
  const accountStore = new AccountAssetStore({ connectionString });
  t.after(async () => Promise.all([mailboxStore.close(), registrationStore.close(), accountStore.close()]));
  const suffix = randomUUID().slice(0, 8);
  const mailbox = await mailboxStore.upsertMailbox({
    email: `workflow-${suffix}@example.com`,
    password: 'mailbox-secret',
  });
  const alias = await mailboxStore.reserveAliasForCreation({
    mailboxId: mailbox.id,
    email: `workflow-alias-${suffix}@example.com`,
  });
  await mailboxStore.markAliasCreated({ aliasId: alias.id });
  const job = await registrationStore.createJob({
    id: randomUUID(),
    email: alias.email,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
  });
  await accountStore.pool.query("update registration_jobs set status = 'completed', step = 'completed', completed_at = now() where id = $1", [job.id]);
  const seededCandidate = await accountStore.pool.query(`
    update registration_candidates
    set mail_com_stage = 'unregistered'
    where email = $1 and registration_job_id = $2
    returning id
  `, [alias.email, job.id]);
  assert.equal(seededCandidate.rowCount, 1);

  await accountStore.transitionMailComWorkflow({
    jobId: job.id,
    stage: 'refining',
    releaseStatus: 'released',
  });
  let candidate = await accountStore.pool.query('select * from registration_candidates where registration_job_id = $1', [job.id]);
  let account = await accountStore.pool.query('select lifecycle_stage, account_snapshot_json from accounts where id = $1', [job.accountId]);
  assert.equal(candidate.rows[0].mail_com_stage, 'refining');
  assert.equal(candidate.rows[0].mail_com_release_status, 'released');
  assert.equal(account.rows[0].lifecycle_stage, 'refining');
  assert.equal(account.rows[0].account_snapshot_json.mailComStage, 'refining');

  await accountStore.pool.query('delete from registration_candidates where registration_job_id = $1', [job.id]);
  await accountStore.transitionMailComWorkflow({
    jobId: job.id,
    stage: 'eligibility',
    releaseStatus: 'released',
  });
  candidate = await accountStore.pool.query('select * from registration_candidates where registration_job_id = $1', [job.id]);
  assert.equal(candidate.rowCount, 1);
  assert.equal(candidate.rows[0].email, alias.email);
  assert.equal(candidate.rows[0].mail_com_stage, 'eligibility');

  await accountStore.pool.query("update registration_jobs set status = 'failed' where id = $1", [job.id]);
  await accountStore.transitionMailComWorkflow({
    jobId: job.id,
    stage: 'unregistered',
    releaseStatus: 'released',
    discard: true,
  });
  candidate = await accountStore.pool.query('select id from registration_candidates where registration_job_id = $1', [job.id]);
  account = await accountStore.pool.query('select lifecycle_stage, account_snapshot_json from accounts where id = $1', [job.accountId]);
  assert.equal(candidate.rowCount, 0);
  assert.equal(account.rows[0].lifecycle_stage, 'abandoned');
  assert.equal(account.rows[0].account_snapshot_json.status, 'abandoned');
});

databaseTest('registration scratch cleanup preserves active, completed, and cleanup-required ownership', async (t) => {
  const store = new AccountAssetStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const rows = await store.pool.query(`
    insert into accounts(email, lifecycle_stage, source)
    values
      ($1, 'abandoned', 'mail_com_split'),
      ($2, 'registering', 'mail_com_split'),
      ($3, 'abandoned', 'mail_com_split'),
      ($4, 'abandoned', 'mail_com_split')
    returning id, email
  `, [
    `scratch-${suffix}@example.com`,
    `active-${suffix}@example.com`,
    `completed-${suffix}@example.com`,
    `cleanup-${suffix}@example.com`,
  ]);
  const byEmail = Object.fromEntries(rows.rows.map((row) => [row.email, row.id]));
  const activeJob = randomUUID();
  const completedJob = randomUUID();
  await store.pool.query(`
    insert into registration_jobs(id, account_id, status, step, branch, mode, mailbox_source)
    values ($1, $2, 'queued', 'queued', 'freepp', 'register', 'manual'),
           ($3, $4, 'completed', 'completed', 'freepp', 'register', 'manual')
  `, [
    activeJob,
    byEmail[`active-${suffix}@example.com`],
    completedJob,
    byEmail[`completed-${suffix}@example.com`],
  ]);
  await store.pool.query(`
    insert into registration_job_inputs(job_id, registration_password)
    values ($1, 'secret'), ($2, 'secret')
  `, [activeJob, completedJob]);
  const mailbox = await store.pool.query(`
    insert into mailboxes(provider, email, password)
    values ('mail_com', $1, 'secret') returning id
  `, [`scratch-main-${suffix}@example.com`]);
  await store.pool.query(`
    insert into email_aliases(mailbox_id, email, status, account_id)
    values ($1, $2, 'cleanup_required', $3)
  `, [mailbox.rows[0].id, `cleanup-${suffix}@example.com`, byEmail[`cleanup-${suffix}@example.com`]]);

  const result = await store.clearRegistrationScratch({ source: 'mail_com_split' });
  assert.equal(result.deletedScratchAccounts, 1);
  const remaining = await store.pool.query('select email from accounts where id = any($1::uuid[]) order by email', [Object.values(byEmail)]);
  assert.deepEqual(remaining.rows.map((row) => row.email), [
    `active-${suffix}@example.com`,
    `cleanup-${suffix}@example.com`,
    `completed-${suffix}@example.com`,
  ].sort());
});

databaseTest('mail.com split cleanup preserves active registration rows', async (t) => {
  const store = new AccountAssetStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().slice(0, 8);
  const email = `active-${suffix}@example.com`;
  const account = await store.pool.query(`
    insert into accounts(email, lifecycle_stage, source, password_status, totp_status)
    values ($1, 'registering', 'mail_com_split', 'unknown', 'unknown')
    returning id
  `, [email]);
  const mailbox = await store.pool.query(`
    insert into mailboxes(provider, email, password)
    values ('mail_com', $1, 'secret')
    returning id
  `, [`active-main-${suffix}@example.com`]);
  const alias = await store.pool.query(`
    insert into email_aliases(mailbox_id, email, status, account_id)
    values ($1, $2, 'registering', $3)
    returning id
  `, [mailbox.rows[0].id, email, account.rows[0].id]);
  const jobId = randomUUID();
  await store.pool.query(`
    insert into registration_jobs(
      id, account_id, status, step, branch, mode, mailbox_source, mailbox_id, alias_id
    )
    values ($1, $2, 'queued', 'queued', 'freepp', 'register', 'mail_com_split', $3, $4)
  `, [jobId, account.rows[0].id, mailbox.rows[0].id, alias.rows[0].id]);
  await store.pool.query(`
    insert into registration_job_inputs(job_id, registration_password)
    values ($1, 'secret')
  `, [jobId]);
  await store.pool.query(`
    insert into registration_candidates(email, mailbox_source, status, registration_job_id)
    values ($1, 'mail_com_split', 'started', $2)
  `, [email, jobId]);
  await store.cleanupInvalidMailComWorkflowRows({
    requirePassword: true,
    requireTotp: true,
  });
  const remainingCandidate = await store.pool.query(
    'select id from registration_candidates where email = $1',
    [email],
  );
  const remainingAccount = await store.pool.query(
    'select lifecycle_stage from accounts where email = $1',
    [email],
  );
  assert.equal(remainingCandidate.rowCount, 1);
  assert.equal(remainingAccount.rows[0].lifecycle_stage, 'registering');
});
