'use strict';

const { Pool } = require('pg');

function normalizeText(value) {
  return String(value || '').trim();
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error(`${label} must be an object`);
    error.code = 'RUNTIME_STATE_OBJECT_REQUIRED';
    throw error;
  }
  return value;
}

function postgresJson(value) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'string' ? item.replace(/\u0000/gu, '\uFFFD') : item
  ));
}

class RuntimeStateStore {
  constructor({ connectionString = process.env.SIGNLIST_DATABASE_URL || '', pool = null } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || new Pool(connectionString
      ? { connectionString }
      : {
        database: process.env.SIGNLIST_DATABASE_NAME || 'signlist',
        user: process.env.SIGNLIST_DATABASE_USER || 'signlistclean',
        host: process.env.SIGNLIST_DATABASE_HOST || '/var/run/postgresql',
        max: Number(process.env.SIGNLIST_DATABASE_POOL_MAX || 5),
      });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async getSetting(key) {
    const normalized = normalizeText(key);
    if (!normalized) throw Object.assign(new Error('setting key is required'), { code: 'SETTING_KEY_REQUIRED' });
    const result = await this.pool.query(
      'select value, version, updated_at from service_settings where key = $1',
      [normalized],
    );
    const row = result.rows[0];
    return row ? { value: row.value, version: Number(row.version), updatedAt: row.updated_at } : null;
  }

  async initializeSetting(key, value) {
    const normalized = normalizeText(key);
    const payload = objectValue(value, 'setting value');
    await this.pool.query(`
      insert into service_settings(key, value)
      values ($1, $2::jsonb)
      on conflict (key) do nothing
    `, [normalized, postgresJson(payload)]);
    return this.getSetting(normalized);
  }

  async updateSetting(key, value, { expectedVersion = null } = {}) {
    const normalized = normalizeText(key);
    const payload = objectValue(value, 'setting value');
    const result = await this.pool.query(`
      update service_settings
      set value = $2::jsonb,
          version = version + 1,
          updated_at = now()
      where key = $1
        and ($3::bigint is null or version = $3)
      returning value, version, updated_at
    `, [normalized, postgresJson(payload), expectedVersion]);
    if (!result.rowCount) {
      const error = new Error(`setting changed concurrently or does not exist: ${normalized}`);
      error.code = 'SETTING_VERSION_CONFLICT';
      throw error;
    }
    const row = result.rows[0];
    return { value: row.value, version: Number(row.version), updatedAt: row.updated_at };
  }

  async listProxyPools(category) {
    const normalized = normalizeText(category);
    const result = await this.pool.query(`
      select pool.id, pool.name, pool.created_at,
             coalesce(jsonb_agg(proxy.payload order by proxy.position)
               filter (where proxy.id is not null), '[]'::jsonb) as proxies
      from proxy_pools pool
      left join proxies proxy
        on proxy.category = pool.category and proxy.pool_id = pool.id
      where pool.category = $1
      group by pool.category, pool.id, pool.name, pool.created_at
      order by pool.created_at, pool.id
    `, [normalized]);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      proxies: row.proxies,
    }));
  }

  async createProxyPool({ category, id, name, createdAt = null }) {
    const result = await this.pool.query(`
      insert into proxy_pools(category, id, name, created_at)
      values ($1, $2, $3, coalesce($4::timestamptz, now()))
      returning id, name, created_at
    `, [normalizeText(category), normalizeText(id), normalizeText(name), createdAt]);
    return { id: result.rows[0].id, name: result.rows[0].name, createdAt: result.rows[0].created_at };
  }

  async deleteProxyPool({ category, poolId }) {
    const result = await this.pool.query(
      'delete from proxy_pools where category = $1 and id = $2',
      [normalizeText(category), normalizeText(poolId)],
    );
    return result.rowCount;
  }

  async replaceProxies({ category, poolId, proxies }) {
    const values = Array.isArray(proxies) ? proxies : [];
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const pool = await client.query(`
        select id from proxy_pools
        where category = $1 and id = $2
        for update
      `, [normalizeText(category), normalizeText(poolId)]);
      if (!pool.rowCount) throw Object.assign(new Error('proxy pool not found'), { code: 'PROXY_POOL_NOT_FOUND' });
      await client.query('delete from proxies where category = $1 and pool_id = $2', [category, poolId]);
      if (values.length) {
        await client.query(`
          insert into proxies(category, pool_id, id, position, payload)
          select $1, $2, source.id, source.position, source.payload
          from jsonb_to_recordset($3::jsonb)
            as source(id text, position bigint, payload jsonb)
        `, [category, poolId, postgresJson(values.map((proxy, index) => ({
          id: normalizeText(proxy.id),
          position: index + 1,
          payload: { ...objectValue(proxy, 'proxy'), poolId: undefined },
        })))]);
      }
      await client.query('commit');
      return values;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getPhoneBindWorkflow(email) {
    const result = await this.pool.query(`
      select email, workflow_stage, state_json, cookies_json, error_json, updated_at
      from phone_bind_workflows where email = $1
    `, [normalizeText(email).toLowerCase()]);
    const row = result.rows[0];
    return row ? {
      email: row.email,
      workflowStage: row.workflow_stage,
      state: row.state_json,
      cookies: row.cookies_json,
      error: row.error_json,
      updatedAt: row.updated_at,
    } : null;
  }

  async putPhoneBindWorkflow({ email, workflowStage, state, cookies = null, error = null }) {
    const result = await this.pool.query(`
      insert into phone_bind_workflows(email, workflow_stage, state_json, cookies_json, error_json)
      values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
      on conflict (email) do update set
        workflow_stage = excluded.workflow_stage,
        state_json = excluded.state_json,
        cookies_json = excluded.cookies_json,
        error_json = excluded.error_json,
        updated_at = now()
      returning updated_at
    `, [normalizeText(email).toLowerCase(), workflowStage, postgresJson(objectValue(state, 'phone-bind state')),
      cookies === null ? null : postgresJson(cookies), error === null ? null : postgresJson(error)]);
    return { email: normalizeText(email).toLowerCase(), workflowStage, state, cookies, error, updatedAt: result.rows[0].updated_at };
  }

  async appendEvidence({ taskId, type, payload = {}, createdAt = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('signlist:evidence:' || $1))", [normalizeText(taskId)]);
      const result = await client.query(`
        insert into evidence_records(task_id, sequence, type, payload_json, created_at)
        select $1, coalesce(max(sequence), 0) + 1, $2, $3::jsonb,
               coalesce($4::timestamptz, now())
        from evidence_records where task_id = $1
        returning sequence, created_at
      `, [normalizeText(taskId), normalizeText(type), postgresJson(objectValue(payload, 'evidence payload')), createdAt]);
      await client.query('commit');
      return { sequence: Number(result.rows[0].sequence), at: result.rows[0].created_at, type, payload };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvidence({ taskId, afterSequence = 0, limit = 200 }) {
    const result = await this.pool.query(`
      select sequence, created_at, type, payload_json
      from evidence_records
      where task_id = $1 and sequence > $2
      order by sequence
      limit $3
    `, [normalizeText(taskId), Math.max(0, Number(afterSequence) || 0), Math.max(1, Math.min(1000, Number(limit) || 200))]);
    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      at: row.created_at,
      type: row.type,
      payload: row.payload_json,
    }));
  }

  async recordEvidenceArtifact({ taskId, name, relativePath, sha256, bytes }) {
    await this.pool.query(`
      insert into evidence_artifacts(task_id, name, relative_path, sha256, bytes)
      values ($1, $2, $3, $4, $5)
      on conflict (task_id, name) do update set
        relative_path = excluded.relative_path,
        sha256 = excluded.sha256,
        bytes = excluded.bytes,
        created_at = now()
    `, [normalizeText(taskId), normalizeText(name), normalizeText(relativePath), normalizeText(sha256), Number(bytes)]);
  }
}

module.exports = { RuntimeStateStore, postgresJson };
