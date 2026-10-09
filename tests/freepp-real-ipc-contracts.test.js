'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const originalSpawn = cp.spawn;
const children = [];
const spawnArguments = [];
cp.spawn = (python, args, options) => {
  spawnArguments.push([...args]);
  assert.deepEqual(args, [path.join(root, 'tools', 'freepp_register_bridge.py'), '--config-stdin']);
  const child = originalSpawn(python, ['-B', '-u', path.join(__dirname, 'test_freepp_bridge_contracts.py'),
    '--ipc', ...args.slice(1)], { ...options, cwd: root });
  children.push(child);
  return child;
};
const { runFreeppBridge, runFreeppRegistration, runFreeppCredentialRepair, credentialRepairForBridge } = require('../src/registration/freepp-sidecar-runner');
test.after(() => { cp.spawn = originalSpawn; for (const child of children) if (child.exitCode === null) child.kill(); });

function options(mode, extras = {}) {
  return {
    config: { registration: { freepp: { python: process.env.PYTHON || 'python', timeoutMs: 10000 } },
      mailbox: { pollTimeoutMs: 1000, pollIntervalMs: 250 } },
    task: { email: 'offline@example.test', registrationPassword: ' FixturePassword1! ' },
    proxy: { host: 'fixture.invalid', port: 1 },
    mailboxSource: mode,
    mailboxProvider: { async listMessages() { return []; } },
    update() {},
    ...extras,
  };
}
function mail(code, email = 'offline@example.test') {
  return { id: 'mail-' + email, subject: 'Your OpenAI code is ' + code, text: 'Your verification code is ' + code,
    sender: 'noreply@openai.com', receivedAt: Date.now() };
}

