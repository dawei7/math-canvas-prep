import { normalizeLabel } from '../model/authority.js';
import { draft, type Draft, type Exercise, type Prepared, type Where } from './common.js';
import { compactNumbers, parseNumeric } from './labels.js';
import { VERIFY_LIMITS, type VerifySection } from './types.js';

/**
 * What the stored exercises of each section say about the numbering of the book: where the section's pages are
 * (`section-unknown`, `section-page`), whether the numbers run without a gap, a repeat or a stray number (`gap`,
 * `duplicate`, `label-outlier`, `non-numeric-label`), whether they follow the order of the page (`order`) and how many
 * exercises have an answer (`no-solution`). Everything comes from the project file, so it also checks edits made by hand.
 */

/** Gaps are listed one by one up to this many numbers per section; a longer list is summarised. */
const MAX_LISTED_GAPS = 10_000;

interface Item {
  exercise: Exercise;
  /** The label as written (closing punctuation dropped). */
  label: string;
  /** The integer the label starts with and what follows it, when it starts with one. */
  n: number | undefined;
  suffix: string;
}

const compareKeys = (a: { n: number; suffix: string }, b: { n: number; suffix: string }): number => a.n - b.n || (a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The items of each section, in the order of the sections and, within one, of the pages. */
function groupBySection(exercises: readonly Exercise[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const exercise of exercises) {
    if (!exercise.book) continue;
    const label = normalizeLabel(exercise.frame.label as string).label;
    const numeric = parseNumeric(label);
    const item: Item = { exercise, label, n: numeric?.n, suffix: numeric?.suffix ?? '' };
    const list = groups.get(exercise.section as string);
    if (list) list.push(item);
    else groups.set(exercise.section as string, [item]);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading order

/** Regions whose left edges are no further apart than this are in one column of the section. */
const COLUMN_GAP = 0.08;

/**
 * The columns of a section: the exercises whose regions start at about the same left edge, over all the pages of the section,
 * each column in the order of the pages and, on a page, from top to bottom. A page of two columns is numbered across its rows
 * (the numbers alternate between the columns) or down one column and then the next; either way every column runs in numeric
 * order, however the rows of the columns are staggered. A section set in one column has one.
 */
function columnsOf(items: readonly Item[]): Item[][] {
  const byLeft = [...items].sort((a, b) => a.exercise.frame.rect.left - b.exercise.frame.rect.left || a.exercise.order - b.exercise.order);
  const columns: Item[][] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const item of byLeft) {
    const left = item.exercise.frame.rect.left;
    const column = columns[columns.length - 1];
    if (column && left - last <= COLUMN_GAP) column.push(item);
    else columns.push([item]);
    last = left;
  }
  const inPlace = (a: Item, b: Item): number =>
    a.exercise.frame.page - b.exercise.frame.page || a.exercise.frame.rect.top - b.exercise.frame.rect.top || a.exercise.frame.rect.left - b.exercise.frame.rect.left || a.exercise.order - b.exercise.order;
  return columns.map((column) => column.sort(inPlace));
}

const keyOf = (item: Item): { n: number; suffix: string } => ({ n: item.n as number, suffix: item.suffix });

/** The items to take out so that the rest is in order: the longest run that is in order is kept (the earliest of equally long ones). */
function outOfOrder(sequence: readonly Item[]): Set<Item> {
  const length = new Array<number>(sequence.length).fill(1);
  const before = new Array<number>(sequence.length).fill(-1);
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (compareKeys(keyOf(sequence[j] as Item), keyOf(sequence[i] as Item)) <= 0 && (length[j] as number) + 1 > (length[i] as number)) {
        length[i] = (length[j] as number) + 1;
        before[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < sequence.length; i += 1) if ((length[i] as number) > (length[end] as number)) end = i;
  const kept = new Set<number>();
  for (let at = sequence.length === 0 ? -1 : end; at >= 0; at = before[at] as number) kept.add(at);
  return new Set(sequence.filter((_item, index) => !kept.has(index)));
}

// ---------------------------------------------------------------------------------------------------------------------
// The checks

const sectionWhere = (items: readonly Item[]): Where => ({ ...(items[0] as Item).exercise.where, top: -1, left: -1 });

function listed(labels: readonly string[], most = 12): string {
  return labels.length <= most ? labels.join(', ') : `${labels.slice(0, most).join(', ')}, ... (${labels.length})`;
}

export function checkSections(prepared: Prepared): { drafts: Draft[]; sections: VerifySection[] } {
  const drafts: Draft[] = [];
  const sections: VerifySection[] = [];
  const { tree } = prepared;
  for (const [id, items] of groupBySection(prepared.exercises)) {
    const index = tree.byId.get(id);
    const node = index === undefined ? undefined : tree.nodes[index];
    const where = sectionWhere(items);
    const firstPage = (items[0] as Item).exercise.frame.page;

    // --- where the section is -------------------------------------------------------------------------------------
    if (node === undefined) {
      for (const item of items) {
        drafts.push(
          draft(
            'section-unknown',
            'error',
            item.exercise.ref,
            item.exercise.frame.page,
            `${item.exercise.ref} is filed under the section "${id}", which is not the id of any entry of the outline.`,
            tree.nodes.length === 0 ? 'the project has no outline' : `the outline has the ids ${listed([...tree.byId.keys()], 8)}`,
            item.exercise.where,
          ),
        );
      }
    } else {
      for (const item of items) {
        const page = item.exercise.frame.page;
        if (page < node.start.page) {
          drafts.push(
            draft('section-page', 'error', item.exercise.ref, page, `${item.exercise.ref} is on page ${page}, before page ${node.start.page} where its section starts.`, `page ${page}; the section starts on page ${node.start.page}`, item.exercise.where),
          );
        } else if (page > node.end.page) {
          drafts.push(
            draft('section-page', 'error', item.exercise.ref, page, `${item.exercise.ref} is on page ${page}, after page ${node.end.page} where the next section starts.`, `page ${page}; the next section starts on page ${node.end.page}`, item.exercise.where),
          );
        }
      }
    }

    // --- the labels -------------------------------------------------------------------------------------------------
    const plain = items.filter((item) => !/^\d+$/.test(item.label));
    if (plain.length > 0) {
      drafts.push(
        draft(
          'non-numeric-label',
          'info',
          id,
          (plain[0] as Item).exercise.frame.page,
          `${plain.length === 1 ? 'One label' : `${plain.length} labels`} of section ${id} ${plain.length === 1 ? 'is' : 'are'} not a plain number; the numbers are checked for the labels that start with one.`,
          listed(plain.map((item) => item.label)),
          where,
        ),
      );
    }

    const numeric = items.filter((item) => item.n !== undefined);
    const centre = numeric.length > 0 ? median(numeric.map((item) => item.n as number)) : 0;
    const strays = numeric.filter((item) => (item.n as number) > VERIFY_LIMITS.outlierFactor * centre);
    for (const item of strays) {
      drafts.push(
        draft(
          'label-outlier',
          'warning',
          item.exercise.ref,
          item.exercise.frame.page,
          `The number ${item.label} of ${item.exercise.ref} is more than ${VERIFY_LIMITS.outlierFactor} times the median ${centre} of the numbers of section ${id}: perhaps a number from the text, not the exercise's own.`,
          `number ${item.n}, median ${centre}`,
          item.exercise.where,
        ),
      );
    }
    const regular = numeric.filter((item) => !strays.includes(item));

    const byLabel = new Map<string, Item[]>();
    for (const item of items) {
      const list = byLabel.get(item.exercise.label as string);
      if (list) list.push(item);
      else byLabel.set(item.exercise.label as string, [item]);
    }
    const duplicates: string[] = [];
    for (const list of byLabel.values()) {
      if (list.length < 2) continue;
      const first = list[0] as Item;
      duplicates.push(first.label);
      drafts.push(
        draft(
          'duplicate',
          'error',
          first.exercise.ref,
          first.exercise.frame.page,
          `${first.exercise.ref} is the name of ${list.length} exercises of section ${id}.`,
          list.map((item) => `${item.exercise.frame.id} on page ${item.exercise.frame.page}`).join(', '),
          first.exercise.where,
        ),
      );
    }

    // --- gaps ---------------------------------------------------------------------------------------------------------
    const values = [...new Set(regular.map((item) => item.n as number))].sort((a, b) => a - b);
    const gaps: string[] = [];
    if (values.length >= 2) {
      const low = values[0] as number;
      const high = values[values.length - 1] as number;
      if (high - low > MAX_LISTED_GAPS) {
        drafts.push(
          draft('gap', 'warning', id, firstPage, `The numbers of section ${id} run from ${low} to ${high}: too far apart to list what is missing.`, `numbers ${low} to ${high}`, where),
        );
      } else {
        for (let k = 1; k < values.length; k += 1) {
          const before = values[k - 1] as number;
          const after = values[k] as number;
          if (after - before <= 1) continue;
          const run: number[] = [];
          for (let n = before + 1; n < after; n += 1) run.push(n);
          gaps.push(...run.map(String));
          const holder = regular.find((item) => item.n === before) as Item;
          drafts.push(
            draft(
              'gap',
              'warning',
              id,
              holder.exercise.frame.page,
              `Section ${id} has no exercise ${compactNumbers(run)} between ${before} and ${after}.`,
              `${compactNumbers(run)} missing; the numbers run from ${low} to ${high}`,
              { ...where, page: holder.exercise.frame.page, top: holder.exercise.frame.rect.top, left: holder.exercise.frame.rect.left },
            ),
          );
        }
      }
    }

    // --- order -------------------------------------------------------------------------------------------------------
    if (duplicates.length === 0 && regular.length >= 2) {
      for (const column of columnsOf(regular)) {
        const stray = outOfOrder(column);
        column.forEach((item, at) => {
          if (!stray.has(item)) return;
          const previous = column[at - 1];
          const next = column[at + 1];
          drafts.push(
            draft(
              'order',
              'warning',
              item.exercise.ref,
              item.exercise.frame.page,
              `${item.exercise.ref} is out of order: in its column it stands between ${previous ? previous.label : 'the start'} and ${next ? next.label : 'the end'}, which the numbers do not allow.`,
              `reads after ${previous ? previous.label : '(nothing)'} and before ${next ? next.label : '(nothing)'}`,
              item.exercise.where,
            ),
          );
        });
      }
    }

    // --- answers -----------------------------------------------------------------------------------------------------
    const solved = items.filter((item) => (item.exercise.frame.solution?.length ?? 0) > 0);
    if (items.length > 0 && solved.length < items.length) {
      const missing = items.filter((item) => !solved.includes(item));
      if (solved.length === 0) {
        drafts.push(
          draft('no-solution', 'info', id, firstPage, `No exercise of section ${id} has an answer (${items.length} exercise${items.length === 1 ? '' : 's'}): the book may print none for this section.`, `no solution region on any of ${items.length}`, where),
        );
      } else if (solved.length < VERIFY_LIMITS.coverageShare * items.length) {
        drafts.push(
          draft(
            'no-solution',
            'warning',
            id,
            (missing[0] as Item).exercise.frame.page,
            `Only ${solved.length} of the ${items.length} exercises of section ${id} have an answer.`,
            `without a solution: ${listed(missing.map((item) => item.exercise.ref), 200)}`,
            where,
          ),
        );
      }
    }

    // The first and the last number of the section as the book counts: in numeric order (a stray number shows here), else in reading order.
    const counted = numeric.length > 0 ? [...numeric].sort((a, b) => compareKeys(keyOf(a), keyOf(b)) || a.exercise.order - b.exercise.order) : items;
    sections.push({
      id,
      label: node?.entry.label ?? null,
      exercises: items.length,
      firstLabel: (counted[0] as Item).label,
      lastLabel: (counted[counted.length - 1] as Item).label,
      withSolution: solved.length,
      gaps,
      duplicates,
    });
  }
  return { drafts, sections };
}
