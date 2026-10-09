'use strict';

const http = require('node:http');

const DEFAULT_GEO_URL = 'http://ip-api.com/json/?fields=status,countryCode,timezone,city,query,as,asname,isp,proxy,hosting,mobile,message';
const DEFAULT_PROXY_MAX_LATENCY_MS = 15000;

function expectedCountryFromPool(pool) {
  if (!pool) return '';
  const countries = Array.isArray(pool.countries) ? pool.countries.filter(Boolean) : [];
  if (countries.length === 1) return String(countries[0]).toUpperCase();
  const name = String(pool.name || '').trim();
  if (/日本|japan|\bjp\b/i.test(name)) return 'JP';
  if (/新加坡|singapore|\bsg\b/i.test(name)) return 'SG';
  if (/马来|malaysia|\bmy\b/i.test(name)) return 'MY';
  if (/美国|united\s*states|\bus\b/i.test(name)) return 'US';
  return '';
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy?.username) return null;
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}`;
}

function checkProxyGeo(proxy, {
  url = DEFAULT_GEO_URL,
  timeoutMs = 8000,
  request = http.request,
} = {}) {
  if (!proxy) return Promise.resolve(null);
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, Number(timeoutMs) || 8000);
  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const deadline = setTimeout(() => {
      const error = Object.assign(new Error('proxy geo check timed out'), { code: 'PROXY_GEO_TIMEOUT' });
      finish(reject, error);
      req?.destroy(error);
    }, deadlineMs);
    const headers = {
      Host: new URL(url).host,
      Accept: 'application/json',
      Connection: 'close',
    };
    const auth = proxyAuthorizationHeader(proxy);
    if (auth) headers['Proxy-Authorization'] = auth;
    try {
      req = request({
        host: proxy.host,
        port: proxy.port,
        method: 'GET',
        path: url,
        headers,
        timeout: deadlineMs,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8192) req.destroy(new Error('proxy geo response too large'));
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            if (res.statusCode < 200 || res.statusCode >= 300 || parsed.status === 'fail') {
              const error = new Error(parsed.message || `proxy geo check failed with HTTP ${res.statusCode}`);
              error.code = 'PROXY_GEO_CHECK_FAILED';
              error.statusCode = res.statusCode;
              finish(reject, error);
              return;
            }
            finish(resolve, {
              ip: String(parsed.query || '').trim() || null,
              countryCode: String(parsed.countryCode || '').toUpperCase() || null,
              timezone: parsed.timezone || null,
              city: parsed.city || null,
              asn: parsed.as || null,
              asName: parsed.asname || null,
              isp: parsed.isp || null,
              proxy: typeof parsed.proxy === 'boolean' ? parsed.proxy : null,
              hosting: typeof parsed.hosting === 'boolean' ? parsed.hosting : null,
              mobile: typeof parsed.mobile === 'boolean' ? parsed.mobile : null,
              ipPresent: Boolean(parsed.query),
              latencyMs: Date.now() - startedAt,
            });
          } catch (error) {
            error.code = error.code || 'PROXY_GEO_RESPONSE_INVALID';
            finish(reject, error);
          }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('proxy geo check timed out'), { code: 'PROXY_GEO_TIMEOUT' })));
      req.on('error', (error) => {
        error.code = error.code || 'PROXY_GEO_REQUEST_FAILED';
        finish(reject, error);
      });
      req.end();
    } catch (error) {
      error.code = error.code || 'PROXY_GEO_REQUEST_FAILED';
      finish(reject, error);
    }
  });
}

async function assertProxyCountry(proxy, expectedCountry, options = {}) {
  const expected = String(expectedCountry || '').toUpperCase();
  if (!proxy || !expected) return { expectedCountry: expected || null, geo: null, accepted: true, reason: 'not_required' };
  const geo = await checkProxyGeo(proxy, options);
  const actual = String(geo?.countryCode || '').toUpperCase();
  if (actual !== expected) {
    const error = new Error(`proxy exit country ${actual || 'unknown'} did not match expected ${expected}`);
    error.code = 'PROXY_COUNTRY_MISMATCH';
    error.retryableProxy = true;
    error.expectedCountry = expected;
    error.actualCountry = actual || null;
    error.geo = geo;
    throw error;
  }
  return { expectedCountry: expected, geo, accepted: true, reason: 'matched' };
}

async function assertProxyQuality(proxy, {
  expectedCountry = '',
  maxLatencyMs = DEFAULT_PROXY_MAX_LATENCY_MS,
  ...options
} = {}) {
  if (!proxy) return { expectedCountry: null, geo: null, accepted: true, reason: 'direct' };
  const expected = String(expectedCountry || '').toUpperCase();
  const geo = await checkProxyGeo(proxy, options);
  const latency = Number(geo?.latencyMs);
  const latencyLimit = Math.max(1, Number(maxLatencyMs) || DEFAULT_PROXY_MAX_LATENCY_MS);
  if (Number.isFinite(latency) && latency > latencyLimit) {
    const error = new Error(`proxy quality check latency ${latency}ms exceeded ${latencyLimit}ms`);
    error.code = 'PROXY_LATENCY_TOO_HIGH';
    error.retryableProxy = true;
    error.geo = geo;
    error.latencyMs = latency;
    throw error;
  }
  if (expected) {
    const actual = String(geo?.countryCode || '').toUpperCase();
    if (actual !== expected) {
      const error = new Error(`proxy exit country ${actual || 'unknown'} did not match expected ${expected}`);
      error.code = 'PROXY_COUNTRY_MISMATCH';
      error.retryableProxy = true;
      error.expectedCountry = expected;
      error.actualCountry = actual || null;
      error.geo = geo;
      throw error;
    }
  }
  return { expectedCountry: expected || null, geo, accepted: true, reason: expected ? 'matched' : 'reachable' };
}

module.exports = {
  DEFAULT_GEO_URL,
  DEFAULT_PROXY_MAX_LATENCY_MS,
  expectedCountryFromPool,
  checkProxyGeo,
  assertProxyCountry,
  assertProxyQuality,
};
