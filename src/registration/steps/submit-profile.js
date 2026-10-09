'use strict';

const PROFILE_NAME_SELECTOR = 'input[name*="name" i], input[autocomplete="name"]';
const PROFILE_AGE_SELECTOR = 'input[name="age"], input[placeholder="Age" i], input[type="number"][min][max]';

const PROFILE_FORM_SUBMIT_SELECTOR = [
  'form:has(input[name*="name" i]) button[type="submit"]',
  'form:has(input[autocomplete="name"]) button[type="submit"]',
  'form:has(input[name*="name" i]) button:has-text("Continue")',
  'form:has(input[autocomplete="name"]) button:has-text("Continue")',
  'form:has(input[name*="name" i]) button:has-text("继续")',
  'form:has(input[autocomplete="name"]) button:has-text("继续")',
].join(', ');

function createAccountUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname === 'auth.openai.com' && url.pathname === '/api/accounts/create_account'
      ? url
      : null;
  } catch {
    return null;
  }
}

class ProfileSubmitError extends Error {
  constructor(message, { code = 'PROFILE_SUBMIT_FORM_INCOMPLETE', status = null, body = null } = {}) {
    super(message);
    this.name = 'ProfileSubmitError';
    this.code = code;
    this.status = status;
    this.body = body;
    this.retryableProxy = false;
  }
}

function isCreateAccountResponse(response) {
  if (!response || typeof response.url !== 'function') return false;
  return Boolean(createAccountUrl(response.url()))
    && typeof response.status === 'function'
    && response.status() >= 200
    && response.status() < 500;
}

function isCreateAccountRequest(request) {
  if (!request || typeof request.url !== 'function') return false;
  return Boolean(createAccountUrl(request.url()))
    && String(typeof request.method === 'function' ? request.method() : '').toUpperCase() === 'POST';
}

function lowerHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[String(key).toLowerCase()] = value;
  return out;
}

function summarizeCreateAccountBody(rawBody) {
  if (!rawBody) return { present: false };
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const summary = {
    present: true,
    bytes: Buffer.byteLength(text),
    json: false,
    keys: [],
  };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
    summary.json = true;
    summary.keys = Object.keys(parsed).sort();
    if (typeof parsed.name === 'string') summary.nameLength = parsed.name.trim().length;
    if (typeof parsed.birthdate === 'string') {
      summary.birthdateShape = /^\d{4}-\d{2}-\d{2}$/.test(parsed.birthdate) ? 'yyyy-mm-dd' : 'other';
    }
    if (typeof parsed.age === 'number' || typeof parsed.age === 'string') summary.agePresent = true;
  } catch {
    // Non-JSON bodies are intentionally not sampled here.
  }
  return summary;
}

function requestPostData(request) {
  if (!request) return null;
  if (typeof request.postDataBuffer === 'function') {
    try { return request.postDataBuffer(); } catch {}
  }
  if (typeof request.postData === 'function') {
    try { return request.postData(); } catch {}
  }
  return null;
}

