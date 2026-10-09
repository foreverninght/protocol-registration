'use strict';

const { VersionedSettings } = require('../db/versioned-settings');

const DEFAULTS = Object.freeze({
  setupPassword: false,
  setupTotp2fa: false,
  validateOauthSession: false,
  phoneBindProbeEnabled: false,
  autoCheckEligibility: false,
  postRegistrationDelaySeconds: 0,
  enabled: false,
  domainMailboxBaseUrl: 'http://127.0.0.1:3102',
  domainMailboxApiToken: '',
  domain: '',
  localPartPrefix: '',
  timeoutSeconds: 120,
  pollIntervalMs: 3000,
  failRegistrationOnError: false,
});

function cleanText(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

function cleanDomain(value, fallback = DEFAULTS.domain) {
  const domain = cleanText(value, 120).replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : fallback;
}

function publicConfig(config) {
  const { domainMailboxApiToken, ...safe } = config;
  return { ...safe, domainMailboxApiTokenConfigured: Boolean(domainMailboxApiToken) };
}

class RegistrationChangeEmailSettings {
  constructor({ store }) {
    this.settings = new VersionedSettings({ store, key: 'registration.change_email' });
  }

  async initialize(seed = DEFAULTS) {
    await this.settings.initialize(seed);
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    const merged = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    return {
      ...merged,
      setupPassword: Boolean(merged.setupPassword),
      setupTotp2fa: Boolean(merged.setupTotp2fa),
      validateOauthSession: merged.validateOauthSession === true,
      phoneBindProbeEnabled: merged.phoneBindProbeEnabled === true,
      autoCheckEligibility: Boolean(merged.autoCheckEligibility),
      postRegistrationDelaySeconds: Math.max(0, Math.min(600, Math.trunc(Number(merged.postRegistrationDelaySeconds) || DEFAULTS.postRegistrationDelaySeconds))),
      enabled: Boolean(merged.enabled),
      domainMailboxBaseUrl: cleanText(merged.domainMailboxBaseUrl || DEFAULTS.domainMailboxBaseUrl, 500).replace(/\/+$/u, ''),
      domainMailboxApiToken: cleanText(merged.domainMailboxApiToken || process.env.DOMAIN_MAILBOX_API_TOKEN || '', 1000),
      domain: cleanDomain(merged.domain, DEFAULTS.domain),
      localPartPrefix: cleanText(merged.localPartPrefix, 32).toLowerCase().replace(/[^a-z0-9._-]+/gu, ''),
      timeoutSeconds: Math.max(30, Math.min(600, Math.trunc(Number(merged.timeoutSeconds) || DEFAULTS.timeoutSeconds))),
      pollIntervalMs: Math.max(500, Math.min(30000, Math.trunc(Number(merged.pollIntervalMs) || DEFAULTS.pollIntervalMs))),
      failRegistrationOnError: Boolean(merged.failRegistrationOnError),
    };
  }

  getPublicConfig() {
    return publicConfig(this.getSecretConfig());
  }

  async update(patch = {}) {
    const current = this.getSecretConfig();
    const next = {
      ...current,
      setupPassword: Boolean(patch.setupPassword ?? current.setupPassword),
      setupTotp2fa: Boolean(patch.setupTotp2fa ?? current.setupTotp2fa),
      validateOauthSession: patch.validateOauthSession === undefined ? current.validateOauthSession === true : patch.validateOauthSession === true,
      phoneBindProbeEnabled: patch.phoneBindProbeEnabled === undefined ? current.phoneBindProbeEnabled === true : patch.phoneBindProbeEnabled === true,
      autoCheckEligibility: Boolean(patch.autoCheckEligibility ?? current.autoCheckEligibility),
      postRegistrationDelaySeconds: Math.max(0, Math.min(600, Math.trunc(Number(patch.postRegistrationDelaySeconds ?? current.postRegistrationDelaySeconds) || 0))),
      enabled: Boolean(patch.enabled ?? current.enabled),
      domainMailboxBaseUrl: cleanText(patch.domainMailboxBaseUrl ?? current.domainMailboxBaseUrl, 500).replace(/\/+$/u, ''),
      domainMailboxApiToken: patch.domainMailboxApiToken === undefined
        ? current.domainMailboxApiToken
        : cleanText(patch.domainMailboxApiToken, 1000),
      domain: cleanDomain(patch.domain ?? current.domain, current.domain),
      localPartPrefix: cleanText(patch.localPartPrefix ?? current.localPartPrefix, 32).toLowerCase().replace(/[^a-z0-9._-]+/gu, ''),
      timeoutSeconds: Math.max(30, Math.min(600, Math.trunc(Number(patch.timeoutSeconds ?? current.timeoutSeconds) || current.timeoutSeconds))),
      pollIntervalMs: Math.max(500, Math.min(30000, Math.trunc(Number(patch.pollIntervalMs ?? current.pollIntervalMs) || current.pollIntervalMs))),
      failRegistrationOnError: Boolean(patch.failRegistrationOnError ?? current.failRegistrationOnError),
      updatedAt: new Date().toISOString(),
    };
    await this.settings.replace(next);
    return publicConfig(next);
  }
}

module.exports = {
  RegistrationChangeEmailSettings,
  DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS: DEFAULTS,
};
