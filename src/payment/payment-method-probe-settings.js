'use strict';

const { VersionedSettings } = require('../db/versioned-settings');

const DEFAULTS = Object.freeze({
  enabled: true,
  autoRunAfterRegistration: true,
  proxyPoolId: '',
});

function cleanText(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

function publicConfig(config) {
  return {
    enabled: config.enabled === true,
    autoRunAfterRegistration: config.autoRunAfterRegistration === true,
    proxyPoolId: cleanText(config.proxyPoolId || config.entryProxyPoolId, 80),
  };
}

class PaymentMethodProbeSettings {
  constructor({ store }) {
    this.settings = new VersionedSettings({ store, key: 'payment.method_probe' });
  }

  async initialize(seed = DEFAULTS) {
    await this.settings.initialize(seed);
    const saved = this.settings.get();
    if (Object.prototype.hasOwnProperty.call(saved, 'entryProxyPoolId')
      || Object.prototype.hasOwnProperty.call(saved, 'exitProxyPoolId')) {
      await this.settings.replace({
        ...this.getSecretConfig(),
        updatedAt: new Date().toISOString(),
      });
    }
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    const merged = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    const proxyPoolId = cleanText(merged.proxyPoolId || merged.entryProxyPoolId, 80);
    return {
      enabled: merged.enabled === true,
      autoRunAfterRegistration: merged.autoRunAfterRegistration === true,
      proxyPoolId,
    };
  }

  getPublicConfig() {
    return publicConfig(this.getSecretConfig());
  }

  async update(patch = {}) {
    const current = this.getSecretConfig();
    const proxyPoolId = cleanText(
      patch.proxyPoolId ?? patch.entryProxyPoolId ?? current.proxyPoolId,
      80,
    );
    const next = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      autoRunAfterRegistration: patch.autoRunAfterRegistration ?? current.autoRunAfterRegistration,
      proxyPoolId,
      updatedAt: new Date().toISOString(),
    };
    await this.settings.replace(next);
    return publicConfig(next);
  }
}

module.exports = {
  PaymentMethodProbeSettings,
  DEFAULT_PAYMENT_METHOD_PROBE_SETTINGS: DEFAULTS,
};
