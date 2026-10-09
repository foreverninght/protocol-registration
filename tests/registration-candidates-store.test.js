'use strict';

const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { RegistrationStore } = require('../src/db/registration-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';

test('registration candidates are imported, consumed, and deleted transactionally', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const store = new RegistrationStore({ connectionString });
  const pool = new Pool({ connectionString });
  t.after(() => Promise.all([store.close(), pool.end()]));
  const suffix = randomUUID().slice(0, 8);
  const readyEmail = `ready-${suffix}@example.com`;
  const shareEmail = `share-${suffix}@example.com`;
  const rollbackEmail = `rollback-${suffix}@example.com`;

  await assert.rejects(
    store.importCandidates([{ email: 'invalid', mailboxSource: 'manual' }]),
    { code: 'REGISTRATION_CANDIDATE_INVALID' },
  );

  const first = await store.importCandidates([
    { email: readyEmail, mailboxSource: 'manual' },
    {
      email: shareEmail,
      mailboxSource: 'share_page',
      mailboxUrl: 'https://mail.example.test/share/source',
    },
  ]);
  assert.equal(first.imported.length, 2);
  assert.deepEqual(first.existing, []);

  const duplicate = await store.importCandidates([{ email: readyEmail.toUpperCase(), mailboxSource: 'manual' }]);
  assert.equal(duplicate.imported.length, 0);
  assert.deepEqual(duplicate.existing, [readyEmail]);

  const concurrentEmail = `concurrent-${randomUUID()}@example.com`;
  const concurrent = await Promise.all([
    store.importCandidates([{ email: concurrentEmail, mailboxSource: 'manual' }]),
    store.importCandidates([{ email: concurrentEmail, mailboxSource: 'manual' }]),
  ]);
  assert.equal(concurrent.flatMap((result) => result.imported).length, 1);
  assert.equal(concurrent.flatMap((result) => result.existing).length, 1);

  const shareJobId = randomUUID();
  const shareJob = await store.createJob({
    id: shareJobId,
    email: shareEmail,
    registrationPassword: 'test-password',
    mailboxSource: 'manual',
    mailboxUrl: 'https://wrong.example.test/',
  });
  assert.equal(shareJob.mailboxSource, 'share_page');
  assert.equal(shareJob.mailboxUrl, 'https://mail.example.test/share/source');

  await assert.rejects(
    store.createJob({
      id: randomUUID(),
      email: shareEmail,
      registrationPassword: 'test-password',
    }),
    { code: 'REGISTRATION_CANDIDATE_ALREADY_STARTED' },
  );

  const started = await store.listCandidates({ status: 'started' });
  const startedShare = started.find((candidate) => candidate.email === shareEmail);
  assert.equal(startedShare.generatedTaskId, shareJobId);
  await assert.rejects(
    store.deleteReadyCandidates([startedShare.id]),
    { code: 'REGISTRATION_CANDIDATE_ALREADY_STARTED' },
  );

  const rollbackCandidate = (await store.importCandidates([
    { email: rollbackEmail, mailboxSource: 'manual' },
  ])).imported[0];
  await assert.rejects(
    store.createJob({
      id: shareJobId,
      email: rollbackEmail,
      registrationPassword: 'test-password',
    }),
    { code: '23505' },
  );
  const readyAfterRollback = await store.listCandidates();
  assert.ok(readyAfterRollback.some((candidate) => candidate.id === rollbackCandidate.id));

  const ready = readyAfterRollback.find((candidate) => candidate.email === readyEmail);
  assert.deepEqual(await store.deleteReadyCandidates([ready.id]), { deleted: 1, requested: 1 });
  assert.equal((await store.listCandidates()).some((candidate) => candidate.id === ready.id), false);

  await assert.rejects(
    store.deleteReadyCandidates([randomUUID()]),
    { code: 'REGISTRATION_CANDIDATE_SELECTION_INVALID' },
  );

  const mailboxEmail = `mailbox-${suffix}@example.com`;
  const aliasEmail = `alias-${suffix}@example.com`;
  const mailbox = await pool.query(`
    insert into mailboxes(provider, email, password)
    values ('mail_com', $1, 'mailbox-secret')
    returning id
  `, [mailboxEmail]);
  const alias = await pool.query(`
    insert into email_aliases(mailbox_id, email, status)
    values ($1, $2, 'unused')
    returning id
  `, [mailbox.rows[0].id, aliasEmail]);
  const mailJobId = randomUUID();
  await store.createJob({
    id: mailJobId,
    email: aliasEmail,
    registrationPassword: 'registration-secret',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.rows[0].id,
    aliasId: alias.rows[0].id,
  });
  const startedMail = (await store.listCandidates({ status: 'started' }))
    .find((candidate) => candidate.email === aliasEmail);
  assert.ok(startedMail);
  assert.equal(startedMail.mailboxSource, 'mail_com_split');
  assert.equal(startedMail.generatedTaskId, mailJobId);
});
