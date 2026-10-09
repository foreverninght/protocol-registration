'use strict';

const { FullNetworkCollector } = require('../collector/network/full-network-collector');
const { EvidenceStore } = require('../collector/storage/evidence-store');
const { restoreSessionWithCookies } = require('../session/restore-session');
const { accountSessionCookieHeader, exactAccountProxy } = require('../session/session-cookie-renewal');
const { buildAccountLoginState } = require('../session/account-login-state');
const { analyzeTrialEligibility } = require('./trial-eligibility');
const { ProxyAgent } = require('undici');

class EligibilityCheckError extends Error {
  constructor(message, { code = 'ELIGIBILITY_CHECK_FAILED', status = null } = {}) {
    super(message);
    this.name = 'EligibilityCheckError';
    this.code = code;
    this.status = status;
    this.retryableProxy = false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeKeys(value, limit = 30) {
  if (!isRecord(value)) return [];
  return Object.keys(value).slice(0, limit);
}

function summarizeCollection(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (isRecord(value)) return { type: 'object', count: Object.keys(value).length, keys: Object.keys(value).slice(0, 20) };
  if (value === null || value === undefined) return { type: 'missing', count: 0 };
  return { type: typeof value, count: 1 };
}

function isCloudflareChallengeResponse(response = {}) {
  const status = Number(response.status || 0);
  const text = String(response.text || '').toLowerCase();
  const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  return (status === 403 || /text\/html/.test(contentType) || status === 200)
    && /cloudflare|cf-chl|__cf_chl|challenge-platform|cf-mitigated|attention required/.test(text);
}

function scalarEligibilityFlags(value, prefix = '', output = []) {
  if (!isRecord(value) && !Array.isArray(value)) return output;
  if (Array.isArray(value)) {
    value.slice(0, 10).forEach((item, index) => scalarEligibilityFlags(item, `${prefix}[${index}]`, output));
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const lower = key.toLowerCase();
    const interesting = lower.includes('eligible')
      || lower.includes('trial')
      || lower.includes('subscription')
      || lower.includes('entitlement')
      || lower.includes('offer')
      || lower.includes('promo')
      || lower.includes('can_access');
    if (interesting && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child === null)) {
      output.push({ path, value: child });
    }
    if (output.length < 80 && (isRecord(child) || Array.isArray(child))) scalarEligibilityFlags(child, path, output);
  }
  return output.slice(0, 80);
}

function summarizeAccountsCheckBody(body) {
  if (!isRecord(body)) {
    return {
      validJsonObject: false,
      topLevelKeys: [],
      accountsCount: 0,
      accounts: [],
    };
  }
  const accounts = isRecord(body.accounts) ? body.accounts : {};
  const entries = Object.entries(accounts);
  const unique = [];
  const seenAccountIds = new Set();
  for (const [key, account] of entries) {
    if (!isRecord(account)) continue;
    const nestedAccount = isRecord(account.account) ? account.account : {};
    const stableId = String(
      account.id
        || account.account_id
        || account.accountId
        || nestedAccount.id
        || nestedAccount.account_id
        || nestedAccount.accountId
        || key
        || '',
    ).toLowerCase();
    const dedupeKey = stableId || key;
    if (seenAccountIds.has(dedupeKey)) continue;
    seenAccountIds.add(dedupeKey);
    unique.push([key, account]);
  }
  const accountSummaries = unique.slice(0, 20).map(([key, account]) => ({
    key,
    fields: safeKeys(account, 40),
    eligiblePromoCampaigns: summarizeCollection(account.eligible_promo_campaigns),
    eligibleOffers: {
      ...summarizeCollection(account.eligible_offers),
      offersCount: Array.isArray(account.eligible_offers?.offers) ? account.eligible_offers.offers.length : null,
      defaultOfferId: typeof account.eligible_offers?.default_offer_id === 'string' ? account.eligible_offers.default_offer_id : null,
    },
    flags: scalarEligibilityFlags(account),
    entitlement: isRecord(account.entitlement) ? {
      keys: safeKeys(account.entitlement, 30),
      plan: account.entitlement.subscription_plan || account.entitlement.plan || account.entitlement.plan_type || account.entitlement.product || null,
      hasActiveSubscription: typeof account.entitlement.has_active_subscription === 'boolean' ? account.entitlement.has_active_subscription : null,
      trial: isRecord(account.entitlement.trial)
        ? {
          keys: safeKeys(account.entitlement.trial, 30),
          status: account.entitlement.trial.status || account.entitlement.trial.state || null,
          eligible: typeof account.entitlement.trial.eligible === 'boolean' ? account.entitlement.trial.eligible : null,
        }
        : account.entitlement.trial ?? null,
    } : null,
    lastActiveSubscription: isRecord(account.last_active_subscription) ? {
      keys: safeKeys(account.last_active_subscription, 30),
      status: account.last_active_subscription.status || null,
      plan: account.last_active_subscription.subscription_plan || account.last_active_subscription.plan || account.last_active_subscription.plan_type || account.last_active_subscription.product || null,
    } : null,
    canAccessWithSession: typeof account.can_access_with_session === 'boolean' ? account.can_access_with_session : null,
  }));
  const totals = accountSummaries.reduce((result, account) => ({
    eligiblePromoCampaigns: result.eligiblePromoCampaigns + (account.eligiblePromoCampaigns?.count || 0),
    eligibleOffers: result.eligibleOffers + (account.eligibleOffers?.count || 0),
    entitlements: result.entitlements + (account.entitlement ? 1 : 0),
    subscriptions: result.subscriptions + (account.lastActiveSubscription ? 1 : 0),
  }), {
    eligiblePromoCampaigns: 0,
    eligibleOffers: 0,
    entitlements: 0,
    subscriptions: 0,
  });
  return {
    validJsonObject: true,
    topLevelKeys: safeKeys(body, 40),
    accountsContainer: summarizeCollection(body.accounts),
    accountsCount: unique.length,
    totals,
    accounts: accountSummaries,
  };
}


function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeAccountPlanStatus(rawPlan, account = {}) {
  const text = String(rawPlan || '').trim().toLowerCase();
  if (text.includes('enterprise') || text.includes('business') || text.includes('team') || text.includes('workspace')) return 'team';
  if (text.includes('plus')) return 'plus';
  if (text.includes('pro')) return 'pro';
  if (text.includes('free')) return 'free';
  if (text.includes('guest')) return 'guest';
  const entitlement = isRecord(account?.entitlement) ? account.entitlement : {};
  if (entitlement.has_active_subscription === true) return 'subscribed';
  if (account?.can_access_with_session === true) return 'free';
  return 'unknown';
}

function analyzeAccountPlanStatus(body) {
  const now = new Date().toISOString();
  if (!isRecord(body)) {
    return {
      status: 'unknown',
      rawPlan: null,
      hasActiveSubscription: null,
      checkedAt: now,
      source: 'accounts_check',
      reason: 'accounts_check_body_not_object',
      signals: {},
    };
  }
  const accounts = isRecord(body.accounts) ? body.accounts : {};
  const candidates = [];
  for (const [key, account] of Object.entries(accounts)) {
    if (!isRecord(account)) continue;
    const nestedAccount = isRecord(account.account) ? account.account : {};
    const entitlement = isRecord(account.entitlement) ? account.entitlement : {};
    const lastActiveSubscription = isRecord(account.last_active_subscription) ? account.last_active_subscription : {};
    const rawPlan = firstNonEmptyString(
      entitlement.subscription_plan,
      entitlement.plan,
      entitlement.plan_type,
      entitlement.product,
      lastActiveSubscription.subscription_plan,
      lastActiveSubscription.plan,
      lastActiveSubscription.plan_type,
      lastActiveSubscription.product,
      nestedAccount.subscription_plan,
      nestedAccount.plan,
      nestedAccount.plan_type,
      nestedAccount.product,
      account.subscription_plan,
      account.plan,
      account.plan_type,
      account.product,
    ) || null;
    const hasActiveSubscription = entitlement.has_active_subscription === true
      || nestedAccount.has_active_subscription === true
      || account.has_active_subscription === true
      || String(lastActiveSubscription.status || '').trim().toLowerCase() === 'active'
      || Boolean(lastActiveSubscription.subscription_id || lastActiveSubscription.id);
    const canAccessWithSession = typeof nestedAccount.can_access_with_session === 'boolean'
      ? nestedAccount.can_access_with_session
      : typeof account.can_access_with_session === 'boolean'
        ? account.can_access_with_session
        : null;
    const status = normalizeAccountPlanStatus(rawPlan, { ...account, ...nestedAccount });
    candidates.push({
      key,
      accountId: firstNonEmptyString(nestedAccount.id, nestedAccount.account_id, nestedAccount.accountId, account.id, account.account_id, account.accountId, key) || null,
      status,
      rawPlan,
      hasActiveSubscription,
      canAccessWithSession,
      signals: {
        entitlementSubscriptionPlan: entitlement.subscription_plan || null,
        entitlementPlan: entitlement.plan || entitlement.plan_type || entitlement.product || null,
        entitlementHasActiveSubscription: typeof entitlement.has_active_subscription === 'boolean'
          ? entitlement.has_active_subscription
          : null,
        lastActiveSubscriptionStatus: lastActiveSubscription.status || null,
        lastActiveSubscriptionPlan: lastActiveSubscription.subscription_plan
          || lastActiveSubscription.plan
          || lastActiveSubscription.plan_type
          || lastActiveSubscription.product
          || null,
        lastActiveSubscriptionPresent: Boolean(Object.keys(lastActiveSubscription).length),
        defaultOfferId: isRecord(account.eligible_offers) ? (account.eligible_offers.default_offer_id || null) : null,
      },
    });
  }
  const selected = candidates.find((item) => item.hasActiveSubscription && item.status !== 'unknown')
    || candidates.find((item) => item.status !== 'unknown')
    || candidates[0]
    || null;
  if (!selected) {
    return {
      status: 'unknown',
      rawPlan: null,
      hasActiveSubscription: null,
      checkedAt: now,
      source: 'accounts_check',
      reason: 'no_accounts_in_accounts_check',
      signals: {},
    };
  }
  return {
    status: selected.status,
    rawPlan: selected.rawPlan,
    hasActiveSubscription: selected.hasActiveSubscription,
    accountId: selected.accountId,
    canAccessWithSession: selected.canAccessWithSession,
    checkedAt: now,
    source: 'accounts_check',
    signals: selected.signals,
    candidates: candidates.slice(0, 5).map((item) => ({
      key: item.key,
      status: item.status,
      rawPlan: item.rawPlan,
      hasActiveSubscription: item.hasActiveSubscription,
      canAccessWithSession: item.canAccessWithSession,
    })),
  };
}

function analyzeAuthSessionAccountPlan(body) {
  const now = new Date().toISOString();
  if (!isRecord(body)) {
    return {
      status: 'unknown',
      rawPlan: null,
      hasActiveSubscription: null,
      checkedAt: now,
      source: 'auth_session',
      reason: 'auth_session_body_not_object',
      signals: {},
    };
  }
  const account = isRecord(body.account) ? body.account : {};
  const rawPlan = firstNonEmptyString(
    account.planType,
    account.plan_type,
    account.plan,
    account.subscription_plan,
    body.planType,
    body.plan_type,
    body.plan,
  ) || null;
  const status = normalizeAccountPlanStatus(rawPlan, account);
  const accountId = firstNonEmptyString(
    account.id,
    account.accountId,
    account.account_id,
    body.accountId,
    body.account_id,
  ) || null;
  const paid = ['plus', 'team', 'pro', 'subscribed'].includes(status);
  return {
    status,
    rawPlan,
    hasActiveSubscription: paid ? true : null,
    accountId,
    checkedAt: now,
    source: 'auth_session',
    signals: {
      accountPlanType: account.planType || account.plan_type || null,
      accountIdPresent: Boolean(accountId),
      userEmailPresent: Boolean(body.user?.email),
    },
    reason: rawPlan ? null : 'auth_session_plan_missing',
  };
}

async function fetchAuthSessionPlan(page, { timeoutMs }) {
  const nonce = Date.now();
  const response = await fetchChatgptJson(page, `/api/auth/session?refresh=${encodeURIComponent(String(nonce))}&source=account_status`, { timeoutMs });
  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    accountPlan: analyzeAuthSessionAccountPlan(response.body),
  };
}

