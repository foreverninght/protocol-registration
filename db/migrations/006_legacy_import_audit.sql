-- Record one-time legacy imports without making JSON a runtime dependency.

begin;

create table if not exists legacy_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_fingerprint text not null unique,
  source_files jsonb not null,
  summary jsonb not null,
  imported_at timestamptz not null default now(),
  constraint ck_legacy_import_fingerprint check (length(source_fingerprint) = 64),
  constraint ck_legacy_import_files_object check (jsonb_typeof(source_files) = 'object'),
  constraint ck_legacy_import_summary_object check (jsonb_typeof(summary) = 'object')
);

commit;
