import { describe, expect, it } from 'vitest';
import { numberFrames } from '../src/model/numbering.js';
import type { Frame, TextLine } from '../src/model/types.js';
import { applyOperation, applyOperations, findFrame, type Operation } from '../src/project/ops.js';
import type { Project } from '../src/project/model.js';
import { validateProject } from '../src/project/validate.js';
import { McPrepError } from '../src/rules/issues.js';
import { bookOutline, bookProject, emptyProject, ordinary } from './book-helpers.js';
import { rect } from './helpers.js';

const ctx = { pageCount: 6 };
const apply = (project: Project, ...ops: Operation[]): Project => applyOperations(project, ops, ctx).project;
const frameOf = (project: Project, id: string): Frame => {
  const found = project.frames.find((entry) => entry.id === id);
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
const errorsOf = (project: Project): string[] => validateProject(project).errors.map((entry) => `${entry.code}${entry.frameId ? `:${entry.frameId}` : ''}`);

const add = (extra: Partial<Extract<Operation, { op: 'add' }>> = {}): Operation => ({ op: 'add', authority: 'book', label: '5a', section: '1.1', page: 0, rect: [0.1, 0.4, 0.9, 0.5], ...extra });

describe('adding an authoritative exercise', () => {
  it('makes an exercise with a label and a section, and no positional number', () => {
    const result = applyOperation(bookProject(), add({ solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }], context: [{ page: 0, rect: [0.1, 0.32, 0.9, 0.39] }], continues: [{ page: 1, rect: [0.1, 0.2, 0.9, 0.3] }] }), ctx);
    const made = frameOf(result.project, 'f1');
    expect(made).toMatchObject({ kind: 'exercise', authority: 'book', label: '5a', section: '1.1', page: 0 });
    expect(made.solution).toHaveLength(1);
    expect(made.context).toHaveLength(1);
    expect(made.continues).toHaveLength(1);
    expect(result.created).toEqual(['f1']);
    expect(result.target).toBe('f1');
    expect(numberFrames(result.project.frames).size).toBe(0);
    expect(errorsOf(result.project)).toEqual([]);
  });

  it('writes the label the way the book prints it and says what it changed', () => {
    const result = applyOperation(bookProject(), add({ label: '  5a) ' }), ctx);
    expect(frameOf(result.project, 'f1').label).toBe('5a');
    expect(result.notes.join(' ')).toContain('closing ")"');
    expect(frameOf(applyOperation(bookProject(), add({ label: '5(a)' }), ctx).project, 'f1').label).toBe('5(a)');
  });

  it('takes the kind exercise for granted, and refuses another kind', () => {
    expect(frameOf(apply(bookProject(), add({ kind: 'exercise' })), 'f1').kind).toBe('exercise');
    fails(bookProject(), add({ kind: 'question' }), 'E_AUTHORITY');
    fails(bookProject(), add({ kind: 'bookmark' }), 'E_AUTHORITY');
  });

  it.each([
    ['no label', { label: undefined }, 'E_LABEL'],
    ['an empty label', { label: '  ' }, 'E_LABEL'],
    ['a label that is not allowed', { label: '(a)' }, 'E_LABEL'],
    ['a label that is too long', { label: 'x'.repeat(25) }, 'E_LABEL'],
    ['no section', { section: undefined }, 'E_SECTION'],
    ['a section that is not an id', { section: 'a b' }, 'E_SECTION'],
    ['another authority', { authority: 'user' as 'book' }, 'E_AUTHORITY'],
  ])('refuses %s', (_name, extra, code) => {
    fails(bookProject(), add(extra), code);
  });

  it('refuses a unit, and explains that the parts of a printed exercise are exercises of their own', () => {
    const error = fails(bookProject(), add({ unit: 'u1' }), 'E_AUTHORITY_UNIT');
    expect(error.message).toContain('single exercise');
    expect(error.hint).toContain('5a, 5b');
    expect(error.hint).toContain('context');
  });

  it('refuses a label or section without authority, and replace without authority', () => {
    fails(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], label: '5' }, 'E_AUTHORITY');
    fails(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], section: '1.1' }, 'E_AUTHORITY');
    fails(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], replace: true }, 'E_AUTHORITY');
  });

  it('lets an ordinary exercise have a solution, but not a question', () => {
    const made = apply(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }] });
    expect(frameOf(made, 'f1').solution).toHaveLength(1);
    fails(bookProject(), { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.1, 0.9, 0.2], solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }] }, 'E_SOLUTION');
  });

  it('is exact about the pair (section, label): the same label in another section is another exercise', () => {
    const project = apply(bookProject(), add(), add({ section: '1.2', page: 1 }), add({ label: '5b', rect: [0.1, 0.5, 0.9, 0.6] }));
    expect(project.frames.map((entry) => `${entry.section}:${entry.label}`)).toEqual(['1.1:5a', '1.2:5a', '1.1:5b']);
    expect(errorsOf(project)).toEqual([]);
  });
});

