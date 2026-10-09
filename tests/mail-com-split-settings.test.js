'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseMainAccountLine } = require('../src/mailbox/mail-com-split-settings');

test('mail.com main account import accepts documented and pipe formats', () => {
  assert.deepEqual(parseMainAccountLine('User@mail.com----pass-word'), {
    email: 'user@mail.com',
    password: 'pass-word',
  });
  assert.deepEqual(parseMainAccountLine('User@mail.com|pass|with|pipes'), {
    email: 'user@mail.com',
    password: 'pass|with|pipes',
  });
});

test('mail.com main account import rejects incomplete rows', () => {
  assert.equal(parseMainAccountLine('user@mail.com'), null);
  assert.equal(parseMainAccountLine('user@mail.com|'), null);
  assert.equal(parseMainAccountLine('|password'), null);
});

test('mailbox import preserves password whitespace as part of the credential', () => {
  assert.deepEqual(parseMainAccountLine(' User@mail.com----  fixture-password  '), {
    email: 'user@mail.com', password: '  fixture-password  ',
  });
});
