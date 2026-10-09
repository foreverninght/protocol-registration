'use strict';

const { runUniversalPaymentMethodProbe } = require('./universal-probe');

function proxyLine(proxy) {
  if (!proxy || typeof proxy !== 'object') return '';
  if (proxy.raw) return String(proxy.raw).trim();
  const host = String(proxy.host || '').trim();
  const port = String(proxy.port || '').trim();
  if (!host || !port) return '';
  const username = String(proxy.username || '');
  const password = String(proxy.password || '');
  return [host, port, username, password].join(':');
}

function proxyLines(proxies, limit = 500) {
  return (Array.isArray(proxies) ? proxies : []).map(proxyLine).filter(Boolean).slice(0, limit);
}

function shortError(error, limit = 1000) {
  return String(error?.message || error || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function hasEligibleTrial(account) {
  const status = String(account?.trialEligibility?.status || account?.eligibilityStatus || '').toLowerCase();
  return ['eligible', 'trial_eligible', 'available'].includes(status) || account?.trialEligible === true;
}

function checkoutTypeFromPayload(payload = {}) {
  return String(payload.checkout_type || payload.checkoutType || payload.session_type || payload.sessionType || '').trim();
}

class PaymentMethodProbeCoordinator {
  constructor({
    accountStore,
    proxyPools,
    settings,
    refiningSettings = null,
    probeRunner = runUniversalPaymentMethodProbe,
    getConcurrency = () => 1,
  } = {}) {
    if (typeof probeRunner !== 'function') throw new Error('payment method probe runner is required');
    if (!accountStore) throw new TypeError('accountStore is required');
    this.accountStore = accountStore;
    this.proxyPools = proxyPools;
    this.settings = settings;
    this.refiningSettings = refiningSettings;
    this.probeRunner = probeRunner;
    this.getConcurrency = getConcurrency;
    this.queue = [];
    this.queued = new Set();
    this.queuedAt = new Map();
    this.active = new Set();
  }

  snapshot() {
    return {
      queued: this.queue.map((email, index) => ({
        email,
        position: index + 1,
        queuedAt: this.queuedAt.get(email) || null,
      })),
      active: [...this.active],
      oldestWaitingMs: this.queue.length
        ? Math.max(0, Date.now() - Math.min(...this.queue.map((email) => this.queuedAt.get(email) || Date.now())))
        : 0,
      concurrency: Math.max(0, Math.min(30, Math.trunc(Number(this.getConcurrency?.()) || 0))),
      settings: this.settings.getPublicConfig(),
    };
  }

  async schedule(email, { force = false, reason = 'registration_completed' } = {}) {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return { scheduled: false, reason: 'email_missing' };
    const config = this.settings.getSecretConfig();
    if (!config.enabled) return { scheduled: false, reason: 'disabled' };
    if (!force && !config.autoRunAfterRegistration) return { scheduled: false, reason: 'auto_disabled' };
    if (this.active.has(key) || this.queued.has(key)) return { scheduled: false, reason: 'already_queued' };
    this.queued.add(key);
    let scheduled = false;
    try {
      const account = await this.accountStore.getByEmail(key, { includeSecret: true });
      if (!account) return { scheduled: false, reason: 'account_not_found' };
      if (!String(account?.tokens?.accessToken || '').trim()) return { scheduled: false, reason: 'access_token_missing' };
      if (!hasEligibleTrial(account)) return { scheduled: false, reason: 'not_eligible' };
      const existingStatus = String(account?.paymentCapabilities?.status || '').toLowerCase();
      if (!force && ['queued', 'checking'].includes(existingStatus)) return { scheduled: false, reason: 'already_running' };
      if (!force && existingStatus === 'done') return { scheduled: false, reason: 'already_done' };
      const now = new Date().toISOString();
      await this.accountStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
        paymentCapabilities: {
          ...(account.paymentCapabilities || {}),
          status: 'queued',
          reason,
          error: null,
          queuedAt: now,
          updatedAt: now,
        },
      } });
      this.queue.push(key);
      this.queuedAt.set(key, Date.now());
      scheduled = true;
      this.drain();
      return { scheduled: true, email: key };
    } finally {
      if (!scheduled) {
        this.queued.delete(key);
        this.queuedAt.delete(key);
      }
    }
  }

  drain() {
    const configuredConcurrency = Math.trunc(Number(this.getConcurrency?.()) || 0);
    const concurrency = Math.max(0, Math.min(30, configuredConcurrency || (this.queue.length ? 1 : 0)));
    while (this.active.size < concurrency && this.queue.length) {
      const email = this.queue.shift();
      this.queued.delete(email);
      this.queuedAt.delete(email);
      this.active.add(email);
      this.run(email).catch((error) => {
        console.error('payment method probe run failed', email, error);
      }).finally(() => {
        this.active.delete(email);
        this.drain();
      });
    }
  }

  async proxyPayload(config, limit = 3) {
    const poolId = String(config.proxyPoolId || config.entryProxyPoolId || '').trim();
    if (!poolId) throw new Error('请先配置支付方式检测代理池');
    const leased = [];
    const excludeIds = [];
    for (let attempt = 0; attempt < Math.max(1, Number(limit) || 3); attempt += 1) {
      const proxy = await this.proxyPools.payment.pickNext({ poolId, excludeIds });
      if (!proxy) break;
      leased.push(proxy);
      excludeIds.push(proxy.id);
    }
    const proxies = proxyLines(leased);
    if (!proxies.length) throw new Error('支付方式检测代理池没有可用代理');
    return {
      proxies,
      poolId,
      leased,
    };
  }

  async recordProxyOutcome(proxies, payload = null, error = null) {
    const leased = Array.isArray(proxies?.leased) ? proxies.leased : [];
    if (!leased.length) return;
    const successfulIndex = Math.max(0, Number(payload?.proxy_index || 0) - 1);
    if (payload?.ok && leased[successfulIndex]) {
      for (let index = 0; index < successfulIndex; index += 1) {
        await this.proxyPools.payment.markBad(leased[index].id, {
          poolId: proxies.poolId,
          reason: 'payment method probe failed before a later proxy succeeded',
        });
      }
      await this.proxyPools.payment.markChecked(leased[successfulIndex].id, {
        poolId: proxies.poolId,
        country: payload?.proxy_geo?.country || null,
      });
      return;
    }
    if (error?.retryableProxy === true) {
      await Promise.all(leased.map((proxy) => this.proxyPools.payment.markBad(proxy.id, {
        poolId: proxies.poolId,
        reason: shortError(error),
      })));
    }
  }

  async recoverStaleStatuses() {
    const accounts = await this.accountStore.list({ limit: null });
    let recovered = 0;
    for (const account of accounts) {
      const probe = account?.paymentCapabilities || {};
      if (!['queued', 'checking'].includes(String(probe.status || '').toLowerCase())) continue;
      if (this.queued.has(account.email) || this.active.has(account.email)) continue;
      const now = new Date().toISOString();
      try {
        await this.accountStore.updateByEmail({ email: account.email, expectedVersion: account.version, patch: {
          paymentCapabilities: {
            ...probe,
            status: 'failed',
            error: '支付方式检测进程已重启，旧任务未完成，请重新检测',
            checkedAt: now,
            updatedAt: now,
          },
        } });
        recovered += 1;
      } catch (error) {
        if (error?.code !== 'ACCOUNT_VERSION_CONFLICT') throw error;
      }
    }
    return { recovered };
  }

  async run(email) {
    const startedAt = new Date().toISOString();
    const startingAccount = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!startingAccount) return;
    const startingAccessToken = String(startingAccount?.tokens?.accessToken || '').trim();
    if (!startingAccessToken) return;
    await this.accountStore.updateByEmail({ email, expectedVersion: startingAccount.version, patch: {
      paymentCapabilities: {
        ...(startingAccount.paymentCapabilities || {}),
        status: 'checking',
        error: null,
        startedAt,
        updatedAt: startedAt,
      },
    } });
    let config = null;
    let proxies = null;
    try {
      config = this.settings.getSecretConfig();
      const account = await this.accountStore.getByEmail(email, { includeSecret: true });
      const accessToken = String(account?.tokens?.accessToken || '').trim();
      if (!account || !accessToken) return;
      proxies = await this.proxyPayload(config);
      const maxProxyAttempts = Math.max(1, Math.min(
        proxies.proxies.length,
        3,
        10,
      ));
      const payload = await this.probeRunner({
        accessToken,
        proxyRef: proxies.proxies.join('\n'),
        maxProxyAttempts,
      });
      await this.recordProxyOutcome(proxies, payload, null);
      const checkedAt = new Date().toISOString();
      const methods = Array.isArray(payload.methods) ? payload.methods : [];
      const accountBeforeSave = await this.accountStore.getByEmail(email, { includeSecret: true });
      if (!accountBeforeSave) return;
      const hasGcash = payload.ok && methods.some((method) => String(method || '').trim().toLowerCase() === 'gcash');
      const currentStage = String(accountBeforeSave.workflowStage || accountBeforeSave.mailComStage || '').trim().toLowerCase();
      const moveToGcash = hasGcash && !['completed', 'sold'].includes(currentStage);
      const moveToRefining = payload.ok
        && !hasGcash
        && !['paid', 'sms', 'completed', 'sold'].includes(currentStage);
      const moveToPaymentMethod = !payload.ok
        && !['paid', 'sms', 'completed', 'sold'].includes(currentStage);
      await this.accountStore.updateByEmail({ email, expectedVersion: accountBeforeSave.version, patch: {
        paymentCapabilities: {
          ...(accountBeforeSave.paymentCapabilities || {}),
          status: payload.ok ? 'done' : 'failed',
          methods,
          routes: payload.routes && typeof payload.routes === 'object' ? payload.routes : [],
          error: payload.ok ? null : (payload.error || 'payment_method_probe_failed'),
          durationMs: payload.duration_ms ?? null,
          checkedAt,
          updatedAt: checkedAt,
          serviceBaseUrl: '',
          engine: 'universal_local',
          checkoutType: checkoutTypeFromPayload(payload),
          proxyGeo: payload.proxy_geo || payload.proxyGeo || null,
          checkoutConfig: payload.checkout_config || payload.checkoutConfig || null,
          proxyPoolId: proxies.poolId,
          entryProxyPoolId: proxies.poolId,
          exitProxyPoolId: proxies.poolId,
        },
        ...(moveToGcash ? { workflowStage: 'gcash', mailComStage: 'gcash', lifecycleStage: 'gcash' } : {}),
        ...(moveToRefining ? { workflowStage: 'refining', mailComStage: 'refining', lifecycleStage: 'refining' } : {}),
        ...(moveToPaymentMethod ? { workflowStage: 'payment_method', mailComStage: 'payment_method', lifecycleStage: 'payment_method' } : {}),
      } });
    } catch (error) {
      await this.recordProxyOutcome(proxies, null, error).catch(() => {});
      const failedAt = new Date().toISOString();
      const accountBeforeFailureSave = await this.accountStore.getByEmail(email, { includeSecret: true });
      if (!accountBeforeFailureSave) return;
      const currentProbe = accountBeforeFailureSave.paymentCapabilities || {};
      if (error?.code === 'ACCOUNT_VERSION_CONFLICT'
        && (currentProbe.status !== 'checking' || currentProbe.startedAt !== startedAt)) return;
      await this.accountStore.updateByEmail({ email, expectedVersion: accountBeforeFailureSave.version, patch: {
        paymentCapabilities: {
          ...currentProbe,
          status: 'failed',
          methods: [],
          routes: [],
          error: shortError(error),
          checkedAt: failedAt,
          updatedAt: failedAt,
          serviceBaseUrl: '',
          engine: 'universal_local',
          checkoutType: '',
          proxyGeo: null,
          checkoutConfig: null,
          proxyPoolId: proxies?.poolId || config?.proxyPoolId || config?.entryProxyPoolId || '',
          entryProxyPoolId: proxies?.poolId || config?.proxyPoolId || config?.entryProxyPoolId || '',
          exitProxyPoolId: proxies?.poolId || config?.proxyPoolId || config?.entryProxyPoolId || '',
        },
        ...(!['paid', 'sms', 'completed', 'sold'].includes(String(accountBeforeFailureSave.workflowStage || accountBeforeFailureSave.mailComStage || '').trim().toLowerCase())
          ? { workflowStage: 'payment_method', mailComStage: 'payment_method', lifecycleStage: 'payment_method' }
          : {}),
      } });
    }
  }
}

module.exports = { PaymentMethodProbeCoordinator };
