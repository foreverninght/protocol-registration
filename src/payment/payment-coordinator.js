'use strict';

const crypto = require('node:crypto');

const BA_TOKEN_RE = /BA-[A-Za-z0-9]{8,80}/u;
const MAX_PAYMENT_PROXY_PAYLOAD = 500;
const ACTIVE_PAYMENT_STATUSES = new Set(['starting', 'running', 'awaiting_otp', 'awaiting_captcha']);
const AUTO_SKIP_PAYMENT_STATUSES = new Set([
  'starting', 'running', 'awaiting_otp', 'awaiting_captcha', 'completed', 'failed', 'cancelled',
]);

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function extractBaToken(account) {
  const refiningJob = account?.refiningJob || {};
  const result = refiningJob.result || {};
  const candidates = [
    refiningJob.baToken,
    result.ba_token,
    result.billing_token,
    result.provider_redirect_url,
    result.stripe_redirect_url,
    refiningJob.resultUrl,
    ...collectStrings(result),
  ];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(BA_TOKEN_RE);
    if (match) return match[0];
  }
  return '';
}

function normalizePaymentError(error) {
  const message = String(error || '').trim();
  if (!message) return '';
  if (/\bNO_BALANCE\b/iu.test(message)) {
    return 'SMSBower 余额不足；本次重试已创建新支付任务，但无法申请手机号，请充值后再次点击重试支付';
  }
  if (/\bNO_NUMBERS\b/iu.test(message)) {
    return 'SMSBower 当前国家和价格区间暂无可用号码；请稍后重试，或调整接码国家/价格区间后重试';
  }
  if (/IDENTITY_ELEVATION_EC_MISSING|INVALID_RESOURCE_ID|resource ID was not found/iu.test(message)) {
    return 'PayPal BA/checkout 已失效或不可用，需要重新提炼生成新的支付链接';
  }
  if (/SMSBower did not return an OTP before timeout/iu.test(message)) return 'SMSBower 超时未收到 PayPal 短信码，可重试支付或更换接码国家/价格区间';
  if (/payment_proxy_pool_empty/iu.test(message)) return '支付代理池为空，请在代理池-支付里导入代理并保存支付配置';
  if (/Proxy pool supports at most 500 entries|supports at most 500 entries/iu.test(message)) {
    return '支付服务单次最多接收 500 条代理；本地支付代理池不限量，系统会轮换取 500 条，请重试支付';
  }
  if (/ba_token_not_available/iu.test(message)) return '当前账号没有可用 BA Token，请先完成提炼';
  if (/account_not_in_unpaid/iu.test(message)) return '账号不在未支付分组，不能启动支付';
  if (/payment_disabled/iu.test(message)) return '支付功能未启用，请先保存支付配置';
  if (/not found|任务不存在|不存在/iu.test(message)) return '支付任务状态丢失，请重新支付；若重复出现请检查支付服务任务归属 Cookie';
  return message;
}

function paymentJobCookie(email) {
  const key = String(email || '').trim().toLowerCase();
  const deviceId = crypto.createHash('sha256')
    .update(`signlist-clean-payment:${key}`)
    .digest('hex')
    .slice(0, 32);
  return `paypal_web_device_id=${deviceId}`;
}

function publicPayment(payment = {}) {
  if (!payment || typeof payment !== 'object') return null;
  const { error, ...safe } = payment;
  return { ...safe, error: error ? normalizePaymentError(error) : '' };
}

class PaymentCoordinator {
  constructor({
    accountStore,
    proxyPools,
    settings,
    intervalMs = 3000,
    onPaymentCompleted = null,
    onFinalPaymentFailed = null,
    getConcurrency = () => 1,
  }) {
    if (!accountStore) throw new TypeError('accountStore is required');
    this.accountStore = accountStore;
    this.proxyPools = proxyPools;
    this.settings = settings;
    this.intervalMs = intervalMs;
    this.onPaymentCompleted = typeof onPaymentCompleted === 'function' ? onPaymentCompleted : null;
    this.onFinalPaymentFailed = typeof onFinalPaymentFailed === 'function' ? onFinalPaymentFailed : null;
    this.getConcurrency = getConcurrency;
    this.timer = null;
    this.running = false;
    this.started = false;
    this.cookie = '';
    this.proxyCursorByPool = new Map();
  }

