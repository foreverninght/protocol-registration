'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPipelineConcurrencyPlan,
  adaptivePipelineConcurrency,
  refiningSettingsWithPipelineConcurrency,
} = require('../src/pipeline/concurrency-planner');

test('pipeline concurrency derives every downstream stage from registration concurrency', () => {
  const plan = buildPipelineConcurrencyPlan({
    registrationConcurrency: 2,
    cpuCores: 4,
    totalMemoryMb: 8192,
  });
  assert.equal(plan.stages.registration.concurrency, 2);
  assert.equal(plan.stages.paymentMethod.concurrency, 2);
  assert.equal(plan.stages.refining.concurrency, 3);
  assert.equal(plan.stages.finalPayment.concurrency, 3);
  assert.equal(plan.stages.phoneBind.concurrency, 2);
  assert.ok(plan.estimatedPeak.cpuUnits > 0);
  assert.ok(plan.estimatedPeak.memoryMb > 0);
});

test('pipeline concurrency respects hardware and stage caps', () => {
  const plan = buildPipelineConcurrencyPlan({
    registrationConcurrency: 30,
    cpuCores: 2,
    totalMemoryMb: 3072,
  });
  assert.ok(plan.stages.paymentMethod.concurrency <= plan.stages.paymentMethod.limits.cpuCap);
  assert.ok(plan.stages.refining.concurrency <= 12);
  assert.ok(plan.stages.finalPayment.concurrency <= 12);
  assert.ok(plan.stages.phoneBind.concurrency <= 30);
  assert.ok(Object.values(plan.stages).some((stage) => stage.capped === true));
});

test('refining settings expose the effective derived concurrency', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 2, cpuCores: 4, totalMemoryMb: 8192 });
  const settings = refiningSettingsWithPipelineConcurrency({ provider: 'pay153', pay153Concurrency: 20 }, plan);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.pay153Concurrency, undefined);
  assert.equal(settings.publicCdkBatchSize, undefined);
  assert.equal(settings.gcTacmonConcurrency, undefined);
});

test('adaptive allocation lends idle downstream capacity to the active stage', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 2, cpuCores: 4, totalMemoryMb: 8192 });
  const paymentOnly = adaptivePipelineConcurrency({ plan, demand: { paymentMethod: 20 } });
  assert.equal(paymentOnly.stages.paymentMethod.concurrency, paymentOnly.stages.paymentMethod.maxConcurrency);
  assert.equal(paymentOnly.stages.refining.concurrency, 0);
  const mixed = adaptivePipelineConcurrency({ plan, demand: { paymentMethod: 5, refining: 5 } });
  assert.ok(mixed.stages.paymentMethod.concurrency >= 1);
  assert.ok(mixed.stages.refining.concurrency >= 1);
  assert.ok(mixed.resources.cpuUsed <= mixed.resources.cpuRemaining);
  assert.ok(mixed.resources.memoryUsedMb <= mixed.resources.memoryRemainingMb);
});

test('adaptive allocation throttles under host pressure and counts only real active registration workers', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 6, cpuCores: 4, totalMemoryMb: 8192 });
  const adaptive = adaptivePipelineConcurrency({
    plan,
    active: { registration: 1 },
    demand: { paymentMethod: 20, refining: 20 },
    telemetry: { load1: 3.9, freeMemoryMb: 1200 },
  });
  assert.equal(adaptive.registrationConcurrency, 1);
  assert.equal(adaptive.resources.pressure, 0.5);
  assert.equal(adaptive.registrationAdmissionOpen, false);
  assert.ok(adaptive.stages.paymentMethod.concurrency <= adaptive.stages.paymentMethod.maxConcurrency);
  assert.ok(adaptive.stages.refining.concurrency <= adaptive.stages.refining.maxConcurrency);
  assert.ok(adaptive.resources.cpuUsed <= adaptive.resources.cpuRemaining);
  assert.ok(adaptive.resources.memoryUsedMb <= adaptive.resources.memoryRemainingMb);
});

test('adaptive allocation keeps running work but admits no new worker without headroom', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 6, cpuCores: 4, totalMemoryMb: 8192 });
  const adaptive = adaptivePipelineConcurrency({
    plan,
    active: { registration: 2, paymentMethod: 3 },
    demand: { paymentMethod: 20, refining: 20 },
    telemetry: { load1: 5, freeMemoryMb: 900 },
  });
  assert.equal(adaptive.registrationConcurrency, 2);
  assert.equal(adaptive.registrationAdmissionOpen, false);
  assert.equal(adaptive.stages.paymentMethod.concurrency, 3);
  assert.equal(adaptive.stages.refining.concurrency, 0);
  assert.equal(adaptive.resources.cpuUsed, 0);
  assert.equal(adaptive.resources.memoryUsedMb, 0);
});

test('moderate pressure reduces capacity without blocking registration when headroom remains', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 2, cpuCores: 4, totalMemoryMb: 8192 });
  const adaptive = adaptivePipelineConcurrency({
    plan,
    active: { registration: 0 },
    telemetry: { load1: 2.9, freeMemoryMb: 4000 },
  });
  assert.equal(adaptive.resources.pressure, 0.75);
  assert.equal(adaptive.registrationAdmissionOpen, true);
});

test('refining runtime preserves an explicit zero allocation', () => {
  const settings = refiningSettingsWithPipelineConcurrency({ provider: 'pay153' }, {
    stages: { refining: { concurrency: 0 } },
  });
  assert.equal(settings.concurrency, 0);
});

test('adaptive allocation prioritizes backlog without starving another active stage', () => {
  const plan = buildPipelineConcurrencyPlan({ registrationConcurrency: 2, cpuCores: 4, totalMemoryMb: 8192 });
  const adaptive = adaptivePipelineConcurrency({
    plan,
    active: { registration: 2 },
    demand: { paymentMethod: 2, refining: 40, finalPayment: 3 },
    waitingMs: { paymentMethod: 10_000, refining: 300_000, finalPayment: 30_000 },
    telemetry: { load1: 1, freeMemoryMb: 4000 },
  });
  assert.ok(adaptive.stages.paymentMethod.concurrency >= 1);
  assert.ok(adaptive.stages.refining.concurrency >= 1);
  assert.ok(adaptive.stages.finalPayment.concurrency >= 1);
  assert.ok(adaptive.stages.refining.concurrency >= adaptive.stages.paymentMethod.concurrency);
  assert.ok(adaptive.resources.cpuUsed <= adaptive.resources.cpuRemaining);
});
