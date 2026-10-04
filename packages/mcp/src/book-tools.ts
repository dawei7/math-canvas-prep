import { z } from 'zod';
import { dryRun, flags, force, page, projectArg, rect, rectArg, region, regionArg, snap, type ToolApi } from './args.js';

/**
 * The tools for auditing a book as an authority: authoritative exercises (named by the number the book prints, inside a
 * section), their hidden solution regions, the sections (the outline with ids) and what the book says about itself.
 * Each runs the matching `mcprep` command in process, so the two can never disagree.
 */

export const BOOK_INSTRUCTIONS = `

Auditing a book as an authority. There are two kinds of exercise. What a person frames for themselves (add_frame) has a free, positional number (E1, E2.1) and can be cut into parts. An authoritative book exercise (exercises_add) is audited once from a book: it is ONE printed exercise, named by the number the book prints (its label: 5, 5a, A.3, never positional) inside a section of the book (the id of an outline entry). The parts of a printed exercise (5a and 5b) are two exercises with two labels, and the statement they share is context on each: authoritative exercises are never cut into parts. Context is what the learner sees and the AI receives; solution regions (solution_add) are regions of the SAME PDF, usually the answer key at the back, used only to grade and hidden from the learner. Sections are the outline entries: first make the outline (adopt_pdf_outline, derive_outline, set_outline or outline_add) and give its entries ids (outline_ids); then exercises_add for every printed exercise (or apply_operations with "authority": "book"), solution_add for its answer, render_crop of every exercise and of its solution region, validate, book_show to compare the counts with the book, book_meta for author, licence and notice, export_bundle. Name a book exercise by its frame id or by SECTION:LABEL (1.2:5a). Applying the same batch twice does not duplicate book exercises: an exercise is identified by its section and label. Long lists in a result (frames, steps, exercises, solutions, warnings) are cut after 500 entries and a field such as framesOmitted says how many were left out: ask for a section or a page instead of everything.`;

const exerciseRef = z.string().min(1).describe('The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).');
const sectionId = z.string().min(1).describe('The id of the outline entry (the section) the exercise belongs to; get_outline lists them.');
const label = z.string().min(1).max(24).describe('The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters: letters, digits, spaces and . _ - ( ) /).');
/** A text that starts with @ would be read as a file name by the command line: write it with a second @. */
const plainText = (text: string): string => (text.startsWith('@') ? `@${text}` : text);
const regions = (what: string): z.ZodOptional<z.ZodArray<typeof region>> => z.array(region).max(8).optional().describe(what);

