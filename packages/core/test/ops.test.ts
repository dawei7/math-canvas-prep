import { describe, expect, it } from 'vitest';
import { numberFrames } from '../src/model/numbering.js';
import type { Frame, TextLine } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { applyOperation, applyOperations, type Operation } from '../src/project/ops.js';
import { validateProject } from '../src/project/validate.js';
import { McPrepError } from '../src/rules/issues.js';
import { rect } from './helpers.js';

const base = (): Project => newProject({ pdf: { path: 'x.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 4 }, title: 'T' });
const ctx = { pageCount: 4 };
const apply = (project: Project, ...ops: Operation[]): Project => applyOperations(project, ops, ctx).project;
const frameOf = (project: Project, id: string): Frame => {
  const found = project.frames.find((frame) => frame.id === id);
  if (!found) throw new Error(`no frame ${id}`);
  return found;
};
const fails = (project: Project, op: Operation, code: string): McPrepError => {
  try {
    applyOperation(project, op, ctx);
  } catch (error) {
    expect(error).toBeInstanceOf(McPrepError);
    expect((error as McPrepError).code).toBe(code);
    return error as McPrepError;
  }
  throw new Error(`expected ${code}`);
};

const line = (text: string, top: number): TextLine => ({ text, rect: rect(0.1, top, 0.9, top + 0.012), fontSize: 11, column: 0, chars: text.length });

describe('add', () => {
  it('generates ids that are never reused and accepts several rect forms', () => {
    let project = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] });
    project = apply(project, { op: 'add', kind: 'question', page: 1, rect: '0.1,0.1,0.9,0.2' });
    project = apply(project, { op: 'delete', id: 'f1' }, { op: 'add', kind: 'bookmark', page: 2, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } });
    expect(project.frames.map((frame) => frame.id).sort()).toEqual(['f2', 'f3']);
    expect(project.seq).toBe(3);
  });

  it('takes an explicit id and refuses a taken or invalid one', () => {
    const project = apply(base(), { op: 'add', id: 'mine', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] });
    fails(project, { op: 'add', id: 'mine', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.4] }, 'E_ID_TAKEN');
    fails(base(), { op: 'add', id: 'no good', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] }, 'E_ID');
  });

  it('refuses a page that does not exist, a kind that does not exist and rects that cannot be fractions', () => {
    fails(base(), { op: 'add', kind: 'exercise', page: 4, rect: [0.1, 0.1, 0.9, 0.2] }, 'E_PAGE');
    fails(base(), { op: 'add', kind: 'exercise', page: -1, rect: [0.1, 0.1, 0.9, 0.2] }, 'E_PAGE');
    fails(base(), { op: 'add', kind: 'note' as 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] }, 'E_KIND');
    const range = fails(base(), { op: 'add', kind: 'exercise', page: 0, rect: [10, 20, 90, 30] }, 'E_RECT_RANGE');
    expect(range.hint).toContain('fractions');
    fails(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.9, 0.1, 0.1, 0.2] }, 'E_RECT_ORDER');
    fails(base(), { op: 'add', kind: 'exercise', page: 0, rect: 'nonsense' }, 'E_RECT');
  });

  it('clamps a rect that is a little outside the page and enlarges one that is too small', () => {
    const result = applyOperation(base(), { op: 'add', kind: 'exercise', page: 0, rect: [-0.005, 0.1, 1.004, 0.2] }, ctx);
    expect(frameOf(result.project, 'f1').rect).toMatchObject({ left: 0, right: 1 });
    const tiny = applyOperation(base(), { op: 'add', kind: 'bookmark', page: 0, rect: [0.5, 0.5, 0.505, 0.502] }, ctx);
    expect(tiny.notes.join(' ')).toContain('enlarged');
    expect(validateProject(tiny.project).errors).toEqual([]);
    fails(base(), { op: 'add', kind: 'bookmark', page: 0, rect: [0.5, 0.5, 0.505, 0.502], enlarge: false }, 'E_RECT_SMALL');
  });

  it('snaps the edges to text lines when asked, and says what it did', () => {
    const lines = [line('one', 0.1), line('two', 0.12), line('three', 0.14)];
    const withLines = { ...ctx, linesFor: (): TextLine[] => lines };
    const result = applyOperation(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1255, 0.9, 0.1465], snap: true }, withLines);
    const added = frameOf(result.project, 'f1');
    expect(added.rect.top).toBeCloseTo(0.114, 4);
    expect(added.rect.bottom).toBeCloseTo(0.152 + 0.004, 4);
    expect(result.notes.some((note) => note.includes('took the line'))).toBe(true);
    const noText = applyOperation(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1255, 0.9, 0.1465], snap: true }, ctx);
    expect(noText.notes.join(' ')).toContain('no text lines');
    expect(frameOf(noText.project, 'f1').rect.top).toBeCloseTo(0.1255);
  });

  it('allows continues on any frame but not on a part, and context only on exercises', () => {
    const region = { page: 1, rect: [0.1, 0.1, 0.9, 0.2] as [number, number, number, number] };
    const project = apply(base(), { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.1, 0.9, 0.2], continues: [region] });
    expect(frameOf(project, 'f1').continues).toHaveLength(1);
    fails(base(), { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.1, 0.9, 0.2], context: [region] }, 'E_CONTEXT');
    fails(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], unit: 'u1', continues: [region] }, 'E_UNIT');
    fails(base(), { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.1, 0.9, 0.2], unit: 'u1' }, 'E_UNIT');
  });
});

