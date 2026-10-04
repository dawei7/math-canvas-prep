import { McPrepError, countBook, countFrames, findFrame, type Operation, type RegionInput } from '@mcprep/core';
import { flag, pageNumber, usage } from '../args.js';
import { issueLines, plural, summarizeFrames, tableLimited, FRAME_HEADERS, frameRows } from '../format.js';
import type { CommandContext, CommandOutput, OptionSpec } from '../types.js';

/** Options every command understands. */
export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: 'project', short: 'p', type: 'string', value: '<file>', description: 'The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.' },
  { name: 'json', type: 'boolean', description: 'Print one JSON document (stable, documented in docs/CLI.md) instead of text.' },
  { name: 'ignore-pdf-change', type: 'boolean', description: 'Open the project even if the PDF is not the one it was made for (frames may then be misplaced).' },
  { name: 'help', short: 'h', type: 'boolean', description: 'Show help for the command.' },
];

export const DRY_RUN: OptionSpec = { name: 'dry-run', type: 'boolean', description: 'Compute and validate the change, but do not write the project.' };
export const FORCE: OptionSpec = { name: 'force', type: 'boolean', description: 'Write the change even if it introduces validation errors.' };
export const SNAP: OptionSpec = { name: 'snap', type: 'boolean', description: 'Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.' };
/** The options that every command that changes the project takes. */
export const REPORT_OPTIONS: OptionSpec[] = [DRY_RUN, FORCE, ...GLOBAL_OPTIONS];

/** `--dry-run` and `--force` as the report wants them. */
export function reportFlags(options: CommandContext['options']): { dryRun?: boolean; force?: boolean } {
  return { ...(flag(options, 'dry-run') ? { dryRun: true } : {}), ...(flag(options, 'force') ? { force: true } : {}) };
}

/** `page:left,top,right,bottom` or a JSON object `{"page":1,"rect":[...]}` as a region. */
export function parseRegion(text: string, what: string): RegionInput {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { page?: unknown; rect?: unknown };
      if (typeof parsed.page === 'number' && parsed.rect !== undefined) return { page: parsed.page, rect: parsed.rect as RegionInput['rect'] };
    } catch {
      // fall through to the message
    }
    throw usage(`${what} must be page:left,top,right,bottom or {"page":1,"rect":{...}}; got ${text}.`);
  }
  const colon = trimmed.indexOf(':');
  if (colon < 1) throw usage(`${what} must be page:left,top,right,bottom (for example 1:0.1,0.2,0.9,0.3); got "${text}".`);
  return { page: pageNumber(trimmed.slice(0, colon), `${what} page`), rect: trimmed.slice(colon + 1) };
}

export interface ReportOptions {
  dryRun?: boolean;
  force?: boolean;
  /** Frame ids to show in the result besides the ones created (the ones the operations were about). */
  show?: readonly string[];
}

/**
 * Applies operations as one atomic batch and reports: what was created and removed, the frames concerned, the notes
 * (what snapping did, what was enlarged), and the validation of the whole project. A batch that would introduce errors
 * is refused (exit code 4) and nothing is written, unless --force.
 */
export async function applyAndReport(context: CommandContext, operations: Operation[], verb: string, options: ReportOptions = {}): Promise<CommandOutput> {
  const session = await context.session();
  const outcome = await session.apply(operations, { modifiedBy: 'cli', ...(options.dryRun === true ? { dryRun: true } : {}), ...(options.force === true ? { force: true } : {}) });
  if (outcome.rejected) {
    throw new McPrepError('E_REJECTED', `Nothing was changed: ${verb} would introduce ${plural(outcome.introduced.length, 'validation error')}.`, {
      hint: 'Fix the cause named below, or write the change anyway with --force.',
      issues: outcome.introduced,
    });
  }
  const project = outcome.project;
  const present = new Set(project.frames.map((frame) => frame.id));
  const replaced = outcome.batch.replaced ?? [];
  // A frame to show may be named by its id or, for a book exercise, by SECTION:LABEL.
  const shown = (options.show ?? []).map((reference) => findFrame(project, reference)?.id ?? reference);
  const show = [...new Set([...outcome.batch.created, ...replaced, ...shown])].filter((id) => present.has(id));
  const frames = summarizeFrames(project, show);
  const validation = outcome.validation;
  const counts = countFrames(project.frames);
  const book = countBook(project.frames);
  const result = {
    applied: outcome.applied,
    dryRun: options.dryRun === true,
    created: outcome.batch.created,
    replaced,
    removed: outcome.batch.removed,
    steps: outcome.batch.steps,
    frames,
    counts,
    book,
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings, repairs: validation.repairs },
  };
  const lines: string[] = [];
  const head = options.dryRun === true ? `Dry run, nothing written: ${verb}.` : `${verb[0]?.toUpperCase() ?? ''}${verb.slice(1)}.`;
  lines.push(head);
  if (frames.length > 0) lines.push(tableLimited(frameRows(frames), FRAME_HEADERS));
  if (replaced.length > 0) lines.push(`Replaced in place: ${replaced.length > 12 ? `${replaced.slice(0, 12).join(', ')}, ... (${replaced.length})` : replaced.join(', ')}.`);
  if (outcome.batch.removed.length > 0) lines.push(`Removed: ${outcome.batch.removed.join(', ')}.`);
  for (const note of outcome.batch.notes.slice(0, 40)) lines.push(`note: ${note}`);
  if (outcome.batch.notes.length > 40) lines.push(`... and ${outcome.batch.notes.length - 40} more notes (use --json to see all)`);
  const bookText = book.exercises > 0 ? `, ${plural(book.exercises, 'book exercise')} (${book.withSolution} with a solution)` : '';
  lines.push(`Project now: ${plural(counts.exercise, 'exercise')}, ${plural(counts.question, 'question')}, ${plural(counts.bookmark, 'bookmark')}${bookText}. Validation: ${plural(validation.errors.length, 'error')}, ${plural(validation.warnings.length, 'warning')}.`);
  lines.push(...issueLines([...validation.errors, ...validation.warnings], '  ', 40));
  return { result, warnings: validation.warnings, notes: outcome.batch.notes, text: lines.join('\n') };
}
