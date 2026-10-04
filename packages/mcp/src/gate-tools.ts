import { z } from 'zod';
import { projectArg, type ToolApi } from './args.js';

/**
 * The tools that prove an audit is complete: the comparison with a reference list of the book (`book_compare`). They run the same
 * commands as the command line and return the result of the command as it is.
 */

/** What the server says about them, after the paragraph on checking an audit. */
export const GATE_INSTRUCTIONS = `

Finishing an audit: book_compare reads a reference (JSON: per section the number of exercises the book prints, from the owner's own list) and compares it with the audit section by section. exercises_sheets makes contact sheets (PNG files) of every exercise with its instruction, continuations and answer, to look at all of them. audit_gate runs every check that needs no looking (validation, exercises_verify with all its checks, the comparison with the reference, the last exported bundle, the sheets that were looked at) and says what is open: it passes only when nothing is open, and writes a certificate that a later change makes stale. Repair every finding; acknowledge with audit_ack ONLY what the book itself prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists) and never a defect of ours (a region that cuts a line, a missed exercise, an answer on the wrong exercise).`;

/** The options that the gate and the acknowledgements share. */
const shared = {
  project: projectArg,
  reference: z.string().optional().describe('Also compare with this reference list of the book (see book_compare).'),
  chapter_offset: z.number().int().optional().describe('Added to the chapter numbers of a reference with chapters.'),
  ink: z.boolean().optional().describe('Also render the pages and check the edges of the regions (edge-on-ink). Slower.'),
  item_patterns: z.array(z.string()).optional().describe('How the number of an exercise or an answer starts a line, as for exercises_verify (regular expressions with the label in group 1).'),
};

const sharedArgs = (args: { reference?: string | undefined; chapter_offset?: number | undefined; ink?: boolean | undefined; item_patterns?: string[] | undefined }): string[] => [
  ...(args.reference ? ['--reference', args.reference] : []),
  ...(args.chapter_offset !== undefined ? ['--chapter-offset', String(args.chapter_offset)] : []),
  ...(args.ink ? ['--ink'] : []),
  ...(args.item_patterns ?? []).flatMap((pattern) => ['--item-pattern', pattern]),
];

