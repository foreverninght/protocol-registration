'use strict';

const crypto = require('node:crypto');

const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-csrf-token|openai-sentinel-token|openai-sentinel-so-token|sentinel-so-token)$/i;
const SENSITIVE_QUERY = /token|code|state|session|auth|password|otp|csrf/i;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    const queryKeys = [...url.searchParams.keys()].sort();
    return {
      origin: url.origin,
      path: url.pathname,
      queryKeys,
      hasSensitiveQuery: queryKeys.some((key) => SENSITIVE_QUERY.test(key)),
      queryHash: url.search ? sha256(url.search).slice(0, 16) : null,
    };
  } catch {
    return { origin: null, path: '[invalid-url]', queryKeys: [], hasSensitiveQuery: false, queryHash: null };
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name.toLowerCase()] = SENSITIVE_HEADER.test(name) ? '[redacted]' : String(value);
  }
  return out;
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown').replace(/[A-Za-z0-9+/=]{24,}/g, '[redacted-token]');
}

function bodySummary(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const summary = {
    size: bytes.length,
    sha256: sha256(bytes).slice(0, 32),
    captured: false,
  };
  if (/json|text|javascript|html|css/i.test(contentType) && bytes.length <= 512 * 1024) {
    summary.captured = true;
    summary.sample = bytes.toString('utf8', 0, Math.min(bytes.length, 2048));
  }
  return summary;
}

function requestBodyShape(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const summary = {
    size: bytes.length,
    sha256: sha256(bytes).slice(0, 32),
    json: false,
    keys: [],
  };
  if (!bytes.length || !/json/i.test(contentType)) return summary;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
    summary.json = true;
    summary.keys = Object.keys(parsed).sort();
    if (typeof parsed.name === 'string') summary.nameLength = parsed.name.trim().length;
    if (typeof parsed.birthdate === 'string') {
      summary.birthdateShape = /^\d{4}-\d{2}-\d{2}$/.test(parsed.birthdate) ? 'yyyy-mm-dd' : 'other';
    }
    if (typeof parsed.age === 'number' || typeof parsed.age === 'string') summary.agePresent = true;
  } catch {
    // Keep only size/hash for malformed JSON.
  }
  return summary;
}

module.exports = { sanitizeUrl, sanitizeHeaders, sanitizeError, bodySummary, requestBodyShape, sha256 };
