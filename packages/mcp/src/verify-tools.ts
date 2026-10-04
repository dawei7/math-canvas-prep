import { z } from 'zod';
import { projectArg, type ToolApi } from './args.js';

/**
 * The tools that make an audit the same for every agent: a text-only check of the exercises (`exercises_verify`) and a fixed
 * sample to look at (`exercises_sample`). They run the same commands as the command line, `exercises verify` and `exercises
 * sample`, and return the result of the command as it is.
 */

/** What the server says about them, after the paragraph on proposals for a book. */
export const VERIFY_INSTRUCTIONS = `

Checking an audit the same way whatever the model: exercises_verify reads the stored exercises and the text layer of the PDF (no images) and returns an ordered list of findings (errors, then warnings, then infos; each with a code, SECTION:LABEL, the page, a message and the evidence): fix the errors, look at the warnings, and call it again until it has no errors. exercises_sample returns a fixed sample of exercises and answers to look at (the first and the last exercise of every section, one of each kind of layout the book has, a spread of the rest): look at exactly those with render_crop (frame = ref, region = region), or let it write the crops (crops_dir).`;

export function registerVerifyTools({ tool, cli, toResult, projectOf }: ToolApi): void {
  tool(
    'exercises_verify',
    {
      title: 'Check the audited exercises from the text layer',
      description:
        'A text-only quality check of an audited book, the same list for every agent (no images, no network): reads the exercises stored in the project and the text layer of the PDF and reports what a person would find by looking at the crops. Findings come in a fixed order (errors, warnings, infos; by code; by the order of the book), each as { code, severity, ref (SECTION:LABEL), page (zero-based), message, evidence }. Codes: label-not-first (the region does not start with its number, read at the left margin; or its left edge cuts the number), no-text, solution-label-missing (the answer region does not hold the label as the start of an item), solution-no-text, overlap (regions of two exercises lie on each other), context-overlaps-frame, duplicate-region, region-size (taller than 0.45, narrower than 0.05 or smaller than 0.002 in area), section-unknown, section-page, gap (numbers missing in a section), duplicate, non-numeric-label, order (a label out of order in its column), no-solution (a section with no or few answers) and label-outlier. The result also has summary (counts) and sections (per section: exercises, first and last label, withSolution, gaps, duplicates). Fix every error (crop the exercise with render_crop, then update_frame, exercises_label, exercises_section, solution_add), look at the warnings, and call it again until there are no errors. It changes nothing. details_file writes the whole report; the result carries the first 300 findings and findingsOmitted says how many it left out. The exit code of the command is 4 when fail_on is met, which is a result here, not a failure.',
      inputSchema: {
        project: projectArg,
        sections: z.array(z.string()).optional().describe('Only the exercises filed under these sections (outline entry ids, "1.2"); default all. Ordinary exercises are then left out.'),
        details_file: z.string().optional().describe('Write the whole report (every finding) as JSON to this file (format math-canvas-verify).'),
        fail_on: z.enum(['error', 'warning', 'none']).optional().describe('The severity from which the command line would exit with code 4 (default error). The result is the same.'),
        item_patterns: z
          .array(z.string())
          .optional()
          .describe('For a book that does not print "5.", "5)" or "(5)": regular expressions with the label as printed in group 1 (as for exercises_propose); they add to what is read by default.'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'exercises',
            'verify',
            ...(args.sections ?? []).flatMap((id) => ['--section', id]),
            ...(args.details_file ? ['--details', args.details_file] : []),
            ...(args.fail_on ? ['--fail-on', args.fail_on] : []),
            ...(args.item_patterns ?? []).flatMap((pattern) => ['--item-pattern', pattern]),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'exercises_sample',
    {
      title: 'A fixed sample of exercises and answers to look at',
      description:
        'The review sample of an audited book, chosen by rules without randomness, so that every agent looks at exactly the same exercises and answers (whatever its model, and independent of the order of the frames in the file). The rules: the first and the last exercise of every section; one exercise of each layout kind the book has (the first in the order of the book): it has a continuation, its instruction is on another page, it stands in a row with one other exercise, in a row with two others, the longest region, the smallest region, a region much taller than the median of its section (beside a figure); the sample is filled up to "exercises" with an even stride over the rest; for the answers: those of the exercises above, the answer with the most lines, an answer that is only a picture, the first answer of every chapter\'s key, then an even stride up to "solutions". The rules always add what they name, so a book with many sections has more than the numbers given. Each entry is { ref (SECTION:LABEL), reason, reasons, page, kind (exercise or solution), region (main or solution:0) }: look at each with render_crop (frame = ref, region = region), or set crops_dir to have the PNG of every region written (named by reference and kind) and read them. "notes" lists the layouts the book does not have. It changes nothing.',
      inputSchema: {
        project: projectArg,
        exercises: z.number().int().min(0).optional().describe('Fill the sample of exercises up to this many (default 40); 0 leaves the exercises out.'),
        solutions: z.number().int().min(0).optional().describe('The same for the answers (default 20); 0 leaves the answers out.'),
        out_file: z.string().optional().describe('Write the sample as JSON to this file (format math-canvas-sample).'),
        crops_dir: z.string().optional().describe('Also write the PNG crop of every region of the sample into this folder, named by reference and kind ("1.2_5-exercise.png", "1.2_5-solution.png").'),
      },
      readOnly: true,
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'exercises',
            'sample',
            ...(args.exercises !== undefined ? ['--exercises', String(args.exercises)] : []),
            ...(args.solutions !== undefined ? ['--solutions', String(args.solutions)] : []),
            ...(args.out_file ? ['--out', args.out_file] : []),
            ...(args.crops_dir ? ['--crops', args.crops_dir] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );
}
