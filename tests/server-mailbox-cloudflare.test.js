'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/app/config');
const { createServerApp } = require('../src/app/server');
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
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(t, env = {}) {
  const config = loadConfig({
    ...env,
    SIGNLIST_CLEAN_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-clean-server-')),
  });
  const jobs = [];
  const registrationStore = {
    recoverExpiredJobs: async () => ({ recovered: 0 }),
    claimNextJob: async () => null,
    claimJob: async () => null,
    createJob: async (input) => {
      const job = { ...input, mailboxSource: 'cloudflare_temp_email', status: 'queued' };
      jobs.push(job);
      return structuredClone(job);
    },
    listJobs: async () => structuredClone(jobs),
    listCandidates: async () => [],
    registrationViews: async () => [],
  };
  const mailboxStore = {
    resetObservedOpenSessions: async () => ({ reset: 0 }),
    getPoolSettings: async () => ({ enabled: false, concurrency: 1, targetCount: 0 }),
    listMailComDomainCatalog: async () => [],
    listEmailInventory: async () => [],
  };
  const accountAssetStore = {
    list: async () => [],
    getByEmail: async () => null,
    updateManyByEmail: async () => [],
  };
  const refiningRuntimeStore = {
    listBatches: async () => [],
    activeBatches: async () => [],
    getPublicState: async () => ({ batches: [], lastError: null }),
    setLastError: async () => {},
  };
  const app = await createServerApp({
    config,
    registrationStore,
    mailboxStore,
    accountAssetStore,
    refiningRuntimeStore,
    runtimeStateStore: new MemoryRuntimeStateStore(),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  return `http://127.0.0.1:${app.address().port}`;
}

test('server saves cloudflare temp email settings without exposing auth and starts generated address task', async (t) => {
  const originalFetch = globalThis.fetch;
  const workerCalls = [];
  globalThis.fetch = async (url, options) => {
    workerCalls.push({ url: String(url), options });
    if (String(url).includes('/open_api/settings')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            domains: ['example.test', 'secondary.example.test'],
            defaultDomains: ['example.test'],
            randomSubdomainDomains: ['example.test'],
          });
        },
      };
    }
    if (String(url).includes('/admin/mails')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ results: [{ address: 'alpha@cesi.example.test' }] });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ address: 'alpha@rnd.example.test' });
      },
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const base = await withServer(t);
  const saved = await requestJson(base, 'PUT', '/api/mailbox/cloudflare-temp-email/config', {
    baseUrl: 'https://mail.example.test/',
    adminAuth: 'worker-password',
    domains: 'example.test',
    usernamePrefix: 'alpha',
    randomSubdomain: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.hasAdminAuth, true);
  assert.equal(saved.body.adminAuth, undefined);

  const config = await requestJson(base, 'GET', '/api/config');
  assert.equal(config.status, 200, JSON.stringify(config.body));
  assert.equal(config.body.mailbox.cloudflareTempEmail.hasAdminAuth, true);
  assert.equal(config.body.mailbox.cloudflareTempEmail.adminAuth, undefined);
  assert.deepEqual(config.body.mailbox.cloudflareTempEmail.domains, ['example.test']);

  const domains = await requestJson(base, 'GET', '/api/mailbox/cloudflare-temp-email/domains');
  assert.equal(domains.status, 200);
  assert.deepEqual(domains.body.domains, ['example.test', 'secondary.example.test']);
  assert.deepEqual(domains.body.defaultDomains, ['example.test']);
  assert.deepEqual(domains.body.randomSubdomainDomains, ['example.test']);
  assert.deepEqual(domains.body.discoveredDomains, []);
  assert.equal(domains.body.scanned, 0);
  assert.equal(workerCalls[0].url, 'https://mail.example.test/open_api/settings');
  assert.equal(workerCalls[0].options.headers['x-admin-auth'], 'worker-password');

  const generated = await requestJson(base, 'POST', '/api/mailbox/cloudflare-temp-email/generate', {
    localPart: 'alpha',
    domain: 'example.test',
    randomSubdomain: true,
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.email, 'alpha@rnd.example.test');
  assert.equal(workerCalls[1].url, 'https://mail.example.test/admin/new_address');
  assert.equal(workerCalls[1].options.headers['x-admin-auth'], 'worker-password');
  assert.deepEqual(JSON.parse(workerCalls[1].options.body), {
    enablePrefix: false,
    enableRandomSubdomain: true,
    name: 'alpha',
    domain: 'example.test',
  });

  const emails = await requestJson(base, 'GET', '/api/emails');
  assert.deepEqual(emails.body.map((entry) => entry.email), []);

  const started = await requestJson(base, 'POST', '/api/tasks/cloudflare-temp-email', {
    localPart: 'beta',
    domain: 'example.test',
    randomSubdomain: false,
    entryBranch: 'freepp',
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.email, 'alpha@rnd.example.test');
  assert.equal(started.body.task.email, 'alpha@rnd.example.test');
  assert.equal(started.body.task.mailboxSource, 'cloudflare_temp_email');
  assert.equal(started.body.task.entryBranch, 'freepp');
  assert.deepEqual(JSON.parse(workerCalls[2].options.body), {
    enablePrefix: false,
    enableRandomSubdomain: true,
    name: 'beta',
    domain: 'example.test',
  });

  const tasks = await requestJson(base, 'GET', '/api/tasks');
  assert.deepEqual(tasks.body.map((task) => task.email), ['alpha@rnd.example.test']);

  const storedEmails = await requestJson(base, 'GET', '/api/emails');
  assert.deepEqual(storedEmails.body, []);
});

test('server returns worker create errors without generic 500', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return 'Failed to create address: Invalid domain';
    },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const base = await withServer(t);
  await requestJson(base, 'PUT', '/api/mailbox/cloudflare-temp-email/config', {
    baseUrl: 'https://mail.example.test/',
    adminAuth: 'worker-password',
    domains: 'example.test',
    randomSubdomain: true,
  });

  const generated = await requestJson(base, 'POST', '/api/tasks/cloudflare-temp-email', {
    localPart: 'alpha',
    domain: 'example.test',
    randomSubdomain: true,
  });

  assert.equal(generated.status, 400);
  assert.equal(generated.body.error, 'MAILBOX_ADDRESS_CREATE_HTTP_ERROR');
  assert.equal(generated.body.workerStatus, 400);
  assert.equal(generated.body.workerBody, 'Failed to create address: Invalid domain');
});