describe('update, move, delete', () => {
  const two = (): Project =>
    apply(
      base(),
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.3] },
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.4, 0.9, 0.6] },
    );

  it('changes the rect, page and kind of a frame; a change of kind drops the context', () => {
    let project = apply(two(), { op: 'context.add', id: 'f1', page: 1, rect: [0.1, 0.1, 0.9, 0.2] });
    project = apply(project, { op: 'update', id: 'f1', rect: [0.2, 0.1, 0.8, 0.3], page: 2 });
    expect(frameOf(project, 'f1')).toMatchObject({ page: 2, rect: { left: 0.2, right: 0.8 } });
    const asQuestion = applyOperation(project, { op: 'update', id: 'f1', kind: 'question' }, ctx);
    expect(frameOf(asQuestion.project, 'f1').context).toBeUndefined();
    expect(asQuestion.notes.join(' ')).toContain('context removed');
    fails(project, { op: 'update', id: 'nope', page: 0 }, 'E_NO_FRAME');
  });

  it('lists the known ids when a frame is not found', () => {
    expect(fails(two(), { op: 'delete', id: 'zzz' }, 'E_NO_FRAME').hint).toContain('f1, f2');
  });

  it('moves a frame and keeps it inside the page', () => {
    const moved = apply(two(), { op: 'move', id: 'f1', dx: 0.05, dy: 0.1 });
    expect(frameOf(moved, 'f1').rect).toMatchObject({ left: 0.15, top: 0.2, right: 0.95, bottom: 0.4 });
    const clamped = apply(two(), { op: 'move', id: 'f1', dx: 0.5, dy: -0.5 });
    expect(frameOf(clamped, 'f1').rect).toMatchObject({ right: 1, top: 0 });
    expect(frameOf(clamped, 'f1').rect.left).toBeCloseTo(0.2);
  });

  it('deletes a frame', () => {
    const project = apply(two(), { op: 'delete', id: 'f1' });
    expect(project.frames.map((frame) => frame.id)).toEqual(['f2']);
  });
});

