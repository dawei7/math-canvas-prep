// Rewrites the registry host in package-lock.json to the public npm registry.
//
// If you install through a mirror (for example `registry=https://registry.npmmirror.com` in your .npmrc), npm records
// the mirror's address in package-lock.json. The tarballs and their integrity hashes are identical, but the committed
// lockfile should name the canonical registry. Run this before committing a changed lockfile:
//
//   node scripts/fix-lockfile.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../package-lock.json', import.meta.url);
const before = readFileSync(path, 'utf8');
const mirrors = ['https://registry.npmmirror.com/', 'https://registry.npm.taobao.org/', 'https://mirrors.cloud.tencent.com/npm/'];
let after = before;
for (const mirror of mirrors) after = after.split(mirror).join('https://registry.npmjs.org/');
if (after !== before) {
  writeFileSync(path, after);
  console.log('package-lock.json now names https://registry.npmjs.org/');
} else {
  console.log('package-lock.json already names https://registry.npmjs.org/');
}
