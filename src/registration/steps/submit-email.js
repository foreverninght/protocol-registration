'use strict';

const OTP_STEP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[inputmode="numeric"]',
];

const LOGIN_PASSWORD_STEP_SELECTORS = [
  'input[type="password"]',
];

const CREATE_PASSWORD_STEP_SELECTORS = [
  'input[autocomplete="new-password"]',
  'input[name*="new-password" i]',
  'input[data-testid*="create-password" i]',
  'form:has(input[autocomplete="new-password"])',
  'button:has-text("Create password")',
  'button:has-text("Create a password")',
  'button:has-text("创建密码")',
  'button:has-text("设置密码")',
  'button:has-text("Set password")',
  'button:has-text("パスワード")',
  'button:has-text("kata laluan")',
];

const NEXT_STEP_SELECTORS = [
  ...OTP_STEP_SELECTORS,
  ...LOGIN_PASSWORD_STEP_SELECTORS,
  ...CREATE_PASSWORD_STEP_SELECTORS,
];

const EMAIL_INPUT_SELECTOR = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[name="login_hint"]',
  'input[data-testid*="email" i]',
  'input[id*="email" i]',
  'input[aria-label*="email" i]',
  'input[placeholder*="email" i]',
].join(', ');

const EMAIL_FORM_SUBMIT_SELECTOR = [
  'form:has(input[type="email"]) button:has-text("Continue")',
  'form:has(input[name="email"]) button:has-text("Continue")',
  'form:has(input[autocomplete="email"]) button:has-text("Continue")',
  'form:has(input[name="login_hint"]) button:has-text("Continue")',
  'form:has(input[placeholder*="email" i]) button:has-text("Continue")',
  'form:has(input[aria-label*="email" i]) button:has-text("Continue")',
  'form:has(input[type="email"]) button:has-text("继续")',
  'form:has(input[name="email"]) button:has-text("继续")',
  'form:has(input[autocomplete="email"]) button:has-text("继续")',
  'form:has(input[name="login_hint"]) button:has-text("继续")',
  'form:has(input[placeholder*="email" i]) button:has-text("继续")',
  'form:has(input[aria-label*="email" i]) button:has-text("继续")',
  'form:has(input[type="email"]) button:has-text("続行")',
  'form:has(input[name="email"]) button:has-text("続行")',
  'form:has(input[autocomplete="email"]) button:has-text("続行")',
  'form:has(input[name="login_hint"]) button:has-text("続行")',
  'form:has(input[placeholder*="email" i]) button:has-text("続行")',
  'form:has(input[aria-label*="email" i]) button:has-text("続行")',
  'form:has(input[type="email"]) button:has-text("続ける")',
  'form:has(input[name="email"]) button:has-text("続ける")',
  'form:has(input[autocomplete="email"]) button:has-text("続ける")',
  'form:has(input[name="login_hint"]) button:has-text("続ける")',
  'form:has(input[placeholder*="email" i]) button:has-text("続ける")',
  'form:has(input[aria-label*="email" i]) button:has-text("続ける")',
  'form:has(input[type="email"]) button:has-text("次へ")',
  'form:has(input[name="email"]) button:has-text("次へ")',
  'form:has(input[autocomplete="email"]) button:has-text("次へ")',
  'form:has(input[name="login_hint"]) button:has-text("次へ")',
  'form:has(input[placeholder*="email" i]) button:has-text("次へ")',
  'form:has(input[aria-label*="email" i]) button:has-text("次へ")',
  'form:has(input[type="email"]) input[type="submit"][value="Continue"]',
  'form:has(input[name="email"]) input[type="submit"][value="Continue"]',
  'form:has(input[autocomplete="email"]) input[type="submit"][value="Continue"]',
  'form:has(input[name="login_hint"]) input[type="submit"][value="Continue"]',
  'form:has(input[placeholder*="email" i]) input[type="submit"][value="Continue"]',
  'form:has(input[aria-label*="email" i]) input[type="submit"][value="Continue"]',
  'form:has(input[type="email"]) input[type="submit"][value="继续"]',
  'form:has(input[name="email"]) input[type="submit"][value="继续"]',
  'form:has(input[autocomplete="email"]) input[type="submit"][value="继续"]',
  'form:has(input[name="login_hint"]) input[type="submit"][value="继续"]',
  'form:has(input[placeholder*="email" i]) input[type="submit"][value="继续"]',
  'form:has(input[aria-label*="email" i]) input[type="submit"][value="继续"]',
  'form:has(input[type="email"]) input[type="submit"][value="続行"]',
  'form:has(input[name="email"]) input[type="submit"][value="続行"]',
  'form:has(input[autocomplete="email"]) input[type="submit"][value="続行"]',
  'form:has(input[name="login_hint"]) input[type="submit"][value="続行"]',
  'form:has(input[placeholder*="email" i]) input[type="submit"][value="続行"]',
  'form:has(input[aria-label*="email" i]) input[type="submit"][value="続行"]',
  'form:has(input[type="email"]) input[type="submit"][value="続ける"]',
  'form:has(input[name="email"]) input[type="submit"][value="続ける"]',
  'form:has(input[autocomplete="email"]) input[type="submit"][value="続ける"]',
  'form:has(input[name="login_hint"]) input[type="submit"][value="続ける"]',
  'form:has(input[placeholder*="email" i]) input[type="submit"][value="続ける"]',
  'form:has(input[aria-label*="email" i]) input[type="submit"][value="続ける"]',
  'form:has(input[type="email"]) input[type="submit"][value="次へ"]',
  'form:has(input[name="email"]) input[type="submit"][value="次へ"]',
  'form:has(input[autocomplete="email"]) input[type="submit"][value="次へ"]',
  'form:has(input[name="login_hint"]) input[type="submit"][value="次へ"]',
  'form:has(input[placeholder*="email" i]) input[type="submit"][value="次へ"]',
  'form:has(input[aria-label*="email" i]) input[type="submit"][value="次へ"]',
].join(', ');

