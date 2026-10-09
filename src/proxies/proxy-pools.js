'use strict';

const crypto = require('node:crypto');

const POOL_NAMES = Object.freeze(['main', 'eligibility', 'checkout', 'payment']);
const LEGACY_POOL_ID = 'legacy';
const DEFAULT_PROXY_COOLDOWN_MS = 15 * 60 * 1000;
const POOL_LABELS = Object.freeze({
  main: '主流程',
  eligibility: '试用资格',
  checkout: 'Checkout',
  payment: '支付',
});

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function normalizePoolId(id) {
  const value = String(id || '').trim();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : '';
}

function normalizePoolName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function isDirectPoolId(poolId) {
  return !poolId || String(poolId) === '__direct__';
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function isProxyCoolingDown(proxy, now = Date.now()) {
  return timestampMs(proxy?.cooldownUntil) > now;
}

function parseProxyLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  if (raw.includes('@') || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsedUrl = new URL(urlLike);
      const host = parsedUrl.hostname;
      const port = Number(parsedUrl.port || ({ 'http:': 80, 'https:': 443 }[parsedUrl.protocol] || 0));
      if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
        const username = decodeURIComponent(parsedUrl.username || '');
        const password = decodeURIComponent(parsedUrl.password || '');
        const tail = `${username}:${password}`;
        const countryMatch = `${raw}:${tail}`.match(/-(?<country>[A-Z]{2})-\d+/);
        return {
          id: hashId(username || password ? `${host}:${port}:${username}:${password}` : `${host}:${port}`),
          raw,
          host,
          port,
          username,
          password,
          country: countryMatch?.groups?.country || null,
          importedAt: new Date().toISOString(),
          status: 'new',
        };
      }
    } catch {}
  }
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const username = parts[2] || '';
  const password = parts.slice(3).join(':') || '';
  const tail = `${username}:${password}`;
  const countryMatch = tail.match(/-(?<country>[A-Z]{2})-\d+/);
  return {
    id: hashId(raw),
    raw,
    host,
    port,
    username,
    password,
    country: countryMatch?.groups?.country || null,
    importedAt: new Date().toISOString(),
    status: 'new',
  };
}

function publicProxy(proxy) {
  const coolingDown = isProxyCoolingDown(proxy);
  return {
    id: proxy.id,
    poolId: proxy.poolId || LEGACY_POOL_ID,
    host: proxy.host,
    port: proxy.port,
    country: proxy.country,
    status: coolingDown ? 'cooldown' : 'new',
    usernamePresent: Boolean(proxy.username),
    passwordPresent: Boolean(proxy.password),
    lastCheckedAt: proxy.lastCheckedAt || null,
    latencyMs: proxy.latencyMs ?? null,
    cooldownUntil: coolingDown ? proxy.cooldownUntil : null,
    lastError: proxy.lastError || null,
  };
}

class ProxyPool {
  constructor({ category, poolId = LEGACY_POOL_ID }) {
    this.category = category;
    this.name = category.name;
    this.poolId = normalizePoolId(poolId) || LEGACY_POOL_ID;
  }

  _read() {
    return this.category._proxies(this.poolId).map((proxy) => ({ ...proxy, poolId: this.poolId }));
  }

  async _write(items) {
    const values = items.map(({ poolId, ...proxy }) => proxy);
    await this.category.store.replaceProxies({ category: this.name, poolId: this.poolId, proxies: values });
    this.category.cache.get(this.poolId).proxies = values;
  }

  async importText(text) {
    return this.category._withPoolLock(this.poolId, () => this._importText(text));
  }

