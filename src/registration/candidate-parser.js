'use strict';

const EMAIL_PATTERN = /(?<![A-Z0-9._%+])[A-Z0-9][A-Z0-9._%+-]*@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,}(?![A-Z0-9._%+])/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function emailFromUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const candidates = [
      ...url.pathname.split('/'),
      ...url.searchParams.values(),
      url.hash.replace(/^#/, ''),
    ].flatMap((part) => decoded(String(part || '')).split(/-{2,}|\s+/));
    for (const candidate of candidates) {
      const match = candidate.match(EMAIL_PATTERN);
      if (match) return normalizeEmail(match[0]);
    }
  } catch {
    return '';
  }
  return '';
}

function candidateFromLine(line) {
  const urlMatch = line.match(URL_PATTERN);
  const mailboxUrl = urlMatch ? urlMatch[0].replace(/-{2,}$/, '') : null;
  const outsideUrl = mailboxUrl ? line.replace(mailboxUrl, ' ') : line;
  const emailMatch = decoded(outsideUrl).match(EMAIL_PATTERN);
  const email = normalizeEmail(emailMatch?.[0] || emailFromUrl(mailboxUrl));
  if (!email) return null;
  let mailboxSource = 'manual';
  if (mailboxUrl) {
    try {
      mailboxSource = new URL(mailboxUrl).hostname.toLowerCase() === 'icmail.icloudmaill.xyz'
        ? 'icmail_public'
        : 'share_page';
    } catch {
      mailboxSource = 'share_page';
    }
  }
  return { email, mailboxUrl, mailboxSource };
}

function parseRegistrationCandidates(text) {
  const candidates = [];
  const rejected = [];
  const duplicateLines = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const candidate = candidateFromLine(line);
    if (!candidate) {
      rejected.push({ line: index + 1, reason: 'email_not_found' });
      return;
    }
    if (seen.has(candidate.email)) {
      duplicateLines.push({ line: index + 1, email: candidate.email });
      return;
    }
    seen.add(candidate.email);
    candidates.push(candidate);
  });
  return { candidates, rejected, duplicateLines };
}

module.exports = {
  parseRegistrationCandidates,
};