test('real IPC returns automatic OTP and exact password', async () => {
  const events = [];
  const result = await runFreeppBridge(options('otp', {
    mailboxProvider: { async listMessages() { return [mail('123456')]; } }, update: e => events.push(e),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.password, ' FixturePassword1! ');
  assert.equal(events.find(e => e.step === 'fixture_code_received').result.code, '123456');
});

test('real core resends after first IPC timeout and accepts second-phase OTP', async () => {
  let resent = false;
  const result = await runFreeppBridge(options('two_phase', {
    mailboxProvider: { async listMessages() { return resent ? [mail('234567')] : []; } },
    update(e) { if (e.step === 'fixture_resend') resent = true; },
  }));
  assert.equal(resent, true);
  assert.equal(result.ok, true);
});

test('final two-phase timeout remains a terminal mailbox timeout', async () => {
  let resends = 0;
  await assert.rejects(runFreeppBridge(options('final_timeout', {
    update(e) { if (e.step === 'fixture_resend') resends++; },
  })), { code: 'MAILBOX_CODE_TIMEOUT' });
  assert.equal(resends, 1);
});

test('single-phase registration timeout stays terminal', async () => {
  await assert.rejects(runFreeppBridge(options('otp')), { code: 'MAILBOX_CODE_TIMEOUT' });
});

test('provider errors never become retryable OTP absence', async () => {
  let resends = 0;
  await assert.rejects(runFreeppBridge(options('provider_error', {
    mailboxProvider: { async listMessages() { throw Object.assign(new Error('fixture failure'), { code: 'MAILBOX_PROVIDER_ERROR' }); } },
    update(e) { if (e.step === 'fixture_resend') resends++; },
  })), { code: 'MAILBOX_PROVIDER_ERROR' });
  assert.equal(resends, 0);
});

test('abort cancels in-flight mailbox requests and emits nothing after settlement', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('fixture lease lost'), { code: 'FIXTURE_LEASE_LOST' });
  let requestSignal;
  let events = 0;
  const pending = runFreeppBridge(options('wait', {
    signal: controller.signal,
    mailboxProvider: { listMessages({ signal }) {
      requestSignal = signal;
      setTimeout(() => controller.abort(reason), 20);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    update() { events++; },
  }));
  await assert.rejects(pending, error => error === reason);
  assert.equal(requestSignal.aborted, true);
  const settledEvents = events;
  await sleep(300);
  assert.equal(events, settledEvents);
});

test('timeout stops mailbox polling and late updates', async () => {
  let calls = 0;
  let events = 0;
  const opts = options('wait', {
    mailboxProvider: { async listMessages() { calls++; return []; } }, update() { events++; },
  });
  opts.config.registration.freepp.timeoutMs = 2500;
  await assert.rejects(runFreeppBridge(opts), { code: 'FREEPP_SIDECAR_TIMEOUT' });
  assert.ok(calls > 0);
  const settled = { calls, events };
  await sleep(1100);
  assert.deepEqual({ calls, events }, settled);
});

test('pre-aborted registration does not spawn Python', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fixture stopped'));
  const before = children.length;
  const opts = options('otp', { signal: controller.signal });
  await assert.rejects(runFreeppRegistration({ ...opts, mailbox: { provider: opts.mailboxProvider, source: 'otp' } }), /fixture stopped/);
  assert.equal(children.length, before);
});

test('simultaneous real sidecars keep OTP, identity and tokens isolated', async () => {
  const run = async (email, code) => {
    const seen = [];
    const result = await runFreeppBridge(options('otp', {
      task: { email, registrationPassword: 'Password-' + code },
      mailboxProvider: { async listMessages(request) { assert.equal(request.email, email); return [mail(code, email)]; } },
      update(e) { if (e.step === 'fixture_code_received') seen.push(e.result); },
    }));
    assert.deepEqual(seen, [{ code, email }]);
    assert.equal(result.access_token, 'AT-' + email);
  };
  await Promise.all([run('a@example.test', '123456'), run('b@example.test', '654321')]);
});

test('post-registration delay emits real IPC heartbeats throughout virtual 600 seconds', async () => {
  let heartbeats = 0;
  const result = await runFreeppBridge(options('delay', {
    mailboxProvider: { async listMessages() { return [mail('123456')]; } },
    changeEmailSettings: { getSecretConfig: () => ({ postRegistrationDelaySeconds: 600 }) },
    update(e) { if (e.step === 'freepp_post_registration_delay_heartbeat') heartbeats++; },
  }));
  assert.equal(result.ok, true);
  assert.equal(heartbeats, 60);
});

test('real IPC keeps ambiguous TOTP activation material without claiming verification', async () => {
  const opts = options('totp_partial', {
    changeEmailSettings: { getSecretConfig: () => ({ setupTotp2fa: true }) },
  });
  const result = await runFreeppRegistration({ ...opts, mailbox: { source: 'totp_partial', provider: opts.mailboxProvider } });
  assert.equal(result.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(result.totpEnrollmentSessionId, 'fixture-enrollment');
  assert.equal(result.totpActivated, null);
  assert.equal(result.totpVerified, false);
  assert.equal(result.totpError.code, 'TOTP_VERIFICATION_PENDING');
});

test('real IPC preserves credentials and maps late completion failures', async () => {
  for (const mode of ['late_at', 'strict_change']) {
    const opts = options(mode, { changeEmailSettings: { getSecretConfig: () => ({
      setupPassword: true, setupTotp2fa: true, enabled: mode === 'strict_change', failRegistrationOnError: true,
    }) } });
    const result = await runFreeppRegistration({ ...opts, mailbox: { source: mode, provider: opts.mailboxProvider } });
    assert.equal(result.passwordStatus, 'has_password');
    assert.equal(result.password, ' FixturePassword1! ');
    assert.equal(result.totpSecret, 'JBSWY3DPEHPK3PXP');
    assert.equal(result.totpVerified, true);
    assert.equal(result.completionError.retryable_proxy, false);
    assert.equal(result.completionError.code, mode === 'late_at' ? 'FREEPP_FINAL_AT_VALIDATION_FAILED' : 'FREEPP_CHANGE_EMAIL_FAILED');
    if (mode === 'late_at') assert.equal(result.finalAtValidation.status, 'invalid');
  }
});

test('changed login email repairs through real password and MFA without touching old mailbox', async () => {
  let mailboxCalls = 0;
  const events = [];
  const account = { email: 'original@example.test', loginEmail: 'changed@example.test', password: ' FixturePassword1! ',
    passwordStatus: 'has_password', totpStatus: 'failed', totpSecret: 'JBSWY3DPEHPK3PXP', totpVerified: false };
  const opts = options('repair_password_mfa', { update: e => events.push(e) });
  const result = await runFreeppCredentialRepair({ ...opts, account,
    mailbox: { source: 'repair_password_mfa', provider: { async listMessages() { mailboxCalls++; return [mail('123456')]; } } },
  });
  assert.equal(result.email, 'original@example.test');
  assert.equal(result.loginEmail, 'changed@example.test');
  assert.equal(account.email, 'original@example.test');
  assert.equal(result.accessToken, 'REPAIRED-AT');
  assert.equal(result.totpVerified, true);
  assert.equal(mailboxCalls, 0);
  assert.equal(events.find(e => e.step === 'fixture_repair_login').result.email, 'changed@example.test');
  assert.ok(events.some(e => e.step === 'freepp_password_probe_mfa_verified'));
});

test('changed login email automatically reads saved private mailbox and excludes old OTP', async () => {
  let oldMailboxCalls = 0;
  const events = [];
  const privateMailbox = { email: 'changed@example.test', base_url: 'https://mailbox.invalid', token: 'private-fixture-token' };
  const account = { email: 'original@example.test', loginEmail: 'changed@example.test', password: ' FixturePassword1! ',
    passwordStatus: 'has_password', totpStatus: 'enabled', totpSecret: 'JBSWY3DPEHPK3PXP',
    sessionContext: { changedEmailMailbox: privateMailbox } };
  const opts = options('repair_changed_otp_private', { update: e => events.push(e) });
  const result = await runFreeppCredentialRepair({ ...opts, account,
    mailbox: { source: 'repair_changed_otp_private', provider: { async listMessages() { oldMailboxCalls++; return [mail('123456')]; } } },
  });
  assert.equal(result.email, 'original@example.test');
  assert.equal(result.loginEmail, 'changed@example.test');
  assert.equal(result.accessToken, 'REPAIRED-AT');
  assert.equal(oldMailboxCalls, 0);
  assert.equal(events.filter(e => e.step === 'fixture_private_mailbox_read').length, 2);
  assert.deepEqual(result.sessionContext.changedEmailMailbox, privateMailbox);
  assert.equal(JSON.stringify(events).includes(privateMailbox.token), false);
});

test('changed login email OTP fails explicitly without polling original mailbox', async () => {
  let mailboxCalls = 0;
  const account = { email: 'original@example.test', loginEmail: 'changed@example.test', password: ' FixturePassword1! ',
    passwordStatus: 'has_password', totpStatus: 'enabled', totpSecret: 'JBSWY3DPEHPK3PXP' };
  const opts = options('repair_changed_otp');
  await assert.rejects(runFreeppCredentialRepair({ ...opts, account,
    mailbox: { source: 'repair_changed_otp', provider: { async listMessages() { mailboxCalls++; return [mail('123456')]; } } },
  }), error => error.code === 'CREDENTIAL_REPAIR_MAILBOX_MISMATCH' && error.retryableProxy === false);
  assert.equal(mailboxCalls, 0);
});

test('spawn argv contains only script and stdin mode, never encoded secrets', () => {
  assert.ok(spawnArguments.length > 0);
  for (const args of spawnArguments) {
    assert.equal(args.length, 2);
    assert.equal(args[1], '--config-stdin');
    assert.equal(args.includes('--config-b64'), false);
    for (const secret of ['FixturePassword1!', 'private-fixture-token', 'JBSWY3DPEHPK3PXP']) {
      assert.equal(args.join(' ').includes(secret), false);
      assert.equal(args.join(' ').includes(Buffer.from(secret).toString('base64')), false);
    }
  }
});

test('credential repair config retains password whitespace', () => {
  assert.equal(credentialRepairForBridge({ password: '  FixturePassword1!  ' }).password, '  FixturePassword1!  ');
  const config = credentialRepairForBridge({ email: 'old@example.test', loginEmail: 'new@example.test' });
  assert.equal(config.email, 'new@example.test');
  assert.equal(config.mailbox_email, 'old@example.test');
});
