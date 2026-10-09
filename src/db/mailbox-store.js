'use strict';

const { Pool } = require('pg');

const MAILBOX_PROVIDERS = new Set(['mail_com', 'icloud', 'domain']);
const SESSION_STATUSES = new Set(['closed', 'opening', 'open', 'failed', 'login_required']);
const DOMAIN_STATES = new Set(['active', 'hidden', 'deactivated']);
const MAIL_COM_DOMAIN_STATES = new Set(['active', 'hidden']);
const DOMAIN_OTP_TIMEOUT_BLACKLIST_THRESHOLD = 2;
const DOMAIN_NO_TRIAL_BLACKLIST_THRESHOLD = 3;
const TERMINAL_REGISTRATION_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const REFILL_ITEM_STATUSES = new Set([
  'reserved',
  'creating',
  'created',
  'queued',
  'failed',
  'cleanup_required',
  'abandoned',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeDomain(value) {
  return normalizeText(value).replace(/^@+/, '').toLowerCase();
}

function serializableObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function storeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function publicMailbox(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const mailbox = {
    id: row.id,
    provider: row.provider,
    email: row.email,
    sessionStatus: row.session_status,
    autoAliasEnabled: Boolean(row.auto_alias_enabled),
    lastOpenedAt: row.last_opened_at,
    lastError: row.last_error || '',
    aliasCount: Number(row.alias_count || 0),
    domainCount: Number(row.domain_count || 0),
    activeDomainCount: Number(row.active_domain_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason || '',
  };
  if (includeSecret) mailbox.password = row.password || '';
  else mailbox.hasPassword = Boolean(row.password);
  return mailbox;
}

class MailboxStore {
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

  async upsertMailbox({ provider = 'mail_com', email, password = '' } = {}) {
    const normalizedProvider = normalizeText(provider).toLowerCase();
    const normalizedEmail = normalizeEmail(email);
    if (!MAILBOX_PROVIDERS.has(normalizedProvider) || !normalizedEmail) {
      throw storeError('MAILBOX_INPUT_INVALID', 'mailbox requires a supported provider and email');
    }
    const normalizedPassword = String(password ?? '');
    const result = await this.pool.query(`
      insert into mailboxes(provider, email, password, session_status)
      values ($1, $2, nullif($3, ''), 'closed')
      on conflict (provider, email) do update set
        password = case when $3 = '' then mailboxes.password else $3 end,
        session_status = case when mailboxes.retired_at is null then mailboxes.session_status else 'closed' end,
        last_error = case when mailboxes.retired_at is null then mailboxes.last_error else '' end,
        retired_at = null,
        retirement_reason = '',
        updated_at = now()
      returning *
    `, [normalizedProvider, normalizedEmail, normalizedPassword]);
    return publicMailbox(result.rows[0], { includeSecret: false });
  }

  async getMailbox({ mailboxId, includeSecret = false } = {}) {
    const id = normalizeText(mailboxId);
    if (!id) return null;
    const result = await this.pool.query(`
      select
        m.*,
        count(distinct ea.id) as alias_count,
        count(distinct md.domain) as domain_count,
        count(distinct md.domain) filter (where md.state = 'active') as active_domain_count
      from mailboxes m
      left join email_aliases ea on ea.mailbox_id = m.id and ea.status <> 'abandoned'
      left join mailbox_domains md on md.mailbox_id = m.id
      where m.id = $1
      group by m.id
    `, [id]);
    return publicMailbox(result.rows[0], { includeSecret });
  }

  async findMailbox({ provider = 'mail_com', email, includeSecret = false } = {}) {
    const normalizedProvider = normalizeText(provider).toLowerCase();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const result = await this.pool.query(`
      select
        m.*,
        count(distinct ea.id) as alias_count,
        count(distinct md.domain) as domain_count,
        count(distinct md.domain) filter (where md.state = 'active') as active_domain_count
      from mailboxes m
      left join email_aliases ea on ea.mailbox_id = m.id and ea.status <> 'abandoned'
      left join mailbox_domains md on md.mailbox_id = m.id
      where m.provider = $1 and m.email = $2 and m.retired_at is null
      group by m.id
    `, [normalizedProvider, normalizedEmail]);
    return publicMailbox(result.rows[0], { includeSecret });
  }

  async listMailboxes({ provider = '', includeSecret = false } = {}) {
    const normalizedProvider = normalizeText(provider).toLowerCase();
    const result = await this.pool.query(`
      select
        m.*,
        count(distinct ea.id) as alias_count,
        count(distinct md.domain) as domain_count,
        count(distinct md.domain) filter (where md.state = 'active') as active_domain_count
      from mailboxes m
      left join email_aliases ea on ea.mailbox_id = m.id and ea.status <> 'abandoned'
      left join mailbox_domains md on md.mailbox_id = m.id
      where ($1::text = '' or m.provider = $1)
        and m.retired_at is null
      group by m.id
      order by m.created_at asc
    `, [normalizedProvider]);
    return result.rows.map((row) => publicMailbox(row, { includeSecret }));
  }

  async deleteMailbox({ mailboxId } = {}) {
    const id = normalizeText(mailboxId);
    if (!id) throw storeError('MAILBOX_ID_REQUIRED', 'deleting a mailbox requires mailboxId');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const mailbox = await client.query('select id, email from mailboxes where id = $1 for update', [id]);
      if (!mailbox.rows[0]) throw storeError('MAILBOX_NOT_FOUND', `mailbox not found: ${id}`);
      const owned = await client.query(`
        select email, status
        from email_aliases
        where mailbox_id = $1
        order by email asc
      `, [id]);
      if (owned.rowCount > 0) {
        throw storeError(
          'MAILBOX_DELETE_HAS_ALIASES',
          'mailbox cannot be deleted while alias history references it',
          { aliases: owned.rows.map((row) => ({ email: row.email, status: row.status })) },
        );
      }
      const jobs = await client.query('select count(*)::int as count from registration_jobs where mailbox_id = $1', [id]);
      if (Number(jobs.rows[0]?.count || 0) > 0) {
        throw storeError('MAILBOX_DELETE_HAS_JOBS', 'mailbox cannot be deleted while registration jobs reference it');
      }
      const deleted = await client.query('delete from mailboxes where id = $1 returning id, email', [id]);
      await client.query('commit');
      return { deleted: 1, id: deleted.rows[0].id, email: deleted.rows[0].email };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async retireMailbox({ mailboxId, reason } = {}) {
    const id = normalizeText(mailboxId);
    const normalizedReason = normalizeText(reason).slice(0, 1000);
    if (!id || !normalizedReason) {
      throw storeError('MAILBOX_RETIREMENT_INPUT_INVALID', 'retiring a mailbox requires mailboxId and reason');
    }
    const result = await this.pool.query(`
      update mailboxes
      set retired_at = coalesce(retired_at, now()),
          retirement_reason = $2,
          session_status = 'closed',
          auto_alias_enabled = false,
          updated_at = now()
      where id = $1 and provider = 'mail_com'
      returning *
    `, [id, normalizedReason]);
    if (result.rowCount !== 1) throw storeError('MAILBOX_NOT_FOUND', `mail.com mailbox not found: ${id}`);
    return publicMailbox(result.rows[0]);
  }

  async recordSessionState({ mailboxId, status, lastError = '' } = {}) {
    const id = normalizeText(mailboxId);
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (!id || !SESSION_STATUSES.has(normalizedStatus)) {
      throw storeError('MAILBOX_SESSION_STATE_INVALID', 'mailbox session update requires mailboxId and valid status');
    }
    const result = await this.pool.query(`
      update mailboxes
      set session_status = $2,
          last_opened_at = case when $2 = 'open' then now() else last_opened_at end,
          last_error = nullif($3, ''),
          updated_at = now()
      where id = $1
      returning *
    `, [id, normalizedStatus, normalizeText(lastError).slice(0, 1000)]);
    if (result.rowCount !== 1) throw storeError('MAILBOX_NOT_FOUND', `mailbox not found: ${id}`);
    return publicMailbox(result.rows[0], { includeSecret: false });
  }

  async resetObservedOpenSessions(reason = 'service restarted; mailbox session must be opened again') {
    const result = await this.pool.query(`
      update mailboxes
      set session_status = 'closed',
          last_error = $1,
          updated_at = now()
      where session_status in ('opening', 'open')
    `, [normalizeText(reason).slice(0, 1000)]);
    return { reset: Number(result.rowCount || 0) };
  }

  async replaceDomains({ mailboxId, domains = [] } = {}) {
    const id = normalizeText(mailboxId);
    if (!id) throw storeError('MAILBOX_ID_REQUIRED', 'replacing mailbox domains requires mailboxId');
    const normalized = new Map();
    for (const entry of Array.isArray(domains) ? domains : []) {
      const domain = normalizeDomain(entry?.domain || entry);
      if (!domain) continue;
      const rawState = normalizeText(entry?.state || 'active').toLowerCase();
      const state = rawState === 'deactivated' ? 'deactivated' : (rawState === 'active' ? 'active' : 'hidden');
      normalized.set(domain, state);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const mailbox = await client.query('select id from mailboxes where id = $1 for update', [id]);
      if (mailbox.rowCount !== 1) throw storeError('MAILBOX_NOT_FOUND', `mailbox not found: ${id}`);
      await client.query('delete from mailbox_domains where mailbox_id = $1', [id]);
      if (normalized.size) {
        await client.query(`
          insert into mailbox_domains(mailbox_id, domain, state, last_synced_at)
          select $1, source.domain, source.state, now()
          from unnest($2::text[], $3::text[]) as source(domain, state)
        `, [id, [...normalized.keys()], [...normalized.values()]]);
      }
      await client.query('commit');
      return this.listDomains({ mailboxId: id });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listDomains({ mailboxId, states = [] } = {}) {
    const id = normalizeText(mailboxId);
    if (!id) return [];
    const normalizedStates = (Array.isArray(states) ? states : [states])
      .map((state) => normalizeText(state).toLowerCase())
      .filter((state) => DOMAIN_STATES.has(state));
    const result = await this.pool.query(`
      select domain, state, last_synced_at, created_at, updated_at
      from mailbox_domains
      where mailbox_id = $1
        and (cardinality($2::text[]) = 0 or state = any($2::text[]))
      order by case state when 'active' then 0 when 'hidden' then 1 else 2 end, domain asc
    `, [id, normalizedStates]);
    return result.rows.map((row) => ({
      domain: row.domain,
      state: row.state,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async replaceMailComDomainCatalog({ domains = [] } = {}) {
    const normalized = new Map();
    for (const entry of Array.isArray(domains) ? domains : []) {
      const domain = normalizeDomain(entry?.domain || entry);
      if (!domain) continue;
      const rawState = normalizeText(entry?.state || '').toLowerCase();
      normalized.set(domain, rawState === 'active' ? 'active' : 'hidden');
    }
    if (!normalized.size) {
      throw storeError('MAIL_COM_DOMAIN_CATALOG_EMPTY', 'an empty suffix response cannot replace the saved catalog');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('signlist:mail-com-domain-catalog'))");
      await client.query(`
        insert into mail_com_domains(domain, state, last_synced_at)
        select source.domain, source.state, now()
        from unnest($1::text[], $2::text[]) as source(domain, state)
        on conflict (domain) do update set
          state = excluded.state,
          last_synced_at = excluded.last_synced_at,
          updated_at = now()
      `, [[...normalized.keys()], [...normalized.values()]]);
      await client.query('commit');
      return this.listMailComDomainCatalog();
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listMailComDomainCatalog({ states = [], includeBlacklisted = true } = {}) {
    const normalizedStates = (Array.isArray(states) ? states : [states])
      .map((state) => normalizeText(state).toLowerCase())
      .filter((state) => MAIL_COM_DOMAIN_STATES.has(state));
    const result = await this.pool.query(`
      select domain.domain, domain.state, domain.last_synced_at,
             domain.created_at, domain.updated_at,
             coalesce(failure.consecutive_otp_timeout_tasks, 0) as consecutive_otp_timeout_tasks,
             coalesce(failure.blacklisted, false) as blacklisted,
             coalesce(failure.consecutive_no_trial_tasks, 0) as consecutive_no_trial_tasks,
             coalesce(failure.no_trial_blacklisted, false) as no_trial_blacklisted,
             failure.last_counted_job_id, failure.last_failure_kind,
             failure.last_error, failure.updated_at as failure_updated_at
      from mail_com_domains domain
      left join mail_com_domain_failures failure on failure.domain = domain.domain
      where (cardinality($1::text[]) = 0 or domain.state = any($1::text[]))
        and ($2::boolean or (
          coalesce(failure.blacklisted, false) = false
          and coalesce(failure.no_trial_blacklisted, false) = false
        ))
      order by case domain.state when 'active' then 0 else 1 end, domain.domain asc
    `, [normalizedStates, Boolean(includeBlacklisted)]);
    return result.rows.map((row) => ({
      domain: row.domain,
      state: row.state,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      consecutiveOtpTimeoutTasks: Number(row.consecutive_otp_timeout_tasks || 0),
      blacklisted: Boolean(row.blacklisted),
      noCodeBlacklisted: Boolean(row.blacklisted),
      consecutiveNoTrialTasks: Number(row.consecutive_no_trial_tasks || 0),
      noTrialBlacklisted: Boolean(row.no_trial_blacklisted),
      lastCountedJobId: row.last_counted_job_id,
      lastFailureKind: row.last_failure_kind || '',
      lastError: row.last_error || '',
      failureUpdatedAt: row.failure_updated_at,
    }));
  }

  async reserveMailComDomain({ domain = null, cooldownMinutes = 30 } = {}) {
    const requested = normalizeDomain(domain);
    const cooldown = Math.max(1, Math.trunc(Number(cooldownMinutes) || 30));
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(`
        with candidate as (
          select d.domain
          from mail_com_domains d
          left join mail_com_domain_failures f on f.domain = d.domain
          where d.state = 'hidden'
            and coalesce(f.blacklisted, false) = false
            and coalesce(f.no_trial_blacklisted, false) = false
            and (d.last_alias_created_at is null
                 or d.last_alias_created_at <= now() - make_interval(mins => $2))
            and ($1::text is null or d.domain = $1)
          order by random()
          limit 1
          for update of d skip locked
        )
        update mail_com_domains d
        set last_alias_created_at = now(), updated_at = now()
        from candidate
        where d.domain = candidate.domain
        returning d.domain, d.state, d.last_alias_created_at
      `, [requested || null, cooldown]);
      if (!result.rows[0]) {
        throw storeError(
          requested ? 'MAIL_COM_SPLIT_DOMAIN_COOLDOWN' : 'MAIL_COM_SPLIT_DOMAIN_UNAVAILABLE',
          requested
            ? `mail.com split domain is unavailable or cooling down: ${requested}`
            : 'no hidden mail.com split domain is available outside the cooldown',
          { domain: requested || null, cooldownMinutes: cooldown }
        );
      }
      await client.query('commit');
      return {
        domain: result.rows[0].domain,
        state: result.rows[0].state,
        lastAliasCreatedAt: result.rows[0].last_alias_created_at,
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMailComDomainRegistrationResult({ domain, jobId = '', ok = false, failureKind = '', error = null } = {}) {
    const normalizedDomain = normalizeDomain(domain);
    const normalizedJobId = normalizeText(jobId) || null;
    const normalizedKind = normalizeText(failureKind).toLowerCase();
    if (!normalizedDomain) throw storeError('MAIL_COM_DOMAIN_REQUIRED', 'recording a suffix result requires domain');
    if (!ok && !['otp_timeout', 'not_eligible'].includes(normalizedKind)) return this.getMailComDomainFailure({ domain: normalizedDomain });
    if (!ok && !normalizedJobId) {
      throw storeError('MAIL_COM_DOMAIN_JOB_REQUIRED', 'domain failure evidence requires a registration job id');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`
        insert into mail_com_domains(domain, state)
        values ($1, 'hidden')
        on conflict (domain) do nothing
      `, [normalizedDomain]);
      const result = ok
        ? await client.query(`
          insert into mail_com_domain_failures(
            domain, consecutive_otp_timeout_tasks, blacklisted,
            consecutive_no_trial_tasks, no_trial_blacklisted,
            last_counted_job_id, last_failure_kind, last_error
          ) values ($1, 0, false, 0, false, null, null, null)
          on conflict (domain) do update set
            consecutive_otp_timeout_tasks = 0,
            blacklisted = false,
            consecutive_no_trial_tasks = 0,
            -- A domain that has failed the no-trial threshold stays excluded;
            -- an eligible result only resets the streak for future evidence.
            no_trial_blacklisted = mail_com_domain_failures.no_trial_blacklisted,
            last_counted_job_id = null,
            last_failure_kind = null,
            last_error = null,
            updated_at = now()
          returning *
        `, [normalizedDomain])
        : normalizedKind === 'not_eligible'
        ? await client.query(`
          insert into mail_com_domain_failures(
            domain, consecutive_otp_timeout_tasks, blacklisted,
            consecutive_no_trial_tasks, no_trial_blacklisted,
            last_no_trial_job_id, last_failure_kind, last_error
          ) values ($1, 0, false, 1, false, $2, 'not_eligible', $3)
          on conflict (domain) do update set
            consecutive_otp_timeout_tasks = mail_com_domain_failures.consecutive_otp_timeout_tasks,
            blacklisted = mail_com_domain_failures.blacklisted,
            consecutive_no_trial_tasks = mail_com_domain_failures.consecutive_no_trial_tasks
              + case when mail_com_domain_failures.last_no_trial_job_id = $2 then 0 else 1 end,
            no_trial_blacklisted = mail_com_domain_failures.no_trial_blacklisted or
              (mail_com_domain_failures.consecutive_no_trial_tasks
                + case when mail_com_domain_failures.last_no_trial_job_id = $2 then 0 else 1 end) >= $4,
            last_no_trial_job_id = case
              when mail_com_domain_failures.last_no_trial_job_id = $2 then mail_com_domain_failures.last_no_trial_job_id
              else $2
            end,
            last_failure_kind = 'not_eligible',
            last_error = $3,
            updated_at = now()
          returning *
        `, [
          normalizedDomain,
          normalizedJobId,
          normalizeText(error?.message || error).slice(0, 1000) || null,
          DOMAIN_NO_TRIAL_BLACKLIST_THRESHOLD,
        ])
        : await client.query(`
          insert into mail_com_domain_failures(
            domain, consecutive_otp_timeout_tasks, blacklisted,
            consecutive_no_trial_tasks, no_trial_blacklisted,
            last_counted_job_id, last_failure_kind, last_error
          ) values ($1, 1, false, 0, false, $2, 'otp_timeout', $3)
          on conflict (domain) do update set
            consecutive_otp_timeout_tasks = mail_com_domain_failures.consecutive_otp_timeout_tasks
              + case when mail_com_domain_failures.last_counted_job_id = $2 then 0 else 1 end,
            blacklisted = mail_com_domain_failures.blacklisted or
              (mail_com_domain_failures.consecutive_otp_timeout_tasks
                + case when mail_com_domain_failures.last_counted_job_id = $2 then 0 else 1 end) >= $4,
            last_counted_job_id = case
              when mail_com_domain_failures.last_counted_job_id = $2 then mail_com_domain_failures.last_counted_job_id
              else $2
            end,
            last_failure_kind = 'otp_timeout',
            last_error = case
              when mail_com_domain_failures.last_counted_job_id = $2 then mail_com_domain_failures.last_error
              else $3
            end,
            updated_at = case
              when mail_com_domain_failures.last_counted_job_id = $2 then mail_com_domain_failures.updated_at
              else now()
            end
          returning *
        `, [
          normalizedDomain,
          normalizedJobId,
          normalizeText(error?.message || error).slice(0, 1000) || null,
          DOMAIN_OTP_TIMEOUT_BLACKLIST_THRESHOLD,
        ]);
      await client.query('commit');
      return this.#mailComDomainFailureView(result.rows[0]);
    } catch (error_) {
      await client.query('rollback').catch(() => {});
      throw error_;
    } finally {
      client.release();
    }
  }

  async getMailComDomainFailure({ domain } = {}) {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) return null;
    const result = await this.pool.query('select * from mail_com_domain_failures where domain = $1', [normalizedDomain]);
    return this.#mailComDomainFailureView(result.rows[0]);
  }

  #mailComDomainFailureView(row) {
    return row ? {
      domain: row.domain,
      consecutiveOtpTimeoutTasks: Number(row.consecutive_otp_timeout_tasks || 0),
      blacklisted: Boolean(row.blacklisted),
      noCodeBlacklisted: Boolean(row.blacklisted),
      consecutiveNoTrialTasks: Number(row.consecutive_no_trial_tasks || 0),
      noTrialBlacklisted: Boolean(row.no_trial_blacklisted),
      lastCountedJobId: row.last_counted_job_id,
      lastFailureKind: row.last_failure_kind || '',
      lastError: row.last_error || '',
      updatedAt: row.updated_at,
    } : null;
  }

  async getAlias({ aliasId = '', email = '' } = {}) {
    const id = normalizeText(aliasId);
    const normalizedEmail = normalizeEmail(email);
    if (!id && !normalizedEmail) return null;
    const result = await this.pool.query(`
      select ea.*, m.email as mailbox_email, m.provider as mailbox_provider
      from email_aliases ea
      join mailboxes m on m.id = ea.mailbox_id
      where ($1::uuid is not null and ea.id = $1)
         or ($1::uuid is null and ea.email = $2)
      limit 1
    `, [id || null, normalizedEmail]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      mailboxId: row.mailbox_id,
      mailboxEmail: row.mailbox_email,
      mailboxProvider: row.mailbox_provider,
      email: row.email,
      status: row.status,
      accountId: row.account_id,
      assignedAt: row.assigned_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async listAliases({ mailboxId = '', statuses = [] } = {}) {
    const id = normalizeText(mailboxId) || null;
    const normalizedStatuses = (Array.isArray(statuses) ? statuses : [statuses])
      .map((status) => normalizeText(status).toLowerCase())
      .filter(Boolean);
    const result = await this.pool.query(`
      select ea.*, m.email as mailbox_email, m.provider as mailbox_provider,
             latest_job.id as latest_job_id, latest_job.status as latest_job_status
      from email_aliases ea
      join mailboxes m on m.id = ea.mailbox_id
      left join lateral (
        select job.id, job.status
        from registration_jobs job
        where job.alias_id = ea.id
        order by job.created_at desc, job.id desc
        limit 1
      ) latest_job on true
      where ($1::uuid is null or ea.mailbox_id = $1)
        and (cardinality($2::text[]) = 0 or ea.status = any($2::text[]))
      order by ea.created_at asc, ea.id asc
    `, [id, normalizedStatuses]);
    return result.rows.map((row) => ({
      id: row.id,
      mailboxId: row.mailbox_id,
      mailboxEmail: row.mailbox_email,
      mailboxProvider: row.mailbox_provider,
      email: row.email,
      status: row.status,
      accountId: row.account_id,
      latestJobId: row.latest_job_id,
      latestJobStatus: row.latest_job_status,
      assignedAt: row.assigned_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async reserveAliasForCreation({ mailboxId, email } = {}) {
    const id = normalizeText(mailboxId);
    const normalizedEmail = normalizeEmail(email);
    if (!id || !normalizedEmail) {
      throw storeError('ALIAS_RESERVATION_INPUT_INVALID', 'alias creation requires mailboxId and email');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const mailbox = await client.query(`
        select id, email, retired_at
        from mailboxes
        where id = $1 and provider = 'mail_com'
        for update
      `, [id]);
      if (!mailbox.rows[0]) throw storeError('MAILBOX_NOT_FOUND', `mail.com mailbox not found: ${id}`);
      if (mailbox.rows[0].retired_at) throw storeError('MAILBOX_RETIRED', `mail.com mailbox is retired: ${id}`);
      if (mailbox.rows[0].email === normalizedEmail) {
        throw storeError('ALIAS_IS_MAIN_MAILBOX', 'main mailbox address cannot be reserved as an alias');
      }
      let reserved;
      try {
        reserved = await client.query(`
          insert into email_aliases(mailbox_id, email, status)
          values ($1, $2, 'creating')
          returning id
        `, [id, normalizedEmail]);
      } catch (error) {
        if (error?.code === '23505') {
          throw storeError('ALIAS_ALREADY_EXISTS', `alias already exists: ${normalizedEmail}`);
        }
        throw error;
      }
      await client.query('commit');
      return this.getAlias({ aliasId: reserved.rows[0].id });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileObservedAliases({ mailboxId, emails = [] } = {}) {
    const id = normalizeText(mailboxId);
    if (!id) throw storeError('MAILBOX_ID_REQUIRED', 'alias reconciliation requires mailboxId');
    const observed = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeEmail).filter(Boolean))];
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const mailbox = await client.query(`
        select id, email
        from mailboxes
        where id = $1 and provider = 'mail_com'
        for update
      `, [id]);
      if (!mailbox.rows[0]) throw storeError('MAILBOX_NOT_FOUND', `mail.com mailbox not found: ${id}`);
      const aliases = observed.filter((email) => email !== mailbox.rows[0].email);
      const conflicts = aliases.length ? await client.query(`
        select email, mailbox_id
        from email_aliases
        where email = any($1::text[]) and mailbox_id <> $2
        for update
      `, [aliases, id]) : { rows: [] };
      if (conflicts.rows.length) {
        throw storeError(
          'ALIAS_MAILBOX_CONFLICT',
          'observed aliases already belong to a different main mailbox',
          { aliases: conflicts.rows.map((row) => row.email) },
        );
      }
      const ownedAliases = await client.query(`
        select alias.id, alias.email, alias.status, latest_job.id as job_id, latest_job.status as job_status
        from email_aliases alias
        left join lateral (
          select job.id, job.status
          from registration_jobs job
          where job.alias_id = alias.id
          order by job.created_at desc, job.id desc
          limit 1
        ) latest_job on true
        where alias.mailbox_id = $1
          and alias.status in ('assigned', 'registering', 'registered')
        order by alias.email asc
      `, [id]);
      const observedSet = new Set(aliases);
      const unresolvedMissing = ownedAliases.rows.filter(
        (row) => !observedSet.has(row.email)
          && !TERMINAL_REGISTRATION_JOB_STATUSES.has(normalizeText(row.job_status).toLowerCase()),
      );
      if (unresolvedMissing.length) {
        throw storeError(
          'MAILBOX_ALIAS_REMOTE_MISSING',
          'remote mailbox is missing aliases that still own active registration jobs',
          { aliases: unresolvedMissing.map((row) => ({
            email: row.email,
            status: row.status,
            jobId: row.job_id,
            jobStatus: row.job_status,
          })) },
        );
      }
      const terminalOwnedIds = ownedAliases.rows
        .filter((row) => TERMINAL_REGISTRATION_JOB_STATUSES.has(normalizeText(row.job_status).toLowerCase()))
        .map((row) => row.id);
      if (terminalOwnedIds.length) {
        await client.query(`
          update email_aliases
          set status = 'cleanup_required', updated_at = now()
          where id = any($1::uuid[])
            and status in ('assigned', 'registering', 'registered')
        `, [terminalOwnedIds]);
      }
      for (const email of aliases) {
        await client.query(`
          insert into email_aliases(mailbox_id, email, status)
          values ($1, $2, 'unused')
          on conflict (email) do update set
            status = case
              when email_aliases.status = 'abandoned' and email_aliases.account_id is null then 'unused'
              when email_aliases.status = 'abandoned' then 'cleanup_required'
              else email_aliases.status
            end,
            updated_at = now()
          where email_aliases.mailbox_id = excluded.mailbox_id
        `, [id, email]);
      }
      await client.query(`
        update email_aliases
        set status = 'abandoned', updated_at = now()
        where mailbox_id = $1
          and status = 'unused'
          and not (email = any($2::text[]))
      `, [id, aliases]);
      await client.query('commit');
      return this.listAliases({ mailboxId: id });
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listEmailInventory({ mailboxSource = '' } = {}) {
    const source = normalizeText(mailboxSource).toLowerCase();
    const result = await this.pool.query(`
      select
        ea.id,
        ea.email,
        'mail_com_split'::text as mailbox_source,
        coalesce(a.id, job.account_id) as account_id,
        coalesce(a.lifecycle_stage, 'created') as lifecycle_stage,
        coalesce(a.plan_status, 'unknown') as plan_status,
        coalesce(a.password_status, 'unknown') as password_status,
        coalesce(a.totp_status, 'unknown') as totp_status,
        coalesce(a.eligibility_status, 'unknown') as eligibility_status,
        coalesce(a.payment_method_status, 'unknown') as payment_method_status,
        coalesce(a.account_snapshot_json, '{}'::jsonb) as account_snapshot_json,
        ea.id as alias_id,
        ea.status as alias_status,
        ea.mailbox_id,
        m.email as main_mailbox_email,
        job.id as job_id,
        job.status as job_status,
        job.step as job_step,
        job_input.mailbox_url,
        ea.created_at,
        greatest(ea.updated_at, coalesce(job.updated_at, ea.updated_at), coalesce(a.updated_at, ea.updated_at)) as updated_at
      from email_aliases ea
      join mailboxes m on m.id = ea.mailbox_id
      left join lateral (
        select id, account_id, status, step, created_at, updated_at
        from registration_jobs
        where alias_id = ea.id
        order by created_at desc, id desc
        limit 1
      ) job on true
      left join accounts a on a.id = coalesce(ea.account_id, job.account_id)
      left join registration_job_inputs job_input on job_input.job_id = job.id
      where ($1::text = '' or $1 = 'mail_com_split')
      order by updated_at desc, email asc
    `, [source]);
    return result.rows.map((row) => {
      const accountSnapshot = serializableObject(row.account_snapshot_json);
      const jobStatus = normalizeText(row.job_status).toLowerCase();
      const lifecycleStage = normalizeText(row.lifecycle_stage).toLowerCase() || 'created';
      const aliasStatus = normalizeText(row.alias_status).toLowerCase();
      const active = ['staged', 'queued', 'retry_waiting', 'running', 'waiting_mail'].includes(jobStatus);
      const unregisteredAlias = !row.job_id && ['reserved', 'creating', 'unused', 'assigned'].includes(aliasStatus);
      return {
        id: row.id,
        email: row.email,
        mailboxSource: row.mailbox_source,
        accountId: row.account_id,
        mailboxId: row.mailbox_id,
        aliasId: row.alias_id,
        aliasStatus,
        mainAccountId: row.mailbox_id,
        mainMailboxEmail: row.main_mailbox_email,
        generatedTaskId: row.job_id,
        mailboxUrl: row.mailbox_url || null,
        hasMailbox: Boolean(row.mailbox_url || row.mailbox_source),
        mailComStage: accountSnapshot.mailComStage || (active || unregisteredAlias ? 'unregistered' : ''),
        gcashSold: Boolean(accountSnapshot.gcashSold),
        status: lifecycleStage === 'registered' || jobStatus === 'completed' ? 'registered' : 'ready',
        lifecycleStage,
        planStatus: row.plan_status || 'unknown',
        passwordStatus: row.password_status || 'unknown',
        totpStatus: row.totp_status || 'unknown',
        eligibilityStatus: row.eligibility_status || 'unknown',
        paymentMethodStatus: row.payment_method_status || 'unknown',
        sourceOfTruth: 'postgresql',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async getPoolSettings() {
    const result = await this.pool.query(`
      select enabled, target_count, concurrency, updated_at
      from registration_pool_settings
      where singleton = true
    `);
    const row = result.rows[0];
    if (!row) throw storeError('REGISTRATION_POOL_SETTINGS_MISSING', 'registration pool settings row is missing');
    return {
      enabled: Boolean(row.enabled),
      targetCount: Number(row.target_count),
      concurrency: Number(row.concurrency),
      updatedAt: row.updated_at,
    };
  }

  async updatePoolSettings({ enabled, targetCount, concurrency } = {}) {
    const current = await this.getPoolSettings();
    const nextEnabled = enabled === undefined ? current.enabled : Boolean(enabled);
    const nextTarget = targetCount === undefined ? current.targetCount : Math.trunc(Number(targetCount));
    const nextConcurrency = concurrency === undefined ? current.concurrency : Math.trunc(Number(concurrency));
    if (nextTarget < 1 || nextTarget > 100 || nextConcurrency < 1 || nextConcurrency > 30) {
      throw storeError('REGISTRATION_POOL_SETTINGS_INVALID', 'registration pool target or concurrency is out of range');
    }
    const result = await this.pool.query(`
      update registration_pool_settings
      set enabled = $1,
          target_count = $2,
          concurrency = $3,
          updated_at = now()
      where singleton = true
      returning enabled, target_count, concurrency, updated_at
    `, [nextEnabled, nextTarget, nextConcurrency]);
    const row = result.rows[0];
    return {
      enabled: Boolean(row.enabled),
      targetCount: Number(row.target_count),
      concurrency: Number(row.concurrency),
      updatedAt: row.updated_at,
    };
  }

  async createRefillRun({ targetCount = null, preferredMailboxId = null, options = {} } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('signlist:mailbox-refill'))");
      const activeRun = await client.query(`
        select id, status
        from alias_refill_runs
        where status in ('queued', 'running')
        limit 1
      `);
      if (activeRun.rows[0]) {
        throw storeError('ALIAS_REFILL_ALREADY_ACTIVE', 'an alias refill run is already active', {
          refillRunId: activeRun.rows[0].id,
        });
      }
      const settings = await client.query(`
        select enabled, target_count
        from registration_pool_settings
        where singleton = true
        for update
      `);
      const configuredTarget = Number(settings.rows[0]?.target_count || 0);
      const requestedTarget = targetCount === null ? configuredTarget : Math.trunc(Number(targetCount));
      if (requestedTarget < 1 || requestedTarget > 100) {
        throw storeError('ALIAS_REFILL_TARGET_INVALID', 'alias refill target is out of range');
      }
      const poolCount = await client.query(`
        select count(*)::int as count
        from registration_jobs
        where mailbox_source = 'mail_com_split'
          and status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting')
      `);
      const created = await client.query(`
        insert into alias_refill_runs(
          target_count, initial_pool_count, preferred_mailbox_id, options_json
        )
        values ($1, $2, $3, $4::jsonb)
        returning *
      `, [
        requestedTarget,
        Number(poolCount.rows[0]?.count || 0),
        normalizeText(preferredMailboxId) || null,
        JSON.stringify(serializableObject(options)),
      ]);
      await client.query('commit');
      return this.#refillRunView(created.rows[0], []);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async startRefillRun({ refillRunId } = {}) {
    const id = normalizeText(refillRunId);
    const result = await this.pool.query(`
      update alias_refill_runs
      set status = 'running',
          started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = $1 and status = 'queued'
      returning *
    `, [id]);
    if (result.rowCount !== 1) throw storeError('ALIAS_REFILL_NOT_QUEUED', 'alias refill run is not queued');
    return this.#refillRunView(result.rows[0], []);
  }

  async reserveAliasForRefill({ refillRunId, mailboxId, email } = {}) {
    const runId = normalizeText(refillRunId);
    const normalizedMailboxId = normalizeText(mailboxId);
    const normalizedEmail = normalizeEmail(email);
    if (!runId || !normalizedMailboxId || !normalizedEmail) {
      throw storeError('ALIAS_RESERVATION_INPUT_INVALID', 'alias reservation requires refillRunId, mailboxId, and email');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const run = await client.query(`
        select id, status
        from alias_refill_runs
        where id = $1
        for update
      `, [runId]);
      if (run.rows[0]?.status !== 'running') {
        throw storeError('ALIAS_REFILL_NOT_RUNNING', 'alias refill run is not running');
      }
      const mailbox = await client.query(`
        select id, retired_at from mailboxes where id = $1 and provider = 'mail_com' for update
      `, [normalizedMailboxId]);
      if (mailbox.rowCount !== 1) throw storeError('MAILBOX_NOT_FOUND', `mail.com mailbox not found: ${normalizedMailboxId}`);
      if (mailbox.rows[0].retired_at) {
        throw storeError('MAILBOX_RETIRED', `mail.com mailbox is retired: ${normalizedMailboxId}`);
      }
      const alias = await client.query(`
        insert into email_aliases(mailbox_id, email, status)
        values ($1, $2, 'reserved')
        returning *
      `, [normalizedMailboxId, normalizedEmail]);
      const position = await client.query(`
        select coalesce(max(position), 0) + 1 as next_position
        from alias_refill_items
        where refill_run_id = $1
      `, [runId]);
      const item = await client.query(`
        insert into alias_refill_items(refill_run_id, mailbox_id, alias_id, position, status)
        values ($1, $2, $3, $4, 'reserved')
        returning *
      `, [runId, normalizedMailboxId, alias.rows[0].id, Number(position.rows[0].next_position)]);
      await client.query('commit');
      return {
        existing: false,
        alias: await this.getAlias({ aliasId: alias.rows[0].id }),
        item: this.#refillItemView(item.rows[0]),
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveExistingAliasForRefill({ refillRunId, mailboxId } = {}) {
    const runId = normalizeText(refillRunId);
    const normalizedMailboxId = normalizeText(mailboxId);
    if (!runId || !normalizedMailboxId) {
      throw storeError('ALIAS_RESERVATION_INPUT_INVALID', 'existing alias reservation requires refillRunId and mailboxId');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const run = await client.query(`
        select id, status
        from alias_refill_runs
        where id = $1
        for update
      `, [runId]);
      if (run.rows[0]?.status !== 'running') {
        throw storeError('ALIAS_REFILL_NOT_RUNNING', 'alias refill run is not running');
      }
      const alias = await client.query(`
        select ea.*
        from email_aliases ea
        join mailboxes mailbox on mailbox.id = ea.mailbox_id
        where ea.mailbox_id = $1
          and mailbox.retired_at is null
          and ea.status = 'unused'
          and not exists (
            select 1
            from registration_jobs job
            where job.alias_id = ea.id
              and job.status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting')
          )
        order by ea.created_at asc, ea.id asc
        limit 1
        for update of ea skip locked
      `, [normalizedMailboxId]);
      if (!alias.rows[0]) {
        await client.query('commit');
        return null;
      }
      const reserved = await client.query(`
        update email_aliases
        set status = 'reserved', updated_at = now()
        where id = $1 and status = 'unused'
        returning *
      `, [alias.rows[0].id]);
      if (reserved.rowCount !== 1) throw storeError('ALIAS_STATE_INVALID', 'existing alias could not be reserved');
      const position = await client.query(`
        select coalesce(max(position), 0) + 1 as next_position
        from alias_refill_items
        where refill_run_id = $1
      `, [runId]);
      const item = await client.query(`
        insert into alias_refill_items(refill_run_id, mailbox_id, alias_id, position, status)
        values ($1, $2, $3, $4, 'created')
        returning *
      `, [runId, normalizedMailboxId, reserved.rows[0].id, Number(position.rows[0].next_position)]);
      await client.query('commit');
      return {
        existing: true,
        alias: await this.getAlias({ aliasId: reserved.rows[0].id }),
        item: this.#refillItemView(item.rows[0]),
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async markAliasCreating({ aliasId, refillItemId } = {}) {
    return this.#transitionAliasAndItem({
      aliasId,
      refillItemId,
      fromAlias: ['reserved'],
      aliasStatus: 'creating',
      itemStatus: 'creating',
    });
  }

  async markAliasCreated({ aliasId, refillItemId } = {}) {
    return this.#transitionAliasAndItem({
      aliasId,
      refillItemId,
      fromAlias: ['reserved', 'creating'],
      aliasStatus: 'unused',
      itemStatus: 'created',
    });
  }

  async markAliasCreationFailed({ aliasId, refillItemId, error } = {}) {
    return this.#transitionAliasAndItem({
      aliasId,
      refillItemId,
      fromAlias: ['reserved', 'creating'],
      aliasStatus: 'abandoned',
      itemStatus: 'failed',
      error,
    });
  }

  async markAliasCleanupRequired({ aliasId, refillItemId, error } = {}) {
    return this.#transitionAliasAndItem({
      aliasId,
      refillItemId,
      fromAlias: ['creating', 'unused', 'assigned', 'registering', 'registered'],
      aliasStatus: 'cleanup_required',
      itemStatus: 'cleanup_required',
      error,
    });
  }

  async failRefillItem({ aliasId, refillItemId, error, cleanupRequired = false } = {}) {
    const normalizedAliasId = normalizeText(aliasId);
    const normalizedItemId = normalizeText(refillItemId);
    if (!normalizedAliasId || !normalizedItemId) {
      throw storeError('ALIAS_REFILL_FAILURE_INPUT_INVALID', 'refill failure requires aliasId and refillItemId');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const item = await client.query(`
        select id, alias_id, status
        from alias_refill_items
        where id = $1 and alias_id = $2
        for update
      `, [normalizedItemId, normalizedAliasId]);
      if (!item.rows[0] || !['reserved', 'creating', 'created'].includes(item.rows[0].status)) {
        throw storeError('ALIAS_REFILL_ITEM_STATE_INVALID', 'refill item is not in a recoverable state');
      }
      const nextAliasStatus = cleanupRequired ? 'cleanup_required' : 'unused';
      const alias = await client.query(`
        update email_aliases
        set status = $2, updated_at = now()
        where id = $1
          and status = any($3::text[])
        returning *
      `, [
        normalizedAliasId,
        nextAliasStatus,
        cleanupRequired ? ['reserved', 'creating', 'unused'] : ['reserved', 'unused'],
      ]);
      if (alias.rowCount !== 1) {
        throw storeError('ALIAS_STATE_INVALID', `alias cannot transition to ${nextAliasStatus}`);
      }
      const failed = await client.query(`
        update alias_refill_items
        set status = $2,
            error_code = $3,
            error_message = $4,
            updated_at = now()
        where id = $1
        returning *
      `, [
        normalizedItemId,
        cleanupRequired ? 'cleanup_required' : 'failed',
        normalizeText(error?.code) || null,
        normalizeText(error?.message || error).slice(0, 1000) || null,
      ]);
      await client.query('commit');
      return {
        alias: await this.getAlias({ aliasId: normalizedAliasId }),
        item: this.#refillItemView(failed.rows[0]),
      };
    } catch (error_) {
      await client.query('rollback').catch(() => {});
      throw error_;
    } finally {
      client.release();
    }
  }

  async markAliasAbandoned({ aliasId, refillItemId = null, error = null } = {}) {
    return this.#transitionAliasAndItem({
      aliasId,
      refillItemId,
      fromAlias: ['reserved', 'creating', 'unused', 'assigned', 'registering', 'registered', 'cleanup_required', 'abandoned'],
      aliasStatus: 'abandoned',
      itemStatus: 'abandoned',
      error,
    });
  }

  async #transitionAliasAndItem({ aliasId, refillItemId, fromAlias, aliasStatus, itemStatus, error = null }) {
    const normalizedAliasId = normalizeText(aliasId);
    const normalizedItemId = normalizeText(refillItemId) || null;
    if (!normalizedAliasId || !REFILL_ITEM_STATUSES.has(itemStatus)) {
      throw storeError('ALIAS_TRANSITION_INPUT_INVALID', 'alias transition input is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const alias = await client.query(`
        update email_aliases
        set status = $2, updated_at = now()
        where id = $1 and status = any($3::text[])
        returning *
      `, [normalizedAliasId, aliasStatus, fromAlias]);
      if (alias.rowCount !== 1) {
        throw storeError('ALIAS_STATE_INVALID', `alias cannot transition to ${aliasStatus}`);
      }
      let item = null;
      if (normalizedItemId) {
        const itemResult = await client.query(`
          update alias_refill_items
          set status = $3,
              error_code = $4,
              error_message = $5,
              updated_at = now()
          where id = $1 and alias_id = $2
          returning *
        `, [
          normalizedItemId,
          normalizedAliasId,
          itemStatus,
          normalizeText(error?.code) || null,
          normalizeText(error?.message || error).slice(0, 1000) || null,
        ]);
        if (itemResult.rowCount !== 1) throw storeError('ALIAS_REFILL_ITEM_MISMATCH', 'refill item does not own alias');
        item = this.#refillItemView(itemResult.rows[0]);
      }
      await client.query('commit');
      return { alias: await this.getAlias({ aliasId: normalizedAliasId }), item };
    } catch (error_) {
      await client.query('rollback').catch(() => {});
      throw error_;
    } finally {
      client.release();
    }
  }

  async linkRefillItemJob({ refillItemId, aliasId, jobId } = {}) {
    const itemId = normalizeText(refillItemId);
    const normalizedAliasId = normalizeText(aliasId);
    const normalizedJobId = normalizeText(jobId);
    const result = await this.pool.query(`
      update alias_refill_items item
      set job_id = job.id,
          status = 'queued',
          updated_at = now()
      from registration_jobs job
      where item.id = $1
        and item.alias_id = $2
        and job.id = $3
        and job.alias_id = item.alias_id
        and job.status = 'staged'
        and item.status = 'created'
      returning item.*
    `, [itemId, normalizedAliasId, normalizedJobId]);
    if (result.rowCount !== 1) throw storeError('ALIAS_REFILL_JOB_LINK_INVALID', 'staged job does not match refill item alias');
    return this.#refillItemView(result.rows[0]);
  }

  async queueRefillRunJobs({ refillRunId } = {}) {
    const id = normalizeText(refillRunId);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const run = await client.query('select id, status from alias_refill_runs where id = $1 for update', [id]);
      if (run.rows[0]?.status !== 'running') throw storeError('ALIAS_REFILL_NOT_RUNNING', 'alias refill run is not running');
      const queued = await client.query(`
        update registration_jobs job
        set status = 'queued', step = 'queued', next_run_at = now(), updated_at = now()
        from alias_refill_items item
        where item.refill_run_id = $1
          and item.job_id = job.id
          and item.status = 'queued'
          and job.status = 'staged'
        returning job.id
      `, [id]);
      await client.query('commit');
      return { refillRunId: id, queued: Number(queued.rowCount || 0) };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finishRefillRun({ refillRunId, error = null } = {}) {
    const id = normalizeText(refillRunId);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const runResult = await client.query('select * from alias_refill_runs where id = $1 for update', [id]);
      const run = runResult.rows[0];
      if (!run || run.status !== 'running') throw storeError('ALIAS_REFILL_NOT_RUNNING', 'alias refill run is not running');
      const poolCount = await client.query(`
        select count(*)::int as count
        from registration_jobs
        where mailbox_source = 'mail_com_split'
          and status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting')
      `);
      const itemCounts = await client.query(`
        select
          count(*)::int as total,
          count(*) filter (where status = 'queued')::int as queued,
          count(*) filter (where status in ('failed', 'cleanup_required', 'abandoned'))::int as failed
        from alias_refill_items
        where refill_run_id = $1
      `, [id]);
      const finalCount = Number(poolCount.rows[0]?.count || 0);
      const counts = itemCounts.rows[0] || {};
      const status = finalCount >= Number(run.target_count)
        ? 'completed'
        : Number(counts.queued || 0) > 0
          ? 'partial'
          : 'failed';
      const finished = await client.query(`
        update alias_refill_runs
        set status = $2,
            final_pool_count = $3,
            error_code = $4,
            error_message = $5,
            completed_at = now(),
            updated_at = now()
        where id = $1
        returning *
      `, [
        id,
        status,
        finalCount,
        normalizeText(error?.code) || null,
        normalizeText(error?.message || error).slice(0, 1000) || null,
      ]);
      const items = await client.query(`
        select * from alias_refill_items where refill_run_id = $1 order by position asc
      `, [id]);
      await client.query('commit');
      return this.#refillRunView(finished.rows[0], items.rows);
    } catch (error_) {
      await client.query('rollback').catch(() => {});
      throw error_;
    } finally {
      client.release();
    }
  }

  async getRefillRun({ refillRunId } = {}) {
    const id = normalizeText(refillRunId);
    if (!id) return null;
    const run = await this.pool.query('select * from alias_refill_runs where id = $1', [id]);
    if (!run.rows[0]) return null;
    const items = await this.pool.query(`
      select * from alias_refill_items where refill_run_id = $1 order by position asc
    `, [id]);
    return this.#refillRunView(run.rows[0], items.rows);
  }

  #refillRunView(row, itemRows) {
    return {
      id: row.id,
      status: row.status,
      targetCount: Number(row.target_count),
      initialPoolCount: Number(row.initial_pool_count || 0),
      finalPoolCount: row.final_pool_count === null ? null : Number(row.final_pool_count),
      preferredMailboxId: row.preferred_mailbox_id,
      options: serializableObject(row.options_json),
      error: row.error_code ? { code: row.error_code, message: row.error_message || '' } : null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: (itemRows || []).map((item) => this.#refillItemView(item)),
    };
  }

  #refillItemView(row) {
    return {
      id: row.id,
      refillRunId: row.refill_run_id,
      mailboxId: row.mailbox_id,
      aliasId: row.alias_id,
      jobId: row.job_id,
      position: Number(row.position),
      status: row.status,
      error: row.error_code ? { code: row.error_code, message: row.error_message || '' } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { MailboxStore };