describe('applying the same batch twice', () => {
  const batch: Operation[] = [add({ label: '1', rect: [0.1, 0.4, 0.9, 0.5] }), add({ label: '2', rect: [0.1, 0.5, 0.9, 0.6] })];

  it('does not duplicate anything: the second time is an error that names the exercise and the way out', () => {
    const once = apply(bookProject(), ...batch);
    let thrown: McPrepError | undefined;
    try {
      applyOperations(once, batch, ctx);
    } catch (error) {
      thrown = error as McPrepError;
    }
    expect(thrown?.code).toBe('E_DUPLICATE_EXERCISE');
    expect(thrown?.message).toContain('Operation 0 (add)');
    expect(thrown?.message).toContain('"1"');
    expect(thrown?.message).toContain('"1.1"');
    expect(thrown?.message).toContain('f1');
    expect(thrown?.hint).toContain('replace');
    expect(once.frames).toHaveLength(2);
  });

  it('is idempotent with replace, and keeps the frame ids', () => {
    const replacing = batch.map((entry) => ({ ...entry, replace: true }) as Operation);
    const once = apply(bookProject(), ...replacing);
    const twice = apply(once, ...replacing);
    expect(twice.frames).toEqual(once.frames);
    expect(twice.frames.map((entry) => entry.id)).toEqual(['f1', 'f2']);
    const result = applyOperations(once, replacing, ctx);
    expect(result.created).toEqual([]);
    expect(result.replaced).toEqual(['f1', 'f2']);
    expect(result.steps[0]?.replaced).toEqual(['f1']);
    expect(result.notes.join(' ')).toContain('Replaced the exercise 1.1:1');
  });

  it('replaces page, rect and continuation, and keeps context and solution unless the operation lists them', () => {
    const rich = apply(bookProject(), add({ context: [{ page: 0, rect: [0.1, 0.3, 0.9, 0.39] }], solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }], continues: [{ page: 1, rect: [0.1, 0.2, 0.9, 0.3] }] }));
    const moved = apply(rich, add({ page: 2, rect: [0.2, 0.2, 0.8, 0.3], replace: true }));
    expect(frameOf(moved, 'f1')).toMatchObject({ page: 2, rect: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.3 } });
    expect(frameOf(moved, 'f1').continues).toBeUndefined();
    expect(frameOf(moved, 'f1').context).toHaveLength(1);
    expect(frameOf(moved, 'f1').solution).toHaveLength(1);
    const changed = apply(rich, add({ replace: true, context: [], solution: [{ page: 4, rect: [0.1, 0.1, 0.9, 0.2] }, { page: 4, rect: [0.1, 0.3, 0.9, 0.4] }] }));
    expect(frameOf(changed, 'f1').context).toBeUndefined();
    expect(frameOf(changed, 'f1').solution).toHaveLength(2);
    expect(frameOf(apply(rich, add({ replace: true, solution: [] })), 'f1').solution).toBeUndefined();
    expect(changed.frames).toHaveLength(1);
  });

  it('keeps the id it has and says so when the operation offers another', () => {
    const project = apply(bookProject(), add());
    const result = applyOperation(project, add({ replace: true, id: 'mine' }), ctx);
    expect(frameOf(result.project, 'f1').label).toBe('5a');
    expect(result.project.frames).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('keeps its id');
  });

  it('lets later operations of the batch name the replaced exercise by its ref', () => {
    const project = apply(bookProject(), add());
    const result = applyOperations(project, [add({ replace: true, ref: 'x' }), { op: 'solution.add', id: '@x', page: 5, rect: [0.1, 0.4, 0.9, 0.45] }], ctx);
    expect(frameOf(result.project, 'f1').solution).toHaveLength(1);
    expect(result.project.frames).toHaveLength(1);
  });
});

