'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const publicDir = path.join(__dirname, '..', 'public');

test('frontend keeps refining proxy roles and exposes one payment-method probe pool', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');

  for (const required of [
    'refiningEntryProxyPool', 'refiningExitProxyPool',
    'paymentMethodProbeProxyPool',
    'paymentMethodProbeEnabled',
    'paymentProxyPoolSelect',
  ]) {
    assert.match(html, new RegExp(`id="${required}"`, 'u'));
  }
  for (const removed of [
    'refiningProxyPool',
    'paymentMethodProbeServiceBaseUrl', 'paymentMethodProbeInternalKey',
    'paymentMethodProbeEntryProxyPool', 'paymentMethodProbeExitProxyPool',
    'paymentMethodProbeMode', 'paymentMethodProbeProfiles',
    'paymentMethodProbeConcurrency', 'paymentMethodProbeRetryCount',
    'paymentMethodProbePythonPath', 'paymentMethodProbePay153Root',
    'mailComDomains', 'saveMailComSplit',
    'data-pool="mailbox"',
    'eligibilityProxyPoolSelect', 'refiningGcTacmonSiteProxies',
    'refiningGcTacmonWorkerProxies', 'refiningGcTacmonProxyFields',
    'refiningGcTacmonTurnstileToken',
  ]) {
    assert.doesNotMatch(html, new RegExp(removed, 'u'));
    assert.doesNotMatch(script, new RegExp(removed, 'u'));
  }
  assert.match(script, /proxyPools:\s*state\.selectedProxyPools/u);
  assert.match(script, /state\.selectedProxyPools = \{ \.\.\.state\.selectedProxyPools, \.\.\.saved\.proxyPools \}/u);
  assert.match(script, /createAndStartMailComTask[\s\S]+?await uiPreferenceSaveQueue/u);
  assert.match(script, /entryProxyPoolId|exitProxyPoolId/u);
  assert.doesNotMatch(script, /gcTacmonSiteProxies|gcTacmonWorkerProxies/u);
  assert.match(script, /state\.proxyCatalog\?\.payment/u);
  assert.match(html, /refiningDeleteFailedAccounts/u);
  assert.match(html, /registrationChangeEmailPollIntervalMs/u);
  assert.match(html, /paymentPollIntervalMs/u);
  assert.match(html, /refiningBatchWindowSeconds/u);
  assert.match(script, /无验证码黑名单（连续两个独立任务未收到验证码）/u);
});

test('server resolves task proxy from the category-scoped main pool', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'server.js'), 'utf8');
  assert.match(server, /proxyPoolId:\s*body\.proxyPoolId\s*\|\|\s*body\.proxyPools\?\.main/u);
});
