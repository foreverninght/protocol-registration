'use strict';

const SMSBOWER_API_URL = 'https://smsbower.page/stubs/handler_api.php';
const SMSBOWER_COUNTRIES = require('./smsbower-countries.json')
  .filter((country) => /^\d+$/u.test(String(country.id)));
const COUNTRY_IDS = Object.freeze({
  BR: '73',
  GB: '16',
  US: '187',
  JP: '126',
  TH: '52',
  ID: '6',
  PH: '4',
  TW: '158',
  MX: '117',
  AU: '175',
  CA: '36',
  BH: '24',
});
const COUNTRY_BY_ID = new Map(SMSBOWER_COUNTRIES.map((country) => [String(country.id), country]));
const TRUST_DEFAULT = 100;
const COUNTRY_TRUST_WEIGHT = 0.35;
const TIER_TRUST_WEIGHT = 0.65;

function countrySlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
}

function trustScore(map, key) {
  const value = Number(map?.[key]?.score ?? map?.[key]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : TRUST_DEFAULT;
}

function tierKey(countryId, price) {
  return `${countryId}|${Number(price).toFixed(8)}`;
}

function smsError(message, code = 'SMSBOWER_ERROR', details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function providerError(action, text) {
  const response = String(text || '').trim();
  if (response === 'NO_BALANCE') return smsError('SMSBower 余额不足', 'SMSBOWER_NO_BALANCE');
  if (response === 'NO_NUMBERS') return smsError('SMSBower 当前价格档暂无可用号码', 'SMSBOWER_NO_NUMBERS');
  if (/^BAD_KEY/iu.test(response)) return smsError('SMSBower API Key 无效', 'SMSBOWER_BAD_KEY');
  if (/^BAD_SERVICE/iu.test(response)) return smsError('SMSBower 接码服务代码无效', 'SMSBOWER_BAD_SERVICE');
  if (/^BAD_COUNTRY/iu.test(response)) return smsError('SMSBower 接码国家无效', 'SMSBOWER_BAD_COUNTRY');
  return smsError(`SMSBower ${action}: ${response || '<empty response>'}`);
}

async function smsRequest(apiKey, action, params = {}, timeoutMs = 20000) {
  const url = new URL(SMSBOWER_API_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = String(await response.text() || '').trim();
    if (!response.ok) throw smsError(`SMSBower ${action} HTTP ${response.status}`, 'SMSBOWER_HTTP_ERROR');
    if (/^(?:BAD_|ERROR|NO_BALANCE|NO_NUMBERS)/u.test(text)) throw providerError(action, text);
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') throw smsError(`SMSBower ${action} 请求超时`, 'SMSBOWER_REQUEST_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function smsJson(apiKey, action, params = {}) {
  const text = await smsRequest(apiKey, action, params);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    throw smsError(`SMSBower ${action} 返回了无效 JSON`, 'SMSBOWER_INVALID_RESPONSE', { cause: error });
  }
}

function normalizedConfig(config = {}) {
  const apiKey = String(config.smsApiKey || config.api_key || '').trim();
  if (!apiKey) throw smsError('OpenAI 接码尚未配置 SMSBower API Key', 'SMSBOWER_KEY_MISSING');
  const legacyCountry = String(config.smsCountry || config.country || 'GB').trim().toUpperCase();
  const rawCountries = Array.isArray(config.smsCountries) ? config.smsCountries : [legacyCountry];
  const countryIds = [...new Set(rawCountries
    .map((value) => String(value || '').trim().toUpperCase())
    .map((value) => COUNTRY_IDS[value] || value)
    .filter((value) => COUNTRY_BY_ID.has(value)))];
  if (!countryIds.length) throw smsError('SMSBower 接码至少需要选择一个国家', 'SMSBOWER_BAD_COUNTRY');
  return {
    apiKey,
    service: String(config.smsService || config.service || 'dr').trim() || 'dr',
    countryIds,
    priceMin: Math.max(0, Number(config.smsPriceMin ?? config.price_min) || 0),
    priceMax: Math.max(0, Number(config.smsPriceMax ?? config.price_max) || 0),
    timeoutSeconds: Math.max(30, Math.min(1800, Number(config.smsTimeoutSeconds ?? config.timeout_seconds) || 180)),
    pollAttempts: Math.max(1, Math.min(50, Math.trunc(Number(config.smsMaxAttempts ?? config.max_attempts) || 12))),
    retryLimit: Math.max(0, Math.min(99, Math.trunc(Number(config.smsPhoneRetryLimit ?? config.number_retry_limit) || 0))),
    preferGold: Boolean(config.smsPreferGold ?? config.prefer_gold ?? true),
    trust: config.smsTrust && typeof config.smsTrust === 'object'
      ? config.smsTrust
      : { countries: {}, tiers: {} },
  };
}

async function goldProviderMap(config) {
  const result = new Map();
  if (!config.preferGold) return result;
  try {
    const top = await smsJson(config.apiKey, 'getTopCountriesByService', { service: config.service });
    for (const countryId of config.countryIds) {
      const country = COUNTRY_BY_ID.get(countryId) || {};
      const aliases = new Set([countryId, countrySlug(country.eng), countrySlug(country.name), countrySlug(country.chn)]);
      for (const [countryKey, providers] of Object.entries(top)) {
        if (!aliases.has(countrySlug(countryKey)) && !aliases.has(String(countryKey))) continue;
        result.set(countryId, new Set(Object.keys(providers && typeof providers === 'object' ? providers : {})));
        break;
      }
    }
  } catch {
    // Gold ranking is advisory. Price and availability still work when it is unavailable.
  }
  return result;
}

async function cancelSmsNumber(activation) {
  if (!activation?.activationId || !activation?.apiKey) return;
  try {
    await smsRequest(activation.apiKey, 'setStatus', { id: activation.activationId, status: 8 });
  } catch {
    // The provider may reject early cancellation. It must not hide the original failure.
  }
}

async function completeSmsNumber(activation) {
  if (!activation?.activationId || !activation?.apiKey) return;
  try {
    await smsRequest(activation.apiKey, 'setStatus', { id: activation.activationId, status: 6 });
  } catch {
    // The SMS has already been consumed; provider finalization is best effort.
  }
}

async function reserveSmsNumber(config, { excludedTiers = new Set(), excludedPhones = new Set() } = {}) {
  const normalized = normalizedConfig(config);
  const [prices, goldProviders] = await Promise.all([
    smsJson(normalized.apiKey, 'getPricesV3', { service: normalized.service }),
    goldProviderMap(normalized),
  ]);
  let candidates = normalized.countryIds.flatMap((countryId) => {
    const country = COUNTRY_BY_ID.get(countryId) || { id: countryId, name: countryId, eng: countryId };
    const countryTrust = trustScore(normalized.trust.countries, countryId);
    const nodes = prices?.[countryId]?.[normalized.service] || {};
    return Object.entries(nodes).map(([providerId, value]) => {
      const price = Number(value?.price || 0);
      const priceTrust = trustScore(normalized.trust.tiers, tierKey(countryId, price));
      return {
        countryId,
        countryName: country.name || country.chn || country.eng || countryId,
        providerId: String(providerId),
        price,
        count: Number(value?.count || 0),
        gold: Boolean(goldProviders.get(countryId)?.has(String(providerId))),
        countryTrust,
        priceTrust,
        effectiveTrust: countryTrust * COUNTRY_TRUST_WEIGHT + priceTrust * TIER_TRUST_WEIGHT,
      };
    });
  })
    .filter((candidate) => candidate.count > 0
      && candidate.price >= normalized.priceMin
      && (!normalized.priceMax || candidate.price <= normalized.priceMax));
  if (!candidates.length) {
    throw smsError(
      'SMSBower 所选国家在配置价格区间内没有 OpenAI 号码',
      'SMSBOWER_NO_NUMBERS',
    );
  }
  const untried = candidates.filter((candidate) => !excludedTiers.has(tierKey(candidate.countryId, candidate.price)));
  if (untried.length) candidates = untried;
  candidates.sort((left, right) => right.effectiveTrust - left.effectiveTrust
    || left.price - right.price
    || Number(right.gold) - Number(left.gold)
    || right.count - left.count);

  let lastError = null;
  for (const candidate of candidates) {
    let payload;
    try {
      payload = await smsJson(normalized.apiKey, 'getNumberV2', {
        service: normalized.service,
        country: candidate.countryId,
        providerIds: candidate.providerId,
        minPrice: candidate.price,
        maxPrice: candidate.price,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    const activationId = String(payload.activationId || '').trim();
    const digits = String(payload.phoneNumber || '').replace(/\D/gu, '');
    if (!activationId || !digits) {
      lastError = smsError('SMSBower 返回的号码数据不完整', 'SMSBOWER_INVALID_NUMBER');
      continue;
    }
    const phone = `+${digits}`;
    if (excludedPhones.has(phone)) {
      await cancelSmsNumber({ activationId, apiKey: normalized.apiKey });
      lastError = smsError('SMSBower 返回了本任务已经使用过的号码', 'SMSBOWER_DUPLICATE_NUMBER');
      continue;
    }
    try {
      await smsRequest(normalized.apiKey, 'setStatus', { id: activationId, status: 1 });
    } catch (error) {
      await cancelSmsNumber({ activationId, apiKey: normalized.apiKey });
      lastError = error;
      continue;
    }
    return {
      activationId,
      apiKey: normalized.apiKey,
      phone,
      providerId: String(payload.activationOperator || candidate.providerId),
      price: Number(payload.activationCost || candidate.price),
      requestedPrice: candidate.price,
      country: candidate.countryName,
      countryId: candidate.countryId,
      countryTrust: candidate.countryTrust,
      priceTrust: candidate.priceTrust,
      effectiveTrust: candidate.effectiveTrust,
      service: normalized.service,
      timeoutSeconds: normalized.timeoutSeconds,
      pollAttempts: normalized.pollAttempts,
    };
  }
  throw lastError || smsError('SMSBower 未能取得可用号码', 'SMSBOWER_NO_NUMBERS');
}

async function waitForSmsCode(activation) {
  if (!activation?.activationId || !activation?.apiKey) {
    throw smsError('当前接码任务没有 SMSBower 激活记录', 'SMSBOWER_ACTIVATION_MISSING');
  }
  const deadline = Date.now() + Math.max(30, Number(activation.timeoutSeconds) || 180) * 1000;
  let attempts = Math.max(1, Number(activation.pollAttempts) || 12);
  let lastStatus = '';
  while (Date.now() < deadline && attempts > 0) {
    const status = await smsRequest(activation.apiKey, 'getStatus', { id: activation.activationId });
    lastStatus = status;
    if (status.startsWith('STATUS_OK:')) {
      const code = status.slice('STATUS_OK:'.length).match(/\d{4,8}/u)?.[0] || '';
      if (code) return code;
    }
    if (status === 'STATUS_CANCEL' || status === 'NO_ACTIVATION') break;
    attempts -= 1;
    if (attempts > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, deadline - Date.now())));
    }
  }
  throw smsError(
    `SMSBower 等待 OpenAI 验证码超时${lastStatus ? `（${lastStatus}）` : ''}`,
    'SMSBOWER_OTP_TIMEOUT',
  );
}

class SmsNumberRotation {
  constructor(config = {}, { onOutcome, initialAttempts = 0 } = {}) {
    this.config = { ...config };
    this.onOutcome = typeof onOutcome === 'function' ? onOutcome : null;
    this.activation = null;
    this.attempts = Math.max(0, Math.trunc(Number(initialAttempts) || 0));
    this.failedTiers = new Set();
    this.usedPhones = new Set();
    this.maxNumbers = normalizedConfig(config).retryLimit + 1;
  }

  async next() {
    if (this.activation) {
      const failedPrice = Number(this.activation.requestedPrice || this.activation.price || 0);
      if (failedPrice > 0) this.failedTiers.add(tierKey(this.activation.countryId, failedPrice));
      await this.#recordOutcome(false);
      await cancelSmsNumber(this.activation);
      this.activation = null;
    }
    if (this.attempts >= this.maxNumbers) {
      throw smsError(
        `OpenAI 接码已用完 ${this.maxNumbers - 1} 次换号重试`,
        'SMSBOWER_PHONE_RETRY_LIMIT',
      );
    }
    this.activation = await reserveSmsNumber(this.config, {
      excludedTiers: this.failedTiers,
      excludedPhones: this.usedPhones,
    });
    this.attempts += 1;
    this.usedPhones.add(this.activation.phone);
    return this.activation;
  }

  async waitForCode() {
    return waitForSmsCode(this.activation);
  }

  async cancel() {
    await cancelSmsNumber(this.activation);
    this.activation = null;
  }

  async fail() {
    await this.#recordOutcome(false);
    await cancelSmsNumber(this.activation);
    this.activation = null;
  }

  async complete() {
    await this.#recordOutcome(true);
    await completeSmsNumber(this.activation);
    this.activation = null;
  }

  async #recordOutcome(succeeded) {
    if (!this.activation || !this.onOutcome) return;
    try {
      const trust = await this.onOutcome({
        countryId: this.activation.countryId,
        price: this.activation.requestedPrice || this.activation.price,
        succeeded,
      });
      if (trust && typeof trust === 'object') this.config.smsTrust = trust;
    } catch {
      // Trust learning must never block phone rotation or successful completion.
    }
  }

  publicState() {
    return {
      automatic: true,
      attempt: this.attempts,
      maxNumbers: this.maxNumbers,
      phone: this.activation?.phone || '',
      price: Number(this.activation?.price || 0),
      country: this.activation?.country || '',
      countryId: this.activation?.countryId || '',
      countryTrust: Number(this.activation?.countryTrust ?? TRUST_DEFAULT),
      priceTrust: Number(this.activation?.priceTrust ?? TRUST_DEFAULT),
      effectiveTrust: Number(this.activation?.effectiveTrust ?? TRUST_DEFAULT),
      service: this.activation?.service || '',
    };
  }
}

module.exports = {
  SmsNumberRotation,
  cancelSmsNumber,
  reserveSmsNumber,
  waitForSmsCode,
};
