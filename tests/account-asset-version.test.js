'use strict';

const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { AccountAssetStore } = require('../src/db/account-asset-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';

test('account asset updates reject stale versions without overwriting newer state', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString });
  const store = new AccountAssetStore({ connectionString });
  t.after(async () => Promise.all([pool.end(), store.close()]));
  const suffix = randomUUID().slice(0, 8);
  const versionedEmail = `versioned-${suffix}@example.com`;
  const batchEmail = `batch-${suffix}@example.com`;
  const missingEmail = `missing-${suffix}@example.com`;
  await pool.query(`
    insert into accounts(email, lifecycle_stage, source)
    values ($1, 'registered', 'manual'), ($2, 'registered', 'manual')
  `, [versionedEmail, batchEmail]);

  const initial = await store.getByEmail(versionedEmail, { includeSecret: true });
  assert.equal(initial.version, 0);
  const unbounded = await store.list({ limit: null });
  assert.ok(unbounded.some((account) => account.email === versionedEmail));
  assert.ok(unbounded.some((account) => account.email === batchEmail));
  const updated = await store.updateByEmail({
    email: initial.email,
    expectedVersion: initial.version,
    patch: { sessionCookieStatus: 'active' },
  });
  assert.equal(updated.version, 1);

  await assert.rejects(
    store.updateByEmail({
      email: initial.email,
      expectedVersion: initial.version,
      patch: { sessionCookieStatus: 'stale-overwrite' },
    }),
    { code: 'ACCOUNT_VERSION_CONFLICT', expectedVersion: 0, actualVersion: 1 },
  );
  const persisted = await store.getByEmail(initial.email);
  assert.equal(persisted.sessionCookieStatus, 'active');
  assert.equal(persisted.version, 1);

  const batch = await store.updateManyByEmail([
    { email: versionedEmail, expectedVersion: 1, patch: { batchState: 'updated' } },
    { email: batchEmail, expectedVersion: 0, patch: { batchState: 'updated' } },
  ]);
  assert.equal(batch.length, 2);
  assert.equal((await store.getByEmail(versionedEmail)).batchState, 'updated');
  assert.equal((await store.getByEmail(batchEmail)).batchState, 'updated');

  await assert.rejects(store.updateManyByEmail([
    { email: versionedEmail, patch: { transactionState: 'must-roll-back' } },
    { email: missingEmail, patch: { transactionState: 'missing' } },
  ]), { code: 'ACCOUNT_NOT_FOUND' });
  assert.equal((await store.getByEmail(versionedEmail)).transactionState, undefined);
});
