'use strict';

const { createFingerprintBrowserSession } = require('../browser/lifecycle/fingerprint-browser');
const { findSessionCookie } = require('../registration/session-cookies');

class SessionRestoreError extends Error {
  constructor(message, { code = 'SESSION_RESTORE_FAILED', status = null } = {}) {
    super(message);
    this.name = 'SessionRestoreError';
    this.code = code;
    this.status = status;
    this.retryableProxy = false;
  }
}

function exactEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function readJsonResponse(response) {
  const status = typeof response?.status === 'function' ? response.status() : 0;
  const text = typeof response?.text === 'function' ? await response.text() : '';
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status, text, body };
}

async function restoreSessionWithCookies({
  config,
  proxy,
  cookies,
  expectedEmail,
  collectorFactory = null,
}) {
  const sessionCookie = findSessionCookie(cookies);
  if (!sessionCookie?.value) {
    throw new SessionRestoreError('saved cookies do not contain a ChatGPT session cookie', {
      code: 'SESSION_COOKIE_MISSING',
    });
  }
  const browserSession = await createFingerprintBrowserSession({ config, proxy, collectorFactory });
  try {
    await browserSession.context.addCookies(cookies);
    const sessionPaths = [
      '/api/auth/session?refresh=true&reason=token_expired&method=POST&path=%2Fces%2Fv1%2Frgstr',
      '/api/auth/session?workspace_update=true&reason=checkout_success&path=%2Fpayments%2Fsuccess',
      `/api/auth/session?refresh=${encodeURIComponent(String(Date.now()))}&reason=session_restore`,
      '/api/auth/session',
    ];
    let session = null;
    let selectedStatus = 0;
    const wantedEmail = exactEmail(expectedEmail);
    for (const path of sessionPaths) {
      const response = await browserSession.page.goto(`https://chatgpt.com${path}`, {
        waitUntil: 'commit',
        timeout: config.browser.operationTimeoutMs,
      }).catch((error) => ({ _restoreError: error }));
      if (response?._restoreError) continue;
      const candidate = await readJsonResponse(response);
      selectedStatus = candidate.status;
      const observedEmail = exactEmail(candidate.body?.user?.email || candidate.body?.email);
      const accessToken = String(candidate.body?.accessToken || candidate.body?.access_token || '');
      if (candidate.status === 200 && observedEmail && observedEmail === wantedEmail && accessToken) {
        session = candidate;
      }
    }
    const observedEmail = exactEmail(session?.body?.user?.email || session?.body?.email);
    const accessToken = String(session?.body?.accessToken || session?.body?.access_token || '');
    if (!session || session.status !== 200 || !observedEmail || observedEmail !== wantedEmail || !accessToken) {
      throw new SessionRestoreError('saved cookies did not prove the expected authenticated session', {
        code: 'SESSION_IDENTITY_NOT_PROVEN',
        status: selectedStatus || session?.status || 0,
      });
    }
    const latestCookies = await browserSession.context.cookies().catch(() => cookies);
    return {
      browserSession,
      email: observedEmail,
      accessToken,
      sessionCookie: findSessionCookie(latestCookies) || sessionCookie,
      cookies: latestCookies,
      sessionStatus: session.status,
      sessionBody: session.body,
    };
  } catch (error) {
    await browserSession.close().catch(() => {});
    throw error;
  }
}

module.exports = {
  restoreSessionWithCookies,
  SessionRestoreError,
  readJsonResponse,
  exactEmail,
};