describe('what an authoritative exercise cannot be', () => {
  const project = (): Project => apply(bookProject(), add({ label: '5', rect: [0.1, 0.1, 0.9, 0.5] }));

  it.each([
    ['split', { op: 'split', id: 'f1', at: [0.3] }],
    ['dividers', { op: 'dividers', id: 'f1', at: [0.3] }],
    ['area', { op: 'area', id: 'f1', rect: [0.1, 0.1, 0.9, 0.6] }],
    ['merge', { op: 'merge', ids: ['f1', 'f2'] }],
  ] as [string, Operation][])('is not cut into parts by %s', (_name, op) => {
    const withOther = apply(project(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.5, 0.9, 0.6] });
    const error = fails(withOther, op, 'E_AUTHORITY');
    expect(error.message).toContain('f1');
    expect(error.message).toContain('1.1:5');
    expect(error.hint).toContain('separate exercises');
    expect(error.hint).toContain('context');
  });

  it('refuses a part, a merge of a part, and a split by its reference as well', () => {
    fails(project(), { op: 'split', id: '1.1:5', at: [0.3] }, 'E_AUTHORITY');
    const parts = apply(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.5] }, { op: 'split', id: 'f1', at: [0.3] });
    fails(parts, { op: 'authority.mark', id: 'f1', label: '5', section: '1.1' }, 'E_AUTHORITY_UNIT');
  });

  it('may still be moved, resized, deleted and given context, continuations and solutions', () => {
    const base = project();
    expect(frameOf(apply(base, { op: 'update', id: 'f1', rect: [0.1, 0.1, 0.9, 0.6] }), 'f1').rect.bottom).toBe(0.6);
    expect(frameOf(apply(base, { op: 'move', id: 'f1', dx: 0, dy: 0.1 }), 'f1').rect.top).toBeCloseTo(0.2);
    expect(apply(base, { op: 'delete', id: 'f1' }).frames).toHaveLength(0);
    const rich = apply(base, { op: 'context.add', id: 'f1', page: 0, rect: [0.1, 0.05, 0.9, 0.09] }, { op: 'continues.add', id: 'f1', page: 1, rect: [0.1, 0.1, 0.9, 0.2] }, { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.4, 0.9, 0.45] });
    expect(frameOf(rich, 'f1')).toMatchObject({ context: expect.any(Array), continues: expect.any(Array), solution: expect.any(Array) });
    expect(errorsOf(rich)).toEqual([]);
  });

  it('cannot become a question or a bookmark, but an ordinary exercise that drops its solution can', () => {
    fails(project(), { op: 'update', id: 'f1', kind: 'question' }, 'E_AUTHORITY');
    const ordinaryWithSolution = apply(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.2], solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }], context: [{ page: 0, rect: [0.1, 0.02, 0.9, 0.06] }] });
    const result = applyOperation(ordinaryWithSolution, { op: 'update', id: 'f1', kind: 'question' }, ctx);
    expect(frameOf(result.project, 'f1')).toMatchObject({ kind: 'question' });
    expect(frameOf(result.project, 'f1').solution).toBeUndefined();
    expect(result.notes.join(' ')).toContain('solution removed');
  });
});

describe('making and unmaking an authoritative exercise', () => {
  const start = (): Project => apply(bookProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.4, 0.9, 0.5], solution: [{ page: 5, rect: [0.1, 0.4, 0.9, 0.45] }] }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.6, 0.9, 0.7] });

  it('marks an exercise you framed, which then has no positional number', () => {
    const before = numberFrames(start().frames);
    expect([...before.values()].map((entry) => entry.label)).toEqual(['E1', 'E2']);
    const result = applyOperation(start(), { op: 'authority.mark', id: 'f1', label: '3.', section: '1.1' }, ctx);
    expect(frameOf(result.project, 'f1')).toMatchObject({ authority: 'book', label: '3', section: '1.1' });
    expect(result.notes.join(' ')).toContain('no positional number');
    expect([...numberFrames(result.project.frames).values()].map((entry) => `${entry.id}:${entry.label}`)).toEqual(['f2:E1']);
    expect(frameOf(result.project, 'f1').solution).toHaveLength(1);
  });

  it('refuses what cannot be marked', () => {
    const marked = apply(start(), { op: 'authority.mark', id: 'f1', label: '3', section: '1.1' });
    expect(fails(marked, { op: 'authority.mark', id: 'f1', label: '4', section: '1.1' }, 'E_AUTHORITY').hint).toContain('label.set');
    const withQuestion = apply(start(), { op: 'add', kind: 'question', page: 1, rect: [0.1, 0.1, 0.9, 0.2] });
    fails(withQuestion, { op: 'authority.mark', id: 'f3', label: '1', section: '1.1' }, 'E_AUTHORITY');
    fails(start(), { op: 'authority.mark', id: 'f1', label: '', section: '1.1' }, 'E_LABEL');
    fails(start(), { op: 'authority.mark', id: 'f1', label: '1', section: 'x y' }, 'E_SECTION');
    fails(start(), { op: 'authority.mark', id: 'nope', label: '1', section: '1.1' }, 'E_NO_FRAME');
  });

  it('unmarks it into an ordinary exercise again, with a number, keeping its solution', () => {
    const marked = apply(start(), { op: 'authority.mark', id: 'f1', label: '3', section: '1.1' });
    const result = applyOperation(marked, { op: 'authority.unmark', id: 'f1' }, ctx);
    const back = frameOf(result.project, 'f1');
    expect(back.authority).toBeUndefined();
    expect(back.label).toBeUndefined();
    expect(back.section).toBeUndefined();
    expect(back.solution).toHaveLength(1);
    expect([...numberFrames(result.project.frames).values()].map((entry) => entry.label)).toEqual(['E1', 'E2']);
    fails(start(), { op: 'authority.unmark', id: 'f1' }, 'E_AUTHORITY');
  });

  it('changes the label and the section, naming the exercise that is not one yet', () => {
    const marked = apply(start(), { op: 'authority.mark', id: 'f1', label: '3', section: '1.1' });
    const changed = apply(marked, { op: 'label.set', id: 'f1', label: '3b)' }, { op: 'section.set', id: 'f1', section: '1.2' });
    expect(frameOf(changed, 'f1')).toMatchObject({ label: '3b', section: '1.2' });
    expect(fails(start(), { op: 'label.set', id: 'f1', label: '3' }, 'E_AUTHORITY').hint).toContain('exercises mark f1');
    fails(start(), { op: 'section.set', id: 'f1', section: '1.2' }, 'E_AUTHORITY');
    fails(marked, { op: 'label.set', id: 'f1', label: '' }, 'E_LABEL');
    fails(marked, { op: 'section.set', id: 'f1', section: '' }, 'E_SECTION');
  });

  it('lets a batch swap two labels: duplicates are judged once, at the end', () => {
    const two = apply(bookProject(), add({ label: '1', rect: [0.1, 0.4, 0.9, 0.5] }), add({ label: '2', rect: [0.1, 0.5, 0.9, 0.6] }));
    const swapped = apply(two, { op: 'label.set', id: 'f1', label: '2' }, { op: 'label.set', id: 'f2', label: '1' });
    expect(swapped.frames.map((entry) => entry.label)).toEqual(['2', '1']);
    expect(errorsOf(swapped)).toEqual([]);
    const clash = apply(two, { op: 'label.set', id: 'f1', label: '2' });
    expect(errorsOf(clash)).toEqual(['duplicate-exercise:f2']);
  });
});

