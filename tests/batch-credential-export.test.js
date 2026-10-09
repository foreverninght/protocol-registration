'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('async function copySelectedCredentials(category) {');
const end = source.indexOf('\nasync function checkSelectedWorkflowAccessTokensLive()', start);

function fixture() {
  const feedback = {};
  const copies = [];
  const context = vm.createContext({
    state: {}, $: () => feedback,
    selectedWorkflowRows: () => [1, 2].map(id => ({entry: {email: `user${id}@example.test`}, account: {}})),
    credentialExportUnavailableReason: () => '', runEmailCategory: () => 'ic',
    updateCopySelectedAtButtons() {}, renderEmailRunStatus() {},
    api: {get: async () => {throw new Error('fixture read failed');}},
    copyTextToClipboard: async text => copies.push(text), showCredentialExportCopyFallback() {},
  });
  vm.runInContext(source.slice(start, end), context);
  return {context, copies, feedback};
}

test('batch credential export releases its lock when every account read fails and can retry', async () => {
  const {context, copies} = fixture();
  await context.copySelectedCredentials('ic');
  assert.equal(context.state.bulkCopyingCredentials, false);
  assert.equal(copies.length, 0);
  context.api.get = async url => ({exportText: url.includes('user1') ? 'user1@example.test----fixture----FIXTURE1' : 'user2@example.test----fixture----FIXTURE2'});
  await context.copySelectedCredentials('ic');
  assert.equal(context.state.bulkCopyingCredentials, false);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].split('\n').length, 2);
});

test('batch export keeps successful rows after a partial failure and resets on fallback errors', async () => {
  const {context, copies, feedback} = fixture();
  context.api.get = async url => {if(url.includes('user1'))return {exportText:'fixture-export'};throw new Error('fixture');};
  await context.copySelectedCredentials('ic');
  assert.deepEqual(copies, ['fixture-export']);
  assert.match(feedback.textContent, /跳过 1/);
  context.copyTextToClipboard = async () => {throw new Error('clipboard fixture');};
  context.showCredentialExportCopyFallback = () => {throw new Error('fallback fixture');};
  await assert.rejects(context.copySelectedCredentials('ic'), /fallback fixture/);
  assert.equal(context.state.bulkCopyingCredentials, false);
});
