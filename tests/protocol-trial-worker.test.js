'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { proxyUrl, validateResult, runProtocolTrialCheck } = require('../src/eligibility/protocol-trial-worker');

const accountId = 'fixture-account';
const accessToken = 'e30.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: accountId },
})).toString('base64url') + '.signature';
const account = {
  email: 'fixture@example.test', password: 'fixture-password', totpSecret: 'FIXTURE',
  totpStatus: 'enabled', tokens: { accessToken },
};
const proxy = { raw: 'proxy.example:8080:user:pass', host: 'proxy.example', port: 8080, username: 'user', password: 'pass' };
const result = {
  email: account.email, accountId, mfaVerified: true, status: 'eligible',
  campaignId: 'plus-1-month-free', errorCode: null, session: null,
};

function fixture(reply = { type: 'result', result }, { stdinError = false, throwStdin = false } = {}) {
  let request;
  let killed = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { killed += 1; queueMicrotask(() => child.emit('close', 1)); };
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      if (stdinError) return callback(new Error('sensitive-stdin-error'));
      request = JSON.parse(chunk.toString());
      callback();
      if (reply) queueMicrotask(() => {
        child.stdout.write(JSON.stringify(reply) + '\n');
        child.emit('close', 0);
      });
    },
  });
  if (throwStdin) child.stdin.end = () => { throw new Error('sensitive-stdin-error'); };
  return {
    spawnImpl: () => child,
    get request() { return request; },
    get killed() { return killed; },
    child,
  };
}

async function run(savedAccount, options = {}) {
  const fake = fixture();
  await runProtocolTrialCheck({ account: savedAccount, proxy, spawnImpl: fake.spawnImpl, ...options });
  return fake.request;
}

test('scheme-less production proxies use canonical structured fields', () => {
  for (const host of ['proxy.example', '192.0.2.10', 'localhost']) {
    assert.equal(proxyUrl({ ...proxy, host, raw: host + ':8080:user:pass' }), 'http://user:pass@' + host + ':8080');
  }
  assert.equal(proxyUrl({ ...proxy, username: 'u:@ /?#%', password: 'p:@ /?#%' }),
    'http://u%3A%40%20%2F%3F%23%25:p%3A%40%20%2F%3F%23%25@proxy.example:8080');
  for (const host of ['2001:db8::1', '[2001:db8::1]']) {
    assert.equal(proxyUrl({ host, port: 1080, scheme: 'socks5h' }), 'socks5h://[2001:db8::1]:1080');
  }
});

test('explicit auth URLs are parsed and restricted to supported proxy schemes', () => {
  for (const scheme of ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    assert.equal(proxyUrl({ raw: scheme + '://u%40:p%3A@proxy.example:1080' }), scheme + '://u%40:p%3A@proxy.example:1080');
  }
  assert.equal(proxyUrl({ raw: 'http://user:pass@[2001:db8::1]:8080' }), 'http://user:pass@[2001:db8::1]:8080');
  assert.equal(proxyUrl({ raw: 'HTTPS://proxy.example:443/' }), 'https://proxy.example:443');
});

test('invalid proxies return no credential-bearing value and never spawn', async () => {
  const invalid = [
    null, {}, { host: 'host', port: 0 }, { host: 'host', port: 65536 },
    { host: 'host', port: 1.5 }, { host: 'bad/host', port: 80 },
    { host: 'user@host', port: 80 }, { host: '[bad]', port: 80 },
    { host: 'host', port: 80, scheme: 'file' },
    ...['ftp://user:secret@host:80', 'http://user:secret@host:99999',
      'http://user:secret@host:80/path', 'http://host:80?secret=x',
      'http://host:80#secret', 'http://u%ZZ:secret@host:80',
      'http://host\\other:80', 'http://host\n:80'].map((raw) => ({ ...proxy, raw })),
  ];
  for (const value of invalid) {
    assert.equal(proxyUrl(value), '');
    await assert.rejects(runProtocolTrialCheck({ account, proxy: value, spawnImpl() { assert.fail('spawn'); } }),
      { code: 'TRIAL_ACCOUNT_NOT_READY', message: 'TRIAL_ACCOUNT_NOT_READY' });
  }
});

test('actual JSON stdin uses jar chunks over stale header for session-first without mutation', async () => {
  const saved = {
    ...account,
    sessionContext: { cookie: '__Secure-next-auth.session-token=stale' },
    session: { cookies: [
      { name: '__Secure-next-auth.session-token.1', value: 'second', domain: '.chatgpt.com' },
      { name: '__Secure-next-auth.session-token.0', value: 'first', domain: 'chatgpt.com' },
      { name: '__Secure-next-auth.session-token', value: 'foreign', domain: 'example.test' },
    ] },
  };
  const before = structuredClone(saved);
  const request = await run(saved);
  assert.deepEqual(request.session, { accessToken, sessionToken: 'firstsecond' });
  assert.equal(request.mfaPreviouslyVerified, true);
  assert.equal(request.proxy, 'http://user:pass@proxy.example:8080');
  assert.deepEqual(saved, before);
});

