'use strict';

const { VersionedSettings } = require('../db/versioned-settings');

const DEFAULTS = Object.freeze({
  enabled: false,
  serviceBaseUrl: '',
  proxyPoolId: '',
  pollIntervalMs: 3000,
  smsProvider: 'smsbower',
  smsService: 'ts',
  smsApiKey: '',
  smsCountry: '',
  smsPriceMin: 0,
  smsPriceMax: 0,
  smsTimeoutSeconds: 180,
  smsMaxAttempts: 12,
  smsPhoneRetryLimit: 2,
  paymentTaskRetryLimit: 1,
  smsPreferGold: true,
});

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class PaymentSettings {
  constructor({ store }) {
    this.settings = new VersionedSettings({ store, key: 'payment.execution' });
  }

  async initialize(seed = DEFAULTS) {
    await this.settings.initialize(seed);
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    const merged = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    return {
      enabled: Boolean(merged.enabled),
      serviceBaseUrl: String(merged.serviceBaseUrl || DEFAULTS.serviceBaseUrl).trim().replace(/\/+$/u, ''),
      proxyPoolId: String(merged.proxyPoolId || '').trim(),
      pollIntervalMs: Math.max(1000, Math.min(30000, numberOr(merged.pollIntervalMs, DEFAULTS.pollIntervalMs))),
      smsProvider: String(merged.smsProvider || DEFAULTS.smsProvider).trim().toLowerCase() || DEFAULTS.smsProvider,
      smsService: 'ts',
      smsApiKey: String(merged.smsApiKey || '').trim(),
      smsCountry: String(merged.smsCountry || '').trim().toUpperCase(),
      smsPriceMin: Math.max(0, numberOr(merged.smsPriceMin, DEFAULTS.smsPriceMin)),
      smsPriceMax: Math.max(0, numberOr(merged.smsPriceMax, DEFAULTS.smsPriceMax)),
      smsTimeoutSeconds: Math.max(30, Math.min(1800, numberOr(merged.smsTimeoutSeconds, DEFAULTS.smsTimeoutSeconds))),
      smsMaxAttempts: Math.max(1, Math.min(50, Math.trunc(numberOr(merged.smsMaxAttempts, DEFAULTS.smsMaxAttempts)))),
      smsPhoneRetryLimit: Math.max(0, Math.min(19, Math.trunc(numberOr(merged.smsPhoneRetryLimit, DEFAULTS.smsPhoneRetryLimit)))),
      paymentTaskRetryLimit: Math.max(0, Math.min(5, Math.trunc(numberOr(merged.paymentTaskRetryLimit, DEFAULTS.paymentTaskRetryLimit)))),
      smsPreferGold: merged.smsPreferGold !== false,
    };
  }

  getPublicConfig() {
    const config = this.getSecretConfig();
    return {
      ...config,
      smsApiKey: config.smsApiKey ? '已配置' : '',
    };
  }

  async update(patch = {}) {
    const current = this.getSecretConfig();
    const next = {
      enabled: Boolean(patch.enabled ?? current.enabled),
      serviceBaseUrl: String(patch.serviceBaseUrl ?? current.serviceBaseUrl).trim().replace(/\/+$/u, ''),
      proxyPoolId: String(patch.proxyPoolId ?? current.proxyPoolId).trim(),
      smsProvider: String(patch.smsProvider ?? current.smsProvider).trim().toLowerCase() || 'smsbower',
      smsService: 'ts',
      smsApiKey: patch.smsApiKey === undefined ? current.smsApiKey : String(patch.smsApiKey || '').trim(),
      smsCountry: String(patch.smsCountry ?? current.smsCountry).trim().toUpperCase(),
      pollIntervalMs: Math.max(1000, Math.min(30000, Number(patch.pollIntervalMs ?? current.pollIntervalMs) || 3000)),
      smsPriceMin: Math.max(0, Number(patch.smsPriceMin ?? current.smsPriceMin) || 0),
      smsPriceMax: Math.max(0, Number(patch.smsPriceMax ?? current.smsPriceMax) || 0),
      smsTimeoutSeconds: Math.max(30, Math.min(1800, Number(patch.smsTimeoutSeconds ?? current.smsTimeoutSeconds) || 180)),
      smsMaxAttempts: Math.max(1, Math.min(50, Math.trunc(Number(patch.smsMaxAttempts ?? current.smsMaxAttempts) || 12))),
      smsPhoneRetryLimit: Math.max(0, Math.min(19, Math.trunc(Number(patch.smsPhoneRetryLimit ?? current.smsPhoneRetryLimit) || 0))),
      paymentTaskRetryLimit: Math.max(0, Math.min(5, Math.trunc(Number(patch.paymentTaskRetryLimit ?? current.paymentTaskRetryLimit) || 0))),
      smsPreferGold: Boolean(patch.smsPreferGold ?? current.smsPreferGold),
    };
    await this.settings.replace(next);
    return this.getPublicConfig();
  }
}

module.exports = { PaymentSettings, DEFAULT_PAYMENT_SETTINGS: DEFAULTS };
