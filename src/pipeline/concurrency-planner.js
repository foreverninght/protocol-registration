'use strict';

const os = require('node:os');

const REGISTRATION_REFERENCE_SECONDS = 90;
const STAGE_DEFINITIONS = Object.freeze({
  paymentMethod: Object.freeze({ referenceSeconds: 55, cpuPerWorker: 0.65, memoryMbPerWorker: 384, hardMax: 8 }),
  refining: Object.freeze({ referenceSeconds: 120, cpuPerWorker: 0.35, memoryMbPerWorker: 256, hardMax: 12 }),
  finalPayment: Object.freeze({ referenceSeconds: 120, cpuPerWorker: 0.25, memoryMbPerWorker: 192, hardMax: 12 }),
  phoneBind: Object.freeze({ referenceSeconds: 90, cpuPerWorker: 0.25, memoryMbPerWorker: 192, hardMax: 30 }),
});

const REGISTRATION_RESOURCE = Object.freeze({ cpuPerWorker: 0.6, memoryMbPerWorker: 700 });

function boundedInteger(value, fallback, min = 1, max = 30) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(parsed) ? parsed : fallback)));
}

function buildPipelineConcurrencyPlan({
  registrationConcurrency,
  cpuCores = os.cpus().length,
  totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024),
} = {}) {
  const registration = boundedInteger(registrationConcurrency, 1);
  const cores = boundedInteger(cpuCores, 1, 1, 256);
  const memoryMb = boundedInteger(totalMemoryMb, 1024, 512, 1024 * 1024);
  const cpuBudget = Math.max(2, cores * 1.5);
  const memoryBudgetMb = Math.max(512, memoryMb - 2048);
  const arrivalPerMinute = registration * 60 / REGISTRATION_REFERENCE_SECONDS;
  const stages = {
    registration: {
      concurrency: registration,
      source: 'configured',
      referenceSeconds: REGISTRATION_REFERENCE_SECONDS,
      capacityPerMinute: arrivalPerMinute,
      cpuUnits: registration * REGISTRATION_RESOURCE.cpuPerWorker,
      memoryMb: registration * REGISTRATION_RESOURCE.memoryMbPerWorker,
    },
  };

  for (const [key, definition] of Object.entries(STAGE_DEFINITIONS)) {
    const desired = Math.max(1, Math.ceil(
      registration * definition.referenceSeconds / REGISTRATION_REFERENCE_SECONDS,
    ));
    const cpuCap = Math.max(1, Math.floor(cpuBudget / definition.cpuPerWorker));
    const memoryCap = Math.max(1, Math.floor(memoryBudgetMb / definition.memoryMbPerWorker));
    const concurrency = Math.max(1, Math.min(desired, definition.hardMax, cpuCap, memoryCap));
    stages[key] = {
      concurrency,
      source: 'derived',
      desiredConcurrency: desired,
      referenceSeconds: definition.referenceSeconds,
      capacityPerMinute: concurrency * 60 / definition.referenceSeconds,
      cpuUnits: concurrency * definition.cpuPerWorker,
      memoryMb: concurrency * definition.memoryMbPerWorker,
      capped: concurrency < desired,
      limits: { hardMax: definition.hardMax, cpuCap, memoryCap },
    };
  }

  const stageValues = Object.values(stages);
  return {
    mode: 'registration_derived',
    registrationConcurrency: registration,
    formula: 'ceil(registrationConcurrency * stageReferenceSeconds / registrationReferenceSeconds)',
    hardware: { cpuCores: cores, totalMemoryMb: memoryMb, cpuBudget, memoryBudgetMb },
    estimatedPeak: {
      cpuUnits: stageValues.reduce((total, stage) => total + stage.cpuUnits, 0),
      memoryMb: stageValues.reduce((total, stage) => total + stage.memoryMb, 0),
    },
    stages,
  };
}

