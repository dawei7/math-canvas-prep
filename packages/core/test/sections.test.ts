import { describe, expect, it } from 'vitest';
import {
  assignSectionIds,
  buildSectionTree,
  cleanSectionId,
  comparePosition,
  countSections,
  deriveSectionId,
  describeSection,
  exercisesBySection,
  findSection,
  isWithin,
  locateSection,
  sectionOfFrame,
  sectionPath,
} from '../src/book/sections.js';
import { countBook, countFrames, countFramesRaw, numberFrames } from '../src/model/numbering.js';
import { overlayBoxes } from '../src/model/overlay.js';
import type { Frame, OutlineEntry } from '../src/model/types.js';
import { bookFrame, bookOutline, ordinary } from './book-helpers.js';
import { frame, rect } from './helpers.js';

const idOf = (node: { id: string | undefined } | undefined): string | undefined => node?.id;

describe('the section tree', () => {
  const tree = buildSectionTree(bookOutline(), 6);

  it('knows parents, children and where each subtree ends', () => {
    expect(tree.roots).toEqual([0, 3]);
    expect(tree.nodes.map((node) => node.parent)).toEqual([-1, 0, 0, -1, 3]);
    expect(tree.nodes[0]?.children).toEqual([1, 2]);
    expect(tree.nodes.map((node) => node.subtreeEnd)).toEqual([3, 2, 3, 5, 5]);
    expect(isWithin(tree, tree.nodes[2]!, tree.nodes[0]!)).toBe(true);
    expect(isWithin(tree, tree.nodes[2]!, tree.nodes[1]!)).toBe(false);
    expect(isWithin(tree, tree.nodes[4]!, tree.nodes[0]!)).toBe(false);
    expect(isWithin(tree, tree.nodes[0]!, tree.nodes[0]!)).toBe(true);
  });

  it('lets a section run from its heading to the next of the same or a lower depth', () => {
    expect(tree.nodes[0]?.start).toEqual({ page: 0, top: 0 });
    expect(tree.nodes[0]?.end).toEqual({ page: 3, top: 0 });
    expect(tree.nodes[1]?.start).toEqual({ page: 0, top: 0.3 });
    expect(tree.nodes[1]?.end).toEqual({ page: 1, top: 0.1 });
    expect(tree.nodes[2]?.end).toEqual({ page: 3, top: 0 });
    expect(tree.nodes[4]?.end).toEqual({ page: 6, top: 0 });
  });

  it('finds an entry by its id and reports an id used twice', () => {
    expect(findSection(tree, '1.2')?.index).toBe(2);
    expect(findSection(tree, 'nope')).toBeUndefined();
    const twice = buildSectionTree([{ title: 'A', page: 0, depth: 0, id: 'x' }, { title: 'B', page: 1, depth: 0, id: 'x' }], 2);
    expect(twice.duplicateIds).toEqual(['x']);
    expect(twice.byId.get('x')).toBe(0);
  });

  it('gives the path from the top-level entry down', () => {
    expect(sectionPath(tree, tree.nodes[2]!).map(idOf)).toEqual(['c1', '1.2']);
    expect(sectionPath(tree, tree.nodes[3]!).map(idOf)).toEqual(['c2']);
  });

  it('handles an empty outline and jumps in depth', () => {
    expect(buildSectionTree([], 3)).toMatchObject({ nodes: [], roots: [] });
    const jumpy = buildSectionTree([{ title: 'A', page: 0, depth: 1 }, { title: 'B', page: 1, depth: 3 }, { title: 'C', page: 2, depth: 0 }], 4);
    expect(jumpy.nodes.map((node) => node.parent)).toEqual([-1, 0, -1]);
    expect(jumpy.roots).toEqual([0, 2]);
  });

  it('describes an entry by its label and title without saying the number twice', () => {
    expect(describeSection({ title: '1.1 Sets', page: 0, depth: 1, label: '1.1' })).toBe('1.1 Sets');
    expect(describeSection({ title: 'Sets', page: 0, depth: 1, label: '1.1' })).toBe('1.1 Sets');
    expect(describeSection({ title: 'Sets', page: 0, depth: 1 })).toBe('Sets');
  });
});

