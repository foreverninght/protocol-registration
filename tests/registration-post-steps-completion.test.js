'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RegistrationRunner,
  assertConfiguredRegistrationCompletion,
} = require('../src/registration/runner');

test('configured post-registration gates only enforce checked optional steps', () => {
  assert.deepEqual(assertConfiguredRegistrationCompletion({
    registrationExtras: { setupPassword: false, setupTotp2fa: false },
    freeppResult: { passwordStatus: 'no_password' },
    trialEligibility: { status: 'unknown' },
  }), { ok: true, missing: [] });
});

test('configured password and 2FA steps still block completion when enabled', () => {
  assert.throws(
    () => assertConfiguredRegistrationCompletion({
      registrationExtras: { setupPassword: true, setupTotp2fa: true },
      freeppResult: { passwordStatus: 'no_password' },
    }),
    (error) => error.code === 'REGISTRATION_POST_STEPS_INCOMPLETE'
      && error.details.missing.some((item) => item.label === 'password')
      && error.details.missing.some((item) => item.label === '2fa'),
  );
});

function classificationRunner(account) {
  let transition = null;
  return {
    runner: new RegistrationRunner({
      config: {},
      registrationStore: {},
      accountAssetStore: {
        async getByJob() { return account; },
        async transitionMailComWorkflow(input) {
          transition = input;
          return input;
        },
      },
      mailboxStore: {},
      proxyPools: {},
      runtimeStateStore: {},
    }),
    transition: () => transition,
  };
}

test('mail.com completed registration without eligible trial goes to eligibility branch', async () => {
  const { runner, transition } = classificationRunner({
    email: 'needs-eligibility@example.com',
    trialEligibility: { status: 'not_eligible' },
    paymentCapabilities: { status: 'done', methods: ['hosted'] },
  });

  await runner.transitionTerminalMailComWorkflow({
    id: 'job-1',
    email: 'needs-eligibility@example.com',
    mailboxSource: 'mail_com_split',
  }, { release: { action: 'released' } });

  assert.equal(transition().stage, 'eligibility');
});

test('mail.com eligible registration without successful payment probe goes to payment-method review', async () => {
  const { runner, transition } = classificationRunner({
    email: 'needs-payment@example.com',
    trialEligibility: { status: 'eligible' },
    paymentCapabilities: { status: 'failed', methods: [] },
  });

  await runner.transitionTerminalMailComWorkflow({
    id: 'job-2',
    email: 'needs-payment@example.com',
    mailboxSource: 'mail_com_split',
  }, { release: { action: 'released' } });

  assert.equal(transition().stage, 'payment_method');
});

test('mail.com eligible registration cannot skip the dedicated payment probe stage', async () => {
  const { runner, transition } = classificationRunner({
    email: 'ready@example.com',
    trialEligibility: { status: 'eligible' },
    paymentCapabilities: { status: 'done', methods: ['hosted'], checkoutType: 'cslive' },
  });

  await runner.transitionTerminalMailComWorkflow({
    id: 'job-3',
    email: 'ready@example.com',
    mailboxSource: 'mail_com_split',
  }, { release: { action: 'released' } });

  assert.equal(transition().stage, 'payment_method');
});