export function registerBookTools({ tool, cli, toResult, projectOf }: ToolApi): void {
  // ------------------------------------------------------------------------------------------------ exercises

  tool(
    'exercises_list',
    {
      title: 'List the authoritative book exercises',
      description:
        'The authoritative exercises by section (in the order of the outline) and, within a section, in reading order: id, label (the number the book prints), section, reference (SECTION:LABEL, how to name it), page, rect, and the number of context, continuation and solution regions. totals say how many there are in the whole project and how many have a solution. Use without_solution to see which still have no answer attached.',
      inputSchema: {
        project: projectArg,
        section: z.string().optional().describe('Only the exercises filed under this section.'),
        subtree: z.boolean().optional().describe('With section: also the sections below it.'),
        page: page.optional().describe('Only exercises that start on this page.'),
        with_solution: z.boolean().optional(),
        without_solution: z.boolean().optional(),
      },
      readOnly: true,
    },
    async (args) =>
      toResult(
        await cli(
          ['exercises', 'list', ...(args.section ? ['--section', args.section] : []), ...(args.subtree ? ['--subtree'] : []), ...(args.page !== undefined ? ['--page', String(args.page)] : []), ...(args.with_solution ? ['--with-solution'] : []), ...(args.without_solution ? ['--without-solution'] : [])],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'exercises_add',
    {
      title: 'Add an authoritative book exercise',
      description:
        'Adds ONE printed exercise of the book with the label the book prints, in its section. It contains its number and statement and everything up to but not including the next exercise\'s number, without page headers or footers. It is a single exercise: it has no parts. The parts of a printed exercise (5a, 5b) are two exercises with two labels; the statement printed once above them is attached to each as context. Adding an exercise that exists (same section and label) is an error, so that applying the same calls twice does no harm; replace=true overwrites it in place instead (page, rect and continuation are replaced, context and solution when given). A rect below the minimum is enlarged; with snap the edges move off lines of text. Returns the change report. For many exercises use apply_operations with "authority": "book".',
      inputSchema: {
        project: projectArg,
        section: sectionId,
        label,
        page,
        rect,
        snap,
        id: z.string().optional().describe('Your own frame id ([A-Za-z0-9_-], up to 40 characters); default generated (f1, f2, ...).'),
        context: regions('The instruction or statement the learner sees and the AI receives with every check (printed once above 5a and 5b, say).'),
        continues: regions('Further regions of the same exercise, in reading order (the next page, the next column).'),
        solution: regions('Where the answer is printed in this PDF (the answer key at the back): hidden from the learner, used only to grade.'),
        replace: z.boolean().optional().describe('Overwrite the exercise in place if it exists (same section and label).'),
        dry_run: dryRun,
        force,
      },
    },
    async (args) =>
      toResult(
        await cli(
          [
            'exercises',
            'add',
            '--section',
            args.section,
            '--label',
            args.label,
            '--page',
            String(args.page),
            '--rect',
            rectArg(args.rect),
            ...(args.id ? ['--id', args.id] : []),
            ...(args.context ?? []).flatMap((entry) => ['--context', regionArg(entry)]),
            ...(args.continues ?? []).flatMap((entry) => ['--continues', regionArg(entry)]),
            ...(args.solution ?? []).flatMap((entry) => ['--solution', regionArg(entry)]),
            ...(args.replace ? ['--replace'] : []),
            ...flags({ snap: args.snap, dryRun: args.dry_run, force: args.force }),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'exercises_mark',
    {
      title: 'Make an exercise an authoritative book exercise',
      description: 'Gives an exercise that a person framed the label the book prints and its section: it keeps its place, context and solution, loses its positional number (E3) and is named by label and section from now on. It cannot be part of a unit (merge_frames first).',
      inputSchema: { project: projectArg, id: exerciseRef, label, section: sectionId, dry_run: dryRun, force },
    },
    async (args) => toResult(await cli(['exercises', 'mark', args.id, '--label', args.label, '--section', args.section, ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  tool(
    'exercises_unmark',
    {
      title: 'Turn a book exercise back into an ordinary exercise',
      description: 'The exercise loses its label and section, gets a positional number again and can be cut into parts. Its context and solution regions stay.',
      inputSchema: { project: projectArg, id: exerciseRef, dry_run: dryRun, force },
    },
    async (args) => toResult(await cli(['exercises', 'unmark', args.id, ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  tool(
    'exercises_label',
    {
      title: 'Change the label of a book exercise',
      description: 'Changes the printed number of an authoritative exercise. A label that is already taken in the section is refused, naming both exercises.',
      inputSchema: { project: projectArg, id: exerciseRef, label, dry_run: dryRun, force },
      idempotent: true,
    },
    async (args) => toResult(await cli(['exercises', 'label', args.id, args.label, ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  tool(
    'exercises_section',
    {
      title: 'Move a book exercise to another section',
      description: 'Files an authoritative exercise under another section (an outline entry id).',
      inputSchema: { project: projectArg, id: exerciseRef, section: sectionId, dry_run: dryRun, force },
      idempotent: true,
    },
    async (args) => toResult(await cli(['exercises', 'section', args.id, args.section, ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  // ------------------------------------------------------------------------------------------------ solutions

  tool(
    'solution_add',
    {
      title: 'Attach a solution region to an exercise',
      description:
        'Attaches a region of the SAME PDF where the answer is printed (usually the answer key at the back) to an exercise. It is hidden and used only to grade: the learner never sees it with the exercise and it is never sent to a tutor chat. Typically one small region per exercise (the line "22) 0") or one block that answers several exercises (give the same region to each). Up to 8 per exercise. Then LOOK at it: render_crop with region "solution:0". The instruction that the learner does see is context (add_context), not this.',
      inputSchema: { project: projectArg, id: exerciseRef, page, rect, snap, dry_run: dryRun, force },
    },
    async (args) => toResult(await cli(['solution', 'add', args.id, '--page', String(args.page), '--rect', rectArg(args.rect), ...flags({ snap: args.snap, dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  tool(
    'solution_list',
    {
      title: 'List the solution regions',
      description: 'The solution regions of one exercise, or of every exercise that has some (frame, label, reference, regions with index, page and rect). With missing=true instead the book exercises that have no solution region yet.',
      inputSchema: { project: projectArg, id: exerciseRef.optional(), missing: z.boolean().optional() },
      readOnly: true,
    },
    async (args) => toResult(await cli(['solution', 'list', ...(args.id ? [args.id] : []), ...(args.missing ? ['--missing'] : [])], { project: projectOf(args) })),
  );

  tool(
    'solution_remove',
    {
      title: 'Remove solution regions',
      description: 'Removes one solution region of an exercise (index from 0, as solution_list shows; needed when there are several) or all of them (all=true).',
      inputSchema: { project: projectArg, id: exerciseRef, index: z.number().int().min(0).optional(), all: z.boolean().optional(), dry_run: dryRun, force },
      destructive: true,
    },
    async (args) => toResult(await cli(['solution', 'remove', args.id, ...(args.index !== undefined ? ['--index', String(args.index)] : []), ...(args.all ? ['--all'] : []), ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args) })),
  );

  // ------------------------------------------------------------------------------------------------ the book

  tool(
    'book_show',
    {
      title: 'The book: sections, exercise counts, totals',
      description:
        'The summary of the book: its information (title, author, licence, ...), every outline entry as a section (index, id, label, title, page, top, depth, parent) with the number of book exercises filed under it (exercises), under it and everything below it (exercisesTotal), how many of them have a solution, and the first and last label; and the totals (sections, book exercises, with and without solution, exercises filed under a section the outline does not have, and what a person framed for themselves). Compare the counts with the book. With exercises=true each section also lists its own exercises. The format is described by get_schema("book-summary").',
      inputSchema: { project: projectArg, used: z.boolean().optional().describe('Only the sections that hold exercises, and the entries above them (text rendering only).'), exercises: z.boolean().optional().describe('Also list the own exercises of each section.') },
      readOnly: true,
    },
    async (args) => toResult(await cli(['book', 'show', ...(args.used ? ['--used'] : []), ...(args.exercises ? ['--exercises'] : [])], { project: projectOf(args) })),
  );

  tool(
    'book_meta',
    {
      title: 'Show or set what the book says about itself',
      description:
        'The title and library folder, and the author, series, description, licence (name and address), source address and notice that go into the bundle. The licence travels with the file: a licence that asks for attribution needs its notice shown wherever the book is shown, so give notice the text the licence asks for (who wrote it, under which licence, what was changed). An empty text removes a field; web addresses are http or https. Without arguments it returns the current values.',
      inputSchema: {
        project: projectArg,
        title: z.string().optional(),
        folder: z.string().optional().describe('Library folder, names separated by "/", at most seven levels; "" removes it.'),
        author: z.string().max(200).optional(),
        series: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        license_name: z.string().max(100).optional().describe('For example "CC BY 3.0". A new name replaces the whole licence (give license_url again).'),
        license_url: z.string().max(500).optional().describe('Where the licence is (http or https); "" removes it.'),
        no_license: z.boolean().optional().describe('Remove the licence.'),
        source_url: z.string().max(500).optional().describe('Where the work comes from (http or https).'),
        notice: z.string().max(4000).optional().describe('The text the licence asks to be shown with the work.'),
        dry_run: dryRun,
        force,
      },
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'book',
            'meta',
            ...(args.title !== undefined ? ['--title', args.title] : []),
            ...(args.folder !== undefined ? ['--folder', args.folder] : []),
            ...(args.author !== undefined ? ['--author', plainText(args.author)] : []),
            ...(args.series !== undefined ? ['--series', plainText(args.series)] : []),
            ...(args.description !== undefined ? ['--description', plainText(args.description)] : []),
            ...(args.license_name !== undefined ? ['--license-name', args.license_name] : []),
            ...(args.license_url !== undefined ? ['--license-url', args.license_url] : []),
            ...(args.no_license ? ['--no-license'] : []),
            ...(args.source_url !== undefined ? ['--source-url', args.source_url] : []),
            ...(args.notice !== undefined ? ['--notice', plainText(args.notice)] : []),
            ...flags({ dryRun: args.dry_run, force: args.force }),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'book_export',
    {
      title: 'Write the book summary as a JSON file',
      description: 'Writes the summary of book_show as a plain, documented JSON file (camelCase, zero-based pages; get_schema("book-summary")): the sections with their exercise and solution counts, the totals and the information about the book. Default path: name.book.json next to the project.',
      inputSchema: { project: projectArg, out: z.string().optional().describe('Where to write it.'), exercises: z.boolean().optional().describe('Also list the own exercises of each section.') },
    },
    async (args) => toResult(await cli(['book', 'export', ...(args.out ? ['--out', args.out] : []), ...(args.exercises ? ['--exercises'] : [])], { project: projectOf(args) })),
  );

  // ------------------------------------------------------------------------------------------------ sections

  tool(
    'outline_add',
    {
      title: 'Add a section to the outline',
      description:
        'Adds an entry to the outline (the sections of the book), at the end or at position "at" (from 0). It gets an id unless you give one or say no_id; the id is what exercises name as their section. depth 0 is a chapter, 1 a section in it, and so on; a child follows its parent and is one level deeper.',
      inputSchema: {
        project: projectArg,
        title: z.string().min(1).max(200),
        page,
        depth: z.number().int().min(0).max(8).optional(),
        id: z.string().optional().describe('The id (letters, digits, . _ -, starting with a letter or digit, up to 60 characters). Default: made from the label or the title.'),
        no_id: z.boolean().optional(),
        label: z.string().max(24).optional().describe('The number printed with the heading ("1.1", "Chapter 3").'),
        top: z.number().min(0).max(1).optional().describe('Where the heading starts on its page, from the top (0 to 1).'),
        at: z.number().int().min(0).optional().describe('Insert at this position of the outline instead of at the end.'),
      },
    },
    async (args) =>
      toResult(
        await cli(
          [
            'outline',
            'add',
            '--title',
            args.title,
            '--page',
            String(args.page),
            ...(args.depth !== undefined ? ['--depth', String(args.depth)] : []),
            ...(args.id ? ['--id', args.id] : []),
            ...(args.no_id ? ['--no-id'] : []),
            ...(args.label ? ['--label', args.label] : []),
            ...(args.top !== undefined ? ['--top', String(args.top)] : []),
            ...(args.at !== undefined ? ['--at', String(args.at)] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'outline_update',
    {
      title: 'Change a section of the outline',
      description:
        'Changes one outline entry, named by its id (or by index, its position from 0, when it has none): title, page, depth, label ("" removes it), top (null removes it) or id (new_id; the exercises filed under the old id follow). Changing the depth moves only this entry.',
      inputSchema: {
        project: projectArg,
        id: z.string().optional().describe('The id of the entry.'),
        index: z.number().int().min(0).optional().describe('The position of the entry in the outline, for an entry that has no id.'),
        title: z.string().min(1).max(200).optional(),
        page: page.optional(),
        depth: z.number().int().min(0).max(8).optional(),
        new_id: z.string().optional(),
        label: z.string().max(24).optional(),
        top: z.number().min(0).max(1).nullable().optional(),
      },
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(
          [
            'outline',
            'update',
            ...(args.id ? [args.id] : []),
            ...(args.index !== undefined ? ['--index', String(args.index)] : []),
            ...(args.title !== undefined ? ['--title', args.title] : []),
            ...(args.page !== undefined ? ['--page', String(args.page)] : []),
            ...(args.depth !== undefined ? ['--depth', String(args.depth)] : []),
            ...(args.new_id !== undefined ? ['--new-id', args.new_id] : []),
            ...(args.label !== undefined ? ['--label', args.label] : []),
            ...(args.top !== undefined ? ['--top', args.top === null ? 'none' : String(args.top)] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'outline_delete',
    {
      title: 'Delete a section of the outline',
      description: 'Deletes an outline entry, named by id (or index). The entries below it move up one level, or are deleted with it (subtree=true). A section that book exercises are filed under cannot be deleted: move them first (exercises_section).',
      inputSchema: { project: projectArg, id: z.string().optional(), index: z.number().int().min(0).optional(), subtree: z.boolean().optional() },
      destructive: true,
    },
    async (args) => toResult(await cli(['outline', 'delete', ...(args.id ? [args.id] : []), ...(args.index !== undefined ? ['--index', String(args.index)] : []), ...(args.subtree ? ['--subtree'] : [])], { project: projectOf(args) })),
  );

  tool(
    'outline_ids',
    {
      title: 'Give every section an id',
      description: 'Gives every outline entry that has no id one (from its printed label, else the number at the start of its title, else a short form of the title), so that exercises can name it. Entries that have an id keep it. Use it after adopt_pdf_outline or derive_outline.',
      inputSchema: { project: projectArg },
      idempotent: true,
    },
    async (args) => toResult(await cli(['outline', 'ids'], { project: projectOf(args) })),
  );
}
