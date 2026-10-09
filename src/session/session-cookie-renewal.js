'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
const SESSION_COOKIE_CHUNK_RE = /^__Secure-next-auth\.session-token\.(\d+)$/u;

class SessionCookieRenewalError extends Error {
  constructor(message, { code = 'SESSION_COOKIE_RENEWAL_FAILED', status = null } = {}) {
    super(message);
    this.name = 'SessionCookieRenewalError';
    this.code = code;
    this.status = status;
  }
}

function sessionTokenFromHeader(header = '') {
  const pairs = cookiePairsFromHeader(header);
  const exact = pairs.find((pair) => pair.name === SESSION_COOKIE_NAME);
  if (exact?.value) return exact.value;
  const chunks = pairs
    .map((pair) => {
      const match = String(pair.name || '').match(SESSION_COOKIE_CHUNK_RE);
      return match ? { index: Number(match[1]), value: pair.value } : null;
    })
    .filter((item) => item && Number.isFinite(item.index) && item.value)
    .sort((a, b) => a.index - b.index);
  return chunks.length ? chunks.map((chunk) => chunk.value).join('') : '';
}

function cookieDomainMatches(domain = '', host = 'chatgpt.com') {
  const normalized = String(domain || host).trim().replace(/^\./u, '').toLowerCase();
  return normalized && (host === normalized || host.endsWith(`.${normalized}`));
}

function cookieHeaderFromCookies(cookies = [], host = 'chatgpt.com') {
  const seen = new Set();
  const pairs = [];
  for (const cookie of cookies) {
    const name = String(cookie?.name || '').trim();
    const value = String(cookie?.value || '');
    if (!name || !value || seen.has(name) || !cookieDomainMatches(cookie?.domain, host)) continue;
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

function cookiePairsFromHeader(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return name && value ? { name, value } : null;
    })
    .filter(Boolean);
}

function isSessionTokenChunkName(name = '') {
  return SESSION_COOKIE_CHUNK_RE.test(String(name || ''));
}

function normalizeSessionTokenCookieSet(pairs = []) {
  const hasExact = pairs.some((pair) => pair.name === SESSION_COOKIE_NAME);
  const hasChunks = pairs.some((pair) => isSessionTokenChunkName(pair.name));
  if (hasChunks) return pairs.filter((pair) => pair.name !== SESSION_COOKIE_NAME);
  if (hasExact) return pairs.filter((pair) => !isSessionTokenChunkName(pair.name));
  return pairs;
}

function mergeCookieHeaders(...headers) {
  const order = [];
  const values = new Map();
  for (const header of headers) {
    const pairs = cookiePairsFromHeader(header);
    if (pairs.some((pair) => isSessionTokenChunkName(pair.name))) {
      values.delete(SESSION_COOKIE_NAME);
      const index = order.indexOf(SESSION_COOKIE_NAME);
      if (index >= 0) order.splice(index, 1);
    }
    if (pairs.some((pair) => pair.name === SESSION_COOKIE_NAME)) {
      for (let index = order.length - 1; index >= 0; index -= 1) {
        if (!isSessionTokenChunkName(order[index])) continue;
        values.delete(order[index]);
        order.splice(index, 1);
      }
    }
    for (const pair of pairs) {
      if (!values.has(pair.name)) order.push(pair.name);
      values.set(pair.name, pair.value);
    }
  }
  return normalizeSessionTokenCookieSet(order.map((name) => ({ name, value: values.get(name) })))
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('; ');
}

function upsertCookieHeaderValue(header, name, value) {
  const pairs = cookiePairsFromHeader(header);
  let replaced = false;
  let next = pairs.map((pair) => {
    if (pair.name !== name) return pair;
    replaced = true;
    return { name, value };
  });
  if (!replaced) next.push({ name, value });
  if (name === SESSION_COOKIE_NAME && value) next = next.filter((pair) => !isSessionTokenChunkName(pair.name));
  if (isSessionTokenChunkName(name)) next = next.filter((pair) => pair.name !== SESSION_COOKIE_NAME);
  return normalizeSessionTokenCookieSet(next).map((pair) => `${pair.name}=${pair.value}`).join('; ');
}

function accountSessionCookieHeader(account) {
  // Keep every raw-header cookie, then let the current structured jar override
  // only cookies with the same name (especially a browser-rotated session token).
  return mergeCookieHeaders(
    String(account?.sessionContext?.cookie || '').trim(),
    cookieHeaderFromCookies(account?.session?.cookies || []),
  );
}

