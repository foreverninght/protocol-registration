'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PaymentCoordinator, paymentJobCookie } = require('../src/payment/payment-coordinator');

function memoryAccountStore(initial) {
  let account = structuredClone({ version: 0, ...initial });
  return {
    async getByEmail(email) {
      return account && account.email === email ? structuredClone(account) : null;
    },
    async updateByEmail({ email, patch, expectedVersion = null }) {
      assert.equal(email, account.email);
      if (expectedVersion !== null) assert.equal(expectedVersion, account.version);
      account = { ...account, ...structuredClone(patch), version: account.version + 1 };
      return structuredClone(account);
    },
    async list() { return account ? [structuredClone(account)] : []; },
    value() { return structuredClone(account); },
  };
}

test('payment jobs use a stable isolated owner cookie per account', () => {
  const first = paymentJobCookie('First@Example.com');
  assert.equal(first, paymentJobCookie('first@example.com'));
  assert.match(first, /^paypal_web_device_id=[a-f0-9]{32}$/u);
  assert.notEqual(first, paymentJobCookie('second@example.com'));
});

test('successful automatic payment saves paid stage and emits one phone-bind continuation', async () => {
  const accountStore = memoryAccountStore({
    email: 'paid@example.com',
    source: 'mail_com_split',
    mailComStage: 'pending_payment',
    payment: { status: 'running', jobId: 'job-1' },
  });
  const continuations = [];
  const coordinator = new PaymentCoordinator({
    accountStore,
    proxyPools: {},
    settings: {},
    onPaymentCompleted: (event) => continuations.push(event),
  });
  coordinator.request = async () => ({
    status: 'completed',
    result: { status: 'success' },
    phone: '+12025550100',
  });

  await coordinator.reconcile('paid@example.com', accountStore.value().payment);

  const account = accountStore.value();
  assert.equal(account.payment.status, 'completed');
  assert.equal(account.mailComStage, 'paid');
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].email, 'paid@example.com');
  assert.equal(continuations[0].payment.status, 'completed');
});

test('final failed payment is removed from usable inventory and does not start phone binding', async () => {
  const accountStore = memoryAccountStore({
    email: 'failed@example.com',
    source: 'mail_com_split',
    mailComStage: 'pending_payment',
    payment: { status: 'running', jobId: 'job-2' },
  });
  const continuations = [];
  const failures = [];
  const coordinator = new PaymentCoordinator({
    accountStore,
    proxyPools: {},
    settings: {},
    onPaymentCompleted: (event) => continuations.push(event),
    onFinalPaymentFailed: (event) => failures.push(event),
  });
  coordinator.request = async () => ({ status: 'failed', error: 'declined' });

  await coordinator.reconcile('failed@example.com', accountStore.value().payment);

  const account = accountStore.value();
  assert.equal(account.payment.status, 'failed');
  assert.equal(account.payment.error, 'declined');
  assert.equal(account.mailComStage, 'pending_payment');
  assert.equal(continuations.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].email, 'failed@example.com');
});

test('job that is terminal-failed at creation triggers final-failure removal with its remote reason', async () => {
  const accountStore = memoryAccountStore({
    email: 'immediate-failure@example.com',
    source: 'mail_com_split',
    mailComStage: 'pending_payment',
    refiningJob: { baToken: 'BA-1234567890' },
  });
  const failures = [];
  const coordinator = new PaymentCoordinator({
    accountStore,
    proxyPools: { payment: { listRaw: () => [{ raw: '127.0.0.1:8080' }] } },
    settings: {
      getSecretConfig: () => ({
        enabled: true,
        serviceBaseUrl: 'http://payment.test',
        proxyPoolId: 'single-pool',
        paymentTaskRetryLimit: 2,
        smsProvider: 'smsbower',
        smsService: 'ts',
      }),
    },
    onFinalPaymentFailed: (event) => failures.push(event),
  });
  coordinator.request = async () => ({ jobs: [{ id: 'job-failed', status: 'failed', error: 'retry exhausted' }] });

  const result = await coordinator.startPayment('immediate-failure@example.com');

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'retry exhausted');
  const account = accountStore.value();
  assert.equal(account.payment.status, 'failed');
  assert.equal(account.payment.jobId, 'job-failed');
  assert.equal(account.mailComStage, 'pending_payment');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].payment.error, 'retry exhausted');
});

test('automatic payment treats dynamic concurrency as a total in-flight limit', async () => {
  const records = [
    { email: 'active-1@example.com', mailComStage: 'pending_payment', payment: { status: 'running' } },
    { email: 'active-2@example.com', mailComStage: 'pending_payment', payment: { status: 'awaiting_otp' } },
    { email: 'ready-1@example.com', mailComStage: 'pending_payment', payment: null },
    { email: 'ready-2@example.com', mailComStage: 'pending_payment', payment: null },
  ];
  const started = [];
  const coordinator = new PaymentCoordinator({
    accountStore: {
      async list() { return structuredClone(records); },
      async getByEmail(email) { return structuredClone(records.find((account) => account.email === email)); },
    },
    proxyPools: {},
    settings: { getSecretConfig: () => ({ enabled: true }) },
    getConcurrency: () => 3,
  });
  coordinator.startPayment = async (email) => { started.push(email); };

  const result = await coordinator.autoStartPendingPayments();

  assert.deepEqual(started, ['ready-1@example.com']);
  assert.deepEqual(result.started, ['ready-1@example.com']);
});
