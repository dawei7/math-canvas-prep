import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { run } from '@mcprep/cli';
import { CALL_LOG_ENV, VERSION, appendCallLog, readAgentGuide } from '@mcprep/core';
import { z } from 'zod';
import { AUDIT_INSTRUCTIONS, registerAuditTools } from './audit-tools.js';
import { capLists, dryRun, flags, force, frameId, kind, page, projectArg, rect, rectArg, region, regionArg, snap, type CliResult } from './args.js';
import { BOOK_INSTRUCTIONS, registerBookTools } from './book-tools.js';
import { GATE_INSTRUCTIONS, registerGateTools } from './gate-tools.js';
import { VERIFY_INSTRUCTIONS, registerVerifyTools } from './verify-tools.js';

/**
 * The MCP server: the same operations as the `mcprep` command line, as typed tools with descriptions that teach the
 * conventions. Every tool runs the command line in process (so the two can never disagree), parses its JSON result and
 * returns it; the images of `render_page` and `render_crop` come back as image content.
 */

export interface ServerOptions {
  /** The project to work on until a tool says otherwise (default: $MCPREP_PROJECT). */
  project?: string;
  /** Where relative paths are resolved (default: the process folder). */
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * A file that every tool call is appended to, as one line of JSON written after the call returned (default: $MCPREP_CALL_LOG;
   * none when neither is set). See docs/AGENT_GUIDE.md, "Comparing two agent runs".
   */
  callLog?: string;
}

const INSTRUCTIONS = `Math Canvas Prep marks exercises, parts, context, questions and bookmarks in a mathematics PDF and exports a bundle (.mcbundle) for the Android app Professor Euler: Math Canvas.

Conventions: pages are ZERO-BASED (the first page is 0). Positions are fractions of the page as displayed (after /Rotate), origin at the TOP-LEFT, x to the right, y downwards, all between 0 and 1; a rectangle is [left, top, right, bottom]. Labels like E4.2, Q1, B3 are computed from position and never stored: refer to frames by id.

Workflow: create_project (or open_project) -> project_info -> render_page with a grid to understand the layout -> propose -> apply_operations (one atomic batch) -> render_crop for EVERY frame and LOOK at the images -> fix -> validate -> export_bundle -> import_check -> tell the user where the bundle is. Read the resource mcprep://guide (or call get_guide) first: it explains where exercises start and end, how to cut parts, context, continuations, scans and what not to do.

Nothing is sent anywhere: the tools make no network calls.`;

