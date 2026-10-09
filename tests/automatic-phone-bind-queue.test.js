'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AutomaticPhoneBindQueue } = require('../src/phone/automatic-phone-bind-queue');
const { classifyPhoneBindFailure, phoneBindRetryPlan } = require('../src/phone/phone-bind-retry-policy');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const failTest = (error) => { throw error; };

test('automatic phone queue respects concurrency and keeps one run per account', async () => {
  const releases = [];
  let active = 0;
  let maximum = 0;
  const runs = [];
  const queue = new AutomaticPhoneBindQueue({
    getConcurrency: () => 2,
    run: (email) => new Promise((resolve) => {
      runs.push(email);
      active += 1;
      maximum = Math.max(maximum, active);
      releases.push(() => { active -= 1; resolve(); });
    }),
    onError: failTest,
  });
  queue.enqueue('one@example.com');
  queue.enqueue('one@example.com');
  queue.enqueue('two@example.com');
  queue.enqueue('three@example.com');
  await tick();
  assert.equal(maximum, 2);
  assert.deepEqual(runs.sort(), ['one@example.com', 'two@example.com']);
  releases.shift()();
  await tick();
  assert.equal(runs.length, 3);
  while (releases.length) releases.shift()();
  await tick();
});

test('manual force entries are ordered ahead of ordinary queued accounts', async () => {
  const order = [];
  let release;
  const queue = new AutomaticPhoneBindQueue({
    getConcurrency: () => 1,
    run: (email) => new Promise((resolve) => {
      order.push(email);
      release = resolve;
    }),
    onError: failTest,
  });
  queue.enqueue('active@example.com');
  await tick();
  queue.enqueue('normal@example.com');
  queue.enqueue('manual@example.com', { force: true });
  release();
  await tick();
  assert.deepEqual(order, ['active@example.com', 'manual@example.com']);
  release();
  await tick();
  release();
});

test('queue reports run and asynchronous change failures', async () => {
  const failures = [];
  const queue = new AutomaticPhoneBindQueue({
    getConcurrency: () => 1,
    run: async () => { throw new Error('run failed'); },
    onChange: async () => { throw new Error('change failed'); },
    onError: (error, context) => failures.push({ message: error.message, ...context }),
  });
  queue.enqueue('failed@example.com');
  await tick();
  await tick();
  assert.ok(failures.some((failure) => failure.operation === 'run' && failure.email === 'failed@example.com'));
  assert.ok(failures.some((failure) => failure.operation === 'onChange'));
});

test('queue refuses to run without an explicit error sink', () => {
  assert.throws(() => new AutomaticPhoneBindQueue({
    getConcurrency: () => 1,
    run: async () => {},
  }), /requires an onError callback/);
});

test('rate limits do not consume a phone retry and use bounded adaptive delay', () => {
  const error = new Error('HTTP 400 {"code":"rate_limit_exceeded"}');
  assert.equal(classifyPhoneBindFailure(error), 'rate_limit');
  const plan = phoneBindRetryPlan({
    error,
    account: { phoneBindSmsAttempt: 7, phoneBindRetryKind: 'rate_limit', phoneBindRetryCount: 1 },
    settings: { smsPhoneRetryLimit: 40 },
    now: 0,
  });
  assert.equal(plan.retry, true);
  assert.equal(plan.consumesNumber, false);
  assert.equal(plan.phoneAttempt, 7);
  assert.equal(plan.delayMs, 30000);
});

test('number risk failures stop at the configured total number count', () => {
  const error = new Error('{"code":"fraud_guard"}');
  const allowed = phoneBindRetryPlan({
    error,
    account: { phoneBindSmsAttempt: 40 },
    settings: { smsPhoneRetryLimit: 40 },
    now: 0,
  });
  assert.equal(allowed.retry, true);
  assert.equal(allowed.maxNumbers, 41);
  const exhausted = phoneBindRetryPlan({
    error,
    account: { phoneBindSmsAttempt: 41 },
    settings: { smsPhoneRetryLimit: 40 },
    now: 0,
  });
  assert.equal(exhausted.retry, false);
});
