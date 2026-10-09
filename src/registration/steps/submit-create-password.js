'use strict';

const CREATE_PASSWORD_INPUT_SELECTOR = [
  'input[autocomplete="new-password"]',
  'input[name*="new-password" i]',
  'input[name*="password" i]:not([autocomplete="current-password"])',
  'input[type="password"]:not([autocomplete="current-password"])',
].join(', ');

const CREATE_PASSWORD_SUBMIT_SELECTOR = [
  'form:has(input[autocomplete="new-password"]) button[type="submit"]',
  'form:has(input[autocomplete="new-password"]) button:has-text("Continue")',
  'form:has(input[name*="new-password" i]) button[type="submit"]',
  'form:has(input[name*="new-password" i]) button:has-text("Continue")',
  'form:has(input[name*="new-password" i]) button:has-text("继续")',
  'form:has(input[type="password"]:not([autocomplete="current-password"])) button[type="submit"]',
  'form:has(input[type="password"]:not([autocomplete="current-password"])) button:has-text("Continue")',
  'form:has(input[type="password"]:not([autocomplete="current-password"])) button:has-text("继续")',
].join(', ');

const CREATE_PASSWORD_FORM_SUBMIT_SELECTOR = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Continue")',
  'button:has-text("继续")',
].join(', ');

const OTP_AFTER_CREATE_PASSWORD_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[inputmode="numeric"]',
].join(', ');

class CreatePasswordSubmitError extends Error {
  constructor(message, { code = 'CREATE_PASSWORD_SUBMIT_FAILED' } = {}) {
    super(message);
    this.name = 'CreatePasswordSubmitError';
    this.code = code;
    this.retryableProxy = false;
  }
}

async function submitCreatePasswordBeforeOtp({ page, password, timeoutMs }) {
  const value = String(password || '');
  if (!value) {
    throw new CreatePasswordSubmitError('default registration password is required for create-password branch', {
      code: 'CREATE_PASSWORD_VALUE_MISSING',
    });
  }
  const inputs = page.locator(CREATE_PASSWORD_INPUT_SELECTOR);
  const count = typeof inputs.count === 'function'
    ? Math.min(await inputs.count().catch(() => 0), 6)
    : 1;
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const input = typeof inputs.nth === 'function' ? inputs.nth(index) : inputs.first();
    if (typeof input.isVisible !== 'function' || await input.isVisible().catch(() => false)) visible.push(input);
  }
  if (!visible.length) {
    throw new CreatePasswordSubmitError('create-password input was not visible', {
      code: 'CREATE_PASSWORD_INPUT_NOT_VISIBLE',
    });
  }
  for (const input of visible) {
    await input.fill(value, { timeout: timeoutMs });
  }

  // Cloak's isolated-world resolver does not support chained XPath/:has-text
  // locators. The create-password page has one native submit control, so use a
  // page-level CSS selector and keep the DOM requestSubmit fallback below.
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  const submitCount = typeof submit.count === 'function'
    ? await submit.count().catch(() => 0)
    : 1;
  if (submitCount) {
    await submit.click({ timeout: timeoutMs });
  } else {
    const submitted = await page.evaluate((selector) => {
      const visibleElement = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0 && !element.disabled;
      };
      const input = [...document.querySelectorAll(selector)].find(visibleElement);
      const targetForm = input?.closest('form');
      const button = [...(targetForm || document).querySelectorAll('button, input[type="submit"]')]
        .find(visibleElement);
      const validSubmitter = button
        && button.form === targetForm
        && ((button instanceof HTMLButtonElement && button.type === 'submit')
          || (button instanceof HTMLInputElement && ['submit', 'image'].includes(button.type)));
      if (targetForm?.requestSubmit) targetForm.requestSubmit(validSubmitter ? button : undefined);
      else if (button) button.click();
      else return { ok: false, reason: 'submit_control_missing' };
      return { ok: true, mode: 'dom_request_submit' };
    }, CREATE_PASSWORD_INPUT_SELECTOR);
    if (!submitted?.ok) {
      throw new CreatePasswordSubmitError('create-password submit control was not available', {
        code: 'CREATE_PASSWORD_SUBMIT_CONTROL_MISSING',
      });
    }
  }

  const otp = page.locator(OTP_AFTER_CREATE_PASSWORD_SELECTOR).first();
  const otpVisible = otp.waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => ({ nextStep: 'otp_required', via: 'otp_visible' }))
    .catch(() => null);
  const waits = [
    otpVisible,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ];
  if (typeof page.waitForURL === 'function') {
    waits.splice(1, 0, page.waitForURL(/email-verification|create-account|auth\/login/i, { timeout: timeoutMs })
      .then(() => ({ nextStep: 'otp_required', via: 'url_changed', url: page.url?.() || null }))
      .catch(() => null));
  }
  const result = await Promise.race(waits);
  if (!result) {
    throw new CreatePasswordSubmitError('create-password was submitted but OTP step did not appear', {
      code: 'CREATE_PASSWORD_NEXT_STEP_NOT_READY',
    });
  }
  return { step: 'create_password_submitted', ...result };
}

module.exports = {
  submitCreatePasswordBeforeOtp,
  CreatePasswordSubmitError,
  CREATE_PASSWORD_INPUT_SELECTOR,
  CREATE_PASSWORD_SUBMIT_SELECTOR,
  CREATE_PASSWORD_FORM_SUBMIT_SELECTOR,
  OTP_AFTER_CREATE_PASSWORD_SELECTOR,
};
