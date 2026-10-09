-- Allow the IC Mail public inbox provider in registration records.
begin;

alter table registration_candidates
  drop constraint if exists ck_registration_candidates_mailbox_source;

alter table registration_candidates
  add constraint ck_registration_candidates_mailbox_source check (
    mailbox_source in ('mail_com_split', 'manual', 'share_page', 'icloud_sheex', 'icmail_public', 'ic')
  );

alter table registration_jobs
  drop constraint if exists ck_registration_jobs_mailbox_source;

alter table registration_jobs
  add constraint ck_registration_jobs_mailbox_source check (
    mailbox_source in (
      'mail_com_split', 'cloudflare_temp_email', 'icloud_sheex', 'icmail_public',
      'share_page', 'manual', 'domain', 'ic'
    )
  );

commit;
