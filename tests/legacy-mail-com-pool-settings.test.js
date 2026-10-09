'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { restoreLegacyPoolSettings } = require('../tools/restore_legacy_mail_com_pool_settings');

function settingsFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-com-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mail-com-split.json');
  fs.writeFileSync(file, JSON.stringify({
    autoStartEnabled: false,
    autoStartTarget: 8,
    autoStartConcurrency: 5,
  }));
  return file;
}

test('pool settings dry-run is read-only and reports the exact legacy values', async (t) => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      return { rows: [{
        enabled: true,
        target_count: 1,
        concurrency: 1,
        updated_at: '2026-08-29T03:10:10.503Z',
        updated_at_version: '2026-08-29 03:10:10.503192+00',
      }] };
    },
  };
  const result = await restoreLegacyPoolSettings({ pool, settingsFile: settingsFile(t) });
  assert.deepEqual(result.legacy, { enabled: false, targetCount: 8, concurrency: 5 });
  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.equal(result.current.updatedAt, '2026-08-29 03:10:10.503192+00');
  assert.equal(queries.length, 1);
});

test('pool settings apply refuses a stale database version', async (t) => {
  let count = 0;
  const pool = {
    async query() {
      count += 1;
      if (count === 1) {
        return { rows: [{
          enabled: true,
          target_count: 1,
          concurrency: 1,
          updated_at: '2026-08-29T03:10:10.503Z',
          updated_at_version: '2026-08-29 03:10:10.503192+00',
        }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  await assert.rejects(
    restoreLegacyPoolSettings({
      pool,
      settingsFile: settingsFile(t),
      apply: true,
      expectedUpdatedAt: '2026-08-29 03:10:10.503192+00',
    }),
    { code: 'POOL_SETTINGS_CHANGED' },
  );
});