describe('which section a position falls into', () => {
  const tree = buildSectionTree(bookOutline(), 6);
  const at = (page: number, top: number, withId = false): string | undefined => idOf(locateSection(tree, page, top, { withId }));

  it('is the deepest section that contains it', () => {
    expect(at(0, 0.1)).toBe('c1');
    expect(at(0, 0.3)).toBe('1.1');
    expect(at(0, 0.9)).toBe('1.1');
    expect(at(1, 0.05)).toBe('1.1');
    expect(at(1, 0.1)).toBe('1.2');
    expect(at(2, 0.5)).toBe('1.2');
    expect(at(3, 0.1)).toBe('c2');
    expect(at(3, 0.2)).toBe('2.1');
    expect(at(5, 0.9)).toBe('2.1');
  });

  it('is nothing before the first entry', () => {
    const late = buildSectionTree([{ title: 'One', page: 2, depth: 0, id: 'a' }], 5);
    expect(locateSection(late, 0, 0.5)).toBeUndefined();
    expect(locateSection(late, 1, 0.99)).toBeUndefined();
    expect(idOf(locateSection(late, 2, 0))).toBe('a');
    expect(locateSection(buildSectionTree([], 3), 0, 0)).toBeUndefined();
  });

  it('can be asked for the nearest section that has an id', () => {
    const entries: OutlineEntry[] = [
      { title: 'Chapter', page: 0, depth: 0, id: 'c' },
      { title: 'Anonymous', page: 1, depth: 1 },
      { title: 'Named', page: 3, depth: 1, id: 'n' },
    ];
    const mixed = buildSectionTree(entries, 5);
    expect(locateSection(mixed, 1, 0.5)?.entry.title).toBe('Anonymous');
    expect(idOf(locateSection(mixed, 1, 0.5, { withId: true }))).toBe('c');
    expect(idOf(locateSection(mixed, 4, 0.5, { withId: true }))).toBe('n');
  });

  it('uses the top edge of a frame', () => {
    expect(idOf(sectionOfFrame(tree, bookFrame('a', '1.1', '1', 0, 0.35, 0.5)))).toBe('1.1');
    expect(idOf(sectionOfFrame(tree, bookFrame('a', '1.1', '1', 0, 0.1, 0.5)))).toBe('c1');
  });

  it('survives an outline that is not in reading order', () => {
    const shuffled: OutlineEntry[] = [
      { title: 'B', page: 4, depth: 0, id: 'b' },
      { title: 'A', page: 0, depth: 0, id: 'a' },
      { title: 'A1', page: 1, depth: 1, id: 'a1' },
    ];
    const odd = buildSectionTree(shuffled, 6);
    // B's extent runs to the next top-level entry (A, page 0): it is empty. A runs to the end of the document.
    expect(idOf(locateSection(odd, 1, 0.5))).toBe('a1');
    expect(idOf(locateSection(odd, 5, 0.5))).toBe('a1');
    expect(locateSection(odd, 0, 0.5)?.id).toBe('a');
  });

  it('compares positions by page, then top', () => {
    expect(comparePosition({ page: 1, top: 0.9 }, { page: 2, top: 0 })).toBe(-1);
    expect(comparePosition({ page: 2, top: 0.2 }, { page: 2, top: 0.1 })).toBe(1);
    expect(comparePosition({ page: 2, top: 0.2 }, { page: 2, top: 0.2 })).toBe(0);
  });
});

