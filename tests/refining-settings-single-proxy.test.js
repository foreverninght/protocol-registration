'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RefiningSettings } = require('../src/refining/settings');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

test('refining settings expose both core proxy roles and the final-failure removal policy', async () => {
  const store = new MemoryRuntimeStateStore();
  const settings = new RefiningSettings({ store });
  await settings.initialize();
  const saved = await settings.update({
    entryProxyPoolId: 'entry-pool',
    exitProxyPoolId: 'exit-pool',
    deleteFailedAccounts: true,
    gcTacmonSiteProxies: 'ignored-site',
    gcTacmonWorkerProxies: 'ignored-worker',
  });

  assert.equal(saved.proxyPoolId, undefined);
  assert.equal(saved.entryProxyPoolId, 'entry-pool');
  assert.equal(saved.exitProxyPoolId, 'exit-pool');
  assert.equal(saved.deleteFailedAccounts, true);
  assert.equal(saved.gcTacmonSiteProxies, undefined);
  assert.equal(saved.gcTacmonWorkerProxies, undefined);
  const secret = settings.getSecretConfig();
  assert.equal(secret.proxyPoolId, undefined);
  assert.equal(secret.entryProxyPoolId, 'entry-pool');
  assert.equal(secret.exitProxyPoolId, 'exit-pool');
  assert.equal(secret.deleteFailedAccounts, true);
  assert.equal(secret.gcTacmonSiteProxies, undefined);
  assert.equal(secret.gcTacmonWorkerProxies, undefined);
});

test('refining uses explicit entry and exit proxy fields', async () => {
  const store = new MemoryRuntimeStateStore();
  await store.initializeSetting('refining.execution', {
    entryProxyPoolId: 'legacy-entry',
    exitProxyPoolId: 'legacy-exit',
  });

  const settings = new RefiningSettings({ store });
  await settings.initialize();
  const config = settings.getSecretConfig();
  assert.equal(config.proxyPoolId, undefined);
  assert.equal(config.entryProxyPoolId, 'legacy-entry');
  assert.equal(config.exitProxyPoolId, 'legacy-exit');
});
