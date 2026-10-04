import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McPrepError, verifySession, type VerifyFinding, type VerifyReport } from '@mcprep/core';
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

const REPLACEMENT = String.fromCharCode(0xfffd);
/** UTF-8 read as Latin-1: a letter such as o with a diaeresis arrives as two characters, the first of them 0xC2 or 0xC3. */
const MOJIBAKE = new RegExp(`[${String.fromCharCode(0xc2)}${String.fromCharCode(0xc3)}][${String.fromCharCode(0x80)}-${String.fromCharCode(0xbf)}]`);

/** Why a pattern cannot be what was typed: a shell that could not pass a letter on puts U+FFFD in its place, or hands UTF-8 over as Latin-1. */
function encodingProblem(source: string): string | undefined {
  if (source.includes(REPLACEMENT)) return 'it holds the character U+FFFD, which stands for a letter that did not arrive intact';
  if (MOJIBAKE.test(source)) return 'it holds characters that look like UTF-8 read as Latin-1 (two characters in place of one letter)';
  return undefined;
}

/**
 * The regular expressions of --item-pattern and of the lines of --item-pattern-file (a UTF-8 file, one expression to a line); group 1 is
 * the label, as `exercises propose` reads them. A letter outside ASCII can be written as an escape (\u00f6) when the shell mangles it.
 */
export async function itemPatterns(context: CommandContext): Promise<RegExp[]> {
  const sources = [...listOption(context.options, 'item-pattern')];
  for (const file of listOption(context.options, 'item-pattern-file')) {
    let text: string;
    try {
      text = await readFile(resolve(context.io.cwd, file), 'utf8');
    } catch (error) {
      throw new McPrepError('E_FILE', `Cannot read the file of patterns "${file}": ${(error as Error).message}`, { hint: 'It is a UTF-8 text file with one regular expression to a line (group 1 is the label).' });
    }
    sources.push(...(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
  }
  return sources.map((source) => {
    const mangled = encodingProblem(source);
    if (mangled !== undefined) {
      throw usage(`--item-pattern "${source}" cannot be what was meant: ${mangled}.`, 'Write the letter as an escape (\\u00f6 for the letter o with a diaeresis), or put the pattern in a UTF-8 file and give it with --item-pattern-file.');
    }
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
    'Reads the project on disk and the text layer of its PDF (no pixels, no network) and reports what a person would find by looking at the crops, in a fixed order (errors, warnings, infos; by code; by the order of the book): an exercise whose region does not start with its number (read at the left margin, so a numerator or a figure label above the number does not count), an answer region that holds another number, regions that lie on each other or are the same, a region that is too large, too narrow or too small, an unknown section or a page outside its section, numbers that are missing, repeated, out of order in their column or far above the rest of their section, and sections with few or no answers. It also asks whether any text is left in no region (a missed exercise or answer, the cut-off end of an exercise or of an answer), whether an exercise that goes on over a page break has all its regions in reading order and none of the text between them left out, whether the instruction of an exercise is the right one, whether the answers lie under the marker of their section, whether a section whose exercises stand inline between paragraphs has regions that end where their text ends, and, with --ink, whether an edge of a region cuts printed ink (it is dark just inside the edge and just outside it at 2 or more places along the edge, or more than 2 percent of the pixels around it are dark): the finding names the position of the edge within 3 points at which no ink goes across it ("move it to y=0.5123") when there is one that leaves the text of the region as it is and does not run into another exercise, and is information (`edge-interlocked`) when none is clear and only tips of ink go across the edge (the lines are set too tightly for a rectangle). Every finding has a code, a severity, the reference of the exercise (SECTION:LABEL), the page, a message and the evidence (the first 40 characters found, the numbers measured). The codes, their thresholds and what to do about each are in docs/AUDIT_A_BOOK.md. `--details FILE` writes the whole report (format math-canvas-verify, see `mcprep schema verify`); the JSON result carries the first 300 findings and says how many it left out. The exit code is 4 when there is a finding of the severity `--fail-on` names or a worse one (default: an error). Nothing is changed.',
  options: [
    { name: 'section', type: 'string', value: '<id>', multiple: true, description: 'Only the exercises filed under this section (an outline entry id); repeat the option, or separate the ids with commas. Ordinary exercises are then left out.' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write the whole report as JSON (every finding, every section), in the format math-canvas-verify.' },
    { name: 'ink', type: 'boolean', description: 'Also render the pages (each page that has a region, once) and report every region whose top, bottom, left or right edge cuts printed ink (`edge-on-ink`, a warning, the worst first): the ink goes on across the edge at 2 or more pixels (the pixels along it at which the row or column just inside the region and the one just outside are both dark, at 2 pixels per point), or more than 2 percent of the pixels around the edge are dark; the evidence has the number of crossing pixels and the position to move to. Slower: it draws the pages.' },
    { name: 'fail-on', type: 'string', value: 'error|warning|none', description: 'Exit with code 4 when there is a finding of this severity or a worse one: error (the default), warning, or none (always 0).' },
    {
      name: 'item-pattern',
      type: 'string',
      multiple: true,
      value: '<regex>',
      description: 'How the number of an exercise or an answer starts a line, for a book that does not print `5.`, `5)` or `(5)`: a regular expression with the label as printed in group 1 (the same option as `exercises propose`); repeatable. It adds to what is read by default. A pattern that applies to the answers too: "Lösung 1.1.2" is `^L(?:ö|oe)sung\\s+(\\d+(?:\\.\\d+)*)` (a letter outside ASCII may be written as an escape, \\u00f6).',
    },
    { name: 'item-pattern-file', type: 'string', multiple: true, value: '<file>', description: 'The same patterns, one to a line in a UTF-8 file (for a shell that mangles letters such as o with a diaeresis); repeatable.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises verify', 'mcprep exercises verify --section 1.2 --section 1.3', 'mcprep exercises verify --details verify.json --fail-on warning', 'mcprep exercises verify --ink', "mcprep exercises verify --item-pattern '^Lösung\\s+(\\d+(?:\\.\\d+)*)'", 'mcprep exercises verify --json'],
  output:
    '{ format: "math-canvas-verify", version: 1, summary: { exercises, authoritative, sections, solutions, errors, warnings, infos }, findings: [{ code, severity, ref, page, message, evidence }] (the first 300; findingsOmitted: n says how many more the --details file has), sections: [{ id, label, exercises, firstLabel, lastLabel, withSolution, gaps, duplicates }] }; the exit code is 4 when --fail-on is met',
  async run(context) {
    const session = await context.session();
    const threshold = failOn(context);
    const ids = sectionIds(context);
    const patterns = await itemPatterns(context);
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