describe('counting exercises per section', () => {
  const tree = buildSectionTree(bookOutline(), 6);
  const solved = { solution: [{ page: 5, rect: rect(0.1, 0.4, 0.9, 0.45) }] };
  const frames: Frame[] = [
    bookFrame('f1', '1.1', '1', 0, 0.35, 0.4, solved),
    bookFrame('f2', '1.1', '2', 0, 0.4, 0.45),
    bookFrame('f3', '1.2', '1', 1, 0.2, 0.3, solved),
    bookFrame('f4', 'c1', 'R1', 2, 0.2, 0.3),
    bookFrame('f5', '2.1', '1', 4, 0.2, 0.3, solved),
    bookFrame('f6', 'ghost', '1', 4, 0.4, 0.5),
    ordinary('f7', 0, 0.5, 0.6),
    frame('f8', 'question', 0, rect(0.1, 0.7, 0.9, 0.8)),
  ];

  it('counts what each section holds, each subtree and the total', () => {
    const counts = countSections(tree, frames);
    expect(counts.perNode.map((entry) => entry.exercises)).toEqual([1, 2, 1, 0, 1]);
    expect(counts.perNode.map((entry) => entry.exercisesTotal)).toEqual([4, 2, 1, 1, 1]);
    expect(counts.perNode.map((entry) => entry.withSolution)).toEqual([0, 1, 1, 0, 1]);
    expect(counts.perNode.map((entry) => entry.withSolutionTotal)).toEqual([2, 1, 1, 1, 1]);
    expect(counts.totals).toEqual({ exercises: 6, withSolution: 3 });
    expect(counts.unplaced.map((entry) => entry.id)).toEqual(['f6']);
    expect(countBook(frames)).toEqual({ exercises: 6, withSolution: 3 });
  });

  it('lists the exercises of a section in reading order, ordinary frames left out', () => {
    const groups = exercisesBySection([...frames].reverse());
    expect(groups.get('1.1')?.map((entry) => entry.id)).toEqual(['f1', 'f2']);
    expect([...groups.keys()].sort()).toEqual(['1.1', '1.2', '2.1', 'c1', 'ghost']);
    expect(groups.size).toBe(5);
  });

  it('is empty for no frames and for no outline', () => {
    expect(countSections(tree, []).totals).toEqual({ exercises: 0, withSolution: 0 });
    const none = countSections(buildSectionTree([], 3), frames);
    expect(none.perNode).toEqual([]);
    expect(none.unplaced).toHaveLength(6);
  });
});

describe('ids for sections', () => {
  it('cleans text into an id, or gives up', () => {
    expect(cleanSectionId('1.2')).toBe('1.2');
    expect(cleanSectionId('Chapter 3')).toBe('Chapter-3');
    expect(cleanSectionId('  Über-Größe!  ')).toBe('Uber-Gro-e');
    expect(cleanSectionId('...x')).toBe('x');
    expect(cleanSectionId('x--y__')).toBe('x-y');
    expect(cleanSectionId('???')).toBeUndefined();
    expect(cleanSectionId('')).toBeUndefined();
    expect(cleanSectionId('x'.repeat(100))).toHaveLength(60);
  });

  it('derives an id from the printed label, else the number in the title, else the title, else the position', () => {
    const used = new Set<string>();
    expect(deriveSectionId({ title: 'Integers', label: '0.1' }, 3, used)).toBe('0.1');
    expect(deriveSectionId({ title: '2.3 Fractions' }, 4, used)).toBe('2.3');
    expect(deriveSectionId({ title: 'Chapter 7: Limits' }, 5, used)).toBe('7');
    expect(deriveSectionId({ title: 'Pre-Algebra' }, 6, used)).toBe('Pre-Algebra');
    expect(deriveSectionId({ title: '??' }, 7, used)).toBe('s8');
    expect([...used]).toEqual(['0.1', '2.3', '7', 'Pre-Algebra', 's8']);
  });

  it('makes ids unique and leaves existing ids alone', () => {
    const entries: OutlineEntry[] = [
      { title: '1 Sets', page: 0, depth: 0, id: '1' },
      { title: '1 Sets again', page: 1, depth: 0 },
      { title: '1 Sets once more', page: 2, depth: 0 },
      { title: 'Notes', page: 3, depth: 0, label: '1' },
    ];
    const result = assignSectionIds(entries);
    expect(result.entries.map((entry) => entry.id)).toEqual(['1', '1-2', '1-3', '1-4']);
    expect(result.assigned).toEqual([{ index: 1, id: '1-2' }, { index: 2, id: '1-3' }, { index: 3, id: '1-4' }]);
    expect(entries[1]?.id).toBeUndefined();
    expect(assignSectionIds(result.entries).assigned).toEqual([]);
  });

  it('only ever makes valid ids', () => {
    const titles = ['', '   ', '§', '7', 'x'.repeat(300), 'ñandú', '1..2', '--', '日本語', 'a b c'];
    const result = assignSectionIds(titles.map((title) => ({ title: title || 'untitled', page: 0, depth: 0 })));
    for (const entry of result.entries) expect(entry.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/);
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(titles.length);
  });
});

