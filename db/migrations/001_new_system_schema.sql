-- PostgreSQL new-system schema for signlist.
-- Clean main state source. Do not model legacy JSON fields here.

begin;

create extension if not exists pgcrypto;

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_status text not null default 'unknown',
  totp_status text not null default 'unknown',
  eligibility_status text not null default 'unknown',
  payment_method_status text not null default 'unknown',
  account_snapshot_json jsonb not null default '{}'::jsonb,
  lifecycle_stage text not null default 'created',
  plan_status text not null default 'unknown',
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_accounts_email unique (email),
  constraint ck_accounts_email_nonempty check (length(trim(email)) > 3),
  constraint ck_accounts_password_status check (password_status in ('unknown', 'has_password', 'no_password')),
  constraint ck_accounts_totp_status check (totp_status in ('unknown', 'enabled', 'missing', 'failed')),
  constraint ck_accounts_eligibility_status check (eligibility_status in ('unknown', 'checking', 'eligible', 'not_eligible', 'failed')),
  constraint ck_accounts_payment_method_status check (payment_method_status in ('unknown', 'queued', 'checking', 'available', 'unavailable', 'failed')),
  constraint ck_accounts_lifecycle_stage check (lifecycle_stage in ('created', 'registering', 'registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'plus', 'sold', 'abandoned')),
  constraint ck_accounts_plan_status check (plan_status in ('unknown', 'free', 'plus', 'expired')),
  constraint ck_accounts_source check (source in ('mail_com_split', 'domain', 'ic', 'manual'))
);

create table if not exists account_auth (
  account_id uuid primary key references accounts(id) on delete cascade,
  access_token text,
  access_token_expires_at timestamptz,
  refresh_token text,
  refresh_token_status text not null default 'missing',
  cookie_json jsonb not null default '[]'::jsonb,
  cookie_status text not null default 'missing',
  token_json jsonb not null default '{}'::jsonb,
  oauth_session_json jsonb not null default '{}'::jsonb,
  session_context_json jsonb not null default '{}'::jsonb,
  last_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_account_auth_refresh_token_status check (refresh_token_status in ('missing', 'stored', 'invalid', 'reused')),
  constraint ck_account_auth_cookie_status check (cookie_status in ('missing', 'available', 'expired', 'invalid'))
);

create table if not exists mailboxes (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  email text not null,
  password text,
  session_status text not null default 'closed',
  auto_alias_enabled boolean not null default false,
  last_opened_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_mailboxes_provider_email unique (provider, email),
  constraint ck_mailboxes_provider check (provider in ('mail_com', 'icloud', 'domain')),
  constraint ck_mailboxes_session_status check (session_status in ('closed', 'opening', 'open', 'failed', 'login_required'))
);

create table if not exists email_aliases (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid references mailboxes(id) on delete set null,
  email text not null,
  status text not null default 'unused',
  account_id uuid references accounts(id) on delete set null,
  assigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_email_aliases_email unique (email),
  constraint ck_email_aliases_status check (status in ('unused', 'assigned', 'registering', 'registered', 'abandoned'))
);

create table if not exists registration_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  status text not null default 'queued',
  step text not null default 'queued',
  branch text not null default 'freepp',
  next_run_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  last_event_sequence integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_registration_jobs_status check (status in ('queued', 'running', 'waiting_mail', 'retry_waiting', 'completed', 'failed', 'cancelled', 'blocked')),
  constraint ck_registration_jobs_attempt_count check (attempt_count >= 0)
);

create table if not exists gcash_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  status text not null default 'idle',
  extract_status text not null default 'not_started',
  monitor_status text not null default 'none',
  mk_job_id text,
  mk_account_id text,
  payment_url text,
  next_run_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_gcash_jobs_status check (status in ('idle', 'queued', 'retry_waiting', 'blocked', 'extracting', 'link_ready', 'waiting_scan', 'scanned', 'callback_processing', 'plus_confirmed', 'failed', 'expired', 'closed')),
  constraint ck_gcash_jobs_extract_status check (extract_status in ('not_started', 'queued', 'running', 'success', 'failed')),
  constraint ck_gcash_jobs_monitor_status check (monitor_status in ('none', 'active', 'expired', 'closed', 'lost')),
  constraint ck_gcash_jobs_attempt_count check (attempt_count >= 0)
);

create table if not exists gcash_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  gcash_job_id uuid not null references gcash_jobs(id) on delete cascade,
  status text not null,
  qr_url text,
  qr_image text,
  issued_at timestamptz,
  expires_at timestamptz,
  refresh_count integer not null default 0,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_gcash_qr_sessions_status check (status in ('waiting_scan', 'scanned', 'expired', 'refreshed', 'closed')),
  constraint ck_gcash_qr_sessions_refresh_count check (refresh_count >= 0)
);

create table if not exists events (
  id bigserial primary key,
  account_id uuid references accounts(id) on delete set null,
  job_type text not null,
  job_id uuid,
  type text not null,
  message text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ck_events_job_type check (job_type in ('registration', 'gcash', 'mailbox', 'auth', 'account', 'system'))
);

create index if not exists idx_accounts_stage_updated
  on accounts (lifecycle_stage, updated_at desc);

create index if not exists idx_accounts_plan_updated
  on accounts (plan_status, updated_at desc);

create index if not exists idx_accounts_password_stage
  on accounts (password_status, lifecycle_stage);

create index if not exists idx_accounts_eligibility_stage
  on accounts (eligibility_status, lifecycle_stage);

create index if not exists idx_accounts_payment_method_stage
  on accounts (payment_method_status, lifecycle_stage);

create index if not exists idx_account_auth_cookie_status
  on account_auth (cookie_status, updated_at desc);

create index if not exists idx_mailboxes_session_status
  on mailboxes (session_status, updated_at desc);

create index if not exists idx_email_aliases_status_created
  on email_aliases (status, created_at);

create index if not exists idx_email_aliases_mailbox_status
  on email_aliases (mailbox_id, status);

create index if not exists idx_registration_jobs_account_created
  on registration_jobs (account_id, created_at desc);

create index if not exists idx_registration_jobs_status_updated
  on registration_jobs (status, updated_at desc);

create index if not exists idx_registration_ready_queue
  on registration_jobs (next_run_at, created_at)
  where status in ('queued', 'retry_waiting');

create index if not exists idx_gcash_jobs_account_created
  on gcash_jobs (account_id, created_at desc);

create index if not exists idx_gcash_jobs_status_updated
  on gcash_jobs (status, updated_at desc);

create index if not exists idx_gcash_ready_queue
  on gcash_jobs (next_run_at, created_at)
  where status in ('queued', 'retry_waiting');

create unique index if not exists ux_gcash_jobs_one_active_per_account
  on gcash_jobs (account_id)
  where status not in ('plus_confirmed', 'failed', 'closed');

create index if not exists idx_gcash_qr_sessions_job_created
  on gcash_qr_sessions (gcash_job_id, created_at desc);

create index if not exists idx_gcash_qr_sessions_status_expires
  on gcash_qr_sessions (status, expires_at);

create index if not exists idx_events_account_time
  on events (account_id, created_at desc);

create index if not exists idx_events_job_time
  on events (job_type, job_id, created_at desc);

commit;
