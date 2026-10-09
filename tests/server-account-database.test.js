'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/app/config');
const serverModule = process.env.SIGNLIST_SERVER_UNDER_TEST
  ? require(path.resolve(process.env.SIGNLIST_SERVER_UNDER_TEST))
  : require('../src/app/server');
const { createServerApp } = serverModule;
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

function requestJson(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(new URL(pathname, baseUrl), {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function publicAccount(account) {
  const { password, session, tokens, totpSecret, ...safe } = account;
  return {
    ...safe,
    hasPassword: Boolean(password),
    sessionAvailable: Boolean(session?.cookies?.length),
    accessTokenAvailable: Boolean(tokens?.accessToken),
    refreshTokenStored: Boolean(tokens?.refreshToken),
  };
}

function injectedStores() {
  let account = {
    id: 'account-1',
    email: 'db-account@example.com',
    loginEmail: 'login@example.com',
    lifecycleStage: 'registered',
    password: 'database-password',
    passwordStatus: 'has_password',
    totpSecret: 'DATABASE-TOTP',
    session: { cookies: [] },
    tokens: { accessToken: 'database-access-token', refreshToken: 'database-refresh-token' },
    eligibilityLastResult: { largeUnusedDiagnostic: 'not-for-summary' },
    trialEligibility: { status: 'eligible', largeUnusedDiagnostic: 'not-for-summary' },
    paymentCapabilities: {
      status: 'done',
      methods: ['gcash'],
      error: null,
      largeUnusedDiagnostic: 'not-for-summary',
    },
    version: 0,
  };
  const accountAssetStore = {
    async getByEmail(email, { includeSecret = false } = {}) {
      if (String(email).toLowerCase() !== account.email) return null;
      return includeSecret ? structuredClone(account) : publicAccount(account);
    },
    async list() {
      return [publicAccount(account)];
    },
    async updateByEmail({ email, patch, expectedVersion = null }) {
      assert.equal(String(email).toLowerCase(), account.email);
      if (expectedVersion !== null && Number(expectedVersion) !== account.version) {
        const error = new Error('account changed after it was read');
        error.code = 'ACCOUNT_VERSION_CONFLICT';
        throw error;
      }
      account = { ...account, ...structuredClone(patch), version: account.version + 1 };
      return publicAccount(account);
    },
    async updateManyByEmail(updates) {
      return Promise.all(updates.map((update) => this.updateByEmail(update)));
    },
  };
  const registrationStore = {
    async recoverExpiredJobs() { return { recovered: 0 }; },
    async claimNextJob() { return null; },
    async listCandidates({ status } = {}) {
      return status === 'ready' ? [{
        id: 'candidate-1',
        accountId: account.id,
        email: account.email,
        mailboxSource: 'mail_com_split',
        status: 'ready',
      }] : [];
    },
    async listJobs() { return []; },
    async registrationViews() { return []; },
  };
  const mailboxStore = {
    async resetObservedOpenSessions() { return { reset: 0 }; },
    async getPoolSettings() { return { enabled: false, concurrency: 1, targetCount: 0 }; },
    async listEmailInventory() {
      return [{
        id: 'alias-1',
        aliasId: 'alias-1',
        accountId: account.id,
        email: account.email,
        mailboxSource: 'mail_com_split',
      }];
    },
  };
  const refiningRuntimeStore = {
    async listBatches() { return []; },
    async activeBatches() { return []; },
    async addBatch(batch) { return batch; },
    async updateBatch() { return null; },
    async setLastError() {},
    async getPublicState() { return { batches: [], lastError: null }; },
  };
  return { accountAssetStore, registrationStore, mailboxStore, refiningRuntimeStore };
}

test('account HTTP APIs use the database asset store without exposing secrets', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-account-db-server-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ SIGNLIST_CLEAN_DATA_DIR: dataDir, SIGNLIST_PORT: '0' });
  const stores = injectedStores();
  const app = await createServerApp({ config, ...stores, runtimeStateStore: new MemoryRuntimeStateStore() });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;

  const list = await requestJson(base, 'GET', '/api/accounts');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].password, undefined);
  assert.equal(list.body[0].totpSecret, undefined);
  assert.equal(list.body[0].tokens, undefined);

  const summary = await requestJson(base, 'GET', '/api/accounts?summary=1&currentEmails=1');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.length, 1);
  assert.equal(summary.body[0].eligibilityLastResult, undefined);
  assert.deepEqual(summary.body[0].trialEligibility, { status: 'eligible' });
  assert.deepEqual(summary.body[0].paymentCapabilities, {
    status: 'done',
    methods: ['gcash'],
    error: null,
  });

  const chunkInfo = await requestJson(base, 'GET', '/api/accounts?a=db-account%40example.com&b=1');
  assert.equal(chunkInfo.status, 200);
  assert.equal(chunkInfo.body.length, Buffer.byteLength('database-access-token'));
  const chunks = [];
  for (let index = 0; index < chunkInfo.body.parts; index += 1) {
    const chunk = await requestJson(base, 'GET', `/api/accounts?a=db-account%40example.com&b=1&c=${index}`);
    assert.equal(chunk.status, 200);
    chunks.push(...chunk.body.data);
  }
  assert.equal(Buffer.from(chunks).toString('utf8'), 'database-access-token');

  const accessToken = await requestJson(base, 'GET', '/api/accounts/db-account%40example.com/access-token');
  assert.equal(accessToken.status, 200);
  assert.equal(accessToken.body.accessToken, 'database-access-token');
  const rt = await requestJson(base, 'GET', '/api/accounts/db-account%40example.com/rt');
  assert.equal(rt.status, 200);
  assert.equal(rt.body.value, 'database-refresh-token');
  const refreshToken = await requestJson(base, 'GET', '/api/accounts/db-account%40example.com/refresh-token');
  assert.equal(refreshToken.status, 200);
  assert.equal(refreshToken.body.refreshToken, 'database-refresh-token');
  const totp = await requestJson(base, 'GET', '/api/accounts/db-account%40example.com/totp-secret');
  assert.equal(totp.status, 200);
  assert.equal(totp.body.totpSecret, 'DATABASE-TOTP');
  const credentials = await requestJson(base, 'GET', '/api/accounts/db-account%40example.com/credential-export');
  assert.equal(credentials.status, 200);
  assert.equal(credentials.body.exportText, 'login@example.com----database-password----DATABASE-TOTP');
  const renewal = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/session-cookie/renew', {});
  assert.equal(renewal.status, 400);
  assert.equal(renewal.body.error, 'ACCESS_TOKEN_SESSION_MISSING');
  const cookieRenewal = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/access-token/refresh', {
    proxyPoolId: 'main-pool',
  });
  assert.equal(cookieRenewal.status, 200);
  assert.equal(cookieRenewal.body.status, 'failed');
  assert.equal(cookieRenewal.body.error.code, 'SESSION_COOKIE_MISSING');
  await stores.accountAssetStore.updateByEmail({
    email: 'db-account@example.com',
    patch: { tokens: {} },
  });
  const tokenRotation = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/refresh-token/refresh', {});
  assert.equal(tokenRotation.status, 409);
  assert.equal(tokenRotation.body.error, 'refresh_token_not_available');

  const statusCheck = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/account-status', {});
  assert.equal(statusCheck.status, 200);
  assert.equal(statusCheck.body.status, 'failed');
  assert.equal(statusCheck.body.error.code, 'ACCOUNT_STATUS_SESSION_MISSING');
  assert.equal(statusCheck.body.account.accountPlanStatus, 'failed');

  const eligibility = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/eligibility', {});
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.body.status, 'failed');
  assert.equal(eligibility.body.error.code, 'TRIAL_ACCOUNT_NOT_READY');
  assert.equal(eligibility.body.account.eligibilityStatus, 'failed');

  const phoneBind = await requestJson(base, 'POST', '/api/accounts/db-account%40example.com/phone-bind', {});
  assert.equal(phoneBind.status, 404);
  assert.equal(phoneBind.body.error, 'feature_disabled');
  const retained = await stores.accountAssetStore.getByEmail('db-account@example.com');
  assert.notEqual(retained.phoneBindStatus, 'failed');
  assert.equal(retained.phoneBindError, undefined);
});
