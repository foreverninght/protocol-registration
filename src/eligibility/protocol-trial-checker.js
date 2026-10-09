'use strict';

const { runProtocolTrialCheck } = require('./protocol-trial-worker');

function sanitizedDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bounded = (n, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : null;
  const phases = ['input', 'bootstrap', 'authorize_continue', 'password_verify', 'mfa_factor', 'mfa_issue', 'mfa_verify', 'reauthorize', 'redirect', 'callback', 'session'];
  const reasons = ['LOGIN_INPUT_MISSING', 'LOGIN_STEP_FAILED', 'LOGIN_HTTP_ERROR', 'LOGIN_CREDENTIALS_REJECTED', 'LOGIN_RESPONSE_INVALID', 'LOGIN_PASSWORD_PAGE_MISSING', 'LOGIN_MFA_FACTOR_MISSING', 'LOGIN_MFA_CODE_REJECTED', 'LOGIN_MFA_REJECTED', 'LOGIN_CONTINUE_MISSING', 'LOGIN_CALLBACK_INVALID', 'LOGIN_CALLBACK_REUSED', 'LOGIN_SESSION_MISSING'];
  return {
    category: ['timeout', 'tls', 'proxy', 'http', 'protocol', 'unknown'].includes(value.category) ? value.category : 'unknown',
    httpStatus: bounded(value.httpStatus, 100, 599),
    curlCode: bounded(value.curlCode, 1, 99),
    ...(phases.includes(value.phase) && reasons.includes(value.reason) ? { phase: value.phase, reason: value.reason } : {}),
  };
}

function resultRecord(result, proxy) {
  const checkedAt = new Date().toISOString();
  const status = result.status === 'eligible' ? 'eligible' : result.status === 'ineligible' ? 'not_eligible' : 'failed';
  return {
    checkedAt,
    source: 'protocol_trial_worker',
    campaignId: result.campaignId,
    amountMinor: result.amountMinor,
    currency: result.currency,
    billingCountry: result.billingCountry,
    mfaVerified: result.mfaVerified,
    accountIdVerified: true,
    protocolStatus: result.status,
    proxy: proxy ? { id: proxy.id, poolId: proxy.poolId || null, country: proxy.country || null } : null,
    trialEligibility: {
      status,
      label: status === 'eligible' ? '试用资格可用' : status === 'not_eligible' ? '暂无试用资格' : '资格检测失败',
      reason: 'independent pure-protocol qualification check',
      promoId: result.campaignId,
      hits: [],
    },
  };
}

