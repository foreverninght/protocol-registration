'use strict';

const OTP_SELECTORS = [
  'input[name="code"]',
  'input[id$="-code"]',
  'input[inputmode="numeric"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
];

const OTP_FORM_SUBMIT_SELECTOR = [
  'form:has(input[inputmode="numeric"]) button[type="submit"]',
  'form:has(input[autocomplete="one-time-code"]) button[type="submit"]',
  'form:has(input[name*="code" i]) button[type="submit"]',
  'form:has(input[id*="code" i]) button[type="submit"]',
  'form:has(input[inputmode="numeric"]) button:has-text("Continue")',
  'form:has(input[autocomplete="one-time-code"]) button:has-text("Continue")',
  'form:has(input[name*="code" i]) button:has-text("Continue")',
  'form:has(input[id*="code" i]) button:has-text("Continue")',
  'form:has(input[inputmode="numeric"]) button:has-text("继续")',
  'form:has(input[autocomplete="one-time-code"]) button:has-text("继续")',
  'form:has(input[name*="code" i]) button:has-text("继续")',
  'form:has(input[id*="code" i]) button:has-text("继续")',
].join(', ');

const POST_OTP_NEXT_STEP_SELECTOR = [
  'input[name*="name" i]',
  'input[autocomplete="name"]',
  'input[name="age"]',
  'input[autocomplete^="bday" i]',
  'input[type="number"]',
  'input[type="password"]',
].join(', ');

function isOtpValidationResponse(response) {
  if (!response || typeof response.url !== 'function') return false;
  let url;
  try {
    url = new URL(response.url());
  } catch {
    return false;
  }
  return url.hostname === 'auth.openai.com'
    && (
      url.pathname.includes('/api/accounts/email-otp/validate')
      || url.pathname.includes('/api/accounts/otp/validate')
    )
    && typeof response.status === 'function';
}

function responseHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

async function summarizeOtpValidationResponse(response) {
  if (!response) return null;
  let headers = {};
  try {
    headers = typeof response.allHeaders === 'function'
      ? await response.allHeaders()
      : typeof response.headers === 'function'
        ? response.headers()
        : {};
  } catch {}
  const status = Number(response.status?.());
  const cfMitigated = responseHeader(headers, 'cf-mitigated');
  const contentType = responseHeader(headers, 'content-type');
  return {
    kind: 'otp_validation_response',
    status: Number.isFinite(status) ? status : null,
    cloudflareChallenge: cfMitigated.toLowerCase() === 'challenge',
    cfMitigated: cfMitigated || null,
    contentType: contentType || null,
  };
}

class OtpValidationError extends Error {
  constructor(message, { code = 'OTP_VALIDATION_FAILED', retryableProxy = false, details = null } = {}) {
    super(message);
    this.name = 'OtpValidationError';
    this.code = code;
    this.retryableProxy = retryableProxy;
    this.details = details;
  }
}

function assertOtpValidationSucceeded(confirmation) {
  if (confirmation?.kind !== 'otp_validation_response') return confirmation;
  const status = Number(confirmation.status);
  if (status >= 200 && status < 300) return confirmation;
  const challenge = status === 403 && confirmation.cloudflareChallenge;
  throw new OtpValidationError(
    challenge
      ? 'OTP validation was blocked by a Cloudflare challenge'
      : `OTP validation failed with HTTP ${Number.isFinite(status) ? status : 'unknown'}`,
    {
      code: challenge ? 'OTP_VALIDATION_CLOUDFLARE_CHALLENGE' : 'OTP_VALIDATION_FAILED',
      retryableProxy: challenge,
      details: confirmation,
    },
  );
}

class OtpInputValueError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OtpInputValueError';
    this.code = 'OTP_INPUT_VALUE_NOT_SET';
    this.retryableProxy = false;
    this.details = details;
  }
}

async function settleWithin(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(50, timeoutMs));
      }),
    ]);
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

