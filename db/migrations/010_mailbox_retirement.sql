begin;

alter table mailboxes
  add column if not exists retired_at timestamptz,
  add column if not exists retirement_reason text;

create index if not exists idx_mailboxes_active_provider
  on mailboxes(provider, created_at)
  where retired_at is null;

commit;
