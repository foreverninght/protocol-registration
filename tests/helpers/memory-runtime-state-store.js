'use strict';

class MemoryRuntimeStateStore {
  constructor() {
    this.settings = new Map();
    this.pools = new Map();
    this.workflows = new Map();
    this.evidence = new Map();
  }

  async initializeSetting(key, value) {
    if (!this.settings.has(key)) this.settings.set(key, { value: structuredClone(value), version: 1 });
    return structuredClone(this.settings.get(key));
  }

  async updateSetting(key, value, { expectedVersion = null } = {}) {
    const current = this.settings.get(key);
    if (!current || (expectedVersion !== null && current.version !== expectedVersion)) {
      throw Object.assign(new Error('setting version conflict'), { code: 'SETTING_VERSION_CONFLICT' });
    }
    const next = { value: structuredClone(value), version: current.version + 1 };
    this.settings.set(key, next);
    return structuredClone(next);
  }

  async getSetting(key) {
    const value = this.settings.get(key);
    return value ? structuredClone(value) : null;
  }

  category(name) {
    if (!this.pools.has(name)) this.pools.set(name, new Map());
    return this.pools.get(name);
  }

  async listProxyPools(category) {
    return [...this.category(category).values()].map((pool) => structuredClone(pool));
  }

  async createProxyPool({ category, id, name, createdAt = null }) {
    const pool = { id, name, createdAt: createdAt || new Date().toISOString(), proxies: [] };
    this.category(category).set(id, pool);
    return structuredClone(pool);
  }

  async deleteProxyPool({ category, poolId }) {
    return this.category(category).delete(poolId) ? 1 : 0;
  }

  async replaceProxies({ category, poolId, proxies }) {
    const pool = this.category(category).get(poolId);
    if (!pool) throw Object.assign(new Error('proxy pool not found'), { code: 'PROXY_POOL_NOT_FOUND' });
    pool.proxies = structuredClone(proxies);
    return structuredClone(proxies);
  }

  async getPhoneBindWorkflow(email) {
    return structuredClone(this.workflows.get(String(email).toLowerCase()) || null);
  }

  async putPhoneBindWorkflow(workflow) {
    const value = { ...structuredClone(workflow), email: String(workflow.email).toLowerCase() };
    this.workflows.set(value.email, value);
    return structuredClone(value);
  }

  async appendEvidence({ taskId, type, payload = {}, createdAt = null }) {
    const events = this.evidence.get(taskId) || [];
    const event = { sequence: events.length + 1, at: createdAt || new Date().toISOString(), type, payload: structuredClone(payload) };
    events.push(event);
    this.evidence.set(taskId, events);
    return structuredClone(event);
  }

  async listEvidence({ taskId, afterSequence = 0, limit = 200 }) {
    return structuredClone((this.evidence.get(taskId) || []).filter((event) => event.sequence > afterSequence).slice(0, limit));
  }

  async recordEvidenceArtifact() {}
}

module.exports = { MemoryRuntimeStateStore };
