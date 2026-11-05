const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const runtime = process.env.RENDERHOP_ELECTRON || '/usr/bin/electron43';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(runtime, [resolve(__dirname, '../dist/src/main.js'), ...process.argv.slice(2)], { stdio: 'inherit', env });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
