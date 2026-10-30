'use strict';
// Explicit inputs keep release staging folders from being discovered as duplicate tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'app/lib')).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join(root, 'app/lib', name));
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
