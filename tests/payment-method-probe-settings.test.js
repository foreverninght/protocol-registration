'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PaymentMethodProbeSettings } = require('../src/payment/payment-method-probe-settings');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

test('payment method probe persists the dedicated single proxy pool', async () => {
  const store = new MemoryRuntimeStateStore();
  const settings = new PaymentMethodProbeSettings({ store });
  await settings.initialize();

  const saved = await settings.update({
    proxyPoolId: 'probe-pool',
  });
  assert.equal(saved.proxyPoolId, 'probe-pool');
  assert.equal(saved.entryProxyPoolId, undefined);
  assert.equal(saved.exitProxyPoolId, undefined);
  assert.equal(saved.enabled, true);
  assert.equal(saved.autoRunAfterRegistration, true);

  const raw = store.settings.get('payment.method_probe').value;
  assert.equal(raw.proxyPoolId, 'probe-pool');
  assert.equal(raw.entryProxyPoolId, undefined);
  assert.equal(raw.exitProxyPoolId, undefined);
  assert.equal(raw.serviceBaseUrl, undefined);
  assert.equal(raw.internalKey, undefined);
});

test('legacy dual proxy fields are folded into the single probe pool', async () => {
  const store = new MemoryRuntimeStateStore();
  await store.initializeSetting('payment.method_probe', {
    enabled: false,
    autoRunAfterRegistration: false,
    entryProxyPoolId: 'legacy-entry',
    exitProxyPoolId: 'legacy-exit',
  });

  const settings = new PaymentMethodProbeSettings({ store });
  await settings.initialize();
  const config = settings.getSecretConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.autoRunAfterRegistration, false);
  assert.equal(config.proxyPoolId, 'legacy-entry');
  assert.equal(config.entryProxyPoolId, undefined);
  assert.equal(config.exitProxyPoolId, undefined);
  assert.equal(config.serviceBaseUrl, undefined);
  const migrated = store.settings.get('payment.method_probe').value;
  assert.equal(migrated.entryProxyPoolId, undefined);
  assert.equal(migrated.exitProxyPoolId, undefined);
});