describe('parts: split, dividers, area, merge, delete', () => {
  const exercise = (): Project => apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.6] });
  const parts = (project: Project): Frame[] => project.frames.filter((frame) => frame.unit !== undefined).sort((a, b) => a.rect.top - b.rect.top);

  it('cuts an exercise into parts that tile, the first part keeping the id', () => {
    const result = applyOperation(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.45] }, ctx);
    const list = parts(result.project);
    expect(list.map((frame) => frame.id)).toEqual(['f1', 'f3', 'f4']);
    expect(list.map((frame) => [frame.rect.top, frame.rect.bottom])).toEqual([[0.2, 0.3], [0.3, 0.45], [0.45, 0.6]]);
    expect(new Set(list.map((frame) => frame.unit)).size).toBe(1);
    expect(result.created).toEqual(['f3', 'f4']);
    expect(validateProject(result.project).errors).toEqual([]);
    expect([...numberFrames(result.project.frames).values()].map((entry) => entry.label).sort()).toEqual(['E1.1', 'E1.2', 'E1.3']);
  });

  it('can start the first part lower and make the text above it context', () => {
    const result = applyOperation(exercise(), { op: 'split', id: 'f1', at: [0.45], first: 0.3, preamble: 'context' }, ctx);
    const list = parts(result.project);
    expect(list[0]?.rect.top).toBe(0.3);
    expect(list[0]?.context).toEqual([{ page: 0, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.3 } }]);
    expect(validateProject(result.project).errors).toEqual([]);
    const dropped = applyOperation(exercise(), { op: 'split', id: 'f1', at: [0.45], first: 0.3, preamble: 'drop' }, ctx);
    expect(parts(dropped.project)[0]?.context).toBeUndefined();
    expect(parts(dropped.project)[0]?.rect.top).toBe(0.3);
  });

  it('refuses dividers that would leave a sliver, are outside, or cut something that cannot be cut', () => {
    fails(exercise(), { op: 'split', id: 'f1', at: [0.205] }, 'E_SPLIT');
    fails(exercise(), { op: 'split', id: 'f1', at: [0.595] }, 'E_SPLIT');
    fails(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.305] }, 'E_SPLIT');
    fails(exercise(), { op: 'split', id: 'f1', at: [] }, 'E_SPLIT');
    fails(exercise(), { op: 'split', id: 'f1', at: [0.3], first: 0.1 }, 'E_SPLIT');
    fails(exercise(), { op: 'split', id: 'f1', at: [0.3], preamble: 'context' }, 'E_SPLIT');
    const question = apply(base(), { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.2, 0.9, 0.6] });
    fails(question, { op: 'split', id: 'f1', at: [0.3] }, 'E_SPLIT');
    const continuing = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.6], continues: [{ page: 1, rect: [0.1, 0.1, 0.9, 0.2] }] });
    expect(fails(continuing, { op: 'split', id: 'f1', at: [0.3] }, 'E_SPLIT').hint).toContain('continues');
  });

  it('snaps the dividers onto lines when asked', () => {
    const lines = [line('(b) second', 0.31), line('(c) third', 0.46)];
    const result = applyOperation(exercise(), { op: 'split', id: 'f1', at: [0.32, 0.47], snap: true }, { ...ctx, linesFor: () => lines });
    const list = parts(result.project);
    expect(list[1]?.rect.top).toBeCloseTo(0.31 - 0.006, 4);
    expect(list[2]?.rect.top).toBeCloseTo(0.46 - 0.006, 4);
    expect(result.notes.filter((note) => note.includes('snapped'))).toHaveLength(2);
  });

  it('cuts a part again, keeping the unit', () => {
    const cut = apply(exercise(), { op: 'split', id: 'f1', at: [0.4] });
    const again = apply(cut, { op: 'split', id: 'f1', at: [0.3] });
    expect(parts(again).map((frame) => [frame.rect.top, frame.rect.bottom])).toEqual([[0.2, 0.3], [0.3, 0.4], [0.4, 0.6]]);
    expect(new Set(parts(again).map((frame) => frame.unit)).size).toBe(1);
    fails(cut, { op: 'split', id: 'f1', at: [0.3], first: 0.25 }, 'E_SPLIT');
  });

  it('moves the dividers, adds parts and removes parts with "dividers"', () => {
    const three = apply(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.45] });
    const moved = apply(three, { op: 'dividers', id: 'f3', at: [0.35, 0.5] });
    expect(parts(moved).map((frame) => [frame.rect.top, frame.rect.bottom])).toEqual([[0.2, 0.35], [0.35, 0.5], [0.5, 0.6]]);
    expect(parts(moved).map((frame) => frame.id)).toEqual(['f1', 'f3', 'f4']);
    const more = applyOperation(three, { op: 'dividers', id: 'f1', at: [0.3, 0.4, 0.5] }, ctx);
    expect(parts(more.project)).toHaveLength(4);
    expect(more.created).toHaveLength(1);
    const fewer = applyOperation(three, { op: 'dividers', id: 'f1', at: [0.4] }, ctx);
    expect(parts(fewer.project).map((frame) => frame.id)).toEqual(['f1', 'f3']);
    expect(fewer.removed).toEqual(['f4']);
    const single = apply(three, { op: 'dividers', id: 'f1', at: [] });
    expect(single.frames.filter((frame) => frame.unit !== undefined)).toHaveLength(0);
    expect(single.frames).toHaveLength(1);
    fails(exercise(), { op: 'dividers', id: 'f1', at: [0.3] }, 'E_UNIT_PART');
  });

  it('moves and resizes the whole area of an exercise with parts, the cuts staying put', () => {
    const three = apply(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.45] });
    const moved = apply(three, { op: 'move', id: 'f3', dx: 0.02, dy: 0.1 });
    expect(parts(moved).map((frame) => [frame.rect.left, frame.rect.top, frame.rect.bottom])).toEqual([
      [0.12, 0.3, 0.4],
      [0.12, 0.4, 0.55],
      [0.12, 0.55, 0.7],
    ]);
    const resized = apply(three, { op: 'area', id: 'f4', rect: [0.05, 0.15, 0.95, 0.7] });
    expect(parts(resized).map((frame) => [frame.rect.left, frame.rect.right, frame.rect.top, frame.rect.bottom])).toEqual([
      [0.05, 0.95, 0.15, 0.3],
      [0.05, 0.95, 0.3, 0.45],
      [0.05, 0.95, 0.45, 0.7],
    ]);
    expect(validateProject(resized).errors).toEqual([]);
    fails(three, { op: 'area', id: 'f1', rect: [0.1, 0.35, 0.9, 0.6] }, 'E_AREA');
    fails(three, { op: 'update', id: 'f3', rect: [0.1, 0.3, 0.9, 0.4] }, 'E_UNIT_PART');
  });

  it('merges parts back, by unit or by neighbours', () => {
    const four = apply(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.4, 0.5] });
    const unit = frameOf(four, 'f1').unit as string;
    const all = applyOperation(four, { op: 'merge', unit }, ctx);
    expect(all.project.frames).toHaveLength(1);
    expect(all.project.frames[0]).toMatchObject({ id: 'f1', rect: { top: 0.2, bottom: 0.6 } });
    expect(all.project.frames[0]?.unit).toBeUndefined();
    expect(all.removed.sort()).toEqual(['f3', 'f4', 'f5']);
    const some = apply(four, { op: 'merge', ids: ['f1', 'f3'] });
    expect(parts(some).map((frame) => [frame.id, frame.rect.top, frame.rect.bottom])).toEqual([['f1', 0.2, 0.4], ['f4', 0.4, 0.5], ['f5', 0.5, 0.6]]);
    fails(four, { op: 'merge', ids: ['f1', 'f4'] }, 'E_MERGE');
    fails(four, { op: 'merge', ids: ['f1'] }, 'E_MERGE');
    const independent = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.4] });
    fails(independent, { op: 'merge', ids: ['f1', 'f2'] }, 'E_MERGE');
    fails(four, { op: 'merge', unit: 'nope' }, 'E_NO_UNIT');
  });

  it('keeps the parts tiling when one is deleted, and dissolves the unit when one part is left', () => {
    const four = apply(exercise(), { op: 'split', id: 'f1', at: [0.3, 0.4, 0.5] });
    const middle = apply(four, { op: 'delete', id: 'f3' });
    expect(parts(middle).map((frame) => [frame.id, frame.rect.top, frame.rect.bottom])).toEqual([['f1', 0.2, 0.4], ['f4', 0.4, 0.5], ['f5', 0.5, 0.6]]);
    expect(validateProject(middle).errors).toEqual([]);
    const last = apply(middle, { op: 'delete', id: 'f5' });
    expect(validateProject(last).errors).toEqual([]);
    const one = apply(last, { op: 'delete', id: 'f4' });
    expect(one.frames).toHaveLength(1);
    expect(one.frames[0]?.unit).toBeUndefined();
    const unit = frameOf(four, 'f1').unit as string;
    expect(apply(four, { op: 'delete', unit }).frames).toHaveLength(0);
  });
});

