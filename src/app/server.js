'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

const { registrationEntryBranchFromEnv } = require('./config');
const { requestBoundaryError } = require('./request-boundary');
const { REGISTRATION_CAPABILITIES, registrationOnly, assertRegistrationBranch, registrationApiAllowed, registrationCatalog } = require('./registration-profile');
const {
  buildPipelineConcurrencyPlan,
  adaptivePipelineConcurrency,
  refiningSettingsWithPipelineConcurrency,
} = require('../pipeline/concurrency-planner');
const {
  executionType,
  executionTypeForImplementation,
  fingerprintBrowser,
  publicExecutionCatalog,
  usesFingerprintBrowser,
} = require('../registration/execution-catalog');
const { RegistrationStore } = require('../db/registration-store');
const { MailboxStore } = require('../db/mailbox-store');
const { AccountAssetStore } = require('../db/account-asset-store');
const { RuntimeStateStore } = require('../db/runtime-state-store');
const { createProxyPools } = require('../proxies/proxy-pools');
const { RegistrationRunner } = require('../registration/runner');
const { parseRegistrationCandidates } = require('../registration/candidate-parser');
const { RegistrationChangeEmailSettings } = require('../registration/change-email-settings');
const { resolveRegistrationPassword } = require('../registration/registration-password');
const { EvidenceStore } = require('../collector/storage/evidence-store');
const { runAccountStatusCheck, runAccessTokenEligibilityCheck } = require('../eligibility/eligibility-checker');
const { runProtocolEligibilityCheck } = require('../eligibility/protocol-trial-checker');
const { rotateOpenAiRefreshToken } = require('../session/refresh-token-rotation');
const { refreshAccountAccessToken } = require('../session/access-token-refresh');
const {
  SESSION_COOKIE_NAME,
  renewAccountSessionCookie,
  upsertCookieHeaderValue,
  cookieHeaderFromCookies,
  isSessionTokenChunkName,
} = require('../session/session-cookie-renewal');
const { accountLoginStateSummary } = require('../session/account-login-state');
const {
  createPhoneBindSession,
  hasPhoneBindOauthQualification,
  isSub2ExchangeSessionExpired,
  recoverPhoneBindExchangeWithFreshAuthorization,
  reauthorizePhoneBindRefreshToken,
  replacePhoneBindNumber,
  replacePhoneBindNumberWithFreshAuthorization,
  retryPhoneBindExchange,
  restorePhoneBindSession,
  submitPhoneBindCode,
} = require('../phone/openai-phone-bind');
const { POOL_NAMES } = require('../proxies/proxy-pools');
const { CloudflareTempEmailSettings } = require('../mailbox/cloudflare-temp-email-settings');
const {
  isDefaultMailComAlias,
  parseMainAccountLine,
} = require('../mailbox/mail-com-split-settings');
const { MAIL_COM_STAGES } = require('../mailbox/mail-com-workflow');
const {
  MailComRegistrationControl,
  candidateAddress,
} = require('../mailbox/mail-com-registration-control');
const { PaymentSettings } = require('../payment/payment-settings');
const { PaymentMethodProbeSettings } = require('../payment/payment-method-probe-settings');
const { PaymentMethodProbeCoordinator } = require('../payment/payment-method-probe-coordinator');
const { PhoneBindSettings } = require('../phone/phone-bind-settings');
const { SmsNumberRotation } = require('../phone/smsbower-client');
const { AutomaticPhoneBindQueue } = require('../phone/automatic-phone-bind-queue');
const { phoneBindRetryPlan } = require('../phone/phone-bind-retry-policy');
const { PaymentCoordinator } = require('../payment/payment-coordinator');
const { RefiningSettings } = require('../refining/settings');
const { RefiningRuntimeStore } = require('../refining/runtime-store');
const { Pay153Client } = require('../refining/pay153-client');
const { RefiningCoordinator } = require('../refining/coordinator');
const {
  createCloudflareTempEmailAddress,
  listCloudflareTempEmailDomains,
} = require('../mailbox/providers/cloudflare-temp-email');
const { createMailComSplitAddress } = require('../mailbox/providers/mail-com-split');
const {
  addAddress: addMailComSplitAddress,
  closeSession: closeMailComSplitSession,
  emptyFolder: clearMailComSplitInbox,
  fetchAliasCode: fetchMailComSplitAliasCode,
  getSession: openMailComSplitSession,
  listAddresses: listMailComSplitAddresses,
  listDomains: listMailComSplitDomains,
  markSessionUnavailable: markMailComSplitSessionUnavailable,
  publicSession: publicMailComSplitSession,
  removeAddress: removeMailComSplitAddress,
} = require('../../tools/mail_com_split_mailbox');

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function cloudflareMailboxErrorPayload(error) {
  if (!error || !String(error.code || '').startsWith('MAILBOX_')) return null;
  return {
    error: error.code,
    message: String(error.message || error),
    workerStatus: error.status || null,
    workerBody: error.responseBody ? String(error.responseBody).slice(0, 800) : '',
  };
}

function mailComSplitErrorPayload(error) {
  if (!error) return null;
  const message = String(error.message || error);
  const match = message.match(/\(HTTP (\d{3})\)/i);
  return {
    error: error.code || 'MAIL_COM_SPLIT_FAILED',
    message,
    status: Number(error.status) || (match ? Number(match[1]) : 400),
    mainAccountRetired: Boolean(error.mainAccountRetired),
    mainAccountEmail: error.mainAccountEmail || null,
  };
}

function mailComMainAccountCatsConflict(error) {
  const message = String(error?.message || error || '');
  const isConflict = /HTTP\s*409|["']?status["']?\s*:\s*409/iu.test(message);
  const isCatsConflict = /urn:problem:mam:cats:request-conflict|masked by CATS/iu.test(message);
  return isConflict && isCatsConflict;
}

function phoneBindNumberNeedsReplacement(error) {
  const message = String(error?.message || error || '');
  return /invalid_phone_number|invalid phone number|phone number is invalid|phone number is not valid|phone_number_in_use|phone number already in use|use a different phone|fraud_guard|suspicious behavior from phone numbers|sms_limit_exceeded/iu.test(message);
}

function phoneBindAuthorizationStepInvalid(error) {
  return /invalid_auth_step|invalid authorization step|invalid_state|sign-in session is no longer valid|start over to continue/iu.test(
    String(error?.message || error || ''),
  );
}

function phoneBindAuthorizationLoginRequired(error) {
  return /PHONE_BIND_REAUTH_REQUIRED|auth\.openai 登录态已失效|需要重新完成邮箱验证|email-verification|\/log-in/iu.test(
    String(error?.message || error || ''),
  );
}

async function replacePhoneBindWithAutomaticNumber(session, rotation) {
  const activation = await rotation.next();
  try {
    let updated;
    try {
      updated = await replacePhoneBindNumber(session, activation.phone);
    } catch (error) {
      if (!phoneBindAuthorizationStepInvalid(error)) throw error;
      updated = await replacePhoneBindNumberWithFreshAuthorization(session, activation.phone);
    }
    updated.smsRotation = rotation;
    return updated;
  } catch (error) {
    if (phoneBindNumberNeedsReplacement(error)) await rotation.fail();
    else await rotation.cancel();
    throw error;
  }
}

function mailComSplitAccountView(account, session = null) {
  if (!account) return null;
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const availableDomains = (Array.isArray(account.availableDomains) ? account.availableDomains : [])
    .map((entry) => ({ ...entry, state: String(entry.state || '').toUpperCase() }));
  return {
    id: account.id,
    email: account.email,
    hasPassword: account.hasPassword ?? Boolean(account.password),
    aliases,
    aliasCount: aliases.length,
    historicalAliasCount: Number(account.historicalAliasCount || aliases.length),
    availableDomains,
    domainCount: availableDomains.length,
    activeDomainCount: availableDomains.filter((item) => item.state === 'ACTIVE').length,
    hiddenDomainCount: availableDomains.filter((item) => item.state !== 'ACTIVE').length,
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    session: session || publicMailComSplitSession(account),
  };
}

const MAIL_COM_SPLIT_ALIAS_LIMIT = 9;
const ACTIVE_REGISTRATION_JOB_STATUSES = new Set(['staged', 'queued', 'running', 'waiting_mail', 'retry_waiting']);
function accountSummaryView(account) {
  if (!account) return account;
  const {
    eligibilityLastResult,
    registrationEnvironment,
    eligibilityError,
    emailChange,
    passwordSetupError,
    totpSetupError,
    refreshTokenLastError,
    trialEligibility,
    paymentCapabilities,
    phoneBindOauthQualification,
    payment,
    ...summary
  } = account;
  return {
    ...summary,
    ...(trialEligibility ? { trialEligibility: { status: trialEligibility.status } } : {}),
    ...(paymentCapabilities ? { paymentCapabilities: {
      status: paymentCapabilities.status,
      methods: paymentCapabilities.methods,
      error: paymentCapabilities.error,
    } } : {}),
    ...(phoneBindOauthQualification ? { phoneBindOauthQualification: {
      qualified: phoneBindOauthQualification.qualified,
      accountSelectReached: phoneBindOauthQualification.accountSelectReached,
      addPhoneReached: phoneBindOauthQualification.addPhoneReached,
    } } : {}),
    ...(payment ? { payment: {
      jobId: payment.jobId,
      status: payment.status,
      error: payment.error,
    } } : {}),
  };
}

function normalizeEmailValue(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeDomainValue(value = '') {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function registrationProxyForAccount(account, proxyPools) {
  const reference = account?.registrationEnvironment?.proxy;
  return mainProxyForReference(
    reference,
    account?.registrationEnvironment?.proxyPoolId,
    proxyPools,
  );
}

function mainProxyForReference(reference, fallbackPoolId, proxyPools) {
  if (!reference || typeof reference !== 'object') return null;
  const poolId = String(reference.poolId || fallbackPoolId || '').trim();
  if (!poolId || !proxyPools?.main?.listRaw) return null;
  const proxies = proxyPools.main.listRaw(poolId);
  return proxies.find((proxy) => proxy.id === reference.id)
    || proxies.find((proxy) => (
      String(proxy.host || '') === String(reference.host || '')
      && String(proxy.port || '') === String(reference.port || '')
    ))
    || null;
}

function phoneBindProxyForAccount(account, proxyPools) {
  return mainProxyForReference(
    account?.phoneBindProxy,
    account?.phoneBindProxy?.poolId || account?.registrationEnvironment?.proxyPoolId,
    proxyPools,
  ) || registrationProxyForAccount(account, proxyPools);
}

function phoneBindProxyReference(proxy) {
  if (!proxy) return null;
  return {
    id: proxy.id,
    poolId: proxy.poolId,
    host: proxy.host,
    port: proxy.port,
    country: proxy.country || null,
  };
}

function proxyIsCoolingDown(proxy, now = Date.now()) {
  const until = Date.parse(String(proxy?.cooldownUntil || ''));
  return Number.isFinite(until) && until > now;
}

async function phoneBindProxyCandidates(account, proxyPools, limit = 3) {
  const savedReference = account?.phoneBindProxy;
  const registrationReference = account?.registrationEnvironment?.proxy;
  const poolId = String(
    savedReference?.poolId
      || registrationReference?.poolId
      || account?.registrationEnvironment?.proxyPoolId
      || '',
  ).trim();
  if (!poolId || !proxyPools?.main?.pickNext) return [];

  const saved = mainProxyForReference(savedReference, poolId, proxyPools);
  const registration = registrationProxyForAccount(account, proxyPools);
  const country = saved?.country || registration?.country || null;
  const candidates = [];
  const excludedIds = [];
  const add = (proxy) => {
    if (!proxy || proxyIsCoolingDown(proxy) || excludedIds.includes(proxy.id)) return;
    candidates.push(proxy);
    excludedIds.push(proxy.id);
  };
  add(saved);
  add(registration);
  while (candidates.length < limit) {
    const next = await proxyPools.main.pickNext({ poolId, country, excludeIds: excludedIds });
    if (!next) break;
    add(next);
  }
  return candidates.slice(0, limit);
}

async function gcashCheckoutProxyCandidates(account, proxyPools, limit = 4) {
  const registrationReference = account?.registrationEnvironment?.proxy;
  const poolId = String(
    registrationReference?.poolId
      || account?.registrationEnvironment?.proxyPoolId
      || '',
  ).trim();
  if (!poolId || !proxyPools?.main?.pickNext) return [];

  const registration = registrationProxyForAccount(account, proxyPools);
  const country = registration?.country || registrationReference?.country || null;
  const candidates = [];
  const excludedIds = [];
  const add = (proxy) => {
    if (!proxy || proxyIsCoolingDown(proxy) || excludedIds.includes(proxy.id)) return;
    candidates.push(proxy);
    excludedIds.push(proxy.id);
  };
  add(registration);
  while (candidates.length < limit) {
    const next = await proxyPools.main.pickNext({ poolId, country, excludeIds: excludedIds });
    if (!next) break;
    add(next);
  }
  return candidates.slice(0, limit);
}

function isPhoneBindTransportError(error) {
  const message = String(error?.message || error || '');
  return /curl:\s*\((?:5|6|7|28|35|52|55|56|60)\)|operation timed out|timed out after|connection timed out|connection reset|connection closed abruptly|empty reply|0 bytes received|certificate subject name|certificate verify|ssl certificate|peer certificate|CERTIFICATE_VERIFY_FAILED/i.test(message);
}

function phoneBindProxyAttemptLimit(settings = {}) {
  return 6;
}

function isPhoneBindProxyRetryableError(error) {
  const message = String(error?.message || error || '');
  if (phoneBindAuthorizationLoginRequired(error)) return false;
  if (phoneBindAuthorizationStepInvalid(error)) return false;
  if (isPhoneBindTransportError(error)) return true;
  const cloudflareChallenge = /<!DOCTYPE html|<title>Just a moment|challenges\.cloudflare\.com|cf-chl-/i.test(message);
  const openAiAuthUrlForbidden = /OpenAI auth-url failed:\s*HTTP 403/i.test(message);
  return openAiAuthUrlForbidden && cloudflareChallenge;
}

async function createPhoneBindSessionWithProxyFallback({
  account,
  proxyPools,
  createSession,
  maxAttempts = 3,
}) {
  const candidates = await phoneBindProxyCandidates(account, proxyPools, maxAttempts);
  const attempts = candidates.length ? candidates : [null];
  let lastError = null;
  let attemptCount = 0;
  for (let index = 0; index < attempts.length; index += 1) {
    const proxy = attempts[index];
    attemptCount += 1;
    try {
      return { session: await createSession(proxy), proxy, attemptCount };
    } catch (error) {
      lastError = error;
      error.phoneBindProxy = proxy || null;
      error.phoneBindProxyAttempts = attemptCount;
      if (!proxy || !isPhoneBindProxyRetryableError(error)) throw error;
      await proxyPools.main.markBad(proxy.id, {
        poolId: proxy.poolId,
        reason: `phone bind retryable failure: ${String(error?.message || error).slice(0, 240)}`,
      });
      if (index === attempts.length - 1) throw error;
    }
  }
  throw lastError || new Error('phone bind proxy selection failed');
}

function mailDomain(email = '') {
  const text = normalizeEmailValue(email);
  const at = text.lastIndexOf('@');
  return normalizeDomainValue(at >= 0 ? text.slice(at + 1) : text);
}

function shortErrorMessage(error) {
  return String(error?.message || error || 'unknown_error').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json body')); }
    });
    req.on('error', reject);
  });
}

function staticFile(publicDir, pathname, res, method = 'GET') {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, file);
  if (!target.startsWith(path.resolve(publicDir))) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  const type = ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';
  const stat = fs.statSync(target);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': stat.size,
    'last-modified': stat.mtime.toUTCString(),
  });
  if (method === 'HEAD') res.end();
  else fs.createReadStream(target).pipe(res);
  return true;
}

const UI_PREFERENCES_KEY = 'ui.preferences';
const DEFAULT_UI_PREFERENCES = Object.freeze({
  proxyPools: {},
  executionType: '',
  browserEngine: '',
  entryBranch: '',
});

