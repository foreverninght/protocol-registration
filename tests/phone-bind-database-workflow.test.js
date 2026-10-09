'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { restorePhoneBindSession } = require('../src/phone/openai-phone-bind');
const { MemoryRuntimeStateStore } = require('./helpers/memory-runtime-state-store');

test('phone-bind recovery materializes protocol IPC from database state', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-bind-db-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const email = 'recover@example.com';
  const store = new MemoryRuntimeStateStore();
  await store.putPhoneBindWorkflow({
    email,
    workflowStage: 'otp_required',
    state: {
      workflow_stage: 'otp_required',
      phone: '+12025550100',
      session_id: 'session-id',
      sub2_session_id: 'sub2-id',
      cookies: [{ name: 'session', value: 'secret', domain: '.openai.com', path: '/' }],
    },
    cookies: [{ name: 'session', value: 'secret', domain: '.openai.com', path: '/' }],
  });

  const session = await restorePhoneBindSession({
    config: { dataDir, registration: { freepp: {} } },
    account: { email, phoneBindStatus: 'otp_required', phoneBindStateFile: '/missing/legacy.json' },
    phoneBindSettings: { getSecretConfig: () => ({}) },
    runtimeStateStore: store,
  });

  assert.equal(session.accountEmail, email);
  assert.equal(session.phone, '+12025550100');
  assert.equal(fs.existsSync(session.stateFile), true);
  assert.equal(JSON.parse(fs.readFileSync(session.stateFile, 'utf8')).session_id, 'session-id');
});