function adaptivePipelineConcurrency({ plan, demand = {}, active: activeWorkers = {}, waitingMs = {}, limits = {}, telemetry = {} } = {}) {
  const source = plan || buildPipelineConcurrencyPlan({ registrationConcurrency: 1 });
  const configuredRegistration = boundedInteger(source.registrationConcurrency, 1);
  const reportedRegistration = Number(activeWorkers.registration);
  const registration = Math.max(0, Math.min(
    configuredRegistration,
    Number.isFinite(reportedRegistration) ? Math.trunc(reportedRegistration) : configuredRegistration,
  ));
  const load1 = Number(telemetry.load1);
  const freeMemoryMb = Number(telemetry.freeMemoryMb);
  const pressure = (Number.isFinite(freeMemoryMb) && freeMemoryMb < 1536)
    || (Number.isFinite(load1) && load1 > source.hardware.cpuCores * 0.9)
    ? 0.5
    : (Number.isFinite(freeMemoryMb) && freeMemoryMb < 2560)
      || (Number.isFinite(load1) && load1 > source.hardware.cpuCores * 0.7)
      ? 0.75
      : 1;
  const cpuTarget = source.hardware.cpuCores * 1.25 * pressure;
  const cpuRemaining = Number.isFinite(load1)
    ? Math.max(0, cpuTarget - load1)
    : source.hardware.cpuBudget * pressure;
  const memoryReserveMb = Math.min(2048, Math.max(1024, source.hardware.totalMemoryMb * 0.2));
  const memoryRemaining = Number.isFinite(freeMemoryMb)
    ? Math.max(0, freeMemoryMb - memoryReserveMb)
    : source.hardware.memoryBudgetMb * pressure;
  const registrationAdmissionOpen = pressure >= 0.75
    && cpuRemaining >= REGISTRATION_RESOURCE.cpuPerWorker
    && memoryRemaining >= REGISTRATION_RESOURCE.memoryMbPerWorker;
  const stageKeys = Object.keys(STAGE_DEFINITIONS);
  const requested = Object.fromEntries(stageKeys.map((key) => [
    key,
    Math.max(
      Math.trunc(Number(activeWorkers[key]) || 0),
      Math.trunc(Number(demand[key]) || 0),
    ),
  ]));
  const activeStages = stageKeys.filter((key) => requested[key] > 0);
  const result = Object.fromEntries(stageKeys.map((key) => [
    key,
    Math.max(0, Math.trunc(Number(activeWorkers[key]) || 0)),
  ]));
  // Host telemetry already includes running workers. Only newly admitted slots
  // consume the current headroom; existing workers remain counted in the limit
  // but are never interrupted when pressure rises.
  const added = { cpu: 0, memoryMb: 0 };
  const canAdd = (key) => {
    const definition = STAGE_DEFINITIONS[key];
    const configuredLimit = Number(limits[key]);
    const hardMax = Math.min(
      definition.hardMax,
      Number.isFinite(configuredLimit) ? Math.max(0, Math.trunc(configuredLimit)) : definition.hardMax,
    );
    const cpu = added.cpu + definition.cpuPerWorker;
    const memory = added.memoryMb + definition.memoryMbPerWorker;
    return result[key] < hardMax && result[key] < requested[key]
      && cpu <= cpuRemaining && memory <= memoryRemaining;
  };
  for (const key of [...activeStages].sort((left, right) => (
    Number(waitingMs[right] || 0) - Number(waitingMs[left] || 0)
  ))) {
    if (result[key] === 0 && canAdd(key)) {
      const definition = STAGE_DEFINITIONS[key];
      result[key] += 1;
      added.cpu += definition.cpuPerWorker;
      added.memoryMb += definition.memoryMbPerWorker;
    }
  }
  while (activeStages.some(canAdd)) {
    const key = activeStages
      .filter(canAdd)
      .sort((left, right) => {
        const leftWaitBoost = 1 + Math.min(5, Math.max(0, Number(waitingMs[left]) || 0) / 60_000);
        const rightWaitBoost = 1 + Math.min(5, Math.max(0, Number(waitingMs[right]) || 0) / 60_000);
        const leftRatio = requested[left] * leftWaitBoost / Math.max(1, result[left] + 1);
        const rightRatio = requested[right] * rightWaitBoost / Math.max(1, result[right] + 1);
        return rightRatio - leftRatio;
      })[0];
    if (!key) break;
    const definition = STAGE_DEFINITIONS[key];
    result[key] += 1;
    added.cpu += definition.cpuPerWorker;
    added.memoryMb += definition.memoryMbPerWorker;
  }
  return {
    registrationConcurrency: registration,
    registrationAdmissionOpen,
    demand: requested,
    waitingMs: Object.fromEntries(stageKeys.map((key) => [key, Math.max(0, Number(waitingMs[key]) || 0)])),
    activeStages,
    stages: Object.fromEntries(stageKeys.map((key) => [key, {
      concurrency: result[key],
      active: Math.max(0, Math.trunc(Number(activeWorkers[key]) || 0)),
      requested: requested[key],
      maxConcurrency: Math.max(result[key], Math.min(
        STAGE_DEFINITIONS[key].hardMax,
        Number.isFinite(Number(limits[key])) ? Math.max(0, Math.trunc(Number(limits[key]))) : STAGE_DEFINITIONS[key].hardMax,
        result[key] + Math.max(0, Math.floor(cpuRemaining / STAGE_DEFINITIONS[key].cpuPerWorker)),
        result[key] + Math.max(0, Math.floor(memoryRemaining / STAGE_DEFINITIONS[key].memoryMbPerWorker)),
      )),
    }])),
    resources: {
      pressure,
      admissionOpen: registrationAdmissionOpen,
      load1: Number.isFinite(load1) ? load1 : null,
      freeMemoryMb: Number.isFinite(freeMemoryMb) ? freeMemoryMb : null,
      cpuRemaining,
      memoryRemainingMb: memoryRemaining,
      cpuUsed: added.cpu,
      memoryUsedMb: added.memoryMb,
      memoryReserveMb,
    },
  };
}

function refiningSettingsWithPipelineConcurrency(settings = {}, plan = {}) {
  const concurrency = boundedInteger(plan?.stages?.refining?.concurrency, 0, 0);
  const next = {
    ...settings,
    concurrency,
    pipelineConcurrency: plan,
  };
  delete next.pay153Concurrency;
  delete next.publicCdkBatchSize;
  delete next.gcTacmonConcurrency;
  return next;
}

module.exports = {
  REGISTRATION_REFERENCE_SECONDS,
  STAGE_DEFINITIONS,
  buildPipelineConcurrencyPlan,
  adaptivePipelineConcurrency,
  refiningSettingsWithPipelineConcurrency,
};
