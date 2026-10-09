'use strict';

const crypto = require('node:crypto');

const { TWO_POOL_LINK_TYPES } = require('./settings');
const { Pay153HttpError } = require('./pay153-client');
const { parseProxyLine, isProxyCoolingDown } = require('../proxies/proxy-pools');
const { extractBaToken } = require('../payment/payment-coordinator');

const ACTIVE_STATUSES = new Set(['dispatching', 'queued', 'running']);
const TERMINAL_REMOTE_STATUSES = new Set(['done', 'error', 'cancelled']);
const PENDING_PAYMENT_STAGE = 'pending_payment';
const GCASH_STAGE = 'gcash';
const REMOTE_UNKNOWN_RETRY_BASE_MS = 5000;
const REMOTE_UNKNOWN_RETRY_MAX_MS = 60000;
const PUBLIC_NOT_FOUND_CONFIRMATIONS = 3;
const PUBLIC_REMOTE_RECOVERY_LIMIT = 3;

function eligibilityStatus(account) {
  return String(account?.eligibilityStatus || account?.trialEligibility?.status || '').trim().toLowerCase();
}


function gcashStageUi(stage, qr = {}) {
  const value = String(stage || '').trim().toLowerCase();
  const qrReady = String(qr.status || '').trim().toLowerCase() === 'ready' || Boolean(qr.imageBase64);
  const labels = {
    idle: '未开始',
      pending: '等待提炼',
    queued: '等待提炼',
    dispatching: '提交提炼',
    running: '执行提炼',
      remote_unknown: '提交状态未知，等待确认',
      remote_lost: '远端状态丢失，等待恢复',
    starting: '正在打开支付页',
    waiting_scan: qrReady ? '等待扫码' : '正在获取二维码',
    refreshing: '正在刷新二维码',
    redirect_captured: '已扫码，准备回调',
    callback_processing: '回调已受理，正在确认 Plus',
    completed: '支付成功',
    callback_failed: '自动回调失败',
    callback_unconfirmed: 'Plus 权益未确认',
    expired: qr.refreshAvailable === true ? '二维码已过期，可刷新' : '支付监控已结束',
    abandoned: '已放弃支付监控',
    monitor_ref_missing: '监控引用丢失，需重提',
    unavailable: '未生成二维码',
    configure_taxes: '配置税务中',
    confirm_payment: '确认支付中',
    proxy_test: '代理测试中',
    failed: '执行失败',
    closed: '已放弃支付监控',
  };
  const stateByStage = {
    idle: 'idle',
      pending: 'extracting',
    queued: 'extracting',
    dispatching: 'extracting',
    running: 'extracting',
      remote_unknown: 'extracting',
      remote_lost: 'extracting',
    starting: 'extracting',
    waiting_scan: qrReady ? 'qr_ready' : 'extracting',
    refreshing: 'extracting',
    redirect_captured: 'scanned',
    callback_processing: 'confirming',
    completed: 'plus_confirmed',
    callback_failed: 'failed',
    callback_unconfirmed: 'failed',
    expired: 'qr_expired',
    abandoned: 'closed',
    monitor_ref_missing: 'closed',
    unavailable: 'idle',
    configure_taxes: 'extracting',
    confirm_payment: 'extracting',
    proxy_test: 'extracting',
    failed: 'failed',
    closed: 'closed',
  };
  return {
    stage: value || 'idle',
    label: labels[value] || labels.idle,
    state: stateByStage[value] || 'idle',
  };
}

function gcashCanonicalStatus(account = {}, record = null, nowMs = Date.now()) {
  const job = account?.refiningJob || {};
  const qr = job?.gcashQr || {};
  const jobStatus = String(job.status || '').trim().toLowerCase();
  const result = job?.result || {};
  const qrStatus = String(qr.status || '').trim().toLowerCase();
  const postStatus = String(qr.gcashPostCheckoutStatus || '').trim().toLowerCase();
  const mkStatus = String(qr.mkPaymentStatus || qr.gcashStateReason || '').trim().toLowerCase();
  const explicit = String(qr.gcashState || '').trim().toLowerCase();
  const mkJobId = String(result.mkJobId || qr.mkJobId || '').trim();
  const mkAccountId = String(result.mkAccountId || qr.mkAccountId || '').trim();
  const hasMkRef = Boolean(mkJobId && mkAccountId);
  const hasQrState = Boolean(qrStatus || mkStatus || explicit || qr.imageBase64 || qr.qrExpiresAt);
  const qrNeedsMkRef = hasQrState && !['closed', 'error'].includes(qrStatus) && !['closed', 'failed'].includes(explicit);
  const qrExpiresAt = Date.parse(String(qr.qrExpiresAt || ''));
  const expiredByTime = Number.isFinite(qrExpiresAt) && qrExpiresAt <= nowMs;
  const jobUpdatedAt = Date.parse(String(job.updatedAt || job.startedAt || job.createdAt || ''));
  const pendingIsFresh = jobStatus === 'pending'
    && Number.isFinite(jobUpdatedAt)
    && nowMs - jobUpdatedAt <= 2 * 60 * 1000;
  const jobRefiningActive = ['dispatching', 'queued', 'running', 'remote_unknown', 'remote_lost'].includes(jobStatus)
    || pendingIsFresh;
  let stage = 'idle';
  if (record?.gcashSold) stage = 'closed';
  else if (qr.gcashConfirmedPlus === true || postStatus === 'plus_confirmed' || mkStatus === 'completed') stage = 'completed';
    else if (jobRefiningActive) stage = jobStatus;
    else if (qrStatus === 'closed' || explicit === 'closed') stage = 'closed';
  else if (!hasMkRef && qrNeedsMkRef) stage = 'monitor_ref_missing';
  else if (mkStatus) stage = mkStatus;
  else if (postStatus && !['plus_confirmed', 'unavailable'].includes(postStatus)) stage = postStatus;
  else if (qrStatus === 'refreshing') stage = 'refreshing';
  else if (qrStatus === 'expired' || expiredByTime) stage = 'expired';
  else if (qrStatus === 'ready') stage = 'waiting_scan';
  else if (qrStatus === 'error') stage = 'failed';
  else if (jobStatus === 'error') stage = 'failed';
  else if (explicit === 'qr_expired') stage = 'expired';
  else if (explicit === 'qr_ready') stage = 'waiting_scan';
  else if (explicit === 'scanned') stage = 'redirect_captured';
  else if (explicit === 'confirming') stage = 'callback_processing';
  else if (explicit === 'closed') stage = 'closed';
  else if (explicit === 'failed') stage = 'failed';
  const ui = gcashStageUi(stage, qr);
  const reason = ui.stage;
  const detail = '';
  return { ...ui, reason, detail };
}

function gcashActionForState(state, reason) {
  if (state === 'plus_confirmed') return 'none';
  if (state === 'qr_ready') return 'scan_phone';
  if (state === 'qr_expired') return 'refresh_qr';
  if (state === 'scanned' || state === 'confirming') return 'wait_or_check_callback';
  if (state === 'extracting') return 'wait';
  if (state === 'failed' && String(reason || '').startsWith('login_state_')) return 'refresh_login_state_then_retry';
  if (state === 'failed') return 'inspect_error_then_retry';
  if (state === 'closed') return 'reopen_if_needed';
  return 'start_gcash';
}

function gcashQrIsStillScannable(qr = {}, nowMs = Date.now()) {
  if (!qr || typeof qr !== 'object') return false;
  const status = String(qr.status || '').trim().toLowerCase();
  const state = String(qr.gcashState || '').trim().toLowerCase();
  const mkStatus = String(qr.mkPaymentStatus || qr.gcashStateReason || '').trim().toLowerCase();
  const hasQr = Boolean(qr.imageBase64 || qr.url || qr.sourceUrl);
  const expiresAt = Date.parse(String(qr.qrExpiresAt || ''));
  const expired = Number.isFinite(expiresAt) && expiresAt <= nowMs;
  return hasQr
    && !expired
    && (status === 'ready' || state === 'qr_ready' || mkStatus === 'waiting_scan');
}

function shouldKeepExistingGcashQr(existingQr = {}, nextQr = {}) {
  if (!gcashQrIsStillScannable(existingQr)) return false;
  const nextStatus = String(nextQr?.status || '').trim().toLowerCase();
  const nextState = String(nextQr?.gcashState || '').trim().toLowerCase();
  const nextMkStatus = String(nextQr?.mkPaymentStatus || nextQr?.gcashStateReason || '').trim().toLowerCase();
  const terminalOrForward = new Set([
    'completed', 'plus_confirmed', 'redirect_captured', 'callback_processing',
    'waiting_scan', 'expired', 'abandoned', 'failed', 'callback_failed',
    'callback_unconfirmed', 'closed',
  ]);
  if (terminalOrForward.has(nextStatus) || terminalOrForward.has(nextState) || terminalOrForward.has(nextMkStatus)) return false;
  if (nextQr?.gcashConfirmedPlus === true) return false;
  if (nextQr?.qrReady === true || nextQr?.imageBase64) return false;
  return ['unavailable', 'capturing', 'refreshing', ''].includes(nextStatus)
    || ['idle', 'extracting', ''].includes(nextState)
    || ['unavailable', 'configure_taxes', 'confirm_payment', 'proxy_test', 'starting', ''].includes(nextMkStatus);
}