describe('naming an exercise by its section and label', () => {
  const project = (): Project => apply(bookProject(), add({ label: '1', rect: [0.1, 0.4, 0.9, 0.5] }), add({ label: '2', rect: [0.1, 0.5, 0.9, 0.6] }), add({ label: '1', section: '1.2', page: 1 }));

  it('finds it', () => {
    expect(findFrame(project(), '1.1:2')?.id).toBe('f2');
    expect(findFrame(project(), '1.2:1')?.id).toBe('f3');
    expect(findFrame(project(), 'f1')?.id).toBe('f1');
    expect(findFrame(project(), '1.1:9')).toBeUndefined();
    expect(findFrame(project(), '9.9:1')).toBeUndefined();
    expect(findFrame(project(), ':1')).toBeUndefined();
  });

  it('works wherever an operation takes an id', () => {
    const changed = apply(project(), { op: 'update', id: '1.1:2', rect: [0.1, 0.5, 0.9, 0.65] }, { op: 'context.add', id: '1.2:1', page: 1, rect: [0.1, 0.05, 0.9, 0.1] }, { op: 'solution.add', id: '1.1:1', page: 5, rect: [0.1, 0.4, 0.9, 0.45] }, { op: 'continues.add', id: '1.1:1', page: 2, rect: [0.1, 0.1, 0.9, 0.2] });
    expect(frameOf(changed, 'f2').rect.bottom).toBe(0.65);
    expect(frameOf(changed, 'f3').context).toHaveLength(1);
    expect(frameOf(changed, 'f1').solution).toHaveLength(1);
    expect(frameOf(changed, 'f1').continues).toHaveLength(1);
    const result = applyOperation(project(), { op: 'delete', id: '1.1:2' }, ctx);
    expect(result.removed).toEqual(['f2']);
    expect(result.project.frames.map((entry) => entry.id)).toEqual(['f1', 'f3']);
    expect(apply(project(), { op: 'label.set', id: '1.1:2', label: '7' }).frames.find((entry) => entry.id === 'f2')?.label).toBe('7');
  });

  it('says which exercises the section has when the label is not there', () => {
    const error = fails(project(), { op: 'update', id: '1.1:9', rect: [0.1, 0.1, 0.9, 0.2] }, 'E_NO_FRAME');
    expect(error.message).toContain('"9"');
    expect(error.message).toContain('"1.1"');
    expect(error.hint).toContain('1, 2');
    expect(fails(project(), { op: 'update', id: '7.7:1', rect: [0.1, 0.1, 0.9, 0.2] }, 'E_NO_FRAME').hint).toContain('exercises list');
  });
});