const THIRD_PARTY_AUTH_BUTTON_RE = /\b(google|apple|microsoft|github|sso|single sign|oauth)\b/i;

function isPrimaryContinueText(text) {
  return /^(continue|next|继续|続行|続ける|次へ)$/i.test(String(text || '').trim());
}

function clampTimeout(timeoutMs, fallback = 5000) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(250, Math.min(Math.trunc(value), fallback));
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

async function countLocator(locator) {
  if (!locator || typeof locator.count !== 'function') return 1;
  const result = await settleWithin(locator.count(), 1000, 0);
  if (result && typeof result === 'object' && result.error) return 0;
  return Math.max(0, Math.min(Number(result) || 0, 10));
}

async function isLocatorVisible(locator) {
  if (!locator || typeof locator.isVisible !== 'function') return true;
  const result = await settleWithin(locator.isVisible(), 1000, false);
  if (result && typeof result === 'object' && result.error) return false;
  return Boolean(result);
}

async function clickLocator(locator, timeoutMs) {
  const result = await settleWithin(
    locator.click({ timeout: clampTimeout(timeoutMs, 5000) }),
    clampTimeout(timeoutMs, 6000) + 250,
    { timeout: true },
  );
  if (result === undefined) return true;
  if (result && typeof result === 'object' && result.error) throw result.error;
  return false;
}

async function locatorText(locator) {
  if (!locator) return null;
  if (typeof locator.evaluate === 'function') {
    const result = await settleWithin(locator.evaluate((element) => String(
      element.innerText
        || element.value
        || element.getAttribute?.('aria-label')
        || element.textContent
        || '',
    ).trim()), 1000, null);
    if (result && typeof result === 'object' && result.error) return null;
    if (result !== null && result !== undefined) return String(result);
  }
  if (typeof locator.textContent === 'function') {
    const result = await settleWithin(locator.textContent({ timeout: 1000 }), 1200, null);
    if (result && typeof result === 'object' && result.error) return null;
    if (result !== null && result !== undefined) return String(result).trim();
  }
  return null;
}

async function flushPendingAuthForm(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const result = await settleWithin(page.evaluate(() => {
    if (typeof window.__submitPendingForm !== 'function') {
      return { present: false, invoked: false };
    }
    window.__submitPendingForm();
    return { present: true, invoked: true };
  }), 1500, { timeout: true, invoked: false });
  if (result && typeof result === 'object' && result.error) return { present: false, invoked: false, error: true };
  return result;
}