describe('context and continues', () => {
  const region = { page: 1, rect: [0.1, 0.1, 0.9, 0.2] as [number, number, number, number] };

  it('attaches context to an exercise, to the first part for a unit, and keeps at most 8 regions', () => {
    let project = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.7] }, { op: 'split', id: 'f1', at: [0.5] });
    // The unit takes the id u2, so the second part is f3.
    project = apply(project, { op: 'context.add', id: 'f3', ...region });
    expect(frameOf(project, 'f1').context).toHaveLength(1);
    expect(frameOf(project, 'f3').context).toBeUndefined();
    for (let i = 0; i < 7; i += 1) project = apply(project, { op: 'context.add', id: 'f1', ...region });
    fails(project, { op: 'context.add', id: 'f1', ...region }, 'E_CONTEXT');
  });

  it('removes one region by index, or all, and needs an index when there are several', () => {
    let project = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.7] });
    project = apply(project, { op: 'context.add', id: 'f1', ...region }, { op: 'context.add', id: 'f1', page: 2, rect: [0.1, 0.1, 0.9, 0.2] });
    fails(project, { op: 'context.remove', id: 'f1' }, 'E_CONTEXT');
    fails(project, { op: 'context.remove', id: 'f1', index: 5 }, 'E_CONTEXT');
    expect(frameOf(apply(project, { op: 'context.remove', id: 'f1', index: 0 }), 'f1').context).toEqual([{ page: 2, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } }]);
    expect(frameOf(apply(project, { op: 'context.remove', id: 'f1', all: true }), 'f1').context).toBeUndefined();
    expect(frameOf(apply(project, { op: 'context.set', id: 'f1', regions: [region] }), 'f1').context).toHaveLength(1);
    expect(frameOf(apply(project, { op: 'context.set', id: 'f1', regions: [] }), 'f1').context).toBeUndefined();
  });

  it('adds and removes continuation regions, never on a part', () => {
    let project = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.6, 0.9, 0.9] });
    project = apply(project, { op: 'continues.add', id: 'f1', ...region });
    expect(frameOf(project, 'f1').continues).toHaveLength(1);
    expect(frameOf(apply(project, { op: 'continues.remove', id: 'f1' }), 'f1').continues).toBeUndefined();
    fails(base(), { op: 'continues.remove', id: 'f1' }, 'E_NO_FRAME');
    const split = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.7] }, { op: 'split', id: 'f1', at: [0.5] });
    fails(split, { op: 'continues.add', id: 'f1', ...region }, 'E_UNIT');
  });

  it('keeps the context of an exercise when its first part is deleted', () => {
    let project = apply(base(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.7] }, { op: 'split', id: 'f1', at: [0.5] });
    project = apply(project, { op: 'context.add', id: 'f1', ...region }, { op: 'delete', id: 'f1' });
    expect(project.frames).toHaveLength(1);
    expect(frameOf(project, 'f3').context).toHaveLength(1);
  });
});

