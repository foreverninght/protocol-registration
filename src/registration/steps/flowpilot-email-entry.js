'use strict';

const {
  waitForAuthEmailBranch,
} = require('./auth-email-entry');
const { dismissCookieConsent, submitEmail } = require('./submit-email');

class FlowPilotEmailEntryError extends Error {
  constructor(message, { code = 'FLOWPILOT_EMAIL_ENTRY_FAILED', details = null, retryableProxy = true } = {}) {
    super(message);
    this.name = 'FlowPilotEmailEntryError';
    this.code = code;
    this.details = details;
    this.retryableProxy = retryableProxy;
  }
}

function clampTimeout(timeoutMs, fallback = 30000) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.min(Math.trunc(value), fallback));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function detectFlowPilotSecurityChallenge(page) {
  if (!page) return false;
  let url = '';
  try { url = String(page.url?.() || ''); } catch {}
  if (/(?:__cf_chl_|cf_chl_|challenges\.cloudflare\.com|turnstile)/i.test(url)) return true;
  try {
    const result = await page.evaluate(() => {
      const text = String(document.body?.innerText || '');
      const title = String(document.title || '');
      const hasTurnstile = Boolean(document.querySelector(
        'input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"]',
      ));
      return { hasTurnstile, challengeText: /Cloudflare|Just a moment|checking your browser|verify you are human|security verification/i.test(`${title}\n${text}`) };
    });
    return Boolean(result?.hasTurnstile || result?.challengeText);
  } catch {
    return false;
  }
}

async function openNaturalFlowPilotEntry({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try { if (typeof onEvent === 'function') onEvent(event); } catch {}
  };
  const otpIssuedAt = Date.now();
  const emailSubmit = await submitEmail({
    page,
    email,
    timeoutMs,
    onEvent: (event) => emit({
      ...event,
      step: `flowpilot_${event.step || event.type || 'email_event'}`,
    }),
  });
  const branch = await waitForAuthEmailBranch({ page, timeoutMs });
  emit({ step: 'flowpilot_natural_branch_ready', result: { branch } });
  return {
    step: 'email_submitted',
    mode: 'flowpilot_browser_natural',
    otpIssuedAt,
    branch,
    emailSubmit,
  };
}

