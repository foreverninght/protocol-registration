-- Restore mailbox business source independently from temporary alias ownership.

begin;

alter table registration_candidates
  add column if not exists mail_com_stage text,
  add column if not exists mail_com_release_status text,
  add column if not exists mail_com_release_error text,
  add column if not exists gcash_sold boolean not null default false;

alter table registration_candidates
  drop constraint if exists ck_registration_candidates_mailbox_source,
  add constraint ck_registration_candidates_mailbox_source check (
    mailbox_source in ('mail_com_split', 'manual', 'share_page', 'icloud_sheex', 'ic')
  );

alter table registration_jobs
  drop constraint if exists ck_registration_jobs_mail_com_ownership,
  add constraint ck_registration_jobs_mail_com_ownership check (
    mailbox_source <> 'mail_com_split'
    or (mailbox_id is not null and alias_id is not null)
    or status in ('completed', 'failed', 'cancelled', 'blocked')
  );

update registration_jobs job
set mailbox_source = 'mail_com_split',
    updated_at = greatest(job.updated_at, input.updated_at)
from registration_job_inputs input
where input.job_id = job.id
  and input.options_json->>'originalMailboxSource' = 'mail_com_split'
  and job.status in ('completed', 'failed', 'cancelled', 'blocked')
  and job.mailbox_source <> 'mail_com_split';

update accounts account
set source = 'mail_com_split',
    updated_at = greatest(account.updated_at, evidence.updated_at)
from (
  select job.account_id, max(input.updated_at) as updated_at
  from registration_jobs job
  join registration_job_inputs input on input.job_id = job.id
  where input.options_json->>'originalMailboxSource' = 'mail_com_split'
  group by job.account_id
) evidence
where evidence.account_id = account.id
  and account.source <> 'mail_com_split';

commit;
