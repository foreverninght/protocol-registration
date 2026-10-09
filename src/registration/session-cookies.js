'use strict';

const SESSION_COOKIE_NAMES = new Set([
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
]);

function findSessionCookie(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const exact = list.find((cookie) => SESSION_COOKIE_NAMES.has(cookie?.name) && cookie.value);
  if (exact) return exact;
  for (const base of SESSION_COOKIE_NAMES) {
    const chunks = list
      .filter((cookie) => String(cookie?.name || '').startsWith(`${base}.`)
        && /^\d+$/.test(String(cookie.name).slice(base.length + 1))
        && cookie.value)
      .sort((a, b) => Number(String(a.name).slice(base.length + 1)) - Number(String(b.name).slice(base.length + 1)));
    if (chunks.length) {
      return {
        ...chunks[0],
        name: base,
        value: chunks.map((cookie) => cookie.value).join(''),
      };
    }
  }
  return null;
}

module.exports = { findSessionCookie };
