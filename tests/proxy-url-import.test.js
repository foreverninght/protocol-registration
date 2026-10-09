'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProxyLine } = require('../src/proxies/proxy-pools');

test('unauthenticated proxy URLs import and deduplicate against host:port', () => {
  const bare = parseProxyLine('proxy.example.test:3128');
  const url = parseProxyLine('http://proxy.example.test:3128');
  assert.ok(url);
  assert.equal(url.id, bare.id);
  assert.equal(url.host, 'proxy.example.test');
  assert.equal(url.port, 3128);
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.raw, 'http://proxy.example.test:3128');
});

test('proxy URL ports and encoded credentials retain URL semantics', () => {
  assert.equal(parseProxyLine('http://proxy.example.test:80').port, 80);
  assert.equal(parseProxyLine('https://proxy.example.test').port, 443);
  const proxy = parseProxyLine('http://user%40test:p%3Aa%2Fss@proxy.example.test:3128');
  assert.equal(proxy.username, 'user@test');
  assert.equal(proxy.password, 'p:a/ss');
  for (const invalid of ['http://proxy.example.test:0', 'http://proxy.example.test:70000', 'http://']) assert.equal(parseProxyLine(invalid), null);
});