  async _importText(text) {
    const existing = this._read();
    const byId = new Map(existing.map((item) => [item.id, item]));
    let imported = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
      const parsed = parseProxyLine(line);
      if (!parsed || byId.has(parsed.id)) continue;
      byId.set(parsed.id, parsed);
      imported += 1;
    }
    await this._write([...byId.values()]);
    return imported;
  }

  list() {
    return this._read().map(publicProxy);
  }

  listRaw() {
    return this._read();
  }

  pick({ country } = {}) {
    const proxies = this._read();
    const filtered = country ? proxies.filter((proxy) => proxy.country === country) : proxies;
    const usable = filtered.find((proxy) => !isProxyCoolingDown(proxy))
      || proxies.find((proxy) => !isProxyCoolingDown(proxy))
      || filtered[0]
      || proxies[0]
      || null;
    return usable;
  }

  async pickNext({ country, excludeIds = [] } = {}) {
    return this.category._withPoolLock(this.poolId, () => this._pickNext({ country, excludeIds }));
  }

  async _pickNext({ country, excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds);
    const proxies = this._read();
    const usable = proxies.filter((proxy) => !isProxyCoolingDown(proxy) && !excluded.has(proxy.id));
    const preferred = country ? usable.filter((proxy) => proxy.country === country) : usable;
    const roundPool = preferred.length ? preferred : usable;
    if (!roundPool.length) return null;

    let currentRound = Math.max(
      1,
      ...proxies.map((proxy) => Math.max(0, Math.trunc(Number(proxy.selectionRound) || 0))),
    );
    let candidates = roundPool.filter((proxy) => (
      Math.max(0, Math.trunc(Number(proxy.selectionRound) || 0)) < currentRound
    ));
    if (!candidates.length) {
      currentRound += 1;
      candidates = roundPool;
    }

    const selected = candidates[0];
    const index = proxies.findIndex((proxy) => proxy.id === selected.id);
    proxies[index] = {
      ...selected,
      selectionRound: currentRound,
      selectedAt: new Date().toISOString(),
      selectionCount: Math.max(0, Number(selected.selectionCount) || 0) + 1,
    };
    await this._write(proxies);
    return proxies[index];
  }

  async markBad(id, { reason, cooldownMs = DEFAULT_PROXY_COOLDOWN_MS } = {}) {
    return this.category._withPoolLock(this.poolId, () => this._markBad(id, { reason, cooldownMs }));
  }

  async _markBad(id, { reason, cooldownMs = DEFAULT_PROXY_COOLDOWN_MS } = {}) {
    const proxies = this._read();
    const index = proxies.findIndex((proxy) => proxy.id === id);
    if (index < 0) return null;
    const checkedAt = new Date();
    const until = new Date(checkedAt.getTime() + Math.max(1000, Number(cooldownMs) || DEFAULT_PROXY_COOLDOWN_MS));
    proxies[index] = {
      ...proxies[index],
      status: 'cooldown',
      lastError: String(reason || 'proxy failed'),
      lastCheckedAt: checkedAt.toISOString(),
      cooldownUntil: until.toISOString(),
      failureCount: Math.max(0, Number(proxies[index].failureCount) || 0) + 1,
    };
    await this._write(proxies);
    return publicProxy(proxies[index]);
  }

  async markChecked(id, { latencyMs = null, country = null } = {}) {
    return this.category._withPoolLock(this.poolId, () => this._markChecked(id, { latencyMs, country }));
  }

  async _markChecked(id, { latencyMs = null, country = null } = {}) {
    const proxies = this._read();
    const index = proxies.findIndex((proxy) => proxy.id === id);
    if (index < 0) return null;
    proxies[index] = {
      ...proxies[index],
      status: 'new',
      lastError: null,
      cooldownUntil: null,
      lastCheckedAt: new Date().toISOString(),
      latencyMs: latencyMs ?? proxies[index].latencyMs ?? null,
      country: country || proxies[index].country || null,
    };
    await this._write(proxies);
    return publicProxy(proxies[index]);
  }
}

class ProxyPoolCategory {
  constructor({ name, store }) {
    this.name = name;
    this.store = store;
    this.cache = new Map();
    this.poolLocks = new Map();
  }