export function createServer(options: ServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let current: string | undefined = options.project ?? env['MCPREP_PROJECT'];
  const callLog = options.callLog !== undefined && options.callLog !== '' ? options.callLog : env[CALL_LOG_ENV];
  // The command line the tools run in process would log the same call a second time: it is not given the log.
  const { [CALL_LOG_ENV]: _logged, ...cliEnv } = env;
  const server = new McpServer({ name: 'math-canvas-prep', version: VERSION }, { instructions: `${INSTRUCTIONS}${BOOK_INSTRUCTIONS}${AUDIT_INSTRUCTIONS}${VERIFY_INSTRUCTIONS}${GATE_INSTRUCTIONS}` });

  async function cli(argv: string[], extra: { stdin?: string; project?: string | undefined } = {}): Promise<CliResult> {
    let out = '';
    let err = '';
    const projectPath = extra.project ?? current;
    // An empty string means "no project" (commands that work on a file only).
    const args = [...argv, ...(projectPath !== undefined && projectPath !== '' ? ['--project', isAbsolute(projectPath) ? projectPath : resolve(cwd, projectPath)] : []), '--json'];
    const code = await run(args, {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      stdin: () => Promise.resolve(extra.stdin ?? ''),
      cwd,
      env: { ...cliEnv },
    });
    const text = out.trim();
    if (text.startsWith('{')) return { code, envelope: JSON.parse(text) as CliResult['envelope'] };
    return { code, envelope: { ok: false, error: { code: 'E_INTERNAL', message: err.trim() || 'The command printed nothing.' } } };
  }

  const text = (value: unknown): { type: 'text'; text: string } => ({ type: 'text', text: JSON.stringify(value, null, 2) });

  function toResult(done: CliResult, extraContent: CallToolResult['content'] = []): CallToolResult {
    const { envelope } = done;
    if (!envelope.ok && envelope.error) {
      const failure = { ok: false, exitCode: done.code, error: envelope.error, ...(envelope.result ? { result: envelope.result } : {}) };
      return { isError: true, content: [text(failure)], structuredContent: failure };
    }
    const body = capLists({ ...(envelope.result ?? {}), ...(envelope.warnings && envelope.warnings.length > 0 ? { warnings: envelope.warnings } : {}), ...(envelope.notes && envelope.notes.length > 0 ? { notes: envelope.notes } : {}) });
    // validate and import_check report "not ok" through their exit code but are not tool failures.
    return { content: [text(body), ...extraContent], structuredContent: body };
  }

  /** Tools that need a project fail with a clear message when none is known. */
  function needsProject(project: string | undefined): CallToolResult | undefined {
    if (project !== undefined || current !== undefined) return undefined;
    const failure = { ok: false, error: { code: 'E_NO_PROJECT', message: 'No project is open in this session.', hint: 'Call create_project with the PDF, or open_project with an existing name.mcprep.json, or pass "project" to this tool.' } };
    return { isError: true, content: [text(failure)], structuredContent: failure };
  }

  /** Appends the call to the call log, after it returned; a log that cannot be written is reported on standard error, never to the client. */
  async function record(name: string, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    if (callLog === undefined || callLog === '') return;
    const code = result.isError === true ? ((result.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code ?? 'E_INTERNAL') : undefined;
    const problem = await appendCallLog(isAbsolute(callLog) ? callLog : resolve(cwd, callLog), {
      surface: 'mcp',
      tool: name,
      arguments: args,
      ok: result.isError !== true,
      ...(typeof code === 'string' ? { error: code } : {}),
    });
    if (problem !== undefined) process.stderr.write(`mcprep-mcp: the call log ${callLog} cannot be written: ${problem}\n`);
  }

  type Handler<A> = (args: A) => Promise<CallToolResult>;
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape; readOnly?: boolean; destructive?: boolean; idempotent?: boolean; project?: boolean },
    handler: Handler<z.infer<z.ZodObject<Shape>>>,
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: { readOnlyHint: config.readOnly === true, destructiveHint: config.destructive === true, idempotentHint: config.idempotent === true, openWorldHint: false },
      },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        let result: CallToolResult | undefined;
        if (config.project !== false) result = needsProject((args as { project?: string }).project);
        if (result === undefined) {
          try {
            result = await handler(args);
          } catch (error) {
            const failure = { ok: false, error: { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) } };
            result = { isError: true, content: [text(failure)], structuredContent: failure };
          }
        }
        await record(name, args as Record<string, unknown>, result);
        return result;
      }) as never,
    );
  }

  const projectOf = (args: { project?: string | undefined }): string | undefined => args.project;

  // ------------------------------------------------------------------------------------------------------ project

  tool(
    'create_project',
    {
      title: 'Create a project for a PDF',
      description:
        'Starts work on a PDF: reads it once (page count, SHA-256) and writes name.mcprep.json next to it (or at "project"). The PDF is never modified; the project refers to it by a relative path. The new project becomes the default project of this session. Use "folder" for where the document is filed in the app library (names separated by "/", at most seven levels).',
      inputSchema: {
        pdf: z.string().describe('Path of the PDF to mark.'),
        project: z.string().optional().describe('Where to write the project file (default: next to the PDF).'),
        title: z.string().optional().describe('The title the library shows (1 to 200 characters; default: the file name).'),
        folder: z.string().optional().describe('Library folder, for example "University/Analysis/Sheets".'),
        force: z.boolean().optional().describe('Overwrite an existing project file.'),
      },
      project: false,
    },
    async (args) => {
      const done = await cli(['init', args.pdf, ...(args.project ? ['--out', args.project] : []), ...(args.title ? ['--title', args.title] : []), ...(args.folder ? ['--folder', args.folder] : []), ...(args.force ? ['--force'] : [])], { project: '' });
      const created = done.envelope.result?.['project'];
      if (done.envelope.ok && typeof created === 'string') current = created;
      return toResult(done);
    },
  );

  tool(
    'open_project',
    {
      title: 'Open an existing project',
      description: 'Makes an existing project (name.mcprep.json) the default project of this session and returns its summary (see project_info). Use it to continue work, or after a person or another agent changed the file.',
      inputSchema: { project: z.string().describe('Path of the project file, or of a folder that holds exactly one.') },
      readOnly: true,
      project: false,
    },
    async (args) => {
      const done = await cli(['info'], { project: args.project });
      if (done.envelope.ok) current = (done.envelope.result?.['project'] as { path?: string } | undefined)?.path ?? args.project;
      return toResult(done);
    },
  );

  tool(
    'project_info',
    {
      title: 'Project and PDF summary',
      description:
        'Pages (count, sizes, /Rotate), whether the pages have a text layer (a page without one is a scan and must be marked by eye), the PDF\'s own outline, the project\'s title and folder, and how many frames there are. Call it first.',
      inputSchema: { project: projectArg, full_text: z.boolean().optional().describe('Check the text layer of every page instead of a sample of 12.') },
      readOnly: true,
    },
    async (args) => toResult(await cli(['info', ...(args.full_text ? ['--full-text'] : [])], { project: projectOf(args) })),
  );

  tool(
    'set_metadata',
    {
      title: 'Set the title and folder',
      description: 'Changes the title the app library shows and the folder it files the document in. Without title and folder it only returns the current values. The author, series, description, licence, source address and notice of a book are set with book_meta.',
      inputSchema: { project: projectArg, title: z.string().optional(), folder: z.string().optional().describe('Names separated by "/", at most seven levels; "" removes it.') },
      idempotent: true,
    },
    async (args) => toResult(await cli(['meta', ...(args.title !== undefined ? ['--title', args.title] : []), ...(args.folder !== undefined ? ['--folder', args.folder] : [])], { project: projectOf(args) })),
  );

  // ------------------------------------------------------------------------------------------------ looking

  tool(
    'get_page_lines',
    {
      title: 'Text lines of a page with coordinates',
      description:
        'The text lines of one page in reading order (columns left to right, each top to bottom), each with its box as page fractions (origin top-left), font size, column, and whether it is a running header or footer (and bold, with fonts=true). Use it to find where exercises start and end. An empty list means the page has no text layer: it is a scan; use render_page with a grid instead.',
      inputSchema: { project: projectArg, page, region: rect.optional().describe('Only the lines inside this rectangle.'), fonts: z.boolean().optional().describe('Also tell which lines are bold (slower).') },
      readOnly: true,
    },
    async (args) => toResult(await cli(['lines', String(args.page), ...(args.region ? ['--region', rectArg(args.region)] : []), ...(args.fonts ? ['--fonts'] : [])], { project: projectOf(args) })),
  );

  async function imageResult(done: CliResult): Promise<CallToolResult> {
    if (!done.envelope.ok) return toResult(done);
    const entries = (done.envelope.result?.['crops'] as { path: string }[] | undefined) ?? [{ path: String(done.envelope.result?.['path']) }];
    const images: CallToolResult['content'] = [];
    for (const entry of entries) images.push({ type: 'image', data: (await readFile(entry.path)).toString('base64'), mimeType: 'image/png' });
    return toResult(done, images);
  }

  tool(
    'render_page',
    {
      title: 'Render a page as an image',
      description:
        'Renders a page to a PNG and returns it as an image (the file path is in the result too). grid=0.1 draws a labelled grid: the labels are page coordinates (origin top-left), so you can read positions off the image. frames=true draws the project\'s frames with their labels (E1, E2.1, Q1, B1; dashed = continuation or context). LOOK at the image: it is how you read the layout and check your marking.',
      inputSchema: {
        project: projectArg,
        page,
        grid: z.number().min(0.01).max(0.5).optional().describe('Grid step as a fraction of the page, for example 0.1 or 0.05.'),
        frames: z.boolean().optional().describe('Draw the frames of the project on the page.'),
        solutions: z.boolean().optional().describe('With frames: also draw the hidden solution regions (dashed, "sol 5a"): use it on the answer-key pages to check where the answers were attached.'),
        max_side: z.number().int().min(200).max(4000).optional().describe('Longer side in pixels (default 1200 here).'),
      },
      readOnly: true,
    },
    async (args) =>
      imageResult(await cli(['render', String(args.page), '--max-side', String(args.max_side ?? 1200), ...(args.grid ? ['--grid', String(args.grid)] : []), ...(args.frames ? ['--frames'] : []), ...(args.solutions ? ['--solutions'] : [])], { project: projectOf(args) })),
  );

  tool(
    'render_crop',
    {
      title: 'Render a frame or a rectangle as an image',
      description:
        'Renders one frame (its main region, or a continuation, context or solution region), or any rectangle of a page, to a PNG and returns it as an image. This is how you CHECK a frame: the exercise number and first words must be at the top, nothing of the next exercise at the bottom, no line cut in half, no header or footer, the figure inside; and for a book exercise region "solution:0" shows the answer that was attached to it. With grid the labels are still page coordinates. Give "frame" (an id, or SECTION:LABEL for a book exercise), or "page" and "rect".',
      inputSchema: {
        project: projectArg,
        frame: frameId.optional(),
        region: z.string().optional().describe('With frame: main (default), continues:N, context:N or solution:N (N from 0).'),
        page: page.optional(),
        rect: rect.optional(),
        grid: z.number().min(0.005).max(0.5).optional().describe('Grid step as a fraction of the page, for example 0.05 or 0.02.'),
        max_side: z.number().int().min(200).max(4000).optional().describe('Longer side in pixels (default 1000 here).'),
      },
      readOnly: true,
    },
    async (args) => {
      const target = args.frame !== undefined ? [args.frame, ...(args.region ? ['--region', args.region] : [])] : args.page !== undefined && args.rect ? ['--page', String(args.page), '--rect', rectArg(args.rect)] : undefined;
      if (!target) {
        const failure = { ok: false, error: { code: 'E_USAGE', message: 'Give "frame", or "page" and "rect".' } };
        return { isError: true, content: [text(failure)], structuredContent: failure };
      }
      return imageResult(await cli(['crop', ...target, '--max-side', String(args.max_side ?? 1000), ...(args.grid ? ['--grid', String(args.grid)] : [])], { project: projectOf(args) }));
    },
  );

  // ------------------------------------------------------------------------------------------------ outline

  tool(
    'get_outline',
    {
      title: 'The contents the bundle will carry',
      description:
        'The project\'s own outline if it has one (that goes into the bundle), else the PDF\'s own bookmarks (the bundle then carries none and the app reads the PDF\'s). Entries are { index, title, page (zero-based), depth, id?, label?, top? }: the entries are the SECTIONS of the book. With the project\'s own outline each entry also says how many authoritative book exercises are filed under it (exercises) and under it with everything below it (exercisesTotal), and how many of those have a solution (withSolution).',
      inputSchema: { project: projectArg },
      readOnly: true,
    },
    async (args) => toResult(await cli(['outline'], { project: projectOf(args) })),
  );

  tool(
    'adopt_pdf_outline',
    {
      title: 'Use the PDF\'s own bookmarks as the contents',
      description: 'Copies the PDF\'s bookmarks into the project so that they are exported and can be edited.',
      inputSchema: { project: projectArg },
      idempotent: true,
    },
    async (args) => toResult(await cli(['outline', 'pdf', '--adopt'], { project: projectOf(args) })),
  );

  tool(
    'derive_outline',
    {
      title: 'Find headings for a PDF without an outline',
      description: 'Heuristics: a line is a heading when it is set larger than the body text, in bold, numbered like "2.1" or starts with a chapter word; depth from numbering or font size. Returns entries with confidence and evidence. With apply=true they are stored in the project (check them first).',
      inputSchema: { project: projectArg, apply: z.boolean().optional(), min_confidence: z.number().min(0).max(1).optional() },
      idempotent: true,
    },
    async (args) => toResult(await cli(['outline', 'derive', ...(args.apply ? ['--apply'] : []), ...(args.min_confidence !== undefined ? ['--min-confidence', String(args.min_confidence)] : [])], { project: projectOf(args) })),
  );

  tool(
    'set_outline',
    {
      title: 'Write the contents by hand',
      description:
        'Replaces the project\'s outline. Entries are { title (1 to 200 characters), page (zero-based), depth (0 to 8; a child is one deeper than its parent), id?, label?, top? } in reading order. The id is what exercises name as their section (unique; letters, digits, . _ -, starting with a letter or digit), the label is the number printed with the heading ("1.1", "Chapter 3"), the top is where the heading starts on its page (0 to 1, from the top). auto_ids gives the entries without an id one. A change that leaves book exercises filed under an id the new outline no longer has is refused. An empty list stores an empty outline; use clear_outline to remove the project\'s outline altogether. outline_add, outline_update and outline_delete change single entries.',
      inputSchema: {
        project: projectArg,
        entries: z.array(z.object({ title: z.string(), page, depth: z.number().int().min(0).max(8), id: z.string().optional(), label: z.string().max(24).optional(), top: z.number().min(0).max(1).optional() })),
        auto_ids: z.boolean().optional().describe('Give every entry that has no id one (from its label, else the number in its title).'),
      },
      idempotent: true,
    },
    async (args) => toResult(await cli(['outline', 'set', '-', ...(args.auto_ids ? ['--auto-ids'] : [])], { project: projectOf(args), stdin: JSON.stringify(args.entries) })),
  );

  tool(
    'clear_outline',
    { title: 'Remove the project outline', description: 'The bundle then carries no outline and the app reads the PDF\'s own.', inputSchema: { project: projectArg }, idempotent: true },
    async (args) => toResult(await cli(['outline', 'clear'], { project: projectOf(args) })),
  );

  // ------------------------------------------------------------------------------------------------ propose

  tool(
    'propose',
    {
      title: 'Suggest exercises, parts, context and bookmarks',
      description:
        'Offline heuristics (no AI) over the printed text: lines that start an exercise ("Exercise 3", "Aufgabe 3", "3.", "3)"), where each ends (before the next start, a heading or a definition; over a figure; onto the next page when the text goes on), part markers (a) (b) (c) inside an exercise, instructions printed for several exercises ("Exercises 3 and 4") and definitions, theorems and remarks as bookmarks. Every proposal has a confidence and its evidence, and the result includes "operations" that create them (give them to apply_operations, after editing if you like). Nothing is applied unless apply=true. It is a starting point: check the crops.',
      inputSchema: {
        project: projectArg,
        pages: z.string().optional().describe('Zero-based pages to look at, like "0,2,5-7" (default all). Try ten pages first on a big book.'),
        min_confidence: z.number().min(0).max(1).optional().describe('Default 0.5.'),
        bookmarks: z.boolean().optional().describe('Propose definitions, theorems, remarks as bookmarks (default true).'),
        graphics: z.boolean().optional().describe('Render pages to find figures so that frames reach over them (default true; slower).'),
        parts: z.enum(['context', 'keep', 'none']).optional().describe('What to do with the statement above (a): context (default, recommended: it becomes context of the exercise and the first part starts at (a)), keep (leave it in the first part, as the app\'s own splitter does), none (no parts).'),
        ids: z.array(z.string()).optional().describe('With apply: only these proposal ids (p1, p3).'),
        apply: z.boolean().optional().describe('Apply the proposals to the project now, as one atomic batch.'),
      },
    },
    async (args) =>
      toResult(
        await cli(
          [
            'propose',
            ...(args.pages ? ['--pages', args.pages] : []),
            ...(args.min_confidence !== undefined ? ['--min-confidence', String(args.min_confidence)] : []),
            ...(args.bookmarks === false ? ['--no-bookmarks'] : []),
            ...(args.graphics === false ? ['--no-graphics'] : []),
            ...(args.parts ? ['--parts', args.parts] : []),
            ...(args.ids && args.ids.length > 0 ? ['--ids', args.ids.join(',')] : []),
            ...(args.apply ? ['--apply'] : []),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  // ------------------------------------------------------------------------------------------------ frames

  tool(
    'list_frames',
    {
      title: 'List the frames with their labels',
      description:
        'All frames in reading order with id, label, kind, authority, page, rect, unit, part, and the number of context, continuation and solution regions. Two kinds of exercise: those a person framed for themselves have a positional label (E2.1, Q1, B3: computed, never stored; authority "user"); authoritative book exercises (authority "book") are named by the number the book prints and the section they belong to (reference "1.2:5a"). counts are the positional ones; book says how many book exercises there are.',
      inputSchema: {
        project: projectArg,
        page: page.optional(),
        kind: kind.optional(),
        authority: z.enum(['book', 'user']).optional().describe('Only authoritative book exercises (book), or only what a person framed for themselves (user).'),
        section: z.string().optional().describe('Only the book exercises filed under this section (an outline entry id).'),
      },
      readOnly: true,
    },
    async (args) =>
      toResult(
        await cli(['frames', 'list', ...(args.page !== undefined ? ['--page', String(args.page)] : []), ...(args.kind ? ['--kind', args.kind] : []), ...(args.authority ? ['--authority', args.authority] : []), ...(args.section ? ['--section', args.section] : [])], { project: projectOf(args) }),
      ),
  );

  tool(
    'add_frame',
    {
      title: 'Add a frame',
      description:
        'Adds an exercise, a question or a bookmark. An exercise contains its number and statement and everything up to but not including the next exercise\'s number, without page headers or footers. A rect below the minimum (0.02 wide, 0.01 tall) is enlarged around its centre. With snap the edges move off lines of text. Returns the change report (created ids, labels, validation). Use split_frame afterwards to cut an exercise into parts, add_context for an instruction printed elsewhere. For many frames use apply_operations.',
      inputSchema: {
        project: projectArg,
        kind,
        page,
        rect,
        snap,
        id: z.string().optional().describe('Your own id ([A-Za-z0-9_-], up to 40 characters); default generated (f1, f2, ...).'),
        context: z.array(region).max(8).optional().describe('Context regions (instruction or background printed elsewhere). Exercises only.'),
        continues: z.array(region).max(8).optional().describe('Further regions of the same task, in reading order. Not for parts.'),
        dry_run: dryRun,
        force,
      },
    },
    async (args) =>
      toResult(
        await cli(
          [
            'frames',
            'add',
            '--kind',
            args.kind,
            '--page',
            String(args.page),
            '--rect',
            rectArg(args.rect),
            ...(args.id ? ['--id', args.id] : []),
            ...(args.context ?? []).flatMap((entry) => ['--context', regionArg(entry)]),
            ...(args.continues ?? []).flatMap((entry) => ['--continues', regionArg(entry)]),
            ...flags({ snap: args.snap, dryRun: args.dry_run, force: args.force }),
          ],
          { project: projectOf(args) },
        ),
      ),
  );

  tool(
    'update_frame',
    {
      title: 'Change a frame',
      description: 'Changes the page, rectangle or kind of a frame (context is dropped when it stops being an exercise). A part of an exercise cannot be changed on its own: use set_area, set_dividers or merge_frames.',
      inputSchema: { project: projectArg, id: frameId, kind: kind.optional(), page: page.optional(), rect: rect.optional(), snap, dry_run: dryRun, force },
      idempotent: true,
    },
    async (args) =>
      toResult(
        await cli(['frames', 'update', args.id, ...(args.kind ? ['--kind', args.kind] : []), ...(args.page !== undefined ? ['--page', String(args.page)] : []), ...(args.rect ? ['--rect', rectArg(args.rect)] : []), ...flags({ snap: args.snap, dryRun: args.dry_run, force: args.force })], { project: projectOf(args) }),
      ),
  );

  tool(
    'delete_frame',
    {
      title: 'Delete a frame',
      description: 'Deletes a frame; with unit=true the id is a unit id and every part of that exercise goes. A part taken out of the middle leaves no gap (the part above takes over); an exercise left with one part is an ordinary exercise again.',
      inputSchema: { project: projectArg, id: z.string().describe('The frame id, or the unit id with unit=true.'), unit: z.boolean().optional(), dry_run: dryRun },
      destructive: true,
    },
    async (args) => toResult(await cli(['frames', 'delete', args.id, ...(args.unit ? ['--unit'] : []), ...flags({ dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'move_frame',
    {
      title: 'Move a frame',
      description: 'Moves a frame by dx, dy (fractions of the page; negative = left/up). An exercise with parts moves as a whole. Stops at the page edges.',
      inputSchema: { project: projectArg, id: frameId, dx: z.number().optional(), dy: z.number().optional(), dry_run: dryRun },
    },
    async (args) => toResult(await cli(['frames', 'move', args.id, ...(args.dx !== undefined ? ['--dx', String(args.dx)] : []), ...(args.dy !== undefined ? ['--dy', String(args.dy)] : []), ...flags({ dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'split_frame',
    {
      title: 'Cut an exercise into parts',
      description:
        'Cuts an exercise into parts (a), (b), (c) = 1.1, 1.2, 1.3 that tile one area. "at" gives the y positions where the parts after the first start, each at its marker line (snap moves a divider onto the nearest line). By default the first part starts at the top of the frame, so the statement before (a) stays inside it (the Android app\'s own splitter). RECOMMENDED: pass "first", the y where the first part starts (the top of the (a) line); the text above becomes context of the exercise, which every check then receives. The original frame keeps its id as the first part. Can also cut an existing part again.',
      inputSchema: {
        project: projectArg,
        id: frameId,
        at: z.array(z.number()).min(1).describe('y positions (page fractions, top to bottom) where parts 2, 3, ... start.'),
        first: z.number().optional().describe('Where the first part starts (default: the top of the frame).'),
        preamble: z.enum(['keep', 'context', 'drop']).optional().describe('What becomes of the text above "first": context (default when first is given) or drop.'),
        snap,
        dry_run: dryRun,
        force,
      },
    },
    async (args) =>
      toResult(
        await cli(['frames', 'split', args.id, '--at', args.at.join(','), ...(args.first !== undefined ? ['--first', String(args.first)] : []), ...(args.preamble ? ['--preamble', args.preamble] : []), ...flags({ snap: args.snap, dryRun: args.dry_run, force: args.force })], { project: projectOf(args) }),
      ),
  );

  tool(
    'merge_frames',
    {
      title: 'Merge parts back',
      description: 'Merges all parts of a unit (unit="u3") or two or more neighbouring part ids (ids) into one frame.',
      inputSchema: { project: projectArg, unit: z.string().optional(), ids: z.array(z.string()).optional(), dry_run: dryRun },
    },
    async (args) => toResult(await cli(['frames', 'merge', ...(args.unit ? ['--unit', args.unit] : (args.ids ?? [])), ...flags({ dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'set_dividers',
    {
      title: 'Set the cuts between the parts',
      description: 'Sets the cuts between the parts of an exercise on a page: moves them, adds parts (more cuts) or removes the last parts (fewer). The area of the parts stays. No cuts turns it back into one frame.',
      inputSchema: { project: projectArg, id: frameId.describe('Any part of the exercise.'), at: z.array(z.number()).describe('The new cuts (y, top to bottom); empty for none.'), page: page.optional(), snap, dry_run: dryRun },
      idempotent: true,
    },
    async (args) => toResult(await cli(['frames', 'dividers', args.id, '--at', args.at.join(','), ...(args.page !== undefined ? ['--page', String(args.page)] : []), ...flags({ snap: args.snap, dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'set_area',
    {
      title: 'Move or resize a whole exercise with parts',
      description: 'Sets the area of the parts: left and right apply to every part, top to the first part, bottom to the last; the cuts between parts stay where they are.',
      inputSchema: { project: projectArg, id: frameId.describe('Any part of the exercise.'), rect, snap, dry_run: dryRun },
      idempotent: true,
    },
    async (args) => toResult(await cli(['frames', 'area', args.id, '--rect', rectArg(args.rect), ...flags({ snap: args.snap, dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'add_context',
    {
      title: 'Attach context to an exercise',
      description:
        'Attaches a region of context (the instruction, question or background printed elsewhere) to an exercise. It is shown first when the exercise is shown and goes to the AI with every check. Use it for an instruction printed once above several exercises (add it to each), or text on another page. For an exercise with parts it is kept on the first part and applies to all of them. Up to 8 regions; exercises only.',
      inputSchema: { project: projectArg, id: frameId, page, rect, snap, dry_run: dryRun },
    },
    async (args) => toResult(await cli(['context', 'add', args.id, '--page', String(args.page), '--rect', rectArg(args.rect), ...flags({ snap: args.snap, dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'remove_context',
    {
      title: 'Remove a context region',
      description: 'Removes one context region of an exercise (index from 0; needed when there are several) or all of them.',
      inputSchema: { project: projectArg, id: frameId, index: z.number().int().min(0).optional(), all: z.boolean().optional(), dry_run: dryRun },
      destructive: true,
    },
    async (args) => toResult(await cli(['context', 'remove', args.id, ...(args.index !== undefined ? ['--index', String(args.index)] : []), ...(args.all ? ['--all'] : []), ...flags({ dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'add_continuation',
    {
      title: 'Add a continuation region to a frame',
      description: 'Adds a further region of the same task after the main region (for example where an exercise goes on in the next column or on the next page); up to 8, in reading order. Not allowed for the parts of an exercise (give each page its own parts instead).',
      inputSchema: { project: projectArg, id: frameId, page, rect, snap, dry_run: dryRun },
    },
    async (args) => toResult(await cli(['continues', 'add', args.id, '--page', String(args.page), '--rect', rectArg(args.rect), ...flags({ snap: args.snap, dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'remove_continuation',
    {
      title: 'Remove a continuation region',
      description: 'Removes one continuation region (index from 0; needed when there are several) or all.',
      inputSchema: { project: projectArg, id: frameId, index: z.number().int().min(0).optional(), all: z.boolean().optional(), dry_run: dryRun },
      destructive: true,
    },
    async (args) => toResult(await cli(['continues', 'remove', args.id, ...(args.index !== undefined ? ['--index', String(args.index)] : []), ...(args.all ? ['--all'] : []), ...flags({ dryRun: args.dry_run })], { project: projectOf(args) })),
  );

  tool(
    'apply_operations',
    {
      title: 'Apply many operations atomically',
      description:
        'Applies a list of operations in one atomic batch with ONE validation at the end: any failure, or any new validation error, rejects the whole batch and writes nothing. This is how to mark a 60-page sheet in one call. Each operation has "op": add, update, delete, move, split, merge, dividers, area, context.add, context.remove, context.set, continues.add, continues.remove, authority.mark, authority.unmark, label.set, section.set, solution.add, solution.remove, solution.set, outline.set, outline.add, outline.update, outline.delete, outline.ids, outline.clear, meta.set, with the fields of the matching tools (rect as [l,t,r,b] or an object; page zero-based). An "add" may carry "ref": "a"; later operations may use "id": "@a" for the frame it created (or replaced), so you need not guess generated ids; a book exercise can also be named "SECTION:LABEL" ("1.2:5a"). An "add" with "authority": "book", "label" and "section" makes an authoritative book exercise (no "kind" needed; it cannot have a "unit"; "solution" lists regions of the answer key); applying the same batch twice does not duplicate it, the second time is an error naming the exercise, unless the "add" says "replace": true. The "operations" returned by propose can be passed as they are.',
      inputSchema: {
        project: projectArg,
        operations: z.array(z.object({ op: z.string().describe('The operation name.') }).passthrough()).describe('The operations, applied in order.'),
        dry_run: dryRun,
        force,
      },
    },
    async (args) => toResult(await cli(['frames', 'apply', '-', ...flags({ dryRun: args.dry_run, force: args.force })], { project: projectOf(args), stdin: JSON.stringify(args.operations) })),
  );

  // ------------------------------------------------------------------------------------------------ finish

  tool(
    'validate',
    {
      title: 'Validate against the bundle format',
      description:
        'Checks the project against every rule of the bundle format. Errors (what the importer would reject; each names the frame id and the fix), repairs (what the importer fixes silently) and warnings (allowed but suspicious: overlaps, an edge cutting a line of text, a header inside a frame, ...). For a book also: a label and a section with every book exercise, (section, label) unique, every section the id of an outline entry, solution regions only on exercises, valid outline ids; warnings for a label written with the "." or ")" the book prints, an exercise printed in another section than the one it is filed under, a solution region lying on the exercise or on another exercise. ok=false means errors. A failed validation is a result, not a tool failure.',
      inputSchema: { project: projectArg, text: z.boolean().optional().describe('Also run the checks that read the printed lines (default true).') },
      readOnly: true,
    },
    async (args) => toResult(await cli(['validate', ...(args.text === false ? ['--no-text'] : [])], { project: projectOf(args) })),
  );

  tool(
    'export_bundle',
    {
      title: 'Export the .mcbundle',
      description:
        'Validates, then writes the bundle (the PDF byte for byte plus frames and outline, and for a book the sections, the book exercises, their hidden solution regions and the author, licence and notice from book_meta) atomically and reads it back with the importer\'s own checks; a bundle that fails them is removed. Errors in the project stop the export. A project with book exercises must be exported with its own outline (the default). Default path: name.mcbundle next to the project. Tell the user where it is: it goes to the tablet and is opened in the Math Canvas library.',
      inputSchema: {
        project: projectArg,
        out: z.string().optional().describe('Where to write the bundle (name.mcbundle).'),
        title: z.string().optional(),
        folder: z.string().optional(),
        outline: z.enum(['project', 'pdf', 'none']).optional().describe('Which contents to carry: the project\'s own outline (default), the PDF\'s bookmarks, or none.'),
      },
    },
    async (args) => toResult(await cli(['export', ...(args.out ? ['--out', args.out] : []), ...(args.title ? ['--title', args.title] : []), ...(args.folder !== undefined ? ['--folder', args.folder] : []), ...(args.outline ? ['--outline', args.outline] : [])], { project: projectOf(args) })),
  );

  tool(
    'inspect_bundle',
    {
      title: 'Look inside a bundle',
      description: 'Reads a .mcbundle: manifest (features, author, licence, notice), entries, frames with their labels (a book exercise by SECTION:LABEL), the sections with the number of exercises in each (summary), and every problem the importer would find.',
      inputSchema: { file: z.string().describe('Path of the .mcbundle.') },
      readOnly: true,
      project: false,
    },
    async (args) => toResult(await cli(['inspect-bundle', args.file], { project: '' })),
  );

  tool(
    'import_check',
    {
      title: 'Check a bundle as the Android importer would',
      description: 'Does exactly what the importer does, in its six steps (archive and limits, manifest, PDF hash, PDF page count, frames and outline with repairs, what would be created), and says whether it would accept the bundle. wouldImport=false is a result, not a tool failure.',
      inputSchema: { file: z.string().describe('Path of the .mcbundle.') },
      readOnly: true,
      project: false,
    },
    async (args) => toResult(await cli(['import-check', args.file], { project: '' })),
  );

  tool(
    'get_guide',
    {
      title: 'The agent guide',
      description: 'The guide for agents that mark a PDF: coordinate system with a worked example, workflow, rules for exercises, parts, context, questions, bookmarks, continuations, columns, scans, how to check by looking, what not to do, a checklist. Read it before you start.',
      inputSchema: {},
      readOnly: true,
      project: false,
    },
    async () => ({ content: [{ type: 'text', text: await readAgentGuide() }] }),
  );

  tool(
    'get_schema',
    {
      title: 'A JSON Schema of the files',
      description: 'The JSON Schema of bundle-manifest, frames, outline or project files, of the book summary (book_show, book_export), of the report of exercises_verify, of the sample of exercises_sample, of the gate certificate and the audit notes (gate, notes), of book_compare (compare) and of the contact sheets (sheets).',
      inputSchema: { name: z.enum(['bundle-manifest', 'frames', 'outline', 'project', 'book-summary', 'verify', 'sample', 'gate', 'notes', 'compare', 'sheets']) },
      readOnly: true,
      project: false,
    },
    async (args) => toResult(await cli(['schema', args.name], { project: '' })),
  );

  registerBookTools({ tool, cli, toResult, projectOf });
  registerAuditTools({ tool, cli, toResult, projectOf });
  registerVerifyTools({ tool, cli, toResult, projectOf });
  registerGateTools({ tool, cli, toResult, projectOf });

  server.registerResource(
    'agent-guide',
    'mcprep://guide',
    { title: 'Agent guide', description: 'How to mark a PDF with Math Canvas Prep.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readAgentGuide() }] }),
  );

  server.registerPrompt(
    'mark_pdf',
    {
      title: 'Mark a PDF for Math Canvas',
      description: 'Instructions to mark every exercise of a PDF and export a bundle.',
      argsSchema: { pdf: z.string().describe('Path of the PDF.'), folder: z.string().optional().describe('Library folder, for example University/Analysis.') },
    },
    ({ pdf, folder }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Mark the PDF "${pdf}" for Math Canvas${folder ? ` and file it under "${folder}"` : ''}. First read the resource mcprep://guide (or call get_guide). Then: create_project, project_info, render_page with a grid on a few pages, propose, apply_operations, render_crop for every frame and look at each image, fix what is wrong, validate, export_bundle, import_check. Finish by telling me where the bundle is, how many exercises, parts, questions and bookmarks it has, and what you were unsure about.`,
          },
        },
      ],
    }),
  );

  return server;
}
