'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRegistrationCandidates } = require('../src/registration/candidate-parser');

test('registration candidate parser preserves mailbox URLs and reports invalid input', () => {
  const result = parseRegistrationCandidates([
    'Manual@Example.com',
    'share@example.net----https://mail.example.test/share/abc',
    'https://mail.example.test/share/url-only%40example.org',
    'manual@example.com',
    'not-an-email',
  ].join('\n'));

  assert.deepEqual(result.candidates, [
    { email: 'manual@example.com', mailboxUrl: null, mailboxSource: 'manual' },
    {
      email: 'share@example.net',
      mailboxUrl: 'https://mail.example.test/share/abc',
      mailboxSource: 'share_page',
    },
    {
      email: 'url-only@example.org',
      mailboxUrl: 'https://mail.example.test/share/url-only%40example.org',
      mailboxSource: 'share_page',
    },
  ]);
  assert.deepEqual(result.duplicateLines, [{ line: 4, email: 'manual@example.com' }]);
  assert.deepEqual(result.rejected, [{ line: 5, reason: 'email_not_found' }]);
});
