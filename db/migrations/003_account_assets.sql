-- Separate account credentials from public workflow snapshots.

begin;

alter table accounts
  add column if not exists login_email text,
  add column if not exists last_registration_job_id uuid references registration_jobs(id) on delete set null,
  add column if not exists version bigint not null default 0;

alter table accounts
  drop constraint if exists ck_accounts_login_email_nonempty,
  add constraint ck_accounts_login_email_nonempty check (
    login_email is null or length(trim(login_email)) > 3
  ),
  drop constraint if exists ck_accounts_version,
  add constraint ck_accounts_version check (version >= 0);

create table if not exists account_credentials (
  account_id uuid primary key references accounts(id) on delete cascade,
  password text,
  totp_secret text,
  totp_active_factor_id text,
  password_updated_at timestamptz,
  totp_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_account_credentials_password_nonempty check (password is null or length(password) > 0),
  constraint ck_account_credentials_totp_nonempty check (totp_secret is null or length(totp_secret) > 0)
);

create index if not exists idx_accounts_last_registration_job
  on accounts (last_registration_job_id)
  where last_registration_job_id is not null;

create index if not exists idx_accounts_source_lifecycle_updated
  on accounts (source, lifecycle_stage, updated_at desc);

commit;
