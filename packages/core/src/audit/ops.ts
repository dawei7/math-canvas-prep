import type { Rect, Region } from '../model/types.js';
import type { ExerciseProposal } from './exercises.js';

/**
 * The operations that turn book proposals into authoritative frames. They are plain data in the shape of the batch
 * operations of the project (`frames apply`): an `add` of an exercise with `authority: "book"`, its printed `label`
 * and its `section`, the instruction as `context`, and, when the answer key was read too, the `solution` regions.
 * The frame id is made from the section and the label, so applying the same operations twice cannot duplicate an
 * exercise: the second batch is refused because the id is taken.
 */

type Box = [number, number, number, number];

export interface BookRegionOperation {
  page: number;
  rect: Box;
}

export interface BookAddOperation {
  op: 'add';
  id: string;
  ref: string;
  kind: 'exercise';
  authority: 'book';
  label: string;
  section: string;
  page: number;
  rect: Box;
  context?: BookRegionOperation[];
  continues?: BookRegionOperation[];
  solution?: BookRegionOperation[];
}

export interface BookSolutionOperation {
  op: 'solution.add';
  id: string;
  page: number;
  rect: Box;
}

const box = (rect: Rect): Box => [rect.left, rect.top, rect.right, rect.bottom];
const region = (entry: Region): BookRegionOperation => ({ page: entry.page, rect: box(entry.rect) });

/** The `add` operation of one exercise; `solution` regions go into the same operation when they are given. */
export function exerciseToOperation(proposal: ExerciseProposal, solution: readonly Region[] = []): BookAddOperation {
  return {
    op: 'add',
    id: proposal.id,
    ref: proposal.id,
    kind: 'exercise',
    authority: 'book',
    label: proposal.label,
    section: proposal.section,
    page: proposal.page,
    rect: box(proposal.rect),
    ...(proposal.context.length > 0 ? { context: proposal.context.map(region) } : {}),
    ...(proposal.continues && proposal.continues.length > 0 ? { continues: proposal.continues.map(region) } : {}),
    ...(solution.length > 0 ? { solution: solution.map(region) } : {}),
  };
}

/** The operations for many exercises, in the order given. */
export function exercisesToOperations(proposals: readonly ExerciseProposal[], solutions: ReadonlyMap<string, readonly Region[]> = new Map()): BookAddOperation[] {
  return proposals.map((proposal) => exerciseToOperation(proposal, solutions.get(proposal.id) ?? []));
}