function canonicalResultUrl(result = {}) {
  const keys = [
    'short_link', 'checkout_url', 'provider_redirect_url', 'adyen_redirect_url', 'payment_redirect_url',
    'paypal_link', 'paypal_url', 'stripe_redirect_url', 'verification_url', 'redirect_url', 'payment_url', 'url', 'link',
  ];
  for (const key of keys) {
    const value = String(result?.[key] || '').trim();
    if (/^https?:\/\//iu.test(value)) return value;
  }
  const seen = new Set();
  const candidates = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^https?:\/\//iu.test(trimmed)) candidates.push(trimmed);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(result);
  return candidates.find((url) => /checkoutshopper|adyen|gcash|checkout|payment/iu.test(url))
    || candidates[0]
    || '';
}

function hasUsablePaymentArtifact(account = {}) {
  if (extractBaToken(account)) return true;
  const job = account.refiningJob || {};
  if (canonicalResultUrl(job.result || {}) || canonicalResultUrl({ url: job.resultUrl })) return true;
  const qr = job.gcashQr || {};
  return Boolean(qr.imageBase64 || qr.url || qr.sourceUrl || (qr.mkJobId && qr.mkAccountId));
}

function publicConfigSnapshot(settings) {
  return {
    provider: settings.provider || 'pay153',
    plan: settings.plan,
    linkType: settings.linkType,
    country: settings.country,
    currency: settings.currency,
    entryProxyPoolId: settings.entryProxyPoolId,
    exitProxyPoolId: settings.exitProxyPoolId,
    retryCount: settings.retryCount,
    concurrency: settings.concurrency,
    usePromo: settings.usePromo,
    promoCampaign: settings.promoCampaign,
    useSentinel: settings.useSentinel,
  };
}

function remoteStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['pending', 'queued', 'running', 'done', 'error', 'cancelled'].includes(status) ? status : 'running';
}

function effectiveRetryCount(settings) {
  const limit = settings.provider === 'public_cdk' ? 50 : (settings.linkType === 'gopay' ? 20 : 10);
  return Math.min(limit, Math.max(1, Number(settings.retryCount) || 1));
}

function providerRuntimeSettings(settings = {}) {
  const provider = String(settings.provider || 'pay153').trim() || 'pay153';
  const nonNegative = (value, fallback = 1, max = 30) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.trunc(parsed))) : fallback;
  };
  if (provider === 'public_cdk') {
    const batchSize = nonNegative(settings.concurrency);
    return {
      provider,
      stage: 'refining',
      concurrency: batchSize,
      dispatchLimit: batchSize,
      waitForBatchWindow: true,
      batchWindowSeconds: Math.max(0, Number(settings.batchWindowSeconds || 0)),
    };
  }
  if (provider === 'gc_tacmon') {
    const concurrency = nonNegative(settings.concurrency, 1, 12);
    return {
      provider,
      stage: GCASH_STAGE,
      concurrency,
      dispatchLimit: concurrency,
      waitForBatchWindow: false,
      batchWindowSeconds: 0,
    };
  }
  const concurrency = nonNegative(settings.concurrency);
  return {
    provider,
    stage: 'refining',
    concurrency,
    dispatchLimit: concurrency,
    waitForBatchWindow: false,
    batchWindowSeconds: 0,
  };
}

function proxyLine(proxy) {
  if (typeof proxy === 'string') return proxy.trim();
  if (!proxy || typeof proxy !== 'object') return '';
  if (proxy.raw) return String(proxy.raw).trim();
  if (!proxy.host || !proxy.port) return '';
  const auth = proxy.username ? `:${proxy.username}:${proxy.password || ''}` : '';
  return `${proxy.host}:${proxy.port}${auth}`;
}

function proxyLines(proxies) {
  return (Array.isArray(proxies) ? proxies : []).map(proxyLine).filter(Boolean);
}

function proxyLineId(line) {
  return crypto.createHash('sha256').update(String(line || '')).digest('hex').slice(0, 16);
}

function proxyObjectFromLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const parsed = parseProxyLine(raw);
  return parsed ? { ...parsed, id: parsed.id || proxyLineId(raw) } : { raw, id: proxyLineId(raw) };
}

function publicServiceProxyReference(proxy) {
  if (!proxy || typeof proxy !== 'object') return null;
  const id = String(proxy.id || '').trim();
  const poolId = String(proxy.poolId || '').trim();
  if (!id || !poolId) return null;
  return {
    id,
    poolId,
    country: proxy.country || null,
  };
}

class RefiningCoordinator {
  constructor({
    accountStore, proxyPools, settings, runtime, client, intervalMs = 2500,
    remoteUnknownRetryBaseMs = REMOTE_UNKNOWN_RETRY_BASE_MS,
    publicNotFoundConfirmations = PUBLIC_NOT_FOUND_CONFIRMATIONS,
    publicRemoteRecoveryLimit = PUBLIC_REMOTE_RECOVERY_LIMIT,
  }) {
    if (!accountStore) throw new TypeError('accountStore is required');
    this.accountStore = accountStore;
    this.proxyPools = proxyPools;
    this.settings = settings;
    this.runtime = runtime;
    this.client = client;
    this.intervalMs = intervalMs;
    this.remoteUnknownRetryBaseMs = Math.max(0, Number(remoteUnknownRetryBaseMs) || 0);
    this.publicNotFoundConfirmations = Math.max(1, Number(publicNotFoundConfirmations) || 1);
    this.publicRemoteRecoveryLimit = Math.max(1, Number(publicRemoteRecoveryLimit) || 1);
    this.gcTacmonDispatching = new Set();
    this.timer = null;
    this.running = false;
    this.started = false;
    this.forceDispatch = false;
  }

