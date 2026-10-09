-- Store imported, not-yet-started registration addresses in PostgreSQL.

begin;

create table if not exists registration_candidates (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  mailbox_source text not null default 'manual',
  mailbox_url text,
  status text not null default 'ready',
  registration_job_id uuid unique references registration_jobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_registration_candidates_email_normalized check (
    email = lower(trim(email)) and length(email) > 3 and position('@' in email) > 1
  ),
  constraint ck_registration_candidates_mailbox_source check (
    mailbox_source in ('manual', 'share_page', 'icloud_sheex', 'ic')
  ),
  constraint ck_registration_candidates_status check (
    status in ('ready', 'started')
  ),
  constraint ck_registration_candidates_job_state check (
    (status = 'ready' and registration_job_id is null)
    or (status = 'started' and registration_job_id is not null)
  )
);

create index if not exists idx_registration_candidates_status_created
  on registration_candidates (status, created_at desc);

commit;
