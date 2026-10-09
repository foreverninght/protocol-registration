'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLegacySetting } = require('../tools/migrate_runtime_state_to_postgres');

test('runtime migration converts the temporary single-pool shape into explicit core roles', () => {
  assert.deepEqual(normalizeLegacySetting('refining.execution', {
    enabled: true,
    proxyPoolId: 'checkout-pool',
  }), {
    enabled: true,
    entryProxyPoolId: 'checkout-pool',
    exitProxyPoolId: 'checkout-pool',
  });
  assert.deepEqual(normalizeLegacySetting('payment.method_probe', {
    proxyPoolId: 'probe-pool',
    entryProxyPoolId: 'explicit-entry',
  }), {
    entryProxyPoolId: 'explicit-entry',
    exitProxyPoolId: 'probe-pool',
  });
});
