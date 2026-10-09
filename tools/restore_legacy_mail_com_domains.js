#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Pool } = require('pg');

function normalizeDomain(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function validDomain(value) {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    settingsFile: path.join(
      process.env.SIGNLIST_CLEAN_DATA_DIR || path.join(process.cwd(), 'data'),
      'settings',
      'mail-com-split.json',
    ),
    databaseUrl: process.env.SIGNLIST_DATABASE_URL || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else if (value === '--settings-file') args.settingsFile = argv[++index];
    else if (value === '--database-url') args.databaseUrl = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function legacyMailComDomainProjection(raw = {}) {
  const catalog = new Map();
  const remember = (value, requestedState) => {
    const domain = normalizeDomain(value?.domain || value);
    if (!validDomain(domain)) return;
    const state = requestedState === 'active' ? 'active' : 'hidden';
    const previous = catalog.get(domain);
    if (!previous || state === 'active') catalog.set(domain, { domain, state });
  };
  for (const domain of Array.isArray(raw.domains) ? raw.domains : []) remember(domain, 'active');
  for (const entry of Array.isArray(raw.sharedAvailableDomains) ? raw.sharedAvailableDomains : []) {
    remember(entry, String(entry?.state || '').toUpperCase() === 'ACTIVE' ? 'active' : 'hidden');
  }
  for (const account of Array.isArray(raw.accounts) ? raw.accounts : []) {
    for (const entry of Array.isArray(account?.availableDomains) ? account.availableDomains : []) {
      remember(entry, String(entry?.state || '').toUpperCase() === 'ACTIVE' ? 'active' : 'hidden');
    }
  }

  const failures = [];
  for (const [key, rawFailure] of Object.entries(raw.domainFailures || {})) {
    const domain = normalizeDomain(rawFailure?.domain || key);
    if (!validDomain(domain)) continue;
    const count = Math.max(0, Math.trunc(Number(rawFailure?.consecutiveOtpTimeoutTasks) || 0));
    const blacklisted = Boolean(rawFailure?.blacklisted || count >= 2);
    if (blacklisted && count < 2) {
      const error = new Error(`legacy blacklist lacks two OTP timeout tasks: ${domain}`);
      error.code = 'LEGACY_MAIL_COM_BLACKLIST_EVIDENCE_INVALID';
      throw error;
    }
    if (!count && !blacklisted) continue;
    if (!catalog.has(domain)) catalog.set(domain, { domain, state: 'hidden' });
    failures.push({
      domain,
      consecutiveOtpTimeoutTasks: count,
      blacklisted,
      lastFailureKind: rawFailure?.lastFailureKind === 'otp_timeout' ? 'otp_timeout' : null,
      lastError: String(rawFailure?.lastError || '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null,
      updatedAt: rawFailure?.updatedAt || null,
    });
  }
  const domains = [...catalog.values()].sort((left, right) => left.domain.localeCompare(right.domain));
  failures.sort((left, right) => left.domain.localeCompare(right.domain));
  return { domains, failures };
}

async function restoreLegacyMailComDomains({ pool, settingsFile, apply = false }) {
  const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const projected = legacyMailComDomainProjection(raw);
  const summary = {
    sourceFile: path.resolve(settingsFile),
    domains: projected.domains.length,
    active: projected.domains.filter((entry) => entry.state === 'active').length,
    hidden: projected.domains.filter((entry) => entry.state === 'hidden').length,
    failureEvidence: projected.failures.length,
    blacklisted: projected.failures.filter((entry) => entry.blacklisted).length,
    source: 'legacy_json_only',
    postCutoverJobsRead: false,
    applied: false,
  };
  if (!apply) return summary;

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('signlist:legacy-mail-com-domain-restore'))");
    await client.query(`
      insert into mail_com_domains(domain, state, last_synced_at, updated_at)
      select source.domain, source.state, now(), now()
      from jsonb_to_recordset($1::jsonb) as source(domain text, state text)
      on conflict (domain) do update set
        state = excluded.state,
        updated_at = now()
    `, [JSON.stringify(projected.domains)]);
    if (projected.failures.length) {
      await client.query(`
        insert into mail_com_domain_failures(
          domain, consecutive_otp_timeout_tasks, blacklisted,
          last_counted_job_id, last_failure_kind, last_error, updated_at
        )
        select source.domain, source.consecutive_otp_timeout_tasks, source.blacklisted,
               null, source.last_failure_kind, source.last_error,
               coalesce(source.updated_at, now())
        from jsonb_to_recordset($1::jsonb) as source(
          domain text,
          consecutive_otp_timeout_tasks integer,
          blacklisted boolean,
          last_failure_kind text,
          last_error text,
          updated_at timestamptz
        )
        on conflict (domain) do update set
          consecutive_otp_timeout_tasks = excluded.consecutive_otp_timeout_tasks,
          blacklisted = excluded.blacklisted,
          last_counted_job_id = null,
          last_failure_kind = excluded.last_failure_kind,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `, [JSON.stringify(projected.failures.map((entry) => ({
        domain: entry.domain,
        consecutive_otp_timeout_tasks: entry.consecutiveOtpTimeoutTasks,
        blacklisted: entry.blacklisted,
        last_failure_kind: entry.lastFailureKind,
        last_error: entry.lastError,
        updated_at: entry.updatedAt,
      })))]);
    }
    await client.query('commit');
    return { ...summary, applied: true };
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
    process.stdout.write(`${JSON.stringify(await restoreLegacyMailComDomains({
      pool,
      settingsFile: args.settingsFile,
      apply: args.apply,
    }), null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: error.code || 'LEGACY_MAIL_COM_DOMAIN_RESTORE_FAILED',
      message: error.message,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { legacyMailComDomainProjection, parseArgs, restoreLegacyMailComDomains };
