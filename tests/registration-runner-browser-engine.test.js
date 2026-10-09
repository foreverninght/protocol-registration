'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/app/config');
const {
  RegistrationRunner,
  isProtocolEntryBranch,
  isFreeppSidecarEntryBranch,
} = require('../src/registration/runner');
const { DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS } = require('../src/registration/change-email-settings');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

function createRunner(options = {}) {
  return new RegistrationRunner({
    config: loadConfig({}),
    registrationStore: {},
    accountAssetStore: {},
    mailboxStore: {},
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
    ...options,
  });
}

test('registration runner can override browser engine per task without mutating service config', () => {
  const config = loadConfig({
    BROWSER_RUN_ENABLED: '1',
    BROWSER_ENGINE: 'camoufox',
  });
  const runner = createRunner({ config });

  const taskConfig = runner.browserConfigForTask({ browserEngine: 'chromium' });
  assert.equal(config.browser.engine, 'camoufox');
  assert.equal(taskConfig.browser.engine, 'chromium');
  assert.notEqual(taskConfig, config);
  assert.notEqual(taskConfig.browser, config.browser);
});

test('browser registration carries verified proxy geo into browser launch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'registration', 'runner.js'), 'utf8');
  assert.match(source, /const browserProxyAttempts[\s\S]+?let proxyGeo = null;[\s\S]+?proxyGeo = preflight\.geo \|\| null;[\s\S]+?createFingerprintBrowserSession\(\{[\s\S]+?proxyGeo\?\.timezone/u);
});

test('registration runner restores supported per-task browser engines and rejects removed engines', () => {
  const config = loadConfig({
    BROWSER_RUN_ENABLED: '1',
    BROWSER_ENGINE: 'camoufox',
  });
  const runner = createRunner({ config });

  assert.equal(runner.browserConfigForTask({ browserEngine: 'cloak' }).browser.engine, 'cloak');
  assert.throws(() => runner.browserConfigForTask({ browserEngine: 'shardx' }), /unsupported BROWSER_ENGINE/);
  assert.throws(() => runner.browserConfigForTask({ browserEngine: 'clearcote' }), /unsupported BROWSER_ENGINE/);
  assert.throws(() => runner.browserConfigForTask({ browserEngine: 'safari' }), /unsupported BROWSER_ENGINE/);
});

test('registration runner can override entry branch per task without mutating service config', () => {
  const config = loadConfig({
    REGISTRATION_ENTRY_BRANCH: 'flowpilot',
  });
  const runner = createRunner({ config });

  assert.equal(runner.entryBranchForTask({ entryBranch: 'direct' }), 'flowpilot');
  assert.equal(runner.entryBranchForTask({ entryBranch: 'freepp' }), 'freepp');
  assert.throws(() => runner.entryBranchForTask({ entryBranch: 'freepp-har' }), { code: 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED' });
  assert.equal(config.registration.entryBranch, 'flowpilot');
  assert.equal(config.registration.freeppHar, undefined);
  assert.equal(runner.entryBranchForTask({}), 'flowpilot');
});

test('registration runner treats only FreePP as a protocol sidecar branch', () => {
  assert.equal(isProtocolEntryBranch('freepp'), true);
  assert.equal(isProtocolEntryBranch('freepp_har'), false);
  assert.equal(isProtocolEntryBranch('flowpilot'), false);
  assert.equal(isProtocolEntryBranch('direct'), false);
  assert.equal(isFreeppSidecarEntryBranch('freepp'), true);
  assert.equal(isFreeppSidecarEntryBranch('freepp_har'), false);
  assert.equal(isFreeppSidecarEntryBranch('flowpilot'), false);
  assert.equal(isFreeppSidecarEntryBranch('direct'), false);
});

test('registration 2FA has no service-level duplicate switch', () => {
  const config = loadConfig({ REGISTRATION_SETUP_TOTP_2FA: '1' });
  assert.equal(Object.prototype.hasOwnProperty.call(config.registration, 'setupTotp2fa'), false);
});

test('registration extras default to disabled', () => {
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.setupPassword, false);
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.setupTotp2fa, false);
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.validateOauthSession, false);
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.phoneBindProbeEnabled, false);
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.autoCheckEligibility, false);
});

test('registration proxy retry limit has one effective configured value', () => {
  assert.equal(loadConfig({ BROWSER_MAX_PROXY_ATTEMPTS: '20' }).browser.maxProxyAttempts, 3);
});

test('registration runner selects cloudflare mailbox provider by configured domain when no share url exists', async () => {
  const config = loadConfig({});
  const runner = createRunner({
    config,
    mailboxSettings: {
      getSecretConfig() {
        return {
          baseUrl: 'https://mail.example.test',
          adminAuth: 'secret',
          customAuth: '',
          domains: ['example.test'],
          path: '/admin/mails',
          limit: 30,
        };
      },
    },
  });

  assert.equal((await runner.mailboxProviderForTask({
    email: 'user@random.example.test',
    mailboxUrl: '',
  })).source, 'cloudflare_temp_email');
  assert.equal((await runner.mailboxProviderForTask({
    email: 'user@other.example',
    mailboxUrl: '',
  })).source, 'none');
});

test('registration runner prefers explicit share mailbox url over cloudflare domain provider', async () => {
  const config = loadConfig({});
  const runner = createRunner({
    config,
    mailboxSettings: {
      getSecretConfig() {
        return {
          baseUrl: 'https://mail.example.test',
          adminAuth: 'secret',
          domains: ['example.test'],
        };
      },
    },
  });

  assert.equal((await runner.mailboxProviderForTask({
    email: 'user@example.test',
    mailboxUrl: 'https://mail.example/s/token/user%40example.test',
  })).source, 'share_page');
});

test('registration runner resolves split mailbox only from persisted task ownership', async () => {
  const alias = 'owned@example.com';
  const mailbox = { id: 'main-mailbox-id', provider: 'mail_com', email: 'main@example.com', password: 'secret' };
  const ownedAlias = { id: 'alias-id', mailboxId: mailbox.id, accountId: 'account-id', email: alias, status: 'registering' };
  const runner = createRunner({
    mailboxStore: {
      async getMailbox({ mailboxId }) { return mailboxId === mailbox.id ? mailbox : null; },
      async getAlias({ aliasId }) { return aliasId === ownedAlias.id ? ownedAlias : null; },
    },
  });

  const resolved = await runner.mailboxProviderForTask({
    email: alias,
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: ownedAlias.id,
    accountId: ownedAlias.accountId,
  });
  assert.equal(resolved.source, 'mail_com_split');
});

test('registration runner rejects incomplete or mismatched split mailbox ownership', async () => {
  const mailbox = { id: 'main-mailbox-id', provider: 'mail_com', email: 'main@example.com', password: 'secret' };
  const alias = { id: 'alias-id', mailboxId: mailbox.id, accountId: 'account-id', email: 'owned@example.com', status: 'registering' };
  const runner = createRunner({
    mailboxStore: {
      async getMailbox() { return mailbox; },
      async getAlias() { return alias; },
    },
  });

  await assert.rejects(runner.mailboxProviderForTask({
    email: 'owned@example.com',
    mailboxSource: 'mail_com_split',
  }), { code: 'MAIL_COM_TASK_OWNERSHIP_INVALID' });
  await assert.rejects(runner.mailboxProviderForTask({
    email: 'other@example.com',
    mailboxSource: 'mail_com_split',
    mailboxId: mailbox.id,
    aliasId: alias.id,
    accountId: alias.accountId,
  }), { code: 'MAIL_COM_TASK_OWNERSHIP_INVALID' });
});
