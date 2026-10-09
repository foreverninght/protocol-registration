'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAllowedOrigins, requestBoundaryError } = require('../src/app/request-boundary');
const { loadConfig } = require('../src/app/config');

function request(headers = {}, localAddress = '127.0.0.1') {
  return { headers: { host: '127.0.0.1:3200', ...headers }, socket: { localAddress } };
}

test('local same-origin and CLI requests pass while foreign origins and hosts fail', () => {
  assert.equal(requestBoundaryError(request()), null);
  assert.equal(requestBoundaryError(request({ origin: 'http://127.0.0.1:3200' })), null);
  for (const headers of [{origin:'https://example.test'}, {origin:'null'}, {host:'example.test'}, {host:'user@127.0.0.1:3200'}, {'sec-fetch-site':'cross-site'}]) {
    assert.equal(requestBoundaryError(request(headers)).status, 403);
  }
  assert.equal(requestBoundaryError(request({host:'[::1]:3200',origin:'http://[::1]:3200'}, '::1')), null);
});

test('reverse proxy origins must be explicit and origin validation fails closed', () => {
  const config = loadConfig({SIGNLIST_ALLOWED_ORIGINS:'https://console.example.test'});
  assert.equal(requestBoundaryError(request({host:'console.example.test', origin:'https://console.example.test'}), config), null);
  assert.equal(requestBoundaryError(request({origin:'https://console.example.test'}), config), null);
  assert.equal(requestBoundaryError(request({host:'console.example.test', origin:'https://other.example.test'}), config).status, 403);
  assert.deepEqual(parseAllowedOrigins('http://localhost:3200/, https://console.example.test'), ['http://localhost:3200','https://console.example.test']);
  for (const value of ['*','https://*.example.test','file:///tmp','https://user:password@example.test','https://example.test/path']) assert.throws(() => parseAllowedOrigins(value));
});