describe('solution regions', () => {
  const start = (): Project => apply(bookProject(), add(), { op: 'add', kind: 'question', page: 1, rect: [0.1, 0.1, 0.9, 0.2] });

  it('are added, removed by index and set', () => {
    let project = apply(start(), { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.4, 0.9, 0.45] }, { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.5, 0.9, 0.55] });
    expect(frameOf(project, 'f1').solution?.map((region) => region.rect.top)).toEqual([0.4, 0.5]);
    project = apply(project, { op: 'solution.remove', id: 'f1', index: 0 });
    expect(frameOf(project, 'f1').solution?.map((region) => region.rect.top)).toEqual([0.5]);
    project = apply(project, { op: 'solution.remove', id: 'f1' });
    expect(frameOf(project, 'f1').solution).toBeUndefined();
    project = apply(project, { op: 'solution.set', id: 'f1', regions: [{ page: 4, rect: [0.1, 0.1, 0.9, 0.2] }, { page: 4, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.4 } }] });
    expect(frameOf(project, 'f1').solution).toHaveLength(2);
    expect(frameOf(apply(project, { op: 'solution.remove', id: 'f1', all: true }), 'f1').solution).toBeUndefined();
    expect(frameOf(apply(project, { op: 'solution.set', id: 'f1', regions: [] }), 'f1').solution).toBeUndefined();
  });

  it('refuse what cannot work, saying why', () => {
    fails(start(), { op: 'solution.add', id: 'f2', page: 5, rect: [0.1, 0.4, 0.9, 0.45] }, 'E_SOLUTION');
    fails(start(), { op: 'solution.add', id: 'f1', page: 6, rect: [0.1, 0.4, 0.9, 0.45] }, 'E_PAGE');
    fails(start(), { op: 'solution.add', id: 'f1', page: 5, rect: [10, 40, 90, 45] }, 'E_RECT_RANGE');
    fails(start(), { op: 'solution.remove', id: 'f1' }, 'E_SOLUTION');
    const two = apply(start(), { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.4, 0.9, 0.45] }, { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.5, 0.9, 0.55] });
    expect(fails(two, { op: 'solution.remove', id: 'f1' }, 'E_SOLUTION').message).toContain('say which');
    fails(two, { op: 'solution.remove', id: 'f1', index: 2 }, 'E_SOLUTION');
    fails(two, { op: 'solution.remove', id: 'f1', index: -1 }, 'E_SOLUTION');
    const regions = Array.from({ length: 9 }, (_, i) => ({ page: 5, rect: [0.1, 0.05 * i + 0.1, 0.9, 0.05 * i + 0.14] as [number, number, number, number] }));
    fails(start(), { op: 'solution.set', id: 'f1', regions }, 'E_SOLUTION');
  });

  it('stop at eight', () => {
    let project = start();
    for (let i = 0; i < 8; i += 1) project = apply(project, { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.05 * i + 0.1, 0.9, 0.05 * i + 0.14] });
    expect(frameOf(project, 'f1').solution).toHaveLength(8);
    fails(project, { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.6, 0.9, 0.65] }, 'E_SOLUTION');
  });

  it('can be snapped to the printed lines like any region', () => {
    const lines: TextLine[] = [
      { text: '21) 17', rect: rect(0.1, 0.4, 0.5, 0.412), fontSize: 10, column: 0, chars: 6 },
      { text: '22) 0', rect: rect(0.1, 0.42, 0.5, 0.432), fontSize: 10, column: 0, chars: 5 },
    ];
    const result = applyOperation(start(), { op: 'solution.add', id: 'f1', page: 5, rect: [0.1, 0.426, 0.9, 0.5], snap: true }, { ...ctx, linesFor: () => lines });
    expect(result.notes.join(' ')).toContain('22) 0');
    expect(frameOf(result.project, 'f1').solution?.[0]?.rect.top).toBeLessThan(0.426);
  });

  it('belong to the part they are added to when the exercise has parts', () => {
    const parts = apply(emptyProject(), { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.1, 0.9, 0.5] }, { op: 'split', id: 'f1', at: [0.3] });
    const second = parts.frames.find((entry) => entry.unit !== undefined && entry.id !== 'f1')?.id as string;
    const withSolution = apply(parts, { op: 'solution.add', id: second, page: 5, rect: [0.1, 0.4, 0.9, 0.45] });
    expect(frameOf(withSolution, second).solution).toHaveLength(1);
    expect(frameOf(withSolution, 'f1').solution).toBeUndefined();
  });
});

