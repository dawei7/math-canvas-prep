import { z } from 'zod';
import { projectArg, type ToolApi } from './args.js';

/**
 * The tools that prove an audit is complete: the comparison with a reference list of the book (`book_compare`). They run the same
 * commands as the command line and return the result of the command as it is.
 */

/** What the server says about them, after the paragraph on checking an audit. */
export const GATE_INSTRUCTIONS = `

Finishing an audit: book_compare reads a reference (JSON: per section the number of exercises the book prints, from the owner's own list) and compares it with the audit section by section. exercises_sheets makes contact sheets (PNG files) of every exercise with its instruction, continuations and answer, to look at all of them. audit_gate runs every check that needs no looking (validation, exercises_verify with all its checks and the pixel check of the edges of the regions, the comparison with the reference, the last exported bundle, the sheets that were looked at) and says what is open: it passes only when nothing is open, and writes a certificate that a later change makes stale. Repair every finding; acknowledge with audit_ack ONLY what the book itself prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists) and never a defect of ours (a region that cuts a line, a missed exercise, an answer or an instruction on the wrong exercise: audit_ack refuses those codes). An acknowledgement needs the page, a quote from the text of that page and a reason in your own words, and a second reviewer confirms it (audit_review, audit_confirm). Prove that every exercise was looked at with a visual record, one entry per exercise (audit_gate visual).`;

/** The options that the gate and the acknowledgements share. */
const shared = {
  project: projectArg,
  reference: z.string().optional().describe('Also compare with this reference list of the book (see book_compare).'),
  chapter_offset: z.number().int().optional().describe('Added to the chapter numbers of a reference with chapters.'),
  ink: z.boolean().optional().describe('The pixel check of the edges of the regions (edge-on-ink: the pages are drawn once) is part of the gate and runs by default. false skips it for a quick loop: the certificate then says ink false and the book is not perfect until the gate has run with ink true (the default).'),
  item_patterns: z.array(z.string()).optional().describe('How the number of an exercise or an answer starts a line, as for exercises_verify (regular expressions with the label in group 1).'),
};

