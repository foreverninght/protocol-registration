'use strict';

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') throw new TypeError('baseUrl is required');
  return baseUrl.replace(/\/+$/, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return at >= 0 ? normalized.slice(at + 1) : '';
}

function normalizeDomain(value) {
  return String(value || '').trim().replace(/^@+/, '').replace(/^\*\./, '').toLowerCase();
}

function domainsFromSettingsValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const domains = [];
  for (const item of values) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'object') {
      domains.push(...domainsFromSettingsValue([
        item.value,
        item.domain,
        item.name,
        item.label,
      ]));
      continue;
    }
    const text = String(item || '').trim();
    if (!text) continue;
    if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
      try {
        domains.push(...domainsFromSettingsValue(JSON.parse(text)));
        continue;
      } catch {
        // Fall through and split as plain text.
      }
    }
    domains.push(...text.split(/[\n,，;；\s]+/u).map(normalizeDomain).filter(Boolean));
  }
  return [...new Set(domains)].sort((a, b) => a.localeCompare(b));
}

function baseDomainFromMailDomain(domain) {
  const labels = normalizeDomain(domain).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

function domainMatchesEmail(email, domains = []) {
  const domain = emailDomain(email);
  if (!domain) return false;
  return (Array.isArray(domains) ? domains : [])
    .map(normalizeDomain)
    .filter(Boolean)
    .some((configured) => domain === configured || domain.endsWith(`.${configured}`));
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.mails)) return payload.mails;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.['hydra:member'])) return payload['hydra:member'];
  return [];
}

function firstString(values = []) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function stringsFromValue(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringsFromValue);
  if (typeof value === 'object') {
    return [
      value.address,
      value.email,
      value.mail,
      value.to,
      value.recipient,
    ].flatMap(stringsFromValue);
  }
  return [];
}

function domainsFromMailRows(rows = []) {
  const domains = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = row && typeof row === 'object' ? row : {};
    const values = [
      source.address,
      source.email,
      source.mail,
      source.to,
      source.recipient,
      source.recipients,
      source.envelope_to,
      source.envelopeTo,
      source.mail_to,
      source.mailTo,
    ].flatMap(stringsFromValue);
    for (const match of String(source.raw || '').matchAll(/\bfor\s+<([^<>@\s]+@[^<>\s]+)>/ig)) {
      values.push(match[1]);
    }
    for (const value of values) {
      const matches = String(value || '').match(/[A-Z0-9._%+-]+@((?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,})/ig) || [];
      for (const match of matches) {
        const domain = normalizeDomain(match.slice(match.lastIndexOf('@') + 1));
        if (domain) domains.add(domain);
      }
    }
  }
  return [...domains].sort((a, b) => a.localeCompare(b));
}

function baseDomainsFromMailRows(rows = []) {
  return [...new Set(domainsFromMailRows(rows)
    .map(baseDomainFromMailDomain)
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchCloudflareTempEmailRows(options, { offset = 0, signal } = {}) {
  const {
    baseUrl,
    adminAuth = '',
    customAuth = '',
    fetchImpl = globalThis.fetch,
    path = '/admin/mails',
    limit = 30,
  } = options || {};
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const root = normalizeBaseUrl(baseUrl);
  const url = new URL(`${root}${String(path || '/admin/mails').startsWith('/') ? path : `/${path}`}`);
  if (limit) url.searchParams.set('limit', String(Math.max(1, Math.min(30, Number(limit) || 30))));
  url.searchParams.set('offset', String(Math.max(0, Number(offset) || 0)));
  const response = await fetchImpl(url, { method: 'GET', headers: authHeaders({ adminAuth, customAuth }), signal });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(`cloudflare temp email api returned HTTP ${response.status}`);
    error.code = 'MAILBOX_API_HTTP_ERROR';
    error.status = response.status;
    error.responseBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw error;
  }
  return pickArray(payload);
}

async function listCloudflareTempEmailDomains(options, { signal } = {}) {
  const settings = await fetchCloudflareTempEmailSettings(options, { signal }).catch((error) => ({ error }));
  if (!settings.error && settings.domains.length) {
    return {
      domains: settings.domains,
      defaultDomains: settings.defaultDomains,
      randomSubdomainDomains: settings.randomSubdomainDomains,
      discoveredDomains: [],
      scanned: 0,
      source: 'open_api_settings',
    };
  }

  const pageLimit = 30;
  const maxRows = Math.max(pageLimit, Math.min(300, Number(options?.maxDomainScanRows) || 60));
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageLimit) {
    const page = await fetchCloudflareTempEmailRows({ ...options, limit: pageLimit }, { offset, signal });
    rows.push(...page);
    if (page.length < pageLimit) break;
  }
  return {
    domains: baseDomainsFromMailRows(rows),
    discoveredDomains: domainsFromMailRows(rows),
    scanned: rows.length,
    source: settings.error ? 'admin_mails_fallback' : 'admin_mails',
  };
}

async function fetchCloudflareTempEmailSettings(options, { signal } = {}) {
  const {
    baseUrl,
    adminAuth = '',
    customAuth = '',
    fetchImpl = globalThis.fetch,
    settingsPath = '/open_api/settings',
  } = options || {};
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const root = normalizeBaseUrl(baseUrl);
  const url = new URL(`${root}${String(settingsPath || '/open_api/settings').startsWith('/') ? settingsPath : `/${settingsPath}`}`);
  const response = await fetchImpl(url, { method: 'GET', headers: authHeaders({ adminAuth, customAuth }), signal });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(`cloudflare temp email settings returned HTTP ${response.status}`);
    error.code = 'MAILBOX_SETTINGS_HTTP_ERROR';
    error.status = response.status;
    error.responseBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw error;
  }
  const source = payload && typeof payload === 'object' ? payload : {};
  const domains = domainsFromSettingsValue(source.domains);
  return {
    domains,
    defaultDomains: domainsFromSettingsValue(source.defaultDomains).filter((domain) => domains.length ? domains.includes(domain) : true),
    randomSubdomainDomains: domainsFromSettingsValue(source.randomSubdomainDomains).filter((domain) => domains.length ? domains.includes(domain) : true),
  };
}

