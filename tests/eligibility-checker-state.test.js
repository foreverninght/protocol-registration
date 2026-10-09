'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runAccountStatusCheck,
  runEligibilityCheck,
} = require('../src/eligibility/eligibility-checker');

function accountStoreWithoutSession() {
  const patches = [];
  return {
    patches,
    async getByEmail() {
      return { email: 'missing-session@example.com', session: { cookies: [] } };
    },
    async updateByEmail({ patch }) {
      patches.push(patch);
    },
  };
}

test('eligibility precondition failure persists a failed terminal state', async () => {
  const accountStore = accountStoreWithoutSession();

  await assert.rejects(
    runEligibilityCheck({ accountStore, email: 'missing-session@example.com' }),
    { code: 'ELIGIBILITY_SESSION_MISSING' },
  );

  assert.equal(accountStore.patches.length, 1);
  assert.equal(accountStore.patches[0].eligibilityStatus, 'failed');
  assert.equal(accountStore.patches[0].eligibilityError.code, 'ELIGIBILITY_SESSION_MISSING');
  assert.match(accountStore.patches[0].eligibilityLastCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('account status precondition failure persists a failed terminal state', async () => {
  const accountStore = accountStoreWithoutSession();

  await assert.rejects(
    runAccountStatusCheck({ accountStore, email: 'missing-session@example.com' }),
    { code: 'ACCOUNT_STATUS_SESSION_MISSING' },
  );

  assert.equal(accountStore.patches.length, 1);
  assert.equal(accountStore.patches[0].accountPlanStatus, 'failed');
  assert.equal(accountStore.patches[0].accountPlanError.code, 'ACCOUNT_STATUS_SESSION_MISSING');
  assert.match(accountStore.patches[0].accountPlanLastCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
});
