'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const localPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = fs.existsSync(localPython) ? localPython : (process.env.FREEPP_PYTHON || 'python');
const directory = process.argv.includes('--worker') ? 'python/rebind_worker' : 'tests';
const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], {
  cwd: root, stdio: 'inherit', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
