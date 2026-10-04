import { resolve } from 'node:path';
import { addAcknowledgement, gatePath, gateStatus, notesPath, runGate, writeGateReport, type Acknowledgement, type GateFinding, type GateReport } from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, TEXT_LIMIT } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { readReference } from './compare.js';
import { GLOBAL_OPTIONS } from './common.js';
import { itemPatterns } from './verify.js';

/**
 * `audit gate` and `audit ack`: the end of an audit. The gate runs every check that needs no looking and says what is open (neither
 * repaired nor acknowledged); it passes only when nothing is. An acknowledgement says that a finding is what the BOOK prints.
 */

/** What the result of the gate carries of a long list; the certificate on disk has everything. */
const LIST_IN_RESULT = 300;

function findingLines(findings: readonly GateFinding[], limit: number): string[] {
  const lines = findings.slice(0, limit).flatMap((finding) => [
    `${finding.severity} [${finding.code}] ${finding.ref}${finding.page !== null ? ` (page ${finding.page})` : ''}: ${finding.message}`,
    ...(finding.evidence.length > 0 && finding.source === 'verify' ? [`    found: ${finding.evidence}`] : []),
  ]);
  if (findings.length > limit) lines.push(`... and ${findings.length - limit} more (the certificate lists them all)`);
  return lines;
}

export function gateText(report: GateReport, path: string | undefined): string {
  const { counts, checks } = report;
  const errors = report.open.filter((finding) => finding.severity === 'error').length;
  const parts = [`validate ${plural(checks.validate.errors, 'error')}`, `verify ${plural(checks.verify.errors, 'error')}, ${plural(checks.verify.warnings, 'warning')}, ${plural(checks.verify.infos, 'info', 'infos')}${checks.verify.ink ? ' (with ink)' : ''}`];
  if (checks.reference !== null) parts.push(`reference ${checks.reference.file}: ${plural(checks.reference.differences, 'difference')}`);
  if (checks.bundle !== null) parts.push(`bundle ${checks.bundle.ok ? 'imports' : 'REJECTED'}`);
  if (checks.sheets !== null) parts.push(`sheets ${checks.sheets.seen} of ${checks.sheets.sheets} looked at${checks.sheets.current ? '' : ' (some are out of date)'}`);
  const lines = [
    report.passed
      ? `Gate PASSED: nothing is open; ${plural(counts.acknowledged, 'finding')} acknowledged. ${plural(counts.exercises, 'exercise')} in ${plural(counts.sections, 'section')}, ${counts.solutions} with an answer.`
      : `Gate NOT passed: ${counts.open} open (${plural(errors, 'error')}, ${plural(counts.open - errors, 'warning')}), ${counts.acknowledged} acknowledged.`,
    `Checks: ${parts.join('; ')}.`,
  ];
  if (report.open.length > 0) lines.push('Open: repair each, or acknowledge only what the book itself prints (`mcprep audit ack`):', ...findingLines(report.open, TEXT_LIMIT));
  if (report.acknowledged.length > 0) {
    const byCode = new Map<string, number>();
    for (const entry of report.acknowledged) byCode.set(entry.finding.code, (byCode.get(entry.finding.code) ?? 0) + 1);
    lines.push(`Acknowledged: ${[...byCode.entries()].map(([code, n]) => `${code} ${n}`).join(', ')} (each with its reason in the certificate).`);
  }
  for (const stale of report.staleAcknowledgements) lines.push(`A note no longer applies (${stale.acknowledgement.code} ${stale.acknowledgement.ref}): ${stale.why}.`);
  if (report.unusedAcknowledgements.length > 0) lines.push(`${plural(report.unusedAcknowledgements.length, 'note')} for findings that are gone (repaired): ${report.unusedAcknowledgements.slice(0, 5).map((entry) => `${entry.code} ${entry.ref}`).join(', ')}${report.unusedAcknowledgements.length > 5 ? ', ...' : ''}.`);
  if (path !== undefined) lines.push(`Wrote the certificate ${path}: it is for these frames and this outline (SHA-256 ${report.project.hash.slice(0, 12)}...); a later change makes it stale.`);
  return lines.join('\n');
}

async function referenceOf(context: CommandContext): Promise<{ file: string; sections: Awaited<ReturnType<typeof readReference>> } | undefined> {
  const file = stringOption(context.options, 'reference');
  if (file === undefined) return undefined;
  const offset = numberOption(context.options, 'chapter-offset') ?? 0;
  if (!Number.isInteger(offset)) throw usage(`--chapter-offset must be a whole number, not ${offset}.`);
  return { file, sections: await readReference(context, file, offset) };
}

