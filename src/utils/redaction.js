'use strict';

const REDACTED = '[REDACTED]';
const PRIVATE_KEYS = new Set([
  'password', 'registrationpassword', 'authorization', 'proxyauthorization',
  'cookie', 'cookies', 'setcookie', 'otp', 'otpcode', 'usedcode', 'verificationcode',
  'secret', 'totpsecret', 'totpactivefactorid', 'totpenrollmentsessionid',
  'enrollmentsessionid', 'session', 'oauthsession', 'sessioncontext', 'tokenjson',
  'token', 'tokens', 'accesstoken', 'refreshtoken', 'sessiontoken', 'idtoken',
  'apikey', 'internalkey', 'domainmailboxapitoken', 'oaiclientauthsession',
]);

function privateKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return PRIVATE_KEYS.has(normalized) || /(?:password|secret|apikey|token)$/.test(normalized);
}

function redactString(value) {
  const text = String(value);
  if (/^\s*[\[{]/.test(text)) {
    try { return JSON.stringify(redactEventValue(JSON.parse(text))); } catch {}
  }
  return text
    .replace(/(^|[\r\n])([ \t]*(?:cookie|set-cookie|authorization|proxy-authorization):[ \t]*)[^\r\n]*/gi, '$1$2' + REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ' + REDACTED)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:code|[a-z_]*(?:token|secret|password)|session|api_?key)=)[^&#\s"'<>]+/gi, '$1' + REDACTED)
    .replace(/\b(["']?[a-z_][a-z0-9_-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;|{}\[\]]+)/gi, (match, prefix, secret) => {
      const key = prefix.replace(/["'\s:=]/g, '');
      if (!privateKey(key) && !(/^(?:code|used_code)$/i.test(key) && /^['"]?\d{4,8}['"]?$/.test(secret))) return match;
      return prefix + REDACTED;
    })
    .replace(/((?:\botp\b|verification\s+code|\u9a8c\u8bc1\u7801)(?:[ \t]*(?:code|\u5df2\u53d6\u5230|\u547d\u4e2d|\u4e3a))?[ \t]*[:=\uff1a]?[ \t]*)\d{4,8}\b/gi, '$1' + REDACTED);
}

function redactEventValue(value, key = '') {
  if ((privateKey(key) && typeof value !== 'boolean') || (/^code$/i.test(key) && /^\d{4,8}$/.test(String(value)))) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactEventValue(item));
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => (
    [childKey, redactEventValue(childValue, childKey)]
  )));
}

module.exports = { redactEventValue, redactString };
