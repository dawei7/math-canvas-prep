import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** The argument schemas the tools share, and the small helpers that turn them back into command-line text. */

export const rect = z
  .union([
    z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[left, top, right, bottom]'),
    z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }),
  ])
  .describe('A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.');

export const page = z.number().int().min(0).describe('Zero-based page: the first page is 0.');
export const projectArg = z.string().optional().describe('Path of the project file (name.mcprep.json). Default: the project created or opened earlier in this session (or $MCPREP_PROJECT).');
export const region = z.object({ page, rect }).describe('A region on a page.');
export const snap = z.boolean().optional().describe('Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.');
export const dryRun = z.boolean().optional().describe('Compute and validate but do not write the project.');
export const force = z.boolean().optional().describe('Write even if the change introduces validation errors (almost never what you want).');
export const frameId = z.string().min(1).describe('The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).');
export const kind = z.enum(['exercise', 'question', 'bookmark']).describe('exercise: to solve and be checked; question: to ask the AI tutor about; bookmark: a place worth coming back to (definition, theorem, worked example).');

export const rectArg = (value: z.infer<typeof rect>): string => (Array.isArray(value) ? value.join(',') : `${value.left},${value.top},${value.right},${value.bottom}`);
export const regionArg = (value: z.infer<typeof region>): string => `${value.page}:${rectArg(value.rect)}`;
export const flags = (args: { snap?: boolean | undefined; dryRun?: boolean | undefined; force?: boolean | undefined }): string[] => [
  ...(args.snap === true ? ['--snap'] : []),
  ...(args.dryRun === true ? ['--dry-run'] : []),
  ...(args.force === true ? ['--force'] : []),
];

type Json = Record<string, unknown>;

/** Lists in a result that are cut when they are longer than {@link LIST_LIMIT}: a book has thousands of exercises, a model's context does not. */
const LONG_LISTS = ['frames', 'steps', 'exercises', 'solutions', 'warnings'] as const;
export const LIST_LIMIT = 500;

/**
 * The result with its long lists cut to the first {@link LIST_LIMIT} entries; `<name>Omitted` says how many were left out
 * (so the client knows and can ask for less: a section, a page). Errors are never cut. The `created`, `replaced` and
 * `removed` id lists and the counts stay whole.
 */
export function capLists(body: Json): Json {
  let out = body;
  const cut = (holder: Json, key: string): Json => {
    const value = holder[key];
    if (!Array.isArray(value) || value.length <= LIST_LIMIT) return holder;
    return { ...holder, [key]: value.slice(0, LIST_LIMIT), [`${key}Omitted`]: value.length - LIST_LIMIT };
  };
  for (const key of LONG_LISTS) out = cut(out, key);
  const validation = out['validation'];
  if (typeof validation === 'object' && validation !== null && !Array.isArray(validation)) {
    const cutValidation = cut(validation as Json, 'warnings');
    if (cutValidation !== validation) out = { ...out, validation: cutValidation };
  }
  return out;
}

/** What running a command line in process gave back: the exit code and the JSON document it printed. */
export interface CliResult {
  code: number;
  envelope: { ok: boolean; result?: Json; warnings?: unknown[]; notes?: string[]; error?: { code: string; message: string; hint?: string; issues?: unknown[]; details?: unknown } };
}

export interface ToolConfig<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: Shape;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** False for tools that need no project (default true). */
  project?: boolean;
}

/** What the tool modules are given to register their tools with. */
export interface ToolApi {
  tool<Shape extends z.ZodRawShape>(name: string, config: ToolConfig<Shape>, handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>): void;
  cli(argv: string[], extra?: { stdin?: string; project?: string | undefined }): Promise<CliResult>;
  toResult(done: CliResult, extraContent?: CallToolResult['content']): CallToolResult;
  projectOf(args: { project?: string | undefined }): string | undefined;
}