const SHARED: CommandSpec['options'] = [
  { name: 'reference', type: 'string', value: '<file>', description: 'Also compare with this reference list of the book (see `mcprep book compare`): every difference must be repaired or acknowledged.' },
  { name: 'chapter-offset', type: 'number', value: '<n>', description: 'Added to the chapter numbers of a reference with chapters (as for `book compare`).' },
  { name: 'ink', type: 'boolean', description: 'Also render the pages and check the edges of the regions (`edge-on-ink`; slower).' },
  { name: 'item-pattern', type: 'string', multiple: true, value: '<regex>', description: 'How the number of an exercise or an answer starts a line, as for `exercises verify` (group 1 is the label); repeatable. The patterns of the notes file apply as well.' },
];

export const auditGate: CommandSpec = {
  name: 'audit gate',
  summary: 'The end of an audit: run every check without looking, say what is open, exit 0 only when nothing is; writes the certificate.',
  description:
    'Runs `validate` (0 errors), `exercises verify` with every check of whole pages, instructions, spans and the answer key (every error and warning is repaired or acknowledged; `--ink` adds the pixel check of the edges), the comparison with a reference list of the book when `--reference` is given (every difference acknowledged), `import-check` of the bundle exported last when there is one (it must import and have the frames of the project), and, with `--sheets-seen FILE`, that every contact sheet of `exercises sheets --all` shows the exercises as they are now and is listed as looked at (FILE is JSON {"seen": [1, 2, 3]} or text such as 1-12, 14). It reports `open` (neither repaired nor acknowledged) and `acknowledged` (with the reason) and exits with code 4 unless `open` is empty. The certificate is written next to the project as <name>.audit-gate.json: the SHA-256 of the frames and of the outline, the counts, the acknowledgements and `passed`; any later change to the frames or the outline makes it stale (`--status` says whether it is current, `export` says so too). Acknowledgements are read from <name>.audit-notes.json and added with `mcprep audit ack`: ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours (a region that cuts a line, an exercise that was missed, an answer on the wrong exercise): repair those. A blanket "everything" is refused, a note for a section must say how many findings it covers, and a note whose findings changed no longer applies.',
  options: [
    ...(SHARED as NonNullable<CommandSpec['options']>),
    { name: 'sheets-seen', type: 'string', value: '<file>', description: 'The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of `exercises sheets --all`.' },
    { name: 'status', type: 'boolean', description: 'Only say whether the certificate on disk is for the project as it is now and whether it passed (exit code 0 only when it is current and passed); run no check.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep audit gate', 'mcprep audit gate --reference reference.json --chapter-offset -1 --ink --sheets-seen sheets/seen.txt', 'mcprep audit gate --status'],
  output:
    '{ format: "math-canvas-audit-gate", version: 1, createdAt, passed, project: { name, frames, outline, hash }, counts: { sections, exercises, solutions, errors, warnings, infos, open, acknowledged }, checks: { validate, verify, reference, bundle, sheets }, itemPatterns, open: [{ source, code, severity, ref, page, message, evidence, acknowledgeable }] (the first 300; openOmitted says how many more), acknowledged: [{ finding, acknowledgement }], staleAcknowledgements, unusedAcknowledgements, certificate: path }; with --status { status: "none"|"stale"|"failed"|"passed", ... }; the exit code is 4 unless the gate passed',
  async run(context) {
    const session = await context.session();
    if (flag(context.options, 'status')) {
      const status = await gateStatus(session);
      const sentence = { none: `There is no certificate yet (${gatePath(session.projectPath)}): run \`mcprep audit gate\`.`, stale: 'The certificate is STALE: the frames or the outline changed after the gate ran. Run `mcprep audit gate` again.', failed: `The certificate is current and the gate did NOT pass (${status.open ?? '?'} open).`, passed: 'The certificate is current and the gate passed.' }[status.status];
      return { result: status, text: sentence, ...(status.status === 'passed' ? {} : { exitCode: 4 }) };
    }
    const patterns = itemPatterns(context);
    const reference = await referenceOf(context);
    const sheetsSeen = stringOption(context.options, 'sheets-seen');
    const { report } = await runGate(session, {
      ...(patterns.length > 0 ? { itemPatterns: patterns } : {}),
      ...(flag(context.options, 'ink') ? { ink: true } : {}),
      ...(reference !== undefined ? { reference } : {}),
      ...(sheetsSeen !== undefined ? { sheetsSeen: resolve(context.io.cwd, sheetsSeen) } : {}),
    });
    const path = await writeGateReport(session, report);
    const cut = report.open.length > LIST_IN_RESULT || report.acknowledged.length > LIST_IN_RESULT;
    const result = { ...report, open: report.open.slice(0, LIST_IN_RESULT), acknowledged: report.acknowledged.slice(0, LIST_IN_RESULT), ...(cut ? { openOmitted: Math.max(0, report.open.length - LIST_IN_RESULT), acknowledgedOmitted: Math.max(0, report.acknowledged.length - LIST_IN_RESULT) } : {}), certificate: path };
    return { result, text: gateText(report, path), ...(report.passed ? {} : { exitCode: 4 }) };
  },
};

export const auditAck: CommandSpec = {
  name: 'audit ack',
  summary: 'Acknowledge a finding as what the BOOK prints, with the reason; never for a defect of ours.',
  description:
    'Appends one acknowledgement to <name>.audit-notes.json after checking that the finding exists now: --code is the code of the finding (as `exercises verify` or `audit gate` name it: `duplicate`, `no-solution`, `gap`, `reference-count`, ...), --ref the exercise (SECTION:LABEL) or the section, --page the page of the finding and --quote a piece of the line (at most 60 characters; the first characters of the evidence are used when it is left out for an exercise). A note for a whole section (a ref without a label) must say how many findings it covers with --count, or quote the line: if the findings change, it no longer applies. --reason says what the book prints and where (a sentence). Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer on the wrong exercise are defects of ours: repair them. A blanket acknowledgement (no code, no exercise, a wildcard) is refused. Give the same --reference, --ink and --item-pattern as for the gate when the finding comes from them.',
  options: [
    { name: 'code', type: 'string', value: '<code>', required: true, description: 'The code of the finding.' },
    { name: 'ref', type: 'string', value: '<SECTION:LABEL|SECTION>', required: true, description: 'The exercise or the section the finding is about, as the finding names it.' },
    { name: 'reason', type: 'string', value: '<sentence>', required: true, description: 'Why it is not a defect: what the book prints and where (at least 10 characters).' },
    { name: 'page', type: 'number', value: '<n>', description: 'The zero-based page of the finding (narrows the note to it).' },
    { name: 'quote', type: 'string', value: '<text>', description: 'A piece of the evidence or of the message of the finding, at most 60 characters (narrows the note to it).' },
    { name: 'count', type: 'number', value: '<n>', description: 'How many findings the note covers; required for a section; the note applies only while exactly that many match.' },
    { name: 'by', type: 'string', value: '<name>', description: 'Who looked (default "agent").' },
    ...(SHARED as NonNullable<CommandSpec['options']>),
    ...GLOBAL_OPTIONS,
  ],
  examples: [
    'mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --reason "The book prints the number 7 twice on page 120 (the second is a typo in the book)"',
    'mcprep audit ack --code reference-count --ref 4.1 --count 1 --reason "The practice set of 4.1 prints 42 exercises; the reference lists 40"',
  ],
  output: '{ path, acknowledgement: { code, ref, reason, evidence, by, count? }, covers: number of findings it covers now, replaced: boolean }',
  async run(context) {
    const session = await context.session();
    const code = stringOption(context.options, 'code');
    const ref = stringOption(context.options, 'ref');
    const reason = stringOption(context.options, 'reason');
    if (code === undefined || ref === undefined || reason === undefined) throw usage('An acknowledgement needs --code, --ref and --reason.', 'Example: mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --reason "..."');
    const page = numberOption(context.options, 'page');
    const quote = stringOption(context.options, 'quote');
    const count = numberOption(context.options, 'count');
    const entry: Acknowledgement = { code, ref, reason, evidence: { ...(page !== undefined ? { page } : {}), ...(quote !== undefined ? { quote } : {}) }, by: stringOption(context.options, 'by') ?? 'agent', ...(count !== undefined ? { count } : {}) };
    const patterns = itemPatterns(context);
    const reference = await referenceOf(context);
    const done = await addAcknowledgement(session, {
      entry,
      ...(patterns.length > 0 ? { itemPatterns: patterns } : {}),
      ...(flag(context.options, 'ink') ? { ink: true } : {}),
      ...(reference !== undefined ? { reference } : {}),
    });
    const path = notesPath(session.projectPath);
    return {
      result: { path, acknowledgement: entry, covers: done.covers.length, replaced: done.replaced },
      text: `${done.replaced ? 'Replaced' : 'Added'} the acknowledgement of ${code} ${ref} (${plural(done.covers.length, 'finding')}) in ${path}. It must be what the book prints: the gate lists it with your reason.`,
    };
  },
};