async function submitOtpForm({ page, timeoutMs }) {
  if (!page || typeof page.evaluate !== 'function') {
    const error = new Error('browser page context is required to submit OTP form');
    error.code = 'OTP_SUBMIT_CONTEXT_MISSING';
    error.retryableProxy = false;
    throw error;
  }

  const result = await page.evaluate((inputSelector) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && !element.disabled;
    };
    const inputs = Array.from(document.querySelectorAll(inputSelector)).filter(visible);
    const input = inputs[0];
    const form = input?.closest('form');
    if (!form) return { ok: false, reason: 'otp_form_missing', inputCount: inputs.length };
    const buttons = Array.from(form.querySelectorAll('button[type="submit"], button[name="intent"][value="validate"], button'));
    const button = buttons.find(visible) || buttons[0] || null;
    if (typeof form.requestSubmit === 'function') {
      const validSubmitter = button
        && button.form === form
        && ((button instanceof HTMLButtonElement && button.type === 'submit')
          || (button instanceof HTMLInputElement && ['submit', 'image'].includes(button.type)));
      form.requestSubmit(validSubmitter ? button : undefined);
      return {
        ok: true,
        mode: 'requestSubmit',
        inputCount: inputs.length,
        buttonText: button?.innerText || '',
      };
    }
    if (button) {
      button.click();
      return {
        ok: true,
        mode: 'domButtonClick',
        inputCount: inputs.length,
        buttonText: button.innerText || '',
      };
    }
    form.submit();
    return { ok: true, mode: 'formSubmit', inputCount: inputs.length, buttonText: '' };
  }, OTP_SELECTORS.join(', '));

  if (!result?.ok) {
    const error = new Error(`OTP submit form was not available: ${result?.reason || 'unknown'}`);
    error.code = 'OTP_SUBMIT_FORM_MISSING';
    error.retryableProxy = false;
    error.details = result || null;
    throw error;
  }
  return result;
}

async function safeCount(locator) {
  if (!locator || typeof locator.count !== 'function') return 0;
  try {
    return Math.min(await locator.count(), 12);
  } catch {
    return 0;
  }
}

async function safeVisible(locator) {
  if (!locator || typeof locator.isVisible !== 'function') return true;
  try {
    return Boolean(await locator.isVisible());
  } catch {
    return false;
  }
}

async function fillOtpInputs({ page, otp, timeoutMs }) {
  const selector = OTP_SELECTORS.join(', ');
  const expected = String(otp || '');
  const locator = page.locator(selector);
  const count = await safeCount(locator);
  const visibleItems = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await safeVisible(item)) visibleItems.push(item);
  }

  // Cloak may expose the auth form in its isolated DOM world before the
  // locator resolver can enumerate it. Use the same DOM setter path as the
  // reference browser flow first, with readback verification.
  if (!visibleItems.length) {
    const domFill = await fillOtpInputsByDom(page, expected);
    const repaired = await readOtpInputState(page, expected);
    if (domFill?.ok && repaired?.matches) {
      return {
        mode: repaired.mode || domFill.mode || 'single',
        inputCount: repaired.inputCount || domFill.inputCount || 1,
        verified: true,
        valueLength: repaired.valueLength,
        repaired: true,
      };
    }
  }

  let mode = 'single';
  let inputCount = Math.max(1, visibleItems.length || count || 1);
  if (visibleItems.length >= expected.length) {
    const digits = expected.split('');
    for (let index = 0; index < digits.length; index += 1) {
      await visibleItems[index].fill(digits[index], { timeout: timeoutMs });
    }
    mode = 'split';
    inputCount = visibleItems.length;
  } else {
    const input = locator.first();
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
    await input.fill(expected, { timeout: timeoutMs });
  }

  const readback = await readOtpInputState(page, expected);
  if (!readback || readback.matches) {
    return {
      mode: readback?.mode || mode,
      inputCount: readback?.inputCount || inputCount,
      verified: Boolean(readback?.matches),
      valueLength: readback?.valueLength ?? null,
    };
  }

  const domFill = await fillOtpInputsByDom(page, expected);
  const repaired = await readOtpInputState(page, expected);
  if (domFill?.ok && repaired?.matches) {
    return {
      mode: repaired.mode || domFill.mode || mode,
      inputCount: repaired.inputCount || domFill.inputCount || inputCount,
      verified: true,
      valueLength: repaired.valueLength,
      repaired: true,
    };
  }

  throw new OtpInputValueError('OTP value was not present in the visible input(s) after fill', {
    mode: readback.mode || mode,
    inputCount: readback.inputCount || inputCount,
    valueLength: repaired?.valueLength ?? readback.valueLength,
    domAttempted: Boolean(domFill?.ok),
  });
}