function persistedAccountStatusPayload({ account, restored, restoredCookieHeader, accountPlan, result }) {
  return {
    accountPlan,
    accountPlanStatus: accountPlan.status,
    accountPlanRaw: accountPlan.rawPlan,
    accountPlanHasActiveSubscription: accountPlan.hasActiveSubscription,
    accountPlanLastCheckedAt: result.checkedAt,
    accountPlanError: null,
    ...(restored ? {
      session: { ...account.session, cookies: restored.cookies, refreshedAt: result.checkedAt },
      sessionContext: {
        ...(account.sessionContext || {}),
        cookie: restoredCookieHeader,
        refreshedAt: result.checkedAt,
      },
    } : {}),
    ...(restored?.accessToken ? { tokens: { ...(account.tokens || {}), accessToken: restored.accessToken, refreshedAt: result.checkedAt } } : {}),
    sessionAvailable: true,
  };
}

function isAuthenticatedAccountPlanStatus(accountPlan) {
  const status = String(accountPlan?.status || '').trim().toLowerCase();
  const accountId = String(accountPlan?.accountId || '').trim().toLowerCase();
  return Boolean(accountId)
    && accountId !== 'default'
    && !['guest', 'unknown'].includes(status);
}

async function fetchChatgptJson(page, path, { timeoutMs, accessToken = '' }) {
  const result = await page.evaluate(async ({ path, accessToken }) => {
    const response = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      body,
      text,
    };
  }, { path, timeoutMs, accessToken: String(accessToken || '').trim() });
  return result;
}

