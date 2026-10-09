'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MailComRegistrationControl } = require('../src/mailbox/mail-com-registration-control');

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

function fixture(registrationStore, runner) {
  return new MailComRegistrationControl({
    mailboxStore: {getPoolSettings: async () => ({enabled:false, concurrency:1, targetCount:1})},
    registrationStore, runner, workerId:'fixture-worker', queueSource:'',
  });
}

test('stop waits for an active task without claiming its queued successor', async () => {
  const gate = deferred();
  const jobs = ['a', 'b'];
  const started = [];
  const control = fixture({claimNextJob: async () => jobs.length ? {id:jobs.shift()} : null}, {
    runClaimed: async task => {started.push(task.id); await gate.promise;},
  });
  assert.equal((await control.drainDatabaseQueue()).claimed, 1);
  let stopped = false;
  const stopping = control.stop().then(() => {stopped = true;});
  await Promise.resolve();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  assert.deepEqual(started, ['a']);
  assert.deepEqual(jobs, ['b']);
  assert.equal((await control.drainDatabaseQueue()).claimed, 0);
  control.scheduleTask();
  control.startQueuePolling();
  control.scheduleGlobalRefill();
  assert.equal(control.queuePollTimer, null);
  assert.equal(control.refillTimer, null);
});

test('stop during a claim returns that lease without starting the sidecar', async () => {
  const entered = deferred();
  const claimed = deferred();
  const released = [];
  let runs = 0;
  const control = fixture({
    claimNextJob: async () => {entered.resolve(); return claimed.promise;},
    releaseClaim: async claim => {released.push(claim);return true;},
  }, {runClaimed: async () => {runs += 1;}});
  const draining = control.drainDatabaseQueue();
  await entered.promise;
  const stopping = control.stop();
  claimed.resolve({id:'job-a', attemptCount:3, claimedBy:'fixture-worker'});
  await draining;
  await stopping;
  assert.equal(runs, 0);
  assert.deepEqual(released, [{jobId:'job-a', workerId:'fixture-worker', attemptCount:3}]);
});
