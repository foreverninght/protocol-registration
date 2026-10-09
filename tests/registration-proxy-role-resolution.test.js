'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('automatic eligibility remains inside the live FreePP registration session', () => {
  const runner = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'registration', 'runner.js'), 'utf8');
  const bridge = fs.readFileSync(path.resolve(__dirname, '..', 'tools', 'freepp_register_bridge.py'), 'utf8');

  assert.match(bridge, /_check_trial_eligibility\(\s*chatgpt_core,\s*_LAST_CHATGPT_SESSION,/u);
  assert.match(bridge, /session=_LAST_CHATGPT_SESSION/u);
  assert.match(runner, /accountsCheckSource:\s*'freepp_live_session'/u);
  assert.doesNotMatch(runner, /freepp_eligibility_check_deferred|post_registration_check_only/u);
  assert.doesNotMatch(runner, /this\.eligibilityChecker/u);
});
