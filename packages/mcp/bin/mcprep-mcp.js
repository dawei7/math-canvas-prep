#!/usr/bin/env node
// An MCP server over stdio. Optional: --project <file> sets the project to work on until a tool says otherwise.
import { runStdio } from '../dist/index.js';

const args = process.argv.slice(2);
const at = args.indexOf('--project');
const project = at >= 0 ? args[at + 1] : undefined;
if (args.includes('--help') || args.includes('-h')) {
  process.stderr.write('mcprep-mcp: an MCP server (stdio) for Math Canvas Prep.\nUsage: mcprep-mcp [--project <file.mcprep.json>]\nSee docs/MCP.md for how to register it in a client.\n');
} else {
  await runStdio(project !== undefined ? { project } : {});
}
