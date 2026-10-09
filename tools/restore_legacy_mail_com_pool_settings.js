#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function parseArgs(argv) {
  const args = {
    apply: false,
    settingsFile: path.join(
      process.env.SIGNLIST_CLEAN_DATA_DIR || path.join(process.cwd(), 'data'),
      'settings',
      'mail-com-split.json',
    ),
    databaseUrl: process.env.SIGNLIST_DATABASE_URL || '',
    expectedUpdatedAt: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else if (value === '--settings-file') args.settingsFile = argv[++index];
    else if (value === '--database-url') args.databaseUrl = argv[++index];
    else if (value === '--expected-updated-at') args.expectedUpdatedAt = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function legacyPoolSettings(raw = {}) {
  return {
    enabled: raw.autoStartEnabled !== false,
    targetCount: Math.max(1, Math.min(100, Math.trunc(Number(raw.autoStartTarget) || 9))),
    concurrency: Math.max(1, Math.min(30, Math.trunc(Number(raw.autoStartConcurrency) || 1))),
  };
}

async function restoreLegacyPoolSettings({ pool, settingsFile, apply = false, expectedUpdatedAt = '' }) {
  const legacy = legacyPoolSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
  const currentResult = await pool.query(`
    select enabled, target_count, concurrency, updated_at,
           updated_at::text as updated_at_version
    from registration_pool_settings
    where singleton = true
  `);
  const currentRow = currentResult.rows[0];
  if (!currentRow) throw new Error('registration pool settings row is missing');
  const current = {
    enabled: Boolean(currentRow.enabled),
    targetCount: Number(currentRow.target_count),
    concurrency: Number(currentRow.concurrency),
    updatedAt: String(currentRow.updated_at_version || new Date(currentRow.updated_at).toISOString()),
  };
  const summary = {
    sourceFile: path.resolve(settingsFile),
    legacy,
    current,
    changed: legacy.enabled !== current.enabled
      || legacy.targetCount !== current.targetCount
      || legacy.concurrency !== current.concurrency,
    applied: false,
  };
  if (!apply) return summary;
  if (!expectedUpdatedAt) {
    const error = new Error('--apply requires --expected-updated-at from the immediately preceding dry-run');
    error.code = 'POOL_SETTINGS_EXPECTED_VERSION_REQUIRED';
    throw error;
  }
  const updated = await pool.query(`
    update registration_pool_settings
    set enabled = $1, target_count = $2, concurrency = $3, updated_at = now()
    where singleton = true and updated_at::text = $4
    returning updated_at
  `, [legacy.enabled, legacy.targetCount, legacy.concurrency, expectedUpdatedAt]);
  if (updated.rowCount !== 1) {
    const error = new Error('pool settings changed after dry-run; refusing to overwrite them');
    error.code = 'POOL_SETTINGS_CHANGED';
    throw error;
  }
  return { ...summary, applied: true, updatedAt: updated.rows[0].updated_at };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool(args.databaseUrl
    ? { connectionString: args.databaseUrl, max: 2 }
    : {
      database: process.env.SIGNLIST_DATABASE_NAME || 'signlist',
      user: process.env.SIGNLIST_DATABASE_USER || 'signlistclean',
      host: process.env.SIGNLIST_DATABASE_HOST || '/var/run/postgresql',
      max: 2,
    });
  try {
    process.stdout.write(`${JSON.stringify(await restoreLegacyPoolSettings({
      pool,
      settingsFile: args.settingsFile,
      apply: args.apply,
      expectedUpdatedAt: args.expectedUpdatedAt,
    }), null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: error.code || 'LEGACY_POOL_SETTINGS_RESTORE_FAILED',
      message: error.message,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { legacyPoolSettings, parseArgs, restoreLegacyPoolSettings };
