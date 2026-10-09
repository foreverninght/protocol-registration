-- Persist refining batch coordination state in PostgreSQL.

begin;

create table if not exists refining_batches (
  id text primary key,
  remote_batch_id text,
  status text not null,
  provider text not null default '',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_refining_batches_id_nonempty check (length(trim(id)) > 0),
  constraint ck_refining_batches_status_nonempty check (length(trim(status)) > 0),
  constraint ck_refining_batches_payload_object check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists ux_refining_batches_remote_batch_id
  on refining_batches (remote_batch_id)
  where remote_batch_id is not null and remote_batch_id <> '';

create index if not exists idx_refining_batches_active_updated
  on refining_batches (status, updated_at desc);

create table if not exists service_runtime_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now(),
  constraint ck_service_runtime_state_key_nonempty check (length(trim(key)) > 0)
);

commit;
