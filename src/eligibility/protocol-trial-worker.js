'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { isIP } = require('node:net');
const { accountSessionCookieHeader, sessionTokenFromHeader } = require('../session/session-cookie-renewal');

const PROXY_SCHEMES = new Set(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);

const ALLOWED_STAGES = new Set(['session_trial', 'login_trial', 'trial_qualification']);
const NETWORK_CODES = new Set(['NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_FAILED']);

function failure(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function diagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const category = ['timeout', 'tls', 'proxy', 'http', 'protocol', 'unknown'].includes(value.category)
    ? value.category : 'unknown';
  const bounded = (input, min, max) => Number.isInteger(input) && input >= min && input <= max ? input : null;
  const phases = new Set(['input', 'bootstrap', 'authorize_continue', 'password_verify', 'mfa_factor', 'mfa_issue', 'mfa_verify', 'reauthorize', 'redirect', 'callback', 'session']);
  const reasons = new Set(['LOGIN_INPUT_MISSING', 'LOGIN_STEP_FAILED', 'LOGIN_HTTP_ERROR', 'LOGIN_CREDENTIALS_REJECTED', 'LOGIN_RESPONSE_INVALID', 'LOGIN_PASSWORD_PAGE_MISSING', 'LOGIN_MFA_FACTOR_MISSING', 'LOGIN_MFA_CODE_REJECTED', 'LOGIN_MFA_REJECTED', 'LOGIN_CONTINUE_MISSING', 'LOGIN_CALLBACK_INVALID', 'LOGIN_CALLBACK_REUSED', 'LOGIN_SESSION_MISSING']);
  return {
    category,
    httpStatus: bounded(value.httpStatus, 100, 599),
    curlCode: bounded(value.curlCode, 1, 99),
    ...(phases.has(value.phase) && reasons.has(value.reason) ? { phase: value.phase, reason: value.reason } : {}),
  };
}

function accountIdFromAccessToken(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return String(payload?.['https://api.openai.com/auth']?.chatgpt_account_id || '').trim();
  } catch {
    return '';
  }
}

function proxyUrl(proxy) {
  if (!proxy) return '';
  try {
    const raw = String(proxy.raw || '').trim();
    let scheme = String(proxy.protocol || proxy.scheme || proxy.type || 'http').toLowerCase().replace(/:$/u, '');
    let host = String(proxy.host || '').trim();
    let port = Number(proxy.port);
    let username = String(proxy.username || '');
    let password = String(proxy.password || '');
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
      if (/[\s\\]/u.test(raw)) return '';
      const parsed = new URL(raw);
      if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return '';
      scheme = parsed.protocol.slice(0, -1).toLowerCase();
      host = parsed.hostname;
      port = Number(parsed.port || (scheme === 'http' ? 80 : scheme === 'https' ? 443 : 0));
      username = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
    }
    if (!PROXY_SCHEMES.has(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
      if (isIP(host) !== 6) return '';
    }
    if (isIP(host) === 6) host = '[' + host + ']';
    else {
      if (!host || /[^a-z0-9.-]/iu.test(host) || host.length > 253
        || !host.replace(/\.$/u, '').split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) return '';
      host = new URL('http://' + host).hostname;
    }
    const auth = username || password
      ? encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@'
      : '';
    return scheme + '://' + auth + host + ':' + port;
  } catch {
    return '';
  }
}

function validToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/u.test(value);
}

function validateResult(result, { email, accountId }) {
  if (!result || typeof result.email !== 'string' || result.email.trim().toLowerCase() !== email.trim().toLowerCase()
    || result.accountId !== accountId || result.mfaVerified !== true
    || !['eligible', 'ineligible', 'error'].includes(result.status)
    || result.campaignId !== 'plus-1-month-free'
    || result.errorCode !== (result.status === 'error' ? 'TRIAL_PROBE_FAILED' : null)) {
    throw failure('TRIAL_RESULT_INVALID');
  }
  if (result.session != null && (typeof result.session !== 'object' || Array.isArray(result.session)
    || !validToken(result.session.accessToken) || !validToken(result.session.sessionToken))) {
    throw failure('TRIAL_RESULT_INVALID');
  }
  return {
    email: result.email.trim().toLowerCase(),
    accountId: result.accountId,
    mfaVerified: true,
    status: result.status,
    campaignId: result.campaignId,
    amountMinor: Number.isSafeInteger(result.amountMinor) ? result.amountMinor : null,
    currency: /^[A-Z]{3}$/u.test(String(result.currency || '')) ? result.currency : null,
    billingCountry: /^[A-Z]{2}$/u.test(String(result.billingCountry || '')) ? result.billingCountry : null,
    errorCode: result.errorCode,
    session: result.session && typeof result.session === 'object' ? {
      accessToken: String(result.session.accessToken || ''),
      sessionToken: String(result.session.sessionToken || ''),
    } : null,
  };
}

