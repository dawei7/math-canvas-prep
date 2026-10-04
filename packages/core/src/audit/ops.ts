import { bookKey } from '../model/authority.js';
import { enlargeToMinimum, isBelowMinimum, rectsEqual } from '../model/rect.js';
import type { Frame, Rect, Region } from '../model/types.js';
import type { Operation } from '../project/ops.js';
import type { ExerciseProposal } from './exercises.js';

/**
 * The operations that turn audit proposals into authoritative frames, in the shape the project operations take (the
 * batch of `frames apply`): an `add` with `authority: "book"`, the printed `label`, the `section`, the instruction as
 * `context`, the part on the next page as `continues` and, when the answer key was read too, the `solution` regions; and
 * `solution.set` for the answers of an exercise that is already there. A book exercise is identified by its section and
 * its label, so adding one that the project already holds is an error unless the operation says `replace`; this module
 * also tells whether a frame of the project already is what a proposal says, so that a command can leave it alone.
 */

type Box = [number, number, number, number];

/** An `add` of an authoritative exercise; the frame gets a generated id and is named by `SECTION:LABEL` afterwards. */
export type BookAddOperation = Extract<Operation, { op: 'add' }> & { authority: 'book'; label: string; section: string; rect: Box };

export type BookSolutionOperation = Extract<Operation, { op: 'solution.set' }>;

const box = (rect: Rect): Box => [rect.left, rect.top, rect.right, rect.bottom];
const region = (entry: Region): { page: number; rect: Box } => ({ page: entry.page, rect: box(entry.rect) });

export interface ExerciseOperationOptions {
  /** The regions of the answer key that hold the answer. */
  solution?: readonly Region[];
  /** Overwrite the exercise that is already in the project under this section and label (it keeps its id). */
  replace?: boolean;
}

/**
 * The `add` of one exercise. With `replace`, the instruction is written even when there is none (an empty list clears
 * what the exercise had); the solution only when one was found, so that an answer put there by hand stays.
 */
export function exerciseToOperation(proposal: ExerciseProposal, options: ExerciseOperationOptions = {}): BookAddOperation {
  const solution = options.solution ?? [];
  return {
    op: 'add',
    authority: 'book',
    label: proposal.label,
    section: proposal.section,
    page: proposal.page,
    rect: box(proposal.rect),
    ...(proposal.context.length > 0 || options.replace === true ? { context: proposal.context.map(region) } : {}),
    ...(proposal.continues && proposal.continues.length > 0 ? { continues: proposal.continues.map(region) } : {}),
    ...(solution.length > 0 ? { solution: solution.map(region) } : {}),
    ...(options.replace === true ? { replace: true } : {}),
  };
}

/**
 * The operations for many exercises, in the order given. `solutions` maps the `bookKey(section, label)` of an exercise to
 * its answer regions; `replace` holds the keys of the proposals that overwrite an exercise of the project.
 */
export function exercisesToOperations(
  proposals: readonly ExerciseProposal[],
  solutions: ReadonlyMap<string, readonly Region[]> = new Map(),
  replace: ReadonlySet<string> = new Set(),
): BookAddOperation[] {
  return proposals.map((proposal) => {
    const key = bookKey(proposal.section, proposal.label);
    return exerciseToOperation(proposal, { solution: solutions.get(key) ?? [], replace: replace.has(key) });
  });
}

/** `solution.set` for the exercise named by `reference` (`SECTION:LABEL` or a frame id): the answer is exactly these regions. */
export function solutionToOperation(reference: string, regions: readonly Region[]): BookSolutionOperation {
  return { op: 'solution.set', id: reference, regions: regions.map(region) };
}

const TOLERANCE = 2e-4;

/** What the project makes of a rectangle: one below the minimum size is enlarged when it is stored. */
const stored = (rect: Rect): Rect => (isBelowMinimum(rect) ? enlargeToMinimum(rect) : rect);
const storedRegions = (regions: readonly Region[]): Region[] => regions.map((entry) => ({ page: entry.page, rect: stored(entry.rect) }));

/** Whether two lists of regions are the same places on the same pages (a stored rectangle is rounded, so not exactly). */
export function sameRegions(a: readonly Region[], b: readonly Region[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.page === (b[index] as Region).page && rectsEqual(entry.rect, (b[index] as Region).rect, TOLERANCE));
}

/**
 * How an exercise that the project already holds compares with the proposal for the same section and label:
 * `unchanged` (the same page, rectangle, continuation and instruction, and the same solution when one was proposed),
 * `needs-solution` (the same, but the proposal found an answer and the frame has none) or `changed` (a different place,
 * continuation or instruction, or a different solution: a person may have corrected the frame, so it is left alone
 * unless the command is told to replace it).
 */
export type ProposalState = 'unchanged' | 'needs-solution' | 'changed';

export function compareWithProposal(frame: Frame, proposal: ExerciseProposal, solution?: readonly Region[]): ProposalState {
  if (frame.page !== proposal.page || !rectsEqual(frame.rect, stored(proposal.rect), TOLERANCE)) return 'changed';
  if (!sameRegions(frame.continues ?? [], storedRegions(proposal.continues ?? []))) return 'changed';
  if (!sameRegions(frame.context ?? [], storedRegions(proposal.context))) return 'changed';
  return compareSolution(frame, solution ?? []);
}

/** The same for the answer alone: `unchanged` also when no answer was found. */
export function compareSolution(frame: Frame, solution: readonly Region[]): ProposalState {
  if (solution.length === 0) return 'unchanged';
  const have = frame.solution ?? [];
  if (have.length === 0) return 'needs-solution';
  return sameRegions(have, storedRegions(solution)) ? 'unchanged' : 'changed';
}
