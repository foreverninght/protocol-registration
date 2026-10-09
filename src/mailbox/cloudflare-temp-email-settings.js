'use strict';

const crypto = require('node:crypto');
const { VersionedSettings } = require('../db/versioned-settings');

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeAuth(value = '') {
  return String(value || '').trim();
}

function normalizeDomain(value = '') {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^\*\./, '')
    .toLowerCase();
}

function normalizeDomains(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value || '');
  return [...new Set(raw
    .split(/[\n,，;；\s]+/u)
    .map(normalizeDomain)
    .filter(Boolean))];
}

function slugLocalPart(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/u, '')
    .replace(/[^a-z0-9._+-]+/gu, '_')
    .replace(/^[._+-]+|[._+-]+$/g, '')
    .slice(0, 48);
}

function randomLabel(bytes = 5) {
  return crypto.randomBytes(bytes).toString('base64url').toLowerCase().replace(/_/g, '').slice(0, 10);
}

function randomLocalPart(prefix = '') {
  const slug = slugLocalPart(prefix);
  const suffix = randomLabel(6);
  return slug ? `${slug}.${suffix}` : suffix;
}

function publicConfig(config = {}) {
  return {
    baseUrl: config.baseUrl || '',
    hasAdminAuth: Boolean(config.adminAuth),
    hasCustomAuth: Boolean(config.customAuth),
    domains: Array.isArray(config.domains) ? config.domains : [],
    path: config.path || '/admin/mails',
    createPath: config.createPath || '/admin/new_address',
    limit: config.limit || 30,
    randomSubdomain: Boolean(config.randomSubdomain),
    defaultDomain: config.defaultDomain || (Array.isArray(config.domains) ? config.domains[0] : '') || '',
    usernamePrefix: config.usernamePrefix || '',
  };
}

class CloudflareTempEmailSettings {
  constructor({ store, defaults = {} }) {
    this.settings = new VersionedSettings({ store, key: 'mailbox.cloudflare_temp_email' });
    this.defaults = {
      baseUrl: normalizeBaseUrl(defaults.baseUrl),
      adminAuth: normalizeAuth(defaults.adminAuth),
      customAuth: normalizeAuth(defaults.customAuth),
      domains: normalizeDomains(defaults.domains || []),
      path: defaults.path || '/admin/mails',
      createPath: defaults.createPath || '/admin/new_address',
      limit: defaults.limit || 30,
      randomSubdomain: false,
      defaultDomain: normalizeDomain(defaults.defaultDomain || (defaults.domains || [])[0] || ''),
      usernamePrefix: '',
    };
  }

  async initialize(seed = null) {
    await this.settings.initialize(seed && typeof seed === 'object' ? seed : this.defaults);
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    const merged = {
      ...this.defaults,
      ...(saved && typeof saved === 'object' ? saved : {}),
    };
    const domains = normalizeDomains(merged.domains);
    return {
      baseUrl: normalizeBaseUrl(merged.baseUrl),
      adminAuth: normalizeAuth(merged.adminAuth),
      customAuth: normalizeAuth(merged.customAuth),
      domains,
      path: merged.path || '/admin/mails',
      createPath: merged.createPath || '/admin/new_address',
      limit: Math.max(1, Math.min(200, Number(merged.limit) || 30)),
      randomSubdomain: Boolean(merged.randomSubdomain),
      defaultDomain: normalizeDomain(merged.defaultDomain || domains[0] || ''),
      usernamePrefix: slugLocalPart(merged.usernamePrefix || ''),
    };
  }

  getPublicConfig() {
    return publicConfig(this.getSecretConfig());
  }

  async update(input = {}) {
    const current = this.getSecretConfig();
    const next = {
      ...current,
      updatedAt: new Date().toISOString(),
    };
    if (Object.prototype.hasOwnProperty.call(input, 'baseUrl')) next.baseUrl = normalizeBaseUrl(input.baseUrl);
    if (Object.prototype.hasOwnProperty.call(input, 'adminAuth')) next.adminAuth = normalizeAuth(input.adminAuth);
    if (Object.prototype.hasOwnProperty.call(input, 'customAuth')) next.customAuth = normalizeAuth(input.customAuth);
    const domainsUpdated = Object.prototype.hasOwnProperty.call(input, 'domains');
    const defaultDomainUpdated = Object.prototype.hasOwnProperty.call(input, 'defaultDomain');
    if (domainsUpdated) next.domains = normalizeDomains(input.domains);
    if (Object.prototype.hasOwnProperty.call(input, 'path')) next.path = String(input.path || '/admin/mails').trim() || '/admin/mails';
    if (Object.prototype.hasOwnProperty.call(input, 'createPath')) next.createPath = String(input.createPath || '/admin/new_address').trim() || '/admin/new_address';
    if (Object.prototype.hasOwnProperty.call(input, 'limit')) next.limit = Math.max(1, Math.min(200, Number(input.limit) || 30));
    if (Object.prototype.hasOwnProperty.call(input, 'randomSubdomain')) next.randomSubdomain = Boolean(input.randomSubdomain);
    if (defaultDomainUpdated) next.defaultDomain = normalizeDomain(input.defaultDomain);
    if (Object.prototype.hasOwnProperty.call(input, 'usernamePrefix')) next.usernamePrefix = slugLocalPart(input.usernamePrefix);
    if (domainsUpdated && !defaultDomainUpdated) next.defaultDomain = next.domains[0] || '';
    if (next.defaultDomain && next.domains.length && !next.domains.includes(next.defaultDomain)) {
      next.domains = [next.defaultDomain, ...next.domains];
    }
    if (!next.defaultDomain && next.domains[0]) next.defaultDomain = next.domains[0];
    await this.settings.replace(next);
    return publicConfig(this.getSecretConfig());
  }

  generateAddress(input = {}) {
    const config = this.getSecretConfig();
    const baseDomain = normalizeDomain(input.domain || config.defaultDomain || config.domains[0] || '');
    if (!baseDomain) {
      const error = new Error('cloudflare temp email domain is required');
      error.code = 'CLOUDFLARE_TEMP_EMAIL_DOMAIN_REQUIRED';
      throw error;
    }
    const localPart = slugLocalPart(input.localPart) || randomLocalPart(input.usernamePrefix || config.usernamePrefix);
    const useRandomSubdomain = Object.prototype.hasOwnProperty.call(input, 'randomSubdomain')
      ? Boolean(input.randomSubdomain)
      : Boolean(config.randomSubdomain);
    return {
      localPart,
      domain: baseDomain,
      email: `${localPart}@${baseDomain}`,
      randomSubdomain: useRandomSubdomain,
    };
  }
}

module.exports = {
  CloudflareTempEmailSettings,
  normalizeDomains,
  randomLocalPart,
  slugLocalPart,
};
