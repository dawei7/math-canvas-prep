#!/usr/bin/env node
// An MCP server over stdio. Optional: --project <file> sets the project to work on until a tool says otherwise;
// --call-log <file> (or the environment variable MCPREP_CALL_LOG) appends every tool call to a file, one line of JSON each.
import { runStdio } from '../dist/index.js';

const args = process.argv.slice(2);

/** The value of `--name <value>` or `--name=<value>`, or undefined. */
function option(name) {
  const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) return undefined;
  const arg = args[at];
  return arg === name ? args[at + 1] : arg.slice(name.length + 1);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stderr.write(
    'mcprep-mcp: an MCP server (stdio) for Math Canvas Prep.\n' +
      'Usage: mcprep-mcp [--project <file.mcprep.json>] [--call-log <file>]\n' +
      '  --call-log <file>  append every tool call to this file as one line of JSON (or set MCPREP_CALL_LOG)\n' +
      'See docs/MCP.md for how to register it in a client.\n',
  );
} else {
  const project = option('--project');
  const callLog = option('--call-log');
  await runStdio({ ...(project !== undefined ? { project } : {}), ...(callLog !== undefined ? { callLog } : {}) });
}
