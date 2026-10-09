'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  terminalFailureCodeFromText,
  terminalFailureRetryableProxy,
  freeppConfigForBranch,
} = require('../src/registration/freepp-sidecar-runner');

test('the deployed FreePP bridge exists at the runtime path', () => {
  const bridge = path.resolve(__dirname, '..', 'tools', 'freepp_register_bridge.py');
  assert.equal(fs.existsSync(bridge), true, `missing runtime bridge: ${bridge}`);
});

test('freepp terminal failures are recovered from sidecar log text', () => {
  assert.equal(
    terminalFailureCodeFromText("RuntimeError('MAILBOX_CODE_TIMEOUT: no verification code mail arrived')"),
    'MAILBOX_CODE_TIMEOUT',
  );
  assert.equal(
    terminalFailureCodeFromText('FREEPP_OAUTH_COOKIE_MISSING: oauth cookie was not retained'),
    'FREEPP_OAUTH_COOKIE_MISSING',
  );
  assert.equal(
    terminalFailureCodeFromText('code=user_already_exists msg=An account already exists for this email address.'),
    'FREEPP_EMAIL_ALREADY_REGISTERED',
  );
  assert.equal(
    terminalFailureCodeFromText('RuntimeError: freepp returned no result'),
    '',
  );
});

test('an account-specific FreePP failure does not reject or rotate the proxy', () => {
  assert.equal(terminalFailureRetryableProxy('FREEPP_EMAIL_ALREADY_REGISTERED'), false);
  assert.equal(terminalFailureRetryableProxy('MAILBOX_CODE_TIMEOUT'), false);
  assert.equal(terminalFailureRetryableProxy('FREEPP_OAUTH_COOKIE_MISSING'), false);
  assert.equal(terminalFailureRetryableProxy('FREEPP_EGRESS_CHANGED'), true);
  assert.equal(terminalFailureRetryableProxy('FREEPP_SIDECAR_IDLE_TIMEOUT'), true);
  assert.equal(terminalFailureRetryableProxy('FREEPP_REGISTRATION_FAILED'), true);
});

test('removed branches never fall back to the FreePP backend', () => {
  const config = {
    registration: {
      freepp: { backendDir: '/opt/freepp/backend', sentinelMode: 'pure' },
      freeppHar: { backendDir: '/opt/freepp-har/backend', sentinelMode: 'pure' },
    },
  };
  assert.equal(freeppConfigForBranch(config, 'freepp').backendDir, '/opt/freepp/backend');
  for (const branch of ['freepp_har', 'freepp-har', 'har', '302', 'unknown']) {
    assert.throws(() => freeppConfigForBranch(config, branch), { code: 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED' });
  }
});
