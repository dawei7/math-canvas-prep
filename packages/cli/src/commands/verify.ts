import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifySession, type VerifyFinding, type VerifyReport } from '@mcprep/core';
import { flag, listOption, stringOption, usage } from '../args.js';
import { plural, tableLimited, TEXT_LIMIT } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { GLOBAL_OPTIONS } from './common.js';

/**
 * `exercises verify`: the text-only quality check of an audited book. The check itself is `verifyProject` in the core; this is
 * the command: its options, the text a person reads, the file with the whole report and the exit code.
 */

/** The most findings the JSON result of the command carries; the report in `--details` always has all of them. */
export const FINDINGS_IN_RESULT = 300;

const FAIL_ON = ['error', 'warning', 'none'] as const;
type FailOn = (typeof FAIL_ON)[number];

/** The sections named with --section, repeated or separated by commas. */
export function sectionIds(context: CommandContext): string[] {
  return listOption(context.options, 'section')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** The regular expressions of --item-pattern (group 1 is the label), as `exercises propose` reads them. */
export function itemPatterns(context: CommandContext): RegExp[] {
  return listOption(context.options, 'item-pattern').map((source) => {
    try {
      const regex = new RegExp(source, 'u');
      // How many capture groups the expression has: an empty alternative always matches and shows them.
      const groups = (new RegExp(`${source}|`, 'u').exec('') as RegExpExecArray).length - 1;
      if (groups < 1) throw new Error('it has no group for the label');
      return regex;
    } catch (error) {
      throw usage(`--item-pattern "${source}" is not usable: ${(error as Error).message}.`, 'It must be a regular expression with a group for the label (group 1).');
    }
  });
}

function failOn(context: CommandContext): FailOn {
  const value = stringOption(context.options, 'fail-on') ?? 'error';
  if (!(FAIL_ON as readonly string[]).includes(value)) throw usage(`--fail-on must be error, warning or none, not "${value}".`);
  return value as FailOn;
}

const percent = (part: number, whole: number): string => (whole === 0 ? '0%' : `${Math.round((part / whole) * 1000) / 10}%`);

function findingLines(findings: readonly VerifyFinding[], limit: number): string[] {
  const lines = findings.slice(0, limit).flatMap((finding) => [
    `${finding.severity} [${finding.code}] ${finding.ref}${finding.page !== null ? ` (page ${finding.page})` : ''}: ${finding.message}`,
    ...(finding.evidence.length > 0 ? [`    found: ${finding.evidence}`] : []),
  ]);
  if (findings.length > limit) lines.push(`... and ${findings.length - limit} more (--details FILE writes them all)`);
  return lines;
}

export function verifyText(report: VerifyReport): string {
  const { summary } = report;
  if (summary.exercises === 0) return 'There are no exercises to check: add them first (`mcprep exercises propose --apply`), or name a section that has some.';
  const head = [
    `Checked ${plural(summary.exercises, 'exercise')}${summary.authoritative !== summary.exercises ? ` (${summary.authoritative} from a book)` : ''} in ${plural(summary.sections, 'section')}:`,
    `${plural(summary.errors, 'error')}, ${plural(summary.warnings, 'warning')}, ${plural(summary.infos, 'info', 'infos')}.`,
    summary.authoritative > 0 ? `${summary.solutions} of ${summary.authoritative} book exercises have a solution (${percent(summary.solutions, summary.authoritative)}).` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const rows = report.sections.map((section) => [
    section.id,
    section.label ?? '',
    String(section.exercises),
    section.firstLabel !== null ? `${section.firstLabel}..${section.lastLabel as string}` : '',
    `${section.withSolution}/${section.exercises}`,
    section.gaps.length > 0 ? `${section.gaps.slice(0, 6).join(',')}${section.gaps.length > 6 ? ',...' : ''}` : '',
    section.duplicates.join(','),
  ]);
  const parts = [head];
  if (rows.length > 0) parts.push(tableLimited(rows, ['section', 'label', 'exercises', 'numbers', 'answers', 'missing', 'repeated'], 120));
  if (report.findings.length > 0) parts.push(findingLines(report.findings, TEXT_LIMIT).join('\n'));
  else parts.push('Nothing to report.');
  return parts.join('\n');
}

export const exercisesVerify: CommandSpec = {
  name: 'exercises verify',
  summary: 'Check the audited exercises against the text layer of the PDF, without looking: the same list for every agent.',
  description:
    'Reads the project on disk and the text layer of its PDF (no pixels, no network) and reports what a person would find by looking at the crops, in a fixed order (errors, warnings, infos; by code; by the order of the book): an exercise whose region does not start with its number (read at the left margin, so a numerator or a figure label above the number does not count), an answer region that holds another number, regions that lie on each other or are the same, a region that is too large, too narrow or too small, an unknown section or a page outside its section, numbers that are missing, repeated, out of order in their column or far above the rest of their section, and sections with few or no answers. Every finding has a code, a severity, the reference of the exercise (SECTION:LABEL), the page, a message and the evidence (the first 40 characters found, the numbers measured). The codes, their thresholds and what to do about each are in docs/AUDIT_A_BOOK.md. `--details FILE` writes the whole report (format math-canvas-verify, see `mcprep schema verify`); the JSON result carries the first 300 findings and says how many it left out. The exit code is 4 when there is a finding of the severity `--fail-on` names or a worse one (default: an error). Nothing is changed.',
  options: [
    { name: 'section', type: 'string', value: '<id>', multiple: true, description: 'Only the exercises filed under this section (an outline entry id); repeat the option, or separate the ids with commas. Ordinary exercises are then left out.' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write the whole report as JSON (every finding, every section), in the format math-canvas-verify.' },
    { name: 'ink', type: 'boolean', description: 'Also render the pages (each page that has a region, once) and report every region whose top, bottom, left or right edge runs through printed ink (`edge-on-ink`, a warning, the worst first). Slower: it draws the pages.' },
    { name: 'fail-on', type: 'string', value: 'error|warning|none', description: 'Exit with code 4 when there is a finding of this severity or a worse one: error (the default), warning, or none (always 0).' },
    {
      name: 'item-pattern',
      type: 'string',
      multiple: true,
      value: '<regex>',
      description: 'How the number of an exercise or an answer starts a line, for a book that does not print `5.`, `5)` or `(5)`: a regular expression with the label as printed in group 1 (the same option as `exercises propose`); repeatable. It adds to what is read by default.',
    },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises verify', 'mcprep exercises verify --section 1.2 --section 1.3', 'mcprep exercises verify --details verify.json --fail-on warning', 'mcprep exercises verify --ink', "mcprep exercises verify --item-pattern '^Lösung\\s+(\\d+(?:\\.\\d+)*)'", 'mcprep exercises verify --json'],
  output:
    '{ format: "math-canvas-verify", version: 1, summary: { exercises, authoritative, sections, solutions, errors, warnings, infos }, findings: [{ code, severity, ref, page, message, evidence }] (the first 300; findingsOmitted: n says how many more the --details file has), sections: [{ id, label, exercises, firstLabel, lastLabel, withSolution, gaps, duplicates }] }; the exit code is 4 when --fail-on is met',
  async run(context) {
    const session = await context.session();
    const threshold = failOn(context);
    const ids = sectionIds(context);
    const patterns = itemPatterns(context);
    const report = await verifySession(session, { ...(ids.length > 0 ? { sections: ids } : {}), ...(patterns.length > 0 ? { itemPatterns: patterns } : {}), ...(flag(context.options, 'ink') ? { ink: true } : {}) });
    const details = stringOption(context.options, 'details');
    if (details !== undefined) await writeFile(resolve(context.io.cwd, details), `${JSON.stringify(report, null, 1)}\n`);
    const cut = report.findings.length > FINDINGS_IN_RESULT;
    const result = cut ? { ...report, findings: report.findings.slice(0, FINDINGS_IN_RESULT), findingsOmitted: report.findings.length - FINDINGS_IN_RESULT } : report;
    const failed = threshold === 'error' ? report.summary.errors > 0 : threshold === 'warning' ? report.summary.errors + report.summary.warnings > 0 : false;
    const text = [verifyText(report), ...(details !== undefined ? [`Wrote the whole report to ${details}.`] : [])].join('\n');
    return { result, text, ...(failed ? { exitCode: 4 } : {}), notes: [] };
  },
};
