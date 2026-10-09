#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Pool } = require('pg');
const { legacyCandidateProjection } = require('../src/db/legacy-json-migrator');

function parseArgs(argv) {
  const args = {
    apply: false,
    emailFile: path.join(process.env.SIGNLIST_CLEAN_DATA_DIR || path.join(process.cwd(), 'data'), 'tasks', 'emails.json'),
    databaseUrl: process.env.SIGNLIST_DATABASE_URL || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else if (value === '--email-file') args.emailFile = argv[++index];
    else if (value === '--database-url') args.databaseUrl = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function sourceCounts(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    counts[candidate.mailboxSource] = (counts[candidate.mailboxSource] || 0) + 1;
  }
  return counts;
}

async function restoreLegacyEmailSources({ pool, emailFile, apply = false }) {
  const raw = JSON.parse(fs.readFileSync(emailFile, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('legacy emails file must contain an array');
  const candidates = raw.map(legacyCandidateProjection);
  const unique = new Set(candidates.map((candidate) => candidate.email));
  if (unique.size !== candidates.length) throw new Error('legacy emails file contains duplicate addresses');

  const existing = await pool.query(`
    select email
    from registration_candidates
    where email = any($1::text[])
  `, [[...unique]]);
  const existingEmails = new Set(existing.rows.map((row) => row.email));
  const missing = candidates.filter((candidate) => !existingEmails.has(candidate.email)).map((candidate) => candidate.email);
  if (missing.length) {
    const error = new Error(`database is missing ${missing.length} legacy email candidates`);
    error.code = 'LEGACY_EMAIL_CANDIDATES_MISSING';
    error.emails = missing.slice(0, 50);
    throw error;
  }

  const summary = {
    sourceFile: path.resolve(emailFile),
    candidates: candidates.length,
    sources: sourceCounts(candidates),
    applied: false,
    updated: 0,
  };
  if (!apply) return summary;

  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(`
      update registration_candidates candidate
      set mailbox_source = restored.mailbox_source,
          mailbox_url = restored.mailbox_url,
          mail_com_stage = restored.mail_com_stage,
          mail_com_release_status = restored.mail_com_release_status,
          mail_com_release_error = restored.mail_com_release_error,
          gcash_sold = restored.gcash_sold,
          updated_at = greatest(candidate.updated_at, restored.updated_at)
      from jsonb_to_recordset($1::jsonb) as restored(
        email text,
        mailbox_source text,
        mailbox_url text,
        mail_com_stage text,
        mail_com_release_status text,
        mail_com_release_error text,
        gcash_sold boolean,
        updated_at timestamptz
      )
      where candidate.email = restored.email
      returning candidate.id
    `, [JSON.stringify(candidates.map((candidate) => ({
      email: candidate.email,
      mailbox_source: candidate.mailboxSource,
      mailbox_url: candidate.mailboxUrl,
      mail_com_stage: candidate.mailComStage,
      mail_com_release_status: candidate.mailComReleaseStatus,
      mail_com_release_error: candidate.mailComReleaseError,
      gcash_sold: candidate.gcashSold,
      updated_at: candidate.updatedAt,
    })))]);
    if (result.rowCount !== candidates.length) {
      throw new Error(`restored ${result.rowCount} candidates, expected ${candidates.length}`);
    }
    await client.query('commit');
    return { ...summary, applied: true, updated: result.rowCount };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
    const result = await restoreLegacyEmailSources({
      pool,
      emailFile: args.emailFile,
      apply: args.apply,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: error.code || 'LEGACY_EMAIL_SOURCE_RESTORE_FAILED',
      message: error.message,
      emails: error.emails || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, restoreLegacyEmailSources, sourceCounts };
