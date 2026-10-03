import { SCHEMA_NAMES, isSchemaName, readAgentGuide, readSchema } from '@mcprep/core';
import { usage } from '../args.js';
import type { CommandSpec } from '../types.js';

export const schema: CommandSpec = {
  name: 'schema',
  summary: 'Print a JSON Schema: bundle-manifest, frames, outline or project.',
  noProject: true,
  args: [{ name: 'name', description: `One of ${SCHEMA_NAMES.join(', ')}. Without a name the available schemas are listed.` }],
  options: [{ name: 'json', type: 'boolean', description: 'Wrap the output in the usual JSON document.' }, { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' }],
  examples: ['mcprep schema frames', 'mcprep schema'],
  output: '{ name, schema } or { schemas: string[] }',
  async run(context) {
    const name = context.args[0];
    if (name === undefined) return { result: { schemas: [...SCHEMA_NAMES] }, text: SCHEMA_NAMES.join('\n') };
    if (!isSchemaName(name)) throw usage(`There is no schema "${name}".`, `Choose one of ${SCHEMA_NAMES.join(', ')}.`);
    const schemaDocument = await readSchema(name);
    return { result: { name, schema: schemaDocument }, text: JSON.stringify(schemaDocument, null, 2) };
  },
};

export const guide: CommandSpec = {
  name: 'guide',
  summary: 'Print the guide for AI agents that mark a PDF with this tool.',
  description: 'The same text as docs/AGENT_GUIDE.md: the coordinate system, the workflow, the rules for deciding what to mark, and a checklist.',
  noProject: true,
  options: [{ name: 'json', type: 'boolean', description: 'Wrap the text in the usual JSON document.' }, { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' }],
  examples: ['mcprep guide'],
  output: '{ markdown }',
  async run() {
    const markdown = await readAgentGuide();
    return { result: { markdown }, text: markdown };
  },
};
