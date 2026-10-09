'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactEventValue } = require('../src/db/registration-store');
const { redactString } = require('../src/utils/redaction');
const { EvidenceStore } = require('../src/collector/storage/evidence-store');
const { RuntimeStateStore } = require('../src/db/runtime-state-store');

const secret = 'synthetic-private-marker';
const otp = '654321';
const logs = [
  '[*] \u6210\u529f\u63d0\u53d6\u9a8c\u8bc1\u7801: ' + otp,
  '[login] \u90ae\u7bb1 OTP \u5df2\u53d6\u5230: ' + otp,
  '[Error] \u9a8c\u8bc1\u7801\u6821\u9a8c\u5931\u8d25: 400 | used_code=' + otp + ' | body=invalid_auth_step',
  '[*] IMAP[fixture] OTP \u547d\u4e2d code=' + otp + ' Date=synthetic',
  'verification code: ' + otp,
];

function assertClean(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(otp), false);
}

test('event redaction covers private nested fields without mutating credential objects', () => {
  const fields = ['accessToken', 'access_token', 'refreshToken', 'refresh_token', 'sessionToken',
    'session_token', 'cookie', 'cookies', 'authorization', 'api_key', 'totpSecret',
    'totpEnrollmentSessionId', 'enrollment_session_id', 'password', 'domainMailboxApiToken'];
  const input = {
    nested: fields.map((key) => ({ [key]: secret })),
    sessionContext: { changedEmailMailbox: { token: secret }, cookie: secret },
    session_context: { changed_email_mailbox: { token: secret } },
    changedEmailMailbox: { email: 'fixture@example.test', token: secret },
    code: 'REGISTRATION_FAILED', status: 400, hasPassword: true, accessTokenAvailable: true,
    attempts: 2, tokenCount: 3, step: 'freepp_log',
  };
  const before = structuredClone(input);
  const output = redactEventValue(input);
  assertClean(output);
  assert.deepEqual(input, before);
  assert.equal(output.code, 'REGISTRATION_FAILED');
  assert.equal(output.status, 400);
  assert.equal(output.hasPassword, true);
  assert.equal(output.accessTokenAvailable, true);
  assert.equal(output.tokenCount, 3);
  assert.equal(output.changedEmailMailbox.email, 'fixture@example.test');
});

test('core OTP log variants retain errors and status while removing OTPs', () => {
  for (const message of logs) assertClean(redactEventValue({ message }));
  const failure = redactString(logs[2]);
  assert.match(failure, /400/);
  assert.match(failure, /invalid_auth_step/);
  assert.equal(redactString('status=200 attempts=12 no OTP received'), 'status=200 attempts=12 no OTP received');
});

test('text diagnostics redact embedded JSON, bearer, URL and snake/camel assignments', () => {
  for (const text of [
    JSON.stringify({ nested: { access_token: secret }, status: 200 }),
    'body=' + JSON.stringify({ nested: { accessToken: secret }, status: 400 }),
    'Authorization: Bearer ' + secret,
    'Cookie: first=' + secret + '; second=' + secret + '\nstatus=400',
    'Set-Cookie: fixture=' + secret + '; HttpOnly',
    'https://fixture.invalid/callback?code=' + secret + '&state=diagnostic',
    'https://fixture:' + secret + '@fixture.invalid/path',
    'access_token=' + secret + ' status=400',
    'totpEnrollmentSessionId="' + secret + '" status=400',
    'used_code=' + otp + ' status=400',
  ]) assertClean(redactString(text));
});

test('EvidenceStore sanitizes actual SQL bindings and text artifacts on disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-redaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bindings = [];
  const query = async (sql, parameters = []) => {
    bindings.push(parameters);
    return { rows: [{ sequence: 1, created_at: '2026-01-01T00:00:00Z' }] };
  };
  const runtime = new RuntimeStateStore({ pool: {
    query, connect: async () => ({ query, release() {} }),
  } });
  const store = new EvidenceStore({ dataDir: dir, taskId: 'synthetic-task', store: runtime });
  const payload = {
    message: logs.join('\n'), nested: { session_context: { token: secret } }, status: 400,
  };
  const recorded = await store.record({ type: 'registration.freepp_log', payload });
  assertClean(recorded);
  assert.equal(recorded.payload.status, 400);
  assert.equal(payload.nested.session_context.token, secret);
  for (const [name, value] of [
    ['diagnostic.json', JSON.stringify(payload)],
    ['diagnostic.log', logs.join('\n') + '\naccess_token=' + secret],
    ['diagnostic-buffer.txt', Buffer.from('password=' + secret)],
  ]) {
    const artifact = await store.writeArtifact(name, value);
    const bytes = fs.readFileSync(artifact.path);
    assertClean(bytes.toString('utf8'));
    assert.equal(artifact.bytes, bytes.length);
    assert.equal(artifact.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  assertClean(bindings);
  assert.equal(bindings.some((parameters) => parameters.some((value) => typeof value === 'string' && value.includes('registration.freepp_log'))), true);
});

test('EvidenceStore preserves non-text binary artifacts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-binary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EvidenceStore({ dataDir: dir, taskId: 'synthetic-task', store: { async recordEvidenceArtifact() {} } });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const artifact = await store.writeArtifact('synthetic.png', bytes);
  assert.deepEqual(fs.readFileSync(artifact.path), bytes);
});