describe('the outline as the sections of a book', () => {
  const entries = bookOutline();

  it('is set with ids, labels and tops, and they are kept', () => {
    const project = apply(emptyProject(), { op: 'outline.set', entries });
    expect(project.outline?.entries).toEqual(entries);
    const clean = apply(emptyProject(), { op: 'outline.set', entries: [{ title: ' 1  Sets ', page: 0, depth: 0, id: 'a', label: ' 1 ', top: 0.123456789 }] });
    expect(clean.outline?.entries).toEqual([{ title: '1 Sets', page: 0, depth: 0, id: 'a', label: '1', top: 0.12346 }]);
  });

  it.each([
    ['a bad id', { id: 'a b' }],
    ['a label that is too long', { label: 'x'.repeat(25) }],
    ['a top above 1', { top: 1.5 }],
    ['a top that is not a number', { top: '0.2' as unknown as number }],
  ])('refuses %s in a list of entries', (_name, extra) => {
    fails(emptyProject(), { op: 'outline.set', entries: [{ title: 'A', page: 0, depth: 0, ...extra }] }, 'E_OUTLINE');
  });

  it('refuses an id used twice', () => {
    const error = fails(emptyProject(), { op: 'outline.set', entries: [{ title: 'A', page: 0, depth: 0, id: 'x' }, { title: 'B', page: 1, depth: 0, id: 'x' }] }, 'E_OUTLINE');
    expect(error.message).toContain('"x"');
    expect(error.message).toContain('0 and 1');
  });

  it('adds an entry at the end or at a position, with an id of its own or a made one', () => {
    let project = apply(emptyProject(), { op: 'outline.add', title: 'Chapter 1', page: 0, depth: 0, id: 'c1', label: 'Chapter 1', top: 0.1 });
    project = apply(project, { op: 'outline.add', title: '1.2 Maps', page: 2, depth: 1, id: '1.2' });
    project = apply(project, { op: 'outline.add', title: '1.1 Sets', page: 1, depth: 1, label: '1.1', at: 1, autoId: true });
    expect(project.outline?.entries.map((entry) => `${entry.id}:${entry.title}`)).toEqual(['c1:Chapter 1', '1.1:1.1 Sets', '1.2:1.2 Maps']);
    expect(project.outline?.entries[0]).toMatchObject({ label: 'Chapter 1', top: 0.1 });
    const made = applyOperation(project, { op: 'outline.add', title: '2 Numbers', page: 3, depth: 0, autoId: true }, ctx);
    expect(made.notes.join(' ')).toContain('"2"');
    expect(made.project.outline?.entries.at(-1)?.id).toBe('2');
    const plain = apply(project, { op: 'outline.add', title: 'Plain', page: 4, depth: 0 });
    expect(plain.outline?.entries.at(-1)).toEqual({ title: 'Plain', page: 4, depth: 0 });
    expect(plain.outline?.source).toBe('manual');
  });

  it('refuses an entry that cannot be added', () => {
    const project = apply(emptyProject(), { op: 'outline.set', entries });
    fails(project, { op: 'outline.add', title: 'X', page: 0, id: '1.1' }, 'E_OUTLINE_ID_TAKEN');
    fails(project, { op: 'outline.add', title: 'X', page: 9 }, 'E_PAGE');
    fails(project, { op: 'outline.add', title: 'X', page: 0, at: 9 }, 'E_OUTLINE');
    fails(project, { op: 'outline.add', title: 'X', page: 0, id: 'a b' }, 'E_OUTLINE');
    fails(project, { op: 'outline.add', title: 'X', page: 0, top: 2 }, 'E_OUTLINE');
  });

  it('updates an entry by id or by position', () => {
    const project = apply(emptyProject(), { op: 'outline.set', entries });
    const changed = apply(project, { op: 'outline.update', id: '1.2', title: '1.2 Functions', page: 2, top: 0.5, label: '1.2a' }, { op: 'outline.update', index: 4, depth: 1, top: null, label: null });
    expect(changed.outline?.entries[2]).toEqual({ title: '1.2 Functions', page: 2, depth: 1, id: '1.2', label: '1.2a', top: 0.5 });
    expect(changed.outline?.entries[4]).toEqual({ title: '2.1 Integers', page: 3, depth: 1, id: '2.1' });
    expect(changed.outline?.source).toBe('manual');
    fails(project, { op: 'outline.update', id: 'nope', title: 'x' }, 'E_NO_SECTION');
    expect(fails(project, { op: 'outline.update', id: 'nope', title: 'x' }, 'E_NO_SECTION').hint).toContain('c1, 1.1, 1.2');
    fails(project, { op: 'outline.update', index: 9, title: 'x' }, 'E_NO_SECTION');
    fails(project, { op: 'outline.update', title: 'x' }, 'E_OUTLINE');
    fails(project, { op: 'outline.update', id: '1.1', index: 3, title: 'x' }, 'E_OUTLINE');
    fails(project, { op: 'outline.update', id: '1.1', title: '  ' }, 'E_OUTLINE');
    fails(project, { op: 'outline.update', id: '1.1', depth: 12 }, 'E_OUTLINE');
    fails(project, { op: 'outline.update', id: '1.1', page: 12 }, 'E_PAGE');
    fails(emptyProject(), { op: 'outline.update', id: '1.1', title: 'x' }, 'E_NO_SECTION');
  });

  it('renames an id and takes the exercises of the section along', () => {
    const project = apply(bookProject(), add({ label: '1' }), add({ label: '2', rect: [0.1, 0.5, 0.9, 0.6] }), add({ label: '1', section: '1.2', page: 1 }));
    const result = applyOperation(project, { op: 'outline.update', id: '1.1', newId: 'sets' }, ctx);
    expect(result.project.frames.map((entry) => entry.section)).toEqual(['sets', 'sets', '1.2']);
    expect(result.project.outline?.entries[1]?.id).toBe('sets');
    expect(result.notes.join(' ')).toContain('The 2 exercises of section "1.1" now name "sets"');
    expect(errorsOf(result.project)).toEqual([]);
    fails(project, { op: 'outline.update', id: '1.1', newId: '1.2' }, 'E_OUTLINE_ID_TAKEN');
    fails(project, { op: 'outline.update', id: '1.1', newId: 'a b' }, 'E_OUTLINE');
    const anonymous = applyOperation(project, { op: 'outline.update', id: 'c2', newId: null }, ctx);
    expect(anonymous.project.outline?.entries[3]?.id).toBeUndefined();
    const error = fails(project, { op: 'outline.update', id: '1.1', newId: null }, 'E_SECTION_IN_USE');
    expect(error.message).toContain('2 exercises');
    expect(error.hint).toContain('--new-id');
  });

  it('deletes an entry and lifts what is below it, or deletes the subtree', () => {
    const project = apply(emptyProject(), { op: 'outline.set', entries });
    const lifted = applyOperation(project, { op: 'outline.delete', id: 'c1' }, ctx);
    expect(lifted.project.outline?.entries.map((entry) => `${entry.id}:${entry.depth}`)).toEqual(['1.1:0', '1.2:0', 'c2:0', '2.1:1']);
    expect(lifted.notes.join(' ')).toContain('2 entries below it moved up one level');
    const subtree = apply(project, { op: 'outline.delete', id: 'c1', subtree: true });
    expect(subtree.outline?.entries.map((entry) => entry.id)).toEqual(['c2', '2.1']);
    expect(apply(project, { op: 'outline.delete', index: 4 }).outline?.entries).toHaveLength(4);
    fails(project, { op: 'outline.delete', id: 'nope' }, 'E_NO_SECTION');
    fails(project, { op: 'outline.delete' }, 'E_OUTLINE');
  });

  it('will not delete a section that exercises are filed under', () => {
    const project = apply(bookProject(), add({ label: '1' }));
    const error = fails(project, { op: 'outline.delete', id: '1.1' }, 'E_SECTION_IN_USE');
    expect(error.message).toContain('1 exercise is filed under the section "1.1"');
    expect(error.hint).toContain('exercises section');
    fails(project, { op: 'outline.delete', id: 'c1', subtree: true }, 'E_SECTION_IN_USE');
    expect(apply(project, { op: 'section.set', id: 'f1', section: '1.2' }, { op: 'outline.delete', id: '1.1' }).outline?.entries.some((entry) => entry.id === '1.1')).toBe(false);
    expect(apply(project, { op: 'outline.delete', id: '1.2' }).outline?.entries).toHaveLength(4);
  });

  it('gives every entry an id', () => {
    const plain = apply(emptyProject(), { op: 'outline.set', source: 'pdf', entries: [{ title: '1 Sets', page: 0, depth: 0 }, { title: '1.1 Basics', page: 0, depth: 1, label: '1.1' }, { title: 'Appendix', page: 2, depth: 0, id: 'app' }] });
    const result = applyOperation(plain, { op: 'outline.ids' }, ctx);
    expect(result.project.outline?.entries.map((entry) => entry.id)).toEqual(['1', '1.1', 'app']);
    expect(result.project.outline?.source).toBe('pdf');
    expect(result.notes.join(' ')).toContain('Gave 2 entries an id');
    expect(applyOperation(result.project, { op: 'outline.ids' }, ctx).notes).toEqual(['Every outline entry already has an id.']);
    fails(emptyProject(), { op: 'outline.ids' }, 'E_OUTLINE');
  });
});

