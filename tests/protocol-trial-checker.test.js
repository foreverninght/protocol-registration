'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProtocolEligibilityCheck } = require('../src/eligibility/protocol-trial-checker');

function fixture() {
  const state = {
    account: {
      email: 'fixture@example.test', version: 1,
      passwordStatus: 'has_password', totpStatus: 'enabled', password: 'password', totpSecret: 'totp',
      tokens: { accessToken: 'access', sessionToken: 'session', refreshToken: 'refresh' },
      trialEligibility: { status: 'not_eligible' }, eligibilityLastResult: { checkedAt: 'previous' },
      eligibilityCheckHistory: [{ checkedAt: 'older' }], eligibilityError: { code: 'OLD' },
    },
    patches: [], picks: [], bad: [], checked: [], calls: [],
  };
  const accountStore = {
    async getByEmail() { return structuredClone(state.account); },
    async updateByEmail({ patch, expectedVersion }) {
      state.beforeSave?.();
      if (state.account.version !== expectedVersion) throw Object.assign(new Error('conflict'), { code: 'ACCOUNT_VERSION_CONFLICT' });
      state.patches.push(structuredClone(patch));
      state.account = { ...state.account, ...structuredClone(patch), version: expectedVersion + 1 };
    },
  };
  const proxyPools = { main: {
    async pickNext(input) {
      state.picks.push(input);
      return state.pick ? state.pick() : { id: String(state.picks.length), poolId: 'pool' };
    },
    async markBad(id) { state.bad.push(id); if (state.markFails) throw new Error('mark failed'); },
    async markChecked(id) { state.checked.push(id); if (state.markFails) throw new Error('mark failed'); },
  } };
  const run = (worker, options = {}) => runProtocolEligibilityCheck({
    accountStore, proxyPools, email: state.account.email, ...options,
    worker: async (input) => { state.calls.push(input); return worker(input); },
  });
  return { state, run };
}
const failure = (details = {}) => Object.assign(new Error('probe failed'), { code: 'NETWORK_PROXY', retryableProxy: true, ...details });
const success = () => ({ status: 'eligible', campaignId: 'plus-1-month-free', mfaVerified: true,
  session: { accessToken: 'new-access', sessionToken: 'new-session' } });

for (const maxAttempts of [undefined, 20, 3, 1]) {
  test(`worker budget and unique proxies: ${maxAttempts}`, async () => {
    const { state, run } = fixture();
    const error = failure({ diagnostic: { category: 'proxy', curlCode: 5, httpStatus: null, token: 'secret' } });
    await assert.rejects(run(() => { throw error; }, { maxAttempts }), (caught) => caught === error);
    const count = maxAttempts === 1 ? 1 : 3;
    assert.equal(state.calls.length, count);
    assert.equal(state.picks.length, count);
    assert.deepEqual(state.bad, Array.from({ length: count }, (_, i) => String(i + 1)));
    assert.deepEqual(state.picks.at(-1).excludeIds, state.bad.slice(0, -1));
    assert.equal(state.account.eligibilityError.attempts, count);
    assert.deepEqual(state.account.eligibilityError.diagnostic, { category: 'proxy', httpStatus: null, curlCode: 5 });
  });
}
for (const httpStatus of [401, 403, 429, 500]) {
  test(`HTTP ${httpStatus} stops without fresh-login fallback or proxy penalty`, async () => {
    const { state, run } = fixture();
    const error = failure({ code: 'TRIAL_PROBE_FAILED', diagnostic: {
      category: 'http', httpStatus, phase: 'password_verify', reason: 'LOGIN_HTTP_ERROR', body: 'secret',
    } });
    await assert.rejects(run(() => { throw error; }));
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].forceLogin, undefined);
    assert.deepEqual(state.bad, []);
    assert.deepEqual(state.checked, ['1']);
    assert.deepEqual(state.account.eligibilityError.diagnostic, {
      category: 'http', httpStatus, curlCode: null, phase: 'password_verify', reason: 'LOGIN_HTTP_ERROR',
    });
  });
}
test('failure preserves credentials and historical eligibility without appending history', async () => {
  const { state, run } = fixture();
  const before = structuredClone(state.account);
  await assert.rejects(run(() => { throw failure({ retryableProxy: false }); }));
  for (const key of ['tokens', 'password', 'totpSecret', 'trialEligibility', 'eligibilityLastResult', 'eligibilityCheckHistory']) {
    assert.deepEqual(state.account[key], before[key]);
  }
  assert.deepEqual(Object.keys(state.patches[0]).sort(), ['eligibilityError', 'eligibilityLastCheckedAt', 'eligibilityStatus']);
  assert.equal(state.account.eligibilityStatus, 'failed');
});
for (const throws of [false, true]) {
  test(`proxy exhaustion persists failure: throws=${throws}`, async () => {
    const { state, run } = fixture();
    state.pick = () => { if (throws) throw failure({ code: 'POOL_EMPTY' }); return null; };
    await assert.rejects(run(success));
    assert.equal(state.calls.length, 0);
    assert.equal(state.account.eligibilityError.attempts, 0);
    assert.equal(state.account.eligibilityError.code, throws ? 'POOL_EMPTY' : 'ELIGIBILITY_PROXY_UNAVAILABLE');
  });
}
test('success merges latest token metadata, writes only qualification/session fields, and clears error', async () => {
  const { state, run } = fixture();
  await run(() => {
    state.account.tokens.refreshToken = 'concurrent-refresh';
    state.account.version += 1;
    return { ...success(), password: 'untrusted', totpSecret: 'untrusted' };
  });
  assert.equal(state.account.eligibilityError, null);
  assert.equal(state.account.tokens.refreshToken, 'concurrent-refresh');
  assert.equal(state.account.tokens.accessToken, 'new-access');
  assert.equal(state.account.tokens.sessionToken, 'new-session');
  assert.equal(state.account.password, 'password');
  assert.equal(state.account.totpSecret, 'totp');
  assert.deepEqual(Object.keys(state.patches[0]).sort(), [
    'eligibilityCheckHistory', 'eligibilityError', 'eligibilityLastCheckedAt', 'eligibilityLastResult',
    'eligibilityStatus', 'sessionAvailable', 'tokens', 'trialEligibility',
  ]);
  assert.equal(state.account.eligibilityCheckHistory.length, 2);
});
for (const atSave of [false, true]) {
  test(`concurrent session wins over stale worker tokens, CAS=${atSave}`, async () => {
    const { state, run } = fixture();
    const change = () => {
      state.account.tokens = { accessToken: 'concurrent-access', sessionToken: 'concurrent-session', refreshToken: 'concurrent-refresh' };
      state.account.version += 1;
      state.beforeSave = null;
    };
    await run(() => { if (atSave) state.beforeSave = change; else change(); return success(); });
    assert.deepEqual(state.account.tokens, {
      accessToken: 'concurrent-access', sessionToken: 'concurrent-session', refreshToken: 'concurrent-refresh',
    });
    assert.equal(state.calls.length, 1);
    assert.equal(state.account.trialEligibility.status, 'eligible');
  });
}
test('non-conclusive worker result is failure and preserves history', async () => {
  const { state, run } = fixture();
  await assert.rejects(run(() => ({ status: 'error', errorCode: 'TRIAL_PROBE_FAILED' })), { code: 'TRIAL_PROBE_FAILED' });
  assert.equal(state.account.trialEligibility.status, 'not_eligible');
  assert.equal(state.account.eligibilityError.attempts, 1);
});

