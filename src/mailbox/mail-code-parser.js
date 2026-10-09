'use strict';

const CHATGPT_SUBJECT_RE = /temporary\s+chatgpt\s+verification\s+code|chatgpt.*verification\s+code|verification\s+code/i;
const CHATGPT_SENDER_RE = /chatgpt|openai|noreply/i;
const CODE_CONTEXT_RE = /verification\s+code|temporary\s+code|security\s+code|one[-\s]?time\s+code|otp|验证码|校验码/i;
const SIX_DIGIT_CODE_RE = /(?<!\d)(\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d)(?!\d)/g;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function decodeHtmlEntities(input) {
  return text(input)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function decodeQuotedPrintable(input) {
  return text(input)
    .replace(/=[\t ]*\r?\n[\t ]*/g, '')
    .replace(/=\s+(?=<html|<\/?[a-z][\s>])/gi, '')
    .replace(/=([A-F0-9]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function htmlToText(html) {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mailPartToSearchText(value) {
  const raw = text(value);
  if (!raw) return '';
  const decoded = decodeQuotedPrintable(raw);
  const looksLikeMarkup = /<html[\s>]|<body[\s>]|<table[\s>]|<p[\s>]|<div[\s>]|<span[\s>]/i.test(decoded);
  const looksLikeMime = /Content-(?:Type|Transfer-Encoding):|MIME-Version:/i.test(raw);
  if (looksLikeMarkup || looksLikeMime || decoded !== raw) return htmlToText(decoded);
  return raw;
}

function normalizeMail(mail) {
  const source = mail && typeof mail === 'object' ? mail : {};
  const subject = text(source.subject);
  const sender = text(source.sender || source.from);
  const bodyText = [
    mailPartToSearchText(source.text),
    htmlToText(decodeQuotedPrintable(source.html)),
  ].filter(Boolean).join('\n');
  const receivedAt = source.receivedAt
    || source.receivedDateTime
    || source.received_at
    || source.created_at
    || source.createdAt
    || source.updated_at
    || source.updatedAt
    || source.date
    || source.timestamp
    || source.mail_timestamp
    || null;
  return {
    id: source.id || source.mail_id || source.message_id || source.messageId || null,
    subject,
    sender,
    text: bodyText,
    receivedAt,
  };
}

function normalizedCode(rawCode) {
  return text(rawCode).replace(/\D/g, '');
}

function isDateLikeCodeCandidate(source, match) {
  const index = match.index ?? -1;
  const raw = text(match[1]);
  if (index < 0 || !raw) return false;
  const before = source.slice(Math.max(0, index - 32), index);
  const after = source.slice(index + raw.length, index + raw.length + 12);
  const window = `${before}${raw}${after}`;
  if (/接收时间|收到时间|\breceived(?:\s+at)?\b|\bsent(?:\s+at)?\b|\bdate\b|\btime\b/i.test(before)) return true;
  if (/\b20\d{2}[-/.年\s](?:0[1-9]|1[0-2]|[1-9])(?:[-/.月\sT]\d{1,2})?(?:[日\sT]\d{1,2}:\d{2})?/i.test(window)) return true;
  if (/\d{1,2}:\d{2}(?::\d{2})?/.test(window) && /\b20\d{2}/.test(window)) return true;
  return false;
}

function isIdentifierLikeCodeCandidate(source, match) {
  const index = match.index ?? -1;
  const raw = text(match[1]);
  if (index < 0 || !raw) return false;
  const before = source.slice(Math.max(0, index - 1), index);
  const after = source.slice(index + raw.length, index + raw.length + 8);
  if (/[A-Z0-9._%+@-]/i.test(before)) return true;
  if (/^@/i.test(after)) return true;
  if (/^\.[A-Z]{2,}/i.test(after)) return true;
  return false;
}

function isLowEntropyCodeCandidate(code) {
  const normalized = normalizedCode(code);
  if (/^(\d)\1{5}$/.test(normalized)) return true;
  return false;
}

function codeCandidatesFromText(value) {
  const candidates = [];
  const source = text(value);
  for (const match of source.matchAll(SIX_DIGIT_CODE_RE)) {
    if (isDateLikeCodeCandidate(source, match)) continue;
    if (isIdentifierLikeCodeCandidate(source, match)) continue;
    const code = normalizedCode(match[1]);
    if (isLowEntropyCodeCandidate(code)) continue;
    if (code.length === 6) candidates.push({ code, index: match.index ?? -1 });
  }
  return candidates;
}

function scoreMailForVerification(mail, codeIndex) {
  let score = 0;
  if (CHATGPT_SUBJECT_RE.test(mail.subject)) score += 40;
  if (CHATGPT_SENDER_RE.test(mail.sender)) score += 25;
  if (CODE_CONTEXT_RE.test(mail.subject)) score += 20;
  const nearby = mail.text.slice(Math.max(0, codeIndex - 120), codeIndex + 160);
  if (CODE_CONTEXT_RE.test(nearby)) score += 25;
  if (/unsubscribe|marketing|newsletter/i.test(mail.text)) score -= 10;
  return score;
}

function extractVerificationCodeFromMail(rawMail, options = {}) {
  const mail = normalizeMail(rawMail);
  const haystack = [mail.subject, mail.text].filter(Boolean).join('\n');
  const candidates = codeCandidatesFromText(haystack)
    .map((candidate) => ({
      ...candidate,
      score: scoreMailForVerification(mail, candidate.index),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const minScore = Number.isFinite(options.minScore) ? options.minScore : 25;
  const best = candidates.find((candidate) => candidate.score >= minScore);
  if (!best) {
    return {
      found: false,
      code: null,
      reason: candidates.length ? 'code_without_verification_context' : 'no_six_digit_code',
      mail,
      candidates,
    };
  }

  return {
    found: true,
    code: best.code,
    reason: 'verification_code_found',
    mail,
    candidates,
  };
}

function timeValue(value) {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000;
  }
  const numeric = String(value).trim();
  if (/^\d{10,13}$/.test(numeric)) {
    const number = Number(numeric);
    return numeric.length >= 13 ? number : number * 1000;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function normalizeSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
}

function selectLatestVerificationCodeMail(mails, options = {}) {
  const after = timeValue(options.after);
  const seenIds = normalizeSet(options.seenIds || options.excludeIds || options.excludedIds);
  const seenCodes = normalizeSet(options.seenCodes || options.excludeCodes || options.excludedCodes);
  const parsed = (Array.isArray(mails) ? mails : [])
    .map((mail) => extractVerificationCodeFromMail(mail, options))
    .filter((result) => result.found)
    .filter((result) => {
      if (seenIds.has(String(result.mail.id || '').trim())) return false;
      if (seenCodes.has(String(result.code || '').trim())) return false;
      if (!after) return true;
      const received = timeValue(result.mail.receivedAt);
      return received > after;
    })
    .sort((a, b) => timeValue(b.mail.receivedAt) - timeValue(a.mail.receivedAt));

  if (!parsed.length) {
    return {
      found: false,
      code: null,
      reason: after ? 'no_code_after_baseline' : 'no_matching_code_mail',
      mail: null,
    };
  }
  return parsed[0];
}

module.exports = {
  extractVerificationCodeFromMail,
  selectLatestVerificationCodeMail,
  normalizeMail,
  htmlToText,
  codeCandidatesFromText,
  decodeQuotedPrintable,
  mailPartToSearchText,
};