describe('the document info of the project', () => {
  const info: Operation = {
    op: 'meta.set',
    author: ' A. Author ',
    series: 'Prerequisites',
    description: 'A short book.',
    notice: 'Attribution: A. Author.',
    sourceUrl: 'https://example.org/the-book',
    license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  };

  it('is set, trimmed, and kept next to the title and folder', () => {
    const project = apply(emptyProject(), { op: 'meta.set', title: 'Pre-Algebra', folder: 'Books/Algebra' }, info);
    expect(project.meta).toEqual({
      title: 'Pre-Algebra',
      folder: 'Books/Algebra',
      author: 'A. Author',
      series: 'Prerequisites',
      description: 'A short book.',
      notice: 'Attribution: A. Author.',
      sourceUrl: 'https://example.org/the-book',
      license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
    });
  });

  it('leaves what it is not told about, and removes a field given null or an empty text', () => {
    const project = apply(emptyProject(), info);
    const changed = apply(project, { op: 'meta.set', author: 'B. Author', series: null, description: '', license: null });
    expect(changed.meta).toMatchObject({ author: 'B. Author', notice: 'Attribution: A. Author.', sourceUrl: 'https://example.org/the-book' });
    expect(changed.meta).not.toHaveProperty('series');
    expect(changed.meta).not.toHaveProperty('description');
    expect(changed.meta).not.toHaveProperty('license');
    expect(apply(project, { op: 'meta.set', license: { name: 'MIT', url: null } }).meta.license).toEqual({ name: 'MIT' });
    expect(apply(project, { op: 'meta.set', title: 'Other' }).meta).toMatchObject({ title: 'Other', author: 'A. Author' });
  });

  it('refuses what a bundle could not carry, naming the field', () => {
    for (const [op, text] of [
      [{ op: 'meta.set', sourceUrl: 'example.org' }, 'meta.sourceUrl'],
      [{ op: 'meta.set', author: 'x'.repeat(201) }, 'meta.author'],
      [{ op: 'meta.set', notice: 'x'.repeat(4001) }, 'meta.notice'],
      [{ op: 'meta.set', license: { name: 'x'.repeat(101) } }, 'license.name'],
      [{ op: 'meta.set', license: { name: 'MIT', url: 'ftp://x.org/a' } }, 'license.url'],
    ] as [Operation, string][]) {
      const error = fails(emptyProject(), op, 'E_META');
      expect(error.message).toContain(text);
      expect(error.hint?.length ?? 0).toBeGreaterThan(5);
    }
    fails(emptyProject(), { op: 'meta.set', license: { url: 'https://x.org' } as unknown as { name: string } }, 'E_META');
  });
});