async function runProtocolTrialCheck({ account, proxy, timeoutMs = 180000, onStage = null, forceLogin = false,
  pythonPath = process.env.SIGNLIST_TRIAL_WORKER_PYTHON || process.env.FREEPP_PYTHON || process.env.FREEPP_HAR_PYTHON || 'python',
  scriptPath = process.env.SIGNLIST_TRIAL_WORKER_SCRIPT || path.resolve(__dirname, '../../python/rebind_worker/worker.py'),
  nodePath = process.env.SIGNLIST_TRIAL_WORKER_NODE || process.execPath,
  spawnImpl = spawn } = {}) {
  const email = String(account?.email || '').trim().toLowerCase();
  const password = String(account?.password || '');
  const totpSecret = String(account?.totpSecret || '').trim();
  const accessToken = String(account?.tokens?.accessToken || '').trim();
  const sessionToken = String(account?.tokens?.sessionToken || '').trim()
    || sessionTokenFromHeader(accountSessionCookieHeader(account));
  const expectedAccountId = accountIdFromAccessToken(accessToken);
  const endpoint = proxyUrl(proxy);
  if (!email || !password || !totpSecret || !expectedAccountId || !endpoint) throw failure('TRIAL_ACCOUNT_NOT_READY');
  const request = {
    type: 'trial',
    credentials: { email, password, totpSecret },
    proxy: endpoint,
    expectedAccountId,
    ...(!forceLogin && sessionToken ? { session: { accessToken, sessionToken }, mfaPreviouslyVerified: account.totpStatus === 'enabled' } : {}),
  };
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let buffer = '';
    let outputBytes = 0;
    let result = null;
    let pending = null;
    let timer = null;
    let killTimer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      child = spawnImpl(pythonPath, ['-B', '-u', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/iu.test(key))),
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONIOENCODING: 'utf-8',
          OPENAI_SENTINEL_NODE_PATH: nodePath,
        },
      });
    } catch {
      finish(failure('TRIAL_WORKER_START_FAILED'));
      return;
    }
    const stop = (error) => {
      if (settled || pending) return;
      pending = error;
      const signal = (name) => {
        try { process.kill(-child.pid, name); } catch {
          try { child.kill(name); } catch {}
        }
      };
      killTimer = setTimeout(() => signal('SIGKILL'), 1000);
      killTimer.unref();
      signal('SIGTERM');
      finish(error);
    };
    const handleLine = (line) => {
      if (settled || pending || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { stop(failure('TRIAL_PROTOCOL_ERROR')); return; }
      if (message?.type === 'stage' && ALLOWED_STAGES.has(message.stage)) {
        Promise.resolve(onStage?.(message.stage)).catch((error) => stop(error));
        return;
      }
      if (message?.type === 'result' && !result) {
        try { result = validateResult(message.result, { email, accountId: expectedAccountId }); }
        catch (error) { stop(error); }
        return;
      }
      if (message?.type === 'error') {
        const code = String(message.code || 'TRIAL_WORKER_FAILED');
        stop(failure(code, {
          diagnostic: diagnostic(message.diagnostic),
          retryableProxy: NETWORK_CODES.has(code) && message.diagnostic?.httpStatus == null,
        }));
        return;
      }
      stop(failure('TRIAL_PROTOCOL_ERROR'));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) return stop(failure('TRIAL_OUTPUT_LIMIT'));
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 256 * 1024) return stop(failure('TRIAL_OUTPUT_LIMIT'));
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) stop(failure('TRIAL_OUTPUT_LIMIT'));
    });
    child.once('error', () => finish(failure('TRIAL_WORKER_START_FAILED')));
    child.once('close', (code) => {
      clearTimeout(killTimer);
      if (pending) return finish(pending);
      if (code !== 0 || buffer.trim() || !result) return finish(failure('TRIAL_WORKER_EXIT_FAILED'));
      finish(null, result);
    });
    timer = setTimeout(() => stop(failure('WORKER_TIMEOUT', { retryableProxy: false })), timeoutMs);
    child.stdin.on('error', () => stop(failure('TRIAL_WORKER_STDIN_FAILED')));
    try { child.stdin.end(JSON.stringify(request) + '\n'); }
    catch { stop(failure('TRIAL_WORKER_STDIN_FAILED')); }
  });
}

module.exports = { accountIdFromAccessToken, proxyUrl, runProtocolTrialCheck, validateResult };
