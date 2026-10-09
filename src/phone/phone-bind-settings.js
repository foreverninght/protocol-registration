'use strict';

const { VersionedSettings } = require('../db/versioned-settings');
const SMSBOWER_COUNTRIES = require('./smsbower-countries.json')
  .filter((country) => /^\d+$/u.test(String(country.id)));

const LEGACY_COUNTRY_IDS = Object.freeze({ GB: '16', US: '187', BR: '73', JP: '126', TH: '52', ID: '6', PH: '4', TW: '158', MX: '117', AU: '175', CA: '36', BH: '24' });
const COUNTRY_ID_SET = new Set(SMSBOWER_COUNTRIES.map((country) => String(country.id)));
const TRUST_DEFAULT = 100;
const COUNTRY_FAILURE_PENALTY = 8;
const COUNTRY_SUCCESS_REWARD = 2;
const TIER_FAILURE_PENALTY = 12;
const TIER_SUCCESS_REWARD = 3;

function normalizeCountryIds(value, legacy = 'GB') {
  const source = Array.isArray(value) ? value : String(value || legacy).split(/[\s,;]+/u);
  const normalized = source
    .map((item) => String(item || '').trim().toUpperCase())
    .map((item) => LEGACY_COUNTRY_IDS[item] || item)
    .filter((item) => COUNTRY_ID_SET.has(item));
  return [...new Set(normalized)].length ? [...new Set(normalized)] : ['16'];
}

function normalizeTrustScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : TRUST_DEFAULT;
}

function normalizeTrustMap(value = {}) {
  const result = {};
  for (const [key, entry] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const score = normalizeTrustScore(entry?.score ?? entry);
    result[String(key)] = {
      score,
      successes: Math.max(0, Math.trunc(Number(entry?.successes) || 0)),
      failures: Math.max(0, Math.trunc(Number(entry?.failures) || 0)),
    };
  }
  return result;
}

const DEFAULTS = Object.freeze({
  autoEnabled: true,
  sub2BaseUrl: '',
  sub2AdminApiKey: '',
  sub2ProxyId: '',
  sub2RedirectUri: '',
  smsProvider: 'smsbower',
  smsService: 'dr',
  smsApiKey: '',
  smsCountry: 'GB',
  smsCountries: ['16'],
  smsPriceMin: 0,
  smsPriceMax: 0,
  smsTimeoutSeconds: 180,
  smsMaxAttempts: 12,
  smsPhoneRetryLimit: 2,
  smsPreferGold: true,
  smsTrust: { countries: {}, tiers: {} },
});

class PhoneBindSettings {
  constructor({ store }) {
    this.store = store;
    this.settings = new VersionedSettings({ store, key: 'phone_bind.execution' });
  }

  async initialize(seed = DEFAULTS) {
    await this.settings.initialize(seed);
    return this.getPublicConfig();
  }

  getSecretConfig() {
    const saved = this.settings.get();
    const config = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    config.smsCountries = normalizeCountryIds(
      Array.isArray(saved?.smsCountries) ? saved.smsCountries : saved?.smsCountry,
      config.smsCountry,
    );
    config.smsTrust = {
      countries: normalizeTrustMap(config.smsTrust?.countries),
      tiers: normalizeTrustMap(config.smsTrust?.tiers),
    };
    return config;
  }

  getPublicConfig() {
    const config = this.getSecretConfig();
    return {
      autoEnabled: Boolean(config.autoEnabled),
      sub2BaseUrl: config.sub2BaseUrl,
      sub2ProxyId: config.sub2ProxyId,
      sub2RedirectUri: config.sub2RedirectUri,
      hasAdminApiKey: Boolean(config.sub2AdminApiKey),
      smsProvider: config.smsProvider,
      smsService: config.smsService,
      smsServiceName: 'OpenAI (ChatGPT)',
      smsApiKey: config.smsApiKey ? '已配置' : '',
      smsCountry: config.smsCountry,
      smsCountries: config.smsCountries,
      smsCountryOptions: SMSBOWER_COUNTRIES.map((country) => ({
        ...country,
        trust: config.smsTrust.countries[country.id]?.score ?? TRUST_DEFAULT,
      })),
      smsTierTrust: config.smsTrust.tiers,
      smsTrustPolicy: {
        countryFailurePenalty: COUNTRY_FAILURE_PENALTY,
        countrySuccessReward: COUNTRY_SUCCESS_REWARD,
        tierFailurePenalty: TIER_FAILURE_PENALTY,
        tierSuccessReward: TIER_SUCCESS_REWARD,
        countryWeight: 0.35,
        tierWeight: 0.65,
      },
      smsPriceMin: config.smsPriceMin,
      smsPriceMax: config.smsPriceMax,
      smsTimeoutSeconds: config.smsTimeoutSeconds,
      smsMaxAttempts: config.smsMaxAttempts,
      smsPhoneRetryLimit: config.smsPhoneRetryLimit,
      smsPreferGold: config.smsPreferGold,
    };
  }

