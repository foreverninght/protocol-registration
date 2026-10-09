'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXECUTION_TYPES,
  EXECUTION_IMPLEMENTATIONS,
  FINGERPRINT_BROWSERS,
  executionType,
  executionImplementation,
  executionTypeForImplementation,
  fingerprintBrowser,
  usesFingerprintBrowser,
  publicExecutionCatalog,
} = require('../src/registration/execution-catalog');
const { registrationEntryBranchFromEnv, browserEngineFromEnv } = require('../src/app/config');

test('registration execution catalog keeps stable numeric ids and unique keys', () => {
  for (const items of [EXECUTION_TYPES, EXECUTION_IMPLEMENTATIONS, FINGERPRINT_BROWSERS]) {
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.equal(new Set(items.map((item) => item.key)).size, items.length);
    assert.ok(items.every((item) => Number.isInteger(item.id) && item.id > 0));
  }
});

test('execution types and selectable implementations are separated', () => {
  assert.equal(executionType(1).key, 'browser');
  assert.equal(executionType(2).key, 'hybrid');
  assert.equal(executionType(3).key, 'protocol');
  assert.deepEqual(
    EXECUTION_IMPLEMENTATIONS.filter((item) => item.type === 'browser').map((item) => item.key),
    ['flowpilot'],
  );
  assert.deepEqual(
    EXECUTION_IMPLEMENTATIONS.filter((item) => item.type === 'hybrid').map((item) => item.key),
    ['context_protocol'],
  );
  assert.deepEqual(
    EXECUTION_IMPLEMENTATIONS.filter((item) => item.type === 'protocol').map((item) => item.key),
    ['freepp'],
  );
});

test('fingerprint browser selection applies only to browser-assisted types', () => {
  assert.equal(usesFingerprintBrowser('flowpilot'), true);
  assert.equal(usesFingerprintBrowser('direct'), true);
  assert.equal(usesFingerprintBrowser('context_protocol'), true);
  assert.equal(usesFingerprintBrowser('freepp'), false);
  assert.equal(usesFingerprintBrowser('freepp_har'), false);
  assert.equal(fingerprintBrowser(1).key, 'cloak');
  assert.equal(browserEngineFromEnv({ BROWSER_ENGINE: '1' }), 'cloak');
});

test('legacy half-protocol names do not silently resolve to a browser implementation', () => {
  for (const value of ['half', 'semi', 'semiprotocol', 'half-protocol']) {
    assert.equal(executionImplementation(value), null);
    assert.throws(
      () => registrationEntryBranchFromEnv({ REGISTRATION_ENTRY_BRANCH: value }),
      /unsupported REGISTRATION_ENTRY_BRANCH/u,
    );
  }
});

test('protocol aliases resolve through the catalog and public catalog is serializable', () => {
  assert.equal(registrationEntryBranchFromEnv({ REGISTRATION_ENTRY_BRANCH: 'direct' }), 'flowpilot');
  assert.equal(registrationEntryBranchFromEnv({}), 'freepp');
  for (const value of ['freepp_har', 'freepp-har', 'freepphar', 'har', '302']) {
    assert.equal(executionImplementation(value), null);
    assert.equal(executionTypeForImplementation(value), null);
    assert.throws(() => registrationEntryBranchFromEnv({ REGISTRATION_ENTRY_BRANCH: value }), { code: 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED' });
  }
  assert.doesNotThrow(() => JSON.stringify(publicExecutionCatalog()));
});