describe('a batch', () => {
  it('is atomic: a failure late in the batch changes nothing, and names the operation', () => {
    const project = bookProject();
    let thrown: McPrepError | undefined;
    try {
      applyOperations(project, [add({ label: '1' }), add({ label: '2', rect: [0.1, 0.5, 0.9, 0.6] }), add({ label: 'bad*' })], ctx);
    } catch (error) {
      thrown = error as McPrepError;
    }
    expect(thrown?.code).toBe('E_LABEL');
    expect(thrown?.message).toContain('Operation 2 (add)');
    expect(project.frames).toEqual([]);
  });

  it('keeps generated ids away from the ids a project and a batch already use', () => {
    const project = { ...bookProject([ordinary('f5', 0, 0.1, 0.2), ordinary('u7x', 0, 0.3, 0.4, { unit: 'u9' })]), seq: 0 };
    const result = applyOperations(project, [{ op: 'add', kind: 'bookmark', page: 0, rect: [0.1, 0.6, 0.9, 0.7] }, { op: 'add', kind: 'bookmark', id: 'f9', page: 0, rect: [0.1, 0.7, 0.9, 0.8] }, { op: 'add', kind: 'bookmark', page: 0, rect: [0.1, 0.8, 0.9, 0.9] }], ctx);
    expect(result.created).toEqual(['f10', 'f9', 'f11']);
    expect(new Set(result.project.frames.map((entry) => entry.id)).size).toBe(result.project.frames.length);
    const unit = applyOperations(project, [{ op: 'add', kind: 'exercise', unit: 'u20', page: 0, rect: [0.1, 0.6, 0.9, 0.7] }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.7, 0.9, 0.8] }], ctx);
    expect(unit.created).toEqual(['f10', 'f21']);
  });

  it('adds a thousand exercises without slowing down', () => {
    const operations: Operation[] = [];
    for (let i = 0; i < 1000; i += 1) operations.push({ op: 'add', authority: 'book', label: String(i + 1), section: '1.1', page: i % 6, rect: [0.1, 0.01 * (i % 90) + 0.05, 0.9, 0.01 * (i % 90) + 0.06] });
    const started = performance.now();
    const result = applyOperations(bookProject(), operations, ctx);
    expect(result.created).toHaveLength(1000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
