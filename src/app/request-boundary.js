'use strict';

function parseAllowedOrigins(value = '') {
  return String(value).split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('SIGNLIST_ALLOWED_ORIGINS must contain HTTP(S) origins without credentials, paths or wildcards');
    }
    return url.origin;
  });
}

function hostname(value) {
  return String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').replace(/[.]$/, '');
}

function requestBoundaryError(req, config = {}) {
  const deniedHost = { status: 403, error: 'UNTRUSTED_REQUEST_HOST' };
  let target;
  try {
    if (!req.headers.host) return deniedHost;
    target = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`);
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) return deniedHost;
  } catch { return deniedHost; }
  const origins = config.allowedOrigins || [];
  const directHosts = new Set(['localhost', '127.0.0.1', '::1', hostname(req.socket?.localAddress)]);
  if (config.host && !['0.0.0.0', '::', '[::]'].includes(config.host)) directHosts.add(hostname(config.host));
  if (!directHosts.has(hostname(target.hostname)) && !origins.some(origin => new URL(origin).host === target.host)) return deniedHost;
  const origin = req.headers.origin;
  if (origin) {
    if (origin !== target.origin && !origins.includes(origin)) return { status: 403, error: 'CROSS_ORIGIN_REQUEST_DENIED' };
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    return { status: 403, error: 'CROSS_ORIGIN_REQUEST_DENIED' };
  }
  return null;
}

module.exports = { parseAllowedOrigins, requestBoundaryError };
