'use strict';

const { VersionedSettings } = require('../db/versioned-settings');

const PROVIDER_VALUES = Object.freeze(['pay153', 'public_cdk', 'gc_tacmon']);
const PUBLIC_REFINING_BASE_URL = String(process.env.PUBLIC_REFINING_BASE_URL || '').trim().replace(/[/]+$/u, '');
const GC_TACMON_BASE_URL = String(process.env.GC_TACMON_BASE_URL || '').trim().replace(/[/]+$/u, '');
const PLAN_VALUES = Object.freeze(['plus', 'pro', 'team', 'codex_low']);
const LINK_TYPE_VALUES = Object.freeze([
  'hosted', 'ph_short', 'paypal', 'gopay', 'ideal', 'twint', 'upi', 'pix', 'momo', 'gcash', 'kakao',
]);
const TWO_POOL_LINK_TYPES = Object.freeze(['ph_short', 'paypal', 'gopay', 'ideal', 'twint', 'upi', 'gcash', 'kakao']);

const DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'pay153',
  publicCdk: '',
  serviceBaseUrl: 'http://127.0.0.1:18082',
  internalKey: '',
  autoStartedAt: null,
  batchWindowSeconds: 10,
  deleteFailedAccounts: true,
  plan: 'plus',
  linkType: 'hosted',
  country: 'US',
  currency: 'USD',
  entryProxyPoolId: '',
  exitProxyPoolId: '',
  retryCount: 3,
  usePromo: true,
  promoCampaign: '',
  useSentinel: true,
  workspaceName: 'Codex Workspace',
  workspaceId: '',
  seatQuantity: 5,
  priceInterval: 'month',
  creditQuantity: 13,
  promoCode: '',
  paypalProxyRouteMode: 'current',
  paypalExtractMode: 'stripe',
  paypalCustomBillingCountry: 'US',
  paypalPromoMode: 'auto_by_session',
  gcashPromoMode: 'native_only',
  pixAutoKind: 'cpf',
  pixTaxId: '',
});

function limitedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function text(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function secretTextUpdate(input, key, current, max = 500) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return text(current[key], max);
  const value = text(input[key], max);
  return value ? value : text(current[key], max);
}