function accountCheckBasePath() {
  return '/backend-api/accounts/check/v4-2023-04-27';
}

function normalizeFreeppSessionContext(sessionContext) {
  if (!isRecord(sessionContext)) return {};
  return {
    cookie: String(sessionContext.cookie || sessionContext.cookieHeader || '').trim(),
    userAgent: String(sessionContext.user_agent || sessionContext.userAgent || '').trim(),
    oaiDeviceId: String(sessionContext.oai_device_id || sessionContext.oaiDeviceId || '').trim(),
  };
}

async function fetchAccountsCheckWithSessionCookie(account, { timeoutMs = 30000 } = {}) {
  const cookie = accountSessionCookieHeader(account);
  if (!cookie) {
    throw new EligibilityCheckError('session cookie is required for accounts/check', {
      code: 'ACCOUNT_STATUS_COOKIE_MISSING',
    });
  }
  const context = normalizeFreeppSessionContext({
    ...(account?.sessionContext || {}),
    cookie,
  });
  const headers = {
    accept: 'application/json',
    cookie: context.cookie || cookie,
    referer: 'https://chatgpt.com/',
    origin: 'https://chatgpt.com',
    'oai-language': 'en-US',
  };
  if (context.userAgent) headers['user-agent'] = context.userAgent;
  if (context.oaiDeviceId) headers['oai-device-id'] = context.oaiDeviceId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(`https://chatgpt.com${accountCheckBasePath()}`, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      body,
      text,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new EligibilityCheckError('accounts/check timed out with session cookie', {
        code: 'ACCOUNT_STATUS_COOKIE_TIMEOUT',
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function proxyDispatcher(proxy) {
  if (!proxy?.host || !proxy?.port) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return new ProxyAgent(`http://${auth}${proxy.host}:${proxy.port}`);
}

async function fetchAccountsCheckWithAccessToken(accessToken, { timeoutMs = 30000, proxy = null, sessionContext = null } = {}) {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new EligibilityCheckError('access token is required for accounts/check', {
      code: 'ELIGIBILITY_ACCESS_TOKEN_MISSING',
    });
  }
  const context = normalizeFreeppSessionContext(sessionContext);
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    referer: 'https://chatgpt.com/',
    origin: 'https://chatgpt.com',
    'oai-language': 'en-US',
  };
  if (context.cookie) headers.cookie = context.cookie;
  if (context.userAgent) headers['user-agent'] = context.userAgent;
  if (context.oaiDeviceId) headers['oai-device-id'] = context.oaiDeviceId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));
  const dispatcher = proxyDispatcher(proxy);
  try {
    const response = await fetch(`https://chatgpt.com${accountCheckBasePath()}`, {
      method: 'GET',
      signal: controller.signal,
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      body,
      text,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new EligibilityCheckError('accounts/check timed out with access token', {
        code: 'ELIGIBILITY_ACCESS_TOKEN_TIMEOUT',
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await dispatcher?.close?.().catch(() => {});
  }
}

async function runAccessTokenEligibilityCheck({ accessToken, timeoutMs = 30000, proxy = null, sessionContext = null } = {}) {
  const accountsCheck = await fetchAccountsCheckWithAccessToken(accessToken, { timeoutMs, proxy, sessionContext });
  if (isCloudflareChallengeResponse(accountsCheck)) {
    const error = new EligibilityCheckError('accounts/check was blocked by a Cloudflare challenge', { code: 'ELIGIBILITY_CLOUDFLARE_CHALLENGE', status: accountsCheck.status || 403 });
    error.retryableProxy = true;
    throw error;
  }
  if (accountsCheck.status !== 200) {
    throw new EligibilityCheckError(`accounts/check failed with access token (HTTP ${accountsCheck.status || 0})`, {
      code: accountsCheck.status === 401
        ? 'ELIGIBILITY_ACCESS_TOKEN_AUTH_STALE'
        : accountsCheck.status === 403
          ? 'ELIGIBILITY_CLOUDFLARE_CHALLENGE'
          : 'ELIGIBILITY_ACCESS_TOKEN_CHECK_FAILED',
      status: accountsCheck.status || null,
    });
  }
  const trialEligibility = analyzeTrialEligibility(accountsCheck.body);
  return {
    checkedAt: new Date().toISOString(),
    proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
    sessionStatus: 200,
    accountsCheckSource: normalizeFreeppSessionContext(sessionContext).cookie ? 'access_token_session_fetch' : 'access_token_fetch',
    accountsCheckStatus: accountsCheck.status,
    accountsCheckSummary: summarizeAccountsCheckBody(accountsCheck.body),
    trialEligibility,
  };
}

async function browserTimezoneOffsetMinutes(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const offset = await page.evaluate(() => new Date().getTimezoneOffset());
    return Number.isFinite(Number(offset)) ? Number(offset) : null;
  } catch {
    return null;
  }
}

async function accountsCheckPathWithBrowserTimezone(page) {
  const offset = await browserTimezoneOffsetMinutes(page);
  if (offset === null) return accountCheckBasePath();
  return `${accountCheckBasePath()}?timezone_offset_min=${encodeURIComponent(String(offset))}`;
}

function isFrontendAccountsCheckResponse(response) {
  try {
    const rawUrl = typeof response?.url === 'function' ? response.url() : response?.url;
    const url = new URL(String(rawUrl || ''));
    if (url.hostname !== 'chatgpt.com') return false;
    if (url.pathname !== accountCheckBasePath()) return false;
    const request = typeof response?.request === 'function' ? response.request() : null;
    if (request && typeof request.method === 'function' && request.method() !== 'GET') return false;
    const headers = request && typeof request.headers === 'function' ? request.headers() : {};
    return url.searchParams.has('timezone_offset_min') || Boolean(headers?.['oai-client-build-number']);
  } catch {
    return false;
  }
}

async function readBrowserResponseJson(response) {
  const status = typeof response?.status === 'function' ? response.status() : response?.status;
  const url = typeof response?.url === 'function' ? response.url() : response?.url;
  let text = '';
  try {
    text = typeof response?.text === 'function' ? await response.text() : String(response?.text || '');
  } catch {}
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    body,
    text,
  };
}

async function fetchFrontendAccountsCheck(page, { timeoutMs }) {
  if (!page || typeof page.waitForResponse !== 'function' || typeof page.goto !== 'function') return null;
  const boundedTimeoutMs = Math.max(1000, Math.min(Number(timeoutMs) || 15000, 20000));
  const responsePromise = page.waitForResponse(isFrontendAccountsCheckResponse, { timeout: boundedTimeoutMs })
    .catch(() => null);
  await page.goto('https://chatgpt.com/', {
    waitUntil: 'domcontentloaded',
    timeout: boundedTimeoutMs,
  }).catch(() => {});
  const response = await responsePromise;
  if (!response) return null;
  return readBrowserResponseJson(response);
}

async function fetchBestAccountsCheck(page, { timeoutMs }) {
  const frontend = await fetchFrontendAccountsCheck(page, { timeoutMs });
  if (frontend?.status) {
    return {
      source: 'frontend_bootstrap',
      result: frontend,
    };
  }
  const path = await accountsCheckPathWithBrowserTimezone(page);
  const direct = await fetchChatgptJson(page, path, { timeoutMs });
  return {
    source: 'direct_fetch',
    result: direct,
  };
}

async function runEligibilityCheckAttempt({
  config,
  accountStore,
  email,
  account,
  proxy,
  taskId,
  evidence,
  event,
}) {
  let restored = null;
  try {
    event('eligibility.started', {
      email,
      proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
    });
    const loginState = buildAccountLoginState(account);
    restored = await restoreSessionWithCookies({
      config,
      proxy,
      cookies: loginState.cookies.length ? loginState.cookies : account.session.cookies,
      expectedEmail: email,
      collectorFactory: evidence
        ? async ({ page, context }) => new FullNetworkCollector({
          page,
          context,
          store: evidence,
          taskId,
          blockImages: config.collector.blockImages,
          captureBodies: config.collector.captureBodies,
          maxEvents: config.collector.maxEvents,
        }).start()
        : null,
    });
    event('eligibility.session_restored', { status: restored.sessionStatus, email });
    const accountsCheckFetch = await fetchBestAccountsCheck(restored.browserSession.page, {
      timeoutMs: config.browser.operationTimeoutMs,
    });
    const accountsCheck = accountsCheckFetch.result;
    const trialEligibility = analyzeTrialEligibility(accountsCheck.body);
    const accountsCheckSummary = summarizeAccountsCheckBody(accountsCheck.body);
    const result = {
      checkedAt: new Date().toISOString(),
      proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
      sessionStatus: restored.sessionStatus,
      accountsCheckSource: accountsCheckFetch.source,
      accountsCheckStatus: accountsCheck.status,
      accountsCheckSummary,
      trialEligibility,
    };
    await accountStore.updateByEmail({ email, patch: {
      status: account.status || 'registered',
      eligibilityStatus: trialEligibility.status,
      trialEligibility,
      eligibilityLastResult: result,
      eligibilityLastCheckedAt: result.checkedAt,
      ...(restored ? { session: { ...account.session, cookies: restored.cookies, refreshedAt: result.checkedAt } } : {}),
      ...(restored?.accessToken ? { tokens: { ...(account.tokens || {}), accessToken: restored.accessToken, refreshedAt: result.checkedAt } } : {}),
      sessionAvailable: true,
    } });
    event('eligibility.completed', result);
    return result;
  } finally {
    await restored?.browserSession?.close?.().catch(() => {});
  }
}

async function runEligibilityCheck({
  config,
  accountStore,
  proxyPools,
  runtimeStateStore,
  email,
  taskId = null,
  proxyPoolId = null,
  attemptRunner = runEligibilityCheckAttempt,
}) {
  if (!accountStore) throw new TypeError('accountStore is required');
  const account = await accountStore.getByEmail(email, { includeSecret: true });
  if (!account) throw new EligibilityCheckError('account was not found', { code: 'ELIGIBILITY_ACCOUNT_NOT_FOUND' });
  if (!buildAccountLoginState(account).cookies.length && !account.session?.cookies?.length) {
    const error = new EligibilityCheckError('account has no saved session cookies', { code: 'ELIGIBILITY_SESSION_MISSING' });
    await accountStore.updateByEmail({ email, patch: {
      eligibilityStatus: 'failed',
      eligibilityError: { code: error.code, message: error.message },
      eligibilityLastCheckedAt: new Date().toISOString(),
    } });
    throw error;
  }

  const evidence = taskId ? new EvidenceStore({ dataDir: config.dataDir, taskId, store: runtimeStateStore }) : null;
  const event = (type, payload = {}) => evidence?.record?.({ type, payload });
  const maxAttempts = Math.max(1, Math.min(Number(config.browser?.maxProxyAttempts) || 1, 100));
  const attemptedProxyIds = new Set();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proxy = await proxyPools.eligibility.pickNext({
      poolId: proxyPoolId || undefined,
      excludeIds: [...attemptedProxyIds],
    });
    if (proxy) attemptedProxyIds.add(proxy.id);
    try {
      const result = await attemptRunner({
        config,
        accountStore,
        email,
        account,
        proxy,
        taskId,
        evidence,
        event: (type, payload = {}) => event(type, {
          ...payload,
          proxyAttempt: attempt,
          maxProxyAttempts: proxy ? maxAttempts : 1,
        }),
      });
      if (proxy) {
        await proxyPools.eligibility.markChecked?.(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined });
      }
      return result;
    } catch (error) {
      lastError = error;
      const retryableProxy = Boolean(proxy) && error?.retryableProxy !== false;
      if (retryableProxy) {
        await proxyPools.eligibility.markBad(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined, reason: error?.message || error });
      }
      const canRetry = retryableProxy && attempt < maxAttempts;
      event(canRetry ? 'eligibility.retrying_proxy' : 'eligibility.failed', {
        proxyAttempt: attempt,
        maxProxyAttempts: proxy ? maxAttempts : 1,
        proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
        error: { code: error?.code || 'ELIGIBILITY_CHECK_FAILED', message: String(error?.message || error) },
      });
      if (!canRetry) {
        await accountStore.updateByEmail({ email, patch: {
          eligibilityStatus: 'failed',
          eligibilityError: { code: error?.code || 'ELIGIBILITY_CHECK_FAILED', message: String(error?.message || error) },
          eligibilityLastCheckedAt: new Date().toISOString(),
        } });
        throw error;
      }
    }
  }

  throw lastError || new EligibilityCheckError('eligibility check did not run', { code: 'ELIGIBILITY_NOT_RUN' });
}


