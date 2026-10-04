import { VERSION } from '@mcprep/core';
import { COMMANDS } from './registry.js';
import type { CommandSpec, OptionSpec } from './types.js';
import { GLOBAL_OPTIONS } from './commands/common.js';

export const EXIT_CODES: [number, string][] = [
  [0, 'success (a validation with only warnings is still 0)'],
  [1, 'internal error (a bug: please report it)'],
  [2, 'usage error: unknown command or option, missing argument, a value that is not a number'],
  [3, 'a file cannot be used: project, PDF or bundle missing, unreadable or damaged; the PDF is not the one the project was made for; another program holds the lock'],
  [4, 'the request was understood but the data is not acceptable: validation errors (validate, export), a change that would introduce errors, a page or frame that does not exist, a rectangle that is not a valid region, a bundle the importer would reject (import-check), a finding that `exercises verify --fail-on` names (an error by default)'],
];

export function optionLabel(option: OptionSpec): string {
  const short = option.short ? `-${option.short}, ` : '';
  const value = option.type === 'boolean' ? '' : ` ${option.value ?? '<value>'}`;
  return `${short}--${option.name}${value}`;
}

export function usageLine(spec: CommandSpec): string {
  const args = (spec.args ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`) + (arg.variadic ? '...' : '')).join(' ');
  const required = (spec.options ?? []).filter((option) => option.required).map((option) => `--${option.name}${option.type === 'boolean' ? '' : ` ${option.value ?? '<value>'}`}`).join(' ');
  return `mcprep ${spec.name}${args ? ` ${args}` : ''}${required ? ` ${required}` : ''} [options]`;
}

export function commandOptions(spec: CommandSpec): OptionSpec[] {
  const own = spec.options ?? [];
  const names = new Set(own.map((option) => option.name));
  const extra = spec.noProject === true ? [] : GLOBAL_OPTIONS.filter((option) => !names.has(option.name));
  return [...own, ...extra];
}

export function renderCommandHelp(spec: CommandSpec): string {
  const lines = [`mcprep ${spec.name}: ${spec.summary}`, '', `Usage: ${usageLine(spec)}`];
  if (spec.description) lines.push('', spec.description);
  if (spec.args && spec.args.length > 0) {
    lines.push('', 'Arguments:');
    for (const arg of spec.args) lines.push(`  ${arg.name}${arg.variadic ? '...' : ''}${arg.required ? '' : ' (optional)'}  ${arg.description}`);
  }
  const options = commandOptions(spec);
  if (options.length > 0) {
    lines.push('', 'Options:');
    for (const option of options) lines.push(`  ${optionLabel(option)}${option.required ? '  (required)' : ''}`, `      ${option.description}`);
  }
  if (spec.examples && spec.examples.length > 0) lines.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`));
  lines.push('', `With --json the result is: ${spec.output}`);
  return lines.join('\n');
}

export function renderTopHelp(): string {
  const width = Math.max(...COMMANDS.map((spec) => spec.name.length));
  return [
    `mcprep ${VERSION}: mark exercises, parts, context, questions and bookmarks in a PDF and write a bundle for Math Canvas.`,
    '',
    'Usage: mcprep <command> [arguments] [options]      mcprep help <command>',
    '',
    'Commands:',
    ...COMMANDS.map((spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`),
    '',
    'Conventions:',
    '  Pages are ZERO-BASED: the first page is 0. Coordinates are fractions of the page as displayed (after /Rotate),',
    '  origin at the top-left, x to the right, y downwards, all between 0 and 1. Run `mcprep guide` for the full guide.',
    '  Every command accepts --json: one JSON document on standard output, never a prompt. Commands never use the network.',
    '  A book audited as an authority has exercises named by the number the book prints and their section (SECTION:LABEL, for example',
    '  1.2:5a), never cut into parts; sections are the outline entries. `mcprep guide` explains it in chapter 14.',
    '  The project is --project <file>, or $MCPREP_PROJECT, or the only *.mcprep.json in the current folder.',
    '',
    'Exit codes:',
    ...EXIT_CODES.map(([code, text]) => `  ${code}  ${text}`),
  ].join('\n');
}