function normalizeServiceBaseUrl(value) {
  const raw = text(value || DEFAULTS.serviceBaseUrl, 500).replace(/\/+$/u, '');
  let url;
  try { url = new URL(raw); } catch { throw new Error('valid PAY.153 service URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('PAY.153 service URL must be an HTTP(S) URL without embedded credentials');
  }
  return url.toString().replace(/\/+$/u, '');
}

function normalizeSettings(input = {}, current = DEFAULTS) {
  const enabled = Boolean(input.enabled ?? current.enabled);
  const wasEnabled = Boolean(current.enabled);
  const selectedProvider = enumValue(input.provider, PROVIDER_VALUES, current.provider || DEFAULTS.provider);
  const next = {
    ...DEFAULTS,
    enabled,
    provider: selectedProvider,
    publicCdk: secretTextUpdate(input, 'publicCdk', current, 500),
    serviceBaseUrl: normalizeServiceBaseUrl(input.serviceBaseUrl ?? current.serviceBaseUrl),
    internalKey: Object.prototype.hasOwnProperty.call(input, 'internalKey') && text(input.internalKey, 500)
      ? text(input.internalKey, 500)
      : text(current.internalKey, 500),
    batchWindowSeconds: limitedInteger(input.batchWindowSeconds, current.batchWindowSeconds, 0, 300),
    deleteFailedAccounts: Boolean(input.deleteFailedAccounts ?? current.deleteFailedAccounts ?? DEFAULTS.deleteFailedAccounts),
    plan: enumValue(input.plan, PLAN_VALUES, current.plan),
    linkType: enumValue(input.linkType, LINK_TYPE_VALUES, current.linkType),
    country: text(input.country ?? current.country, 2).toUpperCase() || 'US',
    currency: text(input.currency ?? current.currency, 3).toUpperCase() || 'USD',
    entryProxyPoolId: text(input.entryProxyPoolId ?? current.entryProxyPoolId, 64),
    exitProxyPoolId: text(input.exitProxyPoolId ?? current.exitProxyPoolId, 64),
    retryCount: limitedInteger(input.retryCount, current.retryCount, 1, 50),
    usePromo: Boolean(input.usePromo ?? current.usePromo),
    promoCampaign: text(input.promoCampaign ?? current.promoCampaign, 160),
    useSentinel: Boolean(input.useSentinel ?? current.useSentinel),
    workspaceName: text(input.workspaceName ?? current.workspaceName, 80),
    workspaceId: text(input.workspaceId ?? current.workspaceId, 120),
    seatQuantity: limitedInteger(input.seatQuantity, current.seatQuantity, 2, 999),
    priceInterval: enumValue(input.priceInterval, ['month', 'year'], current.priceInterval),
    creditQuantity: limitedInteger(input.creditQuantity, current.creditQuantity, 1, 100000),
    promoCode: text(input.promoCode ?? current.promoCode, 160),
    paypalProxyRouteMode: enumValue(input.paypalProxyRouteMode, ['current', 'promo_approve'], current.paypalProxyRouteMode),
    paypalExtractMode: text(input.paypalExtractMode ?? current.paypalExtractMode, 80) || 'stripe',
    paypalCustomBillingCountry: text(input.paypalCustomBillingCountry ?? current.paypalCustomBillingCountry, 2).toUpperCase() || 'US',
    paypalPromoMode: enumValue(input.paypalPromoMode, ['cycle', 'native_only', 'update_only', 'auto_by_session'], current.paypalPromoMode),
    gcashPromoMode: enumValue(input.gcashPromoMode, ['cycle', 'native_only', 'update_only', 'auto_by_session'], current.gcashPromoMode || DEFAULTS.gcashPromoMode),
    pixAutoKind: enumValue(input.pixAutoKind, ['cpf', 'mixed', 'cnpj'], current.pixAutoKind),
    pixTaxId: text(input.pixTaxId ?? current.pixTaxId, 18).replace(/\D/gu, ''),
    updatedAt: current.updatedAt || null,
  };
  if (Object.prototype.hasOwnProperty.call(input, 'clearInternalKey') && input.clearInternalKey) next.internalKey = '';
  if (Object.prototype.hasOwnProperty.call(input, 'clearPublicCdk') && input.clearPublicCdk) next.publicCdk = '';
  if (enabled && !wasEnabled) next.autoStartedAt = new Date().toISOString();
  else next.autoStartedAt = current.autoStartedAt || null;
  return next;
}

function publicSettings(settings) {
  const { internalKey, publicCdk, autoStartedAt, updatedAt, ...safe } = settings;
  return {
    ...safe,
    internalKeyConfigured: Boolean(internalKey),
    publicCdkConfigured: Boolean(publicCdk),
    publicServiceBaseUrl: PUBLIC_REFINING_BASE_URL,
    gcTacmonServiceBaseUrl: GC_TACMON_BASE_URL,
  };
}

class RefiningSettings {
  constructor({ store }) {
    this.settings = new VersionedSettings({ store, key: 'refining.execution' });
  }

  async initialize(seed = DEFAULTS) {
    await this.settings.initialize(seed);
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    return normalizeSettings(saved, { ...DEFAULTS, ...saved });
  }

  getPublicConfig() {
    return publicSettings(this.getSecretConfig());
  }

  async update(input = {}) {
    const next = normalizeSettings(input, this.getSecretConfig());
    next.updatedAt = new Date().toISOString();
    await this.settings.replace(next);
    return publicSettings(next);
  }
}

module.exports = {
  RefiningSettings,
  DEFAULTS,
  PROVIDER_VALUES,
  PUBLIC_REFINING_BASE_URL,
  GC_TACMON_BASE_URL,
  PLAN_VALUES,
  LINK_TYPE_VALUES,
  TWO_POOL_LINK_TYPES,
  normalizeSettings,
  publicSettings,
};
