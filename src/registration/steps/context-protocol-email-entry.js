'use strict';

const { waitForAuthEmailBranch } = require('./auth-email-entry');
const {
  clickEmailFormContinue,
  detectEmailNextStepKind,
  dismissCookieConsent,
  fillEmailInput,
  readVisibleEmailInputState,
  submitEmail,
} = require('./submit-email');

const NEXTAUTH_SIGNIN_PATTERN = '**/api/auth/signin/openai**';

class ContextProtocolEntryError extends Error {
  constructor(message, { code = 'CONTEXT_PROTOCOL_ENTRY_FAILED', details = null, retryableProxy = false } = {}) {
    super(message);
    this.name = 'ContextProtocolEntryError';
    this.code = code;
    this.details = details;
    this.retryableProxy = retryableProxy;
  }
}

function boundedTimeout(timeoutMs, fallback = 30000) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) ? Math.max(1000, Math.min(Math.trunc(value), fallback)) : fallback;
}

function requestUrlHasBrowserContext(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return Boolean(
      url.searchParams.get('auth_session_logging_id')
      && url.searchParams.get('ext-oai-did')
      && url.searchParams.get('login_hint'),
    );
  } catch {
    return false;
  }
}

async function requestHeaders(request) {
  try {
    if (typeof request.allHeaders === 'function') return await request.allHeaders();
    if (typeof request.headers === 'function') return request.headers();
  } catch {}
  return {};
}

async function captureBrowserSigninRequest({ page, click, timeoutMs }) {
  if (!page || typeof page.route !== 'function' || typeof page.unroute !== 'function') {
    throw new ContextProtocolEntryError('browser page routing is required for context protocol signin', {
      code: 'CONTEXT_PROTOCOL_ROUTE_UNAVAILABLE',
    });
  }
  const timeout = boundedTimeout(timeoutMs, 15000);
  let timer = null;
  let handler = null;
  const captured = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new ContextProtocolEntryError(
      'browser click did not produce a NextAuth signin request',
      { code: 'CONTEXT_PROTOCOL_SIGNIN_NOT_CAPTURED' },
    )), timeout);
    handler = async (route) => {
      const request = route.request();
      const value = {
        method: request.method(),
        url: request.url(),
        headers: await requestHeaders(request),
        postData: request.postData?.() || '',
      };
      await route.abort('blockedbyclient').catch(() => {});
      resolve(value);
    };
  });
  await page.route(NEXTAUTH_SIGNIN_PATTERN, handler);
  try {
    await click();
    return await captured;
  } finally {
    clearTimeout(timer);
    await page.unroute(NEXTAUTH_SIGNIN_PATTERN, handler).catch(() => {});
  }
}

function replayHeaders(headers = {}) {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'x-auth-return-redirect']);
  return Object.fromEntries(Object.entries(headers)
    .map(([name, value]) => [String(name).toLowerCase(), String(value || '')])
    .filter(([name, value]) => allowed.has(name) && value));
}

async function replaySigninInBrowserContext({ page, request, timeoutMs }) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new ContextProtocolEntryError('browser page context is required to replay signin', {
      code: 'CONTEXT_PROTOCOL_CONTEXT_MISSING',
    });
  }
  const result = await page.evaluate(async ({ url, method, headers, body, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return {
        status: response.status,
        url: response.url,
        json,
        bodySample: text.slice(0, 500),
      };
    } finally {
      clearTimeout(timer);
    }
  }, {
    url: request.url,
    method: request.method || 'POST',
    headers: replayHeaders(request.headers),
    body: request.postData || '',
    timeout: boundedTimeout(timeoutMs, 20000),
  });
  const authorizeUrl = String(result?.json?.url || '');
  if (Number(result?.status) < 200 || Number(result?.status) >= 300 || !authorizeUrl) {
    throw new ContextProtocolEntryError(
      `context protocol signin failed with HTTP ${result?.status || 'unknown'}`,
      {
        code: 'CONTEXT_PROTOCOL_SIGNIN_FAILED',
        details: { status: result?.status || null, bodySample: result?.bodySample || '' },
      },
    );
  }
  return { status: Number(result.status), authorizeUrl };
}

async function openContextProtocolEmailEntry({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try { if (typeof onEvent === 'function') onEvent(event); } catch {}
  };
  emit({ step: 'context_protocol_entry_started' });
  await dismissCookieConsent(page);
  const fill = await fillEmailInput(page, email, timeoutMs);
  emit({ step: 'context_protocol_email_filled', result: fill });

  const captured = await captureBrowserSigninRequest({
    page,
    timeoutMs,
    click: () => clickEmailFormContinue(page, timeoutMs),
  });
  if (!requestUrlHasBrowserContext(captured.url)) {
    throw new ContextProtocolEntryError(
      'captured signin request did not contain browser-generated device and logging ids',
      { code: 'CONTEXT_PROTOCOL_BROWSER_STATE_INCOMPLETE' },
    );
  }
  const capturedUrl = new URL(captured.url);
  emit({
    step: 'context_protocol_signin_captured',
    result: {
      method: captured.method,
      host: capturedUrl.hostname,
      path: capturedUrl.pathname,
      browserContextComplete: true,
    },
  });

  const signin = await replaySigninInBrowserContext({ page, request: captured, timeoutMs });
  emit({
    step: 'context_protocol_signin_replayed',
    result: { status: signin.status, authorizeUrlPresent: true },
  });

  const otpIssuedAt = Date.now();
  const response = await page.goto(signin.authorizeUrl, {
    waitUntil: 'domcontentloaded',
    timeout: boundedTimeout(timeoutMs, 30000),
  });
  const status = Number(response?.status?.() || 0) || null;
  if (status && status >= 400) {
    throw new ContextProtocolEntryError(`authorize navigation failed with HTTP ${status}`, {
      code: 'CONTEXT_PROTOCOL_AUTHORIZE_FAILED',
      details: { status },
      retryableProxy: status === 403,
    });
  }
  emit({
    step: 'context_protocol_authorize_loaded',
    result: { status, url: page.url?.() || null },
  });

  const visibleEmail = await readVisibleEmailInputState(page, email);
  let emailSubmit = null;
  if (visibleEmail?.found) {
    emailSubmit = await submitEmail({ page, email, timeoutMs, onEvent: emit });
  }
  const branch = await waitForAuthEmailBranch({ page, timeoutMs });
  const nextStepKind = emailSubmit?.nextStepKind || await detectEmailNextStepKind(page);
  return {
    step: 'email_submitted',
    mode: 'browser_context_protocol',
    otpIssuedAt,
    branch,
    emailSubmit: emailSubmit || { nextStepKind },
    signin: { status: signin.status },
  };
}

module.exports = {
  ContextProtocolEntryError,
  NEXTAUTH_SIGNIN_PATTERN,
  captureBrowserSigninRequest,
  openContextProtocolEmailEntry,
  replaySigninInBrowserContext,
  requestUrlHasBrowserContext,
};
