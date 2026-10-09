'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('all Python sidecars exist at their single runtime paths', () => {
  const root = path.resolve(__dirname, '..');
  const scripts = [
    'tools/freepp_register_bridge.py',
    'tools/setup_openai_totp_2fa.py',
    'tools/openai_phone_bind_protocol.py',
    'tools/renew_chatgpt_session_cookie.py',
  ];
  for (const relative of scripts) {
    const file = path.join(root, relative);
    assert.equal(fs.existsSync(file), true, `missing runtime script: ${file}`);
    assert.ok(fs.statSync(file).size > 0, `empty runtime script: ${file}`);
  }
});
