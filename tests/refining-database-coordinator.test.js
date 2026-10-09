'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RefiningCoordinator } = require('../src/refining/coordinator');

function memoryAccountStore(initialAccounts) {
  const accounts = new Map(initialAccounts.map((account) => [account.email, structuredClone({ version: 0, ...account })]));
  const view = (account) => account ? structuredClone(account) : null;
  return {
    async getByEmail(email) { return view(accounts.get(email)); },
    async list({ source = '' } = {}) {
      return [...accounts.values()].filter((account) => !source || account.source === source).map(view);
    },
    async updateByEmail({ email, patch, expectedVersion = null }) {
      const account = accounts.get(email);
      if (!account) throw new Error(`missing account: ${email}`);
      if (expectedVersion !== null) assert.equal(expectedVersion, account.version);
      const next = { ...account, ...structuredClone(patch), version: account.version + 1 };
      accounts.set(email, next);
      return view(next);
    },
    async updateManyByEmail(updates) {
      for (const update of updates) await this.updateByEmail(update);
      return Promise.all(updates.map((update) => this.getByEmail(update.email)));
    },
  };
}

function coordinator(accountStore, proxyLines = []) {
  return new RefiningCoordinator({
    accountStore,
    proxyPools: { checkout: { listRaw: () => proxyLines.map((raw) => ({ raw })) } },
    settings: {
      getSecretConfig: () => ({
        enabled: true,
        provider: 'pay153',
        autoStartedAt: null,
        entryProxyPoolId: 'entry-pool',
        exitProxyPoolId: 'exit-pool',
        linkType: 'gopay',
        concurrency: 1,
        retryCount: 1,
      }),
      getPublicConfig: () => ({}),
    },
    runtime: {
      listBatches: () => [],
      activeBatches: () => [],
      getPublicState: () => ({}),
      setLastError: () => {},
    },
    client: {},
  });
}

test('refining candidate queues and completes through database account state only', async () => {
  const accountStore = memoryAccountStore([{
    email: 'refine@example.com',
    source: 'mail_com_split',
    status: 'registered',
    mailComStage: 'refining',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
  }]);
  const refining = coordinator(accountStore);

  const queued = await refining.enqueueCurrent();
  assert.deepEqual(queued.queued, ['refine@example.com']);
  let account = await accountStore.getByEmail('refine@example.com');
  assert.equal(account.refiningJob.status, 'pending');

  await accountStore.updateByEmail({
    email: account.email,
    expectedVersion: account.version,
    patch: {
      refiningJob: {
        status: 'done',
        baToken: 'BA-DATABASE123',
        resultUrl: 'https://example.test/checkout',
      },
    },
  });
  assert.deepEqual(await refining.moveCompletedAccountsToPendingPayment(), ['refine@example.com']);
  account = await accountStore.getByEmail('refine@example.com');
  assert.equal(account.mailComStage, 'pending_payment');
  assert.equal(account.refiningJob.baToken, 'BA-DATABASE123');
});

test('refining treats non-BA payment links as usable artifacts', async () => {
  const accountStore = memoryAccountStore([{
    email: 'payment-link@example.com',
    source: 'mail_com_split',
    mailComStage: 'refining',
    refiningJob: { status: 'done', resultUrl: 'https://example.test/no-token' },
  }]);
  const refining = coordinator(accountStore);

  assert.deepEqual(await refining.markCompletedRefiningWithoutBaToken(), []);
  assert.deepEqual(await refining.moveCompletedAccountsToPendingPayment(), ['payment-link@example.com']);
  const account = await accountStore.getByEmail('payment-link@example.com');
  assert.equal(account.refiningJob.status, 'done');
  assert.equal(account.mailComStage, 'pending_payment');
});

test('refining preserves PAY.153 entry and exit proxy roles', () => {
  const refining = new RefiningCoordinator({
    accountStore: memoryAccountStore([]),
    proxyPools: { checkout: { listRaw: (poolId) => [{ raw: poolId === 'entry-pool' ? '127.0.0.1:8001' : '127.0.0.2:8002' }] } },
    settings: { getSecretConfig: () => ({}), getPublicConfig: () => ({}) },
    runtime: { listBatches: async () => [], setLastError: async () => {} },
    client: {},
  });
  const payload = refining.proxyPayload({
    provider: 'pay153',
    entryProxyPoolId: 'entry-pool',
    exitProxyPoolId: 'exit-pool',
    linkType: 'gopay',
    concurrency: 1,
    retryCount: 1,
  }, 1);

  assert.notDeepEqual(payload.entry, payload.exit);
});

test('GC refining selects site and worker proxies from their configured roles', async () => {
  const requestedPools = [];
  const refining = new RefiningCoordinator({
    accountStore: memoryAccountStore([]),
    proxyPools: {
      checkout: {
        listRaw(poolId) {
          requestedPools.push(poolId);
          return [
            { raw: '127.0.0.1:8001' },
            { raw: '127.0.0.2:8002' },
            { raw: '127.0.0.3:8003' },
            { raw: '127.0.0.4:8004', cooldownUntil: new Date(Date.now() + 60_000).toISOString() },
          ];
        },
      },
    },
    settings: { getSecretConfig: () => ({}), getPublicConfig: () => ({}) },
    runtime: { listBatches: async () => [], setLastError: async () => {} },
    client: {},
  });
  const settings = { entryProxyPoolId: 'gc-site-pool', exitProxyPoolId: 'gc-worker-pool' };
  const site = await refining.pickGcTacmonProxyLine(settings, '站点代理');
  const workers = await refining.pickGcTacmonProxyLines(settings, '执行代理', 2, new Set([site]));

  assert.deepEqual(requestedPools, ['gc-site-pool', 'gc-worker-pool']);
  assert.equal(workers.length, 2);
  assert.equal(workers.includes(site), false);
  assert.equal([site, ...workers].includes('127.0.0.4:8004'), false);
});
