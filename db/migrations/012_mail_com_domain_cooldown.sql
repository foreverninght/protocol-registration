-- Serialize mail.com split-domain allocation and enforce the creation cooldown.
begin;

alter table mail_com_domains
  add column if not exists last_alias_created_at timestamptz;

create index if not exists idx_mail_com_domains_alias_cooldown
  on mail_com_domains(state, last_alias_created_at);

commit;
