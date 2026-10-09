-- Global mail.com suffix catalog and OTP-only blacklist evidence.

begin;

create table if not exists mail_com_domains (
  domain text primary key,
  state text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_mail_com_domains_domain_nonempty check (length(trim(domain)) > 0),
  constraint ck_mail_com_domains_state check (state in ('active', 'hidden'))
);

create table if not exists mail_com_domain_failures (
  domain text primary key references mail_com_domains(domain) on delete cascade,
  consecutive_otp_timeout_tasks integer not null default 0,
  blacklisted boolean not null default false,
  last_counted_job_id uuid,
  last_failure_kind text,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint ck_mail_com_domain_failure_count check (consecutive_otp_timeout_tasks >= 0),
  constraint ck_mail_com_domain_blacklist_threshold check (
    not blacklisted or consecutive_otp_timeout_tasks >= 2
  )
);

create index if not exists idx_mail_com_domains_state
  on mail_com_domains(state, domain);

create index if not exists idx_mail_com_domain_failures_blacklisted
  on mail_com_domain_failures(domain)
  where blacklisted;

commit;
