'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { compose } = require('node:stream');

const { redactEventValue } = require('./registration-store');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting_for_otp', 'waiting_mail', 'retry_waiting']);
const CANDIDATE_SOURCES = new Set(['mail_com_split', 'manual', 'share_page', 'icloud_sheex', 'ic']);
const REQUIRED_TABLES = [
  'account_auth',
  'account_credentials',
  'accounts',
  'email_aliases',
  'legacy_import_runs',
  'mailbox_domains',
  'mailboxes',
  'refining_batches',
  'registration_candidates',
  'registration_events',
  'registration_job_inputs',
  'registration_jobs',
];
const SECRET_ACCOUNT_KEYS = new Set([
  'password',
  'session',
  'oauthSession',
  'tokens',
  'totpSecret',
  'totpActiveFactorId',
  'sessionContext',
]);

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function encodePostgresJsonNul(value, counter) {
  if (typeof value === 'string') {
    const matches = value.match(/\0/gu);
    if (matches) counter.count += matches.length;
    return matches ? value.replace(/\0/gu, '\\u0000') : value;
  }
  if (Array.isArray(value)) return value.map((item) => encodePostgresJsonNul(item, counter));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const encodedKey = encodePostgresJsonNul(key, counter);
    return [encodedKey, encodePostgresJsonNul(child, counter)];
  }));
}

function validDate(value, fallback = null) {
  const text = normalizeText(value);
  if (!text || !Number.isFinite(Date.parse(text))) return fallback;
  return new Date(text).toISOString();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return EMAIL_RE.test(email) ? email : '';
}

function publicAccountSnapshot(account) {
  return Object.fromEntries(Object.entries(objectValue(account)).filter(([key]) => !SECRET_ACCOUNT_KEYS.has(key)));
}

function passwordStatus(account) {
  const explicit = normalizeText(account.passwordStatus).toLowerCase();
  if (explicit === 'has_password' || explicit === 'no_password') return explicit;
  return normalizeText(account.password) ? 'has_password' : 'unknown';
}

function totpStatus(account) {
  if (account.hasTotp === true || normalizeText(account.totpSecret) || normalizeText(account.totpActiveFactorId)) return 'enabled';
  if (account.totpSetupError) return 'failed';
  if (account.hasTotp === false) return 'missing';
  return 'unknown';
}

function eligibilityStatus(account) {
  const status = normalizeText(account.trialEligibility?.status || account.eligibilityStatus).toLowerCase();
  return ['unknown', 'checking', 'eligible', 'not_eligible', 'failed'].includes(status) ? status : 'unknown';
}

function paymentMethodStatus(account) {
  const probe = normalizeText(account.paymentCapabilities?.status).toLowerCase();
  if (['queued', 'checking', 'failed'].includes(probe)) return probe;
  if (probe === 'done') return arrayValue(account.paymentCapabilities?.methods).length ? 'available' : 'unavailable';
  const explicit = normalizeText(account.paymentMethodStatus).toLowerCase();
  return ['queued', 'checking', 'available', 'unavailable', 'failed'].includes(explicit) ? explicit : 'unknown';
}

function planStatus(account) {
  const values = [account.accountPlanStatus, account.accountPlan?.status, account.accountPlan?.rawPlan]
    .map((value) => normalizeText(value).toLowerCase());
  if (values.includes('plus')) return 'plus';
  if (values.includes('free')) return 'free';
  if (values.includes('expired')) return 'expired';
  return 'unknown';
}

function lifecycleStage(account) {
  const explicit = normalizeText(account.lifecycleStage).toLowerCase();
  const allowed = ['created', 'registering', 'registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'plus', 'sold', 'abandoned'];
  if (allowed.includes(explicit)) return explicit;
  const status = normalizeText(account.status).toLowerCase();
  if (status === 'registered') return 'registered';
  if (status === 'registration_in_progress') return 'registering';
  if (status === 'plus') return 'plus';
  if (status === 'sold') return 'sold';
  return 'created';
}

function authCookies(account) {
  if (arrayValue(account.oauthSession?.cookies).length) return account.oauthSession.cookies;
  return arrayValue(account.session?.cookies);
}

function cookieStatus(account) {
  if (account.oauthSessionExpired === true) return 'expired';
  if (account.oauthSessionAvailable === true || account.sessionAvailable === true || authCookies(account).length) return 'available';
  const explicit = normalizeText(account.oauthSession?.validationStatus).toLowerCase();
  if (['invalid', 'expired'].includes(explicit)) return explicit;
  return 'missing';
}

function refreshTokenStatus(account) {
  const explicit = normalizeText(account.refreshTokenStatus).toLowerCase();
  if (explicit === 'reused') return 'reused';
  if (['invalid', 'invalidated', 'rejected'].includes(explicit)) return 'invalid';
  return normalizeText(account.tokens?.refreshToken) ? 'stored' : 'missing';
}

function taskStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (status === 'succeeded' || status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'blocked' || status === 'failed') return status;
  if (ACTIVE_TASK_STATUSES.has(status)) return 'failed';
  throw migrationError('LEGACY_TASK_STATUS_INVALID', `unsupported legacy task status: ${status || '(empty)'}`);
}

