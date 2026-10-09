'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProxyPools } = require('../src/proxies/proxy-pools');
const { RefiningCoordinator } = require('../src/refining/coordinator');
const { RefiningSettings } = require('../src/refining/settings');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

class MemoryAccountAssetStore {
  constructor(accounts) {
    this.accounts = new Map(accounts.map((account) => [account.email, structuredClone(account)]));
  }

  async getByEmail(email) {
    const value = this.accounts.get(String(email || '').toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async list({ source = '' } = {}) {
    return [...this.accounts.values()]
      .filter((account) => !source || account.source === source)
      .map((account) => structuredClone(account));
  }

  async updateByEmail({ email, expectedVersion = null, patch }) {
    const key = String(email || '').toLowerCase();
    const current = this.accounts.get(key);
    if (!current) throw Object.assign(new Error('account not found'), { code: 'ACCOUNT_NOT_FOUND' });
    if (expectedVersion !== null && Number(expectedVersion) !== Number(current.version)) {
      throw Object.assign(new Error('account changed'), { code: 'ACCOUNT_VERSION_CONFLICT' });
    }
    const next = { ...current, ...structuredClone(patch), version: current.version + 1 };
    this.accounts.set(key, next);
    return structuredClone(next);
  }

  async updateManyByEmail(updates) {
    const snapshots = new Map(this.accounts);
    try {
      const results = [];
      for (const update of updates) results.push(await this.updateByEmail(update));
      return results;
    } catch (error) {
      this.accounts = snapshots;
      throw error;
    }
  }
}

class MemoryRefiningRuntimeStore {
  constructor() {
    this.batches = [];
    this.lastError = null;
  }

  async listBatches() { return structuredClone(this.batches).reverse(); }
  async activeBatches() {
    return (await this.listBatches()).filter((batch) => ['queued', 'running', 'cancelling'].includes(batch.status));
  }
  async addBatch(batch) {
    if (this.batches.some((item) => item.id === batch.id || (batch.remoteBatchId && item.remoteBatchId === batch.remoteBatchId))) {
      throw Object.assign(new Error('batch conflict'), { code: 'REFINING_BATCH_CONFLICT' });
    }
    this.batches.push(structuredClone(batch));
    this.lastError = null;
    return structuredClone(batch);
  }
  async updateBatch(id, patch) {
    const index = this.batches.findIndex((batch) => batch.id === id || batch.remoteBatchId === id);
    if (index < 0) return null;
    this.batches[index] = { ...this.batches[index], ...structuredClone(patch), updatedAt: new Date().toISOString() };
    return structuredClone(this.batches[index]);
  }
  async setLastError(error) {
    this.lastError = error ? { code: error.code || null, message: String(error.message || error) } : null;
  }
  async getPublicState() { return { batches: await this.listBatches(), lastError: this.lastError }; }
}

async function fixture({ result = { checkout_url: 'https://example.com/pay', ba_token: 'BA-DATABASE123' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-refining-db-'));
  const store = new MemoryRuntimeStateStore();
  const proxyPools = createProxyPools({ store });
  await proxyPools.initialize();
  const pool = await proxyPools.checkout.createPool({ name: 'one-pool' });
  await proxyPools.checkout.importText('127.0.0.1:8001:user:pass\n127.0.0.2:8002:user:pass', { poolId: pool.id });
  const settings = new RefiningSettings({ store });
  await settings.initialize();
  await settings.update({
    enabled: true,
    batchWindowSeconds: 0,
    concurrency: 1,
    retryCount: 1,
    linkType: 'gopay',
    entryProxyPoolId: pool.id,
    exitProxyPoolId: pool.id,
  });
  const accountStore = new MemoryAccountAssetStore([{
    email: 'eligible@example.com',
    source: 'mail_com_split',
    status: 'registered',
    lifecycleStage: 'refining',
    mailComStage: 'refining',
    eligibilityStatus: 'eligible',
    trialEligibility: { status: 'eligible' },
    tokens: { accessToken: 'access-token' },
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);
  const runtime = new MemoryRefiningRuntimeStore();
  const starts = [];
  const client = {
    async startBatch(config, payload) {
      starts.push({ config, payload });
      return { batch_id: 'remote-db-1', total: 1, concurrency: 1 };
    },
    async getBatch() {
      return {
        status: 'done',
        summary: { total: 1, done: 1, error: 0 },
        children: [{ email: 'eligible@example.com', status: 'done', percent: 100, result }],
      };
    },
    supportsIdempotency() { return true; },
  };
  const coordinator = new RefiningCoordinator({ accountStore, proxyPools, settings, runtime, client });
  return { root, accountStore, runtime, coordinator, settings, starts, pool };
}

test('database-only refining completes once and moves a BA result to pending payment', async (t) => {
  const context = await fixture();
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  assert.deepEqual((await context.coordinator.queueEmails(['eligible@example.com'], { includeExisting: true })).queued, ['eligible@example.com']);
  await context.coordinator.dispatchPending(context.settings.getSecretConfig());
  assert.equal((await context.runtime.activeBatches()).length, 1);
  await context.coordinator.reconcileBatch(context.settings.getSecretConfig(), (await context.runtime.activeBatches())[0]);
  const account = await context.accountStore.getByEmail('eligible@example.com');
  assert.equal(account.refiningJob.status, 'done');
  assert.equal(account.refiningJob.result.ba_token, 'BA-DATABASE123');
  assert.equal(account.mailComStage, 'pending_payment');
  assert.equal((await context.runtime.activeBatches()).length, 0);
});

test('completed refining with a non-BA payment link moves to pending payment', async (t) => {
  const context = await fixture({ result: { checkout_url: 'https://example.com/pay' } });
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  await context.coordinator.queueEmails(['eligible@example.com'], { includeExisting: true });
  await context.coordinator.dispatchPending(context.settings.getSecretConfig());
  await context.coordinator.reconcileBatch(context.settings.getSecretConfig(), (await context.runtime.activeBatches())[0]);
  const account = await context.accountStore.getByEmail('eligible@example.com');
  assert.equal(account.refiningJob.status, 'done');
  assert.equal(account.refiningJob.result.checkout_url, 'https://example.com/pay');
  assert.equal(account.mailComStage, 'pending_payment');
});

test('PAY.153 receives every configured proxy role', async (t) => {
  const context = await fixture();
  t.after(() => fs.rmSync(context.root, { recursive: true, force: true }));
  await context.coordinator.queueEmails(['eligible@example.com'], { includeExisting: true });
  await context.coordinator.dispatchPending(context.settings.getSecretConfig());
  assert.equal(context.starts.length, 1);
  assert.deepEqual(context.starts[0].payload.entry_proxies, context.starts[0].payload.exit_proxies);
  assert.ok(context.starts[0].payload.entry_proxies.length > 0);
});