describe('numbering leaves authoritative exercises out', () => {
  const frames: Frame[] = [
    ordinary('e1', 0, 0.1, 0.2),
    bookFrame('b1', '1.1', '1', 0, 0.3, 0.4),
    ordinary('e2', 0, 0.5, 0.6),
    frame('q1', 'question', 1, rect(0.1, 0.1, 0.9, 0.2)),
    ordinary('p1', 2, 0.1, 0.2, { unit: 'u1' }),
    ordinary('p2', 2, 0.2, 0.3, { unit: 'u1' }),
    bookFrame('b2', '1.1', '2', 3, 0.1, 0.2),
  ];

  it('gives no number to them and does not count them', () => {
    const numbers = numberFrames(frames);
    expect([...numbers.keys()].sort()).toEqual(['e1', 'e2', 'p1', 'p2', 'q1']);
    expect(numbers.get('e2')?.label).toBe('E2');
    expect(numbers.get('p1')?.label).toBe('E3.1');
    expect(numbers.get('q1')?.label).toBe('Q1');
    expect(numbers.has('b1')).toBe(false);
    expect(countFrames(frames)).toEqual({ exercise: 3, question: 1, bookmark: 0 });
    expect(countFramesRaw(frames)).toEqual({ exercise: 6, question: 1, bookmark: 0 });
  });

  it('does not let them shift the numbers of the others', () => {
    const without = frames.filter((entry) => entry.authority === undefined);
    expect([...numberFrames(without).values()].map((entry) => entry.label)).toEqual([...numberFrames(frames).values()].map((entry) => entry.label));
  });

  it('draws them with their printed label, and the solution regions only when asked', () => {
    const list: Frame[] = [
      ordinary('e1', 0, 0.1, 0.2, { solution: [{ page: 1, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
      bookFrame('b1', '1.1', '5a', 0, 0.3, 0.4, { context: [{ page: 0, rect: rect(0.1, 0.25, 0.9, 0.29) }], continues: [{ page: 1, rect: rect(0.1, 0.5, 0.9, 0.6) }], solution: [{ page: 1, rect: rect(0.1, 0.7, 0.9, 0.75) }] }),
    ];
    expect(overlayBoxes(list, 0).map((box) => box.label)).toEqual(['E1', '5a', 'ctx 5a']);
    expect(overlayBoxes(list, 1).map((box) => box.label)).toEqual(['5a cont.']);
    expect(overlayBoxes(list, 1, { solutions: true }).map((box) => box.label)).toEqual(['sol E1', '5a cont.', 'sol 5a']);
  });
});

describe('a large book', () => {
  it('is located and counted in a blink: 10 000 exercises in 300 sections', () => {
    const entries: OutlineEntry[] = [];
    for (let i = 0; i < 300; i += 1) entries.push({ title: `${i + 1} Section`, page: i * 3, depth: i % 10 === 0 ? 0 : 1, id: `s${i + 1}`, top: 0.1 });
    const tree = buildSectionTree(entries, 1000);
    const frames: Frame[] = [];
    for (let i = 0; i < 10000; i += 1) {
      const page = Math.floor(i / 11);
      const section = Math.min(299, Math.floor(page / 3));
      frames.push(bookFrame(`f${i}`, `s${section + 1}`, String(i), page, 0.2 + (i % 11) * 0.05, 0.24 + (i % 11) * 0.05));
    }
    const started = performance.now();
    const counts = countSections(tree, frames);
    let located = 0;
    for (const entry of frames) if (sectionOfFrame(tree, entry, { withId: true })) located += 1;
    const elapsed = performance.now() - started;
    expect(counts.totals.exercises).toBe(10000);
    expect(counts.unplaced).toHaveLength(0);
    expect(located).toBe(10000);
    expect(elapsed).toBeLessThan(1500);
  });
});
