// Copies the JSON schemas and the agent guide next to the compiled core, so that an installed package finds them
// (packages/core/dist/schemas and packages/core/dist/docs). Run by the core build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const dist = new URL('packages/core/dist/', root);
mkdirSync(new URL('schemas/', dist), { recursive: true });
cpSync(new URL('schemas/', root), new URL('schemas/', dist), { recursive: true });
const guide = new URL('docs/AGENT_GUIDE.md', root);
if (existsSync(guide)) {
  mkdirSync(new URL('docs/', dist), { recursive: true });
  cpSync(guide, new URL('docs/AGENT_GUIDE.md', dist));
}