export function registerGateTools({ tool, cli, toResult, projectOf }: ToolApi): void {
  tool(
    'book_compare',
    {
      title: 'Compare the audited book with a reference list of its sections',
      description:
        'Compares the audited sections and their exercise counts with a reference list of the book (the owner\'s own count of the exercises of each section), section by section, matching sections by the label the book prints. The reference is a JSON file of one of two forms: { "chapters": [{ "number": 1, "title": "...", "sections": [{ "number": 1, "title": "...", "exercise_count": 40 }] }] } (section 1 of chapter 1 is "1.1"; chapter_offset is added to the chapter numbers) or { "sections": [{ "label": "1.1", "title": "...", "exercise_count": 40 }] }. The result lists per section the reference count against the audited count, the first and last label, the pages of the first and the last exercise, the difference and whether the titles differ; the sections on one side only; the totals; a table per chapter; and under differences everything that differs (kind count, missing, extra or title). The exit code of the command is 4 when there is a difference, which is a result here, not a failure: look at the pages of every differing section and decide (what the book prints is acknowledged with audit_ack, anything else is a defect to repair). No network; nothing is changed. details_file writes the whole report (format math-canvas-compare).',
      inputSchema: {
        project: projectArg,
        reference: z.string().min(1).describe('Path of the reference JSON file.'),
        chapter_offset: z.number().int().optional().describe('Added to the chapter numbers of a reference with chapters (the reference counts from 1 and the book prints 0: -1).'),
        details_file: z.string().optional().describe('Write the whole report as JSON to this file.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(['book', 'compare', args.reference, ...(args.chapter_offset !== undefined ? ['--chapter-offset', String(args.chapter_offset)] : []), ...(args.details_file ? ['--details', args.details_file] : [])], {
          project: projectOf(args),
        }),
      ),
  );

  tool(
    'exercises_sheets',
    {
      title: 'Contact sheets of every exercise, to look at all of them',
      description:
        'Makes contact sheets (PNG files) for an exhaustive visual pass: the exercises in the order of the book (all of them, those of sections, or the fixed sample of exercises_sample), per_sheet (default 12) cells at most to a sheet, two cells wide, each cell of a fixed width, a sheet closed as soon as the next cell would make it taller than 2,600 pixels (a cell taller than that has a sheet of its own, drawn smaller only above 6,000 pixels; sheets.json says so), each cell captioned SECTION:LABEL and the zero-based pages of its regions ("p. 12, 13-14"). A cell shows one region under the other: the instruction (blue frame), the exercise (red), its continuations (orange) and, with solutions=true, its answer (green). Files: sheet-0001.png, ... and sheets.json in out_dir, which lists the references and pages of every sheet and a hash of what it shows. Nothing is uploaded; the same project gives the same sheets. sheet draws only that sheet, from_sheet the sheets from that one on (sheets.json is always the whole list): use them to look again after a repair. Look at every sheet, repair what is wrong, then list the sheets you looked at in a file for audit_gate (sheets_seen).',
      inputSchema: {
        project: projectArg,
        out_dir: z.string().min(1).describe('The folder for the sheets and sheets.json.'),
        sections: z.array(z.string()).optional().describe('Only the exercises of these sections (outline entry ids).'),
        sample: z.boolean().optional().describe('Only the exercises of the fixed sample.'),
        per_sheet: z.number().int().min(1).optional().describe('Cells on a sheet, at most (default 12); a sheet taller than 2,600 pixels is closed earlier.'),
        solutions: z.boolean().optional().describe('Also draw the answer of each exercise (green).'),
        sheet: z.number().int().min(1).optional().describe('Draw only this sheet (1 is the first).'),
        from_sheet: z.number().int().min(1).optional().describe('Draw only the sheets from this one on.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'exercises',
            'sheets',
            '--out',
            args.out_dir,
            ...(args.sections ?? []).flatMap((id) => ['--section', id]),
            ...(args.sample ? ['--sample'] : []),
            ...(args.per_sheet !== undefined ? ['--per-sheet', String(args.per_sheet)] : []),
            ...(args.solutions ? ['--solutions'] : []),
            ...(args.sheet !== undefined ? ['--sheet', String(args.sheet)] : []),
            ...(args.from_sheet !== undefined ? ['--from-sheet', String(args.from_sheet)] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'audit_gate',
    {
      title: 'The gate: run every check without looking, say what is open',
      description:
        'The end of an audit. Runs validate (0 errors), exercises_verify with every check of whole pages, instructions, spans and the answer key (every error and warning must be repaired or acknowledged; ink=true adds the pixel check of the edges), the comparison with a reference list of the book when reference is given (every difference acknowledged), the import check of the bundle exported last when there is one (it must import and have the frames of the project) and, with sheets_seen, that every contact sheet of exercises_sheets (scope all) shows the exercises as they are now and is listed as looked at. The result has open (neither repaired nor acknowledged), acknowledged (with the reason), passed and the counts; the command exits with code 4 unless nothing is open, which is a result here, not a failure. It writes the certificate <name>.audit-gate.json next to the project (the SHA-256 of the frames and the outline): any later change to them makes it stale. status=true only says whether the certificate is current and passed. Acknowledgements (<name>.audit-notes.json, added with audit_ack) are ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours: repair those.',
      inputSchema: {
        ...shared,
        sheets_seen: z.string().optional().describe('The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of exercises_sheets with scope all.'),
        status: z.boolean().optional().describe('Only say whether the certificate on disk is for the project as it is now and whether it passed; run no check.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) => toResult(await cli(['audit', 'gate', ...sharedArgs(args), ...(args.sheets_seen ? ['--sheets-seen', args.sheets_seen] : []), ...(args.status ? ['--status'] : [])], { project: projectOf(args) })),
  );

  tool(
    'audit_ack',
    {
      title: 'Acknowledge a finding as what the book prints',
      description:
        'Appends one acknowledgement to <name>.audit-notes.json after checking that the finding exists now. code is the code of the finding (duplicate, no-solution, gap, reference-count, ...), ref the exercise (SECTION:LABEL) or the section, page the page of the finding, quote a piece of its text (at most 60 characters), count how many findings the note covers (required for a section: the note applies only while exactly that many match), reason what the book prints and where (a sentence). Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer on the wrong exercise are defects of ours: repair them. A blanket acknowledgement (no code, no exercise, a wildcard) is refused. Give the same reference, ink and item_patterns as for audit_gate when the finding comes from them.',
      inputSchema: {
        ...shared,
        code: z.string().min(1).describe('The code of the finding.'),
        ref: z.string().min(1).describe('The exercise (SECTION:LABEL) or the section the finding is about, as the finding names it.'),
        reason: z.string().min(10).describe('Why it is not a defect: what the book prints and where.'),
        page: z.number().int().min(0).optional().describe('The zero-based page of the finding.'),
        quote: z.string().max(60).optional().describe('A piece of the evidence or the message of the finding (at most 60 characters).'),
        count: z.number().int().min(1).optional().describe('How many findings the note covers (required for a section).'),
        by: z.string().optional().describe('Who looked (default "agent").'),
      },
      readOnly: false,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'audit',
            'ack',
            '--code',
            args.code,
            '--ref',
            args.ref,
            '--reason',
            args.reason,
            ...(args.page !== undefined ? ['--page', String(args.page)] : []),
            ...(args.quote !== undefined ? ['--quote', args.quote] : []),
            ...(args.count !== undefined ? ['--count', String(args.count)] : []),
            ...(args.by !== undefined ? ['--by', args.by] : []),
            ...sharedArgs(args),
          ],
          { project: projectOf(args) },
        ),
      ),
  );
}
