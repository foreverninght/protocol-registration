'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { releaseMailComSplitAddress } = require('../src/mailbox/providers/mail-com-split');
const { RegistrationRunner } = require('../src/registration/runner');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

function task() {
  return {
    email: 'alias@example.com',
    mailboxSource: 'mail_com_split',
    mailboxId: 'mailbox-id',
    aliasId: 'alias-id',
    accountId: 'account-id',
  };
}

function ownedStore({ status = 'registered' } = {}) {
  const calls = [];
  return {
    calls,
    async getMailbox() {
      return {
        id: 'mailbox-id',
        provider: 'mail_com',
        email: 'main@example.com',
        password: 'mailbox-password',
      };
    },
    async getAlias() {
      return {
        id: 'alias-id',
        mailboxId: 'mailbox-id',
        accountId: 'account-id',
        email: 'alias@example.com',
        status,
      };
    },
    async markAliasAbandoned(input) {
      calls.push(['abandoned', input]);
      return { alias: { id: input.aliasId, status: 'abandoned' } };
    },
    async markAliasCleanupRequired(input) {
      calls.push(['cleanup_required', input]);
      return { alias: { id: input.aliasId, status: 'cleanup_required' } };
    },
  };
}

function runner({ mailboxStore, mailComAddressReleaser }) {
  return new RegistrationRunner({
    config: {},
    registrationStore: {},
    accountAssetStore: {},
    mailboxStore,
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
    mailComAddressReleaser,
  });
}

test('terminal release archives local ownership only after remote removal succeeds', async () => {
  const store = ownedStore();
  const calls = [];
  const result = await releaseMailComSplitAddress({
    mailboxStore: store,
    ...task(),
    mailClient: {
      async removeAddress(main, email) {
        calls.push(['remote', main.id, email]);
      },
    },
  });

  assert.deepEqual(calls, [['remote', 'mailbox-id', 'alias@example.com']]);
  assert.deepEqual(store.calls, [['abandoned', { aliasId: 'alias-id' }]]);
  assert.equal(result.alias.status, 'abandoned');
});

test('remote removal failure does not pretend local ownership was released', async () => {
  const store = ownedStore();
  const error = new Error('remote removal failed');
  error.code = 'REMOTE_REMOVE_FAILED';

  await assert.rejects(
    releaseMailComSplitAddress({
      mailboxStore: store,
      ...task(),
      mailClient: { async removeAddress() { throw error; } },
    }),
    { code: 'REMOTE_REMOVE_FAILED' },
  );
  assert.deepEqual(store.calls, []);
});

test('runner preserves terminal result and records cleanup required after release failure', async () => {
  const store = ownedStore();
  const releaseError = new Error('renewal failed');
  releaseError.code = 'MAIL_COM_SESSION_RENEWAL_FAILED';
  const subject = runner({
    mailboxStore: store,
    mailComAddressReleaser: async () => { throw releaseError; },
  });
  const events = [];

  const result = await subject.releaseTerminalMailComAlias(task(), async (event) => events.push(event));

  assert.equal(result.action, 'cleanup_required');
  assert.equal(store.calls[0][0], 'cleanup_required');
  assert.equal(store.calls[0][1].error, releaseError);
  assert.equal(events[0].type, 'mail_com.alias_cleanup_required');
  assert.equal(events[0].error.code, 'MAIL_COM_SESSION_RENEWAL_FAILED');
});

test('runner records a completed remote alias release', async () => {
  const store = ownedStore();
  const subject = runner({
    mailboxStore: store,
    mailComAddressReleaser: async () => ({ alias: { id: 'alias-id', status: 'abandoned' } }),
  });
  const events = [];

  const result = await subject.releaseTerminalMailComAlias(task(), async (event) => events.push(event));

  assert.equal(result.action, 'released');
  assert.equal(events[0].type, 'mail_com.alias_released');
});

test('event persistence failure does not relabel an already released alias', async () => {
  const store = ownedStore();
  const subject = runner({
    mailboxStore: store,
    mailComAddressReleaser: async () => ({ alias: { id: 'alias-id', status: 'abandoned' } }),
  });

  await assert.rejects(
    subject.releaseTerminalMailComAlias(task(), async () => {
      throw new Error('event store unavailable');
    }),
    /event store unavailable/u,
  );
  assert.deepEqual(store.calls, []);
});