async function installCreateAccountSentinelGate(page) {
  if (!page || typeof page.on !== 'function') {
    return {
      dispose: async () => {},
      snapshot: () => ({ installed: false }),
      waitForNextRequest: async () => null,
    };
  }
  const state = {
    installed: true,
    seen: false,
    allowed: false,
    missingSentinelSo: false,
    requestCount: 0,
    request: null,
    requests: [],
    waiters: [],
  };
  const notify = (decision) => {
    for (const waiter of state.waiters.splice(0)) waiter(decision);
  };
  const handler = (request) => {
    if (!isCreateAccountRequest(request)) return;
    const headers = lowerHeaders(typeof request.headers === 'function' ? request.headers() : {});
    state.seen = true;
    state.requestCount += 1;
    state.request = {
      method: typeof request.method === 'function' ? request.method() : 'POST',
      hasSentinelToken: Boolean(headers['openai-sentinel-token']),
      hasSentinelSoToken: Boolean(headers['openai-sentinel-so-token']),
      body: summarizeCreateAccountBody(requestPostData(request)),
    };
    state.requests.push(state.request);
    if (!headers['openai-sentinel-so-token']) {
      state.missingSentinelSo = true;
      notify({ kind: 'observed_missing_sentinel_so', request: state.request });
      return;
    }
    state.allowed = true;
    notify({ kind: 'observed', request: state.request });
  };
  page.on('request', handler);
  return {
    snapshot: () => ({
      ...state,
      waiters: [],
      request: state.request ? { ...state.request, body: { ...state.request.body } } : null,
      requests: state.requests.map((request) => ({ ...request, body: { ...request.body } })),
    }),
    waitForNextRequest(timeoutMs = 5000) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = state.waiters.indexOf(done);
          if (index >= 0) state.waiters.splice(index, 1);
          resolve(null);
        }, Math.max(250, Math.min(Number(timeoutMs) || 5000, 15000)));
        const done = (decision) => {
          clearTimeout(timer);
          resolve(decision);
        };
        state.waiters.push(done);
      });
    },
    async dispose() {
      if (typeof page.off === 'function') page.off('request', handler);
      else if (typeof page.removeListener === 'function') page.removeListener('request', handler);
    },
  };
}

function isSentinelReqResponse(response) {
  if (!response || typeof response.url !== 'function') return false;
  try {
    const url = new URL(response.url());
    return (url.hostname === 'sentinel.openai.com' || url.hostname === 'chatgpt.com')
      && url.pathname === '/backend-api/sentinel/req'
      && typeof response.status === 'function'
      && response.status() >= 200
      && response.status() < 300;
  } catch {
    return false;
  }
}

async function waitForCreateAccountSentinelRefresh(page, timeoutMs) {
  return waitForCreateAccountSentinelQuiet(page, timeoutMs, { quietMs: 1500, maxWaitMs: 8000 });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageDelay(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms).catch(() => {});
    return;
  }
  await wait(ms);
}

async function waitForCreateAccountSentinelQuiet(page, timeoutMs, options = {}) {
  const quietMs = Math.max(250, Math.min(Number(options.quietMs) || 1500, 5000));
  const maxWaitMs = Math.max(1000, Math.min(Number(options.maxWaitMs) || Number(timeoutMs) || 8000, 15000));
  const minResponses = Math.max(1, Math.min(Number(options.minResponses) || 1, 5));
  if (!page) return;

  if (typeof page.on === 'function') {
    await new Promise((resolve) => {
      let responses = 0;
      let quietTimer = null;
      const timeoutTimer = setTimeout(done, maxWaitMs);
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        if (typeof page.off === 'function') {
          try { page.off('response', onResponse); } catch {}
        } else if (typeof page.removeListener === 'function') {
          try { page.removeListener('response', onResponse); } catch {}
        }
      };
      function done() {
        cleanup();
        resolve();
      }
      function armQuietTimer() {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      }
      function onResponse(response) {
        if (!isSentinelReqResponse(response)) return;
        responses += 1;
        if (responses >= minResponses) armQuietTimer();
      }
      page.on('response', onResponse);
      if (typeof page.waitForResponse === 'function') {
        page.waitForResponse(isSentinelReqResponse, { timeout: maxWaitMs })
          .then(onResponse)
          .catch(() => {});
      }
    });
    return;
  }

  if (typeof page.waitForResponse === 'function') {
    await page.waitForResponse(isSentinelReqResponse, { timeout: maxWaitMs }).catch(() => null);
  }
  await pageDelay(page, quietMs);
}

async function responseText(response) {
  if (!response || typeof response.text !== 'function') return '';
  try {
    return await response.text();
  } catch (error) {
    return `response body unavailable: ${error?.message || error}`;
  }
}

