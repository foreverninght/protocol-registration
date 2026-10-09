'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { registrationApiAllowed, assertRegistrationBranch, registrationCatalog } = require('../src/app/registration-profile');
const { publicExecutionCatalog } = require('../src/registration/execution-catalog');
const { loadConfig } = require('../src/app/config');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

const profile = { profile: 'registration-only' };

test('registration profile permits automation and credentials but closes independent business APIs', () => {
  for (const [method, route] of [
    ['POST', '/api/tasks'], ['POST', '/api/tasks/cloudflare-temp-email'],
    ['POST', '/api/emails/import'], ['POST', '/api/tasks/abcd-1234/retry'],
    ['PUT', '/api/registration/autostart/config'], ['POST', '/api/registration/autostart/start'],
    ['PUT', '/api/registration/change-email/settings'], ['PUT', '/api/phone-bind/settings'],
    ['POST', '/api/mailbox/mail-com-split/accounts/main/aliases/user/code'],
    ['GET', '/api/accounts/user/credential-export'], ['POST', '/api/accounts/user/credential-repair'],
    ['POST', '/api/accounts/user/eligibility'], ['POST', '/api/proxies/main'],
    ['POST', '/api/accounts/user/refresh-token/refresh'],
    ['GET', '/api/accounts/user/access-token/live-check'], ['POST', '/api/accounts/user/access-token/live-check'],
    ['GET', '/api/live-check/user'], ['POST', '/api/live-check/user'],
    ['GET', '/api/proxies/eligibility'], ['POST', '/api/proxies/eligibility'],
    ['POST', '/api/proxy-pools/eligibility'], ['DELETE', '/api/proxy-pools/eligibility/pool-id'],
    ['GET', '/api/proxy-pools/eligibility/pool-id/proxies'], ['POST', '/api/proxy-pools/eligibility/pool-id/proxies'],
  ]) assert.equal(registrationApiAllowed(method, route), true, method + ' ' + route);
  for (const route of [
    '/api/payment/settings', '/api/payment-method-probe', '/api/refining/enqueue-current',
    '/api/accounts/user/payment/start', '/api/accounts/user/payment-methods/probe',
    '/api/accounts/user/phone-bind', '/api/accounts/user/phone-bind/auto-retry',
    '/api/accounts/user/gcash/refresh', '/api/emails/user/mail-com-stage',
    '/api/proxies/payment', '/api/proxy-pools/checkout', '/api/new-business-endpoint',
    '/api/proxy-pools/payment/pool-id/proxies', '/api/proxy-pools/checkout/pool-id/proxies',
  ]) for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.equal(registrationApiAllowed(method, route), false, method + ' ' + route);
  }
  assert.equal(registrationApiAllowed('POST', '/api/accounts/user/credential-export'), false);
});

test('protocol catalog and branch validation exclude browser and hybrid execution', () => {
  const catalog = registrationCatalog(publicExecutionCatalog());
  assert.deepEqual(catalog.types.map((entry) => entry.key), ['protocol']);
  assert.deepEqual(catalog.implementations.map((entry) => entry.key), ['freepp']);
  assert.deepEqual(catalog.fingerprintBrowsers, []);
  for (const branch of ['freepp']) assert.equal(assertRegistrationBranch(profile, branch), branch);
  for (const branch of ['freepp_har', 'freepp-har', 'har', '302', 'flowpilot', 'context_protocol', '', undefined]) {
    assert.throws(() => assertRegistrationBranch(profile, branch), { code: 'REGISTRATION_IMPLEMENTATION_DISABLED' });
  }
});

