'use strict';

const {
  EMAIL_INPUT_SELECTOR,
  OTP_STEP_SELECTORS,
  LOGIN_PASSWORD_STEP_SELECTORS,
  CREATE_PASSWORD_STEP_SELECTORS,
  detectEmailNextStepKind,
  submitEmail,
} = require('./submit-email');

class AuthEmailEntryError extends Error {
  constructor(message, { code = 'AUTH_EMAIL_ENTRY_FAILED', status = null } = {}) {
    super(message);
    this.name = 'AuthEmailEntryError';
    this.code = code;
    this.status = status;
  }
}

function safeTimeout(timeoutMs, fallback = 30000) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.min(Math.trunc(value), fallback));
}

async function waitForAuthEmailBranch({ page, timeoutMs }) {
  const otpSelector = OTP_STEP_SELECTORS.join(', ');
  const loginPasswordSelector = LOGIN_PASSWORD_STEP_SELECTORS.join(', ');
  const createPasswordSelector = CREATE_PASSWORD_STEP_SELECTORS.join(', ');
  const timeout = safeTimeout(timeoutMs);
  const otpVisible = page.locator(otpSelector).first()
    .waitFor({ state: 'visible', timeout })
    .then(() => ({ kind: 'otp_required', selector: otpSelector }))
    .catch(() => null);
  const loginPasswordVisible = page.locator(loginPasswordSelector).first()
    .waitFor({ state: 'visible', timeout })
    .then(async () => {
      const detected = await detectEmailNextStepKind(page);
      if (detected === 'create_password') {
        return {
          kind: 'create_password_required',
          selector: createPasswordSelector,
          via: 'password_input_classified_by_url_or_new_password',
        };
      }
      return { kind: 'login_password_required', selector: loginPasswordSelector };
    })
    .catch(() => null);
  const createPasswordVisible = page.locator(createPasswordSelector).first()
    .waitFor({ state: 'visible', timeout })
    .then(() => ({ kind: 'create_password_required', selector: createPasswordSelector }))
    .catch(() => null);
  const emailVerificationUrl = page.waitForURL?.(/https:\/\/auth\.openai\.com\/email-verification(?:[/?#]|$)/i, {
    timeout,
  }).then(() => ({ kind: 'otp_required', via: 'email_verification_url', url: page.url?.() || null })).catch(() => null);
  const createPasswordUrl = page.waitForURL?.(/https:\/\/auth\.openai\.com\/create-account\/password(?:[/?#]|$)/i, {
    timeout,
  }).then(() => ({ kind: 'create_password_required', via: 'create_password_url', url: page.url?.() || null })).catch(() => null);
  const loginPasswordUrl = page.waitForURL?.(/https:\/\/auth\.openai\.com\/log-in\/password(?:[/?#]|$)/i, {
    timeout,
  }).then(() => ({ kind: 'login_password_required', via: 'login_password_url', url: page.url?.() || null })).catch(() => null);
  const result = await Promise.race([
    otpVisible,
    createPasswordVisible,
    loginPasswordVisible,
    emailVerificationUrl || Promise.resolve(null),
    createPasswordUrl || Promise.resolve(null),
    loginPasswordUrl || Promise.resolve(null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
  ]);
  if (result?.kind === 'otp_required') {
    try {
      const createPasswordSelector = CREATE_PASSWORD_STEP_SELECTORS.join(', ');
      const createPasswordVisible = await page.locator(createPasswordSelector).first().isVisible({ timeout: 500 });
      if (createPasswordVisible) {
        return { kind: 'create_password_required', selector: createPasswordSelector, via: 'create_password_visible_with_otp' };
      }
    } catch {}
  }
  if (result) return result;
  const detected = await detectEmailNextStepKind(page);
  if (detected === 'otp') return { kind: 'otp_required', via: 'detected_after_timeout' };
  if (detected === 'create_password') return { kind: 'create_password_required', via: 'detected_after_timeout' };
  if (detected === 'login_password') return { kind: 'login_password_required', via: 'detected_after_timeout' };
  throw new AuthEmailEntryError('auth email entry did not reach email verification or OTP/password branch', {
    code: 'AUTH_EMAIL_BRANCH_NOT_READY',
  });
}

async function waitForVisibleAuthEmailInput({ page, timeoutMs }) {
  try {
    await page.locator(EMAIL_INPUT_SELECTOR).first().waitFor({
      state: 'visible',
      timeout: safeTimeout(timeoutMs, 30000),
    });
    return true;
  } catch {
    return false;
  }
}

async function openAuthEmailEntry({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try {
      if (typeof onEvent === 'function') onEvent(event);
    } catch {}
  };
  emit({ step: 'auth_natural_entry_started' });
  const initialBranch = await detectEmailNextStepKind(page);
  if (['otp', 'create_password', 'login_password'].includes(initialBranch)) {
    throw new AuthEmailEntryError(`auth/login unexpectedly opened on ${initialBranch}`, {
      code: 'AUTH_LOGIN_INITIAL_STATE_INVALID',
    });
  }
  if (!await waitForVisibleAuthEmailInput({ page, timeoutMs })) {
    throw new AuthEmailEntryError('auth/login did not expose its email input', {
      code: 'AUTH_EMAIL_FORM_NOT_READY',
    });
  }
  emit({
    step: 'auth_email_form_ready',
    result: { url: page.url?.() || null },
  });
  const otpIssuedAt = Date.now();
  emit({ step: 'auth_email_form_submit_started' });
  const emailSubmit = await submitEmail({
    page,
    email,
    timeoutMs,
    onEvent: (event) => emit({
      ...event,
      step: `auth_${event.step || event.type || 'email_event'}`,
    }),
  });
  emit({ step: 'auth_email_form_submitted', result: { step: emailSubmit.step } });
  const branch = await waitForAuthEmailBranch({ page, timeoutMs });
  return {
    step: 'email_submitted',
    mode: 'browser_context_auth_signin',
    otpIssuedAt,
    branch,
    emailSubmit,
  };
}

module.exports = {
  openAuthEmailEntry,
  waitForAuthEmailBranch,
  AuthEmailEntryError,
};
