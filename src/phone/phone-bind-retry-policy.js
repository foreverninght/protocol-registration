'use strict';

function messageOf(error) {
  return String(error?.message || error || '');
}

function classifyPhoneBindFailure(error, account = {}) {
  const message = messageOf(error);
  if (account.phoneBindStatus === 'rt_pending' || /RT 获取失败|exchange-code|refresh[_ -]?token/iu.test(message)) return 'rt';
  if (/rate_limit_exceeded|too many phone verification requests/iu.test(message)) return 'rate_limit';
  if (/fraud_guard|suspicious behavior from phone numbers/iu.test(message)) return 'fraud_guard';
  if (/SMSBOWER_OTP_TIMEOUT|等待 OpenAI 验证码超时/iu.test(message)) return 'otp_timeout';
  if (/invalid_phone_number|invalid phone number|phone_number_in_use|phone number already in use|sms_limit_exceeded/iu.test(message)) return 'number';
  if (/invalid_auth_step|invalid authorization step|invalid_state|sign-in session is no longer valid|start over to continue/iu.test(message)) return 'authorization';
  if (/curl:\s*\((?:5|6|7|28|35|52|55|56|60)\)|timed out|connection reset|empty reply|0 bytes received|certificate/iu.test(message)) return 'transport';
  if (/SMSBOWER_PHONE_RETRY_LIMIT|已用完 .*次换号重试/iu.test(message)) return 'retry_exhausted';
  return 'terminal';
}

function phoneBindRetryPlan({ error, account = {}, settings = {}, now = Date.now() }) {
  const kind = classifyPhoneBindFailure(error, account);
  const sameKindCount = account.phoneBindRetryKind === kind
    ? Math.max(0, Number(account.phoneBindRetryCount || 0))
    : 0;
  const retryCount = sameKindCount + 1;
  const phoneAttempt = Math.max(0, Number(account.phoneBindSmsAttempt || 0));
  const maxNumbers = Math.max(1, Math.min(100, Number(settings.smsPhoneRetryLimit || 0) + 1));
  let retry = false;
  let consumesNumber = false;
  let delayMs = 0;

  if (kind === 'rate_limit') {
    retry = retryCount <= 8;
    delayMs = Math.min(15_000 * (2 ** (retryCount - 1)), 120_000);
  } else if (kind === 'fraud_guard') {
    consumesNumber = true;
    retry = phoneAttempt < maxNumbers;
    delayMs = Math.min(2_000 * (2 ** Math.min(retryCount - 1, 3)), 15_000);
  } else if (kind === 'number') {
    consumesNumber = true;
    retry = phoneAttempt < maxNumbers;
    delayMs = 1_000;
  } else if (kind === 'otp_timeout') {
    consumesNumber = true;
    retry = phoneAttempt < maxNumbers;
    delayMs = 2_000;
  } else if (kind === 'authorization' || kind === 'transport') {
    retry = retryCount <= 6;
    delayMs = Math.min(2_000 * (2 ** (retryCount - 1)), 30_000);
  } else if (kind === 'rt') {
    retry = retryCount <= 8;
    delayMs = Math.min(3_000 * (2 ** (retryCount - 1)), 60_000);
  }

  return {
    kind,
    retry,
    retryCount,
    consumesNumber,
    delayMs,
    nextRetryAt: retry ? new Date(now + delayMs).toISOString() : null,
    phoneAttempt,
    maxNumbers,
  };
}

module.exports = { classifyPhoneBindFailure, phoneBindRetryPlan };
