'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentMethodProbeCoordinator } = require('../src/payment/payment-method-probe-coordinator');

function memoryAccountStore(initial) {
  let account = structuredClone(initial);
  return {
    async getByEmail(email) {
      return account && account.email === email ? structuredClone(account) : null;
    },
    async updateByEmail({ email, patch, expectedVersion = null }) {
      assert.equal(email, account.email);
      if (expectedVersion !== null && expectedVersion !== account.version) {
        const error = new Error('version conflict');
        error.code = 'ACCOUNT_VERSION_CONFLICT';
        throw error;
      }
      account = { ...account, ...structuredClone(patch), version: account.version + 1 };
      return structuredClone(account);
    },
    value() { return structuredClone(account); },
  };
}

function settings(overrides = {}) {
  const config = {
    enabled: true,
    autoRunAfterRegistration: true,
    mode: 'common',
    profiles: ['hosted', 'gcash'],
    proxyPoolId: 'probe-pool',
    entryProxyPoolId: 'probe-pool',
    exitProxyPoolId: 'probe-pool',
    concurrency: 1,
    retryCount: 1,
    timeoutMs: 30000,
    ...overrides,
  };
  return {
    getSecretConfig: () => config,
    getPublicConfig: () => config,
  };
}

function paymentProxyPools(lines = []) {
  const proxies = lines.map((raw, index) => ({ id: `proxy-${index + 1}`, raw }));
  return {
    payment: {
      async pickNext({ poolId, excludeIds = [] }) {
        if (poolId !== 'probe-pool') return null;
        return proxies.find((proxy) => !excludeIds.includes(proxy.id)) || null;
      },
      async markBad() {},
      async markChecked() {},
    },
  };
}

test('payment probe uses the local universal detector with a single proxy pool and saves GCash atomically', async () => {
  const accountStore = memoryAccountStore({
    email: 'probe@example.com',
    version: 0,
    source: 'mail_com_split',
    mailComStage: 'eligibility',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
    paymentCapabilities: { status: 'queued' },
  });
  let probeInput = null;
  const coordinator = new PaymentMethodProbeCoordinator({
    accountStore,
    proxyPools: paymentProxyPools([
      '127.0.0.1:10001:user:pass',
      '127.0.0.2:10002:user:pass',
    ]),
    settings: settings(),
    probeRunner: async (input) => {
      probeInput = input;
      return { ok: true, methods: ['gcash'], checkout_type: 'oaics' };
    },
  });

  await coordinator.run('probe@example.com');

  assert.equal(probeInput.accessToken, 'access-token');
  assert.match(probeInput.proxyRef, /127\.0\.0\.1:10001:user:pass/u);
  assert.match(probeInput.proxyRef, /127\.0\.0\.2:10002:user:pass/u);
  assert.equal(probeInput.maxProxyAttempts, 2);
  const account = accountStore.value();
  assert.equal(account.paymentCapabilities.status, 'done');
  assert.equal(account.paymentCapabilities.engine, 'universal_local');
  assert.equal(account.paymentCapabilities.checkoutType, 'oaics');
  assert.equal(account.paymentCapabilities.proxyPoolId, 'probe-pool');
  assert.equal(account.paymentCapabilities.entryProxyPoolId, 'probe-pool');
  assert.equal(account.paymentCapabilities.exitProxyPoolId, 'probe-pool');
  assert.equal(account.mailComStage, 'gcash');
  assert.equal(account.lifecycleStage, 'gcash');
});

test('payment probe records an explicit failure when the configured pool is empty', async () => {
  const accountStore = memoryAccountStore({
    email: 'empty-pool@example.com',
    version: 0,
    source: 'mail_com_split',
    mailComStage: 'pending_payment',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
  });
  const coordinator = new PaymentMethodProbeCoordinator({
    accountStore,
    proxyPools: paymentProxyPools(),
    settings: settings(),
    probeRunner: async () => { throw new Error('probe must not run'); },
  });

  await coordinator.run('empty-pool@example.com');

  const account = accountStore.value();
  assert.equal(account.paymentCapabilities.status, 'failed');
  assert.match(account.paymentCapabilities.error, /没有可用代理/u);
  assert.equal(account.mailComStage, 'payment_method');
  assert.equal(account.lifecycleStage, 'payment_method');
});

test('successful non-GCash payment probe moves mail.com account to refining', async () => {
  const accountStore = memoryAccountStore({
    email: 'hosted@example.com',
    version: 0,
    source: 'mail_com_split',
    mailComStage: 'pending_payment',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
    paymentCapabilities: { status: 'queued' },
  });
  const coordinator = new PaymentMethodProbeCoordinator({
    accountStore,
    proxyPools: paymentProxyPools(['127.0.0.1:10001:user:pass']),
    settings: settings(),
    probeRunner: async () => ({ ok: true, methods: ['hosted'], session_type: 'cslive' }),
  });

  await coordinator.run('hosted@example.com');

  const account = accountStore.value();
  assert.equal(account.paymentCapabilities.status, 'done');
  assert.equal(account.paymentCapabilities.checkoutType, 'cslive');
  assert.equal(account.mailComStage, 'refining');
  assert.equal(account.lifecycleStage, 'refining');
});

test('unavailable local payment probe keeps mail.com account in payment-method review', async () => {
  const accountStore = memoryAccountStore({
    email: 'unavailable@example.com',
    version: 0,
    source: 'mail_com_split',
    mailComStage: 'unregistered',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
    paymentCapabilities: { status: 'queued', serviceBaseUrl: 'http://127.0.0.1:18082' },
  });
  const coordinator = new PaymentMethodProbeCoordinator({
    accountStore,
    proxyPools: paymentProxyPools(['127.0.0.1:10001:user:pass']),
    settings: settings(),
    probeRunner: async () => ({ ok: false, methods: [], error: 'payment_method_not_available_or_probe_failed' }),
  });

  await coordinator.run('unavailable@example.com');

  const account = accountStore.value();
  assert.equal(account.paymentCapabilities.status, 'failed');
  assert.equal(account.paymentCapabilities.engine, 'universal_local');
  assert.equal(account.paymentCapabilities.serviceBaseUrl, '');
  assert.equal(account.paymentCapabilities.proxyPoolId, 'probe-pool');
  assert.equal(account.mailComStage, 'payment_method');
  assert.equal(account.lifecycleStage, 'payment_method');
});

test('queued probe starts even while adaptive concurrency is idle at zero', async () => {
  const accountStore = memoryAccountStore({
    email: 'idle@example.com',
    version: 0,
    source: 'ic',
    eligibilityStatus: 'eligible',
    tokens: { accessToken: 'access-token' },
  });
  const coordinator = new PaymentMethodProbeCoordinator({
    accountStore,
    proxyPools: paymentProxyPools(['127.0.0.1:10001:user:pass']),
    settings: settings(),
    getConcurrency: () => 0,
    probeRunner: async () => ({ ok: true, methods: ['card'], session_type: 'cslive' }),
  });

  assert.equal((await coordinator.schedule('idle@example.com')).scheduled, true);
  for (let attempt = 0; attempt < 20 && accountStore.value().paymentCapabilities?.status !== 'done'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(accountStore.value().paymentCapabilities.status, 'done');
});
