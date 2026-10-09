'use strict';

const { randomBytes } = require('node:crypto');

function randomRegistrationPassword() {
  return `R-${randomBytes(10).toString('base64url')}-9a!`;
}

function resolveRegistrationPassword(...values) {
  const configured = values
    .map((value) => String(value || '').trim())
    .find(Boolean);
  return configured || randomRegistrationPassword();
}

module.exports = { randomRegistrationPassword, resolveRegistrationPassword };
