begin;

alter table registration_jobs
  drop constraint if exists ck_registration_jobs_mode,
  add constraint ck_registration_jobs_mode check (mode in ('register', 'credential_repair'));

create index if not exists idx_registration_jobs_credential_repair_queue
  on registration_jobs (next_run_at, created_at)
  where mode = 'credential_repair' and status in ('queued', 'retry_waiting');

commit;
