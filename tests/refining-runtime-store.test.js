'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { RefiningRuntimeStore } = require('../src/refining/runtime-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';

test('refining runtime batches are durable, unique, concurrent-safe, and publicly redacted', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString });
  const store = new RefiningRuntimeStore({ pool });
  t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '005_refining_runtime.sql'), 'utf8'));
  const suffix = randomUUID().slice(0, 8);

  const batch = {
    id: `local-runtime-${suffix}`,
    remoteBatchId: `remote-runtime-${suffix}`,
    status: 'queued',
    emails: ['runtime@example.com'],
    config: {
      provider: 'pay153',
      cdkLockKey: 'secret-lock',
      gcTacmonSiteProxyLine: 'site-secret',
      gcTacmonWorkerProxyLines: ['worker-secret'],
      plan: 'plus',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.addBatch(batch);
  await assert.rejects(store.addBatch({ ...batch, id: `local-runtime-conflict-${suffix}` }), {
    code: 'REFINING_BATCH_CONFLICT',
  });

  await Promise.all([
    store.updateBatch(batch.id, { status: 'running' }),
    store.updateBatch(batch.id, { remoteNotFoundAttempts: 1 }),
  ]);
  const persisted = (await store.listBatches()).find((entry) => entry.id === batch.id);
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.remoteNotFoundAttempts, 1);

  await store.setLastError(Object.assign(new Error('runtime failure'), { code: 'RUNTIME_TEST' }));
  const publicState = await store.getPublicState();
  assert.equal(publicState.lastError.code, 'RUNTIME_TEST');
  const publicBatch = publicState.batches.find((entry) => entry.id === batch.id);
  assert.equal(publicBatch.config.plan, 'plus');
  assert.equal(publicBatch.config.cdkLockKey, undefined);
  assert.equal(publicBatch.config.gcTacmonSiteProxyLine, undefined);
  assert.equal(publicBatch.config.gcTacmonWorkerProxyLines, undefined);
});
