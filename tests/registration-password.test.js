'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  randomRegistrationPassword,
  resolveRegistrationPassword,
} = require('../src/registration/registration-password');

test('registration password generation preserves the established task format', () => {
  const values = new Set(Array.from({ length: 100 }, () => randomRegistrationPassword()));
  assert.equal(values.size, 100);
  for (const value of values) assert.match(value, /^R-[A-Za-z0-9_-]{14}-9a!$/);
});

test('registration password resolution respects explicit configuration before generating', () => {
  assert.equal(resolveRegistrationPassword(' task-secret ', 'default-secret'), 'task-secret');
  assert.equal(resolveRegistrationPassword('', ' default-secret '), 'default-secret');
  assert.match(resolveRegistrationPassword('', ''), /^R-[A-Za-z0-9_-]{14}-9a!$/);
});
