// Removes build output (dist, out, release, tsbuildinfo). Never touches sources, examples or node_modules.
import { rmSync } from 'node:fs';

const targets = [
  'packages/core/dist',
  'packages/cli/dist',
  'packages/mcp/dist',
  'apps/desktop/out',
  'apps/desktop/release',
  'coverage',
];
for (const target of targets) {
  rmSync(new URL(`../${target}`, import.meta.url), { recursive: true, force: true });
  console.log(`removed ${target}`);
}