async function dismissCookieConsent(page) {
  if (!page) return { dismissed: false };
  if (typeof page.getByRole === 'function') {
    const choices = [
      /reject non-essential|reject all|only necessary|necessary only|decline optional|từ chối|chỉ cần thiết/i,
      /accept all|accept cookies|chấp nhận tất cả|agree|同意|承諾|承認/i,
      /close|dismiss|đóng|閉じる|关闭/i,
    ];
    for (const name of choices) {
      const locator = page.getByRole('button', { name }).first();
      if (!await isLocatorVisible(locator)) continue;
      try {
        const clicked = await clickLocator(locator, 3000);
        if (!clicked) continue;
        if (typeof page.getByRole === 'function') {
          const dialog = page.getByRole('dialog').first();
          await settleWithin(dialog.waitFor({ state: 'hidden', timeout: 2500 }), 2800, null);
        }
        if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(250).catch(() => {});
        return { dismissed: true, text: String(name), mode: 'locator_click' };
      } catch {}
    }
  }
  if (typeof page.evaluate !== 'function') return { dismissed: false };
  const result = await settleWithin(page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (element) => String(
      element.innerText
        || element.value
        || element.getAttribute?.('aria-label')
        || element.textContent
        || '',
    ).replace(/\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(visible)
      .map((element) => ({ element, text: textOf(element) }))
      .filter((item) => item.text);
    const consentText = String(document.body?.innerText || '');
    const hasCookieBanner = /we use cookies|cookie preferences|cookie policy|cookies/i.test(consentText);
    const preferred = buttons.find((item) => /reject non-essential|reject all|only necessary|necessary only|decline optional|decline/i.test(item.text))
      || buttons.find((item) => /accept all|accept cookies|agree|同意|承諾|承認/i.test(item.text))
      || buttons.find((item) => /dismiss|close|閉じる|关闭/i.test(item.text) && hasCookieBanner)
      || null;
    if (!preferred?.element) return { dismissed: false, hasCookieBanner };
    preferred.element.focus?.();
    preferred.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    preferred.element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    preferred.element.click();
    return { dismissed: true, text: preferred.text, hasCookieBanner };
  }, { action: 'dismiss_cookie_consent' }), 2000, { dismissed: false, timeout: true });
  if (result && typeof result === 'object' && result.error) return { dismissed: false, error: true };
  if (result?.dismissed && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(500).catch(() => {});
  }
  return result || { dismissed: false };
}

class EmailNextStepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailNextStepError';
    this.code = 'EMAIL_NEXT_STEP_NOT_READY';
  }
}

class EmailProviderBranchError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message);
    this.name = 'EmailProviderBranchError';
    this.code = 'EMAIL_SUBMIT_WRONG_PROVIDER_BRANCH';
    this.retryableProxy = options.retryableProxy === true;
    this.details = details;
  }
}

class EmailInputValueError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EmailInputValueError';
    this.code = 'EMAIL_INPUT_VALUE_NOT_SET';
    this.retryableProxy = false;
    this.details = details;
  }
}

class EmailUsernameRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EmailUsernameRejectedError';
    this.code = 'EMAIL_USERNAME_REJECTED';
    this.retryableProxy = false;
    this.details = details;
  }
}

function responseUrl(response) {
  if (!response) return '';
  if (typeof response.url === 'function') return response.url();
  return String(response.url || '');
}

function responseStatus(response) {
  if (!response) return null;
  if (typeof response.status === 'function') return response.status();
  return response.status || null;
}

function responseHeaders(response) {
  if (!response) return {};
  if (typeof response.headers === 'function') return response.headers();
  return response.headers || {};
}