async function runProtocolEligibilityCheck({ accountStore, proxyPools, email, proxyPoolId = null,
  maxAttempts = 3, worker = runProtocolTrialCheck, onStage = null } = {}) {
  const account = await accountStore.getByEmail(email, { includeSecret: true });
  if (!account) throw Object.assign(new Error('account was not found'), { code: 'ELIGIBILITY_ACCOUNT_NOT_FOUND' });
  let attempts = 0;
  const updateLatest = async (buildPatch) => {
    for (let saveAttempt = 0; ; saveAttempt += 1) {
      const latest = await accountStore.getByEmail(account.email, { includeSecret: true });
      if (!latest) throw Object.assign(new Error('account was not found'), { code: 'ELIGIBILITY_ACCOUNT_NOT_FOUND' });
      try {
        return await accountStore.updateByEmail({ email: account.email, expectedVersion: latest.version, patch: buildPatch(latest) });
      } catch (error) {
        if (error?.code !== 'ACCOUNT_VERSION_CONFLICT' || saveAttempt >= 2) throw error;
      }
    }
  };
  const persistFailure = async (error) => {
    await updateLatest(() => ({
      eligibilityStatus: 'failed',
      eligibilityError: {
        code: error?.code || 'ELIGIBILITY_CHECK_FAILED', message: String(error?.message || error),
        diagnostic: sanitizedDiagnostic(error?.diagnostic), attempts,
      },
      eligibilityLastCheckedAt: new Date().toISOString(),
    }));
    return error;
  };
  if (account.passwordStatus !== 'has_password' || account.totpStatus !== 'enabled'
    || !account.password || !account.totpSecret || !account.tokens?.accessToken) {
    throw await persistFailure(Object.assign(new Error('account requires password, TOTP secret, and access-token identity'), {
      code: 'TRIAL_ACCOUNT_NOT_READY', retryableProxy: false,
    }));
  }
  const attempted = new Set();
  let lastError = null;
  const budget = Math.max(1, Math.min(Math.floor(Number(maxAttempts)) || 1, 3));
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    let proxy;
    try {
      proxy = await proxyPools.main.pickNext({
        poolId: proxyPoolId || undefined,
        excludeIds: [...attempted],
      });
      if (!proxy) {
        lastError = Object.assign(new Error('eligibility proxy pool has no available proxy'), {
          code: 'ELIGIBILITY_PROXY_UNAVAILABLE', retryableProxy: false,
        });
        break;
      }
      attempted.add(proxy.id);
      attempts += 1;
      const protocolResult = await worker({ account, proxy, onStage });
      if (protocolResult.status === 'error') throw Object.assign(new Error('trial probe returned no conclusive result'), {
        code: protocolResult.errorCode || 'TRIAL_PROBE_FAILED', retryableProxy: false,
      });
      await proxyPools.main.markChecked?.(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined });
      const result = resultRecord(protocolResult, proxy);
      await updateLatest((latest) => {
        const previousHistory = Array.isArray(latest.eligibilityCheckHistory) ? latest.eligibilityCheckHistory : [];
        const history = [...previousHistory, ...(latest.eligibilityLastResult ? [latest.eligibilityLastResult] : [])].slice(-19);
        const sessionUnchanged = ['accessToken', 'sessionToken'].every((key) => latest.tokens?.[key] === account.tokens?.[key])
          && ['password', 'totpSecret'].every((key) => latest[key] === account[key])
          && ['session', 'sessionContext'].every((key) => JSON.stringify(latest[key]) === JSON.stringify(account[key]));
        const refreshedTokens = protocolResult.session && sessionUnchanged ? {
          ...(latest.tokens || {}),
          accessToken: protocolResult.session.accessToken || latest.tokens?.accessToken || '',
          sessionToken: protocolResult.session.sessionToken || latest.tokens?.sessionToken || '',
          refreshedAt: result.checkedAt,
        } : latest.tokens;
        return {
          eligibilityStatus: result.trialEligibility.status,
          trialEligibility: result.trialEligibility,
          eligibilityLastResult: result,
          eligibilityLastCheckedAt: result.checkedAt,
          eligibilityError: null,
          eligibilityCheckHistory: history,
          tokens: refreshedTokens,
          sessionAvailable: Boolean(refreshedTokens?.sessionToken || latest.sessionAvailable),
        };
      });
      return result;
    } catch (error) {
      lastError = error;
      if (proxy && error?.retryableProxy === true && !error?.diagnostic?.httpStatus && !error?.httpStatus) {
        try {
          await proxyPools.main.markBad?.(proxy.id, {
            poolId: proxy.poolId || proxyPoolId || undefined,
            reason: error?.code || error?.message || error,
          });
        } catch {
          break;
        }
        if (attempt < budget) continue;
      } else if (proxy) {
        try {
          await proxyPools.main.markChecked?.(proxy.id, { poolId: proxy.poolId || proxyPoolId || undefined });
        } catch {
          break;
        }
      }
      break;
    }
  }
  lastError ||= Object.assign(new Error('eligibility check did not run'), { code: 'ELIGIBILITY_NOT_RUN' });
  throw await persistFailure(lastError);
}

module.exports = { resultRecord, runProtocolEligibilityCheck };