function request(server, method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname,
      headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

test('profile startup never constructs non-registration coordinators and keeps registration scheduling', async (t) => {
  const sourcePath = path.resolve(__dirname, '../src/app/server.js');
  const originalRequire = createRequire(sourcePath);
  const forbiddenModules = {
    '../payment/payment-coordinator': 'PaymentCoordinator',
    '../payment/payment-method-probe-coordinator': 'PaymentMethodProbeCoordinator',
    '../refining/coordinator': 'RefiningCoordinator',
    '../refining/runtime-store': 'RefiningRuntimeStore',
    '../phone/automatic-phone-bind-queue': 'AutomaticPhoneBindQueue',
  };
  const intervals = [];
  let externalRequests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    externalRequests += 1;
    throw new Error('unexpected external request');
  });
  let rotations = 0;
  let rejectRotation = false;
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, __dirname: path.dirname(sourcePath), __filename: sourcePath,
    process, console, Buffer, URL, AbortController, setTimeout, clearTimeout, setImmediate,
    setInterval: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval() {},
    require: (name) => {
      if (name === '../session/refresh-token-rotation') return { rotateOpenAiRefreshToken: async () => {
        rotations += 1;
        if (rejectRotation) throw Object.assign(new Error('fixture reused token'), { code: 'REFRESH_TOKEN_REUSED' });
        return { accessToken: 'new-access', refreshToken: 'new-refresh', rotatedAt: new Date().toISOString() };
      } };
      if (name === '../phone/openai-phone-bind') return { ...originalRequire(name),
        reauthorizePhoneBindRefreshToken: async () => { throw new Error('unexpected independent phone authorization'); },
      };
      return forbiddenModules[name]
        ? { [forbiddenModules[name]]: class { constructor() { throw new Error('disabled constructor: ' + name); } } }
        : originalRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const runtimeStateStore = new MemoryRuntimeStateStore();
  for (const key of ['payment.execution', 'payment.method_probe', 'refining.execution']) {
    await runtimeStateStore.initializeSetting(key, { enabled: true });
  }
  await runtimeStateStore.initializeSetting('phone_bind.execution', { autoEnabled: true, smsApiKey: 'fixture' });
  await runtimeStateStore.initializeSetting('registration.change_email', {
    setupPassword: true, setupTotp2fa: true, validateOauthSession: true,
    autoCheckEligibility: true, phoneBindProbeEnabled: true, enabled: true,
  });
  await runtimeStateStore.initializeSetting('ui.preferences', { entryBranch: 'freepp_har', executionType: 'protocol' });
  let claims = 0;
  let recoveries = 0;
  const registrationStore = {
    recoverExpiredJobs: async () => { recoveries += 1; return []; },
    listCandidates: async () => [],
    claimNextJob: async () => { claims += 1; return null; },
    countActiveJobs: async () => 0,
  };
  const mailboxStore = {
    resetObservedOpenSessions: async () => {},
    getPoolSettings: async () => ({ enabled: false, concurrency: 4, targetCount: 0 }),
    listMailComDomainCatalog: async () => [],
  };
  let account = { email: 'fixture@example.com', version: 1, tokens: { refreshToken: 'original-refresh' }, refreshTokenStatus: 'active' };
  const accountAssetStore = {
    getByEmail: async () => structuredClone(account),
    updateByEmail: async ({ patch }) => { account = { ...account, ...patch }; return structuredClone(account); },
    pool: { query: async (sql) => {
      assert.match(sql, /from registration_jobs/);
      assert.doesNotMatch(sql, /from accounts/);
      return { rows: [{ registration_queued: 8 }] };
    } },
    list: async () => { throw new Error('disabled business inventory scan'); },
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-profile-'));
  const config = { ...loadConfig({ REGISTRATION_ENTRY_BRANCH: 'freepp' }), ...profile, dataDir };
  const app = await module.exports.createServerApp({ config, registrationStore, mailboxStore, accountAssetStore, runtimeStateStore });
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  await new Promise(setImmediate);
  assert.ok(recoveries > 0);
  assert.ok(claims > 0);
  assert.deepEqual(intervals.map((timer) => timer.delay), [2000]);
  intervals[0].callback();
  await new Promise(setImmediate);
  const view = await request(app, 'GET', '/api/config');
  assert.equal(view.status, 200);
  for (const headers of [
    { origin: 'https://attacker.example.test', 'content-type': 'text/plain' },
    { host: 'attacker.example.test', origin: 'http://attacker.example.test' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const injected = await request(app, 'POST', '/api/proxy-pools/main', { name: 'cross-origin-injection' }, headers);
    assert.equal(injected.status, 403);
  }
  const stoppedByOtherSite = await request(app, 'POST', '/api/registration/autostart/stop', null, {
    origin: 'https://attacker.example.test', 'content-type': 'application/x-www-form-urlencoded',
  });
  assert.equal(stoppedByOtherSite.status, 403);
  const afterBlocked = await request(app, 'GET', '/api/proxy-pools');
  assert.ok(!afterBlocked.body.main.some(pool => pool.name === 'cross-origin-injection'));
  assert.equal(view.body.capabilities.payment, false);
  assert.equal(view.body.capabilities.phoneBind, false);
  assert.deepEqual(view.body.proxyPools, ['main', 'eligibility']);
  assert.equal(view.body.preferences.entryBranch, 'freepp');
  assert.equal(view.body.registration.autoStart.runtime.dbQueuePolling, true);
  assert.equal(view.body.pipelineConcurrency.stages.registration.concurrency, 4);
  for (const stage of ['paymentMethod', 'refining', 'finalPayment', 'phoneBind']) {
    assert.equal(view.body.pipelineConcurrency.stages[stage].concurrency, 0);
  }
  for (const field of ['setupPassword', 'setupTotp2fa', 'validateOauthSession', 'autoCheckEligibility', 'phoneBindProbeEnabled', 'enabled']) {
    assert.equal(view.body.registration.changeEmail[field], true, field);
  }
  assert.equal((await request(app, 'GET', '/api/refining')).status, 404);
  assert.equal((await request(app, 'POST', '/api/accounts/user/phone-bind')).status, 404);
  assert.equal((await request(app, 'POST', '/API/accounts/user/payment/start')).status, 404);
  assert.equal((await request(app, 'PUT', '/api/preferences', { entryBranch: 'flowpilot', executionType: 'browser' })).status, 400);
  assert.equal((await request(app, 'POST', '/api/tasks', { email: 'fixture@example.com', entryBranch: 'flowpilot' })).status, 400);
  for (const entryBranch of ['freepp_har', 'freepp-har', 'freepphar', 'har', '302']) {
    for (const route of ['/api/tasks', '/api/tasks/cloudflare-temp-email', '/api/tasks/mail-com-split', '/api/tasks/abcd-1234/retry']) {
      const result = await request(app, 'POST', route, { email: 'fixture@example.com', entryBranch });
      assert.equal(result.status, 400, route + ' ' + entryBranch);
      assert.equal(result.body.error, 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED');
    }
  }
  assert.equal((await request(app, 'PUT', '/api/phone-bind/settings', { autoEnabled: true })).status, 200);
  const rotated = await request(app, 'POST', '/api/accounts/fixture/refresh-token/refresh');
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.method, 'refresh_token_rotation');
  assert.equal(account.tokens.refreshToken, 'new-refresh');
  rejectRotation = true;
  const blockedRecovery = await request(app, 'POST', '/api/accounts/fixture/refresh-token/refresh');
  assert.equal(blockedRecovery.status, 409);
  assert.equal(blockedRecovery.body.error, 'REFRESH_TOKEN_REAUTHORIZATION_DISABLED');
  assert.equal(rotations, 2);
  const createdPool = await request(app, 'POST', '/api/proxy-pools/eligibility', { name: 'review-proxy' });
  assert.equal(createdPool.status, 200);
  const pools = await request(app, 'GET', '/api/proxy-pools');
  assert.deepEqual(Object.keys(pools.body).sort(), ['eligibility', 'main']);
  const eligibilityPool = pools.body.eligibility.find((pool) => pool.name === 'review-proxy');
  assert.ok(eligibilityPool);
  assert.equal((await request(app, 'GET', '/api/proxy-pools/eligibility/' + eligibilityPool.id + '/proxies')).status, 200);
  assert.equal((await request(app, 'PUT', '/api/preferences', { proxyPools: { eligibility: eligibilityPool.id } })).status, 200);
  const preferences = await request(app, 'GET', '/api/config');
  assert.equal(preferences.body.preferences.proxyPools.eligibility, eligibilityPool.id);
  assert.equal((await request(app, 'GET', '/api/accounts/fixture/access-token/live-check')).status, 200);
  assert.equal((await request(app, 'GET', '/api/live-check/fixture')).status, 200);
  assert.equal((await request(app, 'POST', '/api/proxy-pools/payment', { name: 'disabled' })).status, 404);
  assert.equal((await request(app, 'DELETE', '/api/proxy-pools/eligibility/' + eligibilityPool.id)).status, 200);
  assert.equal(externalRequests, 0);
});
