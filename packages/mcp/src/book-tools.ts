import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * The tools that audit a book (chapters and sections, numbered exercises with their instruction, the answers of the
 * answer key). They run the same commands as the command line, `outline derive --book`, `exercises propose` and
 * `solutions propose`, so the two can never disagree; the result of the command is returned as it is.
 */

interface Reply {
  code: number;
  envelope: { ok: boolean };
}

export interface BookToolApi {
  tool: <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape; readOnly?: boolean; destructive?: boolean; idempotent?: boolean; project?: boolean },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
  ) => void;
  cli: (argv: string[], extra?: { stdin?: string; project?: string | undefined }) => Promise<Reply>;
  toResult: (done: never) => CallToolResult;
  projectOf: (args: { project?: string | undefined }) => string | undefined;
  projectArg: z.ZodOptional<z.ZodString>;
}

export function registerBookTools(api: BookToolApi): void {
  const { tool, cli, projectOf, projectArg } = api;
  const toResult = api.toResult as (done: Reply) => CallToolResult;

  tool(
    'outline_derive_book',
    {
      title: 'Find the chapters and sections of a book',
      description:
        'For a book that prints numbered chapters and sections (a table of contents with page numbers, chapter openers, headings like "3.2 Practice - Title"): reads the printed contents (also lines that the text extraction merged), the lists on the chapter openers and the headings on the pages, cross-checks them and proposes chapters (id c0, label "Chapter 0") and sections (id and label "0.1") with title, zero-based page, top, confidence and evidence. Titles are normalised ("&" and a slash read as "and", typos of the contents repaired when the headings agree) and every difference is reported. Each section also says where its practice set starts and ends (the start of whatever comes next). With apply=true the entries (with id, label and top) are stored as the outline of the project: do that before exercises_propose, because exercises refer to sections by id. Look at the result: gaps, sections without a practice set and spellings that differ are listed in "notes".',
      inputSchema: { project: projectArg, apply: z.boolean().optional().describe('Store the proposal as the outline of the project (with ids, labels and tops).') },
      idempotent: true,
    },
    async (args) => toResult(await cli(['outline', 'derive', '--book', ...(args.apply ? ['--apply'] : [])], { project: projectOf(args) })),
  );

  tool(
    'exercises_propose',
    {
      title: 'Find the numbered exercises of the practice sets',
      description:
        'Offline heuristics (no AI) over the printed text of every practice set (or of the sections you name): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its text, continuation lines, the second line of a fraction, a figure beside it, lines on the next page), the bold instruction printed above a group as its context (two regions when it crosses a page break), the printed label as the exercise\'s name and the section. Numbers that are missing, printed twice or put aside are reported in "sections[].gaps/duplicates/rejected/notes": what the book prints is what is proposed. The result carries "operations" (add with authority "book", label, section, context; with solutions=true also the solution regions) that you can pass to apply_operations, or apply=true applies them (exercises that are already in the project are skipped, so applying twice does not duplicate). Needs the outline from outline_derive_book (apply=true) in the project. Look at render_crop images of a sample (the first and last of each section, the figures, an item at a page end, an instruction that crosses a page break) before you apply, and fix what is wrong with update_frame.',
      inputSchema: {
        project: projectArg,
        sections: z.array(z.string()).optional().describe('Only these sections, by id or label ("0.1"); default all.'),
        solutions: z.boolean().optional().describe('Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).'),
        max_items: z.number().int().min(1).optional().describe('At most this many exercises per section; the surplus is listed as excluded (use when the book prints more than the audit wants).'),
        ops_file: z.string().optional().describe('Write the operations as a JSON batch to this file (for apply_operations or `mcprep frames apply`).'),
        details_file: z.string().optional().describe('Write every proposal with its evidence, the instructions and the rejected numbers as JSON to this file.'),
        apply: z.boolean().optional().describe('Apply the proposals to the project now, as one atomic batch.'),
      },
    },
    async (args) =>
      toResult(
        await cli(
          [
            'exercises',
            'propose',
            ...(args.sections && args.sections.length > 0 ? ['--section', args.sections.join(',')] : []),
            ...(args.solutions ? ['--solutions'] : []),
            ...(args.max_items !== undefined ? ['--max-items', String(args.max_items)] : []),
            ...(args.ops_file ? ['--ops', args.ops_file] : []),
            ...(args.details_file ? ['--details', args.details_file] : []),
            ...(args.apply ? ['--apply'] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'solutions_propose',
    {
      title: 'Find the answers in the answer key',
      description:
        'Reads the answer key at the back of the same PDF: it is cut into bands by the small section markers ("2.3") and the headers ("Answers - Slope-Intercept") that run across all columns and over page breaks; inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; "sections[].withoutAnswer" lists exercises without an answer and "withoutExercise" answers without an exercise. The result carries "operations" (solution.add, one per region); apply=true applies them. An exercise that already has a solution is left alone. The solution is hidden from the learner and used only to grade. Look at render_crop images of a sample of the answer regions, especially graphs and answers of several lines.',
      inputSchema: {
        project: projectArg,
        ops_file: z.string().optional().describe('Write the operations as a JSON batch to this file.'),
        details_file: z.string().optional().describe('Write every answer with its evidence and the sequences as JSON to this file.'),
        apply: z.boolean().optional().describe('Apply the solutions to the project now, as one atomic batch.'),
      },
    },
    async (args) =>
      toResult(
        await cli(['solutions', 'propose', ...(args.ops_file ? ['--ops', args.ops_file] : []), ...(args.details_file ? ['--details', args.details_file] : []), ...(args.apply ? ['--apply'] : [])], {
          project: projectOf(args),
        }),
      ),
  );
}