function taskMailboxSource(task, ownership) {
  const original = normalizeText(task.mailboxSource).toLowerCase() || 'manual';
  if (original === 'mail_com_split') return 'mail_com_split';
  if (['cloudflare_temp_email', 'icloud_sheex', 'share_page', 'manual', 'domain', 'ic'].includes(original)) return original;
  return 'manual';
}

function accountSource(source, ownership) {
  const value = normalizeText(source).toLowerCase();
  if (value === 'mail_com_split') return 'mail_com_split';
  if (value === 'cloudflare_temp_email' || value === 'domain') return 'domain';
  if (value === 'icloud_sheex' || value === 'share_page' || value === 'ic') return 'ic';
  return 'manual';
}

function legacyCandidateProjection(raw = {}) {
  const email = validEmail(raw.email);
  if (!email) throw migrationError('LEGACY_CANDIDATE_EMAIL_INVALID', `invalid candidate email: ${raw.email || '(empty)'}`);
  const mailboxUrl = normalizeText(raw.mailboxUrl) || null;
  const originalSource = normalizeText(raw.mailboxSource).toLowerCase();
  const mailboxSource = CANDIDATE_SOURCES.has(originalSource)
    ? originalSource
    : (mailboxUrl ? 'share_page' : 'manual');
  return {
    email,
    mailboxSource,
    mailboxUrl,
    status: normalizeText(raw.status).toLowerCase() === 'ready' ? 'ready' : 'started',
    mailComStage: normalizeText(raw.mailComStage).toLowerCase() || null,
    mailComReleaseStatus: normalizeText(raw.mailComReleaseStatus).toLowerCase() || null,
    mailComReleaseError: normalizeText(raw.mailComReleaseError).slice(0, 4000) || null,
    gcashSold: Boolean(raw.gcashSold),
    createdAt: validDate(raw.createdAt, new Date(0).toISOString()),
    updatedAt: validDate(raw.updatedAt, validDate(raw.createdAt, new Date(0).toISOString())),
  };
}

function taskError(task, events) {
  const candidates = [task.error, ...events.slice().reverse().map((event) => event?.error)];
  const error = candidates.find((item) => item && (item.message || item.code));
  return {
    code: normalizeText(error?.code) || null,
    message: normalizeText(error?.message || error).slice(0, 4000) || null,
  };
}

function normalizedTask(task, ownership = null) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw migrationError('LEGACY_TASK_INVALID', 'legacy task must be an object');
  }
  const id = normalizeText(task.id).toLowerCase();
  const email = validEmail(task.email);
  const registrationPassword = normalizeText(task.password);
  if (!UUID_RE.test(id)) throw migrationError('LEGACY_TASK_ID_INVALID', `invalid legacy task id: ${id || '(empty)'}`);
  if (!email) throw migrationError('LEGACY_TASK_EMAIL_INVALID', `invalid legacy task email for ${id}`);
  if (!registrationPassword) throw migrationError('LEGACY_TASK_PASSWORD_MISSING', `legacy task has no registration password: ${id}`);
  const rawEvents = arrayValue(task.events);
  const seenSequences = new Set();
  const events = rawEvents.map((event, index) => {
    const sequence = Number.isInteger(Number(event?.sequence)) && Number(event.sequence) > 0
      ? Number(event.sequence)
      : index + 1;
    if (seenSequences.has(sequence)) {
      throw migrationError('LEGACY_EVENT_SEQUENCE_DUPLICATE', `duplicate event sequence ${sequence} for ${id}`);
    }
    seenSequences.add(sequence);
    return { ...objectValue(event), sequence };
  });
  const status = taskStatus(task.status);
  if (ACTIVE_TASK_STATUSES.has(normalizeText(task.status).toLowerCase())) {
    const sequence = events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
    events.push({
      sequence,
      at: validDate(task.updatedAt, validDate(task.createdAt, new Date(0).toISOString())),
      type: 'registration.interrupted',
      status: 'failed',
      step: 'interrupted_by_database_cutover',
      error: {
        code: 'LEGACY_TASK_INTERRUPTED_BY_DATABASE_CUTOVER',
        message: 'Legacy task was active when the PostgreSQL-only runtime replaced the JSON runtime.',
      },
    });
  }
  const error = taskError(task, events);
  const createdAt = validDate(task.createdAt, validDate(events[0]?.at, new Date(0).toISOString()));
  const updatedAt = validDate(task.updatedAt, validDate(events.at(-1)?.at, createdAt));
  return {
    id,
    email,
    status,
    step: normalizeText(status === 'failed' && ACTIVE_TASK_STATUSES.has(normalizeText(task.status).toLowerCase())
      ? 'interrupted_by_database_cutover'
      : task.currentStep) || (status === 'completed' ? 'completed' : status),
    branch: normalizeText(task.entryBranch).toLowerCase() || 'freepp',
    mailboxSource: taskMailboxSource(task, ownership),
    originalMailboxSource: normalizeText(task.mailboxSource).toLowerCase() || 'manual',
    mailboxId: ownership?.mailbox_id || null,
    aliasId: ownership?.id || null,
    password: registrationPassword,
    mailboxUrl: normalizeText(task.mailboxUrl) || null,
    proxyPoolId: normalizeText(task.proxyPoolId || task.proxyPools?.main || task.proxyPools?.mailbox) || null,
    browserEngine: normalizeText(task.browserEngine).toLowerCase() || null,
    options: {
      migratedFrom: 'tasks/tasks.json',
      originalMailboxSource: normalizeText(task.mailboxSource).toLowerCase() || 'manual',
      legacyProxyPools: redactEventValue(objectValue(task.proxyPools)),
    },
    events,
    error,
    createdAt,
    updatedAt,
    startedAt: validDate(task.startedAt, status === 'completed' || status === 'failed' ? createdAt : null),
    completedAt: ['completed', 'failed', 'cancelled', 'blocked'].includes(status) ? updatedAt : null,
    attemptCount: Math.max(0, Math.trunc(Number(task.attemptCount || task.attempt || 0))),
  };
}