test('cleanup reconciliation treats a fresh remote snapshot as release evidence', async () => {
  const store = ownedStore({ status: 'cleanup_required' });
  store.listAliases = async () => [{
    id: 'alias-id',
    mailboxId: 'mailbox-id',
    accountId: 'account-id',
    email: 'alias@example.com',
    status: 'cleanup_required',
    latestJobId: 'job-id',
  }];
  const events = [];
  const transitions = [];
  const subject = new RegistrationRunner({
    config: {},
    registrationStore: {
      async loadJob() {
        return { ...task(), id: 'job-id', status: 'failed' };
      },
      async appendEvent(input) {
        events.push(input.event);
      },
    },
    accountAssetStore: {
      async transitionMailComWorkflow(input) {
        transitions.push(input);
        return input;
      },
    },
    mailboxStore: store,
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
    mailComAddressReleaser: async () => {
      throw new Error('remote removal must not run for an alias absent from the fresh snapshot');
    },
  });

  const results = await subject.reconcileTerminalMailComAliases({
    mailboxId: 'mailbox-id',
    remoteAliasEmails: [],
  });

  assert.equal(results[0].action, 'released');
  assert.equal(store.calls[0][0], 'abandoned');
  assert.equal(events[0].type, 'mail_com.alias_release_confirmed_by_snapshot');
  assert.deepEqual(transitions[0], {
    jobId: 'job-id',
    stage: 'unregistered',
    releaseStatus: 'released',
    releaseError: null,
    discard: true,
    discardReason: 'registration_failed',
  });
});

test('cleanup reconciliation repairs a released alias whose workflow projection was interrupted', async () => {
  const store = ownedStore({ status: 'abandoned' });
  store.listAliases = async () => [{
    id: 'alias-id',
    mailboxId: 'mailbox-id',
    accountId: 'account-id',
    email: 'alias@example.com',
    status: 'abandoned',
    latestJobId: 'job-id',
  }];
  const events = [];
  const transitions = [];
  const subject = new RegistrationRunner({
    config: {},
    registrationStore: {
      async loadJob() {
        return { ...task(), id: 'job-id', status: 'completed' };
      },
      async appendEvent(input) {
        events.push(input.event);
      },
    },
    accountAssetStore: {
      async getByJob() {
        return { trialEligibility: { status: 'eligible' }, mailComReleaseStatus: 'cleanup_required' };
      },
      async transitionMailComWorkflow(input) {
        transitions.push(input);
        return input;
      },
    },
    mailboxStore: store,
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
    mailComAddressReleaser: async () => {
      throw new Error('an already abandoned alias must not be removed remotely again');
    },
  });

  const results = await subject.reconcileTerminalMailComAliases({ mailboxId: 'mailbox-id' });

  assert.equal(results[0].action, 'released');
  assert.deepEqual(transitions[0], {
    jobId: 'job-id',
    stage: 'payment_method',
    releaseStatus: 'released',
    releaseError: null,
  });
  assert.equal(events[0].type, 'mail_com.alias_release_reconciled_from_local_state');
  assert.deepEqual(store.calls, []);
});

test('completed registration stays in repair while terminal alias release is incomplete', async () => {
  const transitions = [];
  const subject = new RegistrationRunner({
    config: {},
    registrationStore: {},
    accountAssetStore: {
      async getByJob() {
        return {
          trialEligibility: { status: 'eligible' },
          paymentCapabilities: { status: 'failed', error: 'probe failed' },
        };
      },
      async transitionMailComWorkflow(input) {
        transitions.push(input);
        return input;
      },
    },
    mailboxStore: ownedStore(),
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
  });

  await subject.transitionTerminalMailComWorkflow(
    { ...task(), id: 'job-id' },
    { release: { action: 'cleanup_required', error: new Error('release failed') }, trialEligibility: { status: 'eligible' } },
  );

  assert.equal(transitions[0].stage, 'unregistered');
  assert.equal(transitions[0].releaseStatus, 'cleanup_required');
});

test('completed registration always enters payment review before a new payment probe runs', async () => {
  const transitions = [];
  const subject = new RegistrationRunner({
    config: {},
    registrationStore: {},
    accountAssetStore: {
      async getByJob() {
        return {
          trialEligibility: { status: 'eligible' },
          paymentCapabilities: { status: 'done', methods: ['hosted'] },
        };
      },
      async transitionMailComWorkflow(input) {
        transitions.push(input);
        return input;
      },
    },
    mailboxStore: ownedStore(),
    proxyPools: {},
    runtimeStateStore: new MemoryRuntimeStateStore(),
  });

  await subject.transitionTerminalMailComWorkflow(
    { ...task(), id: 'job-id' },
    { release: { action: 'released' }, trialEligibility: { status: 'eligible' } },
  );

  assert.equal(transitions[0].stage, 'payment_method');
  assert.equal(transitions[0].releaseStatus, 'released');
});
