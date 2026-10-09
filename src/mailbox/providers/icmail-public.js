'use strict';

const crypto = require('node:crypto');

const ICMAIL_HOST = 'icmail.icloudmaill.xyz';
const ICMAIL_PATH_RE = /^\/api\/v1\/public\/inboxes\/[0-9a-f-]+\/?$/i;

function parseIcmailPublicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ICMAIL_HOST) return null;
    if (!ICMAIL_PATH_RE.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function messageFromPayload(payload, { email, url }) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  const address = normalizeEmail(data.address);
  const expectedEmail = normalizeEmail(email);
  if (expectedEmail && address && address !== expectedEmail) {
    const error = new Error('icmail public inbox address does not match registration email');
    error.code = 'ICMAIL_ADDRESS_MISMATCH';
    error.retryableProxy = false;
    throw error;
  }
  const code = String(data.code || '').trim();
  const receivedAt = String(data.sent_at || '').trim();
  if (!code || !receivedAt) return null;
  const parsedAt = Date.parse(receivedAt);
  if (!/^\d{6}$/.test(code) || !Number.isFinite(parsedAt)) return null;
  const subject = String(data.subject || 'ChatGPT verification code').trim();
  const snippet = String(data.snippet || '').trim();
  const messageText = [subject, snippet, 'verification code ' + code].filter(Boolean).join('\n');
  const id = crypto.createHash('sha256')
    .update([url, address, receivedAt, code].join('\n'))
    .digest('hex')
    .slice(0, 24);
  return {
    id,
    subject,
    sender: '',
    text: messageText,
    html: '',
    receivedAt: new Date(parsedAt).toISOString(),
  };
}

function createIcmailPublicProvider({ inboxUrl, fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseIcmailPublicUrl(inboxUrl);
  if (!parsed) throw new TypeError('valid icmail public inbox URL is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const canonicalUrl = parsed.toString();
  return {
    async listMessages({ email, signal } = {}) {
      const url = new URL(canonicalUrl);
      url.searchParams.set('_', String(Date.now()));
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal,
      });
      if (!response.ok) {
        const error = new Error('icmail public inbox returned HTTP ' + response.status);
        error.code = 'ICMAIL_PUBLIC_HTTP_ERROR';
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const message = messageFromPayload(payload, { email, url: canonicalUrl });
      return message ? [message] : [];
    },
  };
}

module.exports = {
  createIcmailPublicProvider,
  messageFromPayload,
  parseIcmailPublicUrl,
};
