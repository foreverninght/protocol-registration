'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForVerificationCodeTwoPhase,
  waitForVerificationCodeWithResends,
} = require('../src/mailbox/mailbox-poller');

test('resend polling includes mail delivered before the resend request returns', async () => {
  let deliveredAt = null;
  let resendBaseline = null;
  const provider = {
    async listMessages({ after }) {
      if (!deliveredAt) return [];
      resendBaseline = after;
      return deliveredAt >= after
        ? [{ id: 'mail-1', receivedAt: new Date(deliveredAt).toISOString(), subject: 'Your temporary ChatGPT verification code', sender: 'noreply@tm.openai.com', text: '123456' }]
        : [];
    },
  };

  const result = await waitForVerificationCodeTwoPhase({
    provider,
    email: 'alias@example.com',
    after: Date.now(),
    phase1TimeoutMs: 1000,
    phase2TimeoutMs: 1000,
    intervalMs: 250,
    async resend() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      deliveredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.code, '123456');
  assert.ok(resendBaseline <= deliveredAt);
});

test('three-attempt polling keeps each resend baseline before the resend action', async () => {
  let resendCount = 0;
  let deliveredAt = null;
  const observedBaselines = [];
  const provider = {
    async listMessages({ after }) {
      observedBaselines.push(after);
      if (!deliveredAt) return [];
      return deliveredAt >= after
        ? [{ id: 'mail-3', receivedAt: new Date(deliveredAt).toISOString(), subject: 'ChatGPT verification code', sender: 'noreply@openai.com', text: '654321' }]
        : [];
    },
  };

  const result = await waitForVerificationCodeWithResends({
    provider,
    email: 'alias@example.com',
    after: Date.now(),
    phase1TimeoutMs: 1000,
    phase2TimeoutMs: 1000,
    intervalMs: 250,
    maxAttempts: 3,
    async resend() {
      resendCount += 1;
      if (resendCount === 2) deliveredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  });

  assert.equal(result.code, '654321');
  assert.equal(resendCount, 2);
  assert.ok(observedBaselines.some((baseline) => baseline <= deliveredAt));
});
