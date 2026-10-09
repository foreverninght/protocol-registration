-- Move mutable service configuration, proxy state, phone-bind recovery state,
-- and structured evidence into PostgreSQL.

begin;

create table if not exists service_settings (
  key text primary key,
  value jsonb not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_service_settings_key_nonempty check (length(trim(key)) > 0),
  constraint ck_service_settings_value_object check (jsonb_typeof(value) = 'object'),
  constraint ck_service_settings_version check (version > 0)
);

create table if not exists proxy_pools (
  category text not null,
  id text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (category, id),
  constraint ck_proxy_pools_category check (category in ('main', 'eligibility', 'checkout', 'payment')),
  constraint ck_proxy_pools_id check (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  constraint ck_proxy_pools_name_nonempty check (length(trim(name)) > 0)
);

create table if not exists proxies (
  category text not null,
  pool_id text not null,
  id text not null,
  position bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (category, pool_id, id),
  foreign key (category, pool_id) references proxy_pools(category, id) on delete cascade,
  constraint ux_proxies_category_pool_position unique (category, pool_id, position),
  constraint ck_proxies_position check (position > 0),
  constraint ck_proxies_payload_object check (jsonb_typeof(payload) = 'object')
);

create index if not exists idx_proxies_pool_position
  on proxies(category, pool_id, position);

create table if not exists phone_bind_workflows (
  email text primary key,
  workflow_stage text not null,
  state_json jsonb not null,
  cookies_json jsonb,
  error_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_phone_bind_workflows_email check (length(trim(email)) > 3),
  constraint ck_phone_bind_workflows_stage check (
    workflow_stage in ('authorization_ready', 'otp_required', 'rt_pending', 'completed', 'failed')
  ),
  constraint ck_phone_bind_workflows_state_object check (jsonb_typeof(state_json) = 'object'),
  constraint ck_phone_bind_workflows_cookies_array check (
    cookies_json is null or jsonb_typeof(cookies_json) = 'array'
  ),
  constraint ck_phone_bind_workflows_error_object check (
    error_json is null or jsonb_typeof(error_json) = 'object'
  )
);

create table if not exists evidence_records (
  id bigserial primary key,
  task_id text not null,
  sequence integer not null,
  type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ux_evidence_records_task_sequence unique (task_id, sequence),
  constraint ck_evidence_records_task_nonempty check (length(trim(task_id)) > 0),
  constraint ck_evidence_records_sequence check (sequence > 0),
  constraint ck_evidence_records_type_nonempty check (length(trim(type)) > 0),
  constraint ck_evidence_records_payload_object check (jsonb_typeof(payload_json) = 'object')
);

create index if not exists idx_evidence_records_task_created
  on evidence_records(task_id, sequence);

create table if not exists evidence_artifacts (
  id bigserial primary key,
  task_id text not null,
  name text not null,
  relative_path text not null,
  sha256 text not null,
  bytes bigint not null,
  created_at timestamptz not null default now(),
  constraint ux_evidence_artifacts_task_name unique (task_id, name),
  constraint ck_evidence_artifacts_bytes check (bytes >= 0),
  constraint ck_evidence_artifacts_sha256 check (sha256 ~ '^[a-f0-9]{64}$')
);

commit;
