'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { continueUrlFromCreateAccountBody } = require('../src/registration/steps/submit-profile');

test('extracts only the expected ChatGPT OAuth callback URL', () => {
  const callback = 'https://chatgpt.com/api/auth/callback/openai?code=secret&state=state';
  assert.equal(continueUrlFromCreateAccountBody(JSON.stringify({ continue_url: callback })), callback);
  assert.equal(continueUrlFromCreateAccountBody(JSON.stringify({ page: { payload: { url: callback } } })), callback);
  assert.equal(continueUrlFromCreateAccountBody(JSON.stringify({ continue_url: 'https://evil.example/callback' })), null);
  assert.equal(continueUrlFromCreateAccountBody(JSON.stringify({ continue_url: 'https://chatgpt.com/other' })), null);
  assert.equal(continueUrlFromCreateAccountBody('not-json'), null);
});
