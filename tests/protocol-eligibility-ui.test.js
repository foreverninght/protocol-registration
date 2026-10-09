'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('function trialEligibilityText(');
const end = source.indexOf('function accountPlanLabel(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const text = context.eligibilityText;

test('checking precedes errors and historical eligibility', () => {
  assert.equal(text({ eligibilityStatus: 'checking', eligibilityError: { code: 'OLD' }, trialEligibility: { status: 'not_eligible' } }), '\u8d44\u683c\uff1a\u68c0\u6d4b\u4e2d');
});
for (const status of ['eligible', 'not_eligible']) {
  test(`persisted error precedes DB-derived historical status: ${status}`, () => {
    const account = { eligibilityStatus: status, eligibilityError: { code: 'NETWORK_PROXY' }, trialEligibility: { status } };
    assert.equal(text(account), `\u8d44\u683c\uff1a\u68c0\u6d4b\u5931\u8d25\uff08\u4e0a\u6b21\uff1a${context.trialEligibilityText(status)}\uff09`);
    account.eligibilityError = null;
    assert.equal(text(account), `\u8d44\u683c\uff1a${context.trialEligibilityText(status)}`);
  });
}
test('failure without history and unchecked states remain distinct', () => {
  assert.equal(text({ eligibilityStatus: 'failed' }), '\u8d44\u683c\uff1a\u68c0\u6d4b\u5931\u8d25');
  assert.equal(text(null), '\u8d44\u683c\uff1a\u672a\u68c0\u6d4b');
  assert.equal(text({ sessionAvailable: true }), '\u8d44\u683c\uff1a\u53ef\u68c0\u6d4b');
});