function mapCloudflareTempEmailMail(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const html = firstString([
    source.html,
    source.html_content,
    source.htmlContent,
    source.html_body,
    source.htmlBody,
    source.body_html,
    source.bodyHtml,
  ]);
  const text = firstString([
    source.text,
    source.text_content,
    source.textContent,
    source.bodyPreview,
    source.snippet,
    source.preview,
    source.content,
    source.body,
    source.mail_text,
    source.raw,
    source.mime,
    source.message,
  ]);
  return {
    id: firstString([source.id, source._id, source.mail_id, source.mailId, source.message_id, source.messageId, source.msgid]),
    subject: firstString([source.subject, source.title, source.mail_subject]),
    sender: firstString([
      source.sender,
      source.from,
      source.mail_from,
      source.mailFrom,
      source.from_email,
      source.fromEmail,
      source.sender_email,
      source.senderEmail,
    ]),
    text: text || stripHtml(html),
    html,
    receivedAt: firstString([
      source.receivedAt,
      source.receivedDateTime,
      source.received_at,
      source.created_at,
      source.createdAt,
      source.updated_at,
      source.updatedAt,
      source.date,
      source.timestamp,
    ]) || null,
  };
}

function cloudflareTempEmailConfigured(config = {}) {
  return Boolean(config?.baseUrl && (config?.adminAuth || config?.customAuth) && Array.isArray(config?.domains) && config.domains.length);
}

function authHeaders({ adminAuth = '', customAuth = '' } = {}) {
  const headers = { accept: 'application/json' };
  if (adminAuth) headers['x-admin-auth'] = adminAuth;
  if (customAuth) headers['x-custom-auth'] = customAuth;
  return headers;
}

function parseAddressPayload(payload, fallback = {}) {
  if (!payload || typeof payload !== 'object') return fallback.email || '';
  return firstString([
    payload.email,
    payload.address,
    payload.mail,
    payload.data?.email,
    payload.data?.address,
    payload.result?.email,
    payload.result?.address,
  ]) || fallback.email || '';
}

async function createCloudflareTempEmailAddress(options, address, { signal } = {}) {
  const {
    baseUrl,
    adminAuth = '',
    customAuth = '',
    fetchImpl = globalThis.fetch,
    createPath = '/admin/new_address',
  } = options || {};
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const root = normalizeBaseUrl(baseUrl);
  const url = new URL(`${root}${String(createPath || '/admin/new_address').startsWith('/') ? createPath : `/${createPath}`}`);
  const localPart = firstString([address?.localPart, String(address?.email || '').split('@')[0]]);
  const domain = firstString([address?.domain, String(address?.email || '').split('@')[1]]);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...authHeaders({ adminAuth, customAuth }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      enablePrefix: false,
      enableRandomSubdomain: Boolean(address?.randomSubdomain),
      name: localPart,
      domain,
    }),
    signal,
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(`cloudflare temp email create returned HTTP ${response.status}`);
    error.code = 'MAILBOX_ADDRESS_CREATE_HTTP_ERROR';
    error.status = response.status;
    error.responseBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw error;
  }
  return parseAddressPayload(payload, address);
}

function createCloudflareTempEmailProvider(options) {
  const {
    baseUrl,
    adminAuth = '',
    customAuth = '',
    fetchImpl = globalThis.fetch,
    path = '/admin/mails',
    limit = 30,
  } = options || {};
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const root = normalizeBaseUrl(baseUrl);

  return {
    async listMessages({ email, signal } = {}) {
      const url = new URL(`${root}${String(path || '/admin/mails').startsWith('/') ? path : `/${path}`}`);
      if (limit) url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', '0');
      if (email) url.searchParams.set('address', normalizeEmail(email));
      const response = await fetchImpl(url, { method: 'GET', headers: authHeaders({ adminAuth, customAuth }), signal });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
      if (!response.ok) {
        const error = new Error(`cloudflare temp email api returned HTTP ${response.status}`);
        error.code = 'MAILBOX_API_HTTP_ERROR';
        error.status = response.status;
        error.responseBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
        throw error;
      }
      return pickArray(payload).map(mapCloudflareTempEmailMail);
    },
  };
}

module.exports = {
  cloudflareTempEmailConfigured,
  createCloudflareTempEmailAddress,
  createCloudflareTempEmailProvider,
  domainsFromMailRows,
  domainsFromSettingsValue,
  fetchCloudflareTempEmailSettings,
  baseDomainsFromMailRows,
  baseDomainFromMailDomain,
  domainMatchesEmail,
  listCloudflareTempEmailDomains,
  mapCloudflareTempEmailMail,
  pickArray,
};
