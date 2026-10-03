// Generates docs/CLI.md from the command definitions of the command line, so that the reference is exact.
// Run after `npm run build`:   npm run docs:cli
import { writeFileSync } from 'node:fs';
import { COMMANDS, EXIT_CODES, commandOptions, optionLabel, usageLine } from '../packages/cli/dist/index.js';

const out = new URL('../docs/CLI.md', import.meta.url);

const preface = `# Command line reference: \`mcprep\`

\`mcprep\` marks exercises, parts, context, questions and bookmarks in a PDF and writes a bundle for the Android app. It is made
for scripts and AI agents as much as for people: no prompts, no network, every command can print one JSON document, and the
exit code says what happened. (This file is generated from the command definitions by \`npm run docs:cli\`; do not edit it.)

Run it from the repository as \`npx mcprep <command>\` or \`node packages/cli/bin/mcprep.js <command>\` after \`npm install\` and
\`npm run build\`. \`mcprep help\` lists the commands, \`mcprep help <command>\` explains one, \`mcprep guide\` prints the
[agent guide](AGENT_GUIDE.md).

## Conventions

- **Pages are zero-based**: the first page is \`0\`. Every \`--page\`, every page argument and every \`page\` in JSON.
- **Coordinates** are fractions of the page *as displayed* (after the page's own \`/Rotate\`), origin at the **top-left**, \`x\` to
  the right, \`y\` downwards, all between 0 and 1. A rectangle is written \`left,top,right,bottom\` on the command line and
  \`{ "left": .., "top": .., "right": .., "bottom": .. }\` in JSON (an array \`[l,t,r,b]\` is accepted as input).
- **Labels** such as \`E4.2\`, \`Q1\`, \`B3\` are computed from position and never stored. Refer to a frame by its **id**
  (\`f3\`), which does not change when other frames are added.
- **The project** is \`--project <file>\` (or a folder holding exactly one), else \`$MCPREP_PROJECT\`, else the only
  \`*.mcprep.json\` in the current folder.
- **Changes are atomic.** A command that writes the project reads it fresh under a lock, applies the change in memory,
  validates once and writes only if the change did not introduce validation errors (\`--force\` overrides, \`--dry-run\` previews).
- **Images** (\`render\`, \`crop\`) are written as PNG files, by default into \`.mcprep-cache/\` next to the project; the JSON
  result names the path. Open them with an image viewer: that is how a model checks its work.

## JSON output

With \`--json\` the only thing written to standard output is one document:

\`\`\`json
{ "ok": true, "command": "frames add", "result": { }, "warnings": [ ], "notes": [ ] }
\`\`\`

- \`ok\` is \`true\` exactly when the exit code is 0. \`result\` holds the data of the command (described under each command below).
- \`warnings\` lists validation warnings (when there are any) and \`notes\` short sentences about what happened (what snapping did,
  what was enlarged).
- On failure the document is \`{ "ok": false, "command": "...", "error": { "code", "message", "hint"?, "issues"?, "details"? } }\`
  and standard error stays empty. \`error.code\` is stable (\`E_PAGE\`, \`E_RECT_RANGE\`, \`E_REJECTED\`, \`E_VALIDATION\`, \`E_PDF_CHANGED\`,
  \`E_USAGE\`, ...); \`hint\` says what to do; \`issues\` are validation issues (each with \`code\`, \`message\`, \`frameId?\`, \`fix?\`).
- \`validate\` and \`import-check\` exit with 4 when they find errors, and then still put the details in \`result\`.
- Without \`--json\` the output is plain text for people (errors go to standard error).

A **validation issue** is \`{ "severity": "error" | "repair" | "warning", "code", "message", "frameId"?, "unit"?, "page"?, "fix"? }\`.
**Errors** are what the importer rejects, **repairs** what it fixes silently, **warnings** what is allowed but suspicious.

## Exit codes

| Code | Meaning |
| --- | --- |
${EXIT_CODES.map(([code, text]) => `| ${code} | ${text} |`).join('\n')}

## Commands

${COMMANDS.map((spec) => `- [\`${spec.name}\`](#${spec.name.replace(/ /g, '-')}): ${spec.summary}`).join('\n')}
`;

const sections = COMMANDS.map((spec) => {
  const lines = [`## ${spec.name}`, '', spec.summary, '', '```', usageLine(spec), '```', ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.args && spec.args.length > 0) {
    lines.push('Arguments:', '');
    for (const arg of spec.args) lines.push(`- \`${arg.name}${arg.variadic ? '...' : ''}\`${arg.required ? '' : ' (optional)'}: ${arg.description}`);
    lines.push('');
  }
  const options = commandOptions(spec).filter((option) => spec.noProject !== true || option.name === 'json' || option.name === 'help' || !['project', 'ignore-pdf-change'].includes(option.name));
  if (options.length > 0) {
    lines.push('Options:', '');
    for (const option of options) lines.push(`- \`${optionLabel(option)}\`${option.required ? ' (required)' : ''}: ${option.description}`);
    lines.push('');
  }
  if (spec.examples && spec.examples.length > 0) lines.push('Examples:', '', '```console', ...spec.examples.map((example) => `$ ${example}`), '```', '');
  lines.push(`With \`--json\`, \`result\` is: \`${spec.output}\``, '');
  return lines.join('\n');
});

writeFileSync(out, `${preface}\n${sections.join('\n')}`);
console.log(`wrote docs/CLI.md (${COMMANDS.length} commands)`);