function authorizeLocationKind(location) {
  const value = String(location || '');
  if (!value) return 'missing';
  if (/^https:\/\/accounts\.google\.com\//i.test(value)) return 'google_oauth';
  if (/^https:\/\/auth\.openai\.com\/email-verification(?:[?#/]|$)/i.test(value)
    || /^\/email-verification(?:[?#/]|$)/i.test(value)) return 'email_verification';
  if (/^https:\/\/auth\.openai\.com\/create-account\/password(?:[?#/]|$)/i.test(value)
    || /^\/create-account\/password(?:[?#/]|$)/i.test(value)) return 'create_password';
  if (/^https:\/\/auth\.openai\.com\/create-account(?:[?#]|$)/i.test(value)
    || /^\/create-account(?:[?#]|$)/i.test(value)) return 'email_entry';
  if (/^https:\/\/auth\.openai\.com\/log-in-or-create-account(?:[?#/]|$)/i.test(value)
    || /^\/log-in-or-create-account(?:[?#/]|$)/i.test(value)) return 'email_entry';
  if (/^https:\/\/auth\.openai\.com\/log-in\/password(?:[?#/]|$)/i.test(value)
    || /^\/log-in\/password(?:[?#/]|$)/i.test(value)) return 'login_password';
  return 'other';
}

async function waitForAuthorizeRedirect(page, timeoutMs) {
  if (!page || typeof page.waitForResponse !== 'function') return null;
  try {
    const response = await page.waitForResponse((candidate) => {
      const url = responseUrl(candidate);
      const status = responseStatus(candidate);
      return url.includes('://auth.openai.com/api/accounts/authorize') && status >= 300 && status < 400;
    }, { timeout: Math.min(timeoutMs, 15000) });
    const headers = responseHeaders(response);
    const location = headers.location || headers.Location || '';
    return {
      status: responseStatus(response),
      url: responseUrl(response),
      location,
      kind: authorizeLocationKind(location),
    };
  } catch {
    return null;
  }
}

async function waitForAuthorizeContinueOutcome(page, timeoutMs) {
  if (!page || typeof page.waitForResponse !== 'function') return null;
  try {
    const response = await page.waitForResponse((candidate) => {
      const url = responseUrl(candidate);
      if (!url.includes('://auth.openai.com/api/accounts/authorize/continue')) return false;
      const request = typeof candidate.request === 'function' ? candidate.request() : null;
      const method = typeof request?.method === 'function' ? request.method() : request?.method;
      return !method || String(method).toUpperCase() === 'POST';
    }, { timeout: Math.min(timeoutMs, 15000) });
    const status = responseStatus(response);
    let body = '';
    if (typeof response.text === 'function') {
      const text = await settleWithin(response.text(), 2000, '');
      if (!(text && typeof text === 'object' && text.error)) body = String(text || '');
    }
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch {}
    return {
      status,
      url: responseUrl(response),
      errorCode: json?.error?.code || null,
      errorMessage: json?.error?.message || null,
      bodySample: body ? body.slice(0, 500) : null,
    };
  } catch {
    return null;
  }
}

async function waitForNextAuthSignin(page, timeoutMs) {
  if (!page || typeof page.waitForResponse !== 'function') return null;
  try {
    const response = await page.waitForResponse((candidate) => {
      const url = responseUrl(candidate);
      const status = Number(responseStatus(candidate));
      return /https:\/\/chatgpt\.com\/api\/auth\/signin\/openai(?:\?|$)/i.test(url)
        && status >= 200 && status < 300;
    }, { timeout: Math.min(timeoutMs, 15000) });
    let body = '';
    if (typeof response.text === 'function') body = String(await settleWithin(response.text(), 2000, '') || '');
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch {}
    return { status: responseStatus(response), url: responseUrl(response), authorizeUrlPresent: Boolean(json?.url) };
  } catch {
    return null;
  }
}

async function isSecurityChallengePage(page) {
  if (!page) return false;
  try {
    const url = typeof page.url === 'function' ? String(page.url() || '') : '';
    if (/(?:__cf_chl_|cf_chl_|challenges\.cloudflare\.com|turnstile)/i.test(url)) return true;
  } catch {}
  if (typeof page.evaluate !== 'function') return false;
  try {
    const result = await settleWithin(page.evaluate(() => {
      const title = String(document.title || '');
      const text = String(document.body?.innerText || '');
      const hasTurnstile = Boolean(
        document.querySelector('input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"]'),
      );
      const challengeText = /Cloudflare|正在进行安全验证|安全验证|Just a moment|checking your browser|verify you are human|security verification/i.test(`${title}\n${text}`);
      return { hasTurnstile, challengeText };
    }), 1500, null);
    return Boolean(result && (result.hasTurnstile || result.challengeText));
  } catch {
    return false;
  }
}

async function clickEmailFormContinue(page, timeoutMs) {
  if (!page || typeof page.locator !== 'function') {
    const error = new Error('browser page context is required to submit email');
    error.code = 'EMAIL_CONTINUE_NOT_CLICKABLE';
    throw error;
  }
  const candidates = [];
  const submitButtons = page.locator('button[type="submit"], input[type="submit"]');
  const count = await countLocator(submitButtons);
  for (let index = 0; index < count; index += 1) {
    const locator = typeof submitButtons.nth === 'function' ? submitButtons.nth(index) : submitButtons.first();
    if (!await isLocatorVisible(locator)) continue;
    const text = String(await locatorText(locator) || '').trim();
    const attributes = await settleWithin(locator.evaluate((element) => [
      element.id,
      element.name,
      element.type,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('data-provider'),
      element.getAttribute?.('data-testid'),
      element.value,
      element.className,
    ].filter(Boolean).join(' ')), 1000, '');
    const signature = `${text} ${attributes || ''}`;
    if (THIRD_PARTY_AUTH_BUTTON_RE.test(signature)) continue;
    candidates.push({ locator, index, text, signature });
  }
  const exact = candidates.filter((candidate) => isPrimaryContinueText(candidate.text));
  const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
  if (selected && await clickLocator(selected.locator, timeoutMs)) {
    return {
      ok: true,
      reason: exact.length === 1 ? 'clicked_primary_submit' : 'clicked_only_safe_submit',
      index: selected.index,
      text: selected.text,
      mode: 'locator_humanized_click',
    };
  }
  const reason = candidates.length ? 'ambiguous_submit' : 'no_safe_submit';
  const error = new Error(`email form continue button was not visible or clickable: ${reason}`);
  error.code = 'EMAIL_CONTINUE_NOT_CLICKABLE';
  error.details = { reason, candidateCount: candidates.length, exactCount: exact.length };
  throw error;
}

async function findVisibleEmailInputIndex(page) {
  if (!page || typeof page.evaluate !== 'function') return 0;
  const result = await settleWithin(page.evaluate((emailSelector) => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      if (rect.width <= 0 || rect.height <= 0) return false;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return Boolean(top && (top === element || element.contains(top) || top.contains(element)));
    };
    const inputs = [...document.querySelectorAll(emailSelector)];
    const index = inputs.findIndex(isVisible);
    return index;
  }, EMAIL_INPUT_SELECTOR), 1500, -1);
  if (result && typeof result === 'object' && result.error) return -1;
  return Number.isInteger(result) ? result : -1;
}

async function scrollEmailInputIntoView(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const result = await settleWithin(page.evaluate((selector) => {
    const usable = (element) => {
      if (!element) return false;
      if (element.disabled || element.readOnly) return false;
      if (String(element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
      if (String(element.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    };
    const input = [...document.querySelectorAll(selector)].find(usable);
    if (!input) return { found: false };
    const scrollTargets = [
      input.closest('[role="dialog"], [aria-modal="true"], dialog'),
      input.closest('form'),
      document.scrollingElement,
    ].filter(Boolean);
    for (const target of scrollTargets) {
      try {
        if (target === document.scrollingElement) continue;
        const targetRect = target.getBoundingClientRect?.();
        const inputRect = input.getBoundingClientRect();
        if (targetRect && (inputRect.top < targetRect.top || inputRect.bottom > targetRect.bottom)) {
          target.scrollTop += inputRect.top - targetRect.top - Math.max(24, targetRect.height * 0.2);
        }
      } catch {}
    }
    try {
      input.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      try { input.scrollIntoView(); } catch {}
    }
    try { input.focus({ preventScroll: false }); } catch {
      try { input.focus(); } catch {}
    }
    const rect = input.getBoundingClientRect();
    return {
      found: true,
      name: input.getAttribute('name') || null,
      id: input.getAttribute('id') || null,
      placeholder: input.getAttribute('placeholder') || null,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    };
  }, EMAIL_INPUT_SELECTOR), 2000, null);
  if (result && typeof result === 'object' && result.error) return null;
  return result;
}

async function readVisibleEmailInputState(page, email) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const result = await settleWithin(page.evaluate(({ selector, expected }) => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      if (rect.width <= 0 || rect.height <= 0) return false;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return Boolean(top && (top === element || element.contains(top) || top.contains(element)));
    };
    const inputs = [...document.querySelectorAll(selector)];
    const index = inputs.findIndex(isVisible);
    if (index < 0) return { found: false, matches: false, valueLength: 0, index: -1 };
    const input = inputs[index];
    const value = String(input.value || '');
    return {
      found: true,
      matches: value === expected,
      valueLength: value.length,
      index,
      selector,
      placeholder: input.getAttribute('placeholder') || null,
      name: input.getAttribute('name') || null,
      id: input.getAttribute('id') || null,
    };
  }, { selector: EMAIL_INPUT_SELECTOR, expected: email }), 1500, null);
  if (result && typeof result === 'object' && result.error) return null;
  return result;
}

async function fillEmailInput(page, email, timeoutMs) {
  let visibleIndex = await findVisibleEmailInputIndex(page);
  let scrollResult = null;
  if (visibleIndex < 0) {
    scrollResult = await scrollEmailInputIntoView(page);
    if (typeof page?.waitForTimeout === 'function') {
      await page.waitForTimeout(200);
    }
    visibleIndex = await findVisibleEmailInputIndex(page);
  }
  if (visibleIndex < 0) {
    throw new EmailInputValueError('email input exists but is not visible in the current viewport', {
      selector: EMAIL_INPUT_SELECTOR,
      index: -1,
      scrollAttempted: Boolean(scrollResult),
      scrollResult,
    });
  }
  const inputLocator = page.locator(EMAIL_INPUT_SELECTOR);
  const input = typeof inputLocator.nth === 'function'
    ? inputLocator.nth(visibleIndex)
    : inputLocator.first();
  const fillResult = await settleWithin(
    input.fill(email, { timeout: clampTimeout(timeoutMs, 5000) }),
    clampTimeout(timeoutMs, 6000) + 250,
    { timeout: true },
  );
  if (!fillResult || fillResult === undefined) {
    const verified = await readVisibleEmailInputState(page, email);
    if (!verified || verified.matches) {
      return {
        selector: EMAIL_INPUT_SELECTOR,
        index: verified?.index ?? visibleIndex,
        mode: verified ? 'locator_fill_verified' : 'locator_fill_unverified_no_page_eval',
        verified: Boolean(verified?.matches),
        valueLength: verified?.valueLength ?? null,
      };
    }
    throw new EmailInputValueError('email input value was not present after fill', {
      selector: EMAIL_INPUT_SELECTOR,
      index: verified.index,
      valueLength: verified.valueLength,
    });
  }
  const verified = await readVisibleEmailInputState(page, email);
  if (verified?.matches) {
    return {
      selector: EMAIL_INPUT_SELECTOR,
      index: verified.index ?? visibleIndex,
      mode: 'locator_fill_verified',
      verified: true,
      valueLength: verified.valueLength,
    };
  }
  if (fillResult.error) throw fillResult.error;
  throw new EmailInputValueError('visible email input could not be filled and verified', {
    selector: EMAIL_INPUT_SELECTOR,
    index: verified?.index ?? visibleIndex,
    valueLength: verified?.valueLength ?? null,
  });
}

async function waitForEmailEntryReady(page, timeoutMs) {
  if (!page || typeof page.locator !== 'function') return false;
  try {
    await page.locator(EMAIL_INPUT_SELECTOR).first().waitFor({
      state: 'visible',
      timeout: Math.min(Number(timeoutMs) || 20000, 20000),
    });
    return true;
  } catch {
    return false;
  }
}

async function submitEmail({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try {
      if (typeof onEvent === 'function') onEvent(event);
    } catch {}
  };
  const selector = NEXT_STEP_SELECTORS.join(', ');
  const attempts = [];
  let lastError = null;
  for (let submitAttempt = 1; submitAttempt <= 1; submitAttempt += 1) {
    if (!await waitForEmailEntryReady(page, 20000)) {
      throw new EmailNextStepError('email input did not become ready in the current browser context');
    }
    const dismissedBeforeFill = await dismissCookieConsent(page);
    if (dismissedBeforeFill?.dismissed) emit({ step: 'email_cookie_consent_dismissed', submitAttempt, result: dismissedBeforeFill });
    emit({ step: submitAttempt === 1 ? 'email_fill_started' : 'email_landing_fill_started', submitAttempt });
    const fillResult = await fillEmailInput(page, email, timeoutMs);
    emit({ step: submitAttempt === 1 ? 'email_filled' : 'email_landing_filled', submitAttempt, result: fillResult });
    const authorizeRedirectPromise = waitForAuthorizeRedirect(page, timeoutMs);
    const authorizeContinuePromise = waitForAuthorizeContinueOutcome(page, timeoutMs);
    const nextAuthSigninPromise = waitForNextAuthSignin(page, timeoutMs);
    const dismissedBeforeClick = await dismissCookieConsent(page);
    if (dismissedBeforeClick?.dismissed) emit({ step: 'email_cookie_consent_dismissed', submitAttempt, result: dismissedBeforeClick });
    emit({ step: submitAttempt === 1 ? 'email_continue_click_started' : 'email_landing_continue_click_started', submitAttempt });
    const clickResult = await clickEmailFormContinue(page, timeoutMs);
    emit({ step: submitAttempt === 1 ? 'email_continue_clicked' : 'email_landing_continue_clicked', submitAttempt, result: clickResult });
    attempts.push({ fill: fillResult, click: clickResult });
    try {
      const next = page.locator(selector).first();
      const nextStepReadyPromise = next.waitFor({
        state: 'visible',
        timeout: Math.min(Number(timeoutMs) || 25000, 25000),
      });
      const nextStepPromise = nextStepReadyPromise
        .then(() => ({ type: 'next_step' }))
        .catch((error) => ({ type: 'next_step_error', error }));
      const never = () => new Promise(() => {});
      const authorizePromise = authorizeRedirectPromise
        .then((redirect) => redirect ? { type: 'authorize_redirect', redirect } : never());
      const authorizeContinueFailurePromise = authorizeContinuePromise
        .then((outcome) => (outcome && Number(outcome.status) >= 400
          ? { type: 'authorize_continue_failure', outcome }
          : never()));
      const nextAuthPromise = nextAuthSigninPromise
        .then((signin) => signin ? { type: 'nextauth_signin', signin } : never());
      const first = await Promise.race([nextStepPromise, authorizePromise, authorizeContinueFailurePromise, nextAuthPromise]);
      if (first?.type === 'nextauth_signin') {
        emit({ step: 'nextauth_signin_succeeded', submitAttempt, result: first.signin });
        const authorize = await settleWithin(authorizeRedirectPromise, Math.min(Number(timeoutMs) || 25000, 15000), null);
        if (!authorize) {
          throw new EmailNextStepError('NextAuth signin returned 2xx but no auth.openai.com authorize redirect followed');
        }
        first.type = 'authorize_redirect';
        first.redirect = authorize;
      }
      if (first?.type === 'next_step_error') {
        const lateAuthorize = await settleWithin(authorizeRedirectPromise, Math.min(1000, clampTimeout(timeoutMs, 5000)), null);
        if (lateAuthorize?.kind === 'email_entry') {
          emit({ step: 'email_landing_entry_detected', submitAttempt, authorize: lateAuthorize });
          if (submitAttempt >= 3) {
            throw new EmailProviderBranchError(
              'email submit stayed on the OpenAI email entry page after two submissions',
              { authorize: lateAuthorize, click: clickResult, submitAttempt },
            );
          }
          const ready = await waitForEmailEntryReady(page, timeoutMs);
          if (!ready) {
            throw new EmailNextStepError('OpenAI email entry landing was reached but no visible email field became ready');
          }
          continue;
        }
        throw first.error;
      }
      if (first?.type === 'authorize_continue_failure') {
        if (first.outcome.errorCode === 'invalid_username') {
          throw new EmailUsernameRejectedError(
            `email username was rejected by authorize/continue: ${first.outcome.errorMessage || first.outcome.errorCode}`,
            { outcome: first.outcome, click: clickResult, submitAttempt },
          );
        }
        throw new EmailNextStepError(
          `authorize/continue failed before OTP/password step: ${first.outcome.errorCode || first.outcome.status}`,
        );
      }
      if (first?.type === 'authorize_redirect' && first.redirect.kind === 'google_oauth') {
        throw new EmailProviderBranchError(
          'email submit reached Google OAuth instead of OpenAI email verification',
          { authorize: first.redirect, click: clickResult, submitAttempt },
        );
      }
      if (first?.type === 'authorize_redirect' && first.redirect.kind === 'email_entry') {
        emit({ step: 'email_landing_entry_detected', submitAttempt, authorize: first.redirect });
        throw new EmailProviderBranchError(
          'email submit stayed on the OpenAI email entry page',
          { authorize: first.redirect, click: clickResult, submitAttempt },
        );
      }
      let unexpectedAuthorizeRedirect = null;
      if (first?.type === 'authorize_redirect'
        && !['email_verification', 'create_password', 'login_password'].includes(first.redirect.kind)) {
        unexpectedAuthorizeRedirect = first.redirect;
      }
      if (first?.type !== 'next_step') {
        try {
          await nextStepReadyPromise;
        } catch (error) {
          if (unexpectedAuthorizeRedirect) {
            const securityChallenge = await isSecurityChallengePage(page);
            throw new EmailProviderBranchError(
              `email submit reached unexpected authorize branch: ${unexpectedAuthorizeRedirect.kind}`,
              { authorize: unexpectedAuthorizeRedirect, click: clickResult, submitAttempt, securityChallenge },
              { retryableProxy: securityChallenge },
            );
          }
          throw error;
        }
      }
      const nextStepKind = await detectEmailNextStepKind(page);
      return {
        step: 'email_submitted',
        nextStepSelector: selector,
        nextStepKind,
        fill: fillResult,
        click: clickResult,
        attempts,
      };
    } catch (error) {
      if (error?.code === 'EMAIL_SUBMIT_WRONG_PROVIDER_BRANCH') throw error;
      if (error?.code === 'EMAIL_USERNAME_REJECTED') throw error;
      lastError = error;
      break;
    }
  }
  throw new EmailNextStepError(`email was submitted but no OTP/password step became visible: ${lastError?.message || lastError}`);
}

async function hasVisibleSelector(page, selectors) {
  const selector = selectors.join(', ');
  try {
    const locator = page.locator(selector).first();
    return await isLocatorVisible(locator);
  } catch {
    return false;
  }
}

async function detectEmailNextStepKind(page) {
  if (await hasVisibleSelector(page, CREATE_PASSWORD_STEP_SELECTORS)) return 'create_password';
  if (await hasVisibleSelector(page, OTP_STEP_SELECTORS)) return 'otp';
  if (await hasVisibleSelector(page, LOGIN_PASSWORD_STEP_SELECTORS)) {
    const url = typeof page?.url === 'function' ? String(page.url() || '') : '';
    if (authorizeLocationKind(url) === 'create_password') return 'create_password';
    return 'login_password';
  }
  const url = typeof page?.url === 'function' ? String(page.url() || '') : '';
  const pathKind = authorizeLocationKind(url);
  if (pathKind === 'email_verification') return 'otp';
  if (pathKind === 'create_password') return 'create_password';
  if (pathKind === 'login_password') return 'login_password';
  return 'unknown';
}

module.exports = {
  submitEmail,
  dismissCookieConsent,
  EmailNextStepError,
  EmailProviderBranchError,
  EmailInputValueError,
  EmailUsernameRejectedError,
  NEXT_STEP_SELECTORS,
  OTP_STEP_SELECTORS,
  LOGIN_PASSWORD_STEP_SELECTORS,
  CREATE_PASSWORD_STEP_SELECTORS,
  detectEmailNextStepKind,
  EMAIL_FORM_SUBMIT_SELECTOR,
  EMAIL_INPUT_SELECTOR,
  fillEmailInput,
  clickEmailFormContinue,
  readVisibleEmailInputState,
  scrollEmailInputIntoView,
  flushPendingAuthForm,
  authorizeLocationKind,
  waitForAuthorizeContinueOutcome,
  dismissCookieConsent,
};
