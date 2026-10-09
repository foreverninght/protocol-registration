'use strict';

const { Pool } = require('pg');

const ACTIVE_BATCH_STATUSES = ['queued', 'running', 'cancelling'];

function normalizeText(value) {
  return String(value || '').trim();
}

function runtimeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function serializedBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw runtimeError('REFINING_BATCH_INVALID', 'refining batch must be an object');
  }
  const id = normalizeText(batch.id);
  const status = normalizeText(batch.status);
  if (!id || !status) throw runtimeError('REFINING_BATCH_INVALID', 'refining batch requires id and status');
  try {
    return { ...batch, id, status };
  } catch (error) {
    throw runtimeError('REFINING_BATCH_SERIALIZATION_FAILED', String(error?.message || error));
  }
}

class RefiningRuntimeStore {
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

  async listBatches() {
    const result = await this.pool.query(`
      select payload
      from refining_batches
      order by created_at desc, id desc
    `);
    return result.rows.map((row) => row.payload);
  }

  async activeBatches() {
    const result = await this.pool.query(`
      select payload
      from refining_batches
      where status = any($1::text[])
      order by created_at desc, id desc
    `, [ACTIVE_BATCH_STATUSES]);
    return result.rows.map((row) => row.payload);
  }

  async addBatch(batch) {
    const value = serializedBatch(batch);
    const remoteBatchId = normalizeText(value.remoteBatchId) || null;
    const provider = normalizeText(value.config?.provider);
    const createdAt = value.createdAt || new Date().toISOString();
    const updatedAt = value.updatedAt || createdAt;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`
        insert into refining_batches(id, remote_batch_id, status, provider, payload, created_at, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
      `, [value.id, remoteBatchId, value.status, provider, JSON.stringify(value), createdAt, updatedAt]);
      await client.query(`
        insert into service_runtime_state(key, value, updated_at)
        values ('refining.last_error', null, now())
        on conflict (key) do update
        set value = null, updated_at = excluded.updated_at
      `);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      if (error?.code === '23505') {
        throw runtimeError('REFINING_BATCH_CONFLICT', `refining batch already exists: ${value.id}`, {
          batchId: value.id,
          remoteBatchId,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateBatch(id, patch) {
    const key = normalizeText(id);
    if (!key || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw runtimeError('REFINING_BATCH_UPDATE_INVALID', 'refining batch update requires id and an object patch');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(`
        select id, payload
        from refining_batches
        where id = $1 or remote_batch_id = $1
        for update
      `, [key]);
      if (!result.rowCount) {
        await client.query('rollback');
        return null;
      }
      if (result.rowCount !== 1) {
        throw runtimeError('REFINING_BATCH_KEY_AMBIGUOUS', `refining batch key is ambiguous: ${key}`);
      }
      const next = serializedBatch({
        ...result.rows[0].payload,
        ...patch,
        id: result.rows[0].id,
        updatedAt: new Date().toISOString(),
      });
      await client.query(`
        update refining_batches
        set remote_batch_id = $2,
            status = $3,
            provider = $4,
            payload = $5::jsonb,
            updated_at = $6::timestamptz
        where id = $1
      `, [next.id, normalizeText(next.remoteBatchId) || null, next.status,
        normalizeText(next.config?.provider), JSON.stringify(next), next.updatedAt]);
      await client.query('commit');
      return next;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async setLastError(error) {
    const value = error ? {
      message: String(error.message || error),
      code: error.code || null,
      at: new Date().toISOString(),
    } : null;
    await this.pool.query(`
      insert into service_runtime_state(key, value, updated_at)
      values ('refining.last_error', $1::jsonb, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = excluded.updated_at
    `, [value === null ? null : JSON.stringify(value)]);
  }

  async getPublicState() {
    const [batches, state] = await Promise.all([
      this.listBatches(),
      this.pool.query("select value from service_runtime_state where key = 'refining.last_error'"),
    ]);
    return {
      batches: batches.slice(0, 20).map((batch) => {
        const { cdkLockKey, gcTacmonSiteProxyLine, gcTacmonWorkerProxyLine, gcTacmonWorkerProxyLines, ...config } = batch.config || {};
        return { ...batch, config };
      }),
      lastError: state.rows[0]?.value || null,
    };
  }
}

module.exports = { RefiningRuntimeStore };
