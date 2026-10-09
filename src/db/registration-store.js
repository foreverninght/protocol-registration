'use strict';

const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const ACTIVE_JOB_STATUSES = new Set(['staged', 'queued', 'running', 'waiting_mail', 'retry_waiting']);
const CLAIMABLE_JOB_STATUSES = ['queued', 'retry_waiting'];
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const MAILBOX_SOURCES = new Set([
  'mail_com_split',
  'cloudflare_temp_email',
  'icloud_sheex',
  'icmail_public',
  'share_page',
  'manual',
  'domain',
  'ic',
]);
const CANDIDATE_SOURCES = new Set(['manual', 'share_page', 'icloud_sheex', 'icmail_public', 'ic']);
const { redactEventValue } = require('../utils/redaction');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMailboxSource(value) {
  const source = normalizeText(value).toLowerCase() || 'manual';
  if (!MAILBOX_SOURCES.has(source)) {
    const error = new Error(`unsupported mailbox source: ${source}`);
    error.code = 'REGISTRATION_MAILBOX_SOURCE_INVALID';
    throw error;
  }
  return source;
}

function accountSource(mailboxSource) {
  if (mailboxSource === 'mail_com_split') return 'mail_com_split';
  if (mailboxSource === 'cloudflare_temp_email' || mailboxSource === 'domain') return 'domain';
  if (mailboxSource === 'icloud_sheex' || mailboxSource === 'icmail_public' || mailboxSource === 'share_page' || mailboxSource === 'ic') return 'ic';
  return 'manual';
}

function serializableObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function jobStatusFromEvent(event = {}, currentStatus = '') {
  const type = normalizeText(event.type).toLowerCase();
  const status = normalizeText(event.status).toLowerCase();
  const step = normalizeText(event.step).toLowerCase();
  if (type === 'registration.completed' || step === 'completed') return 'completed';
  if (type === 'registration.failed' || status === 'failed') return 'failed';
  if (type === 'registration.cancelled' || status === 'cancelled') return 'cancelled';
  if (type === 'registration.blocked' || status === 'blocked') return 'blocked';
  if (status === 'waiting_for_otp' || step === 'mailbox_polling') return 'waiting_mail';
  if (status === 'running' || step) return 'running';
  return currentStatus;
}

function registrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function assertRegistrationLease(client, jobId, guard) {
  if (!guard) return null;
  const id = normalizeText(jobId || guard.jobId);
  if (!id || (guard.jobId && guard.jobId !== id)
    || !normalizeText(guard.workerId) || !Number.isSafeInteger(guard.attemptCount)
    || guard.attemptCount < 1) {
    throw registrationError('REGISTRATION_WORKER_LEASE_LOST', 'invalid registration lease guard', { retryableProxy: false });
  }
  await client.query('select id from registration_jobs where id = $1 for update', [id]);
  const result = await client.query(
    `select id, account_id from registration_jobs
     where id = $1 and claimed_by = $2 and attempt_count = $3
       and ((status in ('running', 'waiting_mail') and lease_expires_at > clock_timestamp())
         or ($4::boolean and status in ('completed', 'failed', 'cancelled', 'blocked')))`,
    [id, guard.workerId, guard.attemptCount, guard.allowTerminal === true],
  );
  if (!result.rows[0]) {
    throw registrationError('REGISTRATION_WORKER_LEASE_LOST', 'registration lease is expired or belongs to another claim', { retryableProxy: false });
  }
  return result.rows[0];
}

