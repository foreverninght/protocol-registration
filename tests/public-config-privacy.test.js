'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { RegistrationChangeEmailSettings, DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS } = require('../src/registration/change-email-settings');
const { PhoneBindSettings, DEFAULT_PHONE_BIND_SETTINGS } = require('../src/phone/phone-bind-settings');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

test('personal mailbox and Sub2API destinations start empty and preserve explicit configuration', async () => {
  assert.equal(DEFAULT_REGISTRATION_CHANGE_EMAIL_SETTINGS.domain, '');
  assert.equal(DEFAULT_PHONE_BIND_SETTINGS.sub2BaseUrl, '');
  const store = new MemoryRuntimeStateStore();
  const email = new RegistrationChangeEmailSettings({ store });
  const phone = new PhoneBindSettings({ store });
  await email.initialize();
  await phone.initialize();
  assert.equal(email.getSecretConfig().domain, '');
  assert.equal(phone.getSecretConfig().sub2BaseUrl, '');
  await email.update({ domain: 'mail.example.test' });
  await phone.update({ sub2BaseUrl: 'https://sub2.example.test/' });
  assert.equal(email.getSecretConfig().domain, 'mail.example.test');
  assert.equal(phone.getSecretConfig().sub2BaseUrl, 'https://sub2.example.test');
});

test('public destination placeholders use reserved examples and hidden destinations are empty', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const [id, expected] of Object.entries({
    registrationChangeEmailDomain: 'example.test',
    cfBaseUrl: 'https://mail.example.test',
    phoneBindSub2BaseUrl: 'https://sub2.example.test',
  })) {
    const element = html.split('id="' + id + '"')[1].split('>')[0];
    assert.ok(element.includes('placeholder="' + expected + '"'));
  }
  for (const id of ['refiningPublicServiceBaseUrl', 'refiningGcTacmonServiceBaseUrl']) {
    const element = html.split('id="' + id + '"')[1].split('>')[0];
    assert.ok(element.includes('value=""'));
  }
});

test('all HTML placeholder and value URLs and email examples use reserved hosts', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const isReserved = (host) => /(^|[.])(test|example|invalid|localhost|example[.]com|example[.]net|example[.]org)$/.test(host)
    || host === '127.0.0.1' || host === '[::1]';
  for (const attr of html.matchAll(/(?:placeholder|value)="([^"]*)"/g)) {
    for (const match of attr[1].matchAll(/https?:[/][/][^ "'<>]+/g)) {
      assert.ok(isReserved(new URL(match[0]).hostname), 'URL example must use a reserved host');
    }
    for (const match of attr[1].matchAll(/[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+[.][a-zA-Z]{2,})/g)) {
      assert.ok(isReserved(match[1]), 'Email example must use a reserved host');
    }
  }
});

test('external refining destinations are empty unless explicitly configured', () => {
  const settingsPath = require.resolve('../src/refining/settings');
  const code = 'const s = require(' + JSON.stringify(settingsPath) + '); console.log(JSON.stringify([s.PUBLIC_REFINING_BASE_URL, s.GC_TACMON_BASE_URL]));';
  const read = (publicUrl, gcUrl) => JSON.parse(execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_REFINING_BASE_URL: publicUrl, GC_TACMON_BASE_URL: gcUrl },
  }));
  assert.deepEqual(read('', ''), ['', '']);
  assert.deepEqual(read('https://public.example.test/', 'https://gc.example.test/'), ['https://public.example.test', 'https://gc.example.test']);
});

test('missing refining destinations fail before network or browser work', () => {
  const clientPath = require.resolve('../src/refining/pay153-client');
  const code = [
    'const assert = require("node:assert/strict");',
    'const { Pay153Client } = require(' + JSON.stringify(clientPath) + ');',
    '(async () => {',
    'let requests = 0;',
    'const client = new Pay153Client({ fetchImpl: async () => { requests++; throw new Error("unexpected network"); } });',
    'await assert.rejects(client.publicJson({}, "/api/test", {}), /PUBLIC_REFINING_BASE_URL is not configured/);',
    'await assert.rejects(client.gcTacmonJson({}, "/api/test"), /GC_TACMON_BASE_URL is not configured/);',
    'await assert.rejects(client.startGcTacmonBatchInBrowser({}, {}), /GC_TACMON_BASE_URL is not configured/);',
    'const state = {};',
    'await client.consumePublicStream("test-batch", state);',
    'assert.match(state.error.message, /PUBLIC_REFINING_BASE_URL is not configured/);',
    'assert.equal(requests, 0);',
    '})().catch(error => { console.error(error); process.exitCode = 1; });',
  ].join(' ');
  execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, PUBLIC_REFINING_BASE_URL: '', GC_TACMON_BASE_URL: '' },
  });
});