  async _withPoolLock(poolId, operation) {
    const id = normalizePoolId(poolId) || LEGACY_POOL_ID;
    const previous = this.poolLocks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.poolLocks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.poolLocks.get(id) === current) this.poolLocks.delete(id);
    }
  }

  async initialize() {
    const pools = await this.store.listProxyPools(this.name);
    this.cache = new Map(pools.map((pool) => [pool.id, {
      id: pool.id,
      name: pool.name,
      createdAt: pool.createdAt,
      proxies: Array.isArray(pool.proxies) ? pool.proxies : [],
    }]));
    return this.listPools();
  }

  _readMeta() {
    return { pools: [...this.cache.values()].map(({ proxies, ...pool }) => pool) };
  }

  _proxies(poolId) {
    return this.cache.get(normalizePoolId(poolId) || LEGACY_POOL_ID)?.proxies || [];
  }

  _pool(poolId = LEGACY_POOL_ID) {
    const id = normalizePoolId(poolId) || LEGACY_POOL_ID;
    return new ProxyPool({ category: this, poolId: id });
  }

  async createPool({ name }) {
    const label = normalizePoolName(name);
    if (!label) throw new Error('proxy pool name is required');
    const meta = this._readMeta();
    const existing = meta.pools.find((pool) => pool.name.toLowerCase() === label.toLowerCase());
    if (existing) return { ...existing, count: this._pool(existing.id).list().length };
    let id = hashId(`${this.name}:${label}`).slice(0, 10);
    let counter = 2;
    while (meta.pools.some((pool) => pool.id === id)) {
      id = `${hashId(`${this.name}:${label}:${counter}`).slice(0, 8)}${counter}`;
      counter += 1;
    }
    const pool = await this.store.createProxyPool({ category: this.name, id, name: label });
    this.cache.set(id, { ...pool, proxies: [] });
    return { ...pool, count: 0 };
  }

  async deletePool(poolId) {
    const id = normalizePoolId(poolId);
    if (!id) return { deleted: 0, poolId: '' };
    const deleted = await this.store.deleteProxyPool({ category: this.name, poolId: id });
    this.cache.delete(id);
    return { deleted, poolId: id };
  }

  listPools() {
    const meta = this._readMeta();
    return meta.pools.map((pool) => {
      const proxies = this._pool(pool.id).list();
      return {
        id: pool.id,
        name: pool.name,
        category: this.name,
        categoryLabel: POOL_LABELS[this.name] || this.name,
        count: proxies.length,
        countries: [...new Set(proxies.map((proxy) => proxy.country).filter(Boolean))].sort(),
        badCount: proxies.filter((proxy) => isProxyCoolingDown(proxy)).length,
      };
    });
  }

  async importText(text, { poolId = LEGACY_POOL_ID } = {}) {
    return this._pool(poolId).importText(text);
  }

  list(poolId = LEGACY_POOL_ID) {
    return this._pool(poolId).list();
  }

  listRaw(poolId = LEGACY_POOL_ID) {
    return this._pool(poolId).listRaw();
  }

  pick(options = {}) {
    if (isDirectPoolId(options.poolId)) return null;
    return this._pool(options.poolId).pick(options);
  }

  async pickNext(options = {}) {
    if (isDirectPoolId(options.poolId)) return null;
    return this._pool(options.poolId).pickNext(options);
  }

  async markBad(id, { poolId, reason, cooldownMs } = {}) {
    if (poolId) return this._pool(poolId).markBad(id, { reason, cooldownMs });
    for (const pool of this.listPools()) {
      const result = await this._pool(pool.id).markBad(id, { reason, cooldownMs });
      if (result) return result;
    }
    return null;
  }

  async markChecked(id, { poolId, latencyMs = null, country = null } = {}) {
    if (poolId) return this._pool(poolId).markChecked(id, { latencyMs, country });
    for (const pool of this.listPools()) {
      const result = await this._pool(pool.id).markChecked(id, { latencyMs, country });
      if (result) return result;
    }
    return null;
  }
}

function createProxyPools({ store }) {
  const pools = {};
  for (const name of POOL_NAMES) {
    pools[name] = new ProxyPoolCategory({ name, store });
  }
  Object.defineProperty(pools, 'initialize', {
    enumerable: false,
    value: () => Promise.all(POOL_NAMES.map((name) => pools[name].initialize())),
  });
  return pools;
}

module.exports = {
  createProxyPools,
  ProxyPool,
  ProxyPoolCategory,
  parseProxyLine,
  publicProxy,
  isProxyCoolingDown,
  DEFAULT_PROXY_COOLDOWN_MS,
  POOL_NAMES,
  LEGACY_POOL_ID,
  POOL_LABELS,
};
