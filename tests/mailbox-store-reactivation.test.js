'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MailboxStore } = require('../src/db/mailbox-store');

test('explicit mailbox upsert reactivates a retired main account without resetting active sessions', async () => {
  let statement = '';
  const pool = {
    async query(sql) {
      statement = sql;
      return {
        rows: [{
          id: 'mailbox-1',
          provider: 'mail_com',
          email: 'main@mail.com',
          password: 'secret',
          session_status: 'closed',
          auto_alias_enabled: false,
          last_opened_at: null,
          last_error: '',
          alias_count: 0,
          domain_count: 0,
          active_domain_count: 0,
          created_at: '2026-09-11T00:00:00.000Z',
          updated_at: '2026-09-11T00:00:00.000Z',
          retired_at: null,
          retirement_reason: '',
        }],
      };
    },
  };

  const store = new MailboxStore({ pool });
  const mailbox = await store.upsertMailbox({
    provider: 'mail_com',
    email: 'main@mail.com',
    password: 'secret',
  });

  assert.equal(mailbox.retiredAt, null);
  assert.match(statement, /session_status = case when mailboxes\.retired_at is null then mailboxes\.session_status else 'closed' end/u);
  assert.match(statement, /retired_at = null/u);
  assert.match(statement, /retirement_reason = ''/u);
});