function continueUrlFromCreateAccountBody(body) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const rawUrl = parsed?.continue_url || parsed?.page?.payload?.url;
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    if (url.pathname !== '/api/auth/callback/openai') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function ageFromBirthdate(birthdate) {
  if (!birthdate || !birthdate.year) return null;
  const year = Number(birthdate.year);
  if (!Number.isFinite(year) || year < 1900) return null;
  const age = new Date().getUTCFullYear() - year;
  return age >= 5 && age <= 130 ? age : null;
}

function generatedDisplayName() {
  const syllables = ['Bira', 'Nalo', 'Kavi', 'Milo', 'Raya', 'Tano', 'Lina', 'Sora', 'Veni', 'Daro'];
  const index = Math.abs(Date.now()) % syllables.length;
  return syllables[index];
}

async function profileValuesPresent(page) {
  if (typeof page.evaluate !== 'function') return true;
  return Boolean(await page.evaluate(({ nameSelector, ageSelector }) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nameInput = document.querySelector(nameSelector);
    const ageInput = document.querySelector(ageSelector);
    return visible(nameInput)
      && visible(ageInput)
      && String(nameInput.value || '').trim().length > 0
      && String(ageInput.value || '').trim().length > 0;
  }, { nameSelector: PROFILE_NAME_SELECTOR, ageSelector: PROFILE_AGE_SELECTOR }));
}

async function fillProfileValuesByDom(page, { name, age }) {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate(({ nameSelector, ageSelector, nameValue, ageValue }) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const setInputValue = (input, value) => {
      if (!input) return false;
      input.focus?.();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const findVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(visible) || null;
    const nameInput = findVisible(nameSelector);
    const ageInput = findVisible(ageSelector);
    const nameSet = setInputValue(nameInput, nameValue);
    const ageSet = setInputValue(ageInput, String(ageValue));
    return {
      nameSet,
      ageSet,
      nameLength: String(nameInput?.value || '').trim().length,
      ageLength: String(ageInput?.value || '').trim().length,
    };
  }, {
    nameSelector: PROFILE_NAME_SELECTOR,
    ageSelector: PROFILE_AGE_SELECTOR,
    nameValue: name,
    ageValue: String(age),
  });
}

async function submitProfileForm({ page }) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new ProfileSubmitError('browser page context is required to submit profile form', {
      code: 'PROFILE_SUBMIT_CONTEXT_MISSING',
    });
  }
  const result = await page.evaluate(({ nameSelector, ageSelector }) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0
        && !element.disabled;
    };
    const nameInput = document.querySelector(nameSelector);
    const ageInput = document.querySelector(ageSelector);
    const form = (nameInput || ageInput)?.closest('form');
    if (!form) return { ok: false, reason: 'profile_form_missing' };
    const buttons = Array.from(form.querySelectorAll('button[type="submit"], button'));
    const button = buttons.find(visible) || buttons[0] || null;
    if (button) {
      button.click();
      return { ok: true, mode: 'domButtonClick', buttonText: button.innerText || '' };
    }
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return { ok: true, mode: 'requestSubmit', buttonText: '' };
    }
    form.submit();
    return { ok: true, mode: 'formSubmit', buttonText: '' };
  }, { nameSelector: PROFILE_NAME_SELECTOR, ageSelector: PROFILE_AGE_SELECTOR });
  if (!result?.ok) {
    throw new ProfileSubmitError(`profile submit form was not available: ${result?.reason || 'unknown'}`, {
      code: 'PROFILE_SUBMIT_FORM_MISSING',
    });
  }
  return result;
}

