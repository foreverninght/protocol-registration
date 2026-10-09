'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accountProjection,
  legacyCandidateProjection,
  normalizedTask,
  publicAccountSnapshot,
  streamJsonArray,
} = require('../src/db/legacy-json-migrator');

test('legacy account secrets are split out of the public snapshot', () => {
  const raw = {
    email: ' User@Example.com ',
    password: 'secret',
    totpSecret: 'totp',
    tokens: { accessToken: 'access', refreshToken: 'refresh' },
    oauthSession: { cookies: [{ name: 'session', value: 'cookie' }] },
    status: 'registered',
    paymentCapabilities: { status: 'done', methods: ['card'] },
  };
  assert.deepEqual(Object.keys(publicAccountSnapshot(raw)).sort(), ['email', 'paymentCapabilities', 'status']);
  const account = accountProjection(raw);
  assert.equal(account.email, 'user@example.com');
  assert.equal(account.passwordStatus, 'has_password');
  assert.equal(account.totpStatus, 'enabled');
  assert.equal(account.paymentMethodStatus, 'available');
  assert.equal(account.lifecycleStage, 'registered');
  assert.equal(account.accessToken, 'access');
  assert.equal(account.refreshToken, 'refresh');
  assert.equal(account.cookieStatus, 'available');
  assert.equal('tokens' in account.snapshot, false);
});

test('mail.com business source survives terminal alias release while ownership stays explicit', () => {
  const raw = {
    id: '63f57470-c803-46f7-876f-6035f4ae88b3',
    email: 'alias@example.com',
    password: 'registration-secret',
    mailboxSource: 'mail_com_split',
    status: 'failed',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    events: [{ sequence: 1, type: 'task.created', at: '2026-08-01T00:00:00.000Z' }],
  };
  const unproven = normalizedTask(raw);
  assert.equal(unproven.mailboxSource, 'mail_com_split');
  assert.equal(unproven.originalMailboxSource, 'mail_com_split');
  assert.equal(unproven.mailboxId, null);
  const proven = normalizedTask(raw, { id: 'alias-id', mailbox_id: 'mailbox-id' });
  assert.equal(proven.mailboxSource, 'mail_com_split');
  assert.equal(proven.aliasId, 'alias-id');
  assert.equal(proven.mailboxId, 'mailbox-id');
});

test('legacy email candidates preserve the source and workflow fields used by the old frontend', () => {
  assert.deepEqual(legacyCandidateProjection({
    email: ' Alias@Example.com ',
    mailboxSource: 'mail_com_split',
    status: 'ready',
    mailComStage: 'sold',
    mailComReleaseStatus: 'released',
    mailComReleaseError: null,
    gcashSold: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  }), {
    email: 'alias@example.com',
    mailboxSource: 'mail_com_split',
    mailboxUrl: null,
    status: 'ready',
    mailComStage: 'sold',
    mailComReleaseStatus: 'released',
    mailComReleaseError: null,
    gcashSold: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(legacyCandidateProjection({
    email: 'ic@example.com',
    mailboxUrl: 'https://mail.example.test/share/ic',
  }).mailboxSource, 'share_page');
});

test('active legacy tasks become explicit failed cutover records', () => {
  const task = normalizedTask({
    id: 'daec5f38-483f-4fbf-b37e-50b71b775a2e',
    email: 'active@example.com',
    password: 'secret',
    status: 'running',
    currentStep: 'oauth',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    events: [{ sequence: 1, type: 'task.created', at: '2026-08-01T00:00:00.000Z' }],
  });
  assert.equal(task.status, 'failed');
  assert.equal(task.step, 'interrupted_by_database_cutover');
  assert.equal(task.events.at(-1).error.code, 'LEGACY_TASK_INTERRUPTED_BY_DATABASE_CUTOVER');
  assert.equal(task.events.at(-1).sequence, 2);
});

test('streaming reader handles arrays without loading the whole source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-legacy-stream-'));
  const file = path.join(directory, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
  const values = [];
  for await (const value of streamJsonArray(file)) values.push(value);
  assert.deepEqual(values, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('streaming reader preserves prototype keys without inherited pollution', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-legacy-prototype-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks.json');
  const source = '[{"__proto__":{"polluted":true},"nested":{"__proto__":{"admin":true}},"constructor":{"prototype":{"polluted":true}}}]';
  fs.writeFileSync(file, source);
  const values = [];
  for await (const value of streamJsonArray(file)) values.push(value);
  assert.deepEqual(values, JSON.parse(source));
  assert.equal(Object.getPrototypeOf(values[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(values[0].nested), Object.prototype);
  assert.equal(Object.hasOwn(values[0], '__proto__'), true);
  assert.equal(values[0].polluted, undefined);
  assert.equal(values[0].nested.admin, undefined);
  assert.equal({}.polluted, undefined);
});

test('large JSON migration yields before EOF and processes every record incrementally', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-legacy-large-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks.json');
  const payload = 'x'.repeat(8192);
  const count = 1024;
  const descriptor = fs.openSync(file, 'w');
  try {
    fs.writeSync(descriptor, '[');
    for (let id = 0; id < count; id += 1) {
      fs.writeSync(descriptor, (id ? ',' : '') + JSON.stringify({ id, payload }));
    }
    fs.writeSync(descriptor, ']');
  } finally {
    fs.closeSync(descriptor);
  }
  const createReadStream = fs.createReadStream;
  let source;
  t.mock.method(fs, 'createReadStream', function (name, ...options) {
    const result = createReadStream.call(this, name, ...options);
    if (name === file) source = result;
    return result;
  });
  let seen = 0;
  for await (const value of streamJsonArray(file)) {
    if (seen === 0) assert.ok(source.bytesRead < fs.statSync(file).size);
    assert.equal(value.id, seen);
    assert.equal(value.payload, payload);
    seen += 1;
  }
  assert.equal(seen, count);
  assert.equal(source.destroyed, true);
});

test('stopping migration early closes the source stream', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-legacy-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks.json');
  fs.writeFileSync(file, '[' + '{"id":1},'.repeat(100000) + '{"id":2}]');
  const createReadStream = fs.createReadStream;
  let source;
  let closed;
  t.mock.method(fs, 'createReadStream', function (name, ...options) {
    const result = createReadStream.call(this, name, ...options);
    if (name === file) {
      source = result;
      closed = new Promise((resolve) => result.once('close', resolve));
    }
    return result;
  });
  for await (const value of streamJsonArray(file)) {
    assert.equal(value.id, 1);
    break;
  }
  await closed;
  assert.equal(source.destroyed, true);
  assert.ok(source.bytesRead < fs.statSync(file).size);
});

test('streaming reader propagates malformed JSON and non-array errors', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signlist-legacy-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks.json');
  for (const source of ['[{"id":1},', '{"id":1}']) {
    fs.writeFileSync(file, source);
    await assert.rejects(async () => {
      for await (const value of streamJsonArray(file)) assert.equal(value.id, 1);
    });
  }
});

test('duplicate legacy event sequence fails instead of losing evidence', () => {
  assert.throws(() => normalizedTask({
    id: 'e3ab9d25-1bb0-41ca-a9c1-dd41c5b7928f',
    email: 'duplicate@example.com',
    password: 'secret',
    status: 'failed',
    events: [{ sequence: 1 }, { sequence: 1 }],
  }), { code: 'LEGACY_EVENT_SEQUENCE_DUPLICATE' });
});
