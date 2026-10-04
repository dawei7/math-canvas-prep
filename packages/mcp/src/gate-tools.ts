import { z } from 'zod';
import { projectArg, type ToolApi } from './args.js';

/**
 * The tools that prove an audit is complete: the comparison with a reference list of the book (`book_compare`). They run the same
 * commands as the command line and return the result of the command as it is.
 */

/** What the server says about them, after the paragraph on checking an audit. */
export const GATE_INSTRUCTIONS = `

Comparing with the book's own count: book_compare reads a reference (JSON: per section the number of exercises the book prints, from the owner's own list) and compares it with the audit section by section; every difference (a count, a section on one side only, a title) is listed and must be looked at on the pages: what the book prints is acknowledged, anything else is repaired.`;

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
}
