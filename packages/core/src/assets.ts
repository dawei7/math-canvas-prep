import { readFile } from 'node:fs/promises';
import { McPrepError } from './rules/issues.js';

/**
 * The JSON schemas and the agent guide ship with the tools. In a checkout they live in `schemas/` and `docs/` at the
 * repository root; a build copies them next to the compiled code (`dist/schemas`, `dist/docs`) so that an installed
 * package finds them too.
 */
export const SCHEMA_NAMES = ['bundle-manifest', 'frames', 'outline', 'project', 'book-summary', 'verify', 'sample'] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

async function firstReadable(candidates: string[], what: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      return await readFile(new URL(candidate, import.meta.url), 'utf8');
    } catch {
      // try the next place
    }
  }
  throw new McPrepError('E_ASSET', `Cannot find ${what} next to the tools.`, { hint: 'Run `npm run build` in the repository, or read the file in the repository\'s schemas/ and docs/ folders.' });
}

export async function readSchema(name: SchemaName): Promise<object> {
  const file = `${name}.schema.json`;
  const text = await firstReadable([`./schemas/${file}`, `../schemas/${file}`, `../../../schemas/${file}`], `the schema ${file}`);
  return JSON.parse(text) as object;
}

export function isSchemaName(name: string): name is SchemaName {
  return (SCHEMA_NAMES as readonly string[]).includes(name);
}

export async function readAgentGuide(): Promise<string> {
  return firstReadable(['./docs/AGENT_GUIDE.md', '../docs/AGENT_GUIDE.md', '../../../docs/AGENT_GUIDE.md'], 'docs/AGENT_GUIDE.md');
}