async function runAccountStatusCheckAttempt({
  config,
  accountStore,
  email,
  account,
  proxy,
  taskId,
  evidence,
  event,
}) {
  let restored = null;
  let restoredCookieHeader = '';
  try {
    event('account_status.started', {
      email,
      proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
    });
      let accountsCheckFetch = null;
      let accountsCheck = null;
      const loginState = buildAccountLoginState(account);
      let restoreError = null;
      try {
        restored = await restoreSessionWithCookies({
          config,
          proxy,
          cookies: loginState.cookies.length ? loginState.cookies : account.session?.cookies || [],
          expectedEmail: email,
          collectorFactory: evidence
            ? async ({ page, context }) => new FullNetworkCollector({
              page,
              context,
              store: evidence,
              taskId,
              blockImages: config.collector.blockImages,
              captureBodies: config.collector.captureBodies,
              maxEvents: config.collector.maxEvents,
            }).start()
            : null,
        });
        event('account_status.session_restored', { status: restored.sessionStatus, email });
        const restoredAccount = {
          ...account,
          session: {
            ...(account?.session || {}),
            cookies: restored.cookies || loginState.cookies,
          },
        };
        restoredCookieHeader = accountSessionCookieHeader(restoredAccount);
        const browserAccountsCheckFetch = await fetchBestAccountsCheck(restored.browserSession.page, {
          timeoutMs: config.browser.operationTimeoutMs,
        });
        accountsCheck = browserAccountsCheckFetch.result;
        accountsCheckFetch = {
          source: `restored_${browserAccountsCheckFetch.source}`,
          result: accountsCheck,
        };
      } catch (error) {
        restoreError = error;
        event('account_status.session_restore_failed', {
          email,
          error: { code: error?.code || 'SESSION_RESTORE_FAILED', message: String(error?.message || error).slice(0, 500) },
        });
      }
      const restoredAccessToken = String(account?.tokens?.accessToken || '').trim();
      if (restored && restoredAccessToken && accountsCheck?.status === 200) {
        const restoredPlan = analyzeAccountPlanStatus(accountsCheck.body);
        if (!isAuthenticatedAccountPlanStatus(restoredPlan)) {
          const tokenPath = await accountsCheckPathWithBrowserTimezone(restored.browserSession.page);
          accountsCheck = await fetchChatgptJson(restored.browserSession.page, tokenPath, {
            timeoutMs: config.browser.operationTimeoutMs,
            accessToken: restoredAccessToken,
          });
          accountsCheckFetch = { source: 'restored_access_token_fetch', result: accountsCheck };
        }
      }
      if ((!accountsCheck || accountsCheck.status !== 200) && !restored) {
        const savedAccessToken = String(account?.tokens?.accessToken || '').trim();
        if (savedAccessToken) {
          accountsCheck = await fetchAccountsCheckWithAccessToken(savedAccessToken, {
            timeoutMs: config.browser.operationTimeoutMs,
            sessionContext: {
              ...(account?.sessionContext || {}),
              cookie: accountSessionCookieHeader(account),
            },
          });
          accountsCheckFetch = { source: 'saved_access_token_fallback_fetch', result: accountsCheck };
          const savedPlan = accountsCheck.status === 200
            ? analyzeAccountPlanStatus(accountsCheck.body)
            : null;
          if (savedPlan && !isAuthenticatedAccountPlanStatus(savedPlan)) {
            event('account_status.saved_access_token_untrusted', {
              email,
              status: savedPlan.status,
              accountId: savedPlan.accountId,
            });
            accountsCheck = null;
          }
        } else if (restoreError) {
          throw restoreError;
        }
      }
    if (isCloudflareChallengeResponse(accountsCheck)) {
      const error = new EligibilityCheckError('accounts/check was blocked by a Cloudflare challenge', { code: 'ACCOUNT_STATUS_CLOUDFLARE_CHALLENGE', status: accountsCheck.status || 403 });
      error.details = {
        accountsCheckSource: accountsCheckFetch?.source || null,
        accountsCheckStatus: accountsCheck.status || 403,
        proxyCountry: proxy?.country || null,
        responseClass: 'cloudflare_challenge',
      };
      error.retryableProxy = Boolean(proxy);
      throw error;
    }
    if (!accountsCheck || accountsCheck.status !== 200) {
      const status = Number(accountsCheck?.status || 0);
      const code = status === 401
        ? 'ACCOUNT_STATUS_AUTH_STALE'
        : status === 403
          ? 'ACCOUNT_STATUS_CLOUDFLARE_CHALLENGE'
          : 'ACCOUNT_STATUS_CHECK_FAILED';
      const error = new EligibilityCheckError(`accounts/check failed for account status (HTTP ${accountsCheck?.status || 0})`, {
        code,
        status: accountsCheck?.status || null,
      });
      error.details = {
        accountsCheckSource: accountsCheckFetch?.source || null,
        accountsCheckStatus: status || null,
        proxyCountry: proxy?.country || null,
        responseClass: code === 'ACCOUNT_STATUS_CLOUDFLARE_CHALLENGE' ? 'cloudflare_challenge' : code === 'ACCOUNT_STATUS_AUTH_STALE' ? 'http_401' : 'http_error',
      };
      error.retryableProxy = Boolean(proxy) && status !== 401;
      throw error;
    }
    if (!isRecord(accountsCheck.body)
      || !isRecord(accountsCheck.body.accounts)
      || !Object.values(accountsCheck.body.accounts).some((item) => isRecord(item))) {
      const error = new EligibilityCheckError(
        'accounts/check returned HTTP 200 but no authenticated account',
        { code: 'ACCOUNT_STATUS_UNAUTHENTICATED_RESPONSE', status: accountsCheck.status },
      );
      error.details = {
        accountsCheckSource: accountsCheckFetch?.source || null,
        accountsCheckStatus: accountsCheck.status,
        proxyCountry: proxy?.country || null,
        responseClass: 'empty_or_unauthenticated_body',
      };
      error.retryableProxy = false;
      throw error;
    }
    const accountPlan = analyzeAccountPlanStatus(accountsCheck.body);
    if (!isAuthenticatedAccountPlanStatus(accountPlan)) {
      const error = new EligibilityCheckError('accounts/check did not return a real authenticated account', {
        code: 'ACCOUNT_STATUS_UNAUTHENTICATED_RESPONSE',
        status: accountsCheck.status,
      });
      error.details = {
        accountsCheckSource: accountsCheckFetch?.source || null,
        accountsCheckStatus: accountsCheck.status,
        proxyCountry: proxy?.country || null,
        responseClass: 'account_identity_missing',
      };
      error.retryableProxy = false;
      throw error;
    }
    const accountsCheckSummary = summarizeAccountsCheckBody(accountsCheck.body);
    const result = {
      checkedAt: new Date().toISOString(),
      proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
      sessionStatus: restored?.sessionStatus || null,
      accountsCheckSource: accountsCheckFetch.source,
      accountsCheckStatus: accountsCheck.status,
      accountsCheckSummary,
      accountPlan,
    };
    await accountStore.updateByEmail({ email, patch: {
      accountPlan,
      accountPlanStatus: accountPlan.status,
      accountPlanRaw: accountPlan.rawPlan,
      accountPlanHasActiveSubscription: accountPlan.hasActiveSubscription,
      accountPlanLastCheckedAt: result.checkedAt,
      accountPlanError: null,
      ...(restored ? {
        session: { ...account.session, cookies: restored.cookies, refreshedAt: result.checkedAt },
        sessionContext: {
          ...(account.sessionContext || {}),
          cookie: restoredCookieHeader,
          refreshedAt: result.checkedAt,
        },
      } : {}),
      ...(restored?.accessToken ? { tokens: { ...(account.tokens || {}), accessToken: restored.accessToken, refreshedAt: result.checkedAt } } : {}),
      sessionAvailable: true,
    } });
    event('account_status.completed', result);
    return result;
  } finally {
    await restored?.browserSession?.close?.().catch(() => {});
  }
}