function exactAccountProxy(account, proxyPools, fallbackPoolId = null) {
  const reference = account?.registrationEnvironment?.proxy || {};
  const exactId = String(reference.id || '').trim();
  const storedPoolId = String(reference.poolId || account?.registrationEnvironment?.proxyPoolId || '').trim();
  const poolIds = [storedPoolId, ...proxyPools.main.listPools().map((pool) => pool.id)]
    .filter((value, index, all) => value && all.indexOf(value) === index);
  if (exactId) {
    for (const poolId of poolIds) {
      const found = proxyPools.main.listRaw(poolId).find((proxy) => proxy.id === exactId);
      if (found) return found;
    }
  }
  const fallback = String(fallbackPoolId || '').trim();
  if (!fallback) return null;
  return proxyPools.main.pick({
    poolId: fallback,
    country: String(reference.country || '').trim() || undefined,
  });
}

function runRenewalSidecar({ config, account, proxy }) {
  const cookie = accountSessionCookieHeader(account);
  if (!sessionTokenFromHeader(cookie)) {
    throw new SessionCookieRenewalError('account has no saved ChatGPT session cookie', {
      code: 'SESSION_COOKIE_MISSING',
    });
  }
  if (!proxy) {
    throw new SessionCookieRenewalError('original registration proxy is unavailable; select a main proxy pool as fallback', {
      code: 'SESSION_COOKIE_PROXY_MISSING',
    });
  }
  const python = config.registration?.freepp?.python || 'python3';
  const script = path.resolve(__dirname, '..', '..', 'tools', 'renew_chatgpt_session_cookie.py');
  const payload = {
    email: account.email,
    cookie,
    user_agent: account.sessionContext?.user_agent || account.sessionContext?.userAgent || '',
    device_id: account.sessionContext?.oai_device_id || account.sessionContext?.deviceId || '',
    proxy: {
      raw: proxy.raw || '',
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || '',
      password: proxy.password || '',
      country: proxy.country || null,
      id: proxy.id || null,
      poolId: proxy.poolId || null,
    },
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd: path.dirname(script),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new SessionCookieRenewalError('session cookie renewal timed out', {
        code: 'SESSION_COOKIE_RENEWAL_TIMEOUT',
      });
      finish(reject, error);
    }, 45000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      let result = null;
      try { result = JSON.parse(stdout.trim()); } catch {}
      if (code === 0 && result?.ok && result?.session_cookie?.value) return finish(resolve, result);
      const error = new SessionCookieRenewalError(
        String(result?.error || stderr.trim() || `renewal sidecar exited with code ${code}`).slice(0, 800),
        {
          code: result?.code || 'SESSION_COOKIE_RENEWAL_FAILED',
          status: result?.status || null,
        },
      );
      return finish(reject, error);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function mergedSessionCookiePatch(account, renewal, expectedOldToken) {
  const currentHeader = accountSessionCookieHeader(account);
  const currentToken = sessionTokenFromHeader(currentHeader);
  if (!currentToken || currentToken !== expectedOldToken) {
    throw new SessionCookieRenewalError('saved session cookie changed while renewal was running', {
      code: 'SESSION_COOKIE_CHANGED_DURING_RENEWAL',
    });
  }
  const renewedAt = renewal.renewed_at || new Date().toISOString();
  const accessToken = String(renewal.access_token || '').trim();
  const cookies = Array.isArray(account.session?.cookies)
    ? account.session.cookies.map((cookie) => ({ ...cookie }))
    : [];
  const renewedCookies = Array.isArray(renewal.session_cookies) && renewal.session_cookies.length
    ? renewal.session_cookies
    : (renewal.session_cookie ? [renewal.session_cookie] : []);
  const cookieKey = (cookie) => [
    String(cookie?.domain || '').trim().replace(/^\./u, '').toLowerCase(),
    String(cookie?.path || '/').trim() || '/',
    String(cookie?.name || '').trim(),
  ].join('\n');
  let expires = 0;
  for (const renewed of renewedCookies) {
    if (!renewed?.name && !renewed?.value) continue;
    const normalized = {
      name: String(renewed.name || SESSION_COOKIE_NAME).trim(),
      value: String(renewed.value || '').trim(),
      domain: renewed.domain || '.chatgpt.com',
      path: renewed.path || '/',
      httpOnly: renewed.httpOnly !== false,
      secure: renewed.secure !== false,
      sameSite: renewed.sameSite || 'Lax',
      ...(Number(renewed.expires || 0) ? { expires: Number(renewed.expires || 0) } : {}),
    };
    if (!normalized.name || !normalized.value) continue;
    expires = Number(normalized.expires || expires || 0) || 0;
    const key = cookieKey(normalized);
    const existingIndex = cookies.findIndex((cookie) => cookieKey(cookie) === key);
    if (existingIndex >= 0) cookies[existingIndex] = { ...cookies[existingIndex], ...normalized };
    else cookies.push(normalized);
  }
  const hasRenewedChunks = renewedCookies.some((cookie) => isSessionTokenChunkName(cookie?.name));
  const hasRenewedExact = renewedCookies.some((cookie) => String(cookie?.name || '') === SESSION_COOKIE_NAME);
  let filteredCookies = cookies;
  if (hasRenewedChunks) filteredCookies = filteredCookies.filter((cookie) => cookie.name !== SESSION_COOKIE_NAME);
  if (hasRenewedExact) filteredCookies = filteredCookies.filter((cookie) => !isSessionTokenChunkName(cookie.name));
  const expiresAt = expires ? new Date(expires * 1000).toISOString() : null;
  let nextHeader = currentHeader || cookieHeaderFromCookies(filteredCookies);
  for (const renewed of renewedCookies) {
    if (!renewed?.value) continue;
    nextHeader = upsertCookieHeaderValue(nextHeader, String(renewed.name || SESSION_COOKIE_NAME), String(renewed.value || ''));
  }
  return {
    session: {
      ...(account.session || {}),
      cookies: filteredCookies,
      refreshedAt: renewedAt,
      renewedAt,
      expiresAt,
    },
    sessionContext: {
      ...(account.sessionContext || {}),
      cookie: nextHeader,
      renewedAt,
    },
    ...(accessToken ? {
      tokens: { ...(account.tokens || {}), accessToken, refreshedAt: renewedAt },
      accessTokenAvailable: true,
      accessTokenLastRefreshedAt: renewedAt,
    } : {}),
    sessionAvailable: true,
    sessionCookieStatus: 'active',
    sessionCookieLastRenewedAt: renewedAt,
    sessionCookieExpiresAt: expiresAt,
    sessionCookieLastError: null,
  };
}

async function renewAccountSessionCookie({
  config,
  accountStore,
  proxyPools,
  email,
  fallbackPoolId = null,
  renewalRunner = runRenewalSidecar,
}) {
  if (!accountStore) throw new TypeError('accountStore is required');
  const account = await accountStore.getByEmail(email, { includeSecret: true });
  if (!account) {
    throw new SessionCookieRenewalError('account was not found', {
      code: 'SESSION_COOKIE_ACCOUNT_NOT_FOUND',
      status: 404,
    });
  }
  const oldToken = sessionTokenFromHeader(accountSessionCookieHeader(account));
  const proxy = exactAccountProxy(account, proxyPools, fallbackPoolId);
  const renewal = await renewalRunner({ config, account, proxy });
  const latest = await accountStore.getByEmail(email, { includeSecret: true });
  if (!latest) {
    throw new SessionCookieRenewalError('account was deleted while renewal was running', {
      code: 'SESSION_COOKIE_ACCOUNT_NOT_FOUND',
      status: 404,
    });
  }
  const patch = mergedSessionCookiePatch(latest, renewal, oldToken);
  try {
    await accountStore.updateByEmail({ email, patch, expectedVersion: latest.version });
  } catch (error) {
    if (error?.code !== 'ACCOUNT_VERSION_CONFLICT') throw error;
    throw new SessionCookieRenewalError('saved account changed while renewal was being committed', {
      code: 'SESSION_COOKIE_CHANGED_DURING_RENEWAL',
    });
  }
  return {
    renewedAt: patch.sessionCookieLastRenewedAt,
    sessionStatus: 'active',
    expiresAt: patch.sessionCookieExpiresAt,
    maxAgeSeconds: Number(renewal.session_cookie?.maxAge || 0) || null,
    proxyCountry: proxy?.country || null,
    proxyId: proxy?.id || null,
    accessToken: String(renewal.access_token || ''),
    accessTokenAvailable: Boolean(renewal.access_token),
    cookieChanged: crypto.createHash('sha256').update(oldToken).digest('hex')
      !== crypto.createHash('sha256').update(sessionTokenFromHeader(patch.sessionContext.cookie)).digest('hex'),
  };
}

module.exports = {
  SESSION_COOKIE_NAME,
  SessionCookieRenewalError,
  accountSessionCookieHeader,
  cookieHeaderFromCookies,
  cookiePairsFromHeader,
  mergeCookieHeaders,
  exactAccountProxy,
  mergedSessionCookiePatch,
  renewAccountSessionCookie,
  sessionTokenFromHeader,
  upsertCookieHeaderValue,
  isSessionTokenChunkName,
};
