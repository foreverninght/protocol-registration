'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
const password = randomBytes(24).toString('hex');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python').replaceAll('\\', '/');
let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
text = text.replace('POSTGRES_PASSWORD=GENERATED_BY_NPM_RUN_SETUP', `POSTGRES_PASSWORD=${password}`)
  .replace('SIGNLIST_DATABASE_URL=GENERATED_BY_NPM_RUN_SETUP', `SIGNLIST_DATABASE_URL=postgresql://registration:${password}@127.0.0.1:54329/registration`)
  .replace(/^FREEPP_PYTHON=.*$/m, `FREEPP_PYTHON=${JSON.stringify(python)}`);
try {
  fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  console.log('Local .env created. Existing databases and services were not changed.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('Local .env already exists; kept unchanged.');
  else throw error;
}