async function readOtpInputState(page, expected) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const result = await settleWithin(page.evaluate(({ selector, expectedCode }) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && !element.disabled;
    };
    const inputs = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (!inputs.length) {
      return { found: false, matches: false, mode: 'missing', inputCount: 0, valueLength: 0 };
    }
    const splitInputs = inputs.filter((input) => {
      const maxLength = Number(input.getAttribute?.('maxlength') || input.maxLength || 0);
      return maxLength === 1;
    });
    const targetInputs = splitInputs.length >= expectedCode.length ? splitInputs.slice(0, expectedCode.length) : [inputs[0]];
    const value = targetInputs.map((input) => String(input.value || '').trim()).join('');
    return {
      found: true,
      matches: value === expectedCode,
      mode: targetInputs.length > 1 ? 'split' : 'single',
      inputCount: inputs.length,
      valueLength: value.length,
    };
  }, { selector: OTP_SELECTORS.join(', '), expectedCode: expected }), 1500, null);
  if (result && typeof result === 'object' && result.error) return null;
  if (!result || typeof result !== 'object' || !Object.prototype.hasOwnProperty.call(result, 'matches')) return null;
  return result;
}

async function fillOtpInputsByDom(page, expected) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const result = await settleWithin(page.evaluate(({ selector, expectedCode }) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && !element.disabled;
    };
    const setValue = (input, value) => {
      input.focus?.();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (!inputs.length) return { ok: false, reason: 'otp_inputs_missing', inputCount: 0 };
    const splitInputs = inputs.filter((input) => {
      const maxLength = Number(input.getAttribute?.('maxlength') || input.maxLength || 0);
      return maxLength === 1;
    });
    if (splitInputs.length >= expectedCode.length) {
      const digits = String(expectedCode).split('');
      digits.forEach((digit, index) => setValue(splitInputs[index], digit));
      return { ok: true, mode: 'split', inputCount: splitInputs.length };
    }
    setValue(inputs[0], expectedCode);
    return { ok: true, mode: 'single', inputCount: inputs.length };
  }, { selector: OTP_SELECTORS.join(', '), expectedCode: expected }), 3000, null);
  if (result && typeof result === 'object' && result.error) return null;
  return result;
}

async function waitForOtpSubmitConfirmation({ page, timeoutMs, validationPromise = null }) {
  const waits = [];
  if (validationPromise) {
    waits.push(
      validationPromise
        .then((response) => summarizeOtpValidationResponse(response))
        .catch(() => null),
    );
  } else if (typeof page.waitForResponse === 'function') {
    waits.push(
      page.waitForResponse(isOtpValidationResponse, { timeout: timeoutMs })
        .then((response) => summarizeOtpValidationResponse(response))
        .catch(() => null),
    );
  }
  waits.push(
    page.locator(POST_OTP_NEXT_STEP_SELECTOR).first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => ({ kind: 'next_step_visible' }))
      .catch(() => null),
  );
  waits.push(new Promise((resolve) => setTimeout(() => resolve(null), Math.max(100, timeoutMs))));
  const result = await Promise.race(waits);
  if (result) return assertOtpValidationSucceeded(result);
  const error = new Error('OTP submit did not produce a validation response or next step');
  error.code = 'OTP_SUBMIT_NOT_CONFIRMED';
  error.retryableProxy = false;
  throw error;
}

async function submitOtp({ page, otp, timeoutMs }) {
  const validation = typeof page.waitForResponse === 'function'
    ? page.waitForResponse(isOtpValidationResponse, { timeout: timeoutMs }).catch(() => null)
    : null;
  const fill = await fillOtpInputs({ page, otp, timeoutMs });
  const submit = await submitOtpForm({ page, timeoutMs });
  const confirmation = await waitForOtpSubmitConfirmation({ page, timeoutMs, validationPromise: validation });
  return { step: 'otp_submitted', fill, submit, confirmation };
}

module.exports = {
  submitOtp,
  submitOtpForm,
  fillOtpInputs,
  fillOtpInputsByDom,
  readOtpInputState,
  OtpInputValueError,
  OtpValidationError,
  OTP_SELECTORS,
  OTP_FORM_SUBMIT_SELECTOR,
  POST_OTP_NEXT_STEP_SELECTOR,
  isOtpValidationResponse,
  summarizeOtpValidationResponse,
  assertOtpValidationSucceeded,
};