test('top-level HTTP status also prevents proxy rotation', async () => {
  const { state, run } = fixture();
  await assert.rejects(run(() => { throw failure({ httpStatus: 503 }); }));
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.bad, []);
});

test('invalid diagnostics do not persist arbitrary strings', async () => {
  const { state, run } = fixture();
  await assert.rejects(run(() => { throw failure({ retryableProxy: false, diagnostic: {
    category: 'secret', httpStatus: 'secret', curlCode: 999, phase: 'secret', reason: 'secret', raw: 'secret',
  } }); }));
  assert.deepEqual(state.account.eligibilityError.diagnostic, { category: 'unknown', httpStatus: null, curlCode: null });
});

test('missing prerequisites persist a zero-attempt failure', async () => {
  const { state, run } = fixture();
  state.account.password = '';
  await assert.rejects(run(success), { code: 'TRIAL_ACCOUNT_NOT_READY' });
  assert.equal(state.calls.length, 0);
  assert.equal(state.picks.length, 0);
  assert.equal(state.account.eligibilityError.attempts, 0);
});

test('pool exception after a network failure still persists actual invocation count', async () => {
  const { state, run } = fixture();
  state.pick = () => {
    if (state.picks.length > 1) throw failure({ code: 'POOL_EMPTY' });
    return { id: '1' };
  };
  await assert.rejects(run(() => { throw failure(); }), { code: 'POOL_EMPTY' });
  assert.equal(state.account.eligibilityError.attempts, 1);
  assert.equal(state.calls.length, 1);
});

for (const key of ['password', 'totpSecret', 'session', 'sessionContext']) {
  test(`concurrent ${key} update prevents stale session replacement`, async () => {
    const { state, run } = fixture();
    await run(() => { state.account[key] = 'concurrent'; state.account.version += 1; return success(); });
    assert.equal(state.account.tokens.accessToken, 'access');
    assert.equal(state.account.tokens.sessionToken, 'session');
    assert.equal(state.account[key], 'concurrent');
    assert.equal(state.account.trialEligibility.status, 'eligible');
  });
}
for (const retryableProxy of [true, false]) {
  test(`proxy marking exception still persists original failure: retryable=${retryableProxy}`, async () => {
    const { state, run } = fixture();
    state.markFails = true;
    const error = failure({ retryableProxy });
    await assert.rejects(run(() => { throw error; }), (caught) => caught === error);
    assert.equal(state.account.eligibilityError.code, error.code);
    assert.equal(state.account.eligibilityError.attempts, 1);
    assert.equal(state.calls.length, 1);
  });
}