describe('outline and metadata', () => {
  it('sets, adds and clears the outline, normalising what it is given', () => {
    let project = apply(base(), {
      op: 'outline.set',
      entries: [
        { title: '  1   Sets ', page: 0, depth: 0 },
        { title: '1.1 Sub', page: 1, depth: 3 },
        { title: '   ', page: 1, depth: 0 },
      ],
    });
    expect(project.outline).toEqual({ source: 'manual', entries: [{ title: '1 Sets', page: 0, depth: 0 }, { title: '1.1 Sub', page: 1, depth: 1 }] });
    project = apply(project, { op: 'outline.add', title: '2 More', page: 3, depth: 0 });
    expect(project.outline?.entries).toHaveLength(3);
    expect(apply(project, { op: 'outline.clear' }).outline).toBeUndefined();
    fails(base(), { op: 'outline.set', entries: [{ title: 'x', page: 9, depth: 0 }] }, 'E_PAGE');
    expect(apply(base(), { op: 'outline.set', source: 'derived', entries: [] }).outline?.source).toBe('derived');
  });

  it('sets the title and folder', () => {
    const project = apply(base(), { op: 'meta.set', title: ' New title ', folder: 'A\\B/C' });
    expect(project.meta).toEqual({ title: 'New title', folder: 'A/B/C' });
    expect(apply(project, { op: 'meta.set', folder: null }).meta).toEqual({ title: 'New title' });
    fails(base(), { op: 'meta.set', title: '   ' }, 'E_TITLE');
  });
});

