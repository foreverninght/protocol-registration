'use strict';

const { Pool } = require('pg');
const { redactEventValue, assertRegistrationLease } = require('./registration-store');

const SECRET_ACCOUNT_KEYS = new Set([
  'password',
  'session',
  'oauthSession',
  'tokens',
  'totpSecret',
  'totpActiveFactorId',
  'totpEnrollmentSessionId',
  'sessionContext',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function jsonValue(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch (error) {
    const wrapped = new Error(`account asset is not JSON serializable: ${error?.message || error}`);
    wrapped.code = 'ACCOUNT_ASSET_SERIALIZATION_FAILED';
    throw wrapped;
  }
}

function assetError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function publicSnapshot(account = {}) {
  return Object.fromEntries(Object.entries(objectValue(account)).filter(([key]) => !SECRET_ACCOUNT_KEYS.has(key)));
}

function passwordStatus(account = {}) {
  const explicit = normalizeText(account.passwordStatus).toLowerCase();
  if (explicit === 'has_password' || explicit === 'no_password') return explicit;
  return normalizeText(account.password) ? 'has_password' : 'unknown';
}

function totpStatus(account = {}) {
  if (account.totpVerified === false) return 'failed';
  if (account.hasTotp === true || normalizeText(account.totpSecret) || normalizeText(account.totpActiveFactorId)) return 'enabled';
  if (account.totpSetupError) return 'failed';
  if (account.hasTotp === false) return 'missing';
  return 'unknown';
}

function eligibilityStatus(account = {}) {
  const status = normalizeText(account.trialEligibility?.status || account.eligibilityStatus).toLowerCase();
  return ['unknown', 'checking', 'eligible', 'not_eligible', 'failed'].includes(status) ? status : 'unknown';
}

function paymentMethodStatus(account = {}) {
  const probe = normalizeText(account.paymentCapabilities?.status).toLowerCase();
  if (probe === 'queued' || probe === 'checking' || probe === 'failed') return probe;
  if (probe === 'done') {
    return Array.isArray(account.paymentCapabilities?.methods) && account.paymentCapabilities.methods.length
      ? 'available'
      : 'unavailable';
  }
  const explicit = normalizeText(account.paymentMethodStatus).toLowerCase();
  if (['queued', 'checking', 'available', 'unavailable', 'failed'].includes(explicit)) return explicit;
  return 'unknown';
}

function planStatus(account = {}) {
  const values = [
    account.accountPlanStatus,
    account.accountPlan?.status,
    account.accountPlan?.rawPlan,
  ].map((value) => normalizeText(value).toLowerCase());
  if (values.includes('plus')) return 'plus';
  if (values.includes('free')) return 'free';
  if (values.includes('expired')) return 'expired';
  return 'unknown';
}

function lifecycleStage(account = {}, currentStage = 'created') {
  const explicit = normalizeText(account.lifecycleStage).toLowerCase();
  if (['created', 'registering', 'registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'sms', 'completed', 'plus', 'sold', 'abandoned'].includes(explicit)) {
    return explicit;
  }
  const status = normalizeText(account.status).toLowerCase();
  if (status === 'registered') return 'registered';
  if (status === 'registration_in_progress') return 'registering';
  if (status === 'plus') return 'plus';
  if (status === 'sold') return 'sold';
  return currentStage || 'created';
}

function authCookies(account = {}) {
  const merged = new Map();
  for (const source of [account.oauthSession?.cookies, account.session?.cookies]) {
    for (const cookie of Array.isArray(source) ? source : []) {
      if (!cookie?.name || !cookie?.value) continue;
      const key = String(cookie.domain || '').replace(/^./u, '').toLowerCase() + '|' + (cookie.path || '/') + '|' + cookie.name;
      merged.set(key, cookie);
    }
  }
  return [...merged.values()];
}

function cookieStatus(account = {}) {
  if (account.oauthSessionExpired === true) return 'expired';
  if (account.oauthSessionAvailable === true || account.sessionAvailable === true || authCookies(account).length) return 'available';
  return 'missing';
}

function refreshTokenStatus(account = {}) {
  const token = normalizeText(account.tokens?.refreshToken);
  const explicit = normalizeText(account.refreshTokenStatus).toLowerCase();
  if (explicit === 'reused') return 'reused';
  if (['invalid', 'invalidated', 'rejected'].includes(explicit)) return 'invalid';
  return token ? 'stored' : 'missing';
}

function accountView(account, { includeSecret = false } = {}) {
  if (!account) return null;
  if (includeSecret) return account;
  const safe = publicSnapshot(account);
  const cookies = authCookies(account);
  return {
    ...safe,
    hasPassword: Boolean(normalizeText(account.password)),
    hasTotp: Boolean(account.hasTotp || normalizeText(account.totpSecret)),
    sessionAvailable: Boolean(account.sessionAvailable || account.session?.cookies?.length),
    oauthSessionAvailable: Boolean(account.oauthSessionAvailable || account.oauthSession?.cookies?.length),
    accessTokenAvailable: Boolean(normalizeText(account.tokens?.accessToken)),
    refreshTokenStored: Boolean(normalizeText(account.tokens?.refreshToken)),
    refreshTokenStatus: refreshTokenStatus(account),
  };
}

class AccountAssetStore {
  constructor({ connectionString = process.env.SIGNLIST_DATABASE_URL || '', pool = null } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || new Pool(connectionString
      ? { connectionString }
      : {
        database: process.env.SIGNLIST_DATABASE_NAME || 'signlist',
        user: process.env.SIGNLIST_DATABASE_USER || 'signlistclean',
        host: process.env.SIGNLIST_DATABASE_HOST || '/var/run/postgresql',
        max: Number(process.env.SIGNLIST_DATABASE_POOL_MAX || 5),
      });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async getByEmail(email, { includeSecret = false, client = this.pool } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const result = await client.query(`${this.#accountSelect()} where a.email = $1`, [normalizedEmail]);
    return accountView(this.#accountFromRow(result.rows[0]), { includeSecret });
  }

  async getByJob(jobId, { includeSecret = false, client = this.pool } = {}) {
    const id = normalizeText(jobId);
    if (!id) return null;
    const result = await client.query(`${this.#accountSelect()}
      join registration_jobs lookup_job on lookup_job.account_id = a.id
      where lookup_job.id = $1`, [id]);
    return accountView(this.#accountFromRow(result.rows[0]), { includeSecret });
  }

  async list({
    source = '',
    paymentStatuses = [],
    mailComStages = [],
    lifecycleStages = [],
    accountIds = [],
    registrationJobIds = [],
    includeSecret = false,
    lightweight = false,
    limit = 500,
    offset = 0,
  } = {}) {
    const normalizedSource = normalizeText(source).toLowerCase();
    const stages = (Array.isArray(lifecycleStages) ? lifecycleStages : [lifecycleStages])
      .map((stage) => normalizeText(stage).toLowerCase())
      .filter(Boolean);
    const payments = (Array.isArray(paymentStatuses) ? paymentStatuses : [paymentStatuses])
      .map((status) => normalizeText(status).toLowerCase())
      .filter(Boolean);
    const mailStages = (Array.isArray(mailComStages) ? mailComStages : [mailComStages])
      .map((stage) => normalizeText(stage).toLowerCase())
      .filter(Boolean);
    const ids = (Array.isArray(accountIds) ? accountIds : [accountIds]).map(normalizeText).filter(Boolean);
    const jobIds = (Array.isArray(registrationJobIds) ? registrationJobIds : [registrationJobIds])
      .map(normalizeText)
      .filter(Boolean);
    const result = await this.pool.query(`${lightweight ? this.#accountSummarySelect() : this.#accountSelect()}
      where ($1::text = '' or a.source = $1)
        and (cardinality($2::text[]) = 0 or a.lifecycle_stage = any($2::text[]))
        and (cardinality($7::text[]) = 0 or lower(coalesce(a.account_snapshot_json->'payment'->>'status', '')) = any($7::text[]))
        and (cardinality($8::text[]) = 0 or lower(coalesce(a.account_snapshot_json->>'mailComStage', '')) = any($8::text[]))
        and (
          (cardinality($3::text[]) = 0 and cardinality($4::text[]) = 0)
          or a.id::text = any($3::text[])
          or exists (
            select 1
            from registration_jobs current_job
            where current_job.account_id = a.id
              and current_job.id::text = any($4::text[])
          )
        )
      order by a.updated_at desc
      limit $5 offset $6`, [
      normalizedSource,
      stages,
      ids,
      jobIds,
      limit === null ? null : Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 500))),
      Math.max(0, Math.trunc(Number(offset) || 0)),
      payments,
      mailStages,
    ]);
    return result.rows.map((row) => accountView(this.#accountFromRow(row), { includeSecret }));
  }

  async saveProgress({ jobId, patch = {}, guard = null } = {}) {
    const id = normalizeText(jobId);
    if (!id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw assetError('ACCOUNT_PROGRESS_INPUT_INVALID', 'account progress requires jobId and an object patch');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await assertRegistrationLease(client, id, guard);
      const context = await this.#lockJobAccount(client, id);
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(context.job_status)) {
        throw assetError('REGISTRATION_JOB_TERMINAL', `registration job is already ${context.job_status}`);
      }
      const current = await this.getByEmail(context.email, { includeSecret: true, client });
      const merged = { ...current, ...patch, email: normalizeEmail(patch.email || current.email) };
      await this.#writeAccount(client, context, merged, { complete: false });
      await client.query('commit');
      return await this.getByEmail(merged.email, { includeSecret: false });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateByEmail({ email, patch = {}, expectedVersion = null, guard = null } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw assetError('ACCOUNT_UPDATE_INPUT_INVALID', 'account update requires email and an object patch');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const guardedJob = await assertRegistrationLease(client, guard?.jobId, guard);
      const locked = await client.query('select id, email, lifecycle_stage, source, version from accounts where email = $1 for update', [normalizedEmail]);
      const row = locked.rows[0];
      if (!row) throw assetError('ACCOUNT_NOT_FOUND', `account not found: ${normalizedEmail}`);
      if (guardedJob && guardedJob.account_id !== row.id) throw assetError('REGISTRATION_WORKER_LEASE_LOST', 'account does not match registration lease');
      if (expectedVersion !== null && Number(row.version) !== Number(expectedVersion)) {
        throw assetError(
          'ACCOUNT_VERSION_CONFLICT',
          `account changed after it was read: ${normalizedEmail}`,
          { expectedVersion: Number(expectedVersion), actualVersion: Number(row.version) },
        );
      }
      const current = await this.getByEmail(normalizedEmail, { includeSecret: true, client });
      const merged = { ...current, ...patch, email: normalizeEmail(patch.email || current.email) };
      await this.#writeAccount(client, {
        account_id: row.id,
        email: row.email,
        lifecycle_stage: row.lifecycle_stage,
        source: row.source,
        job_id: null,
      }, merged, { complete: false });
      await client.query('commit');
      return await this.getByEmail(merged.email, { includeSecret: false });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateManyByEmail(updates = []) {
    if (!Array.isArray(updates) || !updates.length) return [];
    const normalized = updates.map((update) => ({
      email: normalizeEmail(update?.email),
      patch: update?.patch,
      expectedVersion: update?.expectedVersion ?? null,
    }));
    if (normalized.some((update) => !update.email || !update.patch || typeof update.patch !== 'object' || Array.isArray(update.patch))) {
      throw assetError('ACCOUNT_BATCH_UPDATE_INPUT_INVALID', 'account batch update requires email and an object patch');
    }
    if (new Set(normalized.map((update) => update.email)).size !== normalized.length) {
      throw assetError('ACCOUNT_BATCH_UPDATE_DUPLICATE', 'account batch update contains duplicate emails');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const emails = normalized.map((update) => update.email).sort();
      const locked = await client.query(`
        select id, email, lifecycle_stage, source, version
        from accounts
        where email = any($1::text[])
        order by email
        for update
      `, [emails]);
      if (locked.rowCount !== normalized.length) {
        const found = new Set(locked.rows.map((row) => row.email));
        throw assetError('ACCOUNT_NOT_FOUND', 'one or more batch accounts were not found', {
          emails: emails.filter((email) => !found.has(email)),
        });
      }
      const rows = new Map(locked.rows.map((row) => [row.email, row]));
      for (const update of normalized) {
        const row = rows.get(update.email);
        if (update.expectedVersion !== null && Number(row.version) !== Number(update.expectedVersion)) {
          throw assetError('ACCOUNT_VERSION_CONFLICT', `account changed after it was read: ${update.email}`, {
            email: update.email,
            expectedVersion: Number(update.expectedVersion),
            actualVersion: Number(row.version),
          });
        }
        const current = await this.getByEmail(update.email, { includeSecret: true, client });
        const merged = { ...current, ...update.patch, email: normalizeEmail(update.patch.email || current.email) };
        await this.#writeAccount(client, {
          account_id: row.id,
          email: row.email,
          lifecycle_stage: row.lifecycle_stage,
          source: row.source,
          job_id: null,
        }, merged, { complete: false });
      }
      await client.query('commit');
      return Promise.all(normalized.map((update) => this.getByEmail(update.email)));
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRegistration({ jobId, account = {}, event = {}, guard = null } = {}) {
    const id = normalizeText(jobId);
    if (!id || !account || typeof account !== 'object' || Array.isArray(account)) {
      throw assetError('ACCOUNT_COMPLETION_INPUT_INVALID', 'registration completion requires jobId and account');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await assertRegistrationLease(client, id, guard);
      const context = await this.#lockJobAccount(client, id);
      if (!['running', 'waiting_mail'].includes(context.job_status)) {
        throw assetError('REGISTRATION_JOB_NOT_RUNNING', `registration job is ${context.job_status}, not running`);
      }
      const current = await this.getByEmail(context.email, { includeSecret: true, client });
      const merged = {
        ...current,
        ...account,
        email: normalizeEmail(account.email || current.email),
        status: 'registered',
        lifecycleStage: 'registered',
        discardReason: null,
        discardedAt: null,
        retryQueuedAt: null,
        lastTaskId: id,
      };
      await this.#writeAccount(client, context, merged, { complete: true });
      if (context.alias_id) {
        const alias = await client.query(`
          update email_aliases
          set status = 'registered',
              account_id = $2,
              assigned_at = coalesce(assigned_at, now()),
              updated_at = now()
          where id = $1
            and mailbox_id = $3
            and account_id = $2
            and status = 'registering'
          returning id
        `, [context.alias_id, context.account_id, context.mailbox_id]);
        if (alias.rowCount !== 1) {
          throw assetError('REGISTERED_ALIAS_OWNERSHIP_INVALID', 'registered account alias ownership does not match its job');
        }
      }
      const sequence = Number(context.last_event_sequence || 0) + 1;
      const completedEvent = redactEventValue({
        ...event,
        sequence,
        type: 'registration.completed',
        status: 'succeeded',
        step: 'completed',
      });
      await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
        values ($1, $2, 'registration.completed', 'succeeded', 'completed', $3, $4::jsonb)
      `, [id, sequence, `Registered account ${merged.email}`, jsonValue(completedEvent, {})]);
      const completedJob = await client.query(`
        update registration_jobs
        set status = 'completed',
            step = 'completed',
            last_event_sequence = $2,
            error_code = null,
            error_message = null,
            lease_expires_at = null,
            completed_at = now(),
            updated_at = now()
        where id = $1 and status in ('running', 'waiting_mail')
        returning id
      `, [id, sequence]);
      if (completedJob.rowCount !== 1) throw assetError('REGISTRATION_JOB_COMPLETION_CONFLICT', 'registration job changed during completion');
      await client.query('commit');
      return await this.getByEmail(merged.email, { includeSecret: false });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async abandonScratchByEmail(email, { guard = null } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return { abandoned: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const guardedJob = await assertRegistrationLease(client, guard?.jobId, guard);
      if (guardedJob) {
        const owner = await client.query('select id from accounts where email = $1 for update', [normalizedEmail]);
        if (owner.rows[0]?.id !== guardedJob.account_id) throw assetError('REGISTRATION_WORKER_LEASE_LOST', 'account does not match registration lease');
      }
      const result = await client.query(`
        update accounts
        set lifecycle_stage = 'abandoned',
            account_snapshot_json = account_snapshot_json || jsonb_build_object(
              'status', 'abandoned',
              'discardReason', 'registration_failed',
              'discardedAt', now()
            ),
            version = version + 1,
            updated_at = now()
        where email = $1
          and ($2::uuid is null or id = $2)
          and coalesce(account_snapshot_json->>'registrationCreated', 'false') <> 'true'
          and lifecycle_stage in ('created', 'registering', 'abandoned')
        returning id
      `, [normalizedEmail, guardedJob?.account_id || null]);
      const candidate = await client.query(`
        delete from registration_candidates
        where email = $1
          and mailbox_source = 'mail_com_split'
      `, [normalizedEmail]);
      await client.query('commit');
      return { abandoned: Number(result.rowCount || 0), candidateDeleted: Number(candidate.rowCount || 0) };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionWorkflow({ jobId, stage, guard = null } = {}) {
    const id = normalizeText(jobId);
    const normalizedStage = normalizeText(stage).toLowerCase();
    const allowedStages = new Set([
      'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment',
      'paid', 'sms', 'completed', 'sold',
    ]);
    if (!id || !allowedStages.has(normalizedStage)) {
      throw assetError('WORKFLOW_INPUT_INVALID', 'workflow transition requires a terminal registration job and valid stage');
    }
    const job = await this.pool.query(`
      select job.status, account.email
      from registration_jobs job
      join accounts account on account.id = job.account_id
      where job.id = $1
    `, [id]);
    const row = job.rows[0];
    if (!row) throw assetError('WORKFLOW_JOB_INVALID', 'workflow registration job was not found');
    if (!['completed', 'failed', 'cancelled', 'blocked'].includes(row.status)) {
      throw assetError('WORKFLOW_JOB_NOT_TERMINAL', 'workflow transition requires a terminal registration job');
    }
    const updated = await this.updateByEmail({
      email: row.email,
      guard,
      patch: {
        workflowStage: normalizedStage,
        mailComStage: normalizedStage,
        lifecycleStage: normalizedStage,
      },
    });
    return { jobId: id, accountId: updated.id, email: row.email, stage: normalizedStage };
  }

  async transitionMailComWorkflow({
    jobId,
    stage,
    releaseStatus = 'released',
    releaseError = null,
    discard = false,
    discardReason = 'registration_failed',
    guard = null,
  } = {}) {
    const id = normalizeText(jobId);
    const normalizedStage = normalizeText(stage).toLowerCase();
    const normalizedReleaseStatus = normalizeText(releaseStatus).toLowerCase();
    const allowedStages = new Set([
      'unregistered', 'eligibility', 'payment_method', 'refining', 'gcash', 'paid',
      'sms', 'pending_payment', 'completed', 'sold',
    ]);
    if (!id || (!discard && !allowedStages.has(normalizedStage))) {
      throw assetError('MAIL_COM_WORKFLOW_INPUT_INVALID', 'mail.com workflow transition requires jobId and stage');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await assertRegistrationLease(client, id, guard);
      const context = await client.query(`
        select job.id as job_id, job.status as job_status, job.mailbox_source,
               account.id as account_id, account.email, account.lifecycle_stage
        from registration_jobs job
        join accounts account on account.id = job.account_id
        where job.id = $1
        for update of job, account
      `, [id]);
      const row = context.rows[0];
      if (!row || row.mailbox_source !== 'mail_com_split') {
        throw assetError('MAIL_COM_WORKFLOW_JOB_INVALID', 'mail.com workflow job was not found');
      }
      if (!['completed', 'failed', 'cancelled', 'blocked'].includes(row.job_status)) {
        throw assetError('MAIL_COM_WORKFLOW_JOB_NOT_TERMINAL', 'mail.com workflow requires a terminal registration job');
      }
      const workflowLifecycleStages = new Set([
        'eligibility', 'payment_method', 'refining', 'gcash',
        'pending_payment', 'paid', 'completed', 'sold',
      ]);
      const lifecycle = discard ? 'abandoned'
        : workflowLifecycleStages.has(normalizedStage) ? normalizedStage
          : row.lifecycle_stage;
      await client.query(`
        update accounts
        set lifecycle_stage = $2,
            account_snapshot_json = account_snapshot_json
              || jsonb_build_object(
                'status', case when $3 then 'abandoned' else coalesce(account_snapshot_json->>'status', 'registered') end,
                'mailComStage', case when $3 then coalesce(nullif($4, ''), account_snapshot_json->>'mailComStage') else $4 end,
                'mailComReleaseStatus', $5::text,
                'mailComReleaseError', $6::text
              )
              || case when $3 then jsonb_build_object(
                'discardReason', $7::text,
                'discardedAt', now()
              ) else '{}'::jsonb end,
            version = version + 1,
            updated_at = now()
        where id = $1
      `, [
        row.account_id,
        lifecycle,
        Boolean(discard),
        normalizedStage,
        normalizedReleaseStatus || null,
        normalizeText(releaseError?.message || releaseError).slice(0, 1000) || null,
        normalizeText(discardReason).slice(0, 200) || 'registration_failed',
      ]);
      if (discard) {
        await client.query('delete from registration_candidates where registration_job_id = $1', [id]);
      } else {
        const candidate = await client.query(`
          insert into registration_candidates(
            email, mailbox_source, mailbox_url, status, registration_job_id,
            mail_com_stage, mail_com_release_status, mail_com_release_error
          )
          values ($5, 'mail_com_split', null, 'started', $1, $2, $3, $4)
          on conflict (email) do update set
            mailbox_source = 'mail_com_split',
            mailbox_url = null,
            status = 'started',
            registration_job_id = excluded.registration_job_id,
            mail_com_stage = excluded.mail_com_stage,
            mail_com_release_status = excluded.mail_com_release_status,
            mail_com_release_error = excluded.mail_com_release_error,
            updated_at = now()
          where registration_candidates.registration_job_id is null
             or registration_candidates.registration_job_id = excluded.registration_job_id
             or exists (
               select 1
               from registration_jobs previous_job
               where previous_job.id = registration_candidates.registration_job_id
                 and previous_job.status in ('completed', 'failed', 'cancelled', 'blocked')
             )
          returning id
        `, [
          id,
          normalizedStage,
          normalizedReleaseStatus || null,
          normalizeText(releaseError?.message || releaseError).slice(0, 1000) || null,
          row.email,
        ]);
        if (candidate.rowCount !== 1) {
          throw assetError(
            'MAIL_COM_WORKFLOW_CANDIDATE_CONFLICT',
            'mail.com workflow candidate belongs to another active registration job',
          );
        }
      }
      await client.query('commit');
      return {
        jobId: id,
        accountId: row.account_id,
        email: row.email,
        stage: discard ? null : normalizedStage,
        releaseStatus: normalizedReleaseStatus || null,
        discarded: Boolean(discard),
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupInvalidMailComWorkflowRows({
    requirePassword = false,
    requireTotp = false,
  } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(`
        with selected as (
          select distinct
            c.email,
            a.id as account_id,
            case
              when coalesce(a.eligibility_status, '') = 'not_eligible'
                then null
              when job.status in ('failed', 'cancelled', 'blocked')
                and coalesce(a.lifecycle_stage, '') not in ('registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'plus', 'sold')
                then 'registration_failed'
              when job.status not in ('completed', 'failed', 'cancelled', 'blocked')
              then null
              when a.source = 'mail_com_split'
                and (
                  ($1::boolean and coalesce(a.password_status, 'unknown') <> 'has_password')
                  or ($2::boolean and coalesce(a.totp_status, 'unknown') <> 'enabled')
                )
                then 'required_registration_asset_missing'
              else null
            end as reason
          from registration_candidates c
          left join accounts a on a.email = c.email
          left join registration_jobs job on job.id = c.registration_job_id
          where c.mailbox_source = 'mail_com_split'
        ),
        invalid as (
          select email, account_id, reason
          from selected
          where reason is not null
        ),
        updated_accounts as (
          update accounts account
          set lifecycle_stage = 'abandoned',
              account_snapshot_json = account_snapshot_json || jsonb_build_object(
                'status', 'abandoned',
                'discardReason', invalid.reason,
                'discardedAt', now()
              ),
              version = version + 1,
              updated_at = now()
          from invalid
          where account.id = invalid.account_id
            and account.lifecycle_stage <> 'abandoned'
          returning account.email
        ),
        deleted_candidates as (
          delete from registration_candidates candidate
          using invalid
          where candidate.email = invalid.email
            and candidate.mailbox_source = 'mail_com_split'
          returning candidate.email
        )
        select
          (select count(*) from invalid)::int as invalid_count,
          (select count(*) from updated_accounts)::int as archived_accounts,
          (select count(*) from deleted_candidates)::int as deleted_candidates,
          coalesce((select jsonb_agg(email order by email) from deleted_candidates), '[]'::jsonb) as emails
      `, [Boolean(requirePassword), Boolean(requireTotp)]);
      await client.query('commit');
      const row = result.rows[0] || {};
      return {
        invalidCount: Number(row.invalid_count || 0),
        archivedAccounts: Number(row.archived_accounts || 0),
        deletedCandidates: Number(row.deleted_candidates || 0),
        emails: Array.isArray(row.emails) ? row.emails : [],
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async clearRegistrationScratch({ source = '' } = {}) {
    const normalizedSource = normalizeText(source).toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const scratch = await client.query(`
        select account.id, account.email
        from accounts account
        where account.lifecycle_stage in ('created', 'registering', 'abandoned')
          and coalesce(account.eligibility_status, '') <> 'not_eligible'
          and ($1::text = '' or account.source = $1)
          and not exists (
            select 1 from registration_jobs job
            where job.account_id = account.id
              and job.status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting')
          )
          and not exists (
            select 1 from registration_jobs job
            where job.account_id = account.id and job.status = 'completed'
          )
          and not exists (
            select 1 from email_aliases alias
            where alias.account_id = account.id and alias.status <> 'abandoned'
          )
        order by account.id
        for update of account
      `, [normalizedSource]);
      const accountIds = scratch.rows.map((row) => row.id);
      if (!accountIds.length) {
        await client.query('commit');
        return { source: normalizedSource || 'all', deletedScratchAccounts: 0, deletedScratchAliases: 0, deletedRegistrationJobs: 0 };
      }
      const jobs = await client.query('select id from registration_jobs where account_id = any($1::uuid[])', [accountIds]);
      const jobIds = jobs.rows.map((row) => row.id);
      if (jobIds.length) {
        await client.query('delete from registration_candidates where registration_job_id = any($1::uuid[])', [jobIds]);
      }
      const aliases = await client.query(`
        delete from email_aliases
        where account_id = any($1::uuid[]) and status = 'abandoned'
      `, [accountIds]);
      const deleted = await client.query('delete from accounts where id = any($1::uuid[])', [accountIds]);
      await client.query('commit');
      return {
        source: normalizedSource || 'all',
        deletedScratchAccounts: Number(deleted.rowCount || 0),
        deletedScratchAliases: Number(aliases.rowCount || 0),
        deletedRegistrationJobs: jobIds.length,
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async discardUsableAccountByEmail(email, { reason = 'business_workflow_failed' } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return { discarded: false };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const account = await client.query(`
        select id from accounts where email = $1 for update
      `, [normalizedEmail]);
      if (!account.rows[0]) {
        await client.query('commit');
        return { discarded: false };
      }
      await client.query(`
        update accounts
        set lifecycle_stage = 'abandoned',
            account_snapshot_json = account_snapshot_json || jsonb_build_object(
              'status', 'abandoned',
              'discardReason', $2::text,
              'discardedAt', now()
            ),
            version = version + 1,
            updated_at = now()
        where id = $1
      `, [account.rows[0].id, normalizeText(reason).slice(0, 200)]);
      const candidate = await client.query('delete from registration_candidates where email = $1', [normalizedEmail]);
      await client.query('commit');
      return { discarded: true, candidateDeleted: candidate.rowCount === 1, email: normalizedEmail };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockJobAccount(client, jobId) {
    const result = await client.query(`
      select
        r.id as job_id,
        r.status as job_status,
        r.last_event_sequence,
        r.alias_id,
        r.mailbox_id,
        a.id as account_id,
        a.email,
        a.lifecycle_stage,
        a.source
      from registration_jobs r
      join accounts a on a.id = r.account_id
      where r.id = $1
      for update of r, a
    `, [jobId]);
    if (!result.rows[0]) throw assetError('REGISTRATION_JOB_NOT_FOUND', `registration job not found: ${jobId}`);
    return result.rows[0];
  }

  async #writeAccount(client, context, account, { complete }) {
    const snapshot = publicSnapshot(account);
    const nextEmail = normalizeEmail(account.email || context.email);
    const stage = complete ? 'registered' : lifecycleStage(account, context.lifecycle_stage);
    const updated = await client.query(`
      update accounts
      set email = $2,
          login_email = nullif($3, ''),
          password_status = $4,
          totp_status = $5,
          eligibility_status = $6,
          payment_method_status = $7,
          lifecycle_stage = $8,
          plan_status = $9,
          account_snapshot_json = $10::jsonb,
          last_registration_job_id = coalesce($11, last_registration_job_id),
          version = version + 1,
          updated_at = now()
      where id = $1
      returning id
    `, [
      context.account_id,
      nextEmail,
      normalizeEmail(account.loginEmail),
      passwordStatus(account),
      totpStatus(account),
      eligibilityStatus(account),
      paymentMethodStatus(account),
      stage,
      planStatus(account),
      jsonValue(snapshot, {}),
      context.job_id,
    ]);
    if (updated.rowCount !== 1) throw assetError('ACCOUNT_UPDATE_CONFLICT', 'account changed during update');

    await client.query(`
      insert into account_credentials(
        account_id, password, totp_secret, totp_active_factor_id,
        password_updated_at, totp_updated_at
      )
      values ($1, $2, $3, $4, case when $2::text is null then null else now() end, case when $3::text is null then null else now() end)
      on conflict (account_id) do update set
        password = excluded.password,
        totp_secret = excluded.totp_secret,
        totp_active_factor_id = excluded.totp_active_factor_id,
        password_updated_at = case when account_credentials.password is distinct from excluded.password then now() else account_credentials.password_updated_at end,
        totp_updated_at = case when account_credentials.totp_secret is distinct from excluded.totp_secret then now() else account_credentials.totp_updated_at end,
        updated_at = now()
    `, [
      context.account_id,
      String(account.password ?? '') || null,
      normalizeText(account.totpSecret) || null,
      normalizeText(account.totpActiveFactorId) || null,
    ]);

    const tokens = objectValue(account.tokens);
    const oauthSession = objectValue(account.oauthSession || account.session);
    const sessionContext = { ...objectValue(account.sessionContext) };
    delete sessionContext.totpEnrollmentSessionId;
    const enrollmentSessionId = normalizeText(account.totpEnrollmentSessionId);
    if (enrollmentSessionId) sessionContext.totpEnrollmentSessionId = enrollmentSessionId;
    await client.query(`
      insert into account_auth(
        account_id, access_token, refresh_token, refresh_token_status,
        cookie_json, cookie_status, token_json, oauth_session_json,
        session_context_json, last_refresh_at
      )
      values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
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
        updated_at = now()
    `, [
      context.account_id,
      normalizeText(tokens.accessToken) || null,
      normalizeText(tokens.refreshToken) || null,
      refreshTokenStatus(account),
      jsonValue(authCookies(account), []),
      cookieStatus(account),
      jsonValue(tokens, {}),
      jsonValue(oauthSession, {}),
      jsonValue(sessionContext, {}),
      account.accessTokenLastRefreshedAt || tokens.refreshedAt || null,
    ]);
  }

  #accountSummarySelect() {
    return `
      select
        a.id,
        a.email,
        a.password_status,
        a.totp_status,
        a.eligibility_status,
        a.payment_method_status,
        a.account_snapshot_json - array[
          'session', 'oauthSession', 'tokens', 'sessionContext', 'registrationEnvironment',
          'eligibilityLastResult', 'eligibilityError', 'emailChange', 'passwordSetupError',
          'totpSetupError', 'refreshTokenLastError', 'totpEnrollmentSessionId'
        ]::text[] as account_snapshot_json,
        a.lifecycle_stage,
        a.plan_status,
        a.source,
        a.created_at,
        a.updated_at,
        a.login_email,
        a.last_registration_job_id,
        a.version,
        case when coalesce(c.password, '') <> '' then '__present__' end as password,
        case when coalesce(c.totp_secret, '') <> '' then '__present__' end as totp_secret,
        case when coalesce(c.totp_active_factor_id, '') <> '' then '__present__' end as totp_active_factor_id,
        case when coalesce(auth.access_token, '') <> '' then '__present__' end as access_token,
        case when coalesce(auth.refresh_token, '') <> '' then '__present__' end as refresh_token,
        auth.refresh_token_status,
        '[]'::jsonb as cookie_json,
        auth.cookie_status,
        '{}'::jsonb as token_json,
        '{}'::jsonb as oauth_session_json,
        '{}'::jsonb as session_context_json,
        auth.last_refresh_at
      from accounts a
      left join account_credentials c on c.account_id = a.id
      left join account_auth auth on auth.account_id = a.id`;
  }

  #accountSelect() {
    return `
      select
        a.*,
        c.password,
        c.totp_secret,
        c.totp_active_factor_id,
        auth.access_token,
        auth.refresh_token,
        auth.refresh_token_status,
        auth.cookie_json,
        auth.cookie_status,
        auth.token_json,
        auth.oauth_session_json,
        auth.session_context_json,
        auth.last_refresh_at
      from accounts a
      left join account_credentials c on c.account_id = a.id
      left join account_auth auth on auth.account_id = a.id`;
  }

  #accountFromRow(row) {
    if (!row) return null;
    const snapshot = objectValue(row.account_snapshot_json);
    const tokens = {
      ...objectValue(row.token_json),
      ...(row.access_token ? { accessToken: row.access_token } : {}),
      ...(row.refresh_token ? { refreshToken: row.refresh_token } : {}),
    };
    return {
      ...snapshot,
      id: row.id,
      version: Number(row.version || 0),
      email: row.email,
      loginEmail: row.login_email || snapshot.loginEmail || null,
      status: row.lifecycle_stage === 'registered' ? 'registered' : snapshot.status,
      lifecycleStage: row.lifecycle_stage,
      planStatus: row.plan_status,
      passwordStatus: row.password_status,
      totpStatus: row.totp_status,
      eligibilityStatus: row.eligibility_status,
      paymentMethodStatus: row.payment_method_status,
      source: row.source,
      lastTaskId: row.last_registration_job_id || snapshot.lastTaskId || null,
      password: row.password || '',
      hasTotp: row.totp_status === 'enabled',
      totpSecret: row.totp_secret || '',
      totpActiveFactorId: row.totp_active_factor_id || '',
      totpEnrollmentSessionId: objectValue(row.session_context_json).totpEnrollmentSessionId || '',
      tokens,
      oauthSession: objectValue(row.oauth_session_json),
      session: { cookies: Array.isArray(row.cookie_json) ? row.cookie_json : [] },
      sessionContext: objectValue(row.session_context_json),
      oauthSessionAvailable: row.cookie_status === 'available',
      sessionAvailable: row.cookie_status === 'available',
      oauthSessionExpired: row.cookie_status === 'expired',
      refreshTokenStatus: row.refresh_token_status || 'missing',
      accessTokenLastRefreshedAt: row.last_refresh_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = {
  AccountAssetStore,
  accountView,
  publicSnapshot,
};
