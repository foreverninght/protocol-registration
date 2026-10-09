'use strict';

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeDomain(value = '') {
  return String(value || '').trim().replace(/^@+/u, '').toLowerCase();
}

function isGeneratableDomain(value = '') {
  return Boolean(normalizeDomain(value));
}

function domainFromEmailOrDomain(value = '') {
  const text = String(value || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  return normalizeDomain(at >= 0 ? text.slice(at + 1) : text);
}

function defaultMailComAlias(mainEmail = '') {
  const email = normalizeEmail(mainEmail);
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email.slice(0, at)}@mail.com` : '';
}

function isDefaultMailComAlias(mainEmail = '', alias = '') {
  const builtIn = defaultMailComAlias(mainEmail);
  return Boolean(builtIn && normalizeEmail(alias) === builtIn);
}

function parseMainAccountLine(line = '') {
  const text = String(line || '');
  if (!text.trim()) return null;
  const separator = text.includes('----') ? '----' : (text.includes('|') ? '|' : '');
  if (!separator) return null;
  const splitAt = text.indexOf(separator);
  const email = normalizeEmail(text.slice(0, splitAt));
  const password = text.slice(splitAt + separator.length);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) || !password) return null;
  return { email, password };
}

module.exports = {
  normalizeEmail,
  normalizeDomain,
  isGeneratableDomain,
  defaultMailComAlias,
  isDefaultMailComAlias,
  domainFromEmailOrDomain,
  parseMainAccountLine,
};
