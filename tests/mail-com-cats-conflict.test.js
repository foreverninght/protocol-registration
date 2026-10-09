'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mailComMainAccountCatsConflict } = require('../src/app/server');

test('only a CATS request conflict paired with HTTP 409 retires a main mailbox', () => {
  assert.equal(mailComMainAccountCatsConflict(new Error(
    '添加分裂邮箱失败 (HTTP 409): urn:problem:mam:cats:request-conflict masked by CATS',
  )), true);
  assert.equal(mailComMainAccountCatsConflict(new Error('添加分裂邮箱失败 (HTTP 409): address exists')), false);
  assert.equal(mailComMainAccountCatsConflict(new Error('HTTP 500 masked by CATS')), false);
});
