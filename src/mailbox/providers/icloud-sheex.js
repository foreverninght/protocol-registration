'use strict';

const crypto = require('node:crypto');
const { htmlToText } = require('../mail-code-parser');

function text(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeReceivedAt(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseIcloudSheexMailboxUrl(mailboxUrl) {
  let url;
  try {
    url = new URL(mailboxUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'icloud.sheex.xyz') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'messages') return null;
  const mailboxId = parts[1];
  const email = decodeURIComponent(parts.slice(2).join('/'));
  if (!mailboxId || !email) return null;
  return { mailboxId, email };
}

function icloudSheexApiUrl(mailboxUrl) {
  const parsed = parseIcloudSheexMailboxUrl(mailboxUrl);
  if (!parsed) return null;
  const url = new URL(`/api/v1/messages/${encodeURIComponent(parsed.mailboxId)}/${encodeURIComponent(parsed.email)}`, 'https://icloud.sheex.xyz');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('summary', '1');
  url.searchParams.set('includeFirstDetail', '1');
  return url.toString();
}

function stableMessageId({ id, subject, bodyText, receivedAt }) {
  if (text(id)) return text(id);
  return crypto.createHash('sha256')
    .update(`${receivedAt || ''}\n${subject || ''}\n${text(bodyText).slice(0, 300)}`)
    .digest('hex')
    .slice(0, 24);
}

function mapIcloudSheexMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const html = text(message.html || message.content);
  const preview = text(message.preview);
  const explicitCode = text(message.code);
  const bodyText = [
    explicitCode ? `verification code ${explicitCode}` : '',
    preview,
    text(message.text || message.body),
    htmlToText(html),
  ].filter(Boolean).join('\n');
  const subject = text(message.subject) || 'Your temporary ChatGPT verification code';
  const receivedAt = normalizeReceivedAt(message.date || message.receivedAt || message.created_at || message.createdAt);
  return {
    id: stableMessageId({
      id: message.id,
      subject,
      bodyText,
      receivedAt,
    }),
    subject,
    sender: text(message.from || message.sender),
    text: bodyText,
    html,
    receivedAt,
  };
}

function createIcloudSheexMailboxProvider(options) {
  const {
    shareUrl,
    fetchImpl = globalThis.fetch,
  } = options || {};
  const apiUrl = icloudSheexApiUrl(shareUrl);
  if (!apiUrl) throw new TypeError('valid icloud.sheex.xyz mailbox url is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  return {
    async listMessages({ signal } = {}) {
      const response = await fetchImpl(apiUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
          'cache-control': 'no-store',
        },
        signal,
      });
      if (!response.ok) {
        const error = new Error(`icloud.sheex mailbox api returned HTTP ${response.status}`);
        error.code = 'ICLOUD_SHEEX_HTTP_ERROR';
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      return messages.map(mapIcloudSheexMessage).filter(Boolean);
    },
  };
}

module.exports = {
  createIcloudSheexMailboxProvider,
  icloudSheexApiUrl,
  parseIcloudSheexMailboxUrl,
};
