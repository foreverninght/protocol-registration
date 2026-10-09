'use strict';

const crypto = require('node:crypto');
const { htmlToText } = require('../mail-code-parser');

const ISO_TIME_RE = /20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/;
const LOCAL_TIME_RE = /20\d\d-\d\d-\d\d[ T]\d\d:\d\d:\d\d/;
const SIX_DIGIT_CODE_RE = /(?<!\d)\d{6}(?!\d)/;
const CHATGPT_SUBJECT_RE = /Your temporary ChatGPT verification code|ChatGPT verification code|verification code/i;
const SENDER_RE = /ChatGPT\s*<[^>]+>|OpenAI\s*<[^>]+>|noreply[^\s<]*/i;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeReceivedAt(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  if (ISO_TIME_RE.test(raw)) return (raw.match(ISO_TIME_RE) || [])[0];
  const local = (raw.match(LOCAL_TIME_RE) || [])[0];
  if (local) {
    const normalized = local.replace(' ', 'T');
    const time = Date.parse(`${normalized}+08:00`);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function extractSharePageMail({ html, url }) {
  const bodyText = htmlToText(html);
  const raw = [bodyText, text(html)].join('\n');
  const subject = (bodyText.match(CHATGPT_SUBJECT_RE) || [])[0] || 'Your temporary ChatGPT verification code';
  const senderSource = [bodyText, text(html).replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')].join('\n');
  const sender = (senderSource.match(SENDER_RE) || [])[0] || '';
  const receivedAt = normalizeReceivedAt((raw.match(ISO_TIME_RE) || raw.match(LOCAL_TIME_RE) || [])[0]);
  const id = crypto.createHash('sha256')
    .update(`${url || ''}\n${receivedAt || ''}\n${subject}\n${bodyText.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 24);

  return {
    id,
    subject,
    sender,
    text: bodyText,
    html: text(html),
    receivedAt,
  };
}

function mailboxJsonUrl(shareUrl) {
  const url = new URL(shareUrl);
  url.searchParams.set('format', 'json');
  url.searchParams.set('refresh', '1');
  url.searchParams.set('_', String(Date.now()));
  return url.toString();
}

function stableMessageId({ url, receivedAt, subject, bodyText }) {
  return crypto.createHash('sha256')
    .update(`${url || ''}\n${receivedAt || ''}\n${subject || ''}\n${text(bodyText).slice(0, 200)}`)
    .digest('hex')
    .slice(0, 24);
}

function mapPublicJsonMessage(message, url) {
  if (!message || typeof message !== 'object') return null;
  const codes = Array.isArray(message.codes) ? message.codes.filter(Boolean).map(String) : [];
  const html = text(message.preview || message.html || message.content);
  const bodyText = [
    codes.length ? `verification code ${codes.join(' ')}` : '',
    text(message.text || message.body),
    htmlToText(html),
  ].filter(Boolean).join('\n');
  const subject = text(message.subject) || 'Your temporary ChatGPT verification code';
  const sender = text(message.from || message.sender);
  const receivedAt = normalizeReceivedAt(message.date || message.receivedAt || message.created_at || message.createdAt);
  return {
    id: text(message.id) || stableMessageId({ url, receivedAt, subject, bodyText }),
    subject,
    sender,
    text: bodyText,
    html,
    receivedAt,
  };
}

function jsonMessages(payload, url) {
  if (!payload || typeof payload !== 'object') return null;
  const messages = [];
  if (payload.message) messages.push(payload.message);
  if (Array.isArray(payload.messages)) messages.push(...payload.messages);
  return messages.map((message) => mapPublicJsonMessage(message, url)).filter(Boolean);
}

function htmlFallbackMessages(html, url) {
  const mail = extractSharePageMail({ html, url });
  if (!mail.receivedAt && !SIX_DIGIT_CODE_RE.test(mail.text)) return [];
  return [mail];
}

function createSharePageMailboxProvider(options) {
  const {
    shareUrl,
    fetchImpl = globalThis.fetch,
  } = options || {};
  if (!shareUrl || typeof shareUrl !== 'string') throw new TypeError('shareUrl is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  return {
    async listMessages({ signal } = {}) {
      const jsonUrl = mailboxJsonUrl(shareUrl);
      const jsonResponse = await fetchImpl(jsonUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
          'cache-control': 'no-store',
        },
        signal,
      });
      if (jsonResponse.ok) {
        const contentType = jsonResponse.headers?.get?.('content-type') || '';
        if (/application\/json/i.test(contentType)) {
          const payload = await jsonResponse.json();
          return jsonMessages(payload, shareUrl) || [];
        }
        const refreshedHtml = await jsonResponse.text();
        return htmlFallbackMessages(refreshedHtml, shareUrl);
      }

      const response = await fetchImpl(shareUrl, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'cache-control': 'no-store',
        },
        signal,
      });
      if (!response.ok) {
        const error = new Error(`mailbox share page returned HTTP ${response.status}`);
        error.code = 'MAILBOX_SHARE_HTTP_ERROR';
        error.status = response.status;
        throw error;
      }
      const contentType = response.headers?.get?.('content-type') || '';
      if (/application\/json/i.test(contentType)) {
        const payload = await response.json();
        const messages = jsonMessages(payload, shareUrl);
        if (messages) return messages;
        const html = payload.html || payload.content || payload.text || JSON.stringify(payload);
        return htmlFallbackMessages(html, shareUrl);
      }
      const html = await response.text();
      return htmlFallbackMessages(html, shareUrl);
    },
  };
}

module.exports = {
  createSharePageMailboxProvider,
  extractSharePageMail,
  normalizeReceivedAt,
};