test('header fallback, direct token precedence, forceLogin and missing cookie', async () => {
  const saved = { ...account, sessionContext: { cookie: '__Secure-next-auth.session-token=header-token' } };
  assert.equal((await run(saved)).session.sessionToken, 'header-token');
  assert.equal((await run({ ...saved, tokens: { accessToken, sessionToken: 'direct-token' } })).session.sessionToken, 'direct-token');
  assert.equal((await run(saved, { forceLogin: true })).session, undefined);
  assert.equal((await run(account)).session, undefined);
});

test('network retry requires absent HTTP status; 401/403/429 and malformed statuses stop', async () => {
  for (const code of ['NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_FAILED', 'WORKER_TIMEOUT', 'LOGIN_STEP_FAILED']) {
    for (const status of [undefined, null, 401, 403, 429, 503, '401', 0]) {
      const fake = fixture({ type: 'error', code, diagnostic: { category: 'http', httpStatus: status } });
      await assert.rejects(runProtocolTrialCheck({ account, proxy, spawnImpl: fake.spawnImpl }), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.retryableProxy, code.startsWith('NETWORK_') && status == null);
        return true;
      });
      assert.equal(fake.killed, 1);
    }
  }
});

test('result session requires two bounded printable tokens; null error result remains valid', () => {
  const context = { email: account.email, accountId };
  assert.equal(validateResult({ ...result, status: 'error', errorCode: 'TRIAL_PROBE_FAILED' }, context).session, null);
  assert.equal(validateResult(result, context).session, null);
  const tokens = { accessToken: 'a'.repeat(16384), sessionToken: '~valid!' };
  assert.deepEqual(validateResult({ ...result, session: tokens }, context).session, tokens);
  for (const field of ['accessToken', 'sessionToken']) {
    for (const bad of ['', null, undefined, 123, {}, 'x\ny', 'x\ry', 'x\0y', 'x\ty', 'x y', '\u007f', '\u00e9', 'a'.repeat(16385)]) {
      assert.throws(() => validateResult({ ...result, session: { ...tokens, [field]: bad } }, context), { code: 'TRIAL_RESULT_INVALID' });
    }
  }
  for (const session of [false, '', 1, [], {}]) {
    assert.throws(() => validateResult({ ...result, session }, context), { code: 'TRIAL_RESULT_INVALID' });
  }
  assert.throws(() => validateResult({ ...result, email: {} }, context), { code: 'TRIAL_RESULT_INVALID' });
});

test('bad worker session never resolves into a writeback result', async () => {
  const fake = fixture({ type: 'result', result: { ...result, session: { accessToken: 'bad\n', sessionToken: 'ok' } } });
  await assert.rejects(runProtocolTrialCheck({ account, proxy, spawnImpl: fake.spawnImpl }), { code: 'TRIAL_RESULT_INVALID' });
});

test('stdin errors and synchronous failures stop child with sanitized error', async () => {
  for (const options of [{ stdinError: true }, { throwStdin: true }]) {
    const fake = fixture(null, options);
    await assert.rejects(runProtocolTrialCheck({ account, proxy, spawnImpl: fake.spawnImpl }),
      { code: 'TRIAL_WORKER_STDIN_FAILED', message: 'TRIAL_WORKER_STDIN_FAILED' });
    assert.equal(fake.killed, 1);
    fake.child.stdin.emit('error', new Error('late error'));
  }
});

test('worker budget expiry is not a retryable proxy failure', async () => {
  const fake = fixture(null);
  await assert.rejects(runProtocolTrialCheck({ account, proxy, spawnImpl: fake.spawnImpl, timeoutMs: 5 }),
    { code: 'WORKER_TIMEOUT', retryableProxy: false });
  assert.equal(fake.killed, 1);
});


test('password whitespace is preserved in actual JSON stdin', async () => {
  const password = '  fixture-password\t ';
  assert.equal((await run({ ...account, password })).credentials.password, password);
});

test('a child ignoring SIGTERM receives SIGKILL; close cancels escalation', async () => {
  const stubborn = fixture(null, { throwStdin: true });
  const closed = fixture(null, { throwStdin: true });
  const stubbornSignals = [];
  const closedSignals = [];
  stubborn.child.kill = (signal) => { stubbornSignals.push(signal); };
  closed.child.kill = (signal) => {
    closedSignals.push(signal);
    queueMicrotask(() => closed.child.emit('close', 1));
  };
  for (const fake of [stubborn, closed]) {
    await assert.rejects(runProtocolTrialCheck({ account, proxy, spawnImpl: fake.spawnImpl }),
      { code: 'TRIAL_WORKER_STDIN_FAILED' });
  }
  assert.deepEqual(stubbornSignals, ['SIGTERM']);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(stubbornSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(closedSignals, ['SIGTERM']);
  stubborn.child.emit('close', 1);
});