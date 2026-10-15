// Opens a workspace folder in Windows File Explorer or native system file manager.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const targetArg = process.argv[2] ?? 'inbox';
let config = {};
const configPath = existsSync('audit.config.json') ? 'audit.config.json' : 'audit.config.example.json';
if (existsSync(configPath)) {
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    // Ignore invalid config; default fallback paths will be used.
  }
}

const dirs = config.directories ?? {
  inbox: './inbox',
  audit_work: './audit',
  batch_results: './results',
  delivered_bundles: './bundles',
};

const map = {
  inbox: dirs.inbox,
  work: dirs.audit_work,
  audit: dirs.audit_work,
  audit_work: dirs.audit_work,
  results: dirs.batch_results,
  batch_results: dirs.batch_results,
  bundles: dirs.delivered_bundles,
  delivered_bundles: dirs.delivered_bundles,
};

const folderPath = resolve(map[targetArg] ?? targetArg);

console.log(`Opening in File Explorer: ${folderPath}`);

if (process.platform === 'win32') {
  spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' }).unref();
} else if (process.platform === 'darwin') {
  spawn('open', [folderPath], { detached: true, stdio: 'ignore' }).unref();
} else {
  spawn('xdg-open', [folderPath], { detached: true, stdio: 'ignore' }).unref();
}