async function waitForFlowPilotAuthShell(page, timeoutMs, onEvent) {
  const requestedTimeout = Number(timeoutMs);
  const deadline = Date.now() + Math.min(
    Number.isFinite(requestedTimeout) ? Math.max(1000, requestedTimeout) : 90000,
    90000,
  );
  let last = null;
  while (Date.now() < deadline) {
    if (await detectFlowPilotSecurityChallenge(page)) {
      throw new FlowPilotEmailEntryError('FlowPilot page is blocked by a Cloudflare security challenge', {
        code: 'FLOWPILOT_SECURITY_CHALLENGE',
        retryableProxy: true,
      });
    }
    let mwebCookieReady = false;
    try {
      const cookies = await page.context().cookies('https://chatgpt.com/');
      const names = new Set(cookies.map((cookie) => String(cookie.name || '')));
      mwebCookieReady = names.has('oai-mweb-origin') && names.has('oai-mweb-route-desktop');
    } catch {}
    last = await page.evaluate((cookieReady) => {
      const urls = [...document.querySelectorAll('script[src], link[href]')]
        .map((element) => String(element.src || element.href || ''));
      const text = String(document.body?.innerText || '');
      const visible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const hasVisibleControl = [...document.querySelectorAll('input, button, textarea, [role="button"], [role="link"]')]
        .some(visible);
      const mwebAssets = urls.filter((url) => /\/unauth-mweb\/(?:assets|scripts)\//i.test(url));
      return {
        readyState: document.readyState,
        hasEntryAction: /sign\s*up\s*for\s*free|log\s*in/i.test(text),
        hasVisibleControl,
        hasBodyText: text.trim().length > 0,
        authAssets: urls.filter((url) => /deferred\.auth|mobile-auth-modal|auth-handoff|stored-auth-account|core-auth-model|auth\.login_with/i.test(url)),
        mwebAssets,
        mwebCookieReady: Boolean(cookieReady),
      };
    }, mwebCookieReady).catch(() => null);
    const shellReady = Boolean(last?.hasEntryAction || last?.hasVisibleControl || last?.hasBodyText);
    if (shellReady) {
      try {
        if (typeof onEvent === 'function') onEvent({
          step: 'flowpilot_auth_shell_ready',
          result: {
            readyState: last.readyState || null,
            hasEntryAction: Boolean(last.hasEntryAction),
            hasVisibleControl: Boolean(last.hasVisibleControl),
            hasBodyText: Boolean(last.hasBodyText),
            authAssetCount: last.authAssets?.length || 0,
            mwebAssetCount: last.mwebAssets?.length || 0,
            mwebCookieReady: Boolean(last.mwebCookieReady),
          },
        });
      } catch {}
      return last;
    }
    await sleep(250);
  }
  throw new FlowPilotEmailEntryError('FlowPilot authentication shell did not become ready', {
    code: 'FLOWPILOT_AUTH_SHELL_NOT_READY',
    details: last,
    // The shell can lag behind a successful home response. This is a page
    // readiness failure, not evidence that the selected proxy is bad.
    retryableProxy: true,
  });
}

const PLAYWRIGHT_SIGNUP_NAME_PATTERN = /免费注册|注册|创建账号|创建帐户|sign\s*up|sign\s+up\s+for\s+free|get\s+started|create\s+account|daftar|mendaftar|secara\s+percuma|gratis|無料でサインアップ|サインアップ|無料登録|登録|アカウント作成/i;
const PLAYWRIGHT_LOGIN_NAME_PATTERN = /log\s*in|login|登录|登入|sign\s*in|log\s*masuk|masuk|ログイン/i;

const FLOWPILOT_ENTRY_STATE_SCRIPT = ({ click = false } = {}) => {
  const renderable = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (style.opacity === '0') return false;
    return true;
  };
  const hitVisible = (element) => {
    if (!renderable(element)) return false;
    const rect = element.getBoundingClientRect();
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + Math.min(rect.width - 1, Math.max(1, rect.width * 0.25)), rect.top + rect.height / 2],
      [rect.left + Math.min(rect.width - 1, Math.max(1, rect.width * 0.75)), rect.top + rect.height / 2],
    ];
    return points.some(([cx, cy]) => {
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return top && (top === element || element.contains(top) || top.contains(element));
    });
  };
  const enabled = (element) => {
    if (!element) return false;
    if (element.disabled) return false;
    return String(element.getAttribute('aria-disabled') || '').toLowerCase() !== 'true';
  };
  const actionText = (element) => String(
    element?.innerText
      || element?.textContent
      || element?.value
      || element?.getAttribute?.('aria-label')
      || element?.getAttribute?.('title')
      || '',
  ).replace(/\s+/g, ' ').trim();
  const firstVisible = (selector, predicate = renderable) => Array.from(document.querySelectorAll(selector)).find(predicate) || null;
  const emailInput = firstVisible([
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
    'input[name="login_hint"]',
    'input[data-testid*="email" i]',
    'input[id*="email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]',
  ].join(', '));
  const passwordInput = firstVisible([
    'input[type="password"]',
    'input[name*="password" i]',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
  ].join(', '));
  const otpInput = firstVisible([
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ].join(', '));
  const profileInput = firstVisible([
    'input[name*="name" i]',
    'input[autocomplete="name"]',
    'input[name="age"]',
    'input[autocomplete^="bday" i]',
    'input[type="number"]',
  ].join(', '));
  const authDialog = firstVisible('[role="dialog"], [aria-modal="true"], dialog');
  const authDialogText = actionText(authDialog);
  const authDialogOpen = Boolean(authDialog && /log\s*in\s+or\s+sign\s+up|continue\s+with\s+(?:google|apple|phone)/i.test(authDialogText));
  const path = String(location.pathname || '');
  const isCreatePasswordPath = /\/(?:create-account|u\/signup|signup)\/password(?:[/?#]|$)/i.test(path);
  const isLoginPasswordPath = /\/log-in\/password(?:[/?#]|$)/i.test(path);
  const isVerificationPath = /\/email-verification(?:[/?#]|$)/i.test(path);
  const signupTriggerPattern = /^(?:免费注册|注册|创建账号|创建帐户|sign\s*up|sign\s+up\s+for\s+free|get\s+started|create\s+account|daftar(?:\s+secara\s+percuma)?|daftar\s+gratis|mendaftar|無料でサインアップ|サインアップ|無料登録|登録|アカウント作成)$/i;
  const looseSignupTriggerPattern = /免费注册|注册|创建账号|创建帐户|sign\s*up|create\s+account|get\s+started|daftar|mendaftar|secara\s+percuma|gratis|無料|サインアップ|登録|アカウント作成/i;
  const loginTriggerPattern = /^(?:log\s*in|login|登录|登入|sign\s*in|log\s*masuk|masuk|ログイン)$/i;
  const looseLoginTriggerPattern = /log\s*in|login|登录|登入|sign\s*in|log\s*masuk|masuk|ログイン/i;
  const actions = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]'))
    .filter((element) => hitVisible(element) && enabled(element))
    .map((element) => ({ element, text: actionText(element) }))
    .filter((item) => item.text);
  const signupTrigger = actions.find((item) => signupTriggerPattern.test(item.text))
    || actions.find((item) => looseSignupTriggerPattern.test(item.text))
    || actions.find((item) => loginTriggerPattern.test(item.text))
    || actions.find((item) => looseLoginTriggerPattern.test(item.text))
    || null;
  const technicalEntryTrigger = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'))
    .filter((element) => hitVisible(element) && enabled(element))
    .map((element) => ({
      element,
      attrs: [
        element.id,
        element.getAttribute('name'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-test-id'),
        element.getAttribute('data-action'),
        element.getAttribute('href'),
        element.getAttribute('aria-label'),
        element.className,
      ].filter(Boolean).join(' ').toLowerCase(),
    }))
    .find((item) => /(^|[^a-z])(signup-button|login-button)([^a-z]|$)/.test(item.attrs)) || null;

  let state = 'unknown';
  if (profileInput || /^\/(?:$|\?|#)/.test(path) && /chatgpt\.com$/i.test(location.hostname)) state = 'profile_or_home';
  if (otpInput || isVerificationPath) state = 'verification_page';
  if (passwordInput && isLoginPasswordPath) state = 'login_password_page';
  else if (passwordInput && (isCreatePasswordPath || !isLoginPasswordPath)) state = 'password_page';
  if (emailInput) state = 'email_entry';
  if ((signupTrigger || technicalEntryTrigger) && !emailInput && !passwordInput && !otpInput && !profileInput) state = 'entry_home';
  if (authDialogOpen && !emailInput && !passwordInput && !otpInput) state = 'entry_modal';

  const result = {
    state,
    url: location.href,
    title: document.title || '',
    path,
    hasEmailInput: Boolean(emailInput),
    hasPasswordInput: Boolean(passwordInput),
    hasOtpInput: Boolean(otpInput),
    hasProfileInput: Boolean(profileInput),
    entryTriggerText: signupTrigger?.text || technicalEntryTrigger?.attrs || '',
    clicked: false,
  };
  if (click && signupTrigger?.element) {
    const element = signupTrigger.element;
    element.focus?.();
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
    result.clicked = true;
    result.clickedText = signupTrigger.text;
  }
  return result;
};

async function inspectFlowPilotSignupEntryState(page) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new FlowPilotEmailEntryError('browser page context is required for FlowPilot email entry', {
      code: 'FLOWPILOT_ENTRY_CONTEXT_MISSING',
    });
  }
  return page.evaluate(FLOWPILOT_ENTRY_STATE_SCRIPT, { click: false });
}

async function clickFlowPilotSignupEntry(page) {
  if (!page || typeof page.evaluate !== 'function') return { clicked: false, clickMode: 'none' };
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true';
    };
    const attributes = (element) => [
      element.id,
      element.getAttribute('name'),
      element.getAttribute('data-testid'),
      element.getAttribute('data-test-id'),
      element.getAttribute('data-action'),
      element.getAttribute('href'),
      element.getAttribute('aria-label'),
      element.className,
    ].filter(Boolean).join(' ').toLowerCase();
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(visible)
      .map((element) => ({ element, attrs: attributes(element) }))
      .filter((item) => /(^|[^a-z])(signup-button|login-button)([^a-z]|$)/.test(item.attrs))
      .sort((left, right) => {
        const leftRank = /(^|[^a-z])signup-button([^a-z]|$)/.test(left.attrs) ? 0 : 1;
        const rightRank = /(^|[^a-z])signup-button([^a-z]|$)/.test(right.attrs) ? 0 : 1;
        return leftRank - rightRank;
      });
    if (!candidates.length) return { clicked: false, clickMode: 'none', count: 0 };
    const target = candidates[0];
    target.element.scrollIntoView({ block: 'center' });
    target.element.click();
    return {
      clicked: true,
      clickMode: 'dom_technical_marker',
      attrs: target.attrs.slice(0, 160),
    };
  }).catch(() => ({ clicked: false, clickMode: 'none' }));
}

async function clickFlowPilotEmailEntryOption(page) {
  if (!page || typeof page.evaluate !== 'function') return { clicked: false };
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0
        && !element.disabled
        && element.getAttribute('aria-disabled') !== 'true';
    };
    const attributes = (element) => {
      const own = [
        element.id, element.name, element.type, element.autocomplete,
        element.getAttribute('data-testid'), element.getAttribute('data-test-id'),
        element.getAttribute('data-provider'), element.getAttribute('data-auth-provider'),
        element.getAttribute('data-idp'), element.getAttribute('href'),
        element.getAttribute('action'), element.getAttribute('formaction'),
        element.value, element.getAttribute('aria-label'), element.className,
      ].filter(Boolean).join(' ');
      const descendants = [...element.querySelectorAll('img, svg, use, [aria-label], [data-provider], [data-testid]')]
        .map((child) => [
          child.getAttribute('alt'), child.getAttribute('src'), child.getAttribute('href'),
          child.getAttribute('aria-label'), child.getAttribute('data-provider'),
          child.getAttribute('data-testid'), child.className,
        ].filter(Boolean).join(' ')).join(' ');
      return `${own} ${descendants}`.toLowerCase();
    };
    const good = /(^|[^a-z])(email|mail|username|passwordless|otp|magic)([^a-z]|$)/;
    const bad = /google|apple|microsoft|github|facebook|saml|sso|oauth|social|oidc|idp|provider|authorize|consent|grant|allow/;
    const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(visible)
      .map((element) => ({ element, attrs: attributes(element), hasLogo: Boolean(element.querySelector?.('img, svg, use')) }))
      .filter((item) => good.test(item.attrs) && !bad.test(item.attrs) && !item.hasLogo);
    if (candidates.length !== 1) return { clicked: false, count: candidates.length };
    candidates[0].element.scrollIntoView({ block: 'center' });
    candidates[0].element.click();
    return { clicked: true, attrs: candidates[0].attrs.slice(0, 160) };
  }).catch(() => ({ clicked: false }));
}

