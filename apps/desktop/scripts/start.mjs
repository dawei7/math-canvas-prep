// Starts the desktop app from a checkout:  npm run desktop -- [file.pdf | project.mcprep.json]
// - It removes ELECTRON_RUN_AS_NODE from the environment: some terminals (for example the one inside VS Code) set it, and
//   then Electron behaves as plain Node and the app cannot start.
// - npm runs workspace scripts inside the workspace folder; a relative file name is resolved against the folder the
//   command was typed in (npm reports it as INIT_CWD).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const base = env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2).map((value) => (value.startsWith('-') ? value : resolve(base, value)));

const child = spawn(electron, [join(here, '..'), ...args], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