  async recoverStaleGcashQrSessions() {
    const recoveredAt = new Date().toISOString();
    const updates = [];
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      const qr = account?.refiningJob?.gcashQr;
      if (!qr || (!qr.browserAlive && !['capturing', 'refreshing', 'closing'].includes(qr.status))) continue;
      updates.push({ email: account.email, expectedVersion: account.version, patch: {
        refiningJob: {
          ...(account.refiningJob || {}),
          gcashQr: {
            ...qr,
            status: 'closed',
            authorizationStatus: qr.authorizationStatus === 'continued' ? 'continued' : 'session_interrupted',
            browserAlive: false,
            closeReason: 'service_restart',
            closedAt: recoveredAt,
            updatedAt: recoveredAt,
          },
        },
      } });
    }
    await this.accountStore.updateManyByEmail(updates);
  }

  async start() {
    if (this.timer) return;
    this.started = true;
    await this.recoverStaleGcashQrSessions();
    await this.markCompletedRefiningWithoutBaToken();
    await this.moveCompletedAccountsToPendingPayment();
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error('refining coordinator tick failed', error);
    }), this.intervalMs);
    this.timer.unref?.();
    this.notify();
  }

  async stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  notify({ forceDispatch = false } = {}) {
    if (forceDispatch) this.forceDispatch = true;
    setImmediate(() => {
      if (!this.started) return;
      this.tick().catch((error) => {
        console.error('refining coordinator notification failed', error);
      });
    });
  }

  mkGcashRef(account) {
    const result = account?.refiningJob?.result;
    const qr = account?.refiningJob?.gcashQr;
    const mkJobId = String(result?.mkJobId || qr?.mkJobId || '').trim();
    const mkAccountId = String(result?.mkAccountId || qr?.mkAccountId || '').trim();
    return result?.mkGcash && mkJobId && mkAccountId ? { mkJobId, mkAccountId } : null;
  }

  async updateAccounts(accounts, patchBuilder) {
    const requested = [...new Set(accounts.map((account) => String(account?.email || account || '').trim().toLowerCase()).filter(Boolean))];
    const current = (await Promise.all(requested.map((email) => (
      this.accountStore.getByEmail(email, { includeSecret: true })
    )))).filter(Boolean);
    const updates = current.map((account) => ({
      email: account.email,
      expectedVersion: account.version,
      patch: patchBuilder(account),
    }));
    await this.accountStore.updateManyByEmail(updates);
    return current;
  }

  async refreshMkGcashQrCapture(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const account = await this.accountStore.getByEmail(normalizedEmail, { includeSecret: true });
    const ref = this.mkGcashRef(account);
    if (!ref || typeof this.client.refreshMkGcashAccount !== 'function') {
      return { refreshed: false, reason: 'not_mk_gcash', status: account?.refiningJob?.gcashQr?.status || null };
    }
    const refreshRequestedAt = new Date().toISOString();
    await this.accountStore.updateByEmail({ email: normalizedEmail, expectedVersion: account.version, patch: {
      refiningJob: {
        ...(account.refiningJob || {}),
        gcashQr: {
          ...(account.refiningJob?.gcashQr || {}),
          status: 'refreshing',
          gcashState: 'extracting',
          gcashStateReason: 'mk_qr_refresh_requested',
          qrRefreshStatus: 'refreshing',
          refreshError: null,
          updatedAt: refreshRequestedAt,
        },
      },
    } });
    await this.client.refreshMkGcashAccount(ref.mkJobId, ref.mkAccountId);
    this.notify();
    return {
      scheduled: false,
      refreshed: true,
      status: 'refreshing',
      sessionId: `mk:${ref.mkJobId}:${ref.mkAccountId}`,
      refreshRequestedAt,
    };
  }

  async closeGcashQrCapture(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const latest = await this.accountStore.getByEmail(normalizedEmail, { includeSecret: true });
    const ref = this.mkGcashRef(latest);
    const closedAt = new Date().toISOString();
    if (!ref || typeof this.client.abandonMkGcashAccount !== 'function') {
      if (!latest?.refiningJob?.gcashQr) return { closed: false, reason: 'not_mk_gcash', sessionId: null };
      await this.accountStore.updateByEmail({ email: normalizedEmail, expectedVersion: latest.version, patch: {
        refiningJob: {
          ...(latest.refiningJob || {}),
          gcashQr: {
            ...(latest.refiningJob?.gcashQr || {}),
            status: 'closed',
            gcashState: 'closed',
            gcashStateReason: 'local_close_without_mk_ref',
            authorizationStatus: 'closed_manually',
            browserAlive: false,
            closeReason: 'local_without_mk_ref',
            closedAt,
            updatedAt: closedAt,
          },
        },
      } });
      this.notify();
      return { closed: true, status: 'closed', reason: 'local_without_mk_ref', sessionId: null };
    }
    await this.client.abandonMkGcashAccount(ref.mkJobId, ref.mkAccountId);
    await this.accountStore.updateByEmail({ email: normalizedEmail, expectedVersion: latest.version, patch: {
      refiningJob: {
        ...(latest.refiningJob || {}),
        gcashQr: {
          ...(latest.refiningJob?.gcashQr || {}),
          status: 'closed',
          gcashState: 'closed',
          gcashStateReason: 'mk_manual_abandon',
          authorizationStatus: 'closed_manually',
          browserAlive: false,
          closeReason: 'manual',
          closedAt,
          updatedAt: closedAt,
        },
      },
    } });
    this.notify();
    return { closed: true, status: 'closed', sessionId: `mk:${ref.mkJobId}:${ref.mkAccountId}` };
  }

  async candidate(email, { includeExisting = false } = {}) {
    const account = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (!account || !['refining', GCASH_STAGE].includes(account.workflowStage || account.mailComStage)) {
      return { ready: false, reason: 'not_in_refining_or_gcash', account };
    }
    if (account.status !== 'registered') return { ready: false, reason: 'not_registered', account };
    if (eligibilityStatus(account) !== 'eligible') return { ready: false, reason: 'not_eligible', account };
    if (!String(account.tokens?.accessToken || '').trim()) return { ready: false, reason: 'access_token_missing', account };
    if (account.refiningJob) return { ready: false, reason: 'already_tracked', account };
    const config = this.settings.getSecretConfig();
    if (config.provider === 'gc_tacmon' && (account.workflowStage || account.mailComStage) !== GCASH_STAGE) {
      return { ready: false, reason: 'gc_tacmon_only_accepts_gcash_stage', account };
    }
    if (!includeExisting && config.autoStartedAt) {
      const enteredAt = Date.parse(account.updatedAt || account.createdAt || '');
      const startedAt = Date.parse(config.autoStartedAt);
      if (Number.isFinite(enteredAt) && Number.isFinite(startedAt) && enteredAt < startedAt) {
        return { ready: false, reason: 'predates_auto_start', account };
      }
    }
    return { ready: true, reason: '', account };
  }

  async queueEmails(emails, { includeExisting = false, manualDispatch = false } = {}) {
    const requested = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
    const patches = [];
    const skipped = [];
    const queuedAt = new Date().toISOString();
    for (const email of requested) {
      const result = await this.candidate(email, { includeExisting });
      if (!result.ready) {
        skipped.push({ email, reason: result.reason });
        continue;
      }
      patches.push({
        email,
        expectedVersion: result.account.version,
        patch: {
          refiningJob: {
            status: 'pending',
            percent: 0,
            text: '等待提炼批次',
            error: null,
            queuedAt,
            ...(manualDispatch ? { manualDispatchAt: queuedAt } : {}),
            updatedAt: queuedAt,
          },
        },
      });
    }
    await this.accountStore.updateManyByEmail(patches);
    if (patches.length) this.notify();
    return { queued: patches.map((item) => item.email), skipped };
  }

  queueStage(settings = this.settings.getSecretConfig()) {
    return providerRuntimeSettings(settings).stage;
  }

  async enqueueCurrent() {
    const stage = this.queueStage();
    const emails = (await this.accountStore.list({ includeSecret: true, limit: null }))
      .filter((account) => (account.workflowStage || account.mailComStage) === stage)
      .map((account) => account.email);
    return this.queueEmails(emails, { includeExisting: true });
  }

  async enqueueNewCandidates() {
    const stage = this.queueStage();
    const emails = (await this.accountStore.list({ includeSecret: true, limit: null }))
      .filter((account) => (account.workflowStage || account.mailComStage) === stage)
      .map((account) => account.email);
    return this.queueEmails(emails, { includeExisting: false });
  }

  async retry(email, { manualDispatch = true } = {}) {
    const account = await this.accountStore.getByEmail(email, { includeSecret: true });
    if (account?.refiningJob && ACTIVE_STATUSES.has(account.refiningJob.status)) {
      return { queued: [], skipped: [{ email, reason: 'job_not_retryable' }] };
    }
    if (account?.refiningJob) await this.accountStore.updateByEmail({ email, expectedVersion: account.version, patch: { refiningJob: null } });
    const result = await this.queueEmails([email], { includeExisting: true, manualDispatch });
    if (result.queued.length) this.notify({ forceDispatch: true });
    return result;
  }

  async recoverRemoteUnknownAccounts() {
    const recovered = [];
    const now = new Date().toISOString();
    const accounts = await this.accountStore.list({ includeSecret: true, limit: null });
    for (const account of accounts) {
      if (!['refining', GCASH_STAGE].includes((account.workflowStage || account.mailComStage))) continue;
      if (account?.refiningJob?.status !== 'remote_unknown') continue;
      const provider = String(account.refiningJob?.config?.provider || '').trim();
      if (provider === 'public_cdk') continue;
      if (provider === 'gc_tacmon') {
        const localBatchId = String(account.refiningJob?.localBatchId || '').trim();
        if (localBatchId) {
          await this.runtime.updateBatch(localBatchId, {
            status: 'error',
            reservedCount: 0,
            error: account.refiningJob?.error || 'GC 提炼 提交未拿到远端任务号，已释放本地未知状态',
          });
        }
        await this.accountStore.updateByEmail({ email: account.email, expectedVersion: account.version, patch: {
          refiningJob: {
            ...account.refiningJob,
            status: 'pending',
            percent: 0,
            text: 'GC 提炼 远端任务号缺失，已释放旧状态，等待重新提交',
            error: null,
            localBatchId: null,
            remoteBatchId: null,
            remoteJobId: null,
            unknownAttempts: 0,
            nextDispatchAt: now,
            updatedAt: now,
          },
        } });
      } else {
        await this.accountStore.updateByEmail({ email: account.email, expectedVersion: account.version, patch: {
          refiningJob: {
            ...account.refiningJob,
            status: 'pending',
            percent: 0,
            text: '远端状态未知，等待幂等重试',
            nextDispatchAt: now,
            updatedAt: now,
          },
        } });
      }
      recovered.push(account.email);
    }
    return recovered;
  }

  async recoverStaleDispatchingAccounts() {
    const now = new Date().toISOString();
    const activeBatchIds = new Set();
    for (const batch of await this.runtime.activeBatches()) {
      if (batch?.id) activeBatchIds.add(String(batch.id));
      if (batch?.remoteBatchId) activeBatchIds.add(String(batch.remoteBatchId));
    }
    const patches = [];
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if (!['refining', GCASH_STAGE].includes((account.workflowStage || account.mailComStage))) continue;
      const job = account?.refiningJob;
      if (job?.status !== 'dispatching') continue;
      const localBatchId = String(job.localBatchId || '').trim();
      const remoteBatchId = String(job.remoteBatchId || '').trim();
      if ((localBatchId && activeBatchIds.has(localBatchId)) || (remoteBatchId && activeBatchIds.has(remoteBatchId))) continue;
      patches.push({
        email: account.email,
        expectedVersion: account.version,
        patch: {
          refiningJob: {
            ...job,
            status: 'pending',
            percent: 0,
            text: '上次提交被服务重启中断，等待重新提交',
            error: null,
            localBatchId: null,
            remoteBatchId: null,
            remoteJobId: null,
            nextDispatchAt: now,
            updatedAt: now,
          },
        },
      });
    }
    await this.accountStore.updateManyByEmail(patches);
    return patches.map((entry) => entry.email);
  }

  async recoverRemoteLostAccounts() {
    const now = new Date().toISOString();
    const patches = [];
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if ((account.workflowStage || account.mailComStage) !== 'refining') continue;
      const job = account?.refiningJob;
      if (job?.status !== 'remote_lost' || job?.config?.provider !== 'public_cdk') continue;
      const recoveryAttempts = Number(job.remoteRecoveryAttempts || 0);
      if (recoveryAttempts >= this.publicRemoteRecoveryLimit) continue;
      const previousRemoteBatchIds = [...new Set([
        ...(Array.isArray(job.previousRemoteBatchIds) ? job.previousRemoteBatchIds : []),
        job.remoteBatchId,
      ].map((value) => String(value || '').trim()).filter(Boolean))];
      patches.push({
        email: account.email,
        expectedVersion: account.version,
        patch: {
          refiningJob: {
            ...job,
            status: 'pending',
            percent: 0,
            text: `公共提炼远端状态已失效，正在重新提交（恢复 ${recoveryAttempts + 1}/${this.publicRemoteRecoveryLimit}）`,
            error: null,
            localBatchId: null,
            remoteBatchId: null,
            remoteJobId: null,
            remoteNotFoundAttempts: 0,
            remoteRecoveryAttempts: recoveryAttempts + 1,
            previousRemoteBatchIds,
            queuedAt: now,
            nextDispatchAt: now,
            updatedAt: now,
          },
        },
      });
    }
    await this.accountStore.updateManyByEmail(patches);
    return patches.map((entry) => entry.email);
  }

  async pendingAccounts(settings = this.settings.getSecretConfig()) {
    const output = [];
    const now = Date.now();
    const stage = this.queueStage(settings);
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if ((account.workflowStage || account.mailComStage) !== stage) continue;
      if (account?.refiningJob?.status !== 'pending') continue;
      const nextDispatchAt = Date.parse(account.refiningJob.nextDispatchAt || '');
      if (Number.isFinite(nextDispatchAt) && nextDispatchAt > now) continue;
      output.push(account);
    }
    return output.sort((a, b) => {
      const manualA = Date.parse(a.refiningJob.manualDispatchAt || '');
      const manualB = Date.parse(b.refiningJob.manualDispatchAt || '');
      const hasManualA = Number.isFinite(manualA);
      const hasManualB = Number.isFinite(manualB);
      if (hasManualA || hasManualB) {
        if (hasManualA && !hasManualB) return -1;
        if (!hasManualA && hasManualB) return 1;
        if (manualA !== manualB) return manualB - manualA;
      }
      return String(a.refiningJob.queuedAt).localeCompare(String(b.refiningJob.queuedAt));
    });
  }

  async activeAccountCount(settings = this.settings.getSecretConfig()) {
    let count = 0;
    const stage = this.queueStage(settings);
    const accounts = await this.accountStore.list({ includeSecret: true, limit: null });
    const byEmail = new Map(accounts.map((account) => [account.email, account]));
    for (const account of accounts) {
      if ((account.workflowStage || account.mailComStage) !== stage) continue;
      if (ACTIVE_STATUSES.has(account?.refiningJob?.status)) count += 1;
    }
    let dispatchingCount = 0;
    for (const email of this.gcTacmonDispatching) {
      const account = byEmail.get(email);
      if ((account?.workflowStage || account?.mailComStage) === stage) dispatchingCount += 1;
    }
    return count + dispatchingCount;
  }

  async moveCompletedAccountsToPendingPayment(emails = null) {
    const selected = emails ? new Set(emails.map((email) => String(email || '').trim().toLowerCase())) : null;
    const moved = [];
    const updates = [];
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if ((account.workflowStage || account.mailComStage) !== 'refining') continue;
      if (selected && !selected.has(account.email)) continue;
      if (account?.refiningJob?.status !== 'done') continue;
      if (!hasUsablePaymentArtifact(account)) continue;
      updates.push({
        email: account.email,
        expectedVersion: account.version,
        patch: { workflowStage: PENDING_PAYMENT_STAGE, mailComStage: PENDING_PAYMENT_STAGE, lifecycleStage: PENDING_PAYMENT_STAGE },
      });
      moved.push(account.email);
    }
    await this.accountStore.updateManyByEmail(updates);
    return moved;
  }

  async markCompletedRefiningWithoutBaToken() {
    const updates = [];
    const markedAt = new Date().toISOString();
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if ((account.workflowStage || account.mailComStage) !== 'refining' || account.refiningJob?.status !== 'done' || hasUsablePaymentArtifact(account)) continue;
      updates.push({ email: account.email, expectedVersion: account.version, patch: {
        refiningJob: {
          ...account.refiningJob,
          status: 'error',
          error: 'refining completed without a usable payment artifact',
          completedAt: account.refiningJob.completedAt || markedAt,
          updatedAt: markedAt,
        },
      } });
    }
    await this.accountStore.updateManyByEmail(updates);
    return updates.map((update) => update.email);
  }

  async discardFinalFailedAccounts(settings = this.settings.getSecretConfig()) {
    if (settings.deleteFailedAccounts === false) return [];
    const discarded = [];
    for (const account of await this.accountStore.list({ includeSecret: true, limit: null })) {
      if ((account.workflowStage || account.mailComStage) !== 'refining') continue;
      if (account.refiningJob?.status !== 'error'
        || (!account.refiningJob?.remoteJobId && !account.refiningJob?.completedAt)) continue;
      const result = await this.accountStore.discardUsableAccountByEmail(account.email, {
        reason: 'final_refining_failed',
      });
      if (result.discarded) discarded.push(account.email);
    }
    return discarded;
  }

  publicCdkLockKey(settings) {
    const cdk = String(settings?.publicCdk || '');
    return cdk ? crypto.createHash('sha256').update(cdk).digest('hex').slice(0, 24) : '';
  }

  async publicQuotaReservations(settings) {
    const lockKey = this.publicCdkLockKey(settings);
    return (await this.runtime.listBatches())
      .filter((batch) => batch.config?.provider === 'public_cdk'
        && (!batch.config?.cdkLockKey || batch.config.cdkLockKey === lockKey)
        && ['queued', 'running', 'cancelling', 'submission_unknown'].includes(batch.status))
      .reduce((sum, batch) => sum + Math.max(0, Number(batch.reservedCount || batch.emails?.length || 0)), 0);
  }

  publicServiceProxyForBatch(settings, batch) {
    const reference = batch?.config?.publicServiceProxy;
    if (!reference?.id) return null;
    const poolId = String(reference.poolId || settings.entryProxyPoolId || '').trim();
    if (!poolId) return null;
    return this.proxyPools.checkout.listRaw(poolId)
      .find((proxy) => proxy.id === reference.id) || null;
  }

  async pickPublicServiceProxy(settings) {
    const poolId = String(settings.entryProxyPoolId || '').trim();
    if (!poolId) throw new Error('公共提炼需要配置代理池1');
    const proxy = await this.proxyPools.checkout.pickNext({ poolId });
    if (!proxy) throw new Error('公共提炼代理池1没有可用代理');
    return proxy;
  }

  async activeGcTacmonProxyLines(field) {
    return new Set((await this.runtime.listBatches())
      .filter((batch) => batch.config?.provider === 'gc_tacmon'
        && ['queued', 'running', 'cancelling'].includes(batch.status))
      .flatMap((batch) => {
        const direct = batch.config?.[field];
        const legacyWorker = field === 'gcTacmonWorkerProxyLines' ? batch.config?.gcTacmonWorkerProxyLine : null;
        return [
          ...(Array.isArray(direct) ? direct : [direct]),
          legacyWorker,
        ];
      })
      .map((line) => String(line || '').trim())
      .filter(Boolean));
  }

  gcTacmonPoolLines(settings, label) {
    const poolId = String(label === '站点代理'
      ? settings.entryProxyPoolId
      : (settings.exitProxyPoolId || settings.entryProxyPoolId)).trim();
    if (!poolId) throw new Error(`GC 提炼需要配置${label}池`);
    const lines = proxyLines(this.proxyPools.checkout.listRaw(poolId).filter((proxy) => !isProxyCoolingDown(proxy)));
    if (!lines.length) throw new Error('GC 提炼所选代理池没有可用代理');
    return lines;
  }

  async pickGcTacmonProxyLine(settings, label, avoidLines = new Set()) {
    const lines = this.gcTacmonPoolLines(settings, label);
    const runtimeField = label === '站点代理' ? 'gcTacmonSiteProxyLine' : 'gcTacmonWorkerProxyLine';
    const used = await this.activeGcTacmonProxyLines(runtimeField);
    const avoided = new Set([
      ...used,
      ...Array.from(avoidLines || []).map((line) => String(line || '').trim()).filter(Boolean),
    ]);
    const selected = lines.find((line) => !avoided.has(line));
    if (!selected) throw new Error(`GC 提炼 ${label}没有空闲代理（当前运行任务/本账号失败代理已占满）`);
    return selected;
  }

  async pickGcTacmonProxyLines(settings, label, count, avoidLines = new Set()) {
    const lines = this.gcTacmonPoolLines(settings, label);
    const runtimeField = label === '站点代理' ? 'gcTacmonSiteProxyLine' : 'gcTacmonWorkerProxyLines';
    const used = await this.activeGcTacmonProxyLines(runtimeField);
    const avoided = new Set([
      ...used,
      ...Array.from(avoidLines || []).map((line) => String(line || '').trim()).filter(Boolean),
    ]);
    const selected = lines.filter((line) => !avoided.has(line)).slice(0, Math.max(1, Number(count) || 1));
    if (selected.length < Math.max(1, Number(count) || 1)) {
      throw new Error(`GC 提炼 ${label}可用代理不足：需要 ${Math.max(1, Number(count) || 1)} 条，只有 ${selected.length} 条`);
    }
    return selected;
  }

  async publicQuotaState(settings) {
    if (settings.provider !== 'public_cdk') return null;
    const lockKey = this.publicCdkLockKey(settings);
    const matching = (await this.runtime.listBatches()).find((batch) =>
      batch.config?.provider === 'public_cdk'
      && (!batch.config?.cdkLockKey || batch.config.cdkLockKey === lockKey)
      && Number.isFinite(Number(batch.quotaSnapshot?.remaining)));
    const remaining = matching ? Number(matching.quotaSnapshot.remaining) : null;
    const reserved = await this.publicQuotaReservations(settings);
    return {
      lastVerifiedRemaining: remaining,
      reserved,
      available: remaining === null ? null : Math.max(0, remaining - reserved),
    };
  }

  proxyPayload(settings, accountCount) {
    if (settings.provider === 'public_cdk' || settings.provider === 'gc_tacmon') {
      return { entry: [], exit: [], concurrency: Math.min(settings.concurrency, accountCount) };
    }
    const entry = settings.entryProxyPoolId ? proxyLines(this.proxyPools.checkout.listRaw(settings.entryProxyPoolId)) : [];
    const needsExit = TWO_POOL_LINK_TYPES.includes(settings.linkType);
    const exitPoolId = settings.exitProxyPoolId || settings.entryProxyPoolId;
    const exit = needsExit && exitPoolId ? proxyLines(this.proxyPools.checkout.listRaw(exitPoolId)) : [];
    const concurrency = Math.min(settings.concurrency, accountCount);
    const required = concurrency * effectiveRetryCount(settings);
    if (entry.length < required) {
      throw new Error(`入口代理池只有 ${entry.length} 条，当前并发和重试至少需要 ${required} 条`);
    }
    if (needsExit && exit.length < required) {
      throw new Error(`出口代理池只有 ${exit.length} 条，当前并发和重试至少需要 ${required} 条`);
    }
    return { entry, exit, concurrency };
  }

  buildPayload(settings, accounts) {
    const proxies = this.proxyPayload(settings, accounts.length);
    return {
      tokens: accounts.map((account) => account.tokens.accessToken),
      accounts: accounts.map((account) => ({
        email: account.email,
        access_token: account.tokens.accessToken,
      })),
      plan: settings.plan,
      link_type: settings.linkType,
      country: settings.country,
      currency: settings.currency,
      entry_proxies: proxies.entry,
      exit_proxies: proxies.exit,
      retry_count: effectiveRetryCount(settings),
      concurrency: proxies.concurrency,
      use_sen: settings.useSentinel,
      use_so: settings.useSentinel,
      use_promo: settings.plan === 'plus' && settings.usePromo,
      promo_campaign: settings.plan === 'plus' ? settings.promoCampaign : '',
      promo_code: settings.plan === 'team' ? settings.promoCode : '',
      workspace_name: settings.workspaceName,
      workspace_id: settings.workspaceId,
      seat_quantity: settings.seatQuantity,
      price_interval: settings.priceInterval,
      credit_quantity: settings.creditQuantity,
      paypal_proxy_route_mode: settings.paypalProxyRouteMode,
      paypal_extract_mode: settings.paypalExtractMode,
      paypal_custom_billing_country: settings.paypalCustomBillingCountry,
      paypal_promo_mode: settings.paypalPromoMode,
      gcash_promo_mode: settings.gcashPromoMode,
      pix_auto_kind: settings.pixAutoKind,
      pix_tax_id: settings.pixTaxId,
    };
  }

  async dispatchGcTacmonOne(settings, account, assigned) {
    const pending = [account];
    const gcTacmonSiteProxyLine = assigned.gcTacmonSiteProxyLine;
    const gcTacmonWorkerProxyLines = assigned.gcTacmonWorkerProxyLines;
    const gcTacmonWorkerProxyLine = gcTacmonWorkerProxyLines[0] || '';
    const localBatchId = String(account.refiningJob?.localBatchId || '').trim() || crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const snapshot = {
      ...publicConfigSnapshot(settings),
      gcTacmonSiteProxyLine,
      gcTacmonSiteProxyId: proxyLineId(gcTacmonSiteProxyLine),
      gcTacmonWorkerProxyLine,
      gcTacmonWorkerProxyLines,
      gcTacmonWorkerProxyId: proxyLineId(gcTacmonWorkerProxyLine),
      gcTacmonWorkerProxyIds: gcTacmonWorkerProxyLines.map((line) => proxyLineId(line)),
    };
    await this.accountStore.updateByEmail({ email: account.email, expectedVersion: account.version, patch: {
      refiningJob: {
        ...account.refiningJob,
        status: 'dispatching',
        text: '正在提交到 GC 提炼',
        localBatchId,
        config: snapshot,
        updatedAt: startedAt,
      },
    } });

    let payload;
    try {
      payload = this.buildPayload(settings, pending);
    } catch (error) {
      const latest = await this.accountStore.getByEmail(account.email, { includeSecret: true });
      if (!latest) return;
      await this.accountStore.updateByEmail({ email: account.email, expectedVersion: latest.version, patch: {
        refiningJob: {
          ...latest.refiningJob,
          status: 'error',
          percent: 100,
          text: '配置校验失败',
          error: String(error.message || error),
          updatedAt: new Date().toISOString(),
        },
      } });
      await this.runtime.setLastError(error);
      return;
    }

    try {
      const remote = await this.client.startBatch({
        ...settings,
        gcTacmonSiteProxy: proxyObjectFromLine(gcTacmonSiteProxyLine),
        gcTacmonWorkerProxyLine,
        gcTacmonWorkerProxyLines,
      }, payload, localBatchId);
      const remoteBatchId = String(remote.batch_id || '');
      if (!remoteBatchId) throw new Error('GC 提炼 accepted the request without a job id');
      await this.runtime.addBatch({
        id: localBatchId,
        remoteBatchId,
        status: 'queued',
        emails: [account.email],
        reservedCount: 0,
        quotaSnapshot: null,
        config: { ...snapshot, cdkLockKey: this.publicCdkLockKey(settings) },
        createdAt: startedAt,
        updatedAt: new Date().toISOString(),
      });
      const latest = await this.accountStore.getByEmail(account.email, { includeSecret: true });
      if (!latest) return;
      await this.accountStore.updateByEmail({ email: account.email, expectedVersion: latest.version, patch: {
        refiningJob: {
          ...latest.refiningJob,
          status: 'queued',
          percent: 2,
          text: '已进入 GC 提炼 队列',
          localBatchId,
          remoteBatchId,
          unknownAttempts: 0,
          nextDispatchAt: null,
          idempotentDispatch: true,
          config: snapshot,
          updatedAt: new Date().toISOString(),
        },
      } });
    } catch (error) {
      const definitelyRejected = error instanceof Pay153HttpError
        && error.status >= 400
        && error.status < 500
        && error.status !== 408;
      const now = Date.now();
      const unknownAttempts = Number(account.refiningJob?.unknownAttempts || 0) + 1;
      const retryDelayMs = Math.min(
        REMOTE_UNKNOWN_RETRY_MAX_MS,
        this.remoteUnknownRetryBaseMs * (2 ** Math.min(unknownAttempts - 1, 6)),
      );
      const triedSiteProxyLines = [...new Set([
        ...(Array.isArray(account.refiningJob?.gcTacmonTriedSiteProxyLines) ? account.refiningJob.gcTacmonTriedSiteProxyLines : []),
        gcTacmonSiteProxyLine,
      ].map((line) => String(line || '').trim()).filter(Boolean))];
      const triedWorkerProxyLines = [...new Set([
        ...(Array.isArray(account.refiningJob?.gcTacmonTriedWorkerProxyLines) ? account.refiningJob.gcTacmonTriedWorkerProxyLines : []),
        gcTacmonWorkerProxyLine,
        ...gcTacmonWorkerProxyLines,
      ].map((line) => String(line || '').trim()).filter(Boolean))];
      const latest = await this.accountStore.getByEmail(account.email, { includeSecret: true });
      if (!latest) return;
      await this.accountStore.updateByEmail({ email: account.email, expectedVersion: latest.version, patch: {
        refiningJob: {
          ...latest.refiningJob,
          status: definitelyRejected ? 'error' : 'pending',
          percent: definitelyRejected ? 100 : 0,
          text: definitelyRejected
            ? 'GC 提炼 明确拒绝任务'
            : `GC 提炼 提交失败，${Math.max(1, Math.ceil(retryDelayMs / 1000))} 秒后换代理重试`,
          error: String(error.message || error),
          localBatchId,
          unknownAttempts,
          gcTacmonTriedSiteProxyLines: triedSiteProxyLines,
          gcTacmonTriedWorkerProxyLines: triedWorkerProxyLines,
          nextDispatchAt: definitelyRejected ? null : new Date(now + retryDelayMs).toISOString(),
          idempotentDispatch: true,
          config: snapshot,
          updatedAt: new Date(now).toISOString(),
        },
      } });
      await this.runtime.setLastError(error);
    }
  }

  async dispatchGcTacmonPending(settings, pendingSource, availableSlots, runtimeSettings = providerRuntimeSettings(settings)) {
    const targetCount = Math.min(runtimeSettings.dispatchLimit, Math.max(0, availableSlots), pendingSource.length);
    if (!targetCount) return;
    const reservedSiteLines = new Set();
    const reservedWorkerLines = new Set();
    const assignments = [];
    for (const account of pendingSource) {
      if (assignments.length >= targetCount) break;
      if (this.gcTacmonDispatching.has(account.email)) continue;
      try {
        const avoidSiteLines = new Set([
          ...reservedSiteLines,
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedSiteProxyLines) ? account.refiningJob.gcTacmonTriedSiteProxyLines : []),
        ].map((line) => String(line || '').trim()).filter(Boolean));
        const avoidWorkerLines = new Set([
          ...reservedWorkerLines,
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedWorkerProxyLines) ? account.refiningJob.gcTacmonTriedWorkerProxyLines : []),
        ].map((line) => String(line || '').trim()).filter(Boolean));
        const gcTacmonSiteProxyLine = await this.pickGcTacmonProxyLine(settings, '站点代理', avoidSiteLines);
        avoidWorkerLines.add(gcTacmonSiteProxyLine);
        const gcTacmonWorkerProxyLines = await this.pickGcTacmonProxyLines(settings, '执行代理', effectiveRetryCount(settings), avoidWorkerLines);
        reservedSiteLines.add(gcTacmonSiteProxyLine);
        for (const line of gcTacmonWorkerProxyLines) reservedWorkerLines.add(line);
        assignments.push({ account, gcTacmonSiteProxyLine, gcTacmonWorkerProxyLines });
      } catch (error) {
        await this.runtime.setLastError(error);
      }
    }
    if (!assignments.length) return;
    for (const assignment of assignments) {
      this.gcTacmonDispatching.add(assignment.account.email);
      this.dispatchGcTacmonOne(settings, assignment.account, assignment)
        .catch((error) => this.runtime.setLastError(error))
        .finally(() => {
          this.gcTacmonDispatching.delete(assignment.account.email);
          this.notify();
        });
    }
  }

  async dispatchPending(settings, forceDispatch = false) {
    const runtimeSettings = providerRuntimeSettings(settings);
    const configuredConcurrency = runtimeSettings.concurrency;
    const activeCount = await this.activeAccountCount(settings);
    const availableSlots = Math.max(0, configuredConcurrency - activeCount);
    if (!availableSlots) return;
    let availablePending = await this.pendingAccounts(settings);
    if (forceDispatch) {
      availablePending = availablePending.filter((account) => Number.isFinite(
        Date.parse(account?.refiningJob?.manualDispatchAt || ''),
      ));
    }
    let quotaSnapshot = null;
    let quotaSlots = Number.POSITIVE_INFINITY;
    if (settings.provider === 'public_cdk') {
      try {
        quotaSnapshot = await this.client.availableQuota(settings);
        quotaSlots = Math.max(0, Number(quotaSnapshot.remaining || 0) - await this.publicQuotaReservations(settings));
      } catch (error) {
        await this.runtime.setLastError(error);
        return;
      }
      if (!quotaSlots) {
        const error = new Error('public CDK quota is exhausted or fully reserved by in-flight jobs');
        error.code = 'PUBLIC_CDK_QUOTA_LOCKED';
        await this.runtime.setLastError(error);
        return;
      }
    }
    const isGcTacmon = settings.provider === 'gc_tacmon';
    const retryBatchId = String(availablePending[0]?.refiningJob?.localBatchId || '').trim();
    const pendingSource = retryBatchId
      ? availablePending.filter((account) => account.refiningJob?.localBatchId === retryBatchId)
      : availablePending.filter((account) => !account.refiningJob?.localBatchId);
    if (!pendingSource.length) return;
    if (runtimeSettings.waitForBatchWindow && !forceDispatch && !retryBatchId && pendingSource.length < runtimeSettings.dispatchLimit) {
      const oldestQueuedAt = pendingSource
        .map((account) => Date.parse(account.refiningJob?.queuedAt || account.refiningJob?.manualDispatchAt || ''))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const batchWindowMs = runtimeSettings.batchWindowSeconds * 1000;
      if (!Number.isFinite(oldestQueuedAt) || Date.now() - oldestQueuedAt < batchWindowMs) return;
    }
    if (isGcTacmon) {
      await this.dispatchGcTacmonPending(settings, pendingSource, availableSlots, runtimeSettings);
      return;
    }
    const pending = pendingSource.slice(0, Math.min(30, runtimeSettings.dispatchLimit, availableSlots, quotaSlots));
    if (!pending.length) return;

    let publicTransportProxy = null;
    if (settings.provider === 'public_cdk') {
      try {
        publicTransportProxy = await this.pickPublicServiceProxy(settings);
      } catch (error) {
        await this.runtime.setLastError(error);
        return;
      }
    }

    const localBatchId = retryBatchId || crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const snapshot = {
      ...publicConfigSnapshot(settings),
      ...(publicTransportProxy ? {
        publicServiceProxy: publicServiceProxyReference(publicTransportProxy),
      } : {}),
    };
    await this.updateAccounts(pending, (account) => ({
        refiningJob: {
          ...account.refiningJob,
          status: 'dispatching',
          text: settings.provider === 'public_cdk'
            ? '正在提交到公共提炼服务'
            : settings.provider === 'gc_tacmon'
              ? '正在提交到 GC 提炼'
              : '正在提交到 PAY.153',
          localBatchId,
          config: snapshot,
          updatedAt: startedAt,
        },
      }));

    let payload;
    try {
      payload = this.buildPayload(settings, pending);
    } catch (error) {
      await this.updateAccounts(pending, (account) => ({
        refiningJob: { ...account.refiningJob, status: 'error', percent: 100, text: '配置校验失败', error: String(error.message || error), updatedAt: new Date().toISOString() },
      }));
      await this.runtime.setLastError(error);
      return;
    }

    try {
      const remote = await this.client.startBatch({
        ...settings,
        ...(publicTransportProxy ? { publicTransportProxy } : {}),
      }, payload, localBatchId);
      const remoteBatchId = String(remote.batch_id || '');
      if (!remoteBatchId) throw new Error('refining service accepted the request without a batch_id');
      await this.runtime.addBatch({
        id: localBatchId,
        remoteBatchId,
        status: 'queued',
        emails: pending.map((account) => account.email),
        reservedCount: settings.provider === 'public_cdk' ? pending.length : 0,
        quotaSnapshot,
        config: { ...snapshot, cdkLockKey: this.publicCdkLockKey(settings) },
        createdAt: startedAt,
        updatedAt: new Date().toISOString(),
      });
      await this.updateAccounts(pending, (account) => ({
          refiningJob: {
            ...account.refiningJob,
            status: 'queued',
            percent: 2,
            text: settings.provider === 'public_cdk'
              ? '已进入公共提炼队列（CDK 额度已预占）'
              : settings.provider === 'gc_tacmon'
                ? '已进入 GC 提炼 队列'
                : '已进入 PAY.153 队列',
            localBatchId,
            remoteBatchId,
              unknownAttempts: 0,
              nextDispatchAt: null,
              idempotentDispatch: this.client.supportsIdempotency?.(settings) !== false,
            config: snapshot,
            updatedAt: new Date().toISOString(),
          },
        }));
    } catch (error) {
      const definitelyRejected = error instanceof Pay153HttpError
        && error.status >= 400
        && error.status < 500
        && !(settings.provider === 'gc_tacmon' && error.status === 408);
      const idempotent = settings.provider === 'gc_tacmon' ? true : this.client.supportsIdempotency?.(settings) !== false;
      const submissionUnknown = !definitelyRejected && !idempotent;
      const now = Date.now();
      const failurePatches = pending.map((account) => {
        const unknownAttempts = Number(account.refiningJob?.unknownAttempts || 0) + 1;
        const retryDelayMs = Math.min(
          REMOTE_UNKNOWN_RETRY_MAX_MS,
          this.remoteUnknownRetryBaseMs * (2 ** Math.min(unknownAttempts - 1, 6)),
        );
        const triedSiteProxyLines = settings.provider === 'gc_tacmon' ? [...new Set([
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedSiteProxyLines) ? account.refiningJob.gcTacmonTriedSiteProxyLines : []),
          gcTacmonSiteProxyLine,
        ].map((line) => String(line || '').trim()).filter(Boolean))] : null;
        const triedWorkerProxyLines = settings.provider === 'gc_tacmon' ? [...new Set([
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedWorkerProxyLines) ? account.refiningJob.gcTacmonTriedWorkerProxyLines : []),
          gcTacmonWorkerProxyLine,
          ...gcTacmonWorkerProxyLines,
        ].map((line) => String(line || '').trim()).filter(Boolean))] : null;
        return {
          email: account.email,
          patch: {
            refiningJob: {
              ...account.refiningJob,
              status: definitelyRejected ? 'error' : (submissionUnknown ? 'remote_unknown' : 'pending'),
              percent: definitelyRejected ? 100 : 0,
              text: definitelyRejected
                ? (settings.provider === 'public_cdk'
                  ? '公共提炼服务明确拒绝任务，额度预占已释放'
                  : settings.provider === 'gc_tacmon'
                    ? 'GC 提炼 明确拒绝任务'
                    : 'PAY.153 拒绝任务')
                : (submissionUnknown
                  ? '公共提炼提交结果未知，CDK 额度继续锁定且不会自动重复提交'
                  : settings.provider === 'gc_tacmon'
                    ? `GC 提炼 提交失败，${Math.max(1, Math.ceil(retryDelayMs / 1000))} 秒后换代理重试`
                    : `PAY.153 连接失败，${Math.max(1, Math.ceil(retryDelayMs / 1000))} 秒后幂等重试`),
              error: String(error.message || error),
              localBatchId,
              unknownAttempts,
              ...(triedSiteProxyLines ? { gcTacmonTriedSiteProxyLines: triedSiteProxyLines } : {}),
              ...(triedWorkerProxyLines ? { gcTacmonTriedWorkerProxyLines: triedWorkerProxyLines } : {}),
              nextDispatchAt: definitelyRejected || submissionUnknown ? null : new Date(now + retryDelayMs).toISOString(),
              idempotentDispatch: idempotent,
              config: snapshot,
              updatedAt: new Date(now).toISOString(),
            },
          },
        };
      });
      const failureByEmail = new Map(failurePatches.map((entry) => [entry.email, entry.patch]));
      await this.updateAccounts(pending, (account) => failureByEmail.get(account.email));
      if (submissionUnknown) {
        await this.runtime.addBatch({
          id: localBatchId,
          remoteBatchId: '',
          status: 'submission_unknown',
          emails: pending.map((account) => account.email),
          reservedCount: settings.provider === 'public_cdk' ? pending.length : 0,
          quotaSnapshot,
          config: { ...snapshot, cdkLockKey: this.publicCdkLockKey(settings) },
          error: String(error.message || error),
          createdAt: startedAt,
          updatedAt: new Date(now).toISOString(),
        });
      }
      await this.runtime.setLastError(error);
    }
  }

  async reconcileBatch(settings, batch) {
    const batchSettings = { ...settings, provider: batch.config?.provider || settings.provider || 'pay153' };
    let remote;
    try {
      const publicTransportProxy = batchSettings.provider === 'public_cdk'
        ? this.publicServiceProxyForBatch(settings, batch)
        : null;
      const gcTacmonSiteProxy = batchSettings.provider === 'gc_tacmon'
        ? proxyObjectFromLine(batch.config?.gcTacmonSiteProxyLine)
        : null;
      if (batch.config?.publicServiceProxy?.id && !publicTransportProxy) {
        throw new Error('公共提炼批次绑定的代理已不在代理池中');
      }
      remote = await this.client.getBatch({
        ...batchSettings,
        ...(publicTransportProxy ? { publicTransportProxy } : {}),
        ...(gcTacmonSiteProxy ? { gcTacmonSiteProxy } : {}),
      }, batch.remoteBatchId);
    } catch (error) {
      if (error instanceof Pay153HttpError && error.status === 404) {
        const isPublic = batchSettings.provider === 'public_cdk';
        const notFoundAttempts = Number(batch.remoteNotFoundAttempts || 0) + 1;
        const confirmedLost = !isPublic || notFoundAttempts >= this.publicNotFoundConfirmations;
        const now = new Date().toISOString();
        const unresolvedPatches = [];
        for (const email of batch.emails) {
          const account = await this.accountStore.getByEmail(email, { includeSecret: true });
          if (!account || TERMINAL_REMOTE_STATUSES.has(account.refiningJob?.status)) continue;
          unresolvedPatches.push({
            email,
            expectedVersion: account.version,
            patch: {
              refiningJob: {
                ...(account.refiningJob || {}),
                status: confirmedLost ? 'remote_lost' : 'running',
                text: confirmedLost
                  ? (isPublic ? '公共提炼批次已连续查询不到，准备重新提交' : 'PAY.153 已无该批次状态')
                  : `公共提炼批次暂不可见，正在确认（${notFoundAttempts}/${this.publicNotFoundConfirmations}）`,
                error: confirmedLost ? 'remote_batch_not_found' : null,
                remoteNotFoundAttempts: notFoundAttempts,
                updatedAt: now,
              },
            },
          });
        }
        await this.accountStore.updateManyByEmail(unresolvedPatches);
        await this.runtime.updateBatch(batch.id, {
          status: confirmedLost ? 'remote_lost' : 'running',
          error: confirmedLost ? 'remote_batch_not_found' : null,
          remoteNotFoundAttempts: notFoundAttempts,
        });
      } else {
        await this.runtime.setLastError(error);
      }
      return;
    }

    const children = remote.children || [];
    const childrenByEmail = new Map(children.map((child) => [String(child.email || '').toLowerCase(), child]));
    const childrenByIndex = new Map(children.map((child, index) => [Number.isFinite(Number(child.index)) ? Number(child.index) : index, child]));
    const patches = [];
    for (const [index, email] of batch.emails.entries()) {
      const account = await this.accountStore.getByEmail(email, { includeSecret: true });
      const child = childrenByEmail.get(String(email).toLowerCase()) || childrenByIndex.get(index);
      if (!account) continue;
      const currentLocalBatchId = String(account.refiningJob?.localBatchId || '').trim();
      const currentRemoteBatchId = String(account.refiningJob?.remoteBatchId || '').trim();
      const batchLocalBatchId = String(batch.id || '').trim();
      const batchRemoteBatchId = String(batch.remoteBatchId || '').trim();
      const isCurrentBatch = (currentLocalBatchId && currentLocalBatchId === batchLocalBatchId)
        || (currentRemoteBatchId && currentRemoteBatchId === batchRemoteBatchId);
      if (!isCurrentBatch) continue;
      if (!child && String(remote.status || '').toLowerCase() === 'done') {
        patches.push({
          email,
          expectedVersion: account.version,
          patch: { refiningJob: {
            ...(account.refiningJob || {}),
            status: 'error',
            percent: 100,
            text: '提炼失败：远端批次结束但未返回该账号结果',
            error: 'remote_result_missing',
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          } },
        });
        continue;
      }
      if (!child) continue;
      const remoteChildStatus = remoteStatus(child.status);
      const result = child.result && typeof child.result === 'object' ? child.result : null;
      const resultUrl = result ? canonicalResultUrl(result) : '';
      const isMkGcashStage = batchSettings.provider === 'gc_tacmon' || (account.workflowStage || account.mailComStage) === GCASH_STAGE;
      const mkGcash = result?.mkGcash ? result : null;
      const completedWithoutMkGcash = remoteChildStatus === 'done' && isMkGcashStage && !mkGcash;
      const completedWithoutPaymentArtifact = remoteChildStatus === 'done' && !isMkGcashStage && !hasUsablePaymentArtifact({
        refiningJob: {
          ...(account.refiningJob || {}),
          result,
          resultUrl,
        },
      });
      const status = (completedWithoutPaymentArtifact || completedWithoutMkGcash) ? 'error' : remoteChildStatus;
      const childErrorText = String(child.error || child.text || '').trim();
      const childErrorKey = childErrorText.toLowerCase();
      const isGcTacmonCancelled = batchSettings.provider === 'gc_tacmon'
        && (status === 'cancelled' || childErrorKey === 'abandoned' || childErrorKey.includes('task_cancelled') || childErrorText.includes('用户已停止任务'));
      if (isGcTacmonCancelled) {
        const closedAt = new Date().toISOString();
        patches.push({
          email,
          expectedVersion: account.version,
          patch: {
            refiningJob: {
              ...(account.refiningJob || {}),
              status: 'done',
              percent: Number(child.percent || 0),
              text: 'GC 监控已关闭/取消，等待重新提炼',
              error: null,
              remoteJobId: null,
              remoteBatchId: null,
              localBatchId: null,
              nextDispatchAt: null,
              updatedAt: closedAt,
              completedAt: closedAt,
              gcashQr: {
                ...(account.refiningJob?.gcashQr || {}),
                status: 'closed',
                gcashState: 'closed',
                gcashStateReason: 'abandoned',
                authorizationStatus: 'closed_manually',
                browserAlive: false,
                closeReason: childErrorText || 'cancelled',
                closedAt,
                updatedAt: closedAt,
              },
            },
          },
        });
        continue;
      }
      const isGcTacmonRemoteFailure = batchSettings.provider === 'gc_tacmon' && status === 'error' && !completedWithoutMkGcash;
      const gcTacmonRemoteAttempts = Number(account.refiningJob?.gcTacmonRemoteAttempts || 0) + (isGcTacmonRemoteFailure ? 1 : 0);
      const gcTacmonRetryLimit = Math.max(1, Number(batch.config?.retryCount || settings.retryCount || 1));
      if (isGcTacmonRemoteFailure && gcTacmonRemoteAttempts < gcTacmonRetryLimit) {
        const retryAt = new Date(Date.now() + 5000).toISOString();
        const triedSiteProxyLines = [...new Set([
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedSiteProxyLines) ? account.refiningJob.gcTacmonTriedSiteProxyLines : []),
          batch.config?.gcTacmonSiteProxyLine,
        ].map((line) => String(line || '').trim()).filter(Boolean))];
        const triedWorkerProxyLines = [...new Set([
          ...(Array.isArray(account.refiningJob?.gcTacmonTriedWorkerProxyLines) ? account.refiningJob.gcTacmonTriedWorkerProxyLines : []),
          batch.config?.gcTacmonWorkerProxyLine,
          ...(Array.isArray(batch.config?.gcTacmonWorkerProxyLines) ? batch.config.gcTacmonWorkerProxyLines : []),
        ].map((line) => String(line || '').trim()).filter(Boolean))];
        patches.push({
          email,
          expectedVersion: account.version,
          patch: {
            refiningJob: {
              ...(account.refiningJob || {}),
              status: 'pending',
              percent: 0,
              text: `GC 提炼 远端失败，等待换代理重试（${gcTacmonRemoteAttempts}/${gcTacmonRetryLimit}）`,
              error: child.error ? String(child.error) : String(child.text || 'gc_tacmon_remote_failed'),
              remoteJobId: null,
              remoteBatchId: null,
              localBatchId: null,
              result: null,
              resultUrl: '',
              gcTacmonRemoteAttempts,
              gcTacmonTriedSiteProxyLines: triedSiteProxyLines,
              gcTacmonTriedWorkerProxyLines: triedWorkerProxyLines,
              nextDispatchAt: retryAt,
              updatedAt: new Date().toISOString(),
              completedAt: null,
            },
          },
        });
        continue;
      }
      const mkPaymentStatus = String(mkGcash?.paymentStatus || '').trim().toLowerCase();
      const mkPaid = Boolean(mkGcash?.paymentSuccess);
      const mkExpired = mkPaymentStatus === 'expired';
      const mkFailedStatus = ['callback_failed', 'callback_unconfirmed', 'failed'].includes(mkPaymentStatus);
      const mkAbandoned = mkPaymentStatus === 'abandoned';
      const mkUnavailable = mkPaymentStatus === 'unavailable';
      const mkFailed = (status === 'error' || mkFailedStatus) && !mkPaid && !mkAbandoned && !mkUnavailable;
      const mkGcashTerminalStatus = mkGcash
        ? (mkPaid || mkExpired || mkGcash?.qrReady || mkAbandoned || mkUnavailable ? 'done' : (mkFailed ? 'error' : status))
        : status;
      const mkGcashState = mkPaid
        ? 'plus_confirmed'
        : mkFailed
          ? 'failed'
          : mkExpired
            ? 'qr_expired'
            : mkAbandoned
              ? 'closed'
              : ['callback_processing'].includes(mkPaymentStatus)
                ? 'confirming'
                : ['redirect_captured'].includes(mkPaymentStatus)
                  ? 'scanned'
                  : mkGcash?.qrReady
                    ? 'qr_ready'
                    : (mkUnavailable ? 'idle' : 'extracting');
      const mkQrStatus = mkPaid
        ? 'completed'
        : mkFailed
          ? 'error'
          : mkExpired
            ? 'expired'
            : mkAbandoned
              ? 'closed'
              : mkGcash?.qrReady
                ? 'ready'
                : (mkUnavailable ? 'unavailable' : 'capturing');
      const existingGcashQr = account.refiningJob?.gcashQr || {};
      const mkGcashQr = mkGcash ? {
        ...existingGcashQr,
        status: mkQrStatus,
        gcashState: mkGcashState,
        gcashStateReason: mkPaid
          ? 'mk_payment_success'
          : mkFailed
            ? 'mk_task_failed'
            : (mkPaymentStatus || (mkGcash?.qrReady ? 'mk_qr_ready' : 'mk_extracting')),
        source: 'mk_gcash_local',
        sourceUrl: mkGcash.url || resultUrl || '',
        url: mkGcash.url || resultUrl || '',
        imageMime: 'image/png',
        imageBase64: mkGcash.qrImageBase64 || account.refiningJob?.gcashQr?.imageBase64 || '',
        screenshotKind: mkGcash.qrSource || account.refiningJob?.gcashQr?.screenshotKind || '',
        qrIssuedAt: mkGcash.qrReady && !account.refiningJob?.gcashQr?.qrIssuedAt ? new Date().toISOString() : account.refiningJob?.gcashQr?.qrIssuedAt || null,
        qrExpiresAt: mkGcash.expiresAt ? new Date(Number(mkGcash.expiresAt) * 1000).toISOString() : account.refiningJob?.gcashQr?.qrExpiresAt || null,
        refreshAvailable: Boolean(mkGcash.refreshAvailable),
        qrRefreshStatus: mkGcash.qrReady ? 'completed' : account.refiningJob?.gcashQr?.qrRefreshStatus || null,
        refreshCount: Number(mkGcash.qrVersion || account.refiningJob?.gcashQr?.refreshCount || 0),
        authorizationStatus: mkFailed
          ? 'authorization_error'
          : mkPaid || ['callback_processing', 'redirect_captured'].includes(mkPaymentStatus)
            ? 'continued'
            : 'waiting_phone_authorize',
        authorizationUpdatedAt: new Date().toISOString(),
        authorizationCompletedAt: mkPaid ? new Date().toISOString() : account.refiningJob?.gcashQr?.authorizationCompletedAt || null,
        browserAlive: !mkFailed && !['completed', 'error'].includes(mkQrStatus),
        error: mkFailed ? String(child.error || child.text || 'gcash_refining_failed') : null,
        mkJobId: mkGcash.mkJobId || '',
        mkAccountId: mkGcash.mkAccountId || '',
        mkPaymentStatus,
        gcashConfirmedPlus: mkPaid,
        gcashPostCheckoutStatus: mkPaid ? 'plus_confirmed' : (mkFailed ? (mkPaymentStatus || 'failed') : mkPaymentStatus),
        updatedAt: new Date().toISOString(),
      } : null;
      const keepExistingGcashQr = mkGcashQr && shouldKeepExistingGcashQr(existingGcashQr, mkGcashQr);
      const stableMkGcashQr = keepExistingGcashQr ? {
        ...mkGcashQr,
        ...existingGcashQr,
        status: 'ready',
        gcashState: 'qr_ready',
        gcashStateReason: existingGcashQr.gcashStateReason || 'waiting_scan',
        mkPaymentStatus: existingGcashQr.mkPaymentStatus || 'waiting_scan',
        authorizationStatus: existingGcashQr.authorizationStatus || 'waiting_phone_authorize',
        browserAlive: existingGcashQr.browserAlive !== false,
        lastMkTransientStatus: mkGcashQr.mkPaymentStatus || mkGcashQr.gcashStateReason || mkGcashQr.status || '',
        updatedAt: mkGcashQr.updatedAt,
      } : mkGcashQr;
      const mkPaidAccountPlanPatch = mkPaid ? {
        accountPlan: {
          ...(account.accountPlan || {}),
          status: 'plus',
          rawPlan: 'plus',
          hasActiveSubscription: true,
          checkedAt: new Date().toISOString(),
          source: 'mk_gcash_local',
          reason: 'mk_gcash_plus_confirmed',
        },
        accountPlanStatus: 'plus',
        accountPlanRaw: 'plus',
        accountPlanHasActiveSubscription: true,
        accountPlanLastCheckedAt: new Date().toISOString(),
      } : {};
      patches.push({
        email,
        expectedVersion: account.version,
        patch: {
          ...mkPaidAccountPlanPatch,
          refiningJob: {
            ...(account.refiningJob || {}),
            status: mkGcashTerminalStatus,
            percent: Number(child.percent || 0),
            text: completedWithoutMkGcash
              ? 'GC MK 提炼失败：远端未返回 MK GCash 状态'
              : (completedWithoutPaymentArtifact
                ? '提炼失败：未返回可用支付产物'
                : (keepExistingGcashQr
                  ? 'MK GCash 二维码/回调监控中：waiting_scan'
                  : (mkGcash && mkExpired
                    ? 'MK GCash 二维码已过期，请重新提炼'
                    : (mkGcash && mkPaid
                      ? 'MK GCash 已确认 Plus'
                      : (mkGcash && mkFailed
                        ? `MK GCash 失败：${mkPaymentStatus || 'failed'}`
                        : String(child.text || '')))))),
            error: completedWithoutMkGcash
              ? 'mk_gcash_result_missing'
              : (completedWithoutPaymentArtifact
                ? 'payment_artifact_not_available'
                : (child.error ? String(child.error) : null)),
            remoteJobId: child.job_id || account.refiningJob?.remoteJobId || null,
            result,
            resultUrl,
            ...(stableMkGcashQr ? { gcashQr: stableMkGcashQr } : {}),
            gcTacmonRemoteAttempts,
            updatedAt: new Date().toISOString(),
            completedAt: TERMINAL_REMOTE_STATUSES.has(mkGcashTerminalStatus) ? new Date().toISOString() : null,
          },
        },
      });
    }
    await this.accountStore.updateManyByEmail(patches);
    await this.moveCompletedAccountsToPendingPayment(
      patches.filter((entry) => entry.patch.refiningJob.status === 'done').map((entry) => entry.email),
    );
    const batchStatus = String(remote.status || 'running').toLowerCase();
    await this.runtime.updateBatch(batch.id, {
      status: batchStatus === 'done' || batchStatus === 'cancelled' ? batchStatus : 'running',
      summary: remote.summary || null,
      error: null,
    });
  }

  async cancelActive() {
    const settings = this.settings.getSecretConfig();
    const batches = await this.runtime.activeBatches();
    for (const batch of batches) {
      const batchSettings = { ...settings, provider: batch.config?.provider || settings.provider || 'pay153' };
      await this.client.cancelBatch(batchSettings, batch.remoteBatchId);
      await this.runtime.updateBatch(batch.id, { status: 'cancelling' });
    }
    this.notify();
    return { cancelled: batches.length };
  }

  async testConnection() {
    const settings = this.settings.getSecretConfig();
    const [health, capabilities] = await Promise.all([
      this.client.health(settings),
      this.client.capabilities(settings),
    ]);
    return { health, capabilities };
  }

  async gcashOverview(sourceAccounts = null) {
    const nowMs = Date.now();
    const summary = {
      total: 0,
      idle: 0,
      extracting: 0,
      qr_ready: 0,
      qr_expired: 0,
      scanned: 0,
      confirming: 0,
      plus_confirmed: 0,
      failed: 0,
      closed: 0,
    };
    const reasons = {};
    const accounts = [];
    const accountsInScope = sourceAccounts || await this.accountStore.list({
      mailComStages: [GCASH_STAGE],
      includeSecret: true,
      limit: null,
    });
    for (const account of accountsInScope) {
      if ((account.workflowStage || account.mailComStage) !== GCASH_STAGE) continue;
      const job = account?.refiningJob || {};
      const qr = job?.gcashQr || {};
      const normalized = gcashCanonicalStatus(account, account, nowMs);
      const state = normalized.state || 'idle';
      const reason = normalized.reason || normalized.stage || state;
      summary.total += 1;
      summary[state] = (summary[state] || 0) + 1;
      reasons[reason] = (reasons[reason] || 0) + 1;
      accounts.push({
        email: account.email,
        state,
        stage: normalized.stage || reason,
        label: normalized.label || '',
        reason,
        action: gcashActionForState(state, reason),
        detail: String(normalized.detail || '').slice(0, 500),
        mailComStage: (account.workflowStage || account.mailComStage),
        gcashSold: Boolean(account.gcashSold),
        accountPlanStatus: account?.accountPlan?.status || account?.accountPlanStatus || '',
        refiningStatus: job.status || '',
        refiningText: job.text || '',
        refiningError: job.error || '',
        qrStatus: qr.status || '',
        authorizationStatus: qr.authorizationStatus || '',
        postCheckoutStatus: qr.gcashPostCheckoutStatus || '',
        mkPaymentStatus: qr.mkPaymentStatus || '',
        gcashConfirmedPlus: qr.gcashConfirmedPlus === true,
        browserAlive: qr.browserAlive === true,
        qrExpiresAt: qr.qrExpiresAt || null,
        updatedAt: job.updatedAt || qr.updatedAt || account.updatedAt || account.createdAt || '',
      });
    }
    const rank = { extracting: 0, qr_ready: 1, qr_expired: 2, scanned: 3, confirming: 4, failed: 5, plus_confirmed: 6, closed: 7, idle: 8 };
    accounts.sort((a, b) => {
      const ra = rank[a.state] ?? 99;
      const rb = rank[b.state] ?? 99;
      if (ra !== rb) return ra - rb;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return { summary, reasons, accounts };
  }

  async overview() {
    const counts = {};
    const secretSettings = this.settings.getSecretConfig();
    const queueStage = this.queueStage(secretSettings);
    const secretAccounts = await this.accountStore.list({
      mailComStages: [...new Set([queueStage, GCASH_STAGE])],
      includeSecret: true,
      limit: null,
    });
    const refiningAccounts = secretAccounts.filter((account) => (account.workflowStage || account.mailComStage) === queueStage);
    for (const account of refiningAccounts) {
      const status = account.refiningJob?.status;
      if (status) counts[status] = (counts[status] || 0) + 1;
    }
    const ready = refiningAccounts.filter((account) => {
      return account?.status === 'registered'
        && eligibilityStatus(account) === 'eligible'
        && Boolean(String(account.tokens?.accessToken || '').trim())
        && !account.refiningJob;
    }).length;
    return {
      settings: this.settings.getPublicConfig(),
      runtime: await this.runtime.getPublicState(),
      publicQuota: await this.publicQuotaState(secretSettings),
      summary: { ...counts, ready },
      gcash: await this.gcashOverview(secretAccounts),
    };
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const forceDispatch = this.forceDispatch;
    this.forceDispatch = false;
    try {
      const settings = this.settings.getSecretConfig();
      await this.markCompletedRefiningWithoutBaToken();
      await this.discardFinalFailedAccounts(settings);
      await this.recoverStaleDispatchingAccounts();
      await this.recoverRemoteUnknownAccounts();
      await this.recoverRemoteLostAccounts();
      let hasPendingWork = (await this.pendingAccounts(settings)).length > 0;
      const activeBatches = await this.runtime.activeBatches();
      if (!settings.enabled && !forceDispatch) {
        for (const batch of activeBatches) await this.reconcileBatch(settings, batch);
        await this.discardFinalFailedAccounts(settings);
        return;
      }
      if (settings.enabled && !forceDispatch) await this.enqueueNewCandidates();
      if (forceDispatch && hasPendingWork) await this.dispatchPending(settings, true);
      for (const batch of activeBatches) await this.reconcileBatch(settings, batch);
      await this.discardFinalFailedAccounts(settings);
      hasPendingWork = (await this.pendingAccounts(settings)).length > 0;
      if (!forceDispatch && settings.enabled && hasPendingWork) await this.dispatchPending(settings, false);
    } finally {
      this.running = false;
    }
  }
}

module.exports = {
  RefiningCoordinator,
  eligibilityStatus,
  canonicalResultUrl,
  effectiveRetryCount,
  PENDING_PAYMENT_STAGE,
  GCASH_STAGE,
  ACTIVE_STATUSES,
  providerRuntimeSettings,
};