async function* streamJsonArray(file) {
  if (!fs.existsSync(file)) throw migrationError('LEGACY_SOURCE_MISSING', `legacy source file is missing: ${file}`);
  const { streamArray } = await import('stream-json/streamers/stream-array.js');
  const input = compose(fs.createReadStream(file), streamArray.withParserAsStream());
  try {
    for await (const item of input) yield item.value;
  } finally {
    input.destroy();
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw migrationError('LEGACY_JSON_INVALID', `invalid JSON in ${file}: ${error.message}`, { file });
  }
}

async function sha256File(file) {
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sourcePaths(dataDir) {
  return {
    tasks: path.join(dataDir, 'tasks', 'tasks.json'),
    candidates: path.join(dataDir, 'tasks', 'emails.json'),
    accounts: path.join(dataDir, 'accounts', 'accounts.json'),
    mailboxes: path.join(dataDir, 'settings', 'mail-com-split.json'),
    refining: path.join(dataDir, 'refining', 'runtime.json'),
  };
}

async function sourceFingerprint(files) {
  const hashes = {};
  for (const [name, file] of Object.entries(files)) hashes[name] = await sha256File(file);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  return { fingerprint, hashes };
}

function summaryTemplate() {
  return {
    mailboxes: { inserted: 0, preserved: 0 },
    aliases: { inserted: 0, preserved: 0 },
    accounts: { inserted: 0, updated: 0, preservedNewer: 0 },
    jobs: { inserted: 0, updated: 0, preservedNewer: 0 },
    events: { inserted: 0, preserved: 0 },
    databaseEvents: { inserted: 0, preserved: 0 },
    candidates: { inserted: 0, preserved: 0, skipped: 0 },
    refiningBatches: { inserted: 0, updated: 0, preservedNewer: 0 },
    ownership: { mailComProven: 0, mailComDowngradedToManual: 0 },
    domains: { sharedRequireSessionResync: 0, notAssignedGlobally: true },
    activeTasksInterrupted: 0,
    encodedNulCharacters: 0,
    finalizedRegisteredAccounts: 0,
    linkedLatestRegistrationJobs: 0,
    advancedEventPointers: 0,
  };
}

function accountProjection(account, { ownership = null, sourceHint = '' } = {}) {
  const email = validEmail(account.email);
  if (!email) throw migrationError('LEGACY_ACCOUNT_EMAIL_INVALID', `invalid legacy account email: ${account.email || '(empty)'}`);
  const tokens = objectValue(account.tokens);
  const oauthSession = objectValue(account.oauthSession || account.session);
  return {
    email,
    loginEmail: validEmail(account.loginEmail) || null,
    passwordStatus: passwordStatus(account),
    totpStatus: totpStatus(account),
    eligibilityStatus: eligibilityStatus(account),
    paymentMethodStatus: paymentMethodStatus(account),
    lifecycleStage: lifecycleStage(account),
    planStatus: planStatus(account),
    source: accountSource(account.source || sourceHint, ownership),
    snapshot: publicAccountSnapshot(account),
    password: normalizeText(account.password) || null,
    totpSecret: normalizeText(account.totpSecret) || null,
    totpActiveFactorId: normalizeText(account.totpActiveFactorId) || null,
    accessToken: normalizeText(tokens.accessToken) || null,
    refreshToken: normalizeText(tokens.refreshToken) || null,
    refreshTokenStatus: refreshTokenStatus(account),
    cookies: authCookies(account),
    cookieStatus: cookieStatus(account),
    tokens,
    oauthSession,
    sessionContext: objectValue(account.sessionContext),
    lastRefreshAt: validDate(account.accessTokenLastRefreshedAt || tokens.refreshedAt),
    createdAt: validDate(account.createdAt, new Date(0).toISOString()),
    updatedAt: validDate(account.updatedAt, validDate(account.createdAt, new Date(0).toISOString())),
  };
}

class LegacyJsonMigrator {
  constructor({ pool, dataDir, eventBatchSize = 500 }) {
    if (!pool) throw migrationError('LEGACY_MIGRATION_POOL_REQUIRED', 'PostgreSQL pool is required');
    this.pool = pool;
    this.dataDir = path.resolve(dataDir);
    this.eventBatchSize = Math.max(50, Math.min(2000, Number(eventBatchSize) || 500));
    this.files = sourcePaths(this.dataDir);
    this.summary = summaryTemplate();
    this.accounts = new Map();
    this.aliases = new Map();
    this.latestJobs = new Map();
    this.taskDerivedAccountIds = new Set();
  }

  async run({ apply = false, sourceQuiesced = false } = {}) {
    if (apply && !sourceQuiesced) {
      throw migrationError('LEGACY_SOURCE_NOT_QUIESCED', '--apply requires explicit confirmation that the JSON-writing service is stopped');
    }
    const source = await sourceFingerprint(this.files);
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level serializable');
      await client.query("select pg_advisory_xact_lock(hashtext('signlist.legacy-json-migration'))");
      await this.#checkSchema(client);
      const existingRun = await client.query('select summary from legacy_import_runs where source_fingerprint = $1', [source.fingerprint]);
      if (existingRun.rowCount) {
        await client.query('rollback');
        return { applied: false, alreadyApplied: true, source, summary: existingRun.rows[0].summary };
      }
      await this.#loadCurrentState(client);
      await this.#importMailboxes(client);
      await this.#importAccounts(client);
      await this.#importTasks(client);
      await this.#importDatabaseRegistrationEvents(client);
      await this.#finalizeTaskAccounts(client);
      await this.#importCandidates(client);
      await this.#importRefining(client);
      await this.#assertIntegrity(client);
      await client.query(`
        insert into legacy_import_runs(source_fingerprint, source_files, summary)
        values ($1, $2::jsonb, $3::jsonb)
      `, [source.fingerprint, JSON.stringify(source.hashes), JSON.stringify(this.summary)]);
      if (apply) await client.query('commit');
      else await client.query('rollback');
      return { applied: apply, alreadyApplied: false, source, summary: this.summary };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  #json(value) {
    return JSON.stringify(this.#encode(value));
  }

  #encode(value) {
    const counter = { count: 0 };
    const encoded = encodePostgresJsonNul(value, counter);
    this.summary.encodedNulCharacters += counter.count;
    return encoded;
  }

  async #checkSchema(client) {
    const result = await client.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])
    `, [REQUIRED_TABLES]);
    const found = new Set(result.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !found.has(name));
    if (missing.length) throw migrationError('LEGACY_MIGRATION_SCHEMA_MISSING', `required migrations are not applied: ${missing.join(', ')}`, { missing });
  }

  async #loadCurrentState(client) {
    const [accounts, aliases] = await Promise.all([
      client.query('select id, email, lifecycle_stage, updated_at from accounts'),
      client.query('select id, mailbox_id, account_id, email, status from email_aliases where mailbox_id is not null'),
    ]);
    for (const row of accounts.rows) this.accounts.set(row.email, row);
    for (const row of aliases.rows) this.aliases.set(row.email, row);
  }

  async #importMailboxes(client) {
    const config = objectValue(this.#encode(readJson(this.files.mailboxes, {})));
    const mailboxes = arrayValue(config.accounts);
    this.summary.domains.sharedRequireSessionResync = arrayValue(config.sharedAvailableDomains).length;
    for (const mailbox of mailboxes) {
      const id = normalizeText(mailbox.id).toLowerCase();
      const email = validEmail(mailbox.email);
      if (!UUID_RE.test(id) || !email || !normalizeText(mailbox.password)) {
        throw migrationError('LEGACY_MAILBOX_INVALID', 'legacy mailbox requires a UUID, valid email, and password', { id, email });
      }
      const result = await client.query(`
        insert into mailboxes(id, provider, email, password, session_status, auto_alias_enabled, created_at, updated_at)
        values ($1, 'mail_com', $2, $3, 'closed', $4, $5, $6)
        on conflict (provider, email) do nothing
        returning id
      `, [id, email, normalizeText(mailbox.password), mailbox.autoAliasEnabled === true,
        validDate(mailbox.createdAt, new Date(0).toISOString()),
        validDate(mailbox.updatedAt, validDate(mailbox.createdAt, new Date(0).toISOString()))]);
      this.summary.mailboxes[result.rowCount ? 'inserted' : 'preserved'] += 1;
      const stored = result.rows[0] || (await client.query(
        "select id from mailboxes where provider = 'mail_com' and email = $1",
        [email],
      )).rows[0];
      if (!stored) throw migrationError('LEGACY_MAILBOX_CONFLICT', `mailbox identity conflict: ${email}`);
      for (const rawAlias of arrayValue(mailbox.aliases)) {
        const aliasEmail = validEmail(typeof rawAlias === 'string' ? rawAlias : rawAlias?.email);
        if (!aliasEmail || aliasEmail === email) throw migrationError('LEGACY_ALIAS_INVALID', `invalid alias on mailbox ${email}`);
        const inserted = await client.query(`
          insert into email_aliases(mailbox_id, email, status)
          values ($1, $2, 'unused')
          on conflict (email) do nothing
          returning id, mailbox_id, account_id, email, status
        `, [stored.id, aliasEmail]);
        let alias = inserted.rows[0];
        if (!alias) {
          alias = (await client.query('select id, mailbox_id, account_id, email, status from email_aliases where email = $1', [aliasEmail])).rows[0];
          if (alias?.mailbox_id !== stored.id) {
            throw migrationError('LEGACY_ALIAS_OWNERSHIP_CONFLICT', `alias belongs to a different mailbox: ${aliasEmail}`);
          }
        }
        this.aliases.set(aliasEmail, alias);
        this.summary.aliases[inserted.rowCount ? 'inserted' : 'preserved'] += 1;
      }
    }
  }

  async #importAccounts(client) {
    const accounts = readJson(this.files.accounts, []);
    if (!Array.isArray(accounts)) throw migrationError('LEGACY_ACCOUNTS_INVALID', 'accounts/accounts.json must contain an array');
    for (const sourceAccount of accounts) {
      const raw = this.#encode(sourceAccount);
      const email = validEmail(raw?.email);
      const ownership = this.aliases.get(email) || null;
      const account = accountProjection(raw, { ownership, sourceHint: ownership ? 'mail_com_split' : '' });
      await this.#upsertAccount(client, account);
    }
  }

  async #upsertAccount(client, account) {
    const existing = this.accounts.get(account.email);
    if (existing && Date.parse(existing.updated_at) >= Date.parse(account.updatedAt)) {
      this.summary.accounts.preservedNewer += 1;
      return existing.id;
    }
    const row = (await client.query(`
      insert into accounts(
        email, login_email, password_status, totp_status, eligibility_status,
        payment_method_status, account_snapshot_json, lifecycle_stage, plan_status,
        source, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
      on conflict (email) do update set
        login_email = excluded.login_email,
        password_status = excluded.password_status,
        totp_status = excluded.totp_status,
        eligibility_status = excluded.eligibility_status,
        payment_method_status = excluded.payment_method_status,
        account_snapshot_json = excluded.account_snapshot_json,
        lifecycle_stage = excluded.lifecycle_stage,
        plan_status = excluded.plan_status,
        source = excluded.source,
        updated_at = excluded.updated_at,
        version = accounts.version + 1
      returning id, email, lifecycle_stage, updated_at
    `, [account.email, account.loginEmail, account.passwordStatus, account.totpStatus,
      account.eligibilityStatus, account.paymentMethodStatus, this.#json(account.snapshot),
      account.lifecycleStage, account.planStatus, account.source, account.createdAt, account.updatedAt])).rows[0];
    await client.query(`
      insert into account_credentials(account_id, password, totp_secret, totp_active_factor_id, password_updated_at, totp_updated_at, created_at, updated_at)
      values (
        $1,$2,$3,$4,
        case when $2::text is null then null else $5::timestamptz end,
        case when $3::text is null then null else $5::timestamptz end,
        $6::timestamptz,$5::timestamptz
      )
      on conflict (account_id) do update set
        password = excluded.password,
        totp_secret = excluded.totp_secret,
        totp_active_factor_id = excluded.totp_active_factor_id,
        password_updated_at = excluded.password_updated_at,
        totp_updated_at = excluded.totp_updated_at,
        updated_at = excluded.updated_at
    `, [row.id, account.password, account.totpSecret, account.totpActiveFactorId, account.updatedAt, account.createdAt]);
    await client.query(`
      insert into account_auth(
        account_id, access_token, refresh_token, refresh_token_status, cookie_json,
        cookie_status, token_json, oauth_session_json, session_context_json,
        last_refresh_at, created_at, updated_at
      ) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)
      on conflict (account_id) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        refresh_token_status = excluded.refresh_token_status,
        cookie_json = excluded.cookie_json,
        cookie_status = excluded.cookie_status,
        token_json = excluded.token_json,
        oauth_session_json = excluded.oauth_session_json,
        session_context_json = excluded.session_context_json,
        last_refresh_at = excluded.last_refresh_at,
        updated_at = excluded.updated_at
    `, [row.id, account.accessToken, account.refreshToken, account.refreshTokenStatus,
      this.#json(account.cookies), account.cookieStatus, this.#json(account.tokens),
      this.#json(account.oauthSession), this.#json(account.sessionContext),
      account.lastRefreshAt, account.createdAt, account.updatedAt]);
    this.summary.accounts[existing ? 'updated' : 'inserted'] += 1;
    this.accounts.set(account.email, row);
    return row.id;
  }

  async #ensureTaskAccount(client, task) {
    const existing = this.accounts.get(task.email);
    if (existing) return existing.id;
    const account = accountProjection({
      email: task.email,
      password: task.password,
      status: task.status === 'completed' ? 'registered' : 'abandoned',
      lifecycleStage: task.status === 'completed' ? 'registered' : 'abandoned',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }, { ownership: task.aliasId ? { id: task.aliasId } : null, sourceHint: task.mailboxSource });
    const accountId = await this.#upsertAccount(client, account);
    this.taskDerivedAccountIds.add(accountId);
    return accountId;
  }

  async #importTasks(client) {
    let eventBatch = [];
    const flushEvents = async () => {
      if (!eventBatch.length) return;
      const columns = { job: [], sequence: [], type: [], status: [], step: [], message: [], payload: [], created: [] };
      for (const row of eventBatch) {
        for (const [key, value] of Object.entries(row)) columns[key].push(value);
      }
      const result = await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json, created_at)
        select * from unnest($1::uuid[],$2::integer[],$3::text[],$4::text[],$5::text[],$6::text[],$7::jsonb[],$8::timestamptz[])
        on conflict (job_id, sequence) do nothing
      `, [columns.job, columns.sequence, columns.type, columns.status, columns.step,
        columns.message, columns.payload, columns.created]);
      this.summary.events.inserted += result.rowCount;
      this.summary.events.preserved += eventBatch.length - result.rowCount;
      eventBatch = [];
    };

    for await (const sourceTask of streamJsonArray(this.files.tasks)) {
      const raw = this.#encode(sourceTask);
      const email = validEmail(raw?.email);
      const ownership = this.aliases.get(email) || null;
      const task = normalizedTask(raw, ownership);
      if (task.originalMailboxSource === 'mail_com_split') {
        this.summary.ownership[ownership ? 'mailComProven' : 'mailComDowngradedToManual'] += 1;
      }
      if (ACTIVE_TASK_STATUSES.has(normalizeText(raw.status).toLowerCase())) this.summary.activeTasksInterrupted += 1;
      const accountId = await this.#ensureTaskAccount(client, task);
      const existing = await client.query('select updated_at from registration_jobs where id = $1', [task.id]);
      let writeJob = !existing.rowCount || Date.parse(existing.rows[0].updated_at) < Date.parse(task.updatedAt);
      const lastEventSequence = task.events.reduce((max, event) => Math.max(max, event.sequence), 0);
      if (writeJob) {
        await client.query(`
          insert into registration_jobs(
            id, account_id, status, step, branch, next_run_at, attempt_count,
            last_event_sequence, error_code, error_message, started_at, completed_at,
            mode, mailbox_source, mailbox_id, alias_id, created_at, updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'register',$13,$14,$15,$16,$17)
          on conflict (id) do update set
            account_id=excluded.account_id,status=excluded.status,step=excluded.step,branch=excluded.branch,
            attempt_count=excluded.attempt_count,last_event_sequence=excluded.last_event_sequence,
            error_code=excluded.error_code,error_message=excluded.error_message,
            started_at=excluded.started_at,completed_at=excluded.completed_at,
            mailbox_source=excluded.mailbox_source,mailbox_id=excluded.mailbox_id,
            alias_id=excluded.alias_id,updated_at=excluded.updated_at
        `, [task.id, accountId, task.status, task.step, task.branch, task.updatedAt,
          task.attemptCount, lastEventSequence,
          task.error.code, task.error.message, task.startedAt, task.completedAt,
          task.mailboxSource, task.mailboxId, task.aliasId, task.createdAt, task.updatedAt]);
        await client.query(`
          insert into registration_job_inputs(job_id, registration_password, mailbox_url, proxy_pool_id, browser_engine, options_json, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
          on conflict (job_id) do update set
            registration_password=excluded.registration_password,mailbox_url=excluded.mailbox_url,
            proxy_pool_id=excluded.proxy_pool_id,browser_engine=excluded.browser_engine,
            options_json=excluded.options_json,updated_at=excluded.updated_at
        `, [task.id, task.password, task.mailboxUrl, task.proxyPoolId, task.browserEngine,
          this.#json(task.options), task.createdAt, task.updatedAt]);
        this.summary.jobs[existing.rowCount ? 'updated' : 'inserted'] += 1;
      } else {
        this.summary.jobs.preservedNewer += 1;
        await client.query(`
          update registration_jobs
          set last_event_sequence = greatest(last_event_sequence, $2)
          where id = $1
        `, [task.id, lastEventSequence]);
        await client.query(`
          insert into registration_job_inputs(job_id, registration_password, mailbox_url, proxy_pool_id, browser_engine, options_json, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
          on conflict (job_id) do nothing
        `, [task.id, task.password, task.mailboxUrl, task.proxyPoolId, task.browserEngine,
          this.#json(task.options), task.createdAt, task.updatedAt]);
      }
      const latest = this.latestJobs.get(task.email);
      if (!latest || Date.parse(latest.updatedAt) < Date.parse(task.updatedAt)) this.latestJobs.set(task.email, task);
      for (const event of task.events) {
        const safe = redactEventValue({
          ...event,
          migration: {
            source: 'tasks/tasks.json',
            originalMailboxSource: task.originalMailboxSource,
            ownershipProven: Boolean(task.aliasId),
          },
        });
        eventBatch.push({
          job: task.id,
          sequence: event.sequence,
          type: normalizeText(event.type) || 'registration.event',
          status: normalizeText(event.status) || null,
          step: normalizeText(event.step) || null,
          message: normalizeText(event.message || event.error?.message).slice(0, 4000) || null,
          payload: this.#json(safe),
          created: validDate(event.at, task.updatedAt),
        });
        if (eventBatch.length >= this.eventBatchSize) await flushEvents();
      }
    }
    await flushEvents();
  }

  async #finalizeTaskAccounts(client) {
    const registered = await client.query(`
      update accounts a
      set lifecycle_stage = 'registered', version = version + 1
      where a.lifecycle_stage in ('created', 'registering', 'abandoned')
        and exists (
          select 1 from registration_jobs job
          where job.account_id = a.id and job.status = 'completed'
        )
    `);
    this.summary.finalizedRegisteredAccounts = registered.rowCount;

    const linked = await client.query(`
      with latest as (
        select distinct on (account_id) account_id, id
        from registration_jobs
        order by account_id, updated_at desc, created_at desc, id desc
      )
      update accounts a
      set last_registration_job_id = latest.id
      from latest
      where a.id = latest.account_id and a.last_registration_job_id is null
    `);
    this.summary.linkedLatestRegistrationJobs = linked.rowCount;

    const taskDerivedIds = [...this.taskDerivedAccountIds];
    if (!taskDerivedIds.length) return;
    await client.query(`
      with latest_completed as (
        select distinct on (job.account_id)
          job.account_id, input.registration_password, job.updated_at
        from registration_jobs job
        join registration_job_inputs input on input.job_id = job.id
        where job.account_id = any($1::uuid[]) and job.status = 'completed'
        order by job.account_id, job.updated_at desc, job.created_at desc, job.id desc
      )
      update account_credentials credential
      set password = latest.registration_password,
          password_updated_at = latest.updated_at,
          updated_at = greatest(credential.updated_at, latest.updated_at)
      from latest_completed latest
      where credential.account_id = latest.account_id
    `, [taskDerivedIds]);
  }

  async #importDatabaseRegistrationEvents(client) {
    const result = await client.query(`
      select event.id, event.job_id, event.type, event.message, event.payload_json, event.created_at
      from events event
      join registration_jobs job on job.id = event.job_id
      where event.job_type = 'registration' and event.job_id is not null
      order by event.job_id, event.id
    `);
    let previousJobId = '';
    let sequence = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const columns = { job: [], sequence: [], type: [], status: [], step: [], message: [], payload: [], created: [] };
      for (const row of batch) {
        for (const [key, value] of Object.entries(row)) columns[key].push(value);
      }
      const inserted = await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json, created_at)
        select * from unnest($1::uuid[],$2::integer[],$3::text[],$4::text[],$5::text[],$6::text[],$7::jsonb[],$8::timestamptz[])
        on conflict (job_id, sequence) do nothing
      `, [columns.job, columns.sequence, columns.type, columns.status, columns.step,
        columns.message, columns.payload, columns.created]);
      this.summary.databaseEvents.inserted += inserted.rowCount;
      this.summary.databaseEvents.preserved += batch.length - inserted.rowCount;
      batch = [];
    };
    for (const row of result.rows) {
      if (row.job_id !== previousJobId) {
        previousJobId = row.job_id;
        sequence = 0;
      }
      sequence += 1;
      const payload = redactEventValue({
        ...objectValue(row.payload_json),
        migration: { source: 'database.events', genericEventId: Number(row.id) },
      });
      batch.push({
        job: row.job_id,
        sequence,
        type: normalizeText(row.type) || 'registration.event',
        status: normalizeText(row.payload_json?.status) || null,
        step: normalizeText(row.payload_json?.step) || null,
        message: normalizeText(row.message).slice(0, 4000) || null,
        payload: this.#json(payload),
        created: validDate(row.created_at, new Date(0).toISOString()),
      });
      if (batch.length >= this.eventBatchSize) await flush();
    }
    await flush();
    const advanced = await client.query(`
      with evidence as (
        select job_id, max(sequence)::integer as last_sequence
        from registration_events
        group by job_id
      )
      update registration_jobs job
      set last_event_sequence = evidence.last_sequence
      from evidence
      where job.id = evidence.job_id and job.last_event_sequence < evidence.last_sequence
    `);
    this.summary.advancedEventPointers = advanced.rowCount;
  }

  async #assertIntegrity(client) {
    const result = await client.query(`
      select job.id, job.last_event_sequence, coalesce(max(event.sequence), 0)::integer as actual_sequence
      from registration_jobs job
      left join registration_events event on event.job_id = job.id
      group by job.id, job.last_event_sequence
      having job.last_event_sequence <> coalesce(max(event.sequence), 0)::integer
      order by job.id
      limit 20
    `);
    if (result.rowCount) {
      throw migrationError(
        'LEGACY_EVENT_SEQUENCE_INTEGRITY_FAILED',
        'registration job event pointers do not match imported evidence',
        { jobs: result.rows },
      );
    }
  }

  async #importCandidates(client) {
    const candidates = readJson(this.files.candidates, []);
    if (!Array.isArray(candidates)) throw migrationError('LEGACY_CANDIDATES_INVALID', 'tasks/emails.json must contain an array');
    for (const sourceCandidate of candidates) {
      const raw = this.#encode(sourceCandidate);
      const candidate = legacyCandidateProjection(raw);
      const job = this.latestJobs.get(candidate.email);
      if (candidate.status !== 'ready' && !job) {
        this.summary.candidates.skipped += 1;
        continue;
      }
      const result = await client.query(`
        insert into registration_candidates(
          email, mailbox_source, mailbox_url, status, registration_job_id,
          mail_com_stage, mail_com_release_status, mail_com_release_error, gcash_sold,
          created_at, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (email) do update set
          mailbox_source=excluded.mailbox_source,
          mailbox_url=excluded.mailbox_url,
          mail_com_stage=excluded.mail_com_stage,
          mail_com_release_status=excluded.mail_com_release_status,
          mail_com_release_error=excluded.mail_com_release_error,
          gcash_sold=excluded.gcash_sold,
          updated_at=greatest(registration_candidates.updated_at, excluded.updated_at)
        returning id
      `, [candidate.email, candidate.mailboxSource, candidate.mailboxUrl, candidate.status,
        candidate.status === 'ready' ? null : job.id,
        candidate.mailComStage, candidate.mailComReleaseStatus, candidate.mailComReleaseError,
        candidate.gcashSold, candidate.createdAt, candidate.updatedAt]);
      this.summary.candidates[result.rowCount ? 'inserted' : 'preserved'] += 1;
    }
  }

  async #importRefining(client) {
    const runtime = objectValue(this.#encode(readJson(this.files.refining, {})));
    for (const batch of arrayValue(runtime.batches)) {
      const id = normalizeText(batch?.id);
      const status = normalizeText(batch?.status);
      if (!id || !status) throw migrationError('LEGACY_REFINING_BATCH_INVALID', 'legacy refining batch requires id and status');
      const updatedAt = validDate(batch.updatedAt, validDate(batch.createdAt, new Date(0).toISOString()));
      const remoteBatchId = normalizeText(batch.remoteBatchId) || null;
      const existing = await client.query(`
        select id, updated_at
        from refining_batches
        where id = $1 or ($2::text is not null and remote_batch_id = $2)
        order by case when id = $1 then 0 else 1 end
        limit 1
      `, [id, remoteBatchId]);
      if (existing.rowCount && Date.parse(existing.rows[0].updated_at) >= Date.parse(updatedAt)) {
        this.summary.refiningBatches.preservedNewer += 1;
        continue;
      }
      const storedId = existing.rows[0]?.id || id;
      await client.query(`
        insert into refining_batches(id, remote_batch_id, status, provider, payload, created_at, updated_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7)
        on conflict (id) do update set
          remote_batch_id=excluded.remote_batch_id,status=excluded.status,provider=excluded.provider,
          payload=excluded.payload,updated_at=excluded.updated_at
      `, [storedId, remoteBatchId, status,
        normalizeText(batch.config?.provider), this.#json(batch),
        validDate(batch.createdAt, new Date(0).toISOString()), updatedAt]);
      this.summary.refiningBatches[existing.rowCount ? 'updated' : 'inserted'] += 1;
    }
    if (runtime.lastError) {
      await client.query(`
        insert into service_runtime_state(key, value, updated_at)
        values ('refining.last_error', $1::jsonb, now())
        on conflict (key) do nothing
      `, [this.#json(redactEventValue(runtime.lastError))]);
    }
  }
}

module.exports = {
  LegacyJsonMigrator,
  accountProjection,
  legacyCandidateProjection,
  normalizedTask,
  publicAccountSnapshot,
  sourceFingerprint,
  sourcePaths,
  streamJsonArray,
};
