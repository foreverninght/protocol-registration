'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  closeAllSessions,
  getSession,
  publicSession,
  removeAddress,
} = require('../tools/mail_com_split_mailbox');

function response(body = '', { status = 200, headers = {} } = {}) {
  return new Response(status === 204 ? null : body, { status, headers });
}

function mailComFetch({ settingsResponse, failLoginAttempt = 0 } = {}) {
  const state = {
    loginAttempts: 0,
    settingsCalls: 0,
  };
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (url.href === 'https://www.mail.com/') {
      return response('<html></html>', {
        headers: { 'set-cookie': 'home=1; Domain=mail.com; Path=/; Secure' },
      });
    }
    if (url.href === 'https://login.mail.com/login') {
      state.loginAttempts += 1;
      if (state.loginAttempts === failLoginAttempt) {
        return response('login rejected');
      }
      return response('', {
        status: 302,
        headers: {
          location: `https://navigator-lxa.mail.com/login?sid=sid-${state.loginAttempts}`,
          'set-cookie': `login=session-${state.loginAttempts}; Domain=mail.com; Path=/; Secure`,
        },
      });
    }
    if (url.hostname === 'navigator-lxa.mail.com' && url.pathname === '/login') {
      return response('<html>mailbox</html>');
    }
    if (url.hostname === 'oauthbridge.navigator-lxa.mail.com') {
      const sid = url.searchParams.get('sid');
      const scope = String(options.body?.get?.('scope') || 'scope').replace(/[^a-z_]/giu, '');
      return response(JSON.stringify({
        access_token: `token-${sid}-${scope}`,
        expires_in: 900,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'settings-cats.mail.com') {
      state.settingsCalls += 1;
      return settingsResponse({
        call: state.settingsCalls,
        authorization: options.headers?.authorization || '',
      });
    }
    throw new Error(`unexpected mail.com request: ${url.href}`);
  };
  return { fetchImpl, state };
}

function mainMailbox(name) {
  return {
    id: `mailbox-${name}`,
    email: `${name}@example.com`,
    password: 'mailbox-password',
  };
}

test.afterEach(async () => {
  await closeAllSessions();
});

test('expired address session renews immediately and replays removal once', async () => {
  const mock = mailComFetch({
    settingsResponse: ({ authorization }) => authorization.includes('sid-1')
      ? response('expired', { status: 401 })
      : response('', { status: 204 }),
  });

  const result = await removeAddress(mainMailbox('renew'), 'alias@example.com', {
    fetchImpl: mock.fetchImpl,
  });

  assert.equal(result.status, 204);
  assert.equal(mock.state.loginAttempts, 2);
  assert.equal(mock.state.settingsCalls, 2);
});

test('concurrent expired removals share one session renewal', async () => {
  const mock = mailComFetch({
    settingsResponse: ({ authorization }) => authorization.includes('sid-1')
      ? response('expired', { status: 401 })
      : response('', { status: 204 }),
  });
  const main = mainMailbox('single-flight');
  await getSession(main, { fetchImpl: mock.fetchImpl });

  await Promise.all([
    removeAddress(main, 'first@example.com', { fetchImpl: mock.fetchImpl }),
    removeAddress(main, 'second@example.com', { fetchImpl: mock.fetchImpl }),
  ]);

  assert.equal(mock.state.loginAttempts, 2);
  assert.equal(mock.state.settingsCalls, 4);
});

test('ordinary address business errors do not renew the session', async () => {
  const mock = mailComFetch({
    settingsResponse: () => response('address cannot be removed', { status: 409 }),
  });

  await assert.rejects(
    removeAddress(mainMailbox('business-error'), 'alias@example.com', { fetchImpl: mock.fetchImpl }),
    /HTTP 409/u,
  );
  assert.equal(mock.state.loginAttempts, 1);
  assert.equal(mock.state.settingsCalls, 1);
});

test('failed renewal records an explicit failed session state', async () => {
  const mock = mailComFetch({
    failLoginAttempt: 2,
    settingsResponse: () => response('expired', { status: 401 }),
  });
  const main = mainMailbox('renewal-failure');

  await assert.rejects(
    removeAddress(main, 'alias@example.com', { fetchImpl: mock.fetchImpl }),
    { code: 'MAIL_COM_SESSION_RENEWAL_FAILED' },
  );
  assert.equal(publicSession(main).status, 'failed');
  assert.match(publicSession(main).lastError, /会话续期失败/u);
});

test('an expired replay is not renewed a second time', async () => {
  const mock = mailComFetch({
    settingsResponse: () => response('expired', { status: 401 }),
  });

  const main = mainMailbox('one-replay');
  await assert.rejects(
    removeAddress(main, 'alias@example.com', { fetchImpl: mock.fetchImpl }),
    { code: 'MAIL_COM_SESSION_EXPIRED' },
  );
  assert.equal(mock.state.loginAttempts, 2);
  assert.equal(mock.state.settingsCalls, 2);
  assert.equal(publicSession(main).status, 'login_required');
});
