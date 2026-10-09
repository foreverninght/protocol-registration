-- Keep no-code and no-trial domain evidence independent.
begin;

alter table mail_com_domain_failures
  add column if not exists consecutive_no_trial_tasks integer not null default 0,
  add column if not exists no_trial_blacklisted boolean not null default false,
  add column if not exists last_no_trial_job_id uuid;

alter table mail_com_domain_failures
  drop constraint if exists ck_mail_com_domain_no_trial_blacklist_threshold;

alter table mail_com_domain_failures
  add constraint ck_mail_com_domain_no_trial_blacklist_threshold check (
    not no_trial_blacklisted or consecutive_no_trial_tasks >= 3
  );

create index if not exists idx_mail_com_domain_failures_no_trial_blacklisted
  on mail_com_domain_failures(domain)
  where no_trial_blacklisted;

commit;