async function withRegistrationLease(pool, guard, action) {
  if (!guard) return action(pool);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const job = await assertRegistrationLease(client, guard.jobId, guard);
    const result = await action(client, job);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function deriveWorkflowStage(row, { status, active, rawJobStatus }) {
  const lifecycleStage = normalizeText(row.lifecycle_stage).toLowerCase();
  const passwordReady = normalizeText(row.password_status).toLowerCase() === 'has_password';
  const totpReady = normalizeText(row.totp_status).toLowerCase() === 'enabled';
  const tokenReady = row.access_token_available === true && row.final_at_status !== 'invalid';
  const sessionReady = row.session_available === true;
  const splitMailbox = normalizeText(row.source).toLowerCase() === 'mail_com_split';
  const jobMode = normalizeText(row.job_mode).toLowerCase();
  if (active && jobMode === 'register' && !tokenReady && !sessionReady) return 'registering';
  if (active && jobMode === 'credential_repair') return 'repair';
  if (row.completion_failed === true && row.completion_error_code === 'FREEPP_CHANGE_EMAIL_FAILED') return 'unrepairable';
  const registered = row.registration_created === true || tokenReady || sessionReady
    || ['registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'plus', 'sold'].includes(lifecycleStage);
  if (!registered) {
    if (active) return 'registering';
    if (['failed', 'cancelled', 'blocked'].includes(rawJobStatus)) {
      if (splitMailbox) return 'registration_failed';
      const mailboxRepairStatus = normalizeText(row.mailbox_repair_status).toLowerCase();
      const mailboxRepairCheckedAt = new Date(row.mailbox_repair_checked_at || 0).getTime();
      const mailboxRepairFresh = Number.isFinite(mailboxRepairCheckedAt)
        && Date.now() - mailboxRepairCheckedAt < 10 * 60 * 1000;
      if (mailboxRepairStatus === 'available' && mailboxRepairFresh) return 'repair';
      if (['expired', 'delivery_failed'].includes(mailboxRepairStatus)) return 'unrepairable';
      return row.registration_mailbox_url || mailboxRepairStatus ? 'repair_verification' : 'registration_failed';
    }
    return 'preparing';
  }
  const mailboxRepairCheckedAt = new Date(row.mailbox_repair_checked_at || 0).getTime();
  const mailboxRepairFresh = Number.isFinite(mailboxRepairCheckedAt)
    && Date.now() - mailboxRepairCheckedAt < 10 * 60 * 1000;
  const credentialRepairErrorCode = normalizeText(row.credential_repair_error_code).toUpperCase();
  const repairInboxExpired = ['expired', 'delivery_failed'].includes(normalizeText(row.mailbox_repair_status).toLowerCase())
    || credentialRepairErrorCode === 'CREDENTIAL_REPAIR_UNKNOWN_MFA'
    || (credentialRepairErrorCode === 'MAILBOX_CODE_TIMEOUT'
    && row.registration_created_at
    && Date.now() - new Date(row.registration_created_at).getTime() >= 7 * 24 * 60 * 60 * 1000);
  if (!splitMailbox && (!passwordReady || !totpReady || !tokenReady || !sessionReady)) {
    if (repairInboxExpired) return 'unrepairable';
    return normalizeText(row.mailbox_repair_status).toLowerCase() === 'available' && mailboxRepairFresh
      ? 'repair'
      : 'repair_verification';
  }
  if (row.completion_failed === true) return 'unrepairable';
  const eligibility = normalizeText(row.eligibility_status).toLowerCase();
  if (!eligibility || ['unknown', 'checking', 'failed'].includes(eligibility)) return 'eligibility';
  if (eligibility === 'not_eligible') return 'discarded';
  if (eligibility !== 'eligible') return 'eligibility';
  const saved = normalizeText(row.mail_com_stage).toLowerCase();
  if (saved === 'sold') return 'sold';
  if (saved === 'completed') return 'completed';
  if (saved === 'paid' || saved === 'sms') return 'paid';
  const payment = normalizeText(row.payment_method_status).toLowerCase();
  if (!['available', 'done'].includes(payment)) return 'payment_method';
  if (['pending_payment', 'unpaid'].includes(saved)) return 'unpaid';
  return 'refining';
}

function registrationView(row = {}) {
  const lifecycleStage = normalizeText(row.lifecycle_stage).toLowerCase() || 'created';
  const rawJobStatus = normalizeText(row.job_status).toLowerCase();
  let status = rawJobStatus || 'idle';
  const step = normalizeText(row.job_step).toLowerCase();
  const jobMode = normalizeText(row.job_mode).toLowerCase();
  const active = ACTIVE_JOB_STATUSES.has(status);
  const terminal = TERMINAL_JOB_STATUSES.has(status);
  const registeredAsset = row.completion_failed !== true && Boolean(row.access_token_available)
    && row.session_available === true
    && normalizeText(row.password_status).toLowerCase() === 'has_password'
    && normalizeText(row.totp_status).toLowerCase() === 'enabled';
  if (registeredAsset && (!rawJobStatus || TERMINAL_JOB_STATUSES.has(rawJobStatus))) status = 'completed';
  const workflowStage = deriveWorkflowStage(row, { status, active, rawJobStatus });
  const labels = {
    queued: '排队中',
    retry_waiting: '等待重试',
    running: step === 'claimed' ? '已领取' : (jobMode === 'credential_repair' ? '修复中' : '注册中'),
    waiting_mail: jobMode === 'credential_repair' ? '修复等验证码' : '等验证码',
    completed: '注册成功',
    failed: '注册失败',
    cancelled: '已取消',
    blocked: '已阻塞',
    idle: '未开始',
  };
  let action = 'start';
  if (active || registeredAsset || status === 'completed') action = 'none';
  else if (['failed', 'cancelled', 'blocked'].includes(status)) action = 'retry';
  return {
    email: row.email,
    source: row.source,
    lifecycleStage,
    planStatus: row.plan_status || 'unknown',
    passwordStatus: row.password_status || 'unknown',
    totpStatus: row.totp_status || 'unknown',
    eligibilityStatus: row.eligibility_status || 'unknown',
    paymentMethodStatus: row.payment_method_status || 'unknown',
    jobId: row.job_id || null,
    status,
    step,
    label: labels[status] || status,
    detail: registeredAsset && ['failed', 'cancelled', 'blocked'].includes(rawJobStatus)
      ? ''
      : row.error_message || '',
    branch: row.branch || null,
    mode: jobMode || null,
    active,
    terminal,
    action,
    actionLabel: action === 'retry' ? '重试' : (action === 'none' ? labels[status] || '处理中' : '启动'),
    workflowStage,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

class RegistrationStore {
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

  async importCandidates(candidates = []) {
    if (!Array.isArray(candidates)) {
      throw registrationError('REGISTRATION_CANDIDATES_INPUT_INVALID', 'registration candidates must be an array');
    }
    const normalized = candidates.map((candidate) => {
      const email = normalizeEmail(candidate?.email);
      const mailboxUrl = normalizeText(candidate?.mailboxUrl) || null;
      const mailboxSource = normalizeText(candidate?.mailboxSource).toLowerCase() || (mailboxUrl ? 'share_page' : 'manual');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !CANDIDATE_SOURCES.has(mailboxSource)) {
        throw registrationError(
          'REGISTRATION_CANDIDATE_INVALID',
          `registration candidate is invalid: ${email || '(missing email)'}`,
        );
      }
      if ((['share_page', 'icloud_sheex', 'icmail_public'].includes(mailboxSource) && !mailboxUrl) || (mailboxSource === 'manual' && mailboxUrl)) {
        throw registrationError(
          'REGISTRATION_CANDIDATE_MAILBOX_INVALID',
          `registration candidate mailbox source does not match its URL: ${email}`,
        );
      }
      return { email, mailboxUrl, mailboxSource };
    });
    if (!normalized.length) return { imported: [], existing: [] };
    const unique = [...new Map(normalized.map((candidate) => [candidate.email, candidate])).values()];
    const payload = unique.map((candidate) => ({
      email: candidate.email,
      mailbox_source: candidate.mailboxSource,
      mailbox_url: candidate.mailboxUrl,
    }));
    const inserted = await this.pool.query(`
      insert into registration_candidates(email, mailbox_source, mailbox_url)
      select candidate.email, candidate.mailbox_source, nullif(candidate.mailbox_url, '')
      from jsonb_to_recordset($1::jsonb) as candidate(email text, mailbox_source text, mailbox_url text)
      on conflict (email) do nothing
      returning id, email, mailbox_source, mailbox_url, status, created_at, updated_at
    `, [JSON.stringify(payload)]);
    const importedEmails = new Set(inserted.rows.map((row) => row.email));
    return {
      imported: inserted.rows.map((row) => this.#candidateFromRow(row)),
      existing: unique.filter((candidate) => !importedEmails.has(candidate.email)).map((candidate) => candidate.email),
    };
  }

  async listCandidates({ status = 'ready' } = {}) {
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (!['ready', 'started'].includes(normalizedStatus)) {
      throw registrationError('REGISTRATION_CANDIDATE_STATUS_INVALID', `unsupported candidate status: ${normalizedStatus}`);
    }
    const result = await this.pool.query(`
      select candidate.id, candidate.email, candidate.mailbox_source, candidate.mailbox_url,
             candidate.status, candidate.registration_job_id,
             candidate.mail_com_stage, candidate.mail_com_release_status,
             candidate.mail_com_release_error, candidate.gcash_sold,
             account.id as account_id,
             account.account_snapshot_json->>'mailComStage' as account_mail_com_stage,
             account.account_snapshot_json->>'mailComReleaseStatus' as account_mail_com_release_status,
             account.account_snapshot_json->>'mailComReleaseError' as account_mail_com_release_error,
             account.account_snapshot_json->>'gcashSold' as account_gcash_sold,
             account.updated_at as account_updated_at,
             latest_job.id as latest_job_id,
             candidate.created_at, candidate.updated_at
      from registration_candidates candidate
      left join accounts account on account.email = candidate.email
      left join lateral (
        select job.id
        from registration_jobs job
        where job.account_id = account.id
        order by job.created_at desc, job.id desc
        limit 1
      ) latest_job on true
      where candidate.status = $1
      order by candidate.created_at desc, candidate.email asc
    `, [normalizedStatus]);
    return result.rows.map((row) => this.#candidateFromRow(row));
  }

  async deleteReadyCandidates(ids = []) {
    const candidateIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(normalizeText).filter(Boolean))];
    if (!candidateIds.length) return { deleted: 0, requested: 0 };
    if (candidateIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
      throw registrationError(
        'REGISTRATION_CANDIDATE_SELECTION_INVALID',
        'selected email rows must be registration candidate UUIDs',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const selected = await client.query(`
        select id, status
        from registration_candidates
        where id = any($1::uuid[])
        for update
      `, [candidateIds]);
      if (selected.rowCount !== candidateIds.length) {
        throw registrationError(
          'REGISTRATION_CANDIDATE_SELECTION_INVALID',
          'one or more selected email rows are not deletable registration candidates',
        );
      }
      const started = selected.rows.filter((row) => row.status !== 'ready');
      if (started.length) {
        throw registrationError(
          'REGISTRATION_CANDIDATE_ALREADY_STARTED',
          'started registration candidates cannot be deleted',
          { ids: started.map((row) => row.id) },
        );
      }
      const deleted = await client.query(`
        delete from registration_candidates
        where id = any($1::uuid[]) and status = 'ready'
        returning id
      `, [candidateIds]);
      if (deleted.rowCount !== candidateIds.length) {
        throw registrationError('REGISTRATION_CANDIDATE_DELETE_CONFLICT', 'registration candidates changed during deletion');
      }
      await client.query('commit');
      return { deleted: deleted.rowCount, requested: candidateIds.length };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteCandidateByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return { deleted: 0, requested: 0 };
    const result = await this.pool.query(`
      delete from registration_candidates
      where email = $1
      returning id
    `, [normalizedEmail]);
    return { deleted: Number(result.rowCount || 0), requested: 1, email: normalizedEmail };
  }

  async retryJob({ jobId, proxyPoolId = null, browserEngine = null, entryBranch = null } = {}) {
    const id = normalizeText(jobId);
    if (!id) throw registrationError('REGISTRATION_JOB_ID_REQUIRED', 'retry requires a registration job id');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const locked = await client.query(`
        select r.id, r.status, r.last_event_sequence, r.account_id, r.mailbox_source, a.email, i.mailbox_url
        from registration_jobs r
        join accounts a on a.id = r.account_id
        join registration_job_inputs i on i.job_id = r.id
        where r.id = $1
        for update of r, a
      `, [id]);
      const job = locked.rows[0];
      if (!job) throw registrationError('REGISTRATION_JOB_NOT_FOUND', `registration job not found: ${id}`);
      if (!TERMINAL_JOB_STATUSES.has(job.status)) {
        throw registrationError('REGISTRATION_JOB_NOT_RETRYABLE', `registration job is ${job.status}, not retryable`);
      }
      const sequence = Number(job.last_event_sequence || 0) + 1;
      const branch = normalizeText(entryBranch).toLowerCase();
      await client.query(`
        update registration_job_inputs
        set proxy_pool_id = coalesce(nullif($2, ''), proxy_pool_id),
            browser_engine = case
              when $4 = 'freepp' then null
              else coalesce(nullif($3, ''), browser_engine)
            end
        where job_id = $1
      `, [id, normalizeText(proxyPoolId), normalizeText(browserEngine).toLowerCase(), branch]);
      await client.query(`
        update registration_jobs
        set status = 'queued',
            step = 'queued',
            branch = coalesce(nullif($2, ''), branch),
            attempt_count = attempt_count + 1,
            claimed_by = null,
            lease_expires_at = null,
            error_code = null,
            error_message = null,
            next_run_at = now(),
            started_at = null,
            completed_at = null,
            last_event_sequence = $3,
            updated_at = now()
        where id = $1
      `, [id, branch, sequence]);
      await client.query(`
        update accounts
        set lifecycle_stage = 'registering',
            account_snapshot_json = account_snapshot_json || jsonb_build_object(
              'status', 'registration_in_progress',
              'retryJobId', $2::text,
              'retryQueuedAt', now()
            ),
            version = version + 1,
            updated_at = now()
        where id = $1
      `, [job.account_id, id]);
      await client.query(`
        insert into registration_candidates(
          email, mailbox_source, mailbox_url, status, registration_job_id, mail_com_stage
        ) values ($1, $2, nullif($3, ''), 'started', $4, 'registering')
        on conflict (email) do update
        set mailbox_source = excluded.mailbox_source,
            mailbox_url = coalesce(excluded.mailbox_url, registration_candidates.mailbox_url),
            status = 'started',
            registration_job_id = excluded.registration_job_id,
            mail_com_stage = 'registering',
            updated_at = now()
      `, [job.email, job.mailbox_source, job.mailbox_url, id]);
      await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
        values ($1, $2, 'task.retry_queued', 'queued', 'queued', $3, $4::jsonb)
      `, [
        id,
        sequence,
        `Queued registration retry ${job.email}`,
        JSON.stringify({ sequence, type: 'task.retry_queued', status: 'queued', step: 'queued', email: job.email }),
      ]);
      await client.query('commit');
      return this.loadJob({ jobId: id, includeSecret: false, includeEvents: true });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createJob(input = {}) {
    return this.#createJob(input);
  }

  async createRefillJob({ refillItemId, ...input } = {}) {
    const itemId = normalizeText(refillItemId);
    if (!itemId) {
      throw registrationError('ALIAS_REFILL_ITEM_REQUIRED', 'refill registration job requires refillItemId');
    }
    return this.#createJob({ ...input, staged: true, refillItemId: itemId });
  }

  async #createJob({
    id,
    email,
    registrationPassword,
    mailboxSource = 'manual',
    mailboxId = null,
    aliasId = null,
    mailboxUrl = null,
    proxyPoolId = null,
    browserEngine = null,
    entryBranch = 'freepp',
    mode = 'register',
    options = {},
    staged = false,
    refillItemId = null,
  } = {}) {
    const jobId = normalizeText(id);
    const normalizedEmail = normalizeEmail(email);
    const password = String(registrationPassword ?? '');
    let source = normalizeMailboxSource(mailboxSource);
    let effectiveMailboxUrl = normalizeText(mailboxUrl) || null;
    const normalizedMode = normalizeText(mode).toLowerCase() || 'register';
    const branch = normalizeText(entryBranch).toLowerCase() || 'freepp';
    const normalizedMailboxId = normalizeText(mailboxId) || null;
    const normalizedAliasId = normalizeText(aliasId) || null;
    const normalizedRefillItemId = normalizeText(refillItemId) || null;
    const initialStatus = staged ? 'staged' : 'queued';
    if (!jobId || !normalizedEmail || !password.trim()) {
      throw registrationError('REGISTRATION_JOB_INPUT_INVALID', 'registration job requires id, email, and password');
    }
    if (normalizedMode !== 'register') {
      throw registrationError('REGISTRATION_JOB_MODE_INVALID', `unsupported registration mode: ${normalizedMode}`);
    }
    if (normalizedRefillItemId && source !== 'mail_com_split') {
      throw registrationError('ALIAS_REFILL_SOURCE_INVALID', 'refill registration jobs require mail_com_split source');
    }
    if (source === 'mail_com_split' && (!normalizedMailboxId || !normalizedAliasId)) {
      throw registrationError(
        'REGISTRATION_JOB_OWNERSHIP_INVALID',
        'mail.com split registration requires mailboxId and aliasId',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const candidateResult = await client.query(`
        select id, mailbox_source, mailbox_url, status, registration_job_id
        from registration_candidates
        where email = $1
        for update
      `, [normalizedEmail]);
      const candidate = candidateResult.rows[0];
      if (candidate) {
        if (candidate.status !== 'ready') {
          throw registrationError(
            'REGISTRATION_CANDIDATE_ALREADY_STARTED',
            'registration candidate already belongs to a registration job',
            { jobId: candidate.registration_job_id },
          );
        }
        source = normalizeMailboxSource(candidate.mailbox_source);
        effectiveMailboxUrl = normalizeText(candidate.mailbox_url) || null;
      }
      if (source === 'mail_com_split') {
        const ownership = await client.query(`
          select ea.id, ea.email, ea.mailbox_id, ea.status, m.email as mailbox_email
          from email_aliases ea
          join mailboxes m on m.id = ea.mailbox_id
          where ea.id = $1
            and ea.mailbox_id = $2
          for update of ea, m
        `, [normalizedAliasId, normalizedMailboxId]);
        const alias = ownership.rows[0];
        if (!alias || normalizeEmail(alias.email) !== normalizedEmail || alias.status === 'registered') {
          throw registrationError(
            'REGISTRATION_JOB_OWNERSHIP_INVALID',
            'registration alias does not belong to the selected main mailbox',
          );
        }
      }

      const accountResult = await client.query(`
        insert into accounts(email, lifecycle_stage, source)
        values ($1, 'registering', $2)
        on conflict (email) do update set
          lifecycle_stage = 'registering',
          source = excluded.source,
          updated_at = now()
        where accounts.lifecycle_stage in ('created', 'registering', 'abandoned')
        returning id
      `, [normalizedEmail, accountSource(source)]);
      if (accountResult.rowCount !== 1) {
        throw registrationError(
          'REGISTRATION_ACCOUNT_CONFLICT',
          'registered account cannot be replaced by a new registration job',
        );
      }
      const accountId = accountResult.rows[0].id;

      if (source === 'mail_com_split') {
        const aliasUpdate = await client.query(`
          update email_aliases
          set account_id = $2,
              status = 'registering',
              assigned_at = coalesce(assigned_at, now()),
              updated_at = now()
          where id = $1
            and mailbox_id = $3
            and status in ('reserved', 'creating', 'unused', 'assigned', 'registering')
          returning id
        `, [normalizedAliasId, accountId, normalizedMailboxId]);
        if (aliasUpdate.rowCount !== 1) {
          throw registrationError(
            'REGISTRATION_ALIAS_STATE_INVALID',
            'registration alias is not available for assignment',
          );
        }
      }

      await client.query(`
        insert into registration_jobs(
          id, account_id, status, step, branch, mode, mailbox_source,
          mailbox_id, alias_id, next_run_at, last_event_sequence
        )
        values ($1, $2, $3, $3, $4, $5, $6, $7, $8, now(), 1)
      `, [
        jobId,
        accountId,
        initialStatus,
        branch,
        normalizedMode,
        source,
        normalizedMailboxId,
        normalizedAliasId,
      ]);
      await client.query(`
        insert into registration_job_inputs(
          job_id, registration_password, mailbox_url, proxy_pool_id,
          browser_engine, options_json
        )
        values ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        jobId,
        password,
        effectiveMailboxUrl,
        normalizeText(proxyPoolId) || null,
        normalizeText(browserEngine).toLowerCase() || null,
        JSON.stringify(serializableObject(options)),
      ]);
      const createdEvent = {
        sequence: 1,
        type: 'task.created',
        status: initialStatus,
        step: initialStatus,
        email: normalizedEmail,
      };
      await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
        values ($1, 1, 'task.created', $2, $2, $3, $4::jsonb)
      `, [
        jobId,
        initialStatus,
        `Created registration task ${normalizedEmail}`,
        JSON.stringify(createdEvent),
      ]);
      if (normalizedRefillItemId) {
        const refillItem = await client.query(`
          update alias_refill_items item
          set job_id = $3,
              status = 'queued',
              updated_at = now()
          from alias_refill_runs run
          where item.id = $1
            and item.alias_id = $2
            and item.mailbox_id = $4
            and item.refill_run_id = run.id
            and item.status = 'created'
            and run.status = 'running'
          returning item.id
        `, [normalizedRefillItemId, normalizedAliasId, jobId, normalizedMailboxId]);
        if (refillItem.rowCount !== 1) {
          throw registrationError(
            'ALIAS_REFILL_JOB_LINK_INVALID',
            'refill item does not own the staged job alias and mailbox',
          );
        }
      }
      if (candidate) {
        const consumed = await client.query(`
          update registration_candidates
          set status = 'started', registration_job_id = $2, updated_at = now()
          where id = $1 and status = 'ready' and registration_job_id is null
          returning id
        `, [candidate.id, jobId]);
        if (consumed.rowCount !== 1) {
          throw registrationError('REGISTRATION_CANDIDATE_CONSUME_CONFLICT', 'registration candidate changed during task creation');
        }
      }
      if (!candidate && source === 'mail_com_split') {
        await client.query(`
          insert into registration_candidates(
            email, mailbox_source, mailbox_url, status, registration_job_id, mail_com_stage
          )
          values ($1, 'mail_com_split', null, 'started', $2, 'unregistered')
        `, [normalizedEmail, jobId]);
      }
      await client.query('commit');
      return this.loadJob({ jobId, includeSecret: false, includeEvents: true });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      if (error?.code === '23505' && error?.constraint === 'ux_registration_jobs_one_active_per_alias') {
        throw registrationError(
          'REGISTRATION_ALIAS_ACTIVE_JOB_EXISTS',
          'mail.com split alias already has an active registration job',
          { aliasId: normalizedAliasId },
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async retryNextRepairableRegistration({ proxyPoolId = null, entryBranch = 'freepp' } = {}) {
    const result = await this.pool.query(`
      select latest.id
      from accounts a
      join lateral (
        select r.id, r.status, r.updated_at, r.mailbox_source
        from registration_jobs r
        where r.account_id = a.id and r.mode = 'register'
        order by r.created_at desc, r.id desc
        limit 1
      ) latest on true
      left join account_auth auth on auth.account_id = a.id
      where latest.status = any($1::text[])
        and latest.mailbox_source <> 'mail_com_split'
        and coalesce(a.account_snapshot_json->'completionError', 'null'::jsonb) = 'null'::jsonb
        and coalesce(a.account_snapshot_json->>'registrationCreated', 'false') <> 'true'
        and a.lifecycle_stage not in ('registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'plus', 'sold')
        and coalesce(auth.access_token, '') = ''
        and coalesce(auth.cookie_status, 'missing') <> 'available'
        and a.account_snapshot_json#>>'{mailboxRepairability,status}' = 'available'
        and nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz >= now() - interval '10 minutes'
        and latest.updated_at < now() - interval '5 minutes'
        and (
          select count(*)
          from registration_events retry_event
          where retry_event.job_id = latest.id
            and retry_event.type = 'task.retry_queued'
        ) < 3
        and not exists (
          select 1 from registration_jobs active
          where active.account_id = a.id
            and active.status = any($2::text[])
        )
      order by latest.updated_at asc
      limit 1
    `, [[...TERMINAL_JOB_STATUSES], [...ACTIVE_JOB_STATUSES]]);
    const jobId = result.rows[0]?.id;
    if (!jobId) return null;
    try {
      return await this.retryJob({ jobId, proxyPoolId, entryBranch });
    } catch (error) {
      if (error?.code === 'REGISTRATION_JOB_NOT_RETRYABLE') return null;
      throw error;
    }
  }

  async createCredentialRepairJob({ email = '', proxyPoolId = null, automatic = false } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const candidate = await client.query(`
        select a.id as account_id, a.email, a.lifecycle_stage, a.password_status, a.totp_status,
               coalesce(c.password, input.registration_password) as password, auth.access_token, auth.cookie_status,
               previous.id as previous_job_id, previous.created_at as previous_created_at,
               previous.mailbox_source, previous.mailbox_id, previous.alias_id,
               input.mailbox_url, input.proxy_pool_id,
               a.account_snapshot_json#>>'{finalAtValidation,status}' as final_at_status
        from accounts a
        left join account_credentials c on c.account_id = a.id
        left join account_auth auth on auth.account_id = a.id
        join lateral (
          select r.id, r.created_at, r.mailbox_source, r.mailbox_id, r.alias_id
          from registration_jobs r
          where r.account_id = a.id and r.mode = 'register'
          order by r.created_at desc, r.id desc
          limit 1
        ) previous on true
        join registration_job_inputs input on input.job_id = previous.id
        where ($1::text = '' or a.email = $1)
          and (
            a.lifecycle_stage = 'registered'
            or a.account_snapshot_json->>'registrationCreated' = 'true'
            or a.account_snapshot_json#>>'{completionError,code}' in ('FREEPP_FINAL_AT_VALIDATION_FAILED', 'FREEPP_CHANGE_EMAIL_FAILED')
            or coalesce(auth.access_token, '') <> ''
            or auth.cookie_status = 'available'
          )
          and (
            a.password_status <> 'has_password'
            or a.totp_status <> 'enabled'
            or coalesce(auth.access_token, '') = ''
            or coalesce(auth.cookie_status, 'missing') <> 'available'
            or a.account_snapshot_json#>>'{finalAtValidation,status}' = 'invalid'
          )
          and coalesce(c.password, input.registration_password, '') <> ''
          and coalesce(a.account_snapshot_json#>>'{credentialRepair,error,code}', '') <> 'CREDENTIAL_REPAIR_UNKNOWN_MFA'
          and previous.mailbox_source <> 'mail_com_split'
          and (not $2::boolean or (
            a.account_snapshot_json#>>'{mailboxRepairability,status}' = 'available'
            and nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz >= now() - interval '10 minutes'
          ))
          and (
            not $2::boolean
            or previous.created_at >= now() - interval '7 days'
            or coalesce((
              select stale.error_code
              from registration_jobs stale
              where stale.account_id = a.id and stale.mode = 'credential_repair'
              order by stale.created_at desc, stale.id desc
              limit 1
            ), '') <> 'MAILBOX_CODE_TIMEOUT'
          )
          and (not $2::boolean or (
            (select count(*) from registration_jobs recent
             where recent.account_id = a.id
               and recent.mode = 'credential_repair'
               and recent.created_at >= now() - interval '1 hour') < 3
            and (select count(*)
                 from registration_jobs automatic_job
                 join registration_job_inputs automatic_input on automatic_input.job_id = automatic_job.id
                 where automatic_job.account_id = a.id
                   and automatic_job.mode = 'credential_repair'
                   and coalesce(automatic_input.options_json#>>'{automatic}', 'false') = 'true') < 6
            and not exists (
              select 1 from registration_jobs cooldown
              where cooldown.account_id = a.id
                and cooldown.mode = 'credential_repair'
                and cooldown.created_at >= now() - interval '15 minutes'
            )
          ))
          and not exists (
            select 1 from registration_jobs active
            where active.account_id = a.id
              and active.status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting')
          )
        order by a.updated_at asc
        limit 1
        for update of a
      `, [normalizedEmail, Boolean(automatic)]);
      const row = candidate.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }
      const id = randomUUID();
      const options = {
        credentialRepair: true,
        automatic: Boolean(automatic),
        repairPassword: row.password_status !== 'has_password',
        repairTotp: row.totp_status !== 'enabled',
        repairLogin: !row.access_token || row.cookie_status !== 'available' || row.final_at_status === 'invalid',
        previousJobId: row.previous_job_id,
      };
      await client.query(`
        insert into registration_jobs(
          id, account_id, status, step, branch, mode, mailbox_source, mailbox_id, alias_id,
          next_run_at, last_event_sequence
        ) values ($1, $2, 'queued', 'queued', 'freepp', 'credential_repair', $3, $4, $5, now(), 1)
      `, [id, row.account_id, row.mailbox_source, row.mailbox_id, row.alias_id]);
      await client.query(`
        insert into registration_job_inputs(
          job_id, registration_password, mailbox_url, proxy_pool_id, browser_engine, options_json
        ) values ($1, $2, $3, $4, null, $5::jsonb)
      `, [id, row.password, row.mailbox_url, normalizeText(proxyPoolId) || row.proxy_pool_id, JSON.stringify(options)]);
      const event = {
        type: 'credential_repair.queued',
        status: 'queued',
        step: 'queued',
        email: row.email,
        repairPassword: options.repairPassword,
        repairTotp: options.repairTotp,
        automatic: options.automatic,
      };
      await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
        values ($1, 1, $2, 'queued', 'queued', $3, $4::jsonb)
      `, [id, event.type, 'Queued credential repair task', JSON.stringify(event)]);
      await client.query(`
        update accounts
        set account_snapshot_json = account_snapshot_json || $2::jsonb, updated_at = now(), version = version + 1
        where id = $1
      `, [row.account_id, JSON.stringify({
        workflowStage: 'repair',
        mailComStage: 'repair',
        credentialRepair: { status: 'queued', taskId: id, automatic: options.automatic, queuedAt: new Date().toISOString() },
      })]);
      await client.query('commit');
      return this.loadJob({ jobId: id, includeEvents: true });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadJob({ jobId, includeSecret = false, includeEvents = false, client = this.pool } = {}) {
    const id = normalizeText(jobId);
    if (!id) return null;
    const result = await client.query(`
      select
        r.id,
        r.status,
        r.step,
        r.branch,
        r.mode,
        r.mailbox_source,
        r.mailbox_id,
        r.alias_id,
        r.attempt_count,
        r.last_event_sequence,
        r.claimed_by,
        r.lease_expires_at,
        r.error_code,
        r.error_message,
        r.created_at,
        r.updated_at,
        r.started_at,
        r.completed_at,
        a.id as account_id,
        a.email,
        i.registration_password,
        i.mailbox_url,
        i.proxy_pool_id,
        i.browser_engine,
        i.options_json,
        m.email as main_mailbox_email
      from registration_jobs r
      join accounts a on a.id = r.account_id
      join registration_job_inputs i on i.job_id = r.id
      left join mailboxes m on m.id = r.mailbox_id
      where r.id = $1
    `, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const task = this.#jobFromRow(row, { includeSecret });
    if (includeEvents) task.events = await this.listEvents({ jobId: id, client });
    return task;
  }

  async listJobs({
    mailboxSource = '',
    statuses = [],
    emails = [],
    jobIds = [],
    includeSecret = false,
    includeEvents = false,
    limit = 500,
    offset = 0,
  } = {}) {
    const source = normalizeText(mailboxSource).toLowerCase();
    const normalizedStatuses = (Array.isArray(statuses) ? statuses : [statuses])
      .map((status) => normalizeText(status).toLowerCase())
      .filter(Boolean);
    const normalizedEmails = (Array.isArray(emails) ? emails : [emails])
      .map(normalizeEmail)
      .filter(Boolean);
    const normalizedJobIds = (Array.isArray(jobIds) ? jobIds : [jobIds])
      .map(normalizeText)
      .filter(Boolean);
    const result = await this.pool.query(`
      select
        r.id,
        r.status,
        r.step,
        r.branch,
        r.mode,
        r.mailbox_source,
        r.mailbox_id,
        r.alias_id,
        r.attempt_count,
        r.last_event_sequence,
        r.claimed_by,
        r.lease_expires_at,
        r.error_code,
        r.error_message,
        r.created_at,
        r.updated_at,
        r.started_at,
        r.completed_at,
        a.id as account_id,
        a.email,
        i.registration_password,
        i.mailbox_url,
        i.proxy_pool_id,
        i.browser_engine,
        i.options_json,
        m.email as main_mailbox_email
      from registration_jobs r
      join accounts a on a.id = r.account_id
      join registration_job_inputs i on i.job_id = r.id
      left join mailboxes m on m.id = r.mailbox_id
      where ($1::text = '' or r.mailbox_source = $1)
        and (cardinality($2::text[]) = 0 or r.status = any($2::text[]))
        and (cardinality($3::text[]) = 0 or a.email = any($3::text[]))
        and (cardinality($4::text[]) = 0 or r.id::text = any($4::text[]))
      order by r.created_at desc, r.id desc
      limit $5 offset $6
    `, [
      source,
      normalizedStatuses,
      normalizedEmails,
      normalizedJobIds,
      Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 500))),
      Math.max(0, Math.trunc(Number(offset) || 0)),
    ]);
    const jobs = result.rows.map((row) => this.#jobFromRow(row, { includeSecret }));
    if (includeEvents) {
      await Promise.all(jobs.map(async (job) => {
        job.events = await this.listEvents({ jobId: job.id });
      }));
    }
    return jobs;
  }

  async countActiveJobs({ mailboxSource = '', mode = '' } = {}) {
    const source = normalizeText(mailboxSource).toLowerCase();
    const normalizedMode = normalizeText(mode).toLowerCase();
    const result = await this.pool.query(`
      select count(*)::int as count
      from registration_jobs
      where status = any($1::text[])
        and ($2::text = '' or mailbox_source = $2)
        and ($3::text = '' or mode = $3)
    `, [[...ACTIVE_JOB_STATUSES], source, normalizedMode]);
    return Number(result.rows[0]?.count || 0);
  }

  async listMailboxRepairabilityChecks({ limit = 12, emails = [] } = {}) {
    const normalizedEmails = [...new Set((Array.isArray(emails) ? emails : [])
      .map((email) => normalizeText(email).toLowerCase())
      .filter(Boolean))];
    const result = await this.pool.query(`
      select
        a.id as account_id,
        latest_input.mailbox_url,
        coalesce(a.account_snapshot_json#>>'{mailboxRepairability,status}', '') as current_status
      from accounts a
      left join account_credentials c on c.account_id = a.id
      left join account_auth auth on auth.account_id = a.id
      join lateral (
        select r.status, i.mailbox_url
        from registration_jobs r
        join registration_job_inputs i on i.job_id = r.id
        where r.account_id = a.id and r.mode = 'register'
        order by r.created_at desc, r.id desc
        limit 1
      ) latest_input on true
      where a.source <> 'mail_com_split'
        and coalesce(latest_input.mailbox_url, '') <> ''
        and (cardinality($5::text[]) = 0 or lower(a.email) = any($5::text[]))
        and coalesce(a.account_snapshot_json#>>'{mailboxRepairability,status}', '') <> 'delivery_failed'
        and not exists (
          select 1 from registration_jobs active
          where active.account_id = a.id and active.status = any($1::text[])
        )
        and (
          (
            (a.lifecycle_stage = any($2::text[])
              or coalesce(auth.access_token, '') <> ''
              or auth.cookie_status = 'available')
            and (
              a.password_status <> 'has_password'
              or a.totp_status <> 'enabled'
              or coalesce(auth.access_token, '') = ''
              or coalesce(auth.cookie_status, 'missing') <> 'available'
              or a.account_snapshot_json#>>'{finalAtValidation,status}' = 'invalid'
            )
          )
          or (
            a.lifecycle_stage <> all($2::text[])
            and coalesce(auth.access_token, '') = ''
            and coalesce(auth.cookie_status, 'missing') <> 'available'
            and latest_input.status = any($3::text[])
          )
        )
        and (
          cardinality($5::text[]) > 0
          or coalesce(
            nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz,
            'epoch'::timestamptz
          ) < now() - case coalesce(a.account_snapshot_json#>>'{mailboxRepairability,status}', '')
            when 'expired' then interval '1 hour'
            when 'unreachable' then interval '5 minutes'
            else interval '5 minutes'
          end
        )
      order by coalesce(
        nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz,
        'epoch'::timestamptz
      ), a.updated_at
      limit $4
    `, [
      [...ACTIVE_JOB_STATUSES],
      ['registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'plus', 'sold'],
      ['failed', 'cancelled', 'blocked'],
      Math.max(1, Math.min(normalizedEmails.length ? 500 : 50, Math.trunc(Number(limit) || 12))),
      normalizedEmails,
    ]);
    return result.rows.map((row) => ({
      accountId: row.account_id,
      mailboxUrl: row.mailbox_url,
      currentStatus: row.current_status || '',
    }));
  }

  async cancelStaleCredentialRepairJobs() {
    const result = await this.pool.query(`
      update registration_jobs job
      set status = 'cancelled',
          step = 'mailbox_revalidation_required',
          error_code = 'MAILBOX_REPAIRABILITY_STALE',
          error_message = 'mailbox repairability must be revalidated before credential repair',
          completed_at = now(),
          claimed_by = null,
          lease_expires_at = null,
          updated_at = now()
      from accounts account
      where job.account_id = account.id
        and job.mode = 'credential_repair'
        and job.status in ('queued', 'retry_waiting')
        and (
          coalesce(account.account_snapshot_json#>>'{mailboxRepairability,status}', '') <> 'available'
          or coalesce(
            nullif(account.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz,
            'epoch'::timestamptz
          ) < now() - interval '10 minutes'
        )
      returning job.id
    `);
    return { cancelled: Number(result.rowCount || 0) };
  }

  async recordMailboxDeliveryFailure({ accountId, detail = 'otp_delivery_timeout', guard = null } = {}) {
    const id = normalizeText(accountId);
    if (!id) return { updated: false, timeoutCount: 0 };
    return withRegistrationLease(this.pool, guard, async (client, job) => {
      if (job && job.account_id !== id) throw registrationError('REGISTRATION_WORKER_LEASE_LOST', 'registration account does not match lease guard', { retryableProxy: false });
      const result = await client.query(`
        with timeout_count as (
          select count(*)::int as count
          from registration_events event
          join registration_jobs job on job.id = event.job_id
          where job.account_id = $1::uuid
            and event.type in ('registration.failed', 'credential_repair.failed')
            and event.payload_json#>>'{error,code}' = 'MAILBOX_CODE_TIMEOUT'
        )
        update accounts account
        set account_snapshot_json = account.account_snapshot_json || jsonb_build_object(
              'mailboxRepairability', jsonb_build_object(
                'status', 'delivery_failed',
                'checkedAt', now()::text,
                'detail', left($2::text, 200)
              )
            ),
            updated_at = now(),
            version = version + 1
        from timeout_count
        where account.id = $1::uuid and timeout_count.count >= 2
        returning timeout_count.count
      `, [id, normalizeText(detail)]);
      return {
        updated: result.rowCount > 0,
        timeoutCount: Number(result.rows[0]?.count || 0),
      };
    });
  }

  async recordMailboxRepairability({ accountId, status, detail = '' } = {}) {
    const id = normalizeText(accountId);
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (!id || !['available', 'expired', 'unreachable', 'delivery_failed'].includes(normalizedStatus)) {
      throw registrationError('MAILBOX_REPAIRABILITY_INPUT_INVALID', 'mailbox repairability result is invalid');
    }
    const result = await this.pool.query(`
      update accounts
      set account_snapshot_json = account_snapshot_json || jsonb_build_object(
            'mailboxRepairability',
            jsonb_build_object(
              'status', $2::text,
              'checkedAt', now()::text,
              'detail', left($3::text, 200)
            )
          ),
          updated_at = now(),
          version = version + 1
      where id = $1::uuid
        and (
          coalesce(account_snapshot_json#>>'{mailboxRepairability,status}', '') <> 'delivery_failed'
          or $2::text = 'delivery_failed'
        )
      returning id
    `, [id, normalizedStatus, normalizeText(detail)]);
    return result.rowCount === 1;
  }

  async registrationViews({ emails = [], mailboxSource = '' } = {}) {
    const normalizedEmails = (Array.isArray(emails) ? emails : [emails]).map(normalizeEmail).filter(Boolean);
    const source = normalizeText(mailboxSource).toLowerCase();
    if (!normalizedEmails.length) {
      return { byEmail: {}, summary: await this.registrationSummary({ mailboxSource: source }) };
    }
    const result = await this.pool.query(`
      select distinct on (a.email)
        a.email,
        a.source,
        a.lifecycle_stage,
        a.plan_status,
        a.password_status,
        coalesce(a.totp_status, 'unknown') as totp_status,
        coalesce(a.eligibility_status, 'unknown') as eligibility_status,
        coalesce(a.payment_method_status, 'unknown') as payment_method_status,
        (coalesce(auth.access_token, '') <> '') as access_token_available,
        (auth.cookie_status = 'available') as session_available,
        coalesce(a.account_snapshot_json->>'mailComStage', '') as mail_com_stage,
        (a.account_snapshot_json->>'registrationCreated' = 'true') as registration_created,
        (coalesce(a.account_snapshot_json->'completionError', 'null'::jsonb) <> 'null'::jsonb) as completion_failed,
        a.account_snapshot_json#>>'{completionError,code}' as completion_error_code,
        a.account_snapshot_json#>>'{finalAtValidation,status}' as final_at_status,
        coalesce(a.account_snapshot_json#>>'{mailboxRepairability,status}', '') as mailbox_repair_status,
        nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz as mailbox_repair_checked_at,
        coalesce(
          nullif(a.account_snapshot_json#>>'{credentialRepair,error,code}', ''),
          (select repair.error_code
           from registration_jobs repair
           where repair.account_id = a.id and repair.mode = 'credential_repair'
           order by repair.created_at desc, repair.id desc
           limit 1),
          ''
        ) as credential_repair_error_code,
        (select registered_input.mailbox_url
         from registration_jobs registered
         join registration_job_inputs registered_input on registered_input.job_id = registered.id
         where registered.account_id = a.id and registered.mode = 'register'
         order by registered.created_at desc, registered.id desc
         limit 1) as registration_mailbox_url,
        (select registered.created_at
         from registration_jobs registered
         where registered.account_id = a.id and registered.mode = 'register'
         order by registered.created_at desc, registered.id desc
         limit 1) as registration_created_at,
        r.id as job_id,
        r.status as job_status,
        r.step as job_step,
        r.mode as job_mode,
        r.branch,
        r.error_message,
        r.created_at,
        r.updated_at,
        r.started_at,
        r.completed_at
      from accounts a
      left join account_auth auth on auth.account_id = a.id
      left join registration_jobs r on r.account_id = a.id
      where a.email = any($1::text[])
        and ($2::text = '' or r.mailbox_source = $2)
      order by a.email, r.created_at desc nulls last
    `, [normalizedEmails, source]);
    return {
      byEmail: Object.fromEntries(result.rows.map((row) => [row.email, registrationView(row)])),
      summary: await this.registrationSummary({ mailboxSource: source }),
    };
  }

  async registrationSummary({ mailboxSource = '' } = {}) {
    const source = normalizeText(mailboxSource).toLowerCase();
    const result = await this.pool.query(`
      select
        count(*) filter (where status in ('staged', 'queued', 'retry_waiting'))::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'waiting_mail')::int as waiting_mail,
        count(*) filter (where status in ('failed', 'blocked'))::int as failed,
        count(*) filter (where status = 'completed')::int as completed,
        count(*) filter (where status in ('staged', 'queued', 'retry_waiting', 'running', 'waiting_mail'))::int as active
      from registration_jobs
      where ($1::text = '' or mailbox_source = $1)
    `, [source]);
    const row = result.rows[0] || {};
    return Object.fromEntries(['queued', 'running', 'waiting_mail', 'failed', 'completed', 'active']
      .map((key) => [key, Number(row[key] || 0)]));
  }

  async listEvents({ jobId, afterSequence = 0, client = this.pool } = {}) {
    const id = normalizeText(jobId);
    if (!id) return [];
    const result = await client.query(`
      select sequence, type, status, step, message, payload_json, created_at
      from registration_events
      where job_id = $1
        and sequence > $2
      order by sequence asc
    `, [id, Math.max(0, Math.trunc(Number(afterSequence) || 0))]);
    return result.rows.map((row) => ({
      ...serializableObject(row.payload_json),
      sequence: Number(row.sequence),
      type: row.type,
      status: row.status,
      step: row.step,
      message: row.message,
      at: row.created_at,
    }));
  }

  async claimJob({ jobId = '', mailboxSource = '', workerId, leaseMs = 300000 } = {}) {
    return this.#claim({ jobId, mailboxSource, workerId, leaseMs });
  }

  async claimNextJob({ mailboxSource = '', mode = '', workerId, leaseMs = 300000 } = {}) {
    return this.#claim({ mailboxSource, mode, workerId, leaseMs });
  }

  async #claim({ jobId = '', mailboxSource = '', mode = '', workerId, leaseMs = 300000 } = {}) {
    const id = normalizeText(jobId);
    const source = normalizeText(mailboxSource).toLowerCase();
    const normalizedMode = normalizeText(mode).toLowerCase();
    const worker = normalizeText(workerId);
    const normalizedLeaseMs = Math.max(10000, Math.min(3600000, Math.trunc(Number(leaseMs) || 300000)));
    if (!worker) throw registrationError('REGISTRATION_WORKER_REQUIRED', 'claiming a registration job requires workerId');
    const result = await this.pool.query(`
      with candidate as (
        select r.id
        from registration_jobs r
        where ($1::uuid is null or r.id = $1)
          and r.status = any($2::text[])
          and r.next_run_at <= now()
          and ($3::text = '' or r.mailbox_source = $3)
          and ($6::text = '' or r.mode = $6)
          and (r.mode <> 'credential_repair' or exists (
            select 1 from accounts a where a.id = r.account_id
              and a.account_snapshot_json#>>'{mailboxRepairability,status}' = 'available'
              and nullif(a.account_snapshot_json#>>'{mailboxRepairability,checkedAt}', '')::timestamptz >= now() - interval '10 minutes'
          ))
        order by (r.mode = 'credential_repair') desc, r.next_run_at asc, r.created_at asc
        limit 1
        for update skip locked
      )
      update registration_jobs r
      set status = 'running',
          step = 'claimed',
          attempt_count = r.attempt_count + 1,
          claimed_by = $4,
          lease_expires_at = now() + ($5::bigint * interval '1 millisecond'),
          started_at = now(),
          updated_at = now()
      from candidate
      where r.id = candidate.id
      returning r.id, r.claimed_by, r.attempt_count
    `, [id || null, CLAIMABLE_JOB_STATUSES, source, worker, normalizedLeaseMs, normalizedMode]);
    const claim = result.rows[0];
    if (!claim) return null;
    const task = await this.loadJob({ jobId: claim.id, includeSecret: true, includeEvents: false });
    return task?.status === 'running' && task.claimedBy === claim.claimed_by
      && task.attemptCount === Number(claim.attempt_count) ? task : null;
  }

  async appendEvent({ jobId, event = {}, guard = null } = {}) {
    const id = normalizeText(jobId);
    const type = normalizeText(event.type);
    if (!id || !type) {
      throw registrationError('REGISTRATION_EVENT_INVALID', 'registration event requires jobId and type');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await assertRegistrationLease(client, id, guard);
      const locked = await client.query(`
        select id, status, step, last_event_sequence
        from registration_jobs
        where id = $1
        for update
      `, [id]);
      const job = locked.rows[0];
      if (!job) throw registrationError('REGISTRATION_JOB_NOT_FOUND', `registration job not found: ${id}`);
      const sequence = Number(job.last_event_sequence || 0) + 1;
      const wasTerminal = TERMINAL_JOB_STATUSES.has(job.status);
      const nextStatus = wasTerminal
        ? job.status
        : jobStatusFromEvent(event, job.status);
      const step = wasTerminal ? job.step : (normalizeText(event.step) || job.step);
      const sanitized = redactEventValue({ ...event, sequence });
      const errorCode = normalizeText(sanitized.error?.code) || null;
      const errorMessage = normalizeText(sanitized.error?.message || sanitized.error).slice(0, 1000) || null;
      await client.query(`
        insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        id,
        sequence,
        type,
        normalizeText(event.status).toLowerCase() || null,
        normalizeText(event.step) || null,
        normalizeText(sanitized.message).slice(0, 500) || null,
        JSON.stringify(sanitized),
      ]);
      await client.query(`
        update registration_jobs
        set status = $2,
            step = $3,
            last_event_sequence = $4,
            error_code = case
              when $2 in ('failed', 'blocked') then coalesce($5, error_code)
              when $2 in ('completed', 'cancelled') then null
              else error_code
            end,
            error_message = case
              when $2 in ('failed', 'blocked') then coalesce($6, error_message)
              when $2 in ('completed', 'cancelled') then null
              else error_message
            end,
            completed_at = case when $2 = any($7::text[]) then now() else completed_at end,
            lease_expires_at = case when $2 = any($7::text[]) then null else lease_expires_at end,
            updated_at = now()
        where id = $1
      `, [id, nextStatus, step, sequence, errorCode, errorMessage, [...TERMINAL_JOB_STATUSES]]);
      await client.query('commit');
      return {
        ...sanitized,
        sequence,
        type,
        status: normalizeText(event.status).toLowerCase() || null,
        step: normalizeText(event.step) || null,
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease({ jobId, workerId, leaseMs = 300000, guard = null } = {}) {
    const id = normalizeText(jobId);
    const worker = normalizeText(workerId);
    const normalizedLeaseMs = Math.max(10000, Math.min(3600000, Math.trunc(Number(leaseMs) || 300000)));
    if (!id || !worker) return false;
    if (guard && (guard.jobId !== id || guard.workerId !== worker
      || !Number.isSafeInteger(guard.attemptCount) || guard.attemptCount < 1)) return false;
    const result = await this.pool.query(`
      update registration_jobs
      set lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
          updated_at = now()
      where id = $1
        and claimed_by = $2
        and status in ('running', 'waiting_mail')
        and ($4::integer is null or (attempt_count = $4 and lease_expires_at > clock_timestamp()))
      returning id
    `, [id, worker, normalizedLeaseMs, guard ? guard.attemptCount : null]);
    return result.rowCount === 1;
  }

  async releaseClaim({ jobId, workerId, attemptCount } = {}) {
    const result = await this.pool.query(`
      update registration_jobs
      set status = 'retry_waiting', step = 'retry_waiting', claimed_by = null,
          lease_expires_at = null, next_run_at = now(), updated_at = now()
      where id = $1 and claimed_by = $2 and attempt_count = $3
        and status in ('running', 'waiting_mail') and lease_expires_at > clock_timestamp()
      returning id
    `, [normalizeText(jobId), normalizeText(workerId), Number.isSafeInteger(attemptCount) ? attemptCount : -1]);
    return result.rowCount === 1;
  }

  async recoverExpiredJobs({
    reason = 'worker lease expired before completion',
  } = {}) {
    const client = await this.pool.connect();
    const recovered = [];
    try {
      await client.query('begin');
      const expired = await client.query(`
        select id, status, last_event_sequence
        from registration_jobs
        where status in ('running', 'waiting_mail')
          and lease_expires_at is not null
          and lease_expires_at <= now()
        order by lease_expires_at asc, created_at asc
        for update skip locked
      `);
      for (const job of expired.rows) {
        const sequence = Number(job.last_event_sequence || 0) + 1;
        const event = redactEventValue({
          sequence,
          type: 'registration.lease_expired',
          status: 'retry_waiting',
          step: 'retry_waiting',
          previousStatus: job.status,
          error: {
            code: 'REGISTRATION_WORKER_LEASE_EXPIRED',
            message: normalizeText(reason).slice(0, 1000),
          },
        });
        await client.query(`
          insert into registration_events(job_id, sequence, type, status, step, message, payload_json)
          values ($1, $2, 'registration.lease_expired', 'retry_waiting', 'retry_waiting', $3, $4::jsonb)
        `, [job.id, sequence, event.error.message, JSON.stringify(event)]);
        await client.query(`
          update registration_jobs
          set status = 'retry_waiting',
              step = 'retry_waiting',
              last_event_sequence = $2,
              claimed_by = null,
              lease_expires_at = null,
              next_run_at = now(),
              error_code = 'REGISTRATION_WORKER_LEASE_EXPIRED',
              error_message = $3,
              started_at = null,
              completed_at = null,
              updated_at = now()
          where id = $1
        `, [job.id, sequence, event.error.message]);
        recovered.push(job.id);
      }
      const retryable = await client.query(`
        select id
        from registration_jobs
        where status = 'retry_waiting'
          and next_run_at <= now()
        order by next_run_at asc, created_at asc
      `);
      for (const job of retryable.rows) {
        if (!recovered.includes(job.id)) recovered.push(job.id);
      }
      await client.query('commit');
      return { recovered: recovered.length, jobIds: recovered };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async assertLease({ jobId, guard } = {}) {
    return withRegistrationLease(this.pool, guard && { ...guard, jobId }, async () => true);
  }

  isActiveStatus(status) {
    return ACTIVE_JOB_STATUSES.has(normalizeText(status).toLowerCase());
  }

  #candidateFromRow(row) {
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      mailboxSource: row.mailbox_source,
      mailboxUrl: row.mailbox_url || null,
      hasMailbox: Boolean(row.mailbox_url || row.mailbox_source !== 'manual'),
      accountId: row.account_id || null,
      mailComStage: row.account_mail_com_stage || row.mail_com_stage || null,
      mailComReleaseStatus: row.account_mail_com_release_status || row.mail_com_release_status || null,
      mailComReleaseError: row.account_mail_com_release_error || row.mail_com_release_error || null,
      gcashSold: row.account_gcash_sold === null || row.account_gcash_sold === undefined
        ? Boolean(row.gcash_sold)
        : String(row.account_gcash_sold).trim().toLowerCase() === 'true',
      generatedTaskId: row.registration_job_id || row.latest_job_id || null,
      sourceOfTruth: 'postgresql',
      createdAt: row.created_at,
      updatedAt: row.account_updated_at || row.updated_at,
    };
  }

  #jobFromRow(row, { includeSecret = false } = {}) {
    const task = {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      mode: row.mode,
      mailboxSource: row.mailbox_source,
      mailboxId: row.mailbox_id,
      aliasId: row.alias_id,
      mainMailboxEmail: row.main_mailbox_email,
      mailboxUrl: row.mailbox_url,
      proxyPoolId: row.proxy_pool_id,
      browserEngine: row.browser_engine,
      entryBranch: row.branch,
      options: serializableObject(row.options_json),
      status: row.status,
      currentStep: row.step,
      attemptCount: Number(row.attempt_count || 0),
      lastEventSequence: Number(row.last_event_sequence || 0),
      claimedBy: row.claimed_by,
      leaseExpiresAt: row.lease_expires_at,
      error: row.error_code ? { code: row.error_code, message: row.error_message || '' } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
    if (includeSecret) task.registrationPassword = row.registration_password;
    return task;
  }
}

module.exports = {
  RegistrationStore,
  assertRegistrationLease,
  withRegistrationLease,
  deriveWorkflowStage,
  jobStatusFromEvent,
  redactEventValue,
};
