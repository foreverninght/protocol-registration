'use strict';

const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeStateStore } = require('../src/db/runtime-state-store');

const connectionString = process.env.SIGNLIST_TEST_DATABASE_URL || '';

test('runtime state keeps settings, proxies, phone workflows, and evidence in PostgreSQL', {
  skip: connectionString ? false : 'SIGNLIST_TEST_DATABASE_URL is required',
}, async (t) => {
  const store = new RuntimeStateStore({ connectionString });
  t.after(() => store.close());
  const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
  const settingKey = `test.${suffix}`;
  const poolId = `test_${suffix}`;
  const email = `phone-${suffix}@example.com`;
  const taskId = `task-${suffix}`;

  const initial = await store.initializeSetting(settingKey, { enabled: false });
  assert.equal(initial.version, 1);
  const updated = await store.updateSetting(settingKey, { enabled: true }, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  await assert.rejects(
    store.updateSetting(settingKey, { enabled: false }, { expectedVersion: 1 }),
    { code: 'SETTING_VERSION_CONFLICT' },
  );

  await store.createProxyPool({ category: 'main', id: poolId, name: `Test ${suffix}` });
  await store.replaceProxies({ category: 'main', poolId, proxies: [{
    id: `proxy_${suffix}`,
    host: '127.0.0.1',
    port: 8080,
    username: 'user',
    password: 'secret',
  }] });
  const pools = await store.listProxyPools('main');
  assert.equal(pools.find((pool) => pool.id === poolId).proxies[0].password, 'secret');

  await store.putPhoneBindWorkflow({
    email,
    workflowStage: 'otp_required',
    state: { session_id: 'session', sub2_session_id: 'sub2', cookies: [] },
    cookies: [],
  });
  assert.equal((await store.getPhoneBindWorkflow(email)).workflowStage, 'otp_required');

  await Promise.all([
    store.appendEvidence({ taskId, type: 'test.first', payload: { value: 1 } }),
    store.appendEvidence({ taskId, type: 'test.second', payload: { value: 2 } }),
  ]);
  const evidence = await store.listEvidence({ taskId });
  assert.deepEqual(evidence.map((event) => event.sequence), [1, 2]);
});
