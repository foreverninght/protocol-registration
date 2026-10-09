#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { Pool } = require('pg');

const { LegacyJsonMigrator } = require('../src/db/legacy-json-migrator');

function parseArgs(argv) {
  const args = {
    apply: false,
    sourceQuiesced: false,
    dataDir: process.env.SIGNLIST_DATA_DIR || path.join(process.cwd(), 'data'),
    databaseUrl: process.env.SIGNLIST_DATABASE_URL || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--source-quiesced') args.sourceQuiesced = true;
    else if (value === '--dry-run') args.apply = false;
    else if (value === '--data-dir') args.dataDir = argv[++index];
    else if (value === '--database-url') args.databaseUrl = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.dataDir) throw new Error('--data-dir is required');
  return args;
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
    const migrator = new LegacyJsonMigrator({ pool, dataDir: args.dataDir });
    const result = await migrator.run({ apply: args.apply, sourceQuiesced: args.sourceQuiesced });
    process.stdout.write(`${JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', ...result }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: error.code || 'LEGACY_MIGRATION_FAILED',
    message: error.message,
    details: error.jobs || error.missing || null,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
