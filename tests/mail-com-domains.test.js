'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDomainsResponse } = require('../tools/mail_com_split_mailbox');

test('mail.com domain response includes active and hidden historical domains', () => {
  const domains = parseDomainsResponse(JSON.stringify({
    domains: [
      { domain: 'mail.com', state: 'ACTIVE' },
      { domain: 'samerica.com', state: 'DEACTIVATED' },
      { domain: 'MAIL.COM', state: 'DEACTIVATED' },
      { domain: 'invalid domain', state: 'ACTIVE' },
    ],
  }));

  assert.deepEqual(domains, [
    { domain: 'mail.com', state: 'ACTIVE' },
    { domain: 'samerica.com', state: 'DEACTIVATED' },
  ]);
});