  async update(patch = {}, audit = {}) {
    const current = this.getSecretConfig();
    const next = {
      ...current,
      autoEnabled: Boolean(patch.autoEnabled ?? current.autoEnabled),
      sub2BaseUrl: String(patch.sub2BaseUrl ?? current.sub2BaseUrl).trim().replace(/\/+$/u, ''),
      sub2AdminApiKey: patch.sub2AdminApiKey === undefined
        ? current.sub2AdminApiKey
        : String(patch.sub2AdminApiKey || '').trim(),
      sub2ProxyId: String(patch.sub2ProxyId ?? current.sub2ProxyId).trim(),
      sub2RedirectUri: String(patch.sub2RedirectUri ?? current.sub2RedirectUri).trim(),
      smsProvider: 'smsbower',
      smsService: 'dr',
      smsApiKey: patch.smsApiKey === undefined ? current.smsApiKey : String(patch.smsApiKey || '').trim(),
      smsCountry: String(patch.smsCountry ?? current.smsCountry).trim().toUpperCase() || 'GB',
      smsCountries: normalizeCountryIds(patch.smsCountries ?? current.smsCountries, patch.smsCountry ?? current.smsCountry),
      smsPriceMin: Math.max(0, Number(patch.smsPriceMin ?? current.smsPriceMin) || 0),
      smsPriceMax: Math.max(0, Number(patch.smsPriceMax ?? current.smsPriceMax) || 0),
      smsTimeoutSeconds: Math.max(30, Math.min(1800, Number(patch.smsTimeoutSeconds ?? current.smsTimeoutSeconds) || 180)),
      smsMaxAttempts: Math.max(1, Math.min(50, Math.trunc(Number(patch.smsMaxAttempts ?? current.smsMaxAttempts) || 12))),
      smsPhoneRetryLimit: Math.max(0, Math.min(99, Math.trunc(Number(patch.smsPhoneRetryLimit ?? current.smsPhoneRetryLimit) || 0))),
      smsPreferGold: Boolean(patch.smsPreferGold ?? current.smsPreferGold),
      smsTrust: current.smsTrust,
    };
    delete next.autoConcurrency;
    await this.settings.replace(next);
    const auditedFields = [
      'autoEnabled', 'smsCountries', 'smsPriceMin', 'smsPriceMax',
      'smsTimeoutSeconds', 'smsMaxAttempts', 'smsPhoneRetryLimit', 'smsPreferGold',
    ];
    const changes = {};
    for (const field of auditedFields) {
      if (JSON.stringify(current[field]) === JSON.stringify(next[field])) continue;
      changes[field] = { from: current[field], to: next[field] };
    }
    if (Object.keys(changes).length) {
      await this.store.appendEvidence({
        taskId: 'settings:phone_bind',
        type: 'phone_bind.settings_changed',
        payload: {
        source: String(audit.source || 'unknown').slice(0, 80),
        remoteAddress: String(audit.remoteAddress || '').slice(0, 120),
        changes,
        },
      });
    }
    return this.getPublicConfig();
  }

  async recordSmsOutcome({ countryId, price, succeeded }) {
    const current = this.getSecretConfig();
    const id = String(countryId || '').trim();
    const numericPrice = Number(price || 0);
    if (!COUNTRY_ID_SET.has(id) || !(numericPrice > 0)) return current.smsTrust;
    const tierKey = `${id}|${numericPrice.toFixed(8)}`;
    const updateEntry = (map, key, successReward, failurePenalty) => {
      const previous = map[key] || { score: TRUST_DEFAULT, successes: 0, failures: 0 };
      map[key] = {
        score: Math.max(0, Math.min(100, previous.score + (succeeded ? successReward : -failurePenalty))),
        successes: previous.successes + (succeeded ? 1 : 0),
        failures: previous.failures + (succeeded ? 0 : 1),
      };
    };
    updateEntry(current.smsTrust.countries, id, COUNTRY_SUCCESS_REWARD, COUNTRY_FAILURE_PENALTY);
    updateEntry(current.smsTrust.tiers, tierKey, TIER_SUCCESS_REWARD, TIER_FAILURE_PENALTY);
    await this.settings.replace(current);
    return current.smsTrust;
  }
}

module.exports = { PhoneBindSettings, DEFAULT_PHONE_BIND_SETTINGS: DEFAULTS };