async function createServerApp({
  config,
  registrationStore: injectedRegistrationStore = null,
  mailboxStore: injectedMailboxStore = null,
  accountAssetStore: injectedAccountAssetStore = null,
  refiningRuntimeStore: injectedRefiningRuntimeStore = null,
  runtimeStateStore: injectedRuntimeStateStore = null,
}) {
  const registrationProfile = registrationOnly(config);
  assertRegistrationBranch(config, config.registration.entryBranch);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const registrationStore = injectedRegistrationStore || new RegistrationStore();
  const mailboxStore = injectedMailboxStore || new MailboxStore();
  const accountAssetStore = injectedAccountAssetStore || new AccountAssetStore();
  const liveCheckState = new Map();
  const runtimeStateStore = injectedRuntimeStateStore || new RuntimeStateStore({ pool: accountAssetStore.pool });
  const proxyPools = createProxyPools({ store: runtimeStateStore });
  const cloudflareTempEmailSettings = new CloudflareTempEmailSettings({
    store: runtimeStateStore,
    defaults: config.mailbox.cloudflareTempEmail,
  });
  const recoveredRegistrationJobs = await registrationStore.recoverExpiredJobs({
    reason: 'service restarted after worker lease expiration',
  });
  await mailboxStore.resetObservedOpenSessions();
  const refiningSettingsStore = new RefiningSettings({
    store: runtimeStateStore,
  });
  const pipelinePlanState = {
    base: buildPipelineConcurrencyPlan({
      registrationConcurrency: config.mailbox?.mailComSplit?.autoStartConcurrency || 1,
    }),
    plan: null,
    updatedAt: null,
  };
  let mailComRegistrationControl = null;
  pipelinePlanState.plan = pipelinePlanState.base;
  const pipelineSettings = {
    getSecretConfig: () => refiningSettingsWithPipelineConcurrency(
      refiningSettingsStore.getSecretConfig(),
      pipelinePlanState.plan,
    ),
    getPublicConfig: () => refiningSettingsWithPipelineConcurrency(
      refiningSettingsStore.getPublicConfig(),
      pipelinePlanState.plan,
    ),
    initialize: (...args) => refiningSettingsStore.initialize(...args),
    update: (...args) => refiningSettingsStore.update(...args),
  };
  const refiningRuntime = registrationProfile ? null : injectedRefiningRuntimeStore || new RefiningRuntimeStore({ pool: accountAssetStore.pool });
  const refiningCoordinator = registrationProfile ? null : new RefiningCoordinator({
    accountStore: accountAssetStore,
    proxyPools,
    settings: pipelineSettings,
    runtime: refiningRuntime,
    client: new Pay153Client({ config }),
  });
  const paymentSettings = new PaymentSettings({ store: runtimeStateStore });
  const paymentMethodProbeSettings = new PaymentMethodProbeSettings({ store: runtimeStateStore });
  const registrationChangeEmailSettings = new RegistrationChangeEmailSettings({ store: runtimeStateStore });
  const phoneBindSettings = new PhoneBindSettings({ store: runtimeStateStore });
  await Promise.all([
    cloudflareTempEmailSettings.initialize(),
    refiningSettingsStore.initialize(),
    paymentSettings.initialize(),
    paymentMethodProbeSettings.initialize(),
    registrationChangeEmailSettings.initialize(),
    phoneBindSettings.initialize(),
    proxyPools.initialize(),
  ]);
  const refreshPipelinePlan = async () => {
    const poolSettings = await mailboxStore.getPoolSettings();
    pipelinePlanState.base = buildPipelineConcurrencyPlan({
      registrationConcurrency: poolSettings.concurrency,
    });
    return pipelinePlanState.base;
  };
  await refreshPipelinePlan();
  const mergeAdaptivePipelinePlan = (adaptive, { registrationQueued = 0, registrationWaitingMs = 0 } = {}) => ({
    ...pipelinePlanState.base,
    mode: 'adaptive_resource_budget',
    updatedAt: new Date().toISOString(),
    adaptive,
    stages: Object.fromEntries(Object.entries(pipelinePlanState.base.stages).map(([key, stage]) => {
      if (key === 'registration') return [key, {
        ...stage,
        active: adaptive.registrationConcurrency,
        demand: adaptive.registrationConcurrency + Math.max(0, Number(registrationQueued) || 0),
        waitingMs: Math.max(0, Number(registrationWaitingMs) || 0),
        effectiveConcurrency: adaptive.registrationAdmissionOpen ? stage.concurrency : 0,
        admissionOpen: adaptive.registrationAdmissionOpen,
      }];
      return [key, {
        ...stage,
        concurrency: adaptive.stages[key]?.concurrency || 0,
        active: adaptive.stages[key]?.active || 0,
        demand: adaptive.stages[key]?.requested || 0,
        maxConcurrency: adaptive.stages[key]?.maxConcurrency || 0,
      }];
    })),
  });
  pipelinePlanState.plan = mergeAdaptivePipelinePlan(adaptivePipelineConcurrency({
    plan: pipelinePlanState.base,
    active: { registration: 0 },
    demand: {},
    telemetry: { load1: os.loadavg()[0], freeMemoryMb: Math.round(os.freemem() / 1024 / 1024) },
  }));
  let pipelinePlanTimer = null;
  await runtimeStateStore.initializeSetting(UI_PREFERENCES_KEY, DEFAULT_UI_PREFERENCES);
  const getUiPreferences = async () => {
    const stored = (await runtimeStateStore.getSetting(UI_PREFERENCES_KEY))?.value || {};
    const saved = registrationProfile ? { ...stored,
      entryBranch: ['freepp'].includes(stored.entryBranch) ? stored.entryBranch : config.registration.entryBranch,
      executionType: 'protocol', browserEngine: '', proxyPools: { main: stored.proxyPools?.main || '', eligibility: stored.proxyPools?.eligibility || '' },
    } : stored;
    const branch = executionTypeForImplementation(saved.entryBranch || config.registration.entryBranch);
    const type = executionType(saved.executionType) || branch;
    return {
      ...DEFAULT_UI_PREFERENCES,
      ...saved,
      proxyPools: { ...(saved.proxyPools || {}) },
      executionType: type?.key || '',
    };
  };

  const resolveTaskExecutionSelection = (body = {}, { fallbackBranch = config.registration.entryBranch } = {}) => {
    const entryBranch = registrationEntryBranchFromEnv({
      REGISTRATION_ENTRY_BRANCH: body.entryBranch || fallbackBranch,
    });
    assertRegistrationBranch(config, entryBranch);
    const type = executionTypeForImplementation(entryBranch);
    const requestedType = body.executionType === undefined || body.executionType === null || body.executionType === ''
      ? type
      : executionType(body.executionType);
    if (!requestedType) {
      const error = new Error(`unsupported execution type: ${body.executionType}`);
      error.code = 'EXECUTION_TYPE_UNSUPPORTED';
      error.retryableProxy = false;
      throw error;
    }
    if (!type || requestedType.key !== type.key) {
      const error = new Error(`execution type ${requestedType.key} does not contain implementation ${entryBranch}`);
      error.code = 'EXECUTION_TYPE_IMPLEMENTATION_MISMATCH';
      error.retryableProxy = false;
      throw error;
    }
    const browser = body.browserEngine ? fingerprintBrowser(body.browserEngine) : null;
    if (body.browserEngine && !browser) {
      const error = new Error(`unsupported fingerprint browser: ${body.browserEngine}`);
      error.code = 'FINGERPRINT_BROWSER_UNSUPPORTED';
      error.retryableProxy = false;
      throw error;
    }
    if (browser && !usesFingerprintBrowser(entryBranch)) {
      const error = new Error(`fingerprint browser does not apply to protocol implementation ${entryBranch}`);
      error.code = 'FINGERPRINT_BROWSER_NOT_APPLICABLE';
      error.retryableProxy = false;
      throw error;
    }
    return {
      executionType: type.key,
      entryBranch,
      browserEngine: usesFingerprintBrowser(entryBranch) ? browser?.key || null : null,
    };
  };

  const activePhoneBinds = new Map();
  const phoneBindPressure = {
    adaptiveLimit: 30,
    recoveryAt: 0,
    lastIncreaseAt: 0,
    rateLimitSignals: [],
  };

  const activeRefreshTokenRuns = new Set();
  const activeSessionCookieRenewals = new Set();
  const internalPost = async (pathname, body = {}) => {
    let response;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${config.port}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signlist-internal': '1' },
          body: JSON.stringify(body),
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    if (!response) throw lastError || new Error('internal phone bind request failed');
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.code = payload.error || 'AUTO_PHONE_BIND_FAILED';
      throw error;
    }
    return payload;
  };

  const automaticPhoneBindEnabled = () => {
    const settings = phoneBindSettings.getSecretConfig();
    return !registrationProfile && Boolean(settings.autoEnabled && settings.smsApiKey);
  };

  const phoneBindRuntimeLimit = () => {
    const now = Date.now();
    if (
      phoneBindPressure.adaptiveLimit < 30
      && now >= phoneBindPressure.recoveryAt
      && now - phoneBindPressure.lastIncreaseAt >= 30_000
    ) {
      phoneBindPressure.adaptiveLimit += 1;
      phoneBindPressure.lastIncreaseAt = now;
    }
    return phoneBindPressure.adaptiveLimit;
  };

  const automaticPhoneBindConcurrency = () => Math.min(
    Math.max(0, Math.min(30, Math.trunc(Number(pipelinePlanState.plan.stages.phoneBind.concurrency) || 0))),
    phoneBindRuntimeLimit(),
  );

  const appendPhoneBindAttempt = (account, entry) => [
    ...(Array.isArray(account?.phoneBindAttemptHistory) ? account.phoneBindAttemptHistory : []),
    entry,
  ].slice(-40);

  const observePhoneBindPressure = ({ email, plan, account }) => {
    if (plan.kind !== 'rate_limit') return;
    const now = Date.now();
    const proxyId = String(account?.phoneBindProxy?.id || account?.registrationEnvironment?.proxy?.id || 'direct');
    phoneBindPressure.rateLimitSignals = [
      ...phoneBindPressure.rateLimitSignals.filter((item) => now - item.at <= 30_000),
      { at: now, key: `${email}|${proxyId}` },
    ];
    const distinct = new Set(phoneBindPressure.rateLimitSignals.map((item) => item.key));
    if (distinct.size < 3) return;
    const current = phoneBindRuntimeLimit();
    phoneBindPressure.adaptiveLimit = Math.max(1, Math.floor(current / 2));
    phoneBindPressure.recoveryAt = now + 60_000;
    phoneBindPressure.lastIncreaseAt = now;
    phoneBindPressure.rateLimitSignals = [];
  };

  const recordPhoneBindSuccess = () => {
    const now = Date.now();
    if (
      phoneBindPressure.adaptiveLimit < 30
      && now >= phoneBindPressure.recoveryAt
      && now - phoneBindPressure.lastIncreaseAt >= 30_000
    ) {
      phoneBindPressure.adaptiveLimit += 1;
      phoneBindPressure.lastIncreaseAt = now;
    }
  };

  let automaticPhoneBindQueue;
  const runAutomaticPhoneBind = async (key) => {
    const before = await accountAssetStore.getByEmail(key, { includeSecret: true });
    if (!before || (before.workflowStage || before.mailComStage) !== MAIL_COM_STAGES.SMS) return;
    if (!before || before.phoneBindStatus === 'completed') return;
    const startedAt = new Date().toISOString();
    const encodedEmail = encodeURIComponent(key);
    await accountAssetStore.updateByEmail({ email: key, expectedVersion: before.version, patch: {
      phoneBindStatus: before.phoneBindStatus === 'rt_pending' ? 'rt_pending' : 'starting',
      phoneBindQueuePosition: null,
      phoneBindLastRunAt: startedAt,
      phoneBindQueueError: null,
    } });
    try {
      let completed;
      if (before.phoneBindStatus === 'rt_pending') {
        completed = await internalPost(`/api/accounts/${encodedEmail}/phone-bind/auto-retry`, {});
      } else {
        const liveAutomaticSession = activePhoneBinds.get(key)?.smsRotation;
        const started = liveAutomaticSession && before.phoneBindStatus === 'otp_required'
          ? { status: 'otp_required' }
          : await internalPost(`/api/accounts/${encodedEmail}/phone-bind`, {});
        completed = started.status === 'otp_required'
          ? await internalPost(`/api/accounts/${encodedEmail}/phone-bind/code`, {})
          : started;
      }
      if (completed.status !== 'completed') {
        throw new Error(`automatic phone bind stopped at ${completed.status || 'unknown'}`);
      }
      const completedAccount = await accountAssetStore.getByEmail(key, { includeSecret: true });
      if (!completedAccount) throw new Error(`account disappeared during phone bind: ${key}`);
      await accountAssetStore.updateByEmail({ email: key, expectedVersion: completedAccount.version, patch: {
        phoneBindRetryKind: null,
        phoneBindRetryCount: 0,
        phoneBindNextRetryAt: null,
        phoneBindQueuePosition: null,
        phoneBindAttemptHistory: appendPhoneBindAttempt(completedAccount, {
          at: new Date().toISOString(),
          startedAt,
          outcome: 'completed',
          phoneAttempt: Number(completedAccount.phoneBindSmsAttempt || 0),
          proxyAttempts: Number(completedAccount.phoneBindProxyAttempt || 0),
        }),
        workflowStage: MAIL_COM_STAGES.COMPLETED,
        mailComStage: MAIL_COM_STAGES.COMPLETED,
        lifecycleStage: MAIL_COM_STAGES.COMPLETED,
      } });
      recordPhoneBindSuccess();
    } catch (error) {
      const currentAccount = await accountAssetStore.getByEmail(key, { includeSecret: true });
      if (!currentAccount) throw error;
      const detailedError = new Error(String(error?.message || currentAccount.phoneBindError?.message || error));
      detailedError.code = error?.code || currentAccount.phoneBindError?.code;
      const plan = phoneBindRetryPlan({
        error: detailedError,
        account: currentAccount,
        settings: phoneBindSettings.getSecretConfig(),
      });
      observePhoneBindPressure({ email: key, plan, account: currentAccount });
      if (plan.kind === 'rate_limit' && currentAccount.phoneBindProxy?.id) {
        await proxyPools.main.markBad(currentAccount.phoneBindProxy.id, {
          poolId: currentAccount.phoneBindProxy.poolId,
          reason: 'OpenAI phone verification rate limit',
        });
      }
      const restoredPhoneAttempt = plan.consumesNumber
        ? Number(currentAccount.phoneBindSmsAttempt || 0)
        : Number(before.phoneBindSmsAttempt || 0);
      await accountAssetStore.updateByEmail({ email: key, expectedVersion: currentAccount.version, patch: {
        phoneBindStatus: plan.retry
          ? (plan.kind === 'rt' ? 'rt_pending' : 'retry_wait')
          : 'failed',
        phoneBindSmsAttempt: restoredPhoneAttempt,
        phoneBindRetryKind: plan.kind,
        phoneBindRetryCount: plan.retryCount,
        phoneBindNextRetryAt: plan.nextRetryAt,
        phoneBindQueuePosition: null,
        phoneBindError: {
          code: detailedError.code || 'AUTO_PHONE_BIND_FAILED',
          message: String(detailedError.message || detailedError),
          retryKind: plan.kind,
          retryAt: plan.nextRetryAt,
        },
        phoneBindAttemptHistory: appendPhoneBindAttempt(currentAccount, {
          at: new Date().toISOString(),
          startedAt,
          outcome: plan.retry ? 'retry_wait' : 'failed',
          kind: plan.kind,
          phoneAttempt: restoredPhoneAttempt,
          maxNumbers: plan.maxNumbers,
          proxyAttempts: Number(currentAccount.phoneBindProxyAttempt || 0),
          nextRetryAt: plan.nextRetryAt,
          message: String(detailedError.message || detailedError).slice(0, 500),
        }),
      } });
    }
  };

  const recordAutomaticPhoneBindQueueError = async (error, context = {}) => {
    const key = String(context.email || error?.accountEmail || '').trim().toLowerCase();
    console.error('automatic phone bind queue failed', context.operation || 'unknown', key, error);
    if (!key) return;
    await accountAssetStore.updateByEmail({ email: key, patch: {
      phoneBindQueueError: {
        operation: context.operation || 'unknown',
        code: error?.code || 'PHONE_BIND_QUEUE_FAILED',
        message: String(error?.message || error).slice(0, 500),
        at: new Date().toISOString(),
      },
    } });
  };

  const syncAutomaticPhoneBindQueuePositions = async (snapshot) => {
    for (const [index, entry] of snapshot.pending.entries()) {
      try {
        const account = await accountAssetStore.getByEmail(entry.email);
        if (!account || account.phoneBindQueuePosition === index + 1) continue;
        await accountAssetStore.updateByEmail({
          email: entry.email,
          expectedVersion: account.version,
          patch: { phoneBindQueuePosition: index + 1 },
        });
      } catch (error) {
        error.accountEmail = entry.email;
        throw error;
      }
    }
  };

  automaticPhoneBindQueue = registrationProfile ? null : new AutomaticPhoneBindQueue({
    getConcurrency: automaticPhoneBindConcurrency,
    run: runAutomaticPhoneBind,
    onChange: syncAutomaticPhoneBindQueuePositions,
    onError: recordAutomaticPhoneBindQueueError,
  });

  const scheduleAutomaticPhoneBind = async ({ email, force = false } = {}) => {
    if (registrationProfile) return false;
    const key = String(email || '').trim().toLowerCase();
    if (!key) return false;
    let initialAccount = await accountAssetStore.getByEmail(key, { includeSecret: true });
    if (!initialAccount || ![MAIL_COM_STAGES.PAID, MAIL_COM_STAGES.SMS].includes(initialAccount.workflowStage || initialAccount.mailComStage)) return false;
    if ((initialAccount.workflowStage || initialAccount.mailComStage) === MAIL_COM_STAGES.PAID) {
      await accountAssetStore.updateByEmail({
        email: key,
        expectedVersion: initialAccount.version,
        patch: { workflowStage: MAIL_COM_STAGES.SMS, mailComStage: MAIL_COM_STAGES.SMS, lifecycleStage: MAIL_COM_STAGES.SMS },
      });
      initialAccount = await accountAssetStore.getByEmail(key, { includeSecret: true });
    }
    if (!automaticPhoneBindEnabled()) return false;
    if (!initialAccount || initialAccount.phoneBindStatus === 'completed') return false;
    if (!force && initialAccount.phoneBindStatus === 'failed') return false;
    const nextRetryAt = Date.parse(initialAccount.phoneBindNextRetryAt || '');
    if (!force && Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) return false;
    if (initialAccount.phoneBindStatus !== 'rt_pending') {
      await accountAssetStore.updateByEmail({ email: key, expectedVersion: initialAccount.version, patch: {
        phoneBindStatus: 'queued',
        phoneBindQueuePosition: automaticPhoneBindQueue.snapshot().pending.length + 1,
        phoneBindQueueError: null,
      } });
    }
    return automaticPhoneBindQueue.enqueue(key, { force, notBefore: nextRetryAt });
  };

  const scheduleAutomaticPhoneBindAfterPayment = ({ email }) => scheduleAutomaticPhoneBind({ email });

  const paymentMethodProbeCoordinator = registrationProfile ? null : new PaymentMethodProbeCoordinator({
    accountStore: accountAssetStore,
    proxyPools,
    settings: paymentMethodProbeSettings,
    refiningSettings: pipelineSettings,
    getConcurrency: () => pipelinePlanState.plan.stages.paymentMethod.concurrency,
  });
  await paymentMethodProbeCoordinator?.recoverStaleStatuses();
  const schedulePaymentMethodProbeAfterRegistration = (email) => (
    paymentMethodProbeCoordinator
      ? paymentMethodProbeCoordinator.schedule(email, { reason: 'registration_completed' })
      : Promise.resolve({ scheduled: false, reason: 'feature_disabled' })
  );

  const reconcileAutomaticPhoneBinds = async () => {
    if (!automaticPhoneBindEnabled()) return;
    const candidates = await accountAssetStore.list({ includeSecret: true, limit: null });
    for (const account of candidates) {
      if ((account.workflowStage || account.mailComStage) !== MAIL_COM_STAGES.SMS) continue;
      try {
        await scheduleAutomaticPhoneBind({ email: account.email });
      } catch (error) {
        await recordAutomaticPhoneBindQueueError(error, { operation: 'reconcile', email: account.email });
      }
    }
  };
  const automaticPhoneBindReconciler = registrationProfile ? null : setInterval(() => {
    reconcileAutomaticPhoneBinds().catch((error) => {
      console.error('automatic phone bind reconciliation failed', error);
    });
  }, 3000);
  automaticPhoneBindReconciler?.unref();

  const paymentCoordinator = registrationProfile ? null : new PaymentCoordinator({
    accountStore: accountAssetStore,
    proxyPools,
    settings: paymentSettings,
    intervalMs: paymentSettings.getSecretConfig().pollIntervalMs,
    getConcurrency: () => pipelinePlanState.plan.stages.finalPayment.concurrency,
    onPaymentCompleted: scheduleAutomaticPhoneBindAfterPayment,
    onFinalPaymentFailed: ({ email }) => accountAssetStore.discardUsableAccountByEmail(email, {
      reason: 'final_payment_failed',
    }),
  });
  paymentCoordinator?.start();
  const runner = new RegistrationRunner({
    config,
    registrationStore,
    accountAssetStore,
    mailboxStore,
    proxyPools,
    runtimeStateStore,
    mailboxSettings: cloudflareTempEmailSettings,
    phoneBindSettings,
    changeEmailSettings: registrationChangeEmailSettings,
    paymentMethodProbeScheduler: registrationProfile ? null : schedulePaymentMethodProbeAfterRegistration,
  });
  void recoveredRegistrationJobs;
  await refiningCoordinator?.start();
  let pipelinePlanRefreshing = false;
  const waitingMs = (value) => {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : 0;
  };
  const availableProxyCount = (category, poolId) => {
    const id = String(poolId || '').trim();
    if (!id || !proxyPools?.[category]?.list) return 0;
    return proxyPools[category].list(id).filter((proxy) => proxy.status !== 'cooldown').length;
  };
  const refreshAdaptivePipelinePlan = async () => {
    if (pipelinePlanRefreshing) return pipelinePlanState.plan;
    pipelinePlanRefreshing = true;
    try {
      await refreshPipelinePlan();
      if (registrationProfile) {
        const registrationRuntime = await mailComRegistrationControl?.snapshot();
        const countsResult = accountAssetStore.pool?.query
          ? await accountAssetStore.pool.query("select count(*)::int as registration_queued, min(next_run_at) as registration_oldest from registration_jobs where status in ('queued', 'retry_waiting')")
          : { rows: [{}] };
        const counts = countsResult.rows[0] || {};
        const adaptive = adaptivePipelineConcurrency({
          plan: pipelinePlanState.base,
          active: { registration: Number(registrationRuntime?.running || 0) },
          demand: {},
          limits: { paymentMethod: 0, refining: 0, finalPayment: 0, phoneBind: 0 },
          telemetry: { load1: os.loadavg()[0], freeMemoryMb: Math.round(os.freemem() / 1024 / 1024) },
        });
        pipelinePlanState.plan = mergeAdaptivePipelinePlan(adaptive, {
          registrationQueued: counts.registration_queued,
          registrationWaitingMs: waitingMs(counts.registration_oldest),
        });
        pipelinePlanState.updatedAt = pipelinePlanState.plan.updatedAt;
        return pipelinePlanState.plan;
      }
      const refiningConfig = pipelineSettings.getSecretConfig();
      const paymentConfig = paymentSettings.getSecretConfig();
      const paymentProbeConfig = paymentMethodProbeSettings.getSecretConfig();
      const refiningStage = refiningConfig.provider === 'gc_tacmon' ? 'gcash' : 'refining';
      const [registrationRuntime, countsResult] = await Promise.all([
        mailComRegistrationControl?.snapshot() || Promise.resolve({ running: 0 }),
        accountAssetStore.pool?.query ? accountAssetStore.pool.query(`
          select
            (select count(*)::int from registration_jobs
              where status in ('queued', 'retry_waiting')) as registration_queued,
            (select min(next_run_at) from registration_jobs
              where status in ('queued', 'retry_waiting')) as registration_oldest,
            count(*) filter (
              where a.account_snapshot_json->>'mailComStage' = $1
                and (
                  lower(coalesce(a.account_snapshot_json->'refiningJob'->>'status', '')) = 'pending'
                  or (
                    lower(coalesce(a.account_snapshot_json->'refiningJob'->>'status', '')) = ''
                    and a.eligibility_status = 'eligible'
                    and coalesce(auth.access_token, '') <> ''
                  )
                )
            )::int as refining_demand,
            count(*) filter (
              where a.account_snapshot_json->>'mailComStage' = $1
                and lower(coalesce(a.account_snapshot_json->'refiningJob'->>'status', '')) in ('dispatching', 'queued', 'running')
            )::int as refining_active,
            min(a.updated_at) filter (
              where a.account_snapshot_json->>'mailComStage' = $1
                and lower(coalesce(a.account_snapshot_json->'refiningJob'->>'status', '')) = 'pending'
            ) as refining_oldest,
            count(*) filter (where a.account_snapshot_json->>'mailComStage' = 'pending_payment')::int as payment_demand,
            count(*) filter (
              where a.account_snapshot_json->>'mailComStage' = 'pending_payment'
                and lower(coalesce(a.account_snapshot_json->'payment'->>'status', '')) in ('starting', 'running', 'awaiting_otp', 'awaiting_captcha')
            )::int as payment_active,
            min(a.updated_at) filter (where a.account_snapshot_json->>'mailComStage' = 'pending_payment') as payment_oldest,
            count(*) filter (where a.account_snapshot_json->>'mailComStage' = 'sms')::int as phone_demand,
            count(*) filter (
              where lower(coalesce(a.account_snapshot_json->>'phoneBindStatus', '')) in ('starting', 'otp_required')
            )::int as phone_active,
            min(a.updated_at) filter (where a.account_snapshot_json->>'mailComStage' = 'sms') as phone_oldest
          from accounts a
          left join account_auth auth on auth.account_id = a.id
          where lower(coalesce(a.account_snapshot_json->>'status', '')) = 'registered'
        `, [refiningStage]) : Promise.resolve({ rows: [{}] }),
      ]);
      const counts = countsResult.rows[0] || {};
      const probe = paymentMethodProbeCoordinator.snapshot();
      const phone = automaticPhoneBindQueue.snapshot();
      const demand = {
        paymentMethod: paymentProbeConfig.enabled ? probe.queued.length + probe.active.length : 0,
        refining: refiningConfig.enabled
          ? Number(counts.refining_demand || 0) + Number(counts.refining_active || 0)
          : 0,
        finalPayment: paymentConfig.enabled ? Number(counts.payment_demand || 0) : 0,
        phoneBind: automaticPhoneBindEnabled() ? Math.max(Number(counts.phone_demand || 0), phone.pending.length + phone.active.length) : 0,
      };
      const active = {
        registration: Number(registrationRuntime?.running || 0),
        paymentMethod: probe.active.length,
        refining: Number(counts.refining_active || 0),
        finalPayment: Number(counts.payment_active || 0),
        phoneBind: Math.max(activePhoneBinds.size, phone.active.length),
      };
      const wait = {
        paymentMethod: paymentProbeConfig.enabled ? Number(probe.oldestWaitingMs || 0) : 0,
        refining: refiningConfig.enabled ? waitingMs(counts.refining_oldest) : 0,
        finalPayment: paymentConfig.enabled ? waitingMs(counts.payment_oldest) : 0,
        phoneBind: automaticPhoneBindEnabled() ? waitingMs(counts.phone_oldest) : 0,
      };
      const refiningRetryCount = Math.max(1, Number(refiningConfig.retryCount) || 1);
      const refiningEntryProxyCount = availableProxyCount('checkout', refiningConfig.entryProxyPoolId);
      const refiningNeedsExitProxy = refiningConfig.provider === 'gc_tacmon'
        || ['ph_short', 'paypal', 'gopay', 'ideal', 'twint', 'upi', 'gcash', 'kakao'].includes(refiningConfig.linkType);
      const refiningExitProxyCount = refiningNeedsExitProxy
        ? availableProxyCount('checkout', refiningConfig.exitProxyPoolId || refiningConfig.entryProxyPoolId)
        : Number.POSITIVE_INFINITY;
      const refiningProxiesPerWorker = refiningConfig.provider === 'gc_tacmon'
        ? refiningRetryCount + 1
        : refiningRetryCount;
      const limits = {
        paymentMethod: availableProxyCount('payment', paymentProbeConfig.proxyPoolId),
        refining: refiningConfig.provider === 'public_cdk'
          ? 12
          : Math.floor(Math.min(refiningEntryProxyCount, refiningExitProxyCount) / refiningProxiesPerWorker),
        finalPayment: availableProxyCount('payment', paymentConfig.proxyPoolId),
        phoneBind: phoneBindRuntimeLimit(),
      };
      const adaptive = adaptivePipelineConcurrency({
        plan: pipelinePlanState.base,
        demand,
        active,
        waitingMs: wait,
        limits,
        telemetry: {
          load1: os.loadavg()[0],
          freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        },
      });
      pipelinePlanState.plan = mergeAdaptivePipelinePlan(adaptive, {
        registrationQueued: counts.registration_queued,
        registrationWaitingMs: waitingMs(counts.registration_oldest),
      });
      pipelinePlanState.updatedAt = pipelinePlanState.plan.updatedAt;
      paymentMethodProbeCoordinator.drain();
      refiningCoordinator.notify();
      paymentCoordinator.notify();
      automaticPhoneBindQueue.drain();
      return pipelinePlanState.plan;
    } finally {
      pipelinePlanRefreshing = false;
    }
  };
  await refreshAdaptivePipelinePlan();
  pipelinePlanTimer = setInterval(() => {
    refreshAdaptivePipelinePlan().catch((error) => console.error('adaptive pipeline concurrency refresh failed', error));
  }, 2000);
  pipelinePlanTimer.unref?.();
  const activeEligibilityChecks = new Set();
  const activeAccountStatusChecks = new Set();
  const loadMailComMailbox = async (identifier, { includeSecret = true } = {}) => {
    const target = String(identifier || '').trim().toLowerCase();
    if (!target) return null;
    if (target.includes('@')) {
      return mailboxStore.findMailbox({ provider: 'mail_com', email: target, includeSecret });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) return null;
    const mailbox = await mailboxStore.getMailbox({ mailboxId: target, includeSecret });
    return mailbox?.provider === 'mail_com' && !mailbox.retiredAt ? mailbox : null;
  };

  const mailComMailboxView = async (mailbox) => {
    if (!mailbox) return null;
    const [aliases, domains] = await Promise.all([
      mailboxStore.listAliases({ mailboxId: mailbox.id }),
      mailboxStore.listMailComDomainCatalog(),
    ]);
    return mailComSplitAccountView({
      ...mailbox,
      historicalAliasCount: aliases.length,
      aliases: aliases.filter((alias) => alias.status !== 'abandoned').map((alias) => alias.email),
      availableDomains: domains.map(publicMailComDomain),
    }, publicMailComSplitSession(mailbox));
  };

  const observedMailComAliases = async (mailbox) => {
    const remoteAliases = await listMailComSplitAddresses(mailbox, {
      timeoutMs: config.mailbox.pollTimeoutMs,
      requireOpenSession: true,
    });
    const aliases = (Array.isArray(remoteAliases) ? remoteAliases : [])
      .map((entry) => normalizeEmailValue(entry?.address || entry?.email || entry))
      .filter((email) => email
        && email !== mailbox.email
        && !isDefaultMailComAlias(mailbox.email, email));
    await mailboxStore.reconcileObservedAliases({ mailboxId: mailbox.id, emails: aliases });
    return aliases;
  };

  const observedMailComState = async (mailbox) => {
    const [aliases, remoteDomains] = await Promise.all([
      observedMailComAliases(mailbox),
      listMailComSplitDomains(mailbox, {
        timeoutMs: config.mailbox.pollTimeoutMs,
        requireOpenSession: true,
      }),
    ]);
    if (!Array.isArray(remoteDomains) || !remoteDomains.length) {
      return {
        aliases,
        domains: await mailboxStore.listMailComDomainCatalog(),
        domainSyncError: {
          code: 'MAIL_COM_SPLIT_DOMAINS_EMPTY',
          message: 'mail.com returned an empty available-domain list; saved catalog was preserved',
        },
      };
    }
    const domains = await mailboxStore.replaceMailComDomainCatalog({ domains: remoteDomains });
    return { aliases, domains };
  };

  const assertMailComSessionReady = (mailbox) => {
    if (!mailbox || mailbox.sessionStatus !== 'open' || !publicMailComSplitSession(mailbox).open) {
      const error = new Error('mail.com main mailbox cleanup must finish before a registration task can start');
      error.code = 'MAIL_COM_SESSION_NOT_READY';
      error.status = 409;
      throw error;
    }
  };

  const cleanMailComAliasesBeforeReady = async (mailbox) => {
    const initial = await observedMailComState(mailbox);
    const terminal = await runner.reconcileTerminalMailComAliases({
      mailboxId: mailbox.id,
      remoteAliasEmails: initial.aliases,
    });
    const remainingEmails = await observedMailComAliases(mailbox);
    const remainingSet = new Set(remainingEmails);
    const removed = [];
    for (const alias of await mailboxStore.listAliases({ mailboxId: mailbox.id })) {
      if (!remainingSet.has(alias.email) || ACTIVE_REGISTRATION_JOB_STATUSES.has(alias.latestJobStatus)) continue;
      await removeMailComSplitAddress(mailbox, alias.email, { timeoutMs: config.mailbox.pollTimeoutMs });
      await mailboxStore.markAliasAbandoned({ aliasId: alias.id });
      removed.push(alias.email);
    }
    const confirmedAliases = await observedMailComAliases(mailbox);
    const confirmedSet = new Set(confirmedAliases);
    const unresolved = (await mailboxStore.listAliases({ mailboxId: mailbox.id })).filter((alias) => (
      confirmedSet.has(alias.email) && !ACTIVE_REGISTRATION_JOB_STATUSES.has(alias.latestJobStatus)
    ));
    if (unresolved.length) {
      const error = new Error('mail.com split mailbox cleanup could not be confirmed');
      error.code = 'MAIL_COM_ALIAS_CLEANUP_INCOMPLETE';
      error.aliases = unresolved.map((alias) => alias.email);
      throw error;
    }
    return {
      initial,
      terminal,
      removed,
      confirmed: { ...initial, aliases: confirmedAliases },
    };
  };

  const createOwnedMailComAlias = async (mailbox, body = {}) => {
    assertMailComSessionReady(mailbox);
    // Bound the complete alias-creation transaction. The mail.com client has
    // per-request timeouts, but store/reservation calls can otherwise leave
    // the HTTP request stuck in "processing" indefinitely.
    const operationTimeoutMs = Math.max(
      15000,
      Math.min(90000, Number(config.mailbox.pollTimeoutMs) || 60000),
    );
    const withDeadline = (promise, label, timeoutMs = operationTimeoutMs) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.code = 'MAIL_COM_ALIAS_OPERATION_TIMEOUT';
          error.retryableProxy = false;
          reject(error);
        }, timeoutMs);
      });
      return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const requestedEmail = normalizeEmailValue(body.email);
    const requestedDomain = normalizeDomainValue(body.domain || body.mailComDomain || mailDomain(requestedEmail));
    // Domain allocation is transactional: hidden domains outside either blacklist,
    // with one allocation per 30-minute cooldown window.
    const selected = await withDeadline(
      mailboxStore.reserveMailComDomain({ domain: requestedDomain || null }),
      'mail.com domain reservation',
    );
    const email = requestedEmail || candidateAddress(
      String(body.usernamePrefix || body.localPart || '').trim(),
      selected.domain,
    );
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || mailDomain(email) !== selected.domain) {
      const error = new Error('mail.com split alias is invalid or does not use the selected mailbox domain');
      error.code = 'MAIL_COM_SPLIT_ALIAS_INVALID';
      throw error;
    }
    let reserved = null;
    try {
      reserved = await withDeadline(
        mailboxStore.reserveAliasForCreation({ mailboxId: mailbox.id, email }),
        'mail.com alias reservation',
      );
      await withDeadline(createMailComSplitAddress({
        mailboxStore,
        mailboxId: mailbox.id,
        aliasId: reserved.id,
        timeoutMs: config.mailbox.pollTimeoutMs,
      }), 'mail.com alias creation');
      return (await withDeadline(
        mailboxStore.markAliasCreated({ aliasId: reserved.id }),
        'mail.com alias commit',
      )).alias;
    } catch (error) {
      if (reserved) {
        await withDeadline(
          mailboxStore.markAliasCleanupRequired({ aliasId: reserved.id, error }),
          'mail.com alias cleanup',
          10000,
        ).catch(() => {});
      }
      if (mailComMainAccountCatsConflict(error)) {
        await closeMailComSplitSession(mailbox.id).catch(() => {});
        await mailboxStore.retireMailbox({
          mailboxId: mailbox.id,
          reason: `CATS request conflict: ${shortErrorMessage(error)}`,
        });
        error.mainAccountRetired = true;
        error.mainAccountEmail = mailbox.email;
      }
      throw error;
    }
  };

  const createMailComDatabaseJob = async ({ mailbox, alias, body = {} }) => {
    const selection = resolveTaskExecutionSelection(body);
    const task = await registrationStore.createJob({
      id: randomUUID(),
      email: alias.email,
      registrationPassword: resolveRegistrationPassword(body.password, config.defaultPassword),
      mailboxSource: 'mail_com_split',
      mailboxId: mailbox.id,
      aliasId: alias.id,
      // The UI sends the category-scoped pool as proxyPools.main. Keep the
      // legacy proxyPoolId form for direct API callers.
      proxyPoolId: body.proxyPoolId || body.proxyPools?.main || null,
      browserEngine: selection.browserEngine,
      entryBranch: selection.entryBranch,
      mode: 'register',
      options: {},
    });
    mailComRegistrationControl.scheduleTask();
    return task;
  };

  mailComRegistrationControl = new MailComRegistrationControl({
    mailboxStore,
    registrationStore,
    runner,
    registrationPassword: () => resolveRegistrationPassword(config.defaultPassword),
    aliasLimit: MAIL_COM_SPLIT_ALIAS_LIMIT,
    queueSource: '',
    entryBranch: config.registration.entryBranch,
    getConcurrency: () => pipelinePlanState.plan?.stages?.registration?.effectiveConcurrency ?? 0,
    getTaskOptions: async () => {
      const preferences = await getUiPreferences();
      return {
        proxyPoolId: preferences.proxyPools?.main || null,
        browserEngine: preferences.browserEngine || null,
        entryBranch: preferences.entryBranch || config.registration.entryBranch,
      };
    },
    onMailboxConflict: async (mailbox, error) => {
      if (!mailComMainAccountCatsConflict(error)) return;
      await closeMailComSplitSession(mailbox.id).catch(() => {});
      await mailboxStore.retireMailbox({
        mailboxId: mailbox.id,
        reason: `CATS request conflict: ${shortErrorMessage(error)}`,
      });
    },
  });
  mailComRegistrationControl.startQueuePolling();
  let scheduleMailComGlobalRefill = () => {};

  function publicMailComDomain(entry) {
    return {
      domain: entry.domain,
      state: entry.state.toUpperCase(),
      // `blacklisted` remains the compatibility field for the old no-code list.
      blacklisted: Boolean(entry.blacklisted),
      noCodeBlacklisted: Boolean(entry.noCodeBlacklisted ?? entry.blacklisted),
      noTrialBlacklisted: Boolean(entry.noTrialBlacklisted),
      consecutiveOtpTimeoutTasks: Number(entry.consecutiveOtpTimeoutTasks || 0),
      consecutiveNoTrialTasks: Number(entry.consecutiveNoTrialTasks || 0),
      failureUpdatedAt: entry.failureUpdatedAt || null,
    };
  }

  const mailComRefillOptions = (body = {}) => ({
    usernamePrefix: String(body.usernamePrefix || '').trim(),
    proxyPoolId: String(body.proxyPoolId || '').trim() || null,
    browserEngine: body.browserEngine || null,
    timeoutMs: config.mailbox.pollTimeoutMs,
  });

  const publicMailComRegistrationConfig = async () => {
    const [poolSettings, runtime, domains] = await Promise.all([
      mailboxStore.getPoolSettings(),
      mailComRegistrationControl.snapshot(),
      mailboxStore.listMailComDomainCatalog(),
    ]);
    return {
      autoStartEnabled: poolSettings.enabled,
      autoStartTarget: poolSettings.targetCount,
      autoStartConcurrency: poolSettings.concurrency,
      autoStartRuntime: runtime,
      sharedAvailableDomains: domains.map(publicMailComDomain),
    };
  };

  const publicRegistrationAutoStartConfig = async () => {
    const configView = await publicMailComRegistrationConfig();
    return {
      enabled: configView.autoStartEnabled,
      concurrency: configView.autoStartConcurrency,
      mailComReserveTarget: configView.autoStartTarget,
      runtime: configView.autoStartRuntime,
    };
  };

  const cleanupInvalidMailComWorkflowRows = async () => {
    if (typeof accountAssetStore.cleanupInvalidMailComWorkflowRows !== 'function') {
      return { invalidCount: 0, archivedAccounts: 0, deletedCandidates: 0, emails: [] };
    }
    const registrationExtras = registrationChangeEmailSettings.getSecretConfig();
    return accountAssetStore.cleanupInvalidMailComWorkflowRows({
      requirePassword: registrationExtras.setupPassword === true,
      requireTotp: registrationExtras.setupTotp2fa === true,
    });
  };

  const cleanupNotEligibleMailComWorkflowRows = async () => {
    const accounts = await accountAssetStore.list({ includeSecret: false, limit: null });
    const preserved = accounts.filter((account) => {
      const trialStatus = String(account?.trialEligibility?.status || account?.eligibilityStatus || '').trim().toLowerCase();
      return trialStatus === 'not_eligible';
    });
    return { preserved: preserved.length };
  };

  const publicEmailRows = async () => {
    const [readyCandidates, startedCandidates] = await Promise.all([
      registrationStore.listCandidates({ status: 'ready' }),
      registrationStore.listCandidates({ status: 'started' }),
    ]);
    return [...readyCandidates, ...startedCandidates].sort((left, right) => (
      String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))
    ));
  };
  scheduleMailComGlobalRefill = (preferredMailboxId = '') => (
    mailComRegistrationControl.scheduleGlobalRefill(preferredMailboxId)
  );
  setImmediate(() => cleanupInvalidMailComWorkflowRows().catch((error) => {
    console.error('mail.com workflow cleanup failed', error);
  }));
  setImmediate(() => scheduleMailComGlobalRefill());
  const server = http.createServer(async (req, res) => {
    try {
      const boundaryError = requestBoundaryError(req, config);
      if (boundaryError) return sendJson(res, boundaryError.status, { error: boundaryError.error });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (registrationProfile && /^\/api(?:\/|$)/i.test(url.pathname) && !registrationApiAllowed(req.method, url.pathname)) {
        return sendJson(res, 404, { error: 'feature_disabled' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/healthz')           return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        return sendJson(res, 200, { ok: true, transport: 'http', collectorMode: config.collector.mode });
      }
      if (url.pathname === '/api/payment/settings') {
        if (req.method === 'GET') return sendJson(res, 200, paymentSettings.getPublicConfig());
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const saved = await paymentSettings.update(body);
          paymentCoordinator.configureInterval(paymentSettings.getSecretConfig().pollIntervalMs);
          paymentCoordinator.notify();
          return sendJson(res, 200, saved);
        }
      }
      if (url.pathname === '/api/payment-method-probe/settings') {
        if (req.method === 'GET') return sendJson(res, 200, paymentMethodProbeSettings.getPublicConfig());
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const saved = await paymentMethodProbeSettings.update(body);
          paymentMethodProbeCoordinator.drain();
          return sendJson(res, 200, saved);
        }
      }
      if (url.pathname === '/api/registration/change-email/settings') {
        if (req.method === 'GET') return sendJson(res, 200, registrationChangeEmailSettings.getPublicConfig());
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const saved = await registrationChangeEmailSettings.update(body);
          return sendJson(res, 200, saved);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/payment-method-probe') {
        return sendJson(res, 200, paymentMethodProbeCoordinator.snapshot());
      }
      const paymentMethodProbeAccountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/payment-methods\/probe$/i);
      if (paymentMethodProbeAccountMatch && req.method === 'POST') {
        const email = decodeURIComponent(paymentMethodProbeAccountMatch[1]);
        return sendJson(res, 202, await paymentMethodProbeCoordinator.schedule(email, { force: true, reason: 'manual' }));
      }
      if (url.pathname === '/api/phone-bind/settings') {
        if (req.method === 'GET') return sendJson(res, 200, phoneBindSettings.getPublicConfig());
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const saved = await phoneBindSettings.update(body, {
            source: 'api',
            remoteAddress: req.socket?.remoteAddress || '',
          });
          automaticPhoneBindQueue?.drain();
          if (!registrationProfile && saved.autoEnabled) {
            const candidates = await accountAssetStore.list({
              includeSecret: true,
              limit: null,
            });
            for (const account of candidates) {
              if ((account.workflowStage || account.mailComStage) === MAIL_COM_STAGES.SMS) {
                await scheduleAutomaticPhoneBind({ email: account.email });
              }
            }
          }
          return sendJson(res, 200, saved);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/proxy-pools/payment') {
        return sendJson(res, 200, proxyPools.payment.listPools());
      }
      if (req.method === 'PUT' && url.pathname === '/api/preferences') {
        const body = await readBody(req);
        const allowed = new Set(['proxyPools', 'executionType', 'browserEngine', 'entryBranch']);
        const unknown = Object.keys(body && typeof body === 'object' ? body : {}).filter((key) => allowed.has(key) === false);
        if (unknown.length) return sendJson(res, 400, { error: 'PREFERENCES_FIELD_UNSUPPORTED', fields: unknown });
        const current = await getUiPreferences();
        const requestedBranch = body.entryBranch === undefined
          ? String(current.entryBranch || '').trim().toLowerCase()
          : String(body.entryBranch || '').trim().toLowerCase();
        const branchType = requestedBranch ? executionTypeForImplementation(requestedBranch) : null;
        if (requestedBranch && !branchType) {
          return sendJson(res, 400, { error: 'EXECUTION_IMPLEMENTATION_UNSUPPORTED', entryBranch: requestedBranch });
        }
        const requestedTypeValue = body.executionType === undefined
          ? String(current.executionType || '').trim().toLowerCase()
          : String(body.executionType || '').trim().toLowerCase();
        const requestedType = requestedTypeValue ? executionType(requestedTypeValue) : branchType;
        if (requestedTypeValue && !requestedType) {
          return sendJson(res, 400, { error: 'EXECUTION_TYPE_UNSUPPORTED', executionType: requestedTypeValue });
        }
        if (requestedType && branchType && requestedType.key !== branchType.key) {
          return sendJson(res, 400, {
            error: 'EXECUTION_TYPE_IMPLEMENTATION_MISMATCH',
            executionType: requestedType.key,
            entryBranch: requestedBranch,
          });
        }
        if (registrationProfile && (requestedType?.key !== 'protocol' || !['freepp'].includes(requestedBranch))) {
          return sendJson(res, 400, { error: 'REGISTRATION_IMPLEMENTATION_DISABLED' });
        }
        const requestedBrowserValue = body.browserEngine === undefined
          ? String(current.browserEngine || '').trim().toLowerCase()
          : String(body.browserEngine || '').trim().toLowerCase();
        const requestedBrowser = requestedBrowserValue ? fingerprintBrowser(requestedBrowserValue) : null;
        if (requestedBrowserValue && !requestedBrowser) {
          return sendJson(res, 400, { error: 'FINGERPRINT_BROWSER_UNSUPPORTED', browserEngine: requestedBrowserValue });
        }
        const next = {
          proxyPools: { ...(current.proxyPools || {}), ...(body.proxyPools && typeof body.proxyPools === 'object' ? body.proxyPools : {}) },
          executionType: requestedType?.key || '',
          browserEngine: requestedBrowser?.key || '',
          entryBranch: requestedBranch,
        };
        const saved = await runtimeStateStore.updateSetting(UI_PREFERENCES_KEY, next);
        return sendJson(res, 200, saved.value);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, {
          profile: config.profile,
          ...(registrationProfile ? { capabilities: REGISTRATION_CAPABILITIES } : {}),
          transport: config.transport,
          collector: config.collector,
          registration: {
            ...config.registration,
            executionCatalog: registrationProfile ? registrationCatalog(publicExecutionCatalog()) : publicExecutionCatalog(),
            executionType: executionTypeForImplementation(config.registration.entryBranch)?.key || null,
            changeEmail: registrationChangeEmailSettings.getPublicConfig(),
            autoStart: await publicRegistrationAutoStartConfig(),
          },
          browserEnabled: !registrationProfile && config.browser.enabled,
          browser: {
            enabled: !registrationProfile && config.browser.enabled,
            engine: config.browser.engine,
            headless: config.browser.headless,
            os: config.browser.os,
            geoip: config.browser.geoip,
            localeSource: config.browser.localeSource,
            locale: config.browser.allowExplicitLocale ? config.browser.locale : '',
            blockWebrtc: config.browser.blockWebrtc,
            blockImages: config.browser.blockImages,
            enableCache: config.browser.enableCache,
            screen: config.browser.screen,
            window: config.browser.window,
            maxProxyAttempts: config.browser.maxProxyAttempts,
            operationTimeoutMs: config.browser.operationTimeoutMs,
          },
          mailbox: {
            pollTimeoutMs: config.mailbox.pollTimeoutMs,
            pollIntervalMs: config.mailbox.pollIntervalMs,
            cloudflareTempEmail: cloudflareTempEmailSettings.getPublicConfig(),
            mailComSplit: await publicMailComRegistrationConfig(),
          },
          defaultPasswordConfigured: Boolean(config.defaultPassword),
          preferences: await getUiPreferences(),
          pipelineConcurrency: pipelinePlanState.plan,
          proxyPools: registrationProfile ? ['main', 'eligibility'] : Object.keys(proxyPools),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/pipeline-concurrency') {
        return sendJson(res, 200, pipelinePlanState.plan);
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const copyEmail = String(url.searchParams.get('a') || '').trim().toLowerCase();
        const copyKind = String(url.searchParams.get('b') || '');
        if (copyEmail && (copyKind === '1' || copyKind === '2')) {
          const account = await accountAssetStore.getByEmail(copyEmail, { includeSecret: true });
          if (!account) return sendJson(res, 404, { error: 'account_not_found' });
          const value = copyKind === '1'
            ? String(account.tokens?.accessToken || '')
            : String(account.tokens?.refreshToken || '');
          if (!value) {
            return sendJson(res, 404, {
              error: copyKind === '1' ? 'access_token_not_available' : 'rt_not_available',
            });
          }
          const source = Buffer.from(value, 'utf8');
          const partSize = copyKind === '1' ? 16 : 8;
          const partCount = Math.ceil(source.length / partSize);
          const partRaw = url.searchParams.get('c');
          if (partRaw === null) {
            return sendJson(res, 200, { parts: partCount, length: source.length });
          }
          const partIndex = Number(partRaw);
          if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
            return sendJson(res, 404, { error: 'copy_part_not_found' });
          }
          const start = partIndex * partSize;
          return sendJson(res, 200, {
            index: partIndex,
            data: Array.from(source.subarray(start, start + partSize)),
          });
        }
        const currentEmailOnly = url.searchParams.get('currentEmails') === '1';
        const currentRows = currentEmailOnly ? await publicEmailRows() : [];
        const accountIds = currentRows.map((entry) => entry.accountId).filter(Boolean);
        const registrationJobIds = currentRows.map((entry) => entry.generatedTaskId).filter(Boolean);
        const accountRows = currentEmailOnly && !accountIds.length && !registrationJobIds.length
          ? []
          : await accountAssetStore.list({
            accountIds,
            registrationJobIds,
            lightweight: url.searchParams.get('summary') === '1',
            limit: null,
          });
        return sendJson(res, 200, url.searchParams.get('summary') === '1'
          ? accountRows.map(accountSummaryView)
          : accountRows);
      }
      if (req.method === 'GET' && url.pathname === '/api/payment/settings') {
        return sendJson(res, 200, paymentSettings.getPublicConfig());
      }
      if (req.method === 'PUT' && url.pathname === '/api/payment/settings') {
        const body = await readBody(req);
        const saved = await paymentSettings.update(body);
        paymentCoordinator.notify();
        return sendJson(res, 200, saved);
      }
      const paymentAccountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/payment(?:\/(start|status|cancel))?$/i);
      if (paymentAccountMatch) {
        const email = decodeURIComponent(paymentAccountMatch[1]);
        const action = paymentAccountMatch[2] || 'status';
        if (req.method === 'GET' && action === 'status') {
          return sendJson(res, 200, { payment: await paymentCoordinator.getStatus(email) });
        }
        if (req.method === 'POST' && action === 'start') {
          try {
            return sendJson(res, 202, { payment: await paymentCoordinator.startPayment(email) });
          } catch (error) {
            return sendJson(res, 400, { error: String(error.message || error) });
          }
        }
        if (req.method === 'POST' && action === 'cancel') {
          try {
            return sendJson(res, 200, { payment: await paymentCoordinator.cancelPayment(email) });
          } catch (error) {
            return sendJson(res, 400, { error: String(error.message || error) });
          }
        }
      }
      const accountPhoneBindMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/phone-bind$/i);
      if (accountPhoneBindMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountPhoneBindMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        if (!hasPhoneBindOauthQualification(account)) {
          await accountAssetStore.updateByEmail({ email, expectedVersion: account.version, patch: {
            phoneBindStatus: 'failed',
            phoneBindError: {
              code: 'PHONE_BIND_OAUTH_QUALIFICATION_MISSING',
              message: '注册阶段 OAuth 资格校验未通过，不能进入接码',
            },
          } });
          return sendJson(res, 409, {
            error: 'phone_bind_oauth_qualification_missing',
            message: '注册阶段 OAuth 资格校验未通过，账号已保留',
            deleted: false,
          });
        }
        const key = String(account.email || email).toLowerCase();
        const requestedPhone = String(body.phone || '').trim();
        const automaticSms = !requestedPhone;
        let attemptedPhone = requestedPhone;
        let selectedPhoneBindProxy = phoneBindProxyForAccount(account, proxyPools);
        let selectedPhoneBindProxyAttempt = 0;
        let existingSession = activePhoneBinds.get(key) || null;
        if (!existingSession) {
          existingSession = await restorePhoneBindSession({
            config,
            account,
            phoneBindSettings,
            runtimeStateStore,
            proxy: selectedPhoneBindProxy,
          });
          if (existingSession) activePhoneBinds.set(key, existingSession);
        }
        try {
          let session;
          let smsRotation = existingSession?.smsRotation || null;
          if (automaticSms && !smsRotation) {
            smsRotation = new SmsNumberRotation(phoneBindSettings.getSecretConfig(), {
              onOutcome: (outcome) => phoneBindSettings.recordSmsOutcome(outcome),
              initialAttempts: Number(account.phoneBindSmsAttempt || 0),
            });
          }
          if (existingSession && automaticSms) {
            session = await replacePhoneBindWithAutomaticNumber(existingSession, smsRotation);
            attemptedPhone = session.phone;
          } else if (existingSession) {
            await existingSession.smsRotation?.cancel?.();
            existingSession.smsRotation = null;
            session = await replacePhoneBindNumber(existingSession, requestedPhone);
          } else {
            const phone = automaticSms ? (await smsRotation.next()).phone : requestedPhone;
            attemptedPhone = phone;
            const started = await createPhoneBindSessionWithProxyFallback({
              account,
              proxyPools,
              maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
              createSession: (proxy) => createPhoneBindSession({
                config,
                account,
                phone,
                headed: Boolean(body.headed),
                phoneBindSettings,
                runtimeStateStore,
                outputDir: path.join(config.dataDir, 'phone-bind-diagnostics'),
                proxy,
              }),
            });
            session = started.session;
            selectedPhoneBindProxy = started.proxy;
            selectedPhoneBindProxyAttempt = started.attemptCount;
            if (automaticSms) session.smsRotation = smsRotation;
            }
            if (session.status === 'completed') {
              await session.smsRotation?.cancel?.();
              await session.close().catch(() => {});
              const currentTokens = account.tokens && typeof account.tokens === 'object'
                ? account.tokens
                : {};
              await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
                phoneBindStatus: 'completed',
                phoneNumber: session.phone || body.phone,
                phoneBindStateFile: null,
                phoneBindWorkflowKey: key,
                ...(session.oauthSession?.refreshToken ? {
                  tokens: {
                    ...currentTokens,
                    refreshToken: session.oauthSession.refreshToken,
                    refreshedAt: new Date().toISOString(),
                  },
                } : {}),
                phoneBindRefreshTokenError: session.oauthSession?.refreshTokenError || null,
                phoneBoundAt: new Date().toISOString(),
                phoneBindAttemptedNumber: null,
                phoneBindError: null,
                phoneBindSmsAuto: automaticSms,
                ...(smsRotation ? {
                  phoneBindSmsAttempt: smsRotation.attempts,
                  phoneBindSmsPrice: smsRotation.publicState().price,
                } : {}),
                ...(selectedPhoneBindProxy ? { phoneBindProxy: phoneBindProxyReference(selectedPhoneBindProxy) } : {}),
                phoneBindProxyAttempt: selectedPhoneBindProxyAttempt,
                ...([MAIL_COM_STAGES.PAID, MAIL_COM_STAGES.SMS].includes(account.workflowStage || account.mailComStage) ? { workflowStage: MAIL_COM_STAGES.COMPLETED, mailComStage: MAIL_COM_STAGES.COMPLETED, lifecycleStage: MAIL_COM_STAGES.COMPLETED } : {}),
              } });
              return sendJson(res, 200, {
                status: 'completed',
                email: key,
                phoneBindWorkflowKey: key,
                account: await accountAssetStore.getByEmail(key),
              });
          }
          activePhoneBinds.set(key, session);
          await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
            phoneBindStatus: 'otp_required',
            phoneNumber: session.phone || body.phone,
            phoneBindStateFile: null,
            phoneBindWorkflowKey: key,
            phoneBindStartedAt: new Date().toISOString(),
            phoneBindAttemptedNumber: null,
            phoneBindError: null,
            phoneBindSmsAuto: automaticSms,
            ...(smsRotation ? {
              phoneBindSmsAttempt: smsRotation.attempts,
              phoneBindSmsPrice: smsRotation.publicState().price,
            } : {}),
            ...(selectedPhoneBindProxy ? { phoneBindProxy: phoneBindProxyReference(selectedPhoneBindProxy) } : {}),
            phoneBindProxyAttempt: selectedPhoneBindProxyAttempt,
          } });
          return sendJson(res, 202, {
            status: 'otp_required',
            email: key,
            phoneReplaced: Boolean(existingSession || (smsRotation && smsRotation.attempts > 1)),
            smsAuto: automaticSms,
            phoneBindWorkflowKey: key,
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          activePhoneBinds.delete(key);
          if (automaticSms && phoneBindNumberNeedsReplacement(error)) await smsRotation?.fail?.();
          else await smsRotation?.cancel?.();
          if (error?.code === 'ACCOUNT_VERSION_CONFLICT') {
            return sendJson(res, 409, {
              error: 'PHONE_BIND_ACCOUNT_CHANGED',
              message: 'account state changed while phone binding was running',
              account: await accountAssetStore.getByEmail(key),
            });
          }
          const failedProxy = error?.phoneBindProxy || selectedPhoneBindProxy;
          await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
            phoneBindStatus: 'failed',
            phoneBindStateFile: null,
            phoneBindWorkflowKey: key,
            phoneBindAttemptedNumber: attemptedPhone || null,
            ...(smsRotation ? {
              phoneBindSmsAttempt: smsRotation.attempts,
              phoneBindSmsPrice: smsRotation.publicState().price,
            } : {}),
            ...(failedProxy ? { phoneBindProxy: phoneBindProxyReference(failedProxy) } : {}),
            phoneBindProxyAttempt: Number(error?.phoneBindProxyAttempts || selectedPhoneBindProxyAttempt || 0),
            phoneBindLastRequestAt: new Date().toISOString(),
            phoneBindError: {
              code: error?.code || 'PHONE_BIND_FAILED',
              message: String(error?.message || error),
              diagnostics: error?.diagnostics || null,
            },
          } });
          return sendJson(res, 400, {
            error: error?.code || 'PHONE_BIND_FAILED',
            message: String(error?.message || error),
            diagnostics: error?.diagnostics || null,
            account: await accountAssetStore.getByEmail(key),
          });
        }
      }
      const accountPhoneBindAutoRetryMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/phone-bind\/auto-retry$/i);
      if (accountPhoneBindAutoRetryMatch && req.method === 'POST') {
        const email = decodeURIComponent(accountPhoneBindAutoRetryMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        if (!automaticPhoneBindEnabled()) return sendJson(res, 409, { error: 'automatic_phone_bind_disabled' });
        const queueSnapshot = automaticPhoneBindQueue.snapshot();
        const alreadyScheduled = queueSnapshot.active.includes(key)
          || queueSnapshot.pending.some((item) => item.email === key);
        if (req.headers['x-signlist-internal'] !== '1' && alreadyScheduled) {
          return sendJson(res, 202, { status: 'running', email: key });
        }
        const exchangeOnlyRetry = account.phoneBindStatus === 'rt_pending';
        if (exchangeOnlyRetry) {
          try {
            let exchangeAttempt;
            const persistedPhoneBindWorkflow = await runtimeStateStore.getPhoneBindWorkflow(key);
            if (!persistedPhoneBindWorkflow
              || persistedPhoneBindWorkflow.workflowStage !== 'rt_pending') {
              exchangeAttempt = await createPhoneBindSessionWithProxyFallback({
                account,
                proxyPools,
                maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
                createSession: (proxy) => reauthorizePhoneBindRefreshToken({
                  config,
                  account,
                  phoneBindSettings,
                  runtimeStateStore,
                  proxy,
                  outputDir: path.join(config.dataDir, 'phone-bind-diagnostics'),
                }),
              });
            } else {
              try {
                exchangeAttempt = await createPhoneBindSessionWithProxyFallback({
                  account,
                  proxyPools,
                  maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
                  createSession: (proxy) => retryPhoneBindExchange({
                    config,
                    account,
                    phoneBindSettings,
                    runtimeStateStore,
                    proxy,
                  }),
                });
              } catch (error) {
                if (isSub2ExchangeSessionExpired(error)) {
                  exchangeAttempt = await createPhoneBindSessionWithProxyFallback({
                    account,
                    proxyPools,
                    maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
                    createSession: (proxy) => recoverPhoneBindExchangeWithFreshAuthorization({
                      config,
                      account,
                      phoneBindSettings,
                      runtimeStateStore,
                      proxy,
                      outputDir: path.join(config.dataDir, 'phone-bind-runtime'),
                    }),
                  });
                } else {
                  throw error;
                }
              }
            }
            const result = exchangeAttempt.session;
            const currentTokens = account.tokens && typeof account.tokens === 'object'
              ? account.tokens
              : {};
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              phoneBindStatus: 'completed',
              phoneBindStateFile: null,
              phoneBindWorkflowKey: key,
              phoneBindProxy: phoneBindProxyReference(exchangeAttempt.proxy)
                || account.phoneBindProxy || null,
              oauthSession: result.oauthSession,
              tokens: {
                ...currentTokens,
                refreshToken: result.oauthSession.refreshToken,
                refreshedAt: new Date().toISOString(),
              },
              phoneBindRefreshTokenError: null,
              phoneBoundAt: account.phoneBoundAt || new Date().toISOString(),
              phoneBindError: null,
              phoneBindRetryKind: null,
              phoneBindRetryCount: 0,
              phoneBindNextRetryAt: null,
              phoneBindQueuePosition: null,
              ...([MAIL_COM_STAGES.PAID, MAIL_COM_STAGES.SMS].includes(account.workflowStage || account.mailComStage) ? { workflowStage: MAIL_COM_STAGES.COMPLETED, mailComStage: MAIL_COM_STAGES.COMPLETED, lifecycleStage: MAIL_COM_STAGES.COMPLETED } : {}),
            } });
            return sendJson(res, 200, {
              status: 'completed',
              email: key,
              phoneBindWorkflowKey: key,
              account: await accountAssetStore.getByEmail(key),
            });
          } catch (error) {
            if (error?.code === 'ACCOUNT_VERSION_CONFLICT') {
              return sendJson(res, 409, {
                error: 'PHONE_BIND_ACCOUNT_CHANGED',
                message: 'account state changed while refresh-token recovery was running',
                account: await accountAssetStore.getByEmail(key),
              });
            }
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              phoneBindStatus: 'rt_pending',
              phoneBindRefreshTokenError: String(error?.message || error),
              phoneBindError: {
                code: error?.code || 'PHONE_BIND_EXCHANGE_RETRY_FAILED',
                message: String(error?.message || error),
              },
            } });
            return sendJson(res, 502, {
              error: error?.code || 'PHONE_BIND_EXCHANGE_RETRY_FAILED',
              message: String(error?.message || error),
              account: await accountAssetStore.getByEmail(key),
            });
          }
        }

        const staleSession = activePhoneBinds.get(key);
        activePhoneBinds.delete(key);
        await staleSession?.smsRotation?.cancel?.().catch(() => {});
        await staleSession?.close?.().catch(() => {});
        await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
          phoneBindStatus: 'idle',
          phoneNumber: null,
          phoneBindStateFile: null,
          phoneBindStartedAt: null,
          phoneBindAttemptedNumber: null,
          phoneBindSmsAuto: true,
          phoneBindSmsAttempt: 0,
          phoneBindSmsPrice: 0,
          phoneBindProxyAttempt: 0,
          phoneBindRetryKind: null,
          phoneBindRetryCount: 0,
          phoneBindNextRetryAt: null,
          phoneBindQueuePosition: null,
          phoneBindError: null,
        } });
        await scheduleAutomaticPhoneBind({ email: key, force: true });
        return sendJson(res, 202, { status: 'starting', email: key });
      }
      const accountPhoneBindCodeMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/phone-bind\/code$/i);
      if (accountPhoneBindCodeMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountPhoneBindCodeMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        let session = activePhoneBinds.get(key);
        if (!session) {
          session = await restorePhoneBindSession({
            config,
            account,
            phoneBindSettings,
            runtimeStateStore,
            proxy: phoneBindProxyForAccount(account, proxyPools),
          });
          if (session) activePhoneBinds.set(key, session);
        }
        if (!session) return sendJson(res, 404, { error: 'phone_bind_session_not_found' });
        try {
          let code = String(body.code || '').trim();
          if (!code && session.smsRotation) {
            code = await session.smsRotation.waitForCode();
          }
          let result = await submitPhoneBindCode(session, code);
          if (result.status === 'rt_pending') {
            try {
              const recoveryAttempt = await createPhoneBindSessionWithProxyFallback({
                account,
                proxyPools,
                maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
                createSession: (proxy) => recoverPhoneBindExchangeWithFreshAuthorization({
                  config,
                  account,
                  phoneBindSettings,
                  runtimeStateStore,
                  proxy,
                  outputDir: path.dirname(result.stateFile),
                  targetStateFile: result.stateFile,
                }),
              });
              result = recoveryAttempt.session;
            } catch (recoveryError) {
              activePhoneBinds.delete(key);
              await session.smsRotation?.complete?.();
              await session.close().catch(() => {});
              await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
                phoneBindStatus: 'rt_pending',
                phoneBindStateFile: null,
                phoneBindWorkflowKey: key,
                phoneBindRefreshTokenError: result.oauthSession?.refreshTokenError
                  || String(recoveryError?.message || recoveryError),
                phoneBoundAt: new Date().toISOString(),
                phoneBindError: {
                  code: recoveryError?.code || 'PHONE_BIND_RT_PENDING',
                  message: String(recoveryError?.message || recoveryError),
                },
              } });
              return sendJson(res, 502, {
                error: recoveryError?.code || 'PHONE_BIND_RT_PENDING',
                message: String(recoveryError?.message || recoveryError),
                status: 'rt_pending',
                account: await accountAssetStore.getByEmail(key),
              });
            }
          }
          let completedMailComStage = null;
          if (result.status === 'completed') {
            activePhoneBinds.delete(key);
            await session.smsRotation?.complete?.();
            await session.close().catch(() => {});
            const currentTokens = account.tokens && typeof account.tokens === 'object'
              ? account.tokens
              : {};
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              phoneBindStatus: 'completed',
              phoneBindStateFile: null,
              phoneBindWorkflowKey: key,
              ...(result.oauthSession?.cookies?.length ? { oauthSession: result.oauthSession } : {}),
              ...(result.oauthSession?.refreshToken ? {
                tokens: {
                  ...currentTokens,
                  refreshToken: result.oauthSession.refreshToken,
                  refreshedAt: new Date().toISOString(),
                },
              } : {}),
              phoneBindRefreshTokenError: result.oauthSession?.refreshTokenError || null,
              phoneBoundAt: new Date().toISOString(),
              phoneBindError: null,
              ...([MAIL_COM_STAGES.PAID, MAIL_COM_STAGES.SMS].includes(account.workflowStage || account.mailComStage)
                ? { workflowStage: MAIL_COM_STAGES.COMPLETED, mailComStage: MAIL_COM_STAGES.COMPLETED, lifecycleStage: MAIL_COM_STAGES.COMPLETED }
                : {}),
            } });
            if ([MAIL_COM_STAGES.PAID, MAIL_COM_STAGES.SMS].includes(account.workflowStage || account.mailComStage)) {
              completedMailComStage = MAIL_COM_STAGES.COMPLETED;
            }
          }
          return sendJson(res, 200, {
            status: result.status,
            email: key,
            phoneBindWorkflowKey: key,
            account: await accountAssetStore.getByEmail(key),
            ...(completedMailComStage ? { mailComStage: completedMailComStage } : {}),
          });
        } catch (error) {
          if (error?.code === 'ACCOUNT_VERSION_CONFLICT') {
            activePhoneBinds.delete(key);
            await session.smsRotation?.cancel?.();
            await session.close().catch(() => {});
            return sendJson(res, 409, {
              error: 'PHONE_BIND_ACCOUNT_CHANGED',
              message: 'account state changed while the verification code was being submitted',
              account: await accountAssetStore.getByEmail(key),
            });
          }
          const validationTransportAttempts = Number(session.validationTransportAttempts || 0);
          if (isPhoneBindTransportError(error) && validationTransportAttempts < 3) {
            session.validationTransportAttempts = validationTransportAttempts + 1;
            activePhoneBinds.set(key, session);
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              phoneBindStatus: 'otp_required',
              phoneBindStateFile: null,
              phoneBindWorkflowKey: key,
              phoneBindError: {
                code: 'PHONE_BIND_CODE_TRANSPORT_RETRY',
                message: `验证码提交网络失败，正在重试 ${session.validationTransportAttempts}/3：${String(error?.message || error)}`,
              },
            } });
            return sendJson(res, 503, {
              error: 'PHONE_BIND_CODE_TRANSPORT_RETRY',
              status: 'otp_required',
              retryable: true,
              attempt: session.validationTransportAttempts,
              message: String(error?.message || error),
              account: await accountAssetStore.getByEmail(key),
            });
          }
          activePhoneBinds.delete(key);
          if (error?.code === 'SMSBOWER_OTP_TIMEOUT') await session.smsRotation?.fail?.();
          else await session.smsRotation?.cancel?.();
          await session.close().catch(() => {});
          await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
            phoneBindStatus: 'failed',
            phoneBindSmsAttempt: Number(session.smsRotation?.attempts || 0),
            phoneBindSmsPrice: Number(session.smsRotation?.publicState?.().price || 0),
            phoneBindLastRequestAt: new Date().toISOString(),
            phoneBindError: {
              code: error?.code || 'PHONE_BIND_CODE_FAILED',
              message: String(error?.message || error),
            },
          } });
          return sendJson(res, 400, {
            error: error?.code || 'PHONE_BIND_CODE_FAILED',
            message: String(error?.message || error),
            account: await accountAssetStore.getByEmail(key),
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/refining') {
        return sendJson(res, 200, await refiningCoordinator.overview());
      }
      if (req.method === 'PUT' && url.pathname === '/api/refining/settings') {
        const body = await readBody(req);
        await refiningSettingsStore.update(body);
        refiningCoordinator.notify();
        return sendJson(res, 200, { settings: pipelineSettings.getPublicConfig() });
      }
      if (req.method === 'POST' && url.pathname === '/api/refining/test') {
        return sendJson(res, 200, await refiningCoordinator.testConnection());
      }
      if (req.method === 'POST' && url.pathname === '/api/refining/automation/stop') {
        await refiningSettingsStore.update({ enabled: false });
        refiningCoordinator.notify();
        return sendJson(res, 200, { settings: pipelineSettings.getPublicConfig(), stopped: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/refining/enqueue-current') {
        const result = await refiningCoordinator.enqueueCurrent();
        refiningCoordinator.notify({ forceDispatch: true });
        return sendJson(res, 202, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/refining/cancel') {
        return sendJson(res, 200, await refiningCoordinator.cancelActive());
      }
      const gcashRefiningRetryMatch = url.pathname.match(/^\/api\/refining\/accounts\/([^/]+)\/gcash\/retry$/i);
      if (req.method === 'POST' && gcashRefiningRetryMatch) {
        try {
          const email = decodeURIComponent(gcashRefiningRetryMatch[1]);
          const key = String(email || '').trim().toLowerCase();
          const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
          if (!account) return sendJson(res, 404, { error: 'account_not_found' });
          const methods = Array.isArray(account.paymentCapabilities?.methods)
            ? account.paymentCapabilities.methods.map((item) => String(item || '').trim().toLowerCase())
            : [];
          if (!methods.includes('gcash')) return sendJson(res, 409, { error: 'account_is_not_gcash_capable' });
          if ((account.workflowStage || account.mailComStage) !== MAIL_COM_STAGES.GCASH) {
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              workflowStage: MAIL_COM_STAGES.GCASH,
              mailComStage: MAIL_COM_STAGES.GCASH,
              lifecycleStage: 'gcash',
            } });
          }
          return sendJson(res, 202, await refiningCoordinator.retry(key, { linkType: 'gcash' }));
        } catch (error) {
          return sendJson(res, 500, {
            error: 'gcash_refining_retry_failed',
            message: String(error?.message || error),
          });
        }
      }
      const refiningRetryMatch = url.pathname.match(/^\/api\/refining\/accounts\/([^/]+)\/retry$/i);
      if (req.method === 'POST' && refiningRetryMatch) {
        return sendJson(res, 202, await refiningCoordinator.retry(decodeURIComponent(refiningRetryMatch[1])));
      }
      const accountLoginStateMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/login-state$/i);
      if (accountLoginStateMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountLoginStateMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        return sendJson(res, 200, {
          email: account.email || email,
          loginState: accountLoginStateSummary(account),
        });
      }
      const gcashCheckoutStatusMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gcash\/status$/i);
      if (gcashCheckoutStatusMatch && req.method === 'GET') {
        const email = decodeURIComponent(gcashCheckoutStatusMatch[1]);
        const account = await accountAssetStore.getByEmail(email);
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        return sendJson(res, 200, {
          email: account.email || email,
          gcashQr: account.refiningJob?.gcashQr || null,
        });
      }
      const gcashCheckoutCloseMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gcash\/close$/i);
      if (gcashCheckoutCloseMatch && req.method === 'POST') {
        const email = decodeURIComponent(gcashCheckoutCloseMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        if (!await accountAssetStore.getByEmail(key)) return sendJson(res, 404, { error: 'account_not_found' });
        const result = await refiningCoordinator.closeGcashQrCapture(key);
        return sendJson(res, result.closed ? 200 : 409, { email: key, ...result });
      }
      const gcashCheckoutOpenMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gcash\/open$/i);
      if (gcashCheckoutOpenMatch && req.method === 'POST') {
        const email = decodeURIComponent(gcashCheckoutOpenMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key);
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        return sendJson(res, 200, {
          email: account.email || key,
          status: account.refiningJob?.gcashQr?.status || null,
          gcashQr: account.refiningJob?.gcashQr || null,
        });
      }
      const gcashCheckoutRefreshMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/gcash\/refresh$/i);
      if (gcashCheckoutRefreshMatch && req.method === 'POST') {
        const email = decodeURIComponent(gcashCheckoutRefreshMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const methods = Array.isArray(account.paymentCapabilities?.methods)
          ? account.paymentCapabilities.methods.map((item) => String(item || '').trim().toLowerCase())
          : [];
        const isGcashAccount = (account.workflowStage || account.mailComStage) === MAIL_COM_STAGES.GCASH || methods.includes('gcash');
        if (!isGcashAccount) return sendJson(res, 409, { error: 'account_is_not_gcash_capable' });
        const refreshed = await refiningCoordinator.refreshMkGcashQrCapture(key);
        if (refreshed?.refreshed) {
          return sendJson(res, 200, { email: key, ...refreshed });
        }
        return sendJson(res, 409, {
          email: key,
          error: 'MK_GCASH_REF_MISSING',
          message: '当前账号没有 MK GCash 任务引用，请先点击提炼生成二维码',
          ...refreshed,
        });
      }
      const accountAccessTokenMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/access-token$/i);
      if (accountAccessTokenMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountAccessTokenMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const accessToken = String(account.tokens?.accessToken || '');
        if (!accessToken) return sendJson(res, 404, { error: 'access_token_not_available' });
        return sendJson(res, 200, { email: account.email, accessToken });
      }
      const accountAccessTokenLiveCheckMatch = url.pathname.match(/^(?:\/api\/accounts\/([^/]+)\/access-token\/live-check|\/api\/live-check\/([^/]+))$/i);
      if (accountAccessTokenLiveCheckMatch && req.method === 'GET') {
        const key = String(decodeURIComponent(accountAccessTokenLiveCheckMatch[1] || accountAccessTokenLiveCheckMatch[2]) || '').trim().toLowerCase();
        return sendJson(res, 200, { email: key, liveCheck: liveCheckState.get(key) || null });
      }
      if (accountAccessTokenLiveCheckMatch && req.method === 'POST') {
        req.resume();
        const email = decodeURIComponent(accountAccessTokenLiveCheckMatch[1] || accountAccessTokenLiveCheckMatch[2]);
        const key = String(email || '').trim().toLowerCase();
        const startedAt = new Date().toISOString();
        liveCheckState.set(key, { status: 'running', startedAt });
        void (async () => {
          let selectedProxy = null;
          try {
          const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
          if (!account) throw Object.assign(new Error('account_not_found'), { status: 404, code: 'ACCOUNT_NOT_FOUND' });
          const stage = String(account.workflowStage || account.mailComStage || '').trim().toLowerCase();
          if (['paid', 'sms', 'completed', 'sold'].includes(stage)) throw Object.assign(new Error('access token live check after payment is disabled'), { status: 409, code: 'ACCESS_TOKEN_LIVE_CHECK_AFTER_PAYMENT_DISABLED' });
          const accessToken = String(account.tokens?.accessToken || '').trim();
          if (!accessToken) throw Object.assign(new Error('access_token_not_available'), { status: 404, code: 'ACCESS_TOKEN_NOT_AVAILABLE' });
          const originalPoolId = String(account.registrationEnvironment?.proxyPoolId || '').trim();
          const jpEligibilityPool = proxyPools.eligibility.listPools().find((pool) => (pool.countries || []).includes('JP'));
          const proxyPoolId = jpEligibilityPool?.id || '';
          selectedProxy = await proxyPools.eligibility.pickNext({
            poolId: proxyPoolId || undefined,
            country: 'JP',
          });
          if (!selectedProxy) throw Object.assign(new Error(`JP资格代理池无可用代理（原注册池 ${originalPoolId || 'unknown'}）`), { code: 'ELIGIBILITY_JP_PROXY_UNAVAILABLE' });
          const result = await runAccessTokenEligibilityCheck({
            accessToken,
            timeoutMs: 15000,
            proxy: selectedProxy,
            sessionContext: account.sessionContext || null,
          });
          await proxyPools.eligibility.markChecked?.(selectedProxy.id, { poolId: selectedProxy.poolId || proxyPoolId || undefined });
          await accountAssetStore.updateByEmail({ email: key, patch: {
            accessTokenLiveCheck: {
              status: 'valid',
              checkedAt: result.checkedAt,
              accountsCheckStatus: result.accountsCheckStatus,
            },
            eligibilityStatus: result.trialEligibility?.status || account.eligibilityStatus,
            trialEligibility: result.trialEligibility || account.trialEligibility || null,
            eligibilityLastResult: result,
            eligibilityLastCheckedAt: result.checkedAt,
            eligibilityError: null,
          } });
          liveCheckState.set(key, { status: 'valid', checkedAt: result.checkedAt, accountsCheckStatus: result.accountsCheckStatus, proxyCountry: result.proxy?.country || null, proxyPoolId: result.proxy?.poolId || null });
          } catch (error) {
          if (selectedProxy) {
            await proxyPools.eligibility.markBad?.(selectedProxy.id, {
              poolId: selectedProxy.poolId || undefined,
              reason: error?.message || error,
            }).catch(() => {});
          }
          const checkedAt = new Date().toISOString();
          if (Number(error?.status || 0) === 401) {
            await accountAssetStore.updateByEmail({ email: key, patch: {
              accessTokenLiveCheck: {
                status: 'invalid',
                checkedAt,
                code: error?.code || 'ACCESS_TOKEN_INVALID',
                statusCode: 401,
                message: String(error?.message || error).slice(0, 500),
              },
            } });
            liveCheckState.set(key, { status: 'invalid', checkedAt, code: error?.code || 'ACCESS_TOKEN_INVALID', statusCode: 401, message: String(error?.message || error).slice(0, 500) });
            return;
          }
          await accountAssetStore.updateByEmail({ email: key, patch: {
            accessTokenLiveCheck: {
              status: 'failed',
              checkedAt,
              code: error?.code || 'ACCESS_TOKEN_LIVE_CHECK_FAILED',
              statusCode: error?.status || null,
              message: String(error?.message || error).slice(0, 500),
            },
          } });
          liveCheckState.set(key, { status: 'failed', checkedAt, code: error?.code || 'ACCESS_TOKEN_LIVE_CHECK_FAILED', statusCode: error?.status || null, message: String(error?.message || error).slice(0, 500) });
          }
        })().catch((error) => console.error('access token live check failed', key, error));
        return sendJson(res, 202, { email: key, status: 'running', startedAt });
      }
      const accountSessionCookieRenewMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/session-cookie\/renew$/i);
      if (accountSessionCookieRenewMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountSessionCookieRenewMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        if (!await accountAssetStore.getByEmail(key)) return sendJson(res, 404, { error: 'account_not_found' });
        if (activeSessionCookieRenewals.has(key)) {
          return sendJson(res, 202, { status: 'running', email: key });
        }
        activeSessionCookieRenewals.add(key);
        try {
          const secretAccount = await accountAssetStore.getByEmail(key, { includeSecret: true });
          const proxy = (await gcashCheckoutProxyCandidates(secretAccount, proxyPools))[0] || null;
          const renewal = await refreshAccountAccessToken({
            config,
            accountStore: accountAssetStore,
            email: key,
            proxy,
          });
          return sendJson(res, 200, {
            status: 'completed',
            email: key,
            renewal,
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          const status = Number(error?.status || 0)
            || (error?.code === 'SESSION_COOKIE_ACCOUNT_NOT_FOUND' ? 404 : 400);
          return sendJson(res, status, {
            error: error?.code || 'SESSION_COOKIE_RENEWAL_FAILED',
            message: String(error?.message || error),
            account: await accountAssetStore.getByEmail(key),
          });
        } finally {
          activeSessionCookieRenewals.delete(key);
        }
      }
      const accountRefreshTokenRefreshMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/refresh-token\/refresh$/i);
      if (accountRefreshTokenRefreshMatch && req.method === 'POST') {
        const email = decodeURIComponent(accountRefreshTokenRefreshMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const currentRefreshToken = String(account.tokens?.refreshToken || '').trim();
        const currentRefreshTokenStatus = String(account.refreshTokenStatus || '').trim().toLowerCase();
        const requiresFreshAuthorization = new Set(['reused', 'invalidated', 'unknown', 'rejected']).has(currentRefreshTokenStatus);
        if (!currentRefreshToken && !account.session?.cookies?.length) {
          await accountAssetStore.updateByEmail({ email: key, patch: { refreshTokenStatus: 'missing' } });
          return sendJson(res, 409, { error: 'refresh_token_not_available' });
        }
        if (activeRefreshTokenRuns.has(key)) return sendJson(res, 202, { status: 'running', email: key });
        activeRefreshTokenRuns.add(key);
        const attemptedAt = new Date().toISOString();
        try {
          let rotated = null;
          let rotationRejected = false;
          if (currentRefreshToken && !requiresFreshAuthorization) {
            try {
              rotated = await rotateOpenAiRefreshToken({ refreshToken: currentRefreshToken });
            } catch (error) {
              if (!['REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_INVALIDATED'].includes(error?.code)) throw error;
              rotationRejected = true;
            }
          }
          if (!rotated) {
            if (registrationProfile) {
              throw Object.assign(new Error('fresh phone authorization is disabled by the registration-only profile'), {
                code: 'REFRESH_TOKEN_REAUTHORIZATION_DISABLED', status: 409,
              });
            }
            const recoveryAttempt = await createPhoneBindSessionWithProxyFallback({
              account,
              proxyPools,
              maxAttempts: phoneBindProxyAttemptLimit(phoneBindSettings.getSecretConfig()),
              createSession: (proxy) => reauthorizePhoneBindRefreshToken({
                config,
                account,
                phoneBindSettings,
                runtimeStateStore,
                proxy,
                outputDir: path.join(config.dataDir, 'phone-bind-diagnostics'),
              }),
            });
            const recovery = recoveryAttempt.session;
            const freshRefreshToken = String(recovery?.oauthSession?.refreshToken || '').trim();
            if (!freshRefreshToken) {
              const error = new Error('fresh authorization did not return a refresh token');
              error.code = 'REFRESH_TOKEN_REAUTHORIZATION_INCOMPLETE';
              throw error;
            }
            const refreshedAt = new Date().toISOString();
            const currentTokens = account.tokens && typeof account.tokens === 'object' ? account.tokens : {};
            await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
              oauthSession: recovery.oauthSession,
              phoneBindProxy: phoneBindProxyReference(recoveryAttempt.proxy) || account.phoneBindProxy || null,
              tokens: { ...currentTokens, refreshToken: freshRefreshToken, refreshedAt },
              refreshTokenAvailable: true,
              refreshTokenStatus: 'active',
              refreshTokenCustody: 'service',
              refreshTokenLastAttemptAt: attemptedAt,
              refreshTokenLastRotatedAt: refreshedAt,
              refreshTokenLastError: null,
              phoneBindRefreshTokenError: null,
            } });
            return sendJson(res, 200, {
              status: 'completed',
              method: rotationRejected ? 'fresh_authorization_after_rotation_rejected' : 'fresh_authorization',
              email: key,
              account: await accountAssetStore.getByEmail(key),
            });
          }
          const currentTokens = account.tokens && typeof account.tokens === 'object' ? account.tokens : {};
          await accountAssetStore.updateByEmail({ email: key, expectedVersion: account.version, patch: {
            tokens: {
              ...currentTokens,
              accessToken: rotated.accessToken,
              refreshToken: rotated.refreshToken,
              refreshedAt: rotated.rotatedAt,
            },
            accessTokenAvailable: true,
            refreshTokenAvailable: true,
            refreshTokenStatus: 'active',
            refreshTokenCustody: 'service',
            refreshTokenLastAttemptAt: attemptedAt,
            refreshTokenLastRotatedAt: rotated.rotatedAt,
            refreshTokenLastError: null,
            phoneBindRefreshTokenError: null,
          } });
          return sendJson(res, 200, {
            status: 'completed',
            method: 'refresh_token_rotation',
            email: key,
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          if (error?.code === 'ACCOUNT_VERSION_CONFLICT') {
            return sendJson(res, 409, {
              error: 'REFRESH_TOKEN_ACCOUNT_CHANGED',
              message: 'account state changed while refresh token rotation was running',
              account: await accountAssetStore.getByEmail(key),
            });
          }
          const statusByCode = {
            REFRESH_TOKEN_REUSED: 'reused',
            REFRESH_TOKEN_INVALIDATED: 'invalidated',
            REFRESH_TOKEN_ROTATION_NETWORK_ERROR: 'unknown',
            REFRESH_TOKEN_ROTATION_INCOMPLETE: 'unknown',
            REFRESH_TOKEN_ROTATION_REJECTED: 'rejected',
          };
          const refreshTokenStatus = statusByCode[error?.code]
            || (requiresFreshAuthorization ? currentRefreshTokenStatus : 'unknown');
          await accountAssetStore.updateByEmail({ email: key, patch: {
            refreshTokenStatus,
            refreshTokenLastAttemptAt: attemptedAt,
            refreshTokenLastError: {
              code: error?.code || 'REFRESH_TOKEN_ROTATION_FAILED',
              remoteCode: error?.remoteCode || '',
              status: error?.status || null,
              message: String(error?.message || error).slice(0, 500),
              at: new Date().toISOString(),
            },
          } });
          const responseStatus = error?.code === 'REFRESH_TOKEN_REAUTHORIZATION_DISABLED'
            ? 409
            : (['reused', 'invalidated'].includes(refreshTokenStatus) ? 409 : (error?.retryable ? 502 : 400));
          return sendJson(res, responseStatus, {
            error: error?.code || 'REFRESH_TOKEN_ROTATION_FAILED',
            message: String(error?.message || error),
            refreshTokenStatus,
            account: await accountAssetStore.getByEmail(key),
          });
        } finally {
          activeRefreshTokenRuns.delete(key);
        }
      }
      const accountRtCopyMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/rt$/i);
      if (accountRtCopyMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountRtCopyMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const value = String(account.tokens?.refreshToken || '');
        if (!value) return sendJson(res, 404, { error: 'rt_not_available' });
        return sendJson(res, 200, { email: account.email, value });
      }
      const accountRefreshTokenMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/refresh-token$/i);
      if (accountRefreshTokenMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountRefreshTokenMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const refreshToken = String(account.tokens?.refreshToken || '');
        if (!refreshToken) return sendJson(res, 404, { error: 'refresh_token_not_available' });
        return sendJson(res, 200, { email: account.email, refreshToken });
      }
      const accountTotpSecretMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/totp-secret$/i);
      if (accountTotpSecretMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountTotpSecretMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        if (!account.totpSecret) return sendJson(res, 404, { error: 'totp_secret_not_available' });
        return sendJson(res, 200, { email: account.email, totpSecret: account.totpSecret });
      }
      const accountCredentialExportMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/credential-export$/i);
      if (accountCredentialExportMatch && req.method === 'GET') {
        const email = decodeURIComponent(accountCredentialExportMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        if (account.passwordStatus !== 'has_password') return sendJson(res, 409, { error: 'account_has_no_password' });
        if (!account.password) return sendJson(res, 404, { error: 'password_not_available' });
        if (!account.totpSecret) return sendJson(res, 404, { error: 'totp_secret_not_available' });
        const loginEmail = String(account.loginEmail || account.email || '').trim().toLowerCase();
        const exportText = `${loginEmail}----${account.password}----${account.totpSecret}`;
        return sendJson(res, 200, {
          email: account.email,
          loginEmail,
          format: 'email----password----2fa',
          exportText,
        });
      }
      const accountAccessTokenRefreshMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/access-token\/refresh$/i);
      if (accountAccessTokenRefreshMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountAccessTokenRefreshMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        if (!await accountAssetStore.getByEmail(key)) return sendJson(res, 404, { error: 'account_not_found' });
        if (activeSessionCookieRenewals.has(key)) {
          return sendJson(res, 202, { status: 'running', email: key });
        }
        activeSessionCookieRenewals.add(key);
        try {
          const renewal = await renewAccountSessionCookie({
            config,
            accountStore: accountAssetStore,
            proxyPools,
            email: key,
            fallbackPoolId: body.proxyPoolId || null,
          });
          return sendJson(res, 200, {
            status: 'completed',
            email: key,
            result: {
              method: 'browser_cookie_jar',
              refreshedAt: renewal.refreshedAt,
              accessToken: renewal.accessToken,
              accessTokenAvailable: renewal.accessTokenAvailable,
              sessionStatus: renewal.sessionStatus,
            },
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          return sendJson(res, 200, {
            status: 'failed',
            email: key,
            error: {
              code: error?.code || 'ACCESS_TOKEN_REFRESH_FAILED',
              message: String(error?.message || error),
            },
            account: await accountAssetStore.getByEmail(key),
          });
        } finally {
          activeSessionCookieRenewals.delete(key);
        }
      }
      const accountStatusMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/account-status$/i);
      if (accountStatusMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountStatusMatch[1]);
        const account = await accountAssetStore.getByEmail(email);
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const key = String(account.email || email).toLowerCase();
        if (activeAccountStatusChecks.has(key)) return sendJson(res, 409, { error: 'account_status_check_already_running' });
        activeAccountStatusChecks.add(key);
        await accountAssetStore.updateByEmail({ email: key, patch: {
          accountPlanStatus: 'checking',
          accountPlanError: null,
          accountPlanStartedAt: new Date().toISOString(),
        } });
        try {
          const result = await runAccountStatusCheck({
            config,
            accountStore: accountAssetStore,
            proxyPools,
            runtimeStateStore,
            email: key,
            proxyPoolId: body.proxyPoolId || null,
          });
          return sendJson(res, 200, {
            status: 'completed',
            email: key,
            result,
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          return sendJson(res, 200, {
            status: 'failed',
            email: key,
            error: {
              code: error?.code || 'ACCOUNT_STATUS_CHECK_FAILED',
              message: String(error?.message || error),
            },
            account: await accountAssetStore.getByEmail(key),
          });
        } finally {
          activeAccountStatusChecks.delete(key);
        }
      }
      const accountEligibilityMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/eligibility$/i);
      if (accountEligibilityMatch && req.method === 'POST') {
        const body = await readBody(req);
        const email = decodeURIComponent(accountEligibilityMatch[1]);
        const account = await accountAssetStore.getByEmail(email, { includeSecret: true });
        if (!account) return sendJson(res, 404, { error: 'account_not_found' });
        const key = String(account.email || email).toLowerCase();
        if (activeEligibilityChecks.has(key)) return sendJson(res, 409, { error: 'eligibility_check_already_running' });
        activeEligibilityChecks.add(key);
        await accountAssetStore.updateByEmail({ email: key, patch: {
          eligibilityStatus: 'checking',
          eligibilityError: null,
          eligibilityStartedAt: new Date().toISOString(),
        } });
        try {
          const result = await runProtocolEligibilityCheck({
            accountStore: accountAssetStore,
            proxyPools,
            email: key,
            proxyPoolId: body.proxyPoolId || null,
          });
          const paymentMethodProbe = await schedulePaymentMethodProbeAfterRegistration(key);
          return sendJson(res, 200, {
            status: 'completed',
            email: key,
            result,
            paymentMethodProbe,
            account: await accountAssetStore.getByEmail(key),
          });
        } catch (error) {
          return sendJson(res, 200, {
            status: 'failed',
            email: key,
            error: {
              code: error?.code || 'ELIGIBILITY_CHECK_FAILED',
              message: String(error?.message || error),
              diagnostic: error?.diagnostic || null,
            },
            account: await accountAssetStore.getByEmail(key),
          });
        } finally {
          activeEligibilityChecks.delete(key);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/emails') return sendJson(res, 200, await publicEmailRows());
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const currentEmailOnly = url.searchParams.get('currentEmails') === '1';
        const jobIds = currentEmailOnly
          ? (await publicEmailRows()).map((entry) => entry.generatedTaskId).filter(Boolean)
          : [];
        let jobs = currentEmailOnly && !jobIds.length ? [] : await registrationStore.listJobs({ jobIds });
        if (url.searchParams.get('latestByEmail') === '1') {
          const seen = new Set();
          jobs = jobs.filter((job) => {
            if (seen.has(job.email)) return false;
            seen.add(job.email);
            return true;
          });
        }
        return sendJson(res, 200, jobs);
      }
      if (req.method === 'GET' && url.pathname === '/api/registration-view') {
        const currentEmailOnly = url.searchParams.get('currentEmails') === '1';
        const emails = currentEmailOnly ? (await publicEmailRows()).map((entry) => entry.email) : [];
        return sendJson(res, 200, await registrationStore.registrationViews({
          emails,
          mailboxSource: url.searchParams.get('source') || '',
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/registration-scratch/clear') {
        const body = await readBody(req);
        if (body.includeActive === true || url.searchParams.get('includeActive') === '1') {
          return sendJson(res, 400, {
            error: 'ACTIVE_REGISTRATION_SCRATCH_CLEAR_FORBIDDEN',
            message: 'active registration jobs cannot be cleared as scratch',
          });
        }
        try {
          return sendJson(res, 200, await accountAssetStore.clearRegistrationScratch({
            source: body.source || url.searchParams.get('source') || '',
          }));
        } catch (error) {
          return sendJson(res, 400, {
            error: error?.code || 'REGISTRATION_SCRATCH_CLEAR_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/mailbox/cloudflare-temp-email/config') {
        return sendJson(res, 200, cloudflareTempEmailSettings.getPublicConfig());
      }
      if (req.method === 'GET' && url.pathname === '/api/mailbox/cloudflare-temp-email/domains') {
        try {
          return sendJson(res, 200, await listCloudflareTempEmailDomains({
            ...cloudflareTempEmailSettings.getSecretConfig(),
            maxDomainScanRows: 60,
          }));
        } catch (error) {
          const payload = cloudflareMailboxErrorPayload(error);
          if (payload) return sendJson(res, 400, payload);
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/cloudflare-temp-email/domains') {
        const body = await readBody(req);
        const savedConfig = cloudflareTempEmailSettings.getSecretConfig();
        const override = body && typeof body === 'object' ? body : {};
        try {
          return sendJson(res, 200, await listCloudflareTempEmailDomains({
            ...savedConfig,
            baseUrl: Object.prototype.hasOwnProperty.call(override, 'baseUrl') && String(override.baseUrl || '').trim()
              ? override.baseUrl
              : savedConfig.baseUrl,
            adminAuth: Object.prototype.hasOwnProperty.call(override, 'adminAuth') && String(override.adminAuth || '').trim()
              ? override.adminAuth
              : savedConfig.adminAuth,
            customAuth: Object.prototype.hasOwnProperty.call(override, 'customAuth') && String(override.customAuth || '').trim()
              ? override.customAuth
              : savedConfig.customAuth,
            maxDomainScanRows: 60,
          }));
        } catch (error) {
          const payload = cloudflareMailboxErrorPayload(error);
          if (payload) return sendJson(res, 400, payload);
          throw error;
        }
      }
      if (req.method === 'PUT' && url.pathname === '/api/mailbox/cloudflare-temp-email/config') {
        const body = await readBody(req);
        return sendJson(res, 200, await cloudflareTempEmailSettings.update(body));
      }
      if (req.method === 'GET' && url.pathname === '/api/registration/autostart/config') {
        return sendJson(res, 200, await publicRegistrationAutoStartConfig());
      }
      if (req.method === 'PUT' && url.pathname === '/api/registration/autostart/config') {
        const body = await readBody(req);
        const allowed = new Set(['concurrency', 'mailComReserveTarget']);
        const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
        if (unsupported.length) return sendJson(res, 400, { error: 'REGISTRATION_AUTOSTART_FIELD_UNSUPPORTED', fields: unsupported });
        await mailboxStore.updatePoolSettings({
          concurrency: body.concurrency,
          targetCount: body.mailComReserveTarget,
        });
        await refreshPipelinePlan();
        return sendJson(res, 200, await publicRegistrationAutoStartConfig());
      }
      if (req.method === 'POST' && url.pathname === '/api/registration/autostart/start') {
        req.resume();
        await mailboxStore.updatePoolSettings({ enabled: true });
        await mailComRegistrationControl.drainDatabaseQueue();
        scheduleMailComGlobalRefill();
        return sendJson(res, 200, { started: true, config: await publicRegistrationAutoStartConfig() });
      }
      if (req.method === 'POST' && url.pathname === '/api/registration/autostart/stop') {
        req.resume();
        mailComRegistrationControl.stopAutoRefill();
        await mailboxStore.updatePoolSettings({ enabled: false });
        return sendJson(res, 200, { stopped: true, config: await publicRegistrationAutoStartConfig() });
      }
      if (req.method === 'GET' && url.pathname === '/api/mailbox/mail-com-split/config') {
        return sendJson(res, 200, await publicMailComRegistrationConfig());
      }
      if (req.method === 'GET' && url.pathname === '/api/mailbox/mail-com-split/accounts') {
        const mailboxes = await mailboxStore.listMailboxes({ provider: 'mail_com' });
        return sendJson(res, 200, await Promise.all(mailboxes.map(mailComMailboxView)));
      }
      if (req.method === 'PUT' && url.pathname === '/api/mailbox/mail-com-split/config') {
        const body = await readBody(req);
        const {
          autoStartEnabled,
          autoStartTarget,
          autoStartConcurrency,
          ...mailboxConfig
        } = body;
        if (Object.keys(mailboxConfig).length) {
          return sendJson(res, 400, {
            error: 'MAIL_COM_CONFIG_FIELD_UNSUPPORTED',
            fields: Object.keys(mailboxConfig),
          });
        }
        const saved = await mailboxStore.updatePoolSettings({
          enabled: autoStartEnabled,
          targetCount: autoStartTarget,
          concurrency: autoStartConcurrency,
        });
        await mailComRegistrationControl.drainDatabaseQueue();
        if (saved.enabled) scheduleMailComGlobalRefill();
        else mailComRegistrationControl.stopAutoRefill();
        return sendJson(res, 200, await publicMailComRegistrationConfig());
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/mail-com-split/autostart/stop') {
        mailComRegistrationControl.stopAutoRefill();
        await mailboxStore.updatePoolSettings({ enabled: false });
        return sendJson(res, 200, { stopped: true, config: await publicMailComRegistrationConfig() });
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/mail-com-split/accounts/autostart') {
        const body = await readBody(req);
        const mailbox = await loadMailComMailbox(body.accountId || body.mainAccountId || body.id || body.email);
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        if (body.autoStartEnabled === false) {
          mailComRegistrationControl.stopAutoRefill();
          await mailboxStore.updatePoolSettings({ enabled: false });
          return sendJson(res, 200, { result: { status: 'stopped' }, config: await publicMailComRegistrationConfig() });
        }
        await mailboxStore.updatePoolSettings({ enabled: true });
        try {
          const result = await mailComRegistrationControl.refill({
            preferredMailboxId: mailbox.id,
            options: mailComRefillOptions(body),
          });
          return sendJson(res, 200, { result, config: await publicMailComRegistrationConfig() });
        } catch (error) {
          const status = error?.code === 'ALIAS_REFILL_ALREADY_ACTIVE' ? 409 : 400;
          return sendJson(res, status, {
            error: error?.code || 'MAIL_COM_REFILL_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/mail-com-split/accounts') {
        const body = await readBody(req);
        const email = normalizeEmailValue(body.email);
        const password = String(body.password ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) {
          return sendJson(res, 400, {
            error: 'mail_com_split_account_invalid',
            message: 'mail.com main email and password are required',
          });
        }
        const mailbox = await mailboxStore.upsertMailbox({ provider: 'mail_com', email, password });
        return sendJson(res, 200, {
          account: await mailComMailboxView(mailbox),
          session: publicMailComSplitSession(mailbox),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/mail-com-split/accounts/import') {
        const body = await readBody(req);
        const result = { imported: [], updated: [], ignored: 0 };
        for (const line of String(body.text || body.accounts || '').split(/\r?\n/u)) {
          const parsed = parseMainAccountLine(line);
          if (!parsed) {
            if (line.trim()) result.ignored += 1;
            continue;
          }
          const existing = await mailboxStore.findMailbox({ provider: 'mail_com', email: parsed.email });
          const mailbox = await mailboxStore.upsertMailbox({ provider: 'mail_com', ...parsed });
          const view = await mailComMailboxView(mailbox);
          (existing ? result.updated : result.imported).push(view);
        }
        return sendJson(res, 200, result);
      }
      const mailComSplitAccountMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)$/i);
      if (mailComSplitAccountMatch && req.method === 'DELETE') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitAccountMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        await closeMailComSplitSession(mailbox.id);
        await mailboxStore.recordSessionState({ mailboxId: mailbox.id, status: 'closed' });
        try {
          return sendJson(res, 200, await mailboxStore.deleteMailbox({ mailboxId: mailbox.id }));
        } catch (error) {
          if (error?.code === 'MAILBOX_DELETE_HAS_ALIASES' || error?.code === 'MAILBOX_DELETE_HAS_JOBS') {
            return sendJson(res, 409, {
              error: error.code,
              message: error.message,
              aliases: error.aliases || [],
            });
          }
          throw error;
        }
      }
      const mailComSplitSessionMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/session\/(open|close)$/i);
      if (mailComSplitSessionMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitSessionMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        if (mailComSplitSessionMatch[2] === 'close') {
          await closeMailComSplitSession(mailbox.id);
          const closed = await mailboxStore.recordSessionState({ mailboxId: mailbox.id, status: 'closed' });
          return sendJson(res, 200, {
            account: await mailComMailboxView(closed),
            session: publicMailComSplitSession(closed),
          });
        }
        const body = await readBody(req);
        await mailboxStore.recordSessionState({ mailboxId: mailbox.id, status: 'opening' });
        try {
          await openMailComSplitSession(mailbox, {
            timeoutMs: config.mailbox.pollTimeoutMs,
            headed: Boolean(body.headed),
          });
          const cleanup = await cleanMailComAliasesBeforeReady(mailbox);
          const opened = await mailboxStore.recordSessionState({ mailboxId: mailbox.id, status: 'open' });
          return sendJson(res, 200, {
            account: await mailComMailboxView(opened),
            session: publicMailComSplitSession(mailbox),
            observed: cleanup.confirmed,
            cleanup,
          });
        } catch (error) {
          await markMailComSplitSessionUnavailable(mailbox.id, {
            status: 'failed',
            lastError: shortErrorMessage(error),
          });
          await mailboxStore.recordSessionState({
            mailboxId: mailbox.id,
            status: 'failed',
            lastError: shortErrorMessage(error),
          });
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_SESSION_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/mail-com-split/workflow/reconcile') {
        const body = await readBody(req);
        const requestedMailbox = body.accountId || body.mailboxId || '';
        const mailbox = requestedMailbox
          ? await loadMailComMailbox(body.accountId || body.mailboxId)
          : null;
        if (requestedMailbox && !mailbox) {
          return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        }
        return sendJson(res, 200, {
          results: await runner.reconcileTerminalMailComAliases({ mailboxId: mailbox?.id || '' }),
        });
      }
      const mailComSplitAliasImportMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/aliases$/i);
      if (mailComSplitAliasImportMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitAliasImportMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        const body = await readBody(req);
        try {
          const alias = await createOwnedMailComAlias(mailbox, body);
          return sendJson(res, 200, {
            account: await mailComMailboxView(mailbox),
            alias: alias.email,
          });
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_ALIAS_CREATE_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      const mailComSplitAliasSyncMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/aliases\/sync$/i);
      if (mailComSplitAliasSyncMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitAliasSyncMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        try {
          const aliases = await listMailComSplitAddresses(mailbox, {
            timeoutMs: config.mailbox.pollTimeoutMs,
            requireOpenSession: true,
          });
          const normalized = aliases
            .map((entry) => normalizeEmailValue(entry?.address || entry?.email || entry))
            .filter((email) => email && !isDefaultMailComAlias(mailbox.email, email));
          const reconciled = await mailboxStore.reconcileObservedAliases({
            mailboxId: mailbox.id,
            emails: normalized,
          });
          return sendJson(res, 200, {
            account: await mailComMailboxView(mailbox),
            aliases: reconciled.filter((alias) => alias.status !== 'abandoned').map((alias) => alias.email),
            syncedAliases: normalized,
          });
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_ALIAS_SYNC_FAILED',
            message: String(error?.message || error),
            aliases: error?.aliases || [],
          });
        }
      }
      const mailComSplitDomainSyncMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/domains\/sync$/i);
      if (mailComSplitDomainSyncMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitDomainSyncMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        try {
          const domains = await listMailComSplitDomains(mailbox, {
            timeoutMs: config.mailbox.pollTimeoutMs,
            requireOpenSession: true,
          });
          if (!Array.isArray(domains) || !domains.length) {
            return sendJson(res, 502, {
              error: 'MAIL_COM_SPLIT_DOMAINS_EMPTY',
              message: 'mail.com 返回了空的可用后缀表',
              account: await mailComMailboxView(mailbox),
              domains: [],
            });
          }
          const saved = await mailboxStore.replaceMailComDomainCatalog({ domains });
          return sendJson(res, 200, {
            account: await mailComMailboxView(mailbox),
            domains: saved,
          });
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_DOMAIN_SYNC_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      const mailComSplitAliasDeleteMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/aliases\/([^/]+)$/i);
      if (mailComSplitAliasDeleteMatch && req.method === 'DELETE') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitAliasDeleteMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        const email = normalizeEmailValue(decodeURIComponent(mailComSplitAliasDeleteMatch[2]));
        const alias = await mailboxStore.getAlias({ email });
        if (!alias || alias.mailboxId !== mailbox.id) {
          return sendJson(res, 404, { error: 'mail_com_split_alias_not_found' });
        }
        if (['assigned', 'registering', 'registered'].includes(alias.status)) {
          return sendJson(res, 409, {
            error: 'MAIL_COM_SPLIT_ALIAS_HAS_ACCOUNT',
            message: 'alias cannot be removed while it owns a registration account',
          });
        }
        try {
          await removeMailComSplitAddress(mailbox, email, {
            timeoutMs: config.mailbox.pollTimeoutMs,
            requireOpenSession: true,
          });
          await mailboxStore.markAliasAbandoned({ aliasId: alias.id });
          return sendJson(res, 200, {
            account: await mailComMailboxView(mailbox),
            deleted: 1,
            alias: email,
          });
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_ALIAS_DELETE_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      const mailComSplitAliasCodeMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/aliases\/([^/]+)\/code$/i);
      if (mailComSplitAliasCodeMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitAliasCodeMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        const email = normalizeEmailValue(decodeURIComponent(mailComSplitAliasCodeMatch[2]));
        const alias = await mailboxStore.getAlias({ email });
        if (!alias || alias.mailboxId !== mailbox.id || alias.status === 'abandoned') {
          return sendJson(res, 404, { error: 'mail_com_split_alias_not_found' });
        }
        try {
          return sendJson(res, 200, await fetchMailComSplitAliasCode(
            mailbox,
            email,
            { timeoutMs: config.mailbox.pollTimeoutMs, requireOpenSession: true },
          ));
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_CODE_FETCH_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      const mailComSplitClearInboxMatch = url.pathname.match(/^\/api\/mailbox\/mail-com-split\/accounts\/([^/]+)\/mail\/clear-inbox$/i);
      if (mailComSplitClearInboxMatch && req.method === 'POST') {
        const mailbox = await loadMailComMailbox(decodeURIComponent(mailComSplitClearInboxMatch[1]));
        if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
        try {
          return sendJson(res, 200, await clearMailComSplitInbox(
            mailbox,
            'INBOX',
            { timeoutMs: config.mailbox.pollTimeoutMs, requireOpenSession: true },
          ));
        } catch (error) {
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, payload?.status || 400, payload || {
            error: error?.code || 'MAIL_COM_SPLIT_CLEAR_INBOX_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox/cloudflare-temp-email/generate') {
        const body = await readBody(req);
        const configForCreate = cloudflareTempEmailSettings.getSecretConfig();
        const generated = cloudflareTempEmailSettings.generateAddress(body);
        let email;
        try {
          email = await createCloudflareTempEmailAddress(configForCreate, generated);
        } catch (error) {
          const payload = cloudflareMailboxErrorPayload(error);
          if (payload) return sendJson(res, 400, payload);
          throw error;
        }
        return sendJson(res, 200, {
          email,
          requested: {
            domain: generated.domain,
            localPart: generated.localPart,
            randomSubdomain: generated.randomSubdomain,
          },
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/cloudflare-temp-email') {
        const body = await readBody(req);
        const selection = resolveTaskExecutionSelection(body);
        const configForCreate = cloudflareTempEmailSettings.getSecretConfig();
        const { randomSubdomain, ...addressInput } = body && typeof body === 'object' ? body : {};
        const generated = cloudflareTempEmailSettings.generateAddress(addressInput);
        let email;
        try {
          email = await createCloudflareTempEmailAddress(configForCreate, generated);
        } catch (error) {
          const payload = cloudflareMailboxErrorPayload(error);
          if (payload) return sendJson(res, 400, payload);
          throw error;
        }
        const task = await registrationStore.createJob({
          id: randomUUID(),
          email,
          registrationPassword: resolveRegistrationPassword(body.password, config.defaultPassword),
          mailboxSource: 'cloudflare_temp_email',
          proxyPoolId: body.proxyPoolId || null,
          browserEngine: selection.browserEngine,
          entryBranch: selection.entryBranch,
          mode: 'register',
        });
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 202, { task, email, requested: generated });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/mail-com-split') {
        const body = await readBody(req);
        resolveTaskExecutionSelection(body);
        try {
          const requestedEmail = normalizeEmailValue(body.email);
          let alias;
          let mailbox;
          if (requestedEmail) {
            alias = await mailboxStore.getAlias({ email: requestedEmail });
            if (!alias || alias.status === 'abandoned' || alias.status === 'cleanup_required') {
              return sendJson(res, 404, { error: 'mail_com_split_alias_not_available' });
            }
            mailbox = await loadMailComMailbox(alias.mailboxId);
            if (!mailbox) return sendJson(res, 409, { error: 'mail_com_split_alias_ownership_invalid' });
            assertMailComSessionReady(mailbox);
            const requestedMailbox = String(
              body.accountId || body.mainAccountId || body.mainEmail || body.accountEmail || '',
            ).trim();
            if (requestedMailbox) {
              const explicitMailbox = await loadMailComMailbox(requestedMailbox);
              if (!explicitMailbox || explicitMailbox.id !== mailbox.id) {
                return sendJson(res, 409, { error: 'mail_com_split_alias_ownership_invalid' });
              }
            }
          } else {
            mailbox = await loadMailComMailbox(
              body.accountId || body.mainAccountId || body.mainEmail || body.accountEmail || '',
            );
            if (!mailbox) return sendJson(res, 404, { error: 'mail_com_split_account_not_found' });
            alias = await createOwnedMailComAlias(mailbox, body);
          }
          const task = await createMailComDatabaseJob({ mailbox, alias, body });
          return sendJson(res, 202, {
            task,
            email: alias.email,
            accountId: mailbox.id,
          });
        } catch (error) {
          const conflictCodes = new Set([
            'ALIAS_ALREADY_EXISTS',
            'REGISTRATION_ACCOUNT_CONFLICT',
            'REGISTRATION_ALIAS_ACTIVE_JOB_EXISTS',
            'REGISTRATION_ALIAS_STATE_INVALID',
            'REGISTRATION_JOB_OWNERSHIP_INVALID',
          ]);
          const payload = mailComSplitErrorPayload(error);
          return sendJson(res, conflictCodes.has(error?.code) ? 409 : (payload?.status || 400), payload || {
            error: error?.code || 'MAIL_COM_SPLIT_TASK_CREATE_FAILED',
            message: String(error?.message || error),
          });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/emails/import') {
        const body = await readBody(req);
        const parsed = parseRegistrationCandidates(body.emails || '');
        if (parsed.rejected.length) {
          return sendJson(res, 400, {
            error: 'REGISTRATION_CANDIDATE_LINES_INVALID',
            message: 'one or more import lines do not contain a valid email address',
            rejected: parsed.rejected,
            duplicateLines: parsed.duplicateLines,
          });
        }
        const result = await registrationStore.importCandidates(parsed.candidates);
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 200, { ...result, duplicateLines: parsed.duplicateLines });
      }
      if (req.method === 'POST' && url.pathname === '/api/emails/delete') {
        const body = await readBody(req);
        try {
          return sendJson(res, 200, await registrationStore.deleteReadyCandidates(body.ids || []));
        } catch (error) {
          return sendJson(res, 409, { error: error?.code || 'REGISTRATION_CANDIDATE_DELETE_FAILED', message: String(error?.message || error) });
        }
      }
      const emailStageMatch = url.pathname.match(/^\/api\/emails\/([^/]+)\/mail-com-stage$/i);
      if (emailStageMatch && req.method === 'PUT') {
        const body = await readBody(req);
        const email = decodeURIComponent(emailStageMatch[1]);
        const account = await accountAssetStore.getByEmail(email);
        if (!account) return sendJson(res, 404, { error: 'email_not_found' });
        const stage = String(body.stage || '').trim().toLowerCase();
        const allowedStages = new Set(['payment_method', 'eligibility', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'sold']);
        if (!allowedStages.has(stage)) return sendJson(res, 400, { error: 'unsupported_workflow_stage' });
        const lifecycleStages = new Set(['eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'sold']);
        const soldSmsStatus = stage === 'sold'
          ? (String(account.workflowStage || account.mailComStage || '').trim().toLowerCase() === 'completed' || account.phoneBindStatus === 'completed' ? 'sms' : 'unsms')
          : null;
        const updated = await accountAssetStore.updateByEmail({ email, patch: {
          workflowStage: stage,
          mailComStage: stage,
          ...(stage === 'payment_method' ? { paymentCapabilities: { ...(account.paymentCapabilities || {}), status: 'failed', error: account.paymentCapabilities?.error || 'manual_pending' } } : {}),
          ...(soldSmsStatus ? { soldSmsStatus, soldAt: new Date().toISOString() } : {}),
          ...(lifecycleStages.has(stage) ? { lifecycleStage: stage } : {}),
        } });
        if (stage === MAIL_COM_STAGES.SMS) await scheduleAutomaticPhoneBind({ email, force: true });
        return sendJson(res, 200, { email: updated });
      }
      const gcashSoldMatch = url.pathname.match(/^\/api\/emails\/([^/]+)\/gcash-sold$/i);
      if (gcashSoldMatch && req.method === 'PUT') {
        const body = await readBody(req);
        const email = decodeURIComponent(gcashSoldMatch[1]);
        const account = await accountAssetStore.getByEmail(email);
        if (!account) return sendJson(res, 404, { error: 'email_not_found' });
        if (String(account.workflowStage || account.mailComStage || '').trim().toLowerCase() !== MAIL_COM_STAGES.GCASH) {
          return sendJson(res, 400, { error: 'email_is_not_in_gcash_stage' });
        }
        const updated = await accountAssetStore.updateByEmail({ email, patch: { gcashSold: body.sold !== false } });
        return sendJson(res, 200, { email: updated });
      }
      const emailMatch = url.pathname.match(/^\/api\/emails\/([0-9a-f-]+)$/i);
      if (emailMatch && req.method === 'DELETE') {
        try {
          return sendJson(res, 200, await registrationStore.deleteReadyCandidates([emailMatch[1]]));
        } catch (error) {
          return sendJson(res, 409, { error: error?.code || 'REGISTRATION_CANDIDATE_DELETE_FAILED', message: String(error?.message || error) });
        }
      }
      const accountWorkflowDeleteMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/workflow$/i);
      if (accountWorkflowDeleteMatch && req.method === 'DELETE') {
        const email = decodeURIComponent(accountWorkflowDeleteMatch[1]);
        const key = String(email || '').trim().toLowerCase();
        const account = await accountAssetStore.getByEmail(key, { includeSecret: true });
        let aliasResult = null;
        if (account?.source === 'mail_com_split') {
          const alias = await mailboxStore.getAlias({ email: key });
          if (alias) {
            const mailbox = await loadMailComMailbox(alias.mailboxId);
            if (mailbox && publicMailComSplitSession(mailbox).open) {
              await removeMailComSplitAddress(mailbox, key, { timeoutMs: config.mailbox.pollTimeoutMs, requireOpenSession: true }).catch((error) => {
                if (!/not found|404|does not exist/iu.test(String(error?.message || error))) throw error;
              });
            }
            aliasResult = await mailboxStore.markAliasAbandoned({ aliasId: alias.id });
          }
        }
        const discarded = account
          ? await accountAssetStore.discardUsableAccountByEmail(key, { reason: 'manual_workflow_delete' })
          : await registrationStore.deleteCandidateByEmail(key);
        return sendJson(res, 200, { email: key, discarded, alias: aliasResult?.alias || null });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readBody(req);
        const selection = resolveTaskExecutionSelection(body);
        const alias = await mailboxStore.getAlias({ email: body.email });
        if (alias) {
          return sendJson(res, 400, {
            error: 'mail_com_split_registration_requires_dedicated_endpoint',
            message: 'mail.com split registration must use /api/tasks/mail-com-split',
          });
        }
        const mailboxUrl = String(body.mailboxUrl || '').trim() || null;
        const task = await registrationStore.createJob({
          id: randomUUID(),
          email: body.email,
          registrationPassword: resolveRegistrationPassword(body.password, config.defaultPassword),
          mailboxUrl,
          mailboxSource: body.mailboxSource || (mailboxUrl ? 'share_page' : 'manual'),
          proxyPoolId: body.proxyPoolId || null,
          browserEngine: selection.browserEngine,
          entryBranch: selection.entryBranch,
          mode: 'register',
        });
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 202, task);
      }
      if (req.method === 'POST' && url.pathname === '/api/mailbox-repairability/recheck') {
        const body = await readBody(req);
        const emails = [...new Set((Array.isArray(body.emails) ? body.emails : [])
          .map((email) => String(email || '').trim().toLowerCase())
          .filter(Boolean))].slice(0, 500);
        if (!emails.length) return sendJson(res, 400, { error: 'mailbox_recheck_emails_required' });
        const result = await mailComRegistrationControl.recheckMailboxRepairability({
          emails,
          limit: emails.length,
        });
        if (result.busy) return sendJson(res, 409, { error: 'mailbox_recheck_busy', ...result });
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 200, result);
      }

      const credentialRepairMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/credential-repair$/i);
      if (req.method === 'POST' && credentialRepairMatch) {
        const body = await readBody(req);
        const preferences = await getUiPreferences();
        const task = await registrationStore.createCredentialRepairJob({
          email: decodeURIComponent(credentialRepairMatch[1]),
          proxyPoolId: body.proxyPoolId || preferences.proxyPools?.main || null,
          automatic: false,
        });
        if (!task) {
          return sendJson(res, 409, {
            error: 'credential_repair_not_queued',
            message: '账号凭据已完整、已有抢修任务，或缺少可复用的注册资料。',
          });
        }
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 202, { task });
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
      const taskRetryMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/retry$/i);
      if (req.method === 'POST' && taskRetryMatch) {
        const body = await readBody(req);
        const selection = resolveTaskExecutionSelection(body);
        const task = await registrationStore.retryJob({
          jobId: taskRetryMatch[1],
          proxyPoolId: body.proxyPoolId || null,
          browserEngine: selection.browserEngine,
          entryBranch: selection.entryBranch,
        });
        mailComRegistrationControl.scheduleTask();
        return sendJson(res, 202, { task });
      }
      if (req.method === 'GET' && taskMatch) {
        return sendJson(res, 200, await registrationStore.loadJob({
          jobId: taskMatch[1],
          includeEvents: true,
        }) || { status: 'not_found' });
      }
      const evidenceMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/evidence$/i);
      if (req.method === 'GET' && evidenceMatch) {
        const evidence = new EvidenceStore({
          dataDir: config.dataDir,
          taskId: evidenceMatch[1],
          store: runtimeStateStore,
        });
        return sendJson(res, 200, await evidence.read({
          afterSequence: Number(url.searchParams.get('afterSequence') || 0),
          limit: Number(url.searchParams.get('limit') || 200),
        }));
      }

      if (req.method === 'GET' && url.pathname === '/api/proxy-pools') {
        return sendJson(res, 200, Object.fromEntries(
          (registrationProfile ? ['main', 'eligibility'] : POOL_NAMES).map((name) => [name, proxyPools[name].listPools()]),
        ));
      }
      const proxyPoolCreateMatch = url.pathname.match(/^\/api\/proxy-pools\/(main|eligibility|checkout|payment)$/);
      if (proxyPoolCreateMatch && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, await proxyPools[proxyPoolCreateMatch[1]].createPool({ name: body.name }));
      }
      const proxyPoolMatch = url.pathname.match(/^\/api\/proxy-pools\/(main|eligibility|checkout|payment)\/([a-z0-9_-]+)$/i);
      if (proxyPoolMatch && req.method === 'DELETE') {
        return sendJson(res, 200, await proxyPools[proxyPoolMatch[1]].deletePool(proxyPoolMatch[2]));
      }
      const proxyPoolProxiesMatch = url.pathname.match(/^\/api\/proxy-pools\/(main|eligibility|checkout|payment)\/([a-z0-9_-]+)\/proxies$/i);
      if (proxyPoolProxiesMatch && req.method === 'GET') {
        return sendJson(res, 200, proxyPools[proxyPoolProxiesMatch[1]].list(proxyPoolProxiesMatch[2]));
      }
      if (proxyPoolProxiesMatch && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, {
          imported: await proxyPools[proxyPoolProxiesMatch[1]].importText(body.proxies || '', { poolId: proxyPoolProxiesMatch[2] }),
        });
      }

      const poolMatch = url.pathname.match(/^\/api\/proxies\/(main|eligibility|checkout|payment)$/);
      if (poolMatch && req.method === 'GET') return sendJson(res, 200, proxyPools[poolMatch[1]].list());
      if (poolMatch && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { imported: await proxyPools[poolMatch[1]].importText(body.proxies || '') });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && staticFile(config.publicDir, url.pathname, res, req.method)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const branchDisabled = ['REGISTRATION_IMPLEMENTATION_DISABLED', 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED'].includes(error?.code);
      sendJson(res, branchDisabled ? 400 : 500, { error: branchDisabled ? error.code : String(error?.message || error) });
    }
  });
  const closeHttpServer = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(pipelinePlanTimer);
    clearInterval(automaticPhoneBindReconciler);
    const backgroundStopped = Promise.all([
      paymentCoordinator?.stop(),
      refiningCoordinator?.stop(),
      mailComRegistrationControl.stop(),
    ]);
    return closeHttpServer((closeError) => {
      backgroundStopped.then(
        () => callback?.(closeError),
        (stopError) => callback?.(stopError),
      );
    });
  };
  return server;
}

module.exports = {
  accountSummaryView,
  createServerApp,
  isPhoneBindProxyRetryableError,
  isPhoneBindTransportError,
  mailComMainAccountCatsConflict,
  phoneBindAuthorizationLoginRequired,
  phoneBindAuthorizationStepInvalid,
  phoneBindProxyAttemptLimit,
};
