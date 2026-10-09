'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { Pool } = require('pg');
const { postgresJson } = require('../src/db/runtime-state-store');

const SETTINGS = Object.freeze([
  ['mailbox.cloudflare_temp_email', [path.join('settings', 'cloudflare-temp-email.json'), 'cloudflare-temp-email.json']],
  ['registration.change_email', path.join('settings', 'registration-change-email.json')],
  ['payment.execution', path.join('settings', 'payment.json')],
  ['payment.method_probe', path.join('settings', 'payment-method-probe.json')],
  ['phone_bind.execution', path.join('settings', 'phone-bind.json')],
  ['refining.execution', [path.join('settings', 'refining.json'), 'refining.json']],
]);
const PROXY_CATEGORIES = Object.freeze(['main', 'eligibility', 'checkout', 'payment']);

function argsOf(argv) {
  const args = { apply: false, dataDir: process.env.SIGNLIST_CLEAN_DATA_DIR || path.resolve('data') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') args.apply = true;
    else if (argv[index] === '--data-dir') args.dataDir = path.resolve(argv[++index] || '');
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value;
}

function readSetting(dataDir, relative) {
  const candidates = Array.isArray(relative) ? relative : [relative];
  for (const candidate of candidates) {
    const file = path.join(dataDir, candidate);
    if (fs.existsSync(file)) return readJson(file);
  }
  return null;
}

function jsonEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function normalizeLegacySetting(key, value) {
  const normalized = structuredClone(value);
  if (key === 'payment.method_probe' || key === 'refining.execution') {
    const single = String(normalized.proxyPoolId || '').trim();
    if (!normalized.entryProxyPoolId && single) normalized.entryProxyPoolId = single;
    if (!normalized.exitProxyPoolId && single) normalized.exitProxyPoolId = single;
    delete normalized.proxyPoolId;
  }
  return normalized;
}

async function insertSetting(client, key, value) {
  const current = await client.query('select value from service_settings where key = $1', [key]);
  if (current.rowCount) {
    if (!jsonEqual(current.rows[0].value, value)) throw new Error(`database setting conflicts with legacy source: ${key}`);
    return false;
  }
  await client.query('insert into service_settings(key, value) values ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  return true;
}

function legacyProxyPools(dataDir, category) {
  const proxyDir = path.join(dataDir, 'proxies');
  const legacyFile = path.join(proxyDir, `${category}.json`);
  const meta = readJson(path.join(proxyDir, `${category}.pools.json`), { pools: [] });
  const pools = Array.isArray(meta?.pools) ? meta.pools.slice() : [];
  const legacy = readJson(legacyFile, []);
  if (Array.isArray(legacy) && legacy.length && !pools.some((pool) => pool.id === 'legacy')) {
    pools.unshift({ id: 'legacy', name: '导入池', createdAt: null });
  }
  return pools.map((pool) => {
    const id = String(pool.id || '').trim();
    const file = id === 'legacy' ? legacyFile : path.join(proxyDir, `${category}.${id}.json`);
    return { ...pool, id, proxies: readJson(file, []) || [] };
  });
}

async function insertProxyPool(client, category, pool) {
  const current = await client.query(
    'select name from proxy_pools where category = $1 and id = $2',
    [category, pool.id],
  );
  if (current.rowCount && current.rows[0].name !== String(pool.name || pool.id)) {
    throw new Error(`database proxy pool conflicts with legacy source: ${category}/${pool.id}`);
  }
  if (!current.rowCount) {
    await client.query(`
      insert into proxy_pools(category, id, name, created_at)
      values ($1, $2, $3, coalesce($4::timestamptz, now()))
    `, [category, pool.id, String(pool.name || pool.id), pool.createdAt || null]);
  }
  const existing = await client.query(
    'select payload from proxies where category = $1 and pool_id = $2 order by position',
    [category, pool.id],
  );
  if (existing.rowCount) {
    if (!jsonEqual(existing.rows.map((row) => row.payload), pool.proxies)) {
      throw new Error(`database proxies conflict with legacy source: ${category}/${pool.id}`);
    }
    return false;
  }
  for (let index = 0; index < pool.proxies.length; index += 1) {
    const proxy = { ...pool.proxies[index] };
    delete proxy.poolId;
    await client.query(`
      insert into proxies(category, pool_id, id, position, payload)
      values ($1, $2, $3, $4, $5::jsonb)
    `, [category, pool.id, String(proxy.id || ''), index + 1, JSON.stringify(proxy)]);
  }
  return true;
}

async function importPhoneBindWorkflows(client) {
  const result = await client.query(`
    select coalesce(nullif(login_email, ''), email) as login_email,
           account_snapshot_json->>'phoneBindStateFile' as state_file
    from accounts
    where nullif(account_snapshot_json->>'phoneBindStateFile', '') is not null
  `);
  let imported = 0;
  for (const row of result.rows) {
    if (!fs.existsSync(row.state_file)) continue;
    const state = readJson(row.state_file, {});
    const stage = String(state.workflow_stage || '').trim()
      || (state.refresh_token ? 'completed' : state.oauth_code && state.oauth_state ? 'rt_pending' : 'otp_required');
    const existing = await client.query('select state_json from phone_bind_workflows where email = $1', [row.login_email]);
    if (existing.rowCount) {
      if (!jsonEqual(existing.rows[0].state_json, state)) throw new Error(`database phone-bind workflow conflicts: ${row.login_email}`);
      continue;
    }
    await client.query(`
      insert into phone_bind_workflows(email, workflow_stage, state_json, cookies_json)
      values ($1, $2, $3::jsonb, $4::jsonb)
    `, [row.login_email, stage, JSON.stringify(state), Array.isArray(state.cookies) ? JSON.stringify(state.cookies) : null]);
    imported += 1;
  }
  return { referenced: result.rowCount, imported };
}

async function importEvidence(pool, dataDir) {
  const root = path.join(dataDir, 'evidence');
  if (!fs.existsSync(root)) return { files: 0, events: 0 };
  let files = 0;
  let events = 0;
  let artifacts = 0;
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await pool.query(`
      insert into evidence_records(task_id, sequence, type, payload_json, created_at)
      select source.task_id, source.sequence, source.type, source.payload,
             coalesce(source.created_at::timestamptz, now())
      from jsonb_to_recordset($1::jsonb)
        as source(task_id text, sequence integer, type text, payload jsonb, created_at text)
      on conflict (task_id, sequence) do nothing
    `, [postgresJson(batch)]);
    batch.length = 0;
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const file = path.join(root, taskId, 'events.ndjson');
    if (!fs.existsSync(file)) continue;
    files += 1;
    const input = fs.createReadStream(file, 'utf8');
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      batch.push({
        task_id: taskId,
        sequence: Number(event.sequence),
        type: String(event.type || 'evidence.event'),
        payload: event.payload || {},
        created_at: event.at || null,
      });
      if (batch.length >= 500) await flush();
      events += 1;
    }
    const artifactDir = path.join(root, taskId, 'artifacts');
    if (fs.existsSync(artifactDir)) {
      for (const artifact of fs.readdirSync(artifactDir, { withFileTypes: true })) {
        if (!artifact.isFile()) continue;
        const artifactFile = path.join(artifactDir, artifact.name);
        const content = fs.readFileSync(artifactFile);
        await pool.query(`
          insert into evidence_artifacts(task_id, name, relative_path, sha256, bytes)
          values ($1, $2, $3, $4, $5)
          on conflict (task_id, name) do nothing
        `, [taskId, artifact.name, path.join('artifacts', artifact.name),
          crypto.createHash('sha256').update(content).digest('hex'), content.length]);
        artifacts += 1;
      }
    }
  }
  await flush();
  return { files, events, artifacts };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const summary = { mode: args.apply ? 'apply' : 'dry-run', dataDir: args.dataDir, settings: 0, proxyPools: 0, proxies: 0 };
  for (const [key, relative] of SETTINGS) {
    const source = readSetting(args.dataDir, relative);
    const value = source && typeof source === 'object' && !Array.isArray(source)
      ? normalizeLegacySetting(key, source)
      : source;
    if (value && typeof value === 'object' && !Array.isArray(value)) summary.settings += 1;
  }
  const pools = [];
  for (const category of PROXY_CATEGORIES) {
    for (const pool of legacyProxyPools(args.dataDir, category)) pools.push({ category, ...pool });
  }
  summary.proxyPools = pools.length;
  summary.proxies = pools.reduce((total, pool) => total + pool.proxies.length, 0);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const pool = new Pool(process.env.SIGNLIST_DATABASE_URL
    ? { connectionString: process.env.SIGNLIST_DATABASE_URL }
    : { database: process.env.SIGNLIST_DATABASE_NAME || 'signlist', user: process.env.SIGNLIST_DATABASE_USER || 'signlistclean', host: process.env.SIGNLIST_DATABASE_HOST || '/var/run/postgresql' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [key, relative] of SETTINGS) {
      const source = readSetting(args.dataDir, relative);
      const value = source && typeof source === 'object' && !Array.isArray(source)
        ? normalizeLegacySetting(key, source)
        : source;
      if (value && typeof value === 'object' && !Array.isArray(value)) await insertSetting(client, key, value);
    }
    for (const proxyPool of pools) await insertProxyPool(client, proxyPool.category, proxyPool);
    summary.phoneBind = await importPhoneBindWorkflows(client);
    await client.query('commit');
    summary.evidence = await importEvidence(pool, args.dataDir);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { argsOf, legacyProxyPools, normalizeLegacySetting };