async function runAccountStatusCheck({
  config,
  accountStore,
  proxyPools,
  runtimeStateStore,
  email,
  taskId = null,
  proxyPoolId = null,
  attemptRunner = runAccountStatusCheckAttempt,
}) {
  if (!accountStore) throw new TypeError('accountStore is required');
  const account = await accountStore.getByEmail(email, { includeSecret: true });
  if (!account) throw new EligibilityCheckError('account was not found', { code: 'ACCOUNT_STATUS_ACCOUNT_NOT_FOUND' });
  if (!buildAccountLoginState(account).cookies.length && !account.session?.cookies?.length) {
    const error = new EligibilityCheckError('account has no saved session cookies', { code: 'ACCOUNT_STATUS_SESSION_MISSING' });
    await accountStore.updateByEmail({ email, patch: {
      accountPlanStatus: 'failed',
      accountPlanError: { code: error.code, message: error.message },
      accountPlanLastCheckedAt: new Date().toISOString(),
    } });
    throw error;
  }

  const evidence = taskId ? new EvidenceStore({ dataDir: config.dataDir, taskId, store: runtimeStateStore }) : null;
  const event = (type, payload = {}) => evidence?.record?.({ type, payload });
  const maxAttempts = Math.max(1, Math.min(Number(config.browser?.maxProxyAttempts) || 1, 100));
  const attemptedProxyIds = new Set();
  const originalProxy = exactAccountProxy(account, proxyPools, proxyPoolId || account.registrationEnvironment?.proxyPoolId || null);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proxy = attempt === 1 && originalProxy
      ? originalProxy
      : await proxyPools.eligibility.pickNext({
        poolId: proxyPoolId || undefined,
        excludeIds: [...attemptedProxyIds],
      });
    if (proxy) attemptedProxyIds.add(proxy.id);
    try {
      const result = await attemptRunner({
        config,
        accountStore,
        email,
        account,
        proxy,
        taskId,
        evidence,
        event: (type, payload = {}) => event(type, {
          ...payload,
          proxyAttempt: attempt,
          maxProxyAttempts: proxy ? maxAttempts : 1,
        }),
      });
      if (proxy) {
        const targetPools = proxy === originalProxy ? proxyPools.main : proxyPools.eligibility;
        await targetPools.markChecked?.(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined });
      }
      return result;
    } catch (error) {
      lastError = error;
      const retryableProxy = Boolean(proxy) && error?.retryableProxy !== false;
      if (retryableProxy) {
        const targetPools = proxy === originalProxy ? proxyPools.main : proxyPools.eligibility;
        await targetPools.markBad?.(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined, reason: error?.message || error });
      }
      const canRetry = retryableProxy && attempt < maxAttempts;
      event(canRetry ? 'account_status.retrying_proxy' : 'account_status.failed', {
        proxyAttempt: attempt,
        maxProxyAttempts: proxy ? maxAttempts : 1,
        proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country, host: proxy.host, port: proxy.port } : null,
        error: { code: error?.code || 'ACCOUNT_STATUS_CHECK_FAILED', message: String(error?.message || error) },
      });
      if (!canRetry) {
        const authStale = error?.code === 'ACCOUNT_STATUS_AUTH_STALE';
        const checkedAt = new Date().toISOString();
        await accountStore.updateByEmail({ email, patch: {
          ...(authStale ? {
            accountPlan: {
              status: 'auth_stale',
              rawPlan: null,
              hasActiveSubscription: null,
              checkedAt,
              source: 'accounts_check',
              reason: 'saved_login_state_rejected',
            },
            sessionAvailable: false,
            sessionCookieStatus: 'stale',
          } : {}),
          accountPlanStatus: authStale ? 'auth_stale' : 'failed',
          accountPlanError: {
            code: error?.code || 'ACCOUNT_STATUS_CHECK_FAILED',
            message: String(error?.message || error),
            ...(error?.details ? { details: error.details } : {}),
          },
          accountPlanLastCheckedAt: checkedAt,
        } });
        throw error;
      }
    }
  }

  throw lastError || new EligibilityCheckError('account status check did not run', { code: 'ACCOUNT_STATUS_NOT_RUN' });
}

module.exports = {
  runEligibilityCheck,
  runAccountStatusCheck,
  runAccessTokenEligibilityCheck,
  fetchChatgptJson,
  fetchAccountsCheckWithAccessToken,
  fetchFrontendAccountsCheck,
  fetchBestAccountsCheck,
  accountsCheckPathWithBrowserTimezone,
  EligibilityCheckError,
  summarizeAccountsCheckBody,
  analyzeAccountPlanStatus,
  isAuthenticatedAccountPlanStatus,
};
