import { z } from 'zod';
import { projectArg, type ToolApi } from './args.js';

/**
 * The tools that make an audit the same for every agent: a text-only check of the exercises (`exercises_verify`) and a fixed
 * sample to look at (`exercises_sample`). They run the same commands as the command line, `exercises verify` and `exercises
 * sample`, and return the result of the command as it is.
 */

/** What the server says about them, after the paragraph on proposals for a book. */
export const VERIFY_INSTRUCTIONS = `

Checking an audit the same way whatever the model: exercises_verify reads the stored exercises and the text layer of the PDF (no images) and returns an ordered list of findings (errors, then warnings, then infos; each with a code, SECTION:LABEL, the page, a message and the evidence): fix the errors, look at the warnings, and call it again until it has no errors. exercises_sample returns a fixed, bounded sample of exercises and answers to look at (at most 40 exercises and 20 answers: one exercise of each kind of layout the book has, the first and the last exercise of every chapter, a spread of the rest): look at exactly those with render_crop (frame = ref, region = region), or let it write the crops (crops_dir); per_section=true is the thorough review (the first and the last exercise of every section, beyond the caps).`;

export function registerVerifyTools({ tool, cli, toResult, projectOf }: ToolApi): void {
  tool(
    'exercises_verify',
    {
      title: 'Check the audited exercises from the text layer',
      description:
        'A text-only quality check of an audited book, the same list for every agent (no images, no network): reads the exercises stored in the project and the text layer of the PDF and reports what a person would find by looking at the crops. Findings come in a fixed order (errors, warnings, infos; by code; by the order of the book), each as { code, severity, ref (SECTION:LABEL), page (zero-based), message, evidence }. Codes: label-not-first (the region does not start with its number, read at the left margin; or its left edge cuts the number), no-text, solution-label-missing (the answer region does not hold the label as the start of an item), solution-no-text, overlap (regions of two exercises lie on each other), context-overlaps-frame, duplicate-region, region-size (taller than 0.45, narrower than 0.05 or smaller than 0.002 in area), section-unknown, section-page, gap (numbers missing in a section), duplicate, non-numeric-label, order (a label out of order in its column), no-solution (a section with no or few answers), label-outlier, and the checks of whole pages and of the layout: text-left-behind (a line in no region), numbered-text-left-behind (a missed exercise or part), answer-left-behind and answer-clipped (in the answers), span-gap, continuation-order and continuation-limit (exercises that go on over page breaks), context-range, context-missing and context-not-nearest (the instruction of an exercise), solution-section-mismatch and solution-order (the answer key by section), region-open-end and region-holds-item (the end of a region in a section whose exercises stand inline), inline-section (information) and, with ink=true, edge-on-ink (an edge of a region cuts printed ink: dark just inside and just outside it at 2 or more places along the edge, or more than 2 percent of the pixels around it dark). The result also has summary (counts) and sections (per section: exercises, first and last label, withSolution, gaps, duplicates). Fix every error (crop the exercise with render_crop, then update_frame, exercises_label, exercises_section, solution_add), look at the warnings, and call it again until there are no errors. It changes nothing. details_file writes the whole report; the result carries the first 300 findings and findingsOmitted says how many it left out. The exit code of the command is 4 when fail_on is met, which is a result here, not a failure.',
      inputSchema: {
        project: projectArg,
        sections: z.array(z.string()).optional().describe('Only the exercises filed under these sections (outline entry ids, "1.2"); default all. Ordinary exercises are then left out.'),
        details_file: z.string().optional().describe('Write the whole report (every finding) as JSON to this file (format math-canvas-verify).'),
        ink: z.boolean().optional().describe('Also render the pages (each page that has a region once) and report every region edge that cuts printed ink (edge-on-ink; the number of crossing pixels is in the evidence). Slower. Default off.'),
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
            ...(args.ink ? ['--ink'] : []),
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
        'The review sample of an audited book, bounded and chosen by rules without randomness, so that every agent looks at exactly the same exercises and answers (whatever its model, and independent of the order of the frames in the file). At most "exercises" exercises (default 40) and "solutions" answers (default 20). The rules are applied in order, each adds its exercises that are not in the sample yet until the cap is reached, and a rule that does not fit is thinned by an even stride, never cut off at the end. Exercises: (1) one exercise of each layout kind the book has (the first in the order of the book): it has a continuation, it goes on over two or more further pages (spans-pages), its instruction is on another page, it stands in a row with one other exercise, in a row with two others, the longest region, the smallest region, a region much taller than the median of its section (beside a figure); (2) the first and the last exercise of every chapter; (3) the first and the last exercise of every section, or of an even stride of sections that keeps the first and the last when less than twice as many exercises as sections are left in the cap; (4) an even stride over the rest. Answers: those of the exercises of rule 1, the answer with the most lines, an answer that is only a picture, the first answer of every chapter\'s key, those of the other sampled exercises, then an even stride over the rest. per_section=true is the thorough review: the first and the last exercise of EVERY section (and the answers of every sampled exercise) are taken beyond the caps. Each entry is { ref (SECTION:LABEL), reason, reasons, page, kind (exercise or solution), region (main or solution:0) }: look at each with render_crop (frame = ref, region = region), or set crops_dir to have the PNG of every region written (named by reference and kind) and read them. "notes" lists the layouts the book does not have and the rules that were thinned. It changes nothing.',
      inputSchema: {
        project: projectArg,
        exercises: z.number().int().min(0).optional().describe('The most exercises the sample has (default 40); 0 leaves the exercises out.'),
        solutions: z.number().int().min(0).optional().describe('The most answers the sample has (default 20); 0 leaves the answers out.'),
        per_section: z.boolean().optional().describe('The thorough review: take the first and the last exercise of every section (and the answers of every sampled exercise) beyond the caps; the sample may then be larger than "exercises" and "solutions". Default off.'),
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
            ...(args.per_section ? ['--per-section'] : []),
            ...(args.out_file ? ['--out', args.out_file] : []),
            ...(args.crops_dir ? ['--crops', args.crops_dir] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );
}