async function submitProfile({ page, name, age, birthdate, timeoutMs }) {
  const displayName = name || generatedDisplayName();
  const displayAge = age || ageFromBirthdate(birthdate) || 30;
  let locatorFillError = null;
  const nameInput = page.locator(PROFILE_NAME_SELECTOR).first();
  await nameInput.waitFor({ state: 'visible', timeout: timeoutMs });
  try {
    await nameInput.fill(displayName, { timeout: timeoutMs });
  } catch (error) {
    locatorFillError = error;
  }

  const ageInput = page.locator(PROFILE_AGE_SELECTOR).first();
  await ageInput.waitFor({ state: 'visible', timeout: timeoutMs });
  try {
    await ageInput.fill(String(displayAge), { timeout: timeoutMs });
  } catch (error) {
    locatorFillError = locatorFillError || error;
  }

  let profileReady = await profileValuesPresent(page);
  if (!profileReady || locatorFillError) {
    await fillProfileValuesByDom(page, { name: displayName, age: displayAge }).catch(() => null);
    profileReady = await profileValuesPresent(page);
  }

  if (!profileReady) {
    throw new ProfileSubmitError('profile form was not filled: name and age are required before submit');
  }

  const gate = await installCreateAccountSentinelGate(page);
  let submit = null;
  let response = null;
  let gateSnapshot = gate.snapshot();
  try {
    const maxSubmitAttempts = gateSnapshot.installed ? 3 : 1;
    for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
      await waitForCreateAccountSentinelQuiet(page, timeoutMs, { quietMs: 1500, maxWaitMs: 8000 });
      const createAccountResponsePromise = typeof page.waitForResponse === 'function'
        ? page.waitForResponse(isCreateAccountResponse, { timeout: timeoutMs }).catch(() => null)
        : Promise.resolve(null);
      const decisionPromise = gateSnapshot.installed
        ? gate.waitForNextRequest(timeoutMs)
        : Promise.resolve(null);
      submit = await submitProfileForm({ page, timeoutMs });
      const decision = await decisionPromise;
      gateSnapshot = gate.snapshot();
      if (decision?.kind === 'blocked_missing_sentinel_so') {
        if (attempt < maxSubmitAttempts) {
          await waitForCreateAccountSentinelRefresh(page, timeoutMs);
          continue;
        }
        break;
      }
      response = await createAccountResponsePromise;
      break;
    }
  } finally {
    await gate.dispose();
  }
  if (!response && gateSnapshot.missingSentinelSo) {
    throw new ProfileSubmitError('create_account request was blocked because openai-sentinel-so-token was missing', {
      code: 'PROFILE_CREATE_ACCOUNT_SENTINEL_SO_MISSING',
      body: JSON.stringify({ request: gateSnapshot.request }),
    });
  }
  if (!response) {
    throw new ProfileSubmitError('profile submit did not produce create_account response', {
      code: 'PROFILE_CREATE_ACCOUNT_RESPONSE_MISSING',
      body: JSON.stringify({ createAccountRequest: gateSnapshot.request }),
    });
  }
  const status = response.status();
  const body = await responseText(response);
  if (status < 200 || status >= 300) {
    throw new ProfileSubmitError(
      `create_account failed with HTTP ${status}${body ? `: ${body.slice(0, 500)}` : ''}`,
      { code: 'PROFILE_CREATE_ACCOUNT_FAILED', status, body: body.slice(0, 2000) },
    );
  }
  return {
    step: 'profile_submitted',
    createAccountStatus: status,
    submit,
    createAccountRequest: gateSnapshot.request,
    continueUrl: continueUrlFromCreateAccountBody(body),
  };
}

module.exports = {
  submitProfile,
  submitProfileForm,
  PROFILE_FORM_SUBMIT_SELECTOR,
  PROFILE_NAME_SELECTOR,
  PROFILE_AGE_SELECTOR,
  ProfileSubmitError,
  fillProfileValuesByDom,
  isCreateAccountResponse,
  isCreateAccountRequest,
  summarizeCreateAccountBody,
  installCreateAccountSentinelGate,
  waitForCreateAccountSentinelQuiet,
  continueUrlFromCreateAccountBody,
};