const sharedArgs = (args: { reference?: string | undefined; chapter_offset?: number | undefined; ink?: boolean | undefined; item_patterns?: string[] | undefined }): string[] => [
  ...(args.reference ? ['--reference', args.reference] : []),
  ...(args.chapter_offset !== undefined ? ['--chapter-offset', String(args.chapter_offset)] : []),
  ...(args.ink === false ? ['--no-ink'] : []),
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
        'The end of an audit. Runs validate (0 errors), exercises_verify with every check of whole pages, instructions, spans and the answer key (every error and warning must be repaired or acknowledged; the pixel check of the edges, edge-on-ink, is part of the gate and runs by default: ink=false skips it for a quick loop, and then the book is not perfect), the comparison with a reference list of the book when reference is given (every difference acknowledged), the import check of the bundle exported last when there is one (it must import and have the frames of the project) and, with sheets_seen, that every contact sheet of exercises_sheets (scope all) shows the exercises as they are now and is listed as looked at, and with visual the visual record (a JSON file, or a folder of .json files merged in the order of their names, for example one for each sheet): a list with ONE ENTRY PER EXERCISE, written by whoever looked at its cell, { ref: "1.2:5", startsWith: "the first three words after the number", instruction: true (the cell shows a blue box), answerStartsWith: "5" (the number at the start of the green box, or ""), ok: true } (ok: false with defect: "CODE" for a defect). The gate checks that every exercise has an entry, that startsWith is a piece of the text of the exercise\'s region, that instruction is whether the exercise has an instruction and that answerStartsWith is the number at the start of the text of its answer: a mismatch is open as visual-mismatch (the cell was not looked at), ok false as visual-defect, no entry as visual-missing (one finding for each sheet that holds some, when sheets.json is found next to the file of sheets_seen, next to the record or in the folder sheets next to the project); a bare sheets_seen list proves nothing (exhaustive is true only when the visual record covers every exercise). The result has open (neither repaired nor acknowledged), acknowledged (with the reason), passed, unconfirmed (acknowledgements that no second reviewer confirmed with audit_confirm), perfect (nothing open, the visual record covers every exercise, nothing unconfirmed, the pixel check ran), ink (whether the pixel check ran) and the counts; final=true makes the exit code 4 unless it is perfect ("run the gate without --no-ink" when the pixel check was skipped); the command exits with code 4 unless nothing is open, which is a result here, not a failure. It writes the certificate <name>.audit-gate.json next to the project (the SHA-256 of the frames and the outline): any later change to them makes it stale. status=true only says whether the certificate is current and passed. Acknowledgements (<name>.audit-notes.json, added with audit_ack) are ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours: a label-not-first, solution-label-missing, overlap, duplicate-region, section-unknown, section-page, span-gap, continuation-order, context-range, context-missing, context-inconsistent, context-not-nearest, solution-section-mismatch or region-holds-item can not be acknowledged at all: repair those.',
      inputSchema: {
        ...shared,
        visual: z.string().optional().describe('The visual record: a JSON file with a list of one entry per exercise { ref, startsWith, instruction, answerStartsWith, ok, defect? }, written by whoever looked at its cell, or a FOLDER of such .json files (one small file for each sheet will do; they are merged in the order of the file names, a repeated ref is a visual-mismatch). An exercise without an entry is named with its sheet when sheets.json is found.'),
        final: z.boolean().optional().describe('The last gate of a book: exit code 4 unless it is perfect (nothing open, the visual record covers every exercise, no acknowledgement unconfirmed, the pixel check ran).'),
        sheets_seen: z.string().optional().describe('The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of exercises_sheets with scope all.'),
        status: z.boolean().optional().describe('Only say whether the certificate on disk is for the project as it is now and whether it passed; run no check.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) => toResult(await cli(['audit', 'gate', ...sharedArgs(args), ...(args.sheets_seen ? ['--sheets-seen', args.sheets_seen] : []), ...(args.visual ? ['--visual', args.visual] : []), ...(args.final ? ['--final'] : []), ...(args.status ? ['--status'] : [])], { project: projectOf(args) })),
  );

  tool(
    'audit_ack',
    {
      title: 'Acknowledge a finding as what the book prints',
      description:
        'Appends one acknowledgement to <name>.audit-notes.json after checking everything that can be checked. code is the code of the finding as audit_gate names it (duplicate, no-solution, gap, reference-count, ...): a code that names a defect of the audit (label-not-first, solution-label-missing, overlap, duplicate-region, section-unknown, section-page, span-gap, continuation-order, context-range, context-missing, context-inconsistent, context-not-nearest, solution-section-mismatch, region-holds-item) is REFUSED, with the command that repairs it. ref is the exercise (SECTION:LABEL) or the section, exactly as the finding names it; page the zero-based page of the finding; quote a piece of the text printed ON THAT PAGE (4 to 60 characters, copied from get_page_lines; it must be in the text layer of the page: a piece of the finding\'s own message does not count); reason what the book prints and where, in your own words (at least 10 characters; one that repeats the finding is refused); count how many findings the note covers (required for a section). Every refusal says what is wrong and what to give instead, everything that is wrong at once (a list, then the call that would do), so that one call is enough to correct it. The new note is NOT confirmed: a second reviewer (another by) looks at it (audit_review) and confirms it (audit_confirm); audit_gate reports unconfirmed. Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer or an instruction on the wrong exercise are defects of ours: repair them. Give the same reference and item_patterns as for audit_gate when the finding comes from them (the pixel check of the edges runs unless ink is false).',
      inputSchema: {
        ...shared,
        code: z.string().describe('The code of the finding, as audit_gate names it.'),
        ref: z.string().describe('The exercise (SECTION:LABEL) or the section the finding is about, exactly as the finding names it.'),
        reason: z.string().describe('What the book prints that makes the finding correct, and where, in your own words (at least 10 characters; not the text of the finding).'),
        page: z.number().optional().describe('The zero-based page of the finding (required for a finding that has a page).'),
        quote: z.string().optional().describe('A piece of the text printed on that page, 4 to 60 characters, copied from get_page_lines (required with page; it must be in the text layer of the page).'),
        count: z.number().optional().describe('How many findings the note covers (required for a section).'),
        by: z.string().optional().describe('Who looked (default "agent"); the one who confirms the note must be another.'),
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

  tool(
    'audit_confirm',
    {
      title: 'Confirm acknowledgements as a second reviewer',
      description:
        'A second reviewer confirms acknowledgements of <name>.audit-notes.json: it looked at each one (audit_review shows the picture, the reason and the quote) and the book prints what it says. by must be ANOTHER identity than the one who wrote the note. Name one note with ref (and code, page when the exercise has several), or confirm every note of the others with all=true. A note that is changed or replaced is not confirmed again. audit_gate reports how many notes are unconfirmed; confirm only what the book really prints and repair the rest.',
      inputSchema: {
        project: projectArg,
        by: z.string().describe('Who confirms: another name than the one that wrote the note.'),
        ref: z.string().optional().describe('The acknowledgement to confirm (as in the notes).'),
        code: z.string().optional().describe('With ref: narrow to this code.'),
        page: z.number().optional().describe('With ref: narrow to this page.'),
        all: z.boolean().optional().describe('Confirm every acknowledgement that was written by someone else than by.'),
      },
      readOnly: false,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(['audit', 'confirm', '--by', args.by, ...(args.ref ? ['--ref', args.ref] : []), ...(args.code ? ['--code', args.code] : []), ...(args.page !== undefined ? ['--page', String(args.page)] : []), ...(args.all ? ['--all'] : [])], {
          project: projectOf(args),
        }),
      ),
  );

  tool(
    'audit_review',
    {
      title: 'Write what a second reviewer needs to check the acknowledgements',
      description:
        'For every acknowledgement of <name>.audit-notes.json writes, into out_dir, a picture of what it is about (the exercise region or the place on the page, without any grid) named NNN-code-ref.png, and an index.md that lists every note on one line (code, ref, page, who wrote it, whether it is confirmed, the reason, the quote and whether the quote is on the page) and then each note with its picture, the finding it covers and the command that confirms it; review.json has the same for a program. Notes that no longer apply and notes that are not allowed are listed as such. Nothing in the project is changed. Look at each picture, read the reason, then audit_confirm what the book really prints; repair the others.',
      inputSchema: {
        ...shared,
        out_dir: z.string().describe('The folder for the pictures, index.md and review.json.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) => toResult(await cli(['audit', 'review', '--out', args.out_dir, ...sharedArgs(args)], { project: projectOf(args) })),
  );
}