function branchFromFlowPilotState(state) {
  if (state?.state === 'verification_page') {
    return { kind: 'otp_required', via: 'flowpilot_state', url: state.url || null };
  }
  if (state?.state === 'password_page') {
    return { kind: 'create_password_required', via: 'flowpilot_state', url: state.url || null };
  }
  if (state?.state === 'login_password_page') {
    return { kind: 'login_password_required', via: 'flowpilot_state', url: state.url || null };
  }
  return null;
}

async function waitForFlowPilotSignupEntryState({ page, timeoutMs, autoOpenEntry = true, onEvent }) {
  const timeout = clampTimeout(timeoutMs);
  const startedAt = Date.now();
  let lastState = '';
  let lastClickAt = 0;
  let clickAttempts = 0;
  while (Date.now() - startedAt < timeout) {
    if (await detectFlowPilotSecurityChallenge(page)) {
      throw new FlowPilotEmailEntryError('FlowPilot page is blocked by a Cloudflare security challenge', {
        code: 'FLOWPILOT_SECURITY_CHALLENGE',
        retryableProxy: true,
      });
    }
    const dismissedCookie = await dismissCookieConsent(page);
    if (dismissedCookie?.dismissed) {
      try {
        if (typeof onEvent === 'function') {
          onEvent({ step: 'flowpilot_cookie_consent_dismissed', result: dismissedCookie });
        }
      } catch {}
    }
    const state = await inspectFlowPilotSignupEntryState(page);
    if (state.state !== lastState) {
      lastState = state.state;
      try {
        if (typeof onEvent === 'function') {
          onEvent({
            step: 'flowpilot_entry_state',
            result: {
              state: state.state,
              url: state.url,
              hasEmailInput: state.hasEmailInput,
              hasPasswordInput: state.hasPasswordInput,
              hasOtpInput: state.hasOtpInput,
              entryTriggerText: state.entryTriggerText || '',
            },
          });
        }
      } catch {}
    }
    if (['email_entry', 'password_page', 'login_password_page', 'verification_page'].includes(state.state)) {
      return state;
    }
    if (state.state === 'entry_modal') {
      const emailEntry = await clickFlowPilotEmailEntryOption(page);
      if (emailEntry?.clicked && typeof onEvent === 'function') {
        try {
          onEvent({ step: 'flowpilot_email_entry_option_clicked', result: emailEntry });
        } catch {}
      }
      await sleep(emailEntry?.clicked ? 1000 : 250);
      continue;
    }
    if (autoOpenEntry && state.state === 'entry_home' && Date.now() - lastClickAt >= 2000) {
      lastClickAt = Date.now();
      clickAttempts += 1;
      const clicked = await clickFlowPilotSignupEntry(page);
      try {
        if (typeof onEvent === 'function') {
          onEvent({
            step: 'flowpilot_entry_clicked',
            result: {
              clicked: Boolean(clicked?.clicked),
              text: clicked?.attrs || '',
              clickMode: clicked?.clickMode || 'none',
              attempt: clickAttempts,
            },
          });
        }
      } catch {}
    }
    await sleep(250);
  }
  const finalState = await inspectFlowPilotSignupEntryState(page).catch(() => null);
  const challenge = await detectFlowPilotSecurityChallenge(page);
  throw new FlowPilotEmailEntryError(challenge
    ? 'FlowPilot page is blocked by a Cloudflare security challenge'
    : 'FlowPilot entry did not reach email/password/OTP state', {
    code: challenge ? 'FLOWPILOT_SECURITY_CHALLENGE' : 'FLOWPILOT_ENTRY_NOT_READY',
    details: finalState,
    retryableProxy: challenge,
  });
}

async function openFlowPilotEmailEntry({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try {
      if (typeof onEvent === 'function') onEvent(event);
    } catch {}
  };
  emit({ step: 'flowpilot_entry_started' });
  const entryState = await waitForFlowPilotSignupEntryState({
    page,
    timeoutMs: Math.min(Number(timeoutMs) || 20000, 20000),
    autoOpenEntry: true,
    onEvent: emit,
  });
  emit({ step: 'flowpilot_natural_entry_ready', result: { state: entryState.state } });
  const result = await openNaturalFlowPilotEntry({
    page,
    email,
    timeoutMs,
    onEvent: (event) => emit({
      ...event,
      step: event.step || event.type || 'flowpilot_natural_event',
    }),
  });
  emit({ step: 'flowpilot_natural_entry_completed', result: { mode: result.mode, branch: result.branch } });
  return result;
}

module.exports = {
  openFlowPilotEmailEntry,
  waitForFlowPilotSignupEntryState,
  inspectFlowPilotSignupEntryState,
  clickFlowPilotSignupEntry,
  FlowPilotEmailEntryError,
};
