'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { dismissCookieConsent } = require('../src/registration/steps/submit-email');

test('cookie consent uses a visible browser button before page-script fallback', async () => {
  let clicked = false;
  let dialogHiddenWaited = false;
  const hidden = {
    first() { return this; },
    async isVisible() { return false; },
  };
  const reject = {
    first() { return this; },
    async isVisible() { return true; },
    async click() { clicked = true; },
  };
  const dialog = {
    first() { return this; },
    async waitFor(options) {
      assert.equal(options.state, 'hidden');
      dialogHiddenWaited = true;
    },
  };
  const page = {
    getByRole(role, options = {}) {
      if (role === 'dialog') return dialog;
      if (role === 'button' && options.name?.test('Reject non-essential')) return reject;
      return hidden;
    },
    async evaluate() { throw new Error('page-script fallback must not run'); },
    async waitForTimeout() {},
  };

  const result = await dismissCookieConsent(page);

  assert.equal(result.dismissed, true);
  assert.equal(result.mode, 'locator_click');
  assert.equal(clicked, true);
  assert.equal(dialogHiddenWaited, true);
});
