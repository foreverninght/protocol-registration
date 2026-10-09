'use strict';

const { fetchChatgptJson, fetchBestAccountsCheck, summarizeAccountsCheckBody } = require('../eligibility/eligibility-checker');
const { analyzeTrialEligibility } = require('../eligibility/trial-eligibility');
const { exactEmail } = require('../session/restore-session');

class PostRegistrationBootstrapError extends Error {
  constructor(message, { code = 'POST_REGISTRATION_BOOTSTRAP_FAILED', status = null } = {}) {
    super(message);
    this.name = 'PostRegistrationBootstrapError';
    this.code = code;
    this.status = status;
    this.retryableProxy = false;
  }
}

function sessionEmailFromBody(body) {
  return exactEmail(body?.user?.email || body?.email || '');
}

function accessTokenFromBody(body) {
  return String(body?.accessToken || body?.access_token || '');
}

async function collectPostRegistrationBootstrap({
  page,
  email,
  timeoutMs,
  registrationEnvironment = null,
  checkEligibility = false,
}) {
  const checkedAt = new Date().toISOString();
  const session = await fetchChatgptJson(page, '/api/auth/session', { timeoutMs });
  const observedEmail = sessionEmailFromBody(session.body);
  const wantedEmail = exactEmail(email);
  const accessToken = accessTokenFromBody(session.body);
  if (session.status !== 200 || !observedEmail || observedEmail !== wantedEmail || !accessToken) {
    throw new PostRegistrationBootstrapError('post-registration session did not prove the expected account', {
      code: 'POST_REGISTRATION_SESSION_NOT_PROVEN',
      status: session.status,
    });
  }

  let accountsCheckFetch = null;
  let accountsCheck = null;
  let trialEligibility = null;
  if (checkEligibility === true) {
    accountsCheckFetch = await fetchBestAccountsCheck(page, { timeoutMs });
    accountsCheck = accountsCheckFetch.result;
    trialEligibility = analyzeTrialEligibility(accountsCheck.body);
  }

  return {
    checkedAt,
    source: 'registration_session',
    registrationEnvironment,
    sessionStatus: session.status,
    sessionEmail: observedEmail,
    sessionEmailMatched: true,
    accessToken,
    accessTokenAvailable: Boolean(accessToken),
    eligibilityChecked: checkEligibility === true,
    accountsCheckSource: accountsCheckFetch?.source || null,
    accountsCheckStatus: accountsCheck?.status || null,
    accountsCheckSummary: accountsCheck ? summarizeAccountsCheckBody(accountsCheck.body) : null,
    trialEligibility,
  };
}

function publicPostRegistrationBootstrapResult(result) {
  if (!result) return null;
  const { accessToken, ...safe } = result;
  return {
    ...safe,
    accessTokenAvailable: Boolean(result.accessToken || result.accessTokenAvailable),
  };
}

module.exports = {
  PostRegistrationBootstrapError,
  collectPostRegistrationBootstrap,
  publicPostRegistrationBootstrapResult,
};
