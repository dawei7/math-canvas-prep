import { resolve } from 'node:path';
import { addAcknowledgement, confirmAcknowledgements, gatePath, gateStatus, notesPath, reviewAcknowledgements, runGate, sheetsSentence, writeGateReport, type Acknowledgement, type GateFinding, type GateReport } from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, TEXT_LIMIT } from '../format.js';
import type { CommandContext, CommandSpec } from '../types.js';
import { readReference } from './compare.js';
import { GLOBAL_OPTIONS } from './common.js';
import { itemPatterns } from './verify.js';

/**
 * `audit gate`, `audit ack`, `audit confirm` and `audit review`: the end of an audit. The gate runs every check that needs no looking and says
 * what is open (neither repaired nor acknowledged); it passes only when nothing is. An acknowledgement says that a finding is what the BOOK
 * prints, and a second reviewer confirms it.
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
  const parts = [`validate ${plural(checks.validate.errors, 'error')}`, `verify ${plural(checks.verify.errors, 'error')}, ${plural(checks.verify.warnings, 'warning')}, ${plural(checks.verify.infos, 'info', 'infos')}${checks.verify.ink ? ' (with the pixel check of the edges)' : ' (WITHOUT the pixel check of the edges: --no-ink)'}`];
  if (checks.reference !== null) parts.push(`reference ${checks.reference.file}: ${plural(checks.reference.differences, 'difference')}`);
  if (checks.bundle !== null) parts.push(`bundle ${checks.bundle.ok ? 'imports' : 'REJECTED'}`);
  if (checks.sheets !== null) parts.push(`sheets ${checks.sheets.seen} of ${checks.sheets.sheets} looked at${checks.sheets.current ? '' : ' (some are out of date)'}`);
  if (checks.visual !== null) parts.push(`visual record ${checks.visual.entries} entries${checks.visual.files > 1 ? ` in ${checks.visual.files} files` : ''} for ${checks.visual.exercises} exercises: ${checks.visual.missing} missing${checks.visual.missingSheets.length > 0 ? ` (exercises of ${sheetsSentence(checks.visual.missingSheets)} have no entry)` : ''}, ${checks.visual.mismatches} not fitting, ${checks.visual.defects} defects`);
  const lines = [
    report.passed
      ? `Gate PASSED: nothing is open; ${plural(counts.acknowledged, 'finding')} acknowledged. ${plural(counts.exercises, 'exercise')} in ${plural(counts.sections, 'section')}, ${counts.solutions} with an answer.`
      : `Gate NOT passed: ${counts.open} open (${plural(errors, 'error')}, ${plural(counts.open - errors, 'warning')}), ${counts.acknowledged} acknowledged.`,
    `Checks: ${parts.join('; ')}.`,
  ];
  if (!report.ink) lines.push('The pixel check of the edges of the regions did not run (--no-ink): run the gate without --no-ink; the book is not perfect until it has run.');
  if (report.interlocked.length > 0) lines.push(`${plural(report.interlocked.length, 'edge')} ${report.interlocked.length === 1 ? 'is' : 'are'} interlocked with ink that no rectangle can separate (information, nothing to repair, listed in the certificate): ${report.interlocked.slice(0, 4).map((entry) => entry.ref).join(', ')}${report.interlocked.length > 4 ? ', ...' : ''}.`);
  if (report.passed && report.unconfirmed > 0) lines.push(`${report.unconfirmed} acknowledgement${report.unconfirmed === 1 ? ' is' : 's are'} not yet confirmed by a second reviewer: \`mcprep audit review --out DIR\` shows each one, \`mcprep audit confirm --by NAME\` confirms it.`);
  if (report.passed && !report.perfect) {
    lines.push(
      checks.visual === null
        ? 'Not exhaustive: there is no visual record of looking at every exercise (--visual FILE or FOLDER: one entry per exercise, one small file for each sheet will do).'
        : !checks.visual.exhaustive
          ? `Not exhaustive: the visual record has no entry for ${checks.visual.missing} of the ${checks.visual.exercises} exercises${checks.visual.missingSheets.length > 0 ? ` (the exercises of ${sheetsSentence(checks.visual.missingSheets)})` : ''}.`
          : 'Not perfect yet: see above.',
    );
  } else if (report.perfect) lines.push('Perfect: nothing is open, every exercise was looked at (the visual record covers all of them), every acknowledgement is confirmed and the pixel check of the edges ran.');
  if (report.open.length > 0) lines.push('Open: repair each; acknowledge (`mcprep audit ack`) only what the book itself prints, and never what the gate names as a defect of the audit:', ...findingLines(report.open, TEXT_LIMIT));
  if (report.acknowledged.length > 0) {
    const byCode = new Map<string, number>();
    for (const entry of report.acknowledged) byCode.set(entry.finding.code, (byCode.get(entry.finding.code) ?? 0) + 1);
    lines.push(`Acknowledged: ${[...byCode.entries()].map(([code, n]) => `${code} ${n}`).join(', ')} (each with its reason in the certificate).`);
  }
  for (const stale of report.staleAcknowledgements) lines.push(`A note no longer applies (${stale.acknowledgement.code} ${stale.acknowledgement.ref}): ${stale.why}.`);
  for (const refused of report.refusedAcknowledgements) lines.push(`A note is not allowed and covers nothing (${refused.acknowledgement.code} ${refused.acknowledgement.ref}): ${refused.why}`);
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
  { name: 'ink', type: 'boolean', description: 'The pixel check of the edges of the regions (`edge-on-ink`: the pages are drawn once) is part of the gate and runs by default: this option is accepted for older calls and changes nothing.' },
  { name: 'no-ink', type: 'boolean', description: 'Skip the pixel check of the edges of the regions, for a quick loop: the certificate then says `ink: false` and the book is not perfect (`--final` exits with code 4) until the gate has run without --no-ink.' },
  { name: 'item-pattern', type: 'string', multiple: true, value: '<regex>', description: 'How the number of an exercise or an answer starts a line, as for `exercises verify` (group 1 is the label); repeatable. The patterns of the notes file (itemPatterns) apply as well. The certificate lists them with every letter outside ASCII written as an escape.' },
  { name: 'item-pattern-file', type: 'string', multiple: true, value: '<file>', description: 'The same patterns, one to a line in a UTF-8 file (for a shell that mangles letters such as o with a diaeresis).' },
];

const sharedOptions = async (context: CommandContext): Promise<{ itemPatterns?: RegExp[]; ink: boolean; reference?: { file: string; sections: Awaited<ReturnType<typeof readReference>> } }> => {
  if (flag(context.options, 'ink') && flag(context.options, 'no-ink')) throw usage('--ink and --no-ink together: the pixel check of the edges runs by default, so give --no-ink to skip it and leave --ink out.');
  const patterns = await itemPatterns(context);
  const reference = await referenceOf(context);
  return { ...(patterns.length > 0 ? { itemPatterns: patterns } : {}), ink: !flag(context.options, 'no-ink'), ...(reference !== undefined ? { reference } : {}) };
};

export const auditGate: CommandSpec = {
  name: 'audit gate',
  summary: 'The end of an audit: run every check without looking, say what is open, exit 0 only when nothing is; writes the certificate.',
  description:
    'Runs `validate` (0 errors), `exercises verify` with every check of whole pages, instructions, spans and the answer key (every error and warning is repaired or acknowledged; the pixel check of the edges of the regions, `edge-on-ink`, is part of the gate and runs by default: `--no-ink` skips it for a quick loop; a finding of it names the position to move the edge to ("Move it to y=0.5123") when there is one, and an edge that only tips of ink go across and no rectangle can do better about is `edge-interlocked`, information that needs nothing and that the certificate lists under `interlocked`), the comparison with a reference list of the book when `--reference` is given (every difference acknowledged), `import-check` of the bundle exported last when there is one (it must import and have the frames of the project), with `--sheets-seen FILE` that every contact sheet of `exercises sheets --all` shows the exercises as they are now and is listed as looked at (FILE is JSON {"seen": [1, 2, 3]} or text such as 1-12, 14), and with `--visual FILE` (or a FOLDER of .json files, merged in the order of their names: one small file for each sheet will do) the visual record: ONE ENTRY PER EXERCISE, written by whoever looked at its cell, [{ "ref": "1.2:5", "startsWith": "the first three words after the number", "instruction": true, "answerStartsWith": "5", "ok": true }] ("instruction": whether the cell shows a blue box; "answerStartsWith": the number at the start of the green box, or ""; "ok": false with "defect": "CODE" when the cell shows a defect). The gate checks that every exercise has an entry, that startsWith is a piece of the text of the exercise\'s region (three words, case and spaces do not matter), that instruction is whether the exercise has an instruction, and that answerStartsWith is the number at the start of the text of its answer: a mismatch is open as `visual-mismatch` (the cell was not looked at), `ok: false` as `visual-defect`, an exercise without an entry as `visual-missing` (one finding for each sheet that holds some, "the 12 exercises of sheet 5 have no entry", when the list of the sheets, sheets.json, is found next to the file of `--sheets-seen`, next to the record or in the folder sheets next to the project; otherwise one for each section). A bare list of sheets (`--sheets-seen`) proves nothing: `exhaustive` is true only when the visual record covers every exercise. It reports `open` (neither repaired nor acknowledged) and `acknowledged` (with the reason) and exits with code 4 unless `open` is empty. It also says `unconfirmed`: how many acknowledgements no second reviewer has confirmed (`audit confirm`); `perfect` is true only when nothing is open, the visual record covers every exercise, nothing is unconfirmed and the pixel check ran (not with `--no-ink`), and `--final` exits with code 4 unless it is ("run the gate without --no-ink" when the pixel check was skipped). The certificate is written next to the project as <name>.audit-gate.json: the SHA-256 of the frames and of the outline, the counts, the acknowledgements, `passed`, `unconfirmed`, `ink` (whether the pixel check ran) and `perfect`; any later change to the frames or the outline makes it stale (`--status` says whether it is current, `export` says so too). Acknowledgements are read from <name>.audit-notes.json and added with `mcprep audit ack`: ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours: a region that cuts a line, an exercise or an answer that was missed, an answer or an instruction on the wrong exercise can not be acknowledged at all (`audit ack` refuses these codes and the gate takes no note for them): repair them.',
  options: [
    ...(SHARED as NonNullable<CommandSpec['options']>),
    { name: 'sheets-seen', type: 'string', value: '<file>', description: 'The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of `exercises sheets --all`.' },
    { name: 'visual', type: 'string', value: '<file|folder>', description: 'The visual record: a JSON list with ONE ENTRY PER EXERCISE, { ref, startsWith, instruction, answerStartsWith, ok, defect? }, written by whoever looked at its cell; checked against the project and the text layer. A FOLDER works too: every .json file in it is such a list, merged in the order of the file names (so one small file can be written for each sheet); a ref that two entries repeat is a visual-mismatch, and an exercise without an entry is named with its sheet when sheets.json is found (next to the file of --sheets-seen, in the folder, or in the folder sheets next to the project).' },
    { name: 'final', type: 'boolean', description: 'The last gate of a book: exit with code 4 unless it is perfect (nothing open, the visual record covers every exercise, every acknowledgement confirmed).' },
    { name: 'status', type: 'boolean', description: 'Only say whether the certificate on disk is for the project as it is now and whether it passed (exit code 0 only when it is current and passed); run no check.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep audit gate', 'mcprep audit gate --reference reference.json --chapter-offset -1 --visual visual.json --sheets-seen sheets/seen.txt', 'mcprep audit gate --no-ink', 'mcprep audit gate --visual visual.json --final', 'mcprep audit gate --status'],
  output:
    '{ format: "math-canvas-audit-gate", version: 1, createdAt, passed, perfect, unconfirmed, ink, project: { name, frames, outline, hash }, counts: { sections, exercises, solutions, errors, warnings, infos, open, acknowledged }, checks: { validate, verify, reference, bundle, sheets, visual }, itemPatterns, open: [{ source, code, severity, ref, page, message, evidence, acknowledgeable }] (the first 300; openOmitted says how many more), acknowledged: [{ finding, acknowledgement }], staleAcknowledgements, unusedAcknowledgements, refusedAcknowledgements, interlocked: [{ ref, page, message, evidence }] (edge-interlocked, information), certificate: path }; with --status { status: "none"|"stale"|"failed"|"passed", unconfirmed, exhaustive, ... }; the exit code is 4 unless the gate passed (with --final: unless it is perfect)',
  async run(context) {
    const session = await context.session();
    if (flag(context.options, 'status')) {
      const status = await gateStatus(session);
      const sentence = { none: `There is no certificate yet (${gatePath(session.projectPath)}): run \`mcprep audit gate\`.`, stale: 'The certificate is STALE: the frames or the outline changed after the gate ran. Run `mcprep audit gate` again.', failed: `The certificate is current and the gate did NOT pass (${status.open ?? '?'} open).`, passed: `The certificate is current and the gate passed${status.unconfirmed !== undefined && status.unconfirmed > 0 ? `; ${status.unconfirmed} acknowledgement${status.unconfirmed === 1 ? ' is' : 's are'} not yet confirmed by a second reviewer` : ''}${status.exhaustive === false ? '; the visual record does not cover every exercise' : ''}${status.ink === false ? '; the pixel check of the edges did not run (run the gate without --no-ink)' : ''}.` }[status.status];
      return { result: status, text: sentence, ...(status.status === 'passed' ? {} : { exitCode: 4 }) };
    }
    const shared = await sharedOptions(context);
    const sheetsSeen = stringOption(context.options, 'sheets-seen');
    const visual = stringOption(context.options, 'visual');
    const { report } = await runGate(session, {
      ...shared,
      ...(sheetsSeen !== undefined ? { sheetsSeen: resolve(context.io.cwd, sheetsSeen) } : {}),
      ...(visual !== undefined ? { visual: resolve(context.io.cwd, visual) } : {}),
    });
    const path = await writeGateReport(session, report);
    const cut = report.open.length > LIST_IN_RESULT || report.acknowledged.length > LIST_IN_RESULT;
    const result = { ...report, open: report.open.slice(0, LIST_IN_RESULT), acknowledged: report.acknowledged.slice(0, LIST_IN_RESULT), ...(cut ? { openOmitted: Math.max(0, report.open.length - LIST_IN_RESULT), acknowledgedOmitted: Math.max(0, report.acknowledged.length - LIST_IN_RESULT) } : {}), certificate: path };
    const final = flag(context.options, 'final');
    const failed = final ? !report.perfect : !report.passed;
    const text = final && !report.perfect ? `${gateText(report, path)}\n--final: the book is not perfect yet, so the exit code is 4${report.ink ? '' : ': run the gate without --no-ink'}.` : gateText(report, path);
    return { result, text, ...(failed ? { exitCode: 4 } : {}) };
  },
};

export const auditAck: CommandSpec = {
  name: 'audit ack',
  summary: 'Acknowledge a finding as what the BOOK prints, with the reason and a quote of the page; never for a defect of the audit.',
  description:
    'Appends one acknowledgement to <name>.audit-notes.json after checking everything that can be checked: --code is the code of the finding (as `audit gate` prints it in square brackets: `duplicate`, `no-solution`, `gap`, `reference-count`, ...; a code that names a defect of the audit, such as label-not-first, overlap, span-gap or any of the context-* and solution-* ones, is REFUSED: repair it), --ref the exercise (SECTION:LABEL) or the section it is about, exactly as the finding names it, --page the zero-based page of the finding, --quote a piece of the text printed on THAT PAGE (4 to 60 characters, copied from `mcprep lines PAGE`; it must be in the text layer of the page, a piece of the finding\'s own message does not count) and --reason what the book prints and where, in your own words (at least 10 characters; a reason that repeats the finding is refused). A note for a whole section (a ref without a label) must say how many findings it covers with --count; a note with a count applies only while exactly that many findings match. Every refusal says what is wrong and what to give instead, everything that is wrong at once (a list of the things, then the call that would do), so that one call is enough to correct it. A new note is NOT confirmed: a second reviewer, another --by, looks at it (`mcprep audit review --out DIR`) and confirms it (`mcprep audit confirm`); the gate reports how many are unconfirmed. Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer or an instruction on the wrong exercise are defects of ours: repair them. Give the same --reference and --item-pattern as for the gate when the finding comes from them (the pixel check of the edges runs unless --no-ink).',
  options: [
    { name: 'code', type: 'string', value: '<code>', description: 'Required: the code of the finding, as `audit gate` prints it.' },
    { name: 'ref', type: 'string', value: '<SECTION:LABEL|SECTION>', description: 'Required: the exercise or the section the finding is about, exactly as the finding names it.' },
    { name: 'reason', type: 'string', value: '<sentence>', description: 'Required: what the book prints that makes the finding correct, and where, in your own words (at least 10 characters; not the text of the finding).' },
    { name: 'page', type: 'number', value: '<n>', description: 'The zero-based page of the finding (required for a finding that has a page).' },
    { name: 'quote', type: 'string', value: '<text>', description: 'A piece of the text printed on that page, 4 to 60 characters, copied from `mcprep lines PAGE` (required with --page; it must be in the text layer of the page).' },
    { name: 'count', type: 'number', value: '<n>', description: 'How many findings the note covers; required for a section; the note applies only while exactly that many match.' },
    { name: 'by', type: 'string', value: '<name>', description: 'Who looked (default "agent"); the one who confirms the note must be another.' },
    ...(SHARED as NonNullable<CommandSpec['options']>),
    ...GLOBAL_OPTIONS,
  ],
  examples: [
    'mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --quote "7. Find the area" --reason "The book prints the number 7 twice on page 120 (the second is a typo in the book)"',
    'mcprep audit ack --code reference-count --ref 4.1 --count 1 --page 150 --quote "42. Simplify" --reason "The practice set of 4.1 prints 42 exercises; the reference lists 40"',
  ],
  output: '{ path, acknowledgement: { code, ref, reason, evidence, by, count?, confirmed: false }, covers: number of findings it covers now, replaced: boolean }',
  async run(context) {
    const session = await context.session();
    const code = stringOption(context.options, 'code');
    const ref = stringOption(context.options, 'ref');
    const reason = stringOption(context.options, 'reason');
    const missing = [code === undefined ? '--code' : '', ref === undefined ? '--ref' : '', reason === undefined ? '--reason' : ''].filter(Boolean);
    if (missing.length > 0) {
      throw usage(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing: an acknowledgement needs --code, --ref, --reason (and --page and --quote for a finding that has a page).`,
        'Example: mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --quote "7. Find the area" --reason "The book prints the number 7 twice on page 120"',
      );
    }
    const page = numberOption(context.options, 'page');
    const quote = stringOption(context.options, 'quote');
    const count = numberOption(context.options, 'count');
    const entry: Acknowledgement = { code: code as string, ref: ref as string, reason: reason as string, evidence: { ...(page !== undefined ? { page } : {}), ...(quote !== undefined ? { quote } : {}) }, by: stringOption(context.options, 'by') ?? 'agent', ...(count !== undefined ? { count } : {}), confirmed: false };
    const shared = await sharedOptions(context);
    const done = await addAcknowledgement(session, { entry, ...shared });
    const path = notesPath(session.projectPath);
    return {
      result: { path, acknowledgement: entry, covers: done.covers.length, replaced: done.replaced },
      text: `${done.replaced ? 'Replaced' : 'Added'} the acknowledgement of ${entry.code} ${entry.ref} (${plural(done.covers.length, 'finding')}) in ${path}. It is not confirmed: a second reviewer must look at it (\`mcprep audit review --out DIR\`, then \`mcprep audit confirm --by NAME --ref ${entry.ref} --code ${entry.code}\`). It must be what the book prints: the gate lists it with your reason.`,
    };
  },
};

export const auditConfirm: CommandSpec = {
  name: 'audit confirm',
  summary: 'A second reviewer confirms acknowledgements: it looked at each one and the book prints what it says.',
  description:
    'Marks acknowledgements of <name>.audit-notes.json as confirmed by --by, which must be ANOTHER identity than the one who wrote the note (its --by): a note confirms by someone who looked at it. Name one note with --ref (and --code, --page when the exercise has several), or confirm every note of the others with --all. `mcprep audit review --out DIR` writes the picture, the reason and the quote of every note for the reviewer to look at first; confirm only what the book really prints. A note that is changed or replaced is not confirmed again. The gate reports how many notes are unconfirmed (`unconfirmed`), and `export` says so.',
  options: [
    { name: 'by', type: 'string', value: '<name>', description: 'Required: who confirms, another name than the one that wrote the note.' },
    { name: 'ref', type: 'string', value: '<SECTION:LABEL|SECTION>', description: 'The acknowledgement to confirm (as in the notes).' },
    { name: 'code', type: 'string', value: '<code>', description: 'With --ref: narrow to this code.' },
    { name: 'page', type: 'number', value: '<n>', description: 'With --ref: narrow to this page.' },
    { name: 'all', type: 'boolean', description: 'Confirm every acknowledgement that was written by someone else than --by.' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep audit confirm --by reviewer --ref 3.2:7 --code duplicate', 'mcprep audit confirm --by reviewer --all'],
  output: '{ path, confirmed: [{ code, ref, by, confirmedBy, ... }], skipped: [{ acknowledgement, why }] }',
  async run(context) {
    const session = await context.session();
    const by = stringOption(context.options, 'by');
    const page = numberOption(context.options, 'page');
    const code = stringOption(context.options, 'code');
    const ref = stringOption(context.options, 'ref');
    const done = await confirmAcknowledgements(session, { by: by ?? '', ...(ref !== undefined ? { ref } : {}), ...(code !== undefined ? { code } : {}), ...(page !== undefined ? { page } : {}), ...(flag(context.options, 'all') ? { all: true } : {}) });
    const lines = [`${by as string} confirmed ${plural(done.confirmed.length, 'acknowledgement')} in ${done.path}: ${done.confirmed.slice(0, 6).map((entry) => `${entry.code} ${entry.ref}`).join(', ')}${done.confirmed.length > 6 ? ', ...' : ''}.`, ...done.skipped.slice(0, 6).map((entry) => `Not confirmed: ${entry.acknowledgement.code} ${entry.acknowledgement.ref}: ${entry.why}.`)];
    return { result: { path: done.path, confirmed: done.confirmed, skipped: done.skipped }, text: lines.join('\n') };
  },
};

export const auditReview: CommandSpec = {
  name: 'audit review',
  summary: 'Write what a second reviewer needs to check every acknowledgement: the picture, the reason, the quote and an index.',
  description:
    'For every acknowledgement of <name>.audit-notes.json writes, into --out, a picture of what it is about (the exercise\'s region, or the place on the page, without any grid) named NNN-code-ref.png, and an index.md that lists every note on one line (code, ref, page, who wrote it, whether it is confirmed, the reason, the quote and whether the quote is on the page) and then each note with its picture, the finding it covers and the command that confirms it; review.json has the same for a program. The notes that do not apply any more (the finding is gone or changed) and the notes that are not allowed are listed as such. Nothing in the project is changed. The reviewer (a person or another agent) looks at each picture, reads the reason, and runs `mcprep audit confirm` for the ones the book really prints; the others are repaired. Give the same --reference and --item-pattern as for the gate (the pixel check of the edges runs unless --no-ink).',
  options: [{ name: 'out', short: 'o', type: 'string', value: '<folder>', description: 'Required: where the pictures, index.md and review.json go.' }, ...(SHARED as NonNullable<CommandSpec['options']>), ...GLOBAL_OPTIONS],
  examples: ['mcprep audit review --out review/'],
  output: '{ out, index, json, unconfirmed, entries: [{ number, code, ref, page, by, confirmed, reason, quote?, quoteOnPage, status: "applies"|"unused"|"stale"|"refused", findings, finding?, image, line }] }',
  async run(context) {
    const session = await context.session();
    const out = stringOption(context.options, 'out');
    if (out === undefined) throw usage('Say where the review goes: --out FOLDER.');
    const shared = await sharedOptions(context);
    const done = await reviewAcknowledgements(session, { ...shared, outDir: resolve(context.io.cwd, out) });
    const text =
      done.entries.length === 0
        ? `There are no acknowledgements to review (${done.indexPath} says so).`
        : `Wrote ${plural(done.entries.length, 'acknowledgement')} with their pictures to ${done.outDir}: open ${done.indexPath}. ${done.unconfirmed} apply and ${done.unconfirmed === 1 ? 'is' : 'are'} not confirmed yet: look at each, then \`mcprep audit confirm --by NAME --ref REF --code CODE\` (or --all when you have looked at all of them).`;
    return { result: { out: done.outDir, index: done.indexPath, json: done.jsonPath, unconfirmed: done.unconfirmed, entries: done.entries }, text };
  },
};
