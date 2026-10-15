// Creates missing workspace directories defined in audit.config.json or audit.config.example.json.
// Completely non-destructive: never deletes or overwrites existing files or directories.
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const configArg = process.argv[2];
const candidates = [configArg, 'audit.config.json', 'audit.config.example.json'].filter(Boolean);
let configPath;
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    configPath = resolve(candidate);
    break;
  }
}

let config = {};
if (configPath) {
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
    console.log(`Using configuration: ${configPath}`);
  } catch (err) {
    console.error(`Cannot parse ${configPath}: ${err.message}`);
    process.exit(1);
  }
} else {
  console.log('No audit.config.json found; using standard default directories.');
}

const dirs = config.directories ?? {
  inbox: './inbox',
  audit_work: './audit',
  batch_results: './results',
  delivered_bundles: './bundles',
};

console.log('Checking workspace directories (non-destructive):');
for (const [key, dir] of Object.entries(dirs)) {
  const abs = resolve(dir);
  if (existsSync(abs)) {
    console.log(`  ✓ exists:  ${dir} (${key})`);
  } else {
    await mkdir(abs, { recursive: true });
    console.log(`  + created: ${dir} (${key})`);
  }
}
console.log('All directories ready (nothing overwritten or deleted).');