  start() {
    if (this.timer) return;
    this.started = true;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error('payment reconciliation tick failed', error);
    }), this.intervalMs);
    this.timer.unref?.();
    this.notify();
  }

  configureInterval(intervalMs) {
    const next = Math.max(1000, Math.min(30000, Number(intervalMs) || 3000));
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    this.start();
  }

  notify() {
    setImmediate(() => {
      if (!this.started) return;
      this.tick().catch((error) => {
        console.error('payment reconciliation notification failed', error);
      });
    });
  }

  async stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  rememberCookie(response) {
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) return;
    const cookies = setCookie
      .split(/,(?=[^;,]+=)/u)
      .map((item) => item.split(';')[0].trim())
      .filter(Boolean);
    if (cookies.length) this.cookie = cookies.join('; ');
  }

  async request(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (this.cookie && !headers.cookie) headers.cookie = this.cookie;
    const response = await fetch(`${this.settings.getSecretConfig().serviceBaseUrl}${path}`, {
      ...options,
      headers,
    });
    this.rememberCookie(response);
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(payload.message || payload.error || `payment service HTTP ${response.status}`);
    return payload;
  }

  paymentProxyPool() {
    const config = this.settings.getSecretConfig();
    const poolId = String(config.proxyPoolId || '').trim();
    if (!poolId) {
      return { proxies: [], total: 0, selected: 0, limit: MAX_PAYMENT_PROXY_PAYLOAD };
    }
    const all = this.proxyPools.payment.listRaw(poolId)
      .map((proxy) => proxy.raw || `${proxy.host}:${proxy.port}:${proxy.username || ''}:${proxy.password || ''}`)
      .filter(Boolean);
    if (all.length <= MAX_PAYMENT_PROXY_PAYLOAD) {
      return { proxies: all, total: all.length, selected: all.length, limit: MAX_PAYMENT_PROXY_PAYLOAD };
    }
    const key = poolId || '__default__';
    const start = (Number(this.proxyCursorByPool.get(key)) || 0) % all.length;
    const proxies = Array.from({ length: MAX_PAYMENT_PROXY_PAYLOAD }, (_, index) => all[(start + index) % all.length]);
    this.proxyCursorByPool.set(key, (start + MAX_PAYMENT_PROXY_PAYLOAD) % all.length);
    return { proxies, total: all.length, selected: proxies.length, limit: MAX_PAYMENT_PROXY_PAYLOAD };
  }

  async getStatus(email) {
    return publicPayment((await this.accountStore.getByEmail(email, { includeSecret: true }))?.payment);
  }

  async deleteFinalFailedPayment(email, payment = null) {
    if (!this.onFinalPaymentFailed) return;
    await this.onFinalPaymentFailed({ email, payment: publicPayment(payment) });
  }

  async startPayment(email, options = {}) {
    const account = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!account) throw new Error('account_not_found');
    if ((account.workflowStage || account.mailComStage) !== 'pending_payment') {
      throw new Error('account_not_in_unpaid');
    }
    if (ACTIVE_PAYMENT_STATUSES.has(String(account.payment?.status || '').toLowerCase())) {
      return publicPayment(account.payment);
    }
    const config = this.settings.getSecretConfig();
    const taskRetryCount = Math.max(0, Math.trunc(Number(options.taskRetryCount) || 0));
    const baToken = extractBaToken(account);
    if (!baToken) throw new Error('ba_token_not_available');
    const proxyPayload = this.paymentProxyPool();
    const proxies = proxyPayload.proxies;
    if (!proxies.length) throw new Error('payment_proxy_pool_empty');
    const now = new Date().toISOString();
    const startingPayment = {
      payment: {
        status: 'starting',
        jobId: '',
        baToken,
        baSource: 'refiningJob',
        phoneMode: 'auto',
        phone: '',
        activationId: '',
        providerId: '',
        price: 0,
        country: '',
        proxyPoolId: config.proxyPoolId || '',
        proxyCount: proxyPayload.selected,
        proxyTotalCount: proxyPayload.total,
        proxyPayloadLimit: proxyPayload.limit,
        taskRetryCount,
        taskRetryLimit: config.paymentTaskRetryLimit,
        retryReason: String(options.retryReason || ''),
        error: '',
        result: null,
        startedAt: now,
        updatedAt: now,
      },
    };
    await this.accountStore.updateByEmail({ email, expectedVersion: account.version, patch: startingPayment });
    try {
      const payload = await this.request('/jobs/batch', {
        method: 'POST',
        headers: { cookie: paymentJobCookie(email) },
        body: JSON.stringify({
          tasks: [{
            ba_token: baToken,
            phone: 'auto',
            sms: {
              provider: config.smsProvider,
              service: config.smsService,
              api_key: config.smsApiKey,
              country: config.smsCountry,
              price_min: config.smsPriceMin,
              price_max: config.smsPriceMax,
              timeout_seconds: config.smsTimeoutSeconds,
              max_attempts: config.smsMaxAttempts,
              number_retry_limit: config.smsPhoneRetryLimit,
              prefer_gold: config.smsPreferGold,
            },
          }],
          proxies,
        }),
      });
      const job = payload.jobs?.[0] || {};
      const latest = await this.accountStore.getByEmail(email, { includeSecret: true });
      if (!latest) throw new Error('account_not_found');
      if (latest.payment?.status !== 'starting' || latest.payment?.startedAt !== now) {
        const error = new Error('payment state changed while the remote task was being created');
        error.code = 'PAYMENT_STATE_CHANGED';
        throw error;
      }
      const savedPayment = {
        ...latest.payment,
        status: job.status === 'failed' ? 'failed' : 'running',
        jobId: job.id || '',
        phone: job.phone || '',
        country: job.country || '',
        updatedAt: new Date().toISOString(),
        error: normalizePaymentError(job.error || ''),
      };
      await this.accountStore.updateByEmail({ email, expectedVersion: latest.version, patch: {
        payment: {
          ...savedPayment,
        },
      } });
      if (job.status === 'failed') {
        await this.deleteFinalFailedPayment(email, savedPayment);
        return { ...publicPayment(savedPayment), deleted: true };
      }
      return publicPayment(savedPayment);
    } catch (error) {
      if (error?.code === 'PAYMENT_STATE_CHANGED' || error?.code === 'ACCOUNT_VERSION_CONFLICT') throw error;
      const normalizedError = normalizePaymentError(error.message || error);
      const latest = await this.accountStore.getByEmail(email, { includeSecret: true });
      if (latest) await this.accountStore.updateByEmail({ email, expectedVersion: latest.version, patch: {
        payment: {
          ...(latest.payment || {}),
          status: 'failed',
          error: normalizedError,
          updatedAt: new Date().toISOString(),
        },
      } });
      throw new Error(normalizedError);
    }
  }

  async cancelPayment(email) {
    const account = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!account) throw new Error('account_not_found');
    const jobId = account?.payment?.jobId;
    if (jobId) await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { cookie: paymentJobCookie(email) },
      body: '{}',
    });
    await this.accountStore.updateByEmail({ email, expectedVersion: account.version, patch: {
      payment: {
        ...(account?.payment || {}),
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      },
    } });
    return this.getStatus(email);
  }

  async markAutoStartFailure(email, error) {
    const current = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!current) return;
    const now = new Date().toISOString();
    await this.accountStore.updateByEmail({ email, expectedVersion: current.version, patch: {
      payment: {
        ...(current.payment || {}),
        status: 'failed',
        jobId: current.payment?.jobId || '',
        error: normalizePaymentError(error?.message || error),
        autoStartedAt: current.payment?.autoStartedAt || now,
        updatedAt: now,
      },
    } });
  }

  async autoStartPendingPayments() {
    const config = this.settings.getSecretConfig();
    if (!config.enabled) return { started: [], skipped: [] };
    const started = [];
    const skipped = [];
      const records = await this.accountStore.list({
                mailComStages: ['pending_payment'],
        includeSecret: true,
        limit: null,
      });
    const concurrency = Math.max(0, Math.min(30, Math.trunc(Number(this.getConcurrency?.()) || 0)));
    const activeCount = records.filter((account) => ACTIVE_PAYMENT_STATUSES.has(
      String(account.payment?.status || '').toLowerCase(),
    )).length;
    const availableSlots = Math.max(0, concurrency - activeCount);
    const readyRecords = records.filter((account) => !AUTO_SKIP_PAYMENT_STATUSES.has(
      String(account.payment?.status || '').toLowerCase(),
    ));
    const recordsToStart = readyRecords.slice(0, availableSlots);
    let cursor = 0;
    if (!recordsToStart.length) return { started, skipped };
    const worker = async () => {
      while (cursor < recordsToStart.length) {
        const account = recordsToStart[cursor++];
        const email = account.email;
        try {
          await this.startPayment(email);
          started.push(email);
        } catch (error) {
          const latest = await this.accountStore.getByEmail(email, { includeSecret: true }) || {};
          const latestStatus = String(latest.payment?.status || '').toLowerCase();
          if (!AUTO_SKIP_PAYMENT_STATUSES.has(latestStatus)) await this.markAutoStartFailure(email, error);
          skipped.push({ email, reason: normalizePaymentError(error?.message || error) });
        }
      }
    };
    await Promise.all(Array.from({ length: recordsToStart.length }, () => worker()));
    return { started, skipped };
  }

  async reconcile(email, payment) {
    if (!payment?.jobId || !ACTIVE_PAYMENT_STATUSES.has(String(payment.status || '').toLowerCase())) return;
    const remote = await this.request(`/jobs/${encodeURIComponent(payment.jobId)}`, {
      headers: { cookie: paymentJobCookie(email) },
    });
    if (remote.status === 'awaiting_captcha') {
      await this.retryCaptchaPayment(email, payment, remote);
      return;
    }
    const nextStatus = remote.status === 'completed'
      ? 'completed'
      : remote.status === 'failed'
        ? 'failed'
        : remote.status === 'awaiting_otp' ? 'awaiting_otp' : 'running';
    const next = {
      ...payment,
      status: nextStatus,
      phone: remote.phone || payment.phone || '',
      country: remote.country || payment.country || '',
      result: remote.result || payment.result || null,
      error: normalizePaymentError(remote.error || payment.error || ''),
      activationId: remote.activation_id || payment.activationId || '',
      providerId: remote.provider_id || payment.providerId || '',
      price: Number(remote.price || payment.price || 0),
      updatedAt: new Date().toISOString(),
    };
    const current = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!current) return;
    if (current.payment?.jobId !== payment.jobId
      || !ACTIVE_PAYMENT_STATUSES.has(String(current.payment?.status || '').toLowerCase())) return;
    await this.accountStore.updateByEmail({ email, expectedVersion: current.version, patch: {
      payment: next,
      ...(nextStatus === 'completed' && remote.result?.status === 'success'
        ? { workflowStage: 'paid', mailComStage: 'paid', lifecycleStage: 'paid' }
        : {}),
    } });
    if (nextStatus === 'failed') {
      await this.deleteFinalFailedPayment(email, next);
      return;
    }
    if (nextStatus === 'completed' && remote.result?.status === 'success') {
      try {
        await this.onPaymentCompleted?.({ email, payment: publicPayment(next) });
      } catch (error) {
        const latest = await this.accountStore.getByEmail(email, { includeSecret: true });
        if (latest) await this.accountStore.updateByEmail({ email, expectedVersion: latest.version, patch: {
          paymentContinuationError: {
            code: error?.code || 'PAYMENT_CONTINUATION_FAILED',
            message: String(error?.message || error).slice(0, 500),
            at: new Date().toISOString(),
          },
        } });
      }
    }
  }

  async retryCaptchaPayment(email, payment, remote = {}) {
    const config = this.settings.getSecretConfig();
    const retryCount = Math.max(0, Math.trunc(Number(payment.taskRetryCount) || 0));
    const retryLimit = Math.max(0, Math.min(5, Math.trunc(Number(config.paymentTaskRetryLimit) || 0)));
    const reason = normalizePaymentError(
      remote.awaiting_prompt
      || remote.stage
      || 'PayPal 要求人工风控验证，自动支付无法继续',
    );
    let cancellationError = null;
    try {
      await this.request(`/jobs/${encodeURIComponent(payment.jobId)}/cancel`, {
        method: 'POST',
        headers: { cookie: paymentJobCookie(email) },
        body: '{}',
      });
    } catch (error) {
      cancellationError = normalizePaymentError(error?.message || error);
    }
    if (retryCount >= retryLimit) {
      const failed = {
        ...payment,
        status: 'failed',
        taskRetryCount: retryCount,
        taskRetryLimit: retryLimit,
        error: `${reason}；支付任务重试次数已耗尽（${retryCount}/${retryLimit}）`,
        updatedAt: new Date().toISOString(),
      };
      const current = await this.accountStore.getByEmail(email, { includeSecret: true });
      if (current) await this.accountStore.updateByEmail({ email, expectedVersion: current.version, patch: {
        payment: { ...failed, previousTaskCancelError: cancellationError },
      } });
      await this.deleteFinalFailedPayment(email, failed);
      return;
    }
    const current = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!current) return;
    await this.accountStore.updateByEmail({ email, expectedVersion: current.version, patch: {
      payment: {
        ...payment,
        status: 'cancelled',
        taskRetryCount: retryCount + 1,
        taskRetryLimit: retryLimit,
        error: `${reason}；正在更换支付任务和代理重试（${retryCount + 1}/${retryLimit}）`,
        previousTaskCancelError: cancellationError,
        updatedAt: new Date().toISOString(),
      },
    } });
    await this.startPayment(email, {
      taskRetryCount: retryCount + 1,
      retryReason: reason,
    });
  }

    async tick() {
      if (this.running) return;
      this.running = true;
      try {
        for (const account of await this.accountStore.list({
                    paymentStatuses: [...ACTIVE_PAYMENT_STATUSES],
          includeSecret: true,
          limit: null,
        })) {
        try { await this.reconcile(account.email, account.payment); } catch (error) {
          if (error?.code === 'ACCOUNT_VERSION_CONFLICT' || error?.code === 'PAYMENT_STATE_CHANGED') continue;
          const message = normalizePaymentError(error.message || error);
          const previous = normalizePaymentError(account.payment?.error || '');
          const keepPrevious = previous && /not found|不存在|任务不存在/iu.test(message);
          const latest = await this.accountStore.getByEmail(account.email, { includeSecret: true });
          if (!latest) continue;
          await this.accountStore.updateByEmail({ email: account.email, expectedVersion: latest.version, patch: {
            payment: {
              ...(latest.payment || {}),
              status: 'failed',
              error: keepPrevious ? previous : message,
              updatedAt: new Date().toISOString(),
            },
          } });
        }
      }
      await this.autoStartPendingPayments();
    } finally {
      this.running = false;
    }
  }
}

module.exports = { PaymentCoordinator, extractBaToken, paymentJobCookie, publicPayment };