describe('batches', () => {
  it('applies everything or nothing, and names the operation that failed', () => {
    const project = base();
    const ops: Operation[] = [
      { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] },
      { op: 'add', kind: 'exercise', page: 9, rect: [0.1, 0.1, 0.9, 0.2] },
    ];
    expect(() => applyOperations(project, ops, ctx)).toThrow(/Operation 1 \(add\)/);
    expect(project.frames).toHaveLength(0);
    try {
      applyOperations(project, ops, ctx);
    } catch (error) {
      expect((error as McPrepError).code).toBe('E_PAGE');
      expect((error as McPrepError).details).toMatchObject({ operation: 1 });
    }
  });

  it('lets later operations refer to frames made earlier in the same batch with @ref', () => {
    const result = applyOperations(
      base(),
      [
        { op: 'add', ref: 'a', kind: 'exercise', page: 0, rect: [0.1, 0.2, 0.9, 0.6] },
        { op: 'split', id: '@a', at: [0.4] },
        { op: 'context.add', id: '@a', page: 1, rect: [0.1, 0.1, 0.9, 0.2] },
        { op: 'add', ref: 'q', kind: 'question', page: 2, rect: [0.1, 0.1, 0.9, 0.2] },
        { op: 'update', id: '@q', rect: [0.1, 0.1, 0.8, 0.3] },
      ],
      ctx,
    );
    expect(result.project.frames).toHaveLength(3);
    expect(result.steps.map((step) => step.op)).toEqual(['add', 'split', 'context.add', 'add', 'update']);
    expect(frameOf(result.project, 'f1').context).toHaveLength(1);
  });

  it('rejects an undefined or duplicate reference and an unknown operation', () => {
    expect(() => applyOperations(base(), [{ op: 'delete', id: '@missing' }], ctx)).toThrow(/not defined/);
    const twice: Operation[] = [
      { op: 'add', ref: 'a', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2] },
      { op: 'add', ref: 'a', kind: 'exercise', page: 0, rect: [0.1, 0.3, 0.9, 0.4] },
    ];
    expect(() => applyOperations(base(), twice, ctx)).toThrow(/twice/);
    const unknown = fails(base(), { op: 'frobnicate' } as unknown as Operation, 'E_OP');
    expect(unknown.hint).toContain('split');
    expect(() => applyOperations(base(), [null as unknown as Operation], ctx)).toThrow(/must be an object/);
  });
});
