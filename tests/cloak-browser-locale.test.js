'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCloakLaunchOptions,
  localeForProxy,
} = require('../src/browser/lifecycle/fingerprint-browser');

test('Cloak derives locale and Accept-Language from the registration proxy', () => {
  const config = {
    browser: {
      headless: 'virtual',
      geoip: true,
      locale: '',
      cloakReleaseChannel: 'stable',
      cloakVersion: '146.0.7680.177',
    },
  };
  const options = buildCloakLaunchOptions({
    config,
    proxy: { host: 'proxy.example', port: 1000, country: 'GB' },
    display: ':99',
  });

  assert.equal(localeForProxy({ country: 'GB' }), 'en-GB');
  assert.equal(options.locale, 'en-GB');
  assert.equal(options.extraHTTPHeaders['accept-language'], 'en-GB,en;q=0.9');
});
