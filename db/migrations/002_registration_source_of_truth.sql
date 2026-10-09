-- Make PostgreSQL the complete source of truth for mailbox registration work.
-- Application cutover and legacy data import are intentionally separate steps.

begin;

create table if not exists mailbox_domains (
  mailbox_id uuid not null references mailboxes(id) on delete cascade,
  domain text not null,
  state text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (mailbox_id, domain),
  constraint ck_mailbox_domains_domain_nonempty check (length(trim(domain)) > 0),
  constraint ck_mailbox_domains_state check (state in ('active', 'hidden', 'deactivated'))
);

create table if not exists registration_pool_settings (
  singleton boolean primary key default true,
  enabled boolean not null default false,
  target_count integer not null default 1,
  concurrency integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint ck_registration_pool_settings_singleton check (singleton),
  constraint ck_registration_pool_target check (target_count between 1 and 100),
  constraint ck_registration_pool_concurrency check (concurrency between 1 and 30)
);

insert into registration_pool_settings(singleton)
values (true)
on conflict (singleton) do nothing;

alter table email_aliases
  drop constraint if exists ck_email_aliases_status;

alter table email_aliases
  add constraint ck_email_aliases_status check (
    status in (
      'reserved',
      'creating',
      'unused',
      'assigned',
      'registering',
      'registered',
      'cleanup_required',
      'abandoned'
    )
  );

alter table email_aliases
  drop constraint if exists ck_email_aliases_mailbox_ownership,
  add constraint ck_email_aliases_mailbox_ownership check (
    status not in ('reserved', 'creating', 'unused', 'assigned', 'registering', 'registered', 'cleanup_required')
    or mailbox_id is not null
  ) not valid,
  drop constraint if exists ck_email_aliases_account_ownership,
  add constraint ck_email_aliases_account_ownership check (
    status not in ('assigned', 'registering', 'registered') or account_id is not null
  ) not valid;

alter table registration_jobs
  add column if not exists mode text,
  add column if not exists mailbox_source text,
  add column if not exists mailbox_id uuid references mailboxes(id) on delete restrict,
  add column if not exists alias_id uuid references email_aliases(id) on delete restrict,
  add column if not exists claimed_by text,
  add column if not exists lease_expires_at timestamptz;

update registration_jobs r
set mode = coalesce(r.mode, 'register'),
    mailbox_source = coalesce(r.mailbox_source, a.source)
from accounts a
where a.id = r.account_id
  and (r.mode is null or r.mailbox_source is null);

update registration_jobs r
set alias_id = ea.id,
    mailbox_id = ea.mailbox_id
from email_aliases ea
where ea.account_id = r.account_id
  and r.mailbox_source = 'mail_com_split'
  and (r.alias_id is null or r.mailbox_id is null);

alter table registration_jobs
  alter column mode set default 'register',
  alter column mode set not null,
  alter column mailbox_source set default 'manual',
  alter column mailbox_source set not null;

alter table registration_jobs
  drop constraint if exists ck_registration_jobs_status,
  add constraint ck_registration_jobs_status check (
    status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting', 'completed', 'failed', 'cancelled', 'blocked')
  ),
  drop constraint if exists ck_registration_jobs_mode,
  add constraint ck_registration_jobs_mode check (mode = 'register'),
  drop constraint if exists ck_registration_jobs_mailbox_source,
  add constraint ck_registration_jobs_mailbox_source check (
    mailbox_source in ('mail_com_split', 'cloudflare_temp_email', 'icloud_sheex', 'share_page', 'manual', 'domain', 'ic')
  ),
  drop constraint if exists ck_registration_jobs_mail_com_ownership,
  add constraint ck_registration_jobs_mail_com_ownership check (
    mailbox_source <> 'mail_com_split' or (mailbox_id is not null and alias_id is not null)
  ) not valid;

create table if not exists registration_job_inputs (
  job_id uuid primary key references registration_jobs(id) on delete cascade,
  registration_password text not null,
  mailbox_url text,
  proxy_pool_id text,
  browser_engine text,
  options_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_registration_job_inputs_password_nonempty check (length(registration_password) > 0),
  constraint ck_registration_job_inputs_options_object check (jsonb_typeof(options_json) = 'object')
);

create table if not exists registration_events (
  id bigserial primary key,
  job_id uuid not null references registration_jobs(id) on delete cascade,
  sequence integer not null,
  type text not null,
  status text,
  step text,
  message text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ux_registration_events_job_sequence unique (job_id, sequence),
  constraint ck_registration_events_sequence check (sequence > 0),
  constraint ck_registration_events_type_nonempty check (length(trim(type)) > 0),
  constraint ck_registration_events_payload_object check (jsonb_typeof(payload_json) = 'object')
);

create table if not exists alias_refill_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued',
  target_count integer not null,
  initial_pool_count integer not null default 0,
  final_pool_count integer,
  preferred_mailbox_id uuid references mailboxes(id) on delete set null,
  options_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_alias_refill_runs_status check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  constraint ck_alias_refill_runs_target check (target_count between 1 and 100),
  constraint ck_alias_refill_runs_initial_count check (initial_pool_count >= 0),
  constraint ck_alias_refill_runs_final_count check (final_pool_count is null or final_pool_count >= 0),
  constraint ck_alias_refill_runs_options_object check (jsonb_typeof(options_json) = 'object')
);

create table if not exists alias_refill_items (
  id bigserial primary key,
  refill_run_id uuid not null references alias_refill_runs(id) on delete cascade,
  mailbox_id uuid not null references mailboxes(id) on delete restrict,
  alias_id uuid references email_aliases(id) on delete restrict,
  job_id uuid references registration_jobs(id) on delete restrict,
  position integer not null,
  status text not null default 'reserved',
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_alias_refill_items_run_position unique (refill_run_id, position),
  constraint ck_alias_refill_items_position check (position > 0),
  constraint ck_alias_refill_items_status check (
    status in ('reserved', 'creating', 'created', 'queued', 'failed', 'cleanup_required', 'abandoned')
  )
);

create index if not exists idx_mailbox_domains_state
  on mailbox_domains (state, domain);

create index if not exists idx_registration_jobs_mailbox_status
  on registration_jobs (mailbox_id, status, created_at);

create index if not exists idx_registration_jobs_alias_created
  on registration_jobs (alias_id, created_at desc);

create index if not exists idx_registration_jobs_active_lease
  on registration_jobs (lease_expires_at, created_at)
  where status in ('running', 'waiting_mail');

create unique index if not exists ux_registration_jobs_one_active_per_alias
  on registration_jobs (alias_id)
  where alias_id is not null
    and status in ('staged', 'queued', 'running', 'waiting_mail', 'retry_waiting');

create index if not exists idx_registration_events_job_created
  on registration_events (job_id, created_at, id);

create unique index if not exists ux_alias_refill_runs_one_active
  on alias_refill_runs ((true))
  where status in ('queued', 'running');

create index if not exists idx_alias_refill_items_run_status
  on alias_refill_items (refill_run_id, status, position);

commit;
