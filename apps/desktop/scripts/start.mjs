// Starts the desktop app from a checkout:  npm run start --workspace @mcprep/desktop -- [file.pdf | project.mcprep.json]
// It removes ELECTRON_RUN_AS_NODE from the environment: some terminals (for example the one inside VS Code) set it, and then
// Electron behaves as plain Node and the app cannot start.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [join(here, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
