'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyPools } = require('../src/proxies/proxy-pools');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

test('concurrent proxy selections are serialized within one database-backed pool', async () => {
  const store = new MemoryRuntimeStateStore();
  const pools = createProxyPools({ store });
  await pools.initialize();
  const pool = await pools.main.createPool({ name: 'concurrent' });
  await pools.main.importText([
    '127.0.0.1:8001:user:pass',
    '127.0.0.2:8002:user:pass',
  ].join('\n'), { poolId: pool.id });

  const selected = await Promise.all([
    pools.main.pickNext({ poolId: pool.id }),
    pools.main.pickNext({ poolId: pool.id }),
  ]);
  assert.equal(new Set(selected.map((proxy) => proxy.id)).size, 2);
});
