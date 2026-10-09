'use strict';

const {
  addAddress,
  fetchAliasCode,
  getSession,
  removeAddress,
  snapshotAliasMessages,
} = require('../../../tools/mail_com_split_mailbox');

function normalizeMailComResult(result = {}, email = '') {
  if (!result.found) return [];
  return [{
    id: result.mail?.id || '',
    subject: result.mail?.subject || '',
    sender: result.mail?.sender || '',
    text: result.code || '',
    receivedAt: result.mail?.receivedAt || new Date().toISOString(),
  }];
}

function ownershipError(message) {
  const error = new Error(message);
  error.code = 'MAIL_COM_TASK_OWNERSHIP_INVALID';
  error.retryableProxy = false;
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function requireStore(mailboxStore) {
  if (!mailboxStore
    || typeof mailboxStore.getMailbox !== 'function'
    || typeof mailboxStore.getAlias !== 'function') {
    throw new TypeError('mail.com split provider requires mailboxStore');
  }
  return mailboxStore;
}

async function loadOwnedAlias({ mailboxStore, mailboxId, aliasId, accountId = '', email = '', statuses }) {
  const store = requireStore(mailboxStore);
  if (!mailboxId || !aliasId) throw ownershipError('mail.com split mailboxId and aliasId are required');
  const [mailbox, alias] = await Promise.all([
    store.getMailbox({ mailboxId, includeSecret: true }),
    store.getAlias({ aliasId }),
  ]);
  if (!mailbox || mailbox.provider !== 'mail_com' || !mailbox.password) {
    throw ownershipError('mail.com split main mailbox is missing or has no credentials');
  }
  const normalizedEmail = normalizeEmail(email || alias?.email);
  if (!alias
    || alias.mailboxId !== mailbox.id
    || alias.email !== normalizedEmail
    || (accountId && alias.accountId !== accountId)
    || !statuses.includes(alias.status)) {
    throw ownershipError('mail.com split alias ownership or state does not match this operation');
  }
  return { mailbox, alias };
}

async function createMailComSplitAddress({
  mailboxStore,
  mailboxId,
  aliasId,
  timeoutMs = 60000,
  mailClient = { getSession, addAddress },
}) {
  const { mailbox, alias } = await loadOwnedAlias({
    mailboxStore,
    mailboxId,
    aliasId,
    statuses: ['creating'],
  });
  const domain = alias.email.split('@').pop();
  const availableDomains = await mailboxStore.listMailComDomainCatalog({ includeBlacklisted: false });
  if (!availableDomains.some((entry) => entry.domain === domain && !entry.blacklisted)) {
    const error = new Error(`mail.com split alias domain is not available for its main mailbox: ${domain}`);
    error.code = 'MAIL_COM_SPLIT_DOMAIN_NOT_AVAILABLE';
    error.domain = domain;
    error.retryableProxy = false;
    throw error;
  }
  await mailClient.getSession(mailbox, { timeoutMs });
  await mailClient.addAddress(mailbox, alias.email, { timeoutMs });
  return { email: alias.email, mailboxId: mailbox.id, aliasId: alias.id };
}

async function releaseMailComSplitAddress({
  mailboxStore,
  mailboxId,
  aliasId,
  accountId,
  email,
  timeoutMs = 60000,
  mailClient = { removeAddress },
}) {
  const { mailbox, alias } = await loadOwnedAlias({
    mailboxStore,
    mailboxId,
    aliasId,
    accountId,
    email,
    statuses: ['registering', 'registered', 'cleanup_required'],
  });
  await mailClient.removeAddress(mailbox, alias.email, { timeoutMs });
  return mailboxStore.markAliasAbandoned({ aliasId: alias.id });
}

function createMailComSplitProvider({
  mailboxStore,
  mailbox,
  alias,
  mailClient = { fetchAliasCode, snapshotAliasMessages },
}) {
  const store = requireStore(mailboxStore);
  if (!mailbox?.id || !alias?.id || !alias?.accountId) {
    throw ownershipError('mail.com split provider requires explicit mailbox, alias, and account ownership');
  }
  const ownership = {
    mailboxId: mailbox.id,
    mailboxEmail: mailbox.email,
    aliasId: alias.id,
    accountId: alias.accountId,
    aliasEmail: alias.email,
  };
  const loadCurrent = async (email) => {
    if (normalizeEmail(email) !== ownership.aliasEmail) {
      throw ownershipError('mail.com split poll requested a different alias');
    }
    const current = await loadOwnedAlias({
      mailboxStore: store,
      mailboxId: ownership.mailboxId,
      aliasId: ownership.aliasId,
      accountId: ownership.accountId,
      email: ownership.aliasEmail,
      statuses: ['registering'],
    });
    if (current.mailbox.email !== ownership.mailboxEmail) {
      throw ownershipError('mail.com split main mailbox identity changed during polling');
    }
    return current;
  };
  return {
    async snapshotMessages({ email } = {}) {
      const current = await loadCurrent(email);
      return mailClient.snapshotAliasMessages(current.mailbox, ownership.aliasEmail, { timeoutMs: 60000 });
    },
    async listMessages({ email, after, seenIds, seenCodes } = {}) {
      const current = await loadCurrent(email);
      const result = await mailClient.fetchAliasCode(current.mailbox, ownership.aliasEmail, {
        timeoutMs: 60000,
        after,
        seenIds,
        seenCodes,
      });
      return normalizeMailComResult(result, ownership.aliasEmail);
    },
  };
}

module.exports = {
  createMailComSplitAddress,
  createMailComSplitProvider,
  releaseMailComSplitAddress,
};
