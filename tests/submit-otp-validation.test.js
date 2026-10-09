'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertOtpValidationSucceeded,
  summarizeOtpValidationResponse,
} = require('../src/registration/steps/submit-otp');

test('OTP validation accepts only successful HTTP responses', () => {
  assert.doesNotThrow(() => assertOtpValidationSucceeded({
    kind: 'otp_validation_response',
    status: 200,
    cloudflareChallenge: false,
  }));
  assert.throws(
    () => assertOtpValidationSucceeded({
      kind: 'otp_validation_response',
      status: 400,
      cloudflareChallenge: false,
    }),
    (error) => error.code === 'OTP_VALIDATION_FAILED' && error.retryableProxy === false,
  );
});

test('OTP validation classifies Cloudflare challenge responses', async () => {
  const summary = await summarizeOtpValidationResponse({
    status: () => 403,
    allHeaders: async () => ({
      'cf-mitigated': 'challenge',
      'content-type': 'text/html; charset=UTF-8',
    }),
  });
  assert.deepEqual(summary, {
    kind: 'otp_validation_response',
    status: 403,
    cloudflareChallenge: true,
    cfMitigated: 'challenge',
    contentType: 'text/html; charset=UTF-8',
  });
  assert.throws(
    () => assertOtpValidationSucceeded(summary),
    (error) => error.code === 'OTP_VALIDATION_CLOUDFLARE_CHALLENGE'
      && error.retryableProxy === true
      && error.details.status === 403,
  );
});
