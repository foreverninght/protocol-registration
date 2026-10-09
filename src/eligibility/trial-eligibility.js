'use strict';

const TRIAL_ELIGIBILITY_STATUS = Object.freeze({
  ELIGIBLE: 'eligible',
  NOT_ELIGIBLE: 'not_eligible',
  UNKNOWN: 'unknown',
});

const PLUS_TRIAL_PROMO_ID = 'plus-1-month-free';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalize(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
}

function unknown(reason, hits = []) {
  return {
    status: TRIAL_ELIGIBILITY_STATUS.UNKNOWN,
    label: '无法确认试用资格',
    reason,
    hits: hits.slice(0, 30),
  };
}

function parseAccountsCheck(input) {
  if (typeof input === 'string') {
    if (!input.trim()) return { reason: 'accounts/check 返回为空' };
    try { return { payload: JSON.parse(input) }; } catch { return { reason: 'accounts/check 返回不是 JSON' }; }
  }
  if (!isRecord(input)) return { reason: 'accounts/check 返回不是对象' };
  return { payload: input };
}

function analyzeTrialEligibility(input) {
  const parsed = parseAccountsCheck(input);
  if (!parsed.payload) return unknown(parsed.reason);
  const payload = parsed.payload;
  if (payload.error || payload.errors || ['error', 'failed', 'failure'].includes(normalize(payload.status))) {
    return unknown('accounts/check 返回错误，不能据此判断资格');
  }
  if (!isRecord(payload.accounts)) return unknown('accounts/check 缺少 accounts 对象');
  const entries = Object.entries(payload.accounts);
  if (!entries.length) return unknown('accounts/check 的 accounts 为空');

  let validAccountCount = 0;
  for (const [accountId, account] of entries) {
    if (!isRecord(account)) {
      continue;
    }
    validAccountCount += 1;
    const accountPath = `accounts.${accountId}`;
    const campaigns = isRecord(account.eligible_promo_campaigns) ? account.eligible_promo_campaigns : {};
    for (const [campaignKey, campaign] of Object.entries(campaigns)) {
      if (!isRecord(campaign)) continue;
      const idField = ['id', 'promo_campaign_id', 'campaign_id']
        .find((field) => String(campaign[field] || '').trim().toLowerCase() === PLUS_TRIAL_PROMO_ID);
      if (idField) {
        return {
          status: TRIAL_ELIGIBILITY_STATUS.ELIGIBLE,
          label: '有 Plus 1 个月免费试用',
          reason: `${accountPath}.eligible_promo_campaigns.${campaignKey}.${idField} = ${PLUS_TRIAL_PROMO_ID}`,
          promoId: PLUS_TRIAL_PROMO_ID,
          hits: [
            { path: `${accountPath}.eligible_promo_campaigns.${campaignKey}.${idField}`, value: PLUS_TRIAL_PROMO_ID },
            ...(campaign.metadata?.plan_name ? [{ path: `${accountPath}.eligible_promo_campaigns.${campaignKey}.metadata.plan_name`, value: campaign.metadata.plan_name }] : []),
            ...(campaign.metadata?.discount?.percentage !== undefined ? [{ path: `${accountPath}.eligible_promo_campaigns.${campaignKey}.metadata.discount.percentage`, value: campaign.metadata.discount.percentage }] : []),
            ...(campaign.metadata?.duration ? [{ path: `${accountPath}.eligible_promo_campaigns.${campaignKey}.metadata.duration`, value: campaign.metadata.duration }] : []),
          ],
        };
      }
    }
  }

  if (!validAccountCount) return unknown('accounts/check 没有可解析的账号对象');
  return {
    status: TRIAL_ELIGIBILITY_STATUS.NOT_ELIGIBLE,
    label: '没有 Plus 1 个月免费试用',
    reason: `accounts/check 未返回 ${PLUS_TRIAL_PROMO_ID} promo`,
    promoId: null,
    hits: [],
  };
}

module.exports = {
  TRIAL_ELIGIBILITY_STATUS,
  PLUS_TRIAL_PROMO_ID,
  analyzeTrialEligibility,
};
