import { beforeAll, describe, expect, it } from 'vitest';
import { McPrepError, PdfDocument, applyOperations, newProject, type Frame, type Operation, type PageText, type Project } from '@mcprep/core';
import type { AuthoritySample } from '@mcprep/core/testing';
import { checkBookLabel, compareLabels, newestOf, nextFreeLabel, successorLabel, suggestFor, suggestLabel } from '../src/renderer/logic/book.js';
import { NO_PARTS_REASON, guiFix, plainError } from '../src/renderer/logic/errors.js';
import { placeChips } from '../src/renderer/logic/labels.js';
import { bookModel, entryOfSection, frameIndex, labelOf, pageContent, sectionChoices } from '../src/renderer/logic/model.js';
import { Store } from '../src/renderer/logic/store.js';
import { fakeApi, openedDocument } from './helpers/fake-api.js';

let authority: AuthoritySample;
let texts: PageText[];

beforeAll(async () => {
  const built = await import('@mcprep/core/testing');
  authority = built.buildAuthoritySample();
  const pdf = await PdfDocument.fromBytes(authority.pdf);
  texts = await pdf.allPageText({ fonts: true, ink: true });
  await pdf.close();
});

/** The synthetic workbook: its sections as the outline and, when asked, every printed exercise as a book exercise. */
function workbook(options: { outline?: boolean; exercises?: boolean } = {}): Project {
  const base = newProject({ pdf: { path: 'workbook.pdf', sha256: 'c'.repeat(64), bytes: 5553, pageCount: 4 }, title: 'Pre-Algebra Workbook', now: new Date('2026-10-04T12:00:00Z') });
  const operations: Operation[] = [];
  if (options.outline !== false) operations.push({ op: 'outline.set', entries: authority.sections, source: 'manual' });
  if (options.exercises === true) {
    for (const exercise of authority.exercises) {
      operations.push({
        op: 'add',
        authority: 'book',
        label: exercise.label,
        section: exercise.section,
        page: exercise.page,
        rect: exercise.rect,
        ...(exercise.context ? { context: exercise.context } : {}),
        ...(exercise.continues ? { continues: exercise.continues } : {}),
        solution: exercise.solution,
      });
    }
  }
  return applyOperations(base, operations, { pageCount: 4 }).project;
}

async function started(project: Project = workbook()): Promise<{ store: Store; api: ReturnType<typeof fakeApi> }> {
  const api = fakeApi({ pdf: () => authority.pdf, texts: () => texts, fresh: () => project });
  const store = new Store(api);
  await store.openDocument(openedDocument(project, 4, authority.pdfOutline));
  return { store, api };
}

const row = (top: number, left = 0.1, height = 0.02) => ({ left, top, right: left + 0.8, bottom: top + height });

describe('the printed numbers of a book', () => {
  it('counts the way a book does: previous + 1, 5b after 5a', () => {
    const cases: [string, string | undefined][] = [
      ['1', '2'],
      ['9', '10'],
      ['09', '10'],
      ['009', '010'],
      ['5a', '5b'],
      ['12b', '12c'],
      ['5z', '6'],
      ['5A', '5B'],
      ['5(a)', '5(b)'],
      ['5(z)', '6'],
      ['A.3', 'A.4'],
      ['A.9', 'A.10'],
      ['3.1', '3.2'],
      ['II-4', 'II-5'],
      ['Review 3', 'Review 4'],
      ['B2', 'B3'],
      ['a', 'b'],
      ['Z', undefined],
      ['Review', undefined],
    ];
    for (const [label, next] of cases) expect(successorLabel(label), label).toBe(next);
  });

  it('puts labels in the order a book counts them', () => {
    const sorted = ['10', '2', '1', '3b', '3a', 'A.10', 'A.2', '20', '3'].sort(compareLabels);
    expect(sorted).toEqual(['1', '2', '3', '3a', '3b', '10', '20', 'A.2', 'A.10']);
  });

  it('skips labels that are taken and starts at 1', () => {
    expect(nextFreeLabel(new Set(), undefined)).toBe('1');
    expect(nextFreeLabel(new Set(['1']), undefined)).toBe('2');
    expect(nextFreeLabel(new Set(['1', '2', '3']), '3')).toBe('4');
    expect(nextFreeLabel(new Set(['4', '5']), '3')).toBe('6');
    expect(nextFreeLabel(new Set(), 'Review')).toBe('1');
    expect(nextFreeLabel(new Set(['5b']), '5a')).toBe('5c');
  });

  it('takes the exercise drawn last as the previous one (the highest generated id), else the last label', () => {
    const frame = (id: string, label: string): Frame => ({ id, kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.1, right: 0.5, bottom: 0.2 }, authority: 'book', label, section: 's' });
    expect(newestOf([frame('f3', '3a'), frame('f10', '1'), frame('f2', '9')])?.label).toBe('1');
    expect(newestOf([frame('a', '10'), frame('b', '2')])?.label).toBe('10');
    expect(newestOf([])).toBeUndefined();
  });

  it('suggests the section at a place of the page and the next number in it', () => {
    const empty = workbook();
    const model = bookModel(empty.frames, empty.outline?.entries, 4);
    expect(suggestFor(model, 0, 0.34)).toEqual({ section: '1.1', label: '1' });
    expect(suggestFor(model, 1, 0.2)).toEqual({ section: '1.2', label: '1' });
    expect(suggestFor(model, 2, 0.5)).toEqual({ section: '2.1', label: '1' });
    // Before the first heading there is no section: the form says so.
    expect(suggestFor(model, 0, 0.01).section).toBeUndefined();
    expect(suggestFor(model, 0, 0.01).noSection).toContain('Choose one');

    const full = workbook({ exercises: true });
    const filled = bookModel(full.frames, full.outline?.entries, 4);
    expect(suggestFor(filled, 0, 0.5)).toEqual({ section: '1.1', label: '3c' });
    expect(suggestFor(filled, 1, 0.9)).toEqual({ section: '1.2', label: '5' });
    expect(suggestLabel(filled, '2.1')).toBe('3');
    // The exercise being changed does not count against its own number.
    const four = full.frames.find((frame) => frame.section === '1.2' && frame.label === '4') as Frame;
    expect(suggestLabel(filled, '1.2', four.id)).toBe('4');
  });

  it('says what is wrong with a number or a section in plain words', () => {
    const full = workbook({ exercises: true });
    const model = bookModel(full.frames, full.outline?.entries, 4);
    expect(checkBookLabel(model, '', '1.1').problem).toContain('exactly as the book prints');
    expect(checkBookLabel(model, 'x'.repeat(30), '1.1').problem).toContain('1 to 24 characters');
    expect(checkBookLabel(model, '5#', '1.1').problem).toContain('cannot be a number');
    expect(checkBookLabel(model, '5', undefined).problem).toBe('Choose the section the exercise belongs to.');
    expect(checkBookLabel(model, '5', 'nope').problem).toContain('not in the Sections list');
    expect(checkBookLabel(model, '3a', '1.1').problem).toMatch(/Section 1\.1 already has an exercise 3a \(f\d+\)/);
    expect(checkBookLabel(model, '3a', '1.2')).toEqual({ label: '3a' });
    // The closing "." the book prints is not part of the number.
    expect(checkBookLabel(model, '  7.  ', '1.1')).toEqual({ label: '7' });
    const own = full.frames.find((frame) => frame.section === '1.1' && frame.label === '3a') as Frame;
    expect(checkBookLabel(model, '3a', '1.1', own.id)).toEqual({ label: '3a' });
  });
});

describe('what the panels know about a project', () => {
  it('names a book exercise by its printed number and numbers only what a person framed', () => {
    const project = workbook({ exercises: true });
    const ordinary: Frame = { id: 'f90', kind: 'exercise', page: 2, rect: { left: 0.1, top: 0.6, right: 0.9, bottom: 0.65 } };
    const frames = [...project.frames, ordinary];
    const index = frameIndex(frames);
    expect(index.book).toHaveLength(10);
    expect(index.bookWithSolution).toBe(10);
    expect(index.counts).toEqual({ exercise: 1, question: 0, bookmark: 0 });
    const threeA = frames.find((frame) => frame.label === '3a') as Frame;
    expect(labelOf(index, threeA)).toBe('3a');
    expect(labelOf(index, ordinary)).toBe('E1');
    expect(index.numbers.has(threeA.id)).toBe(false);
    expect(frameIndex(frames)).toBe(index);
    expect(frameIndex([...frames])).not.toBe(index);
  });

  it('collects what is drawn on each page: frames, continuations, context and solutions', () => {
    const project = workbook({ exercises: true });
    const index = frameIndex(project.frames);
    expect(pageContent(index, 0).frames).toHaveLength(4);
    expect(pageContent(index, 0).context).toHaveLength(2);
    expect(pageContent(index, 2).continues).toHaveLength(1);
    expect(pageContent(index, 3).solution).toHaveLength(10);
    expect(pageContent(index, 3).frames).toHaveLength(0);
    expect(index.perPage.get(0)).toBe(4);
    expect(pageContent(index, 9).frames).toEqual([]);
  });

  it('files the book exercises under their sections in the order a book counts, and counts them per subtree', () => {
    const project = workbook({ exercises: true });
    const model = bookModel(project.frames, project.outline?.entries, 4);
    expect(model.groups.get('1.1')?.map((frame) => frame.label)).toEqual(['1', '2', '3a', '3b']);
    expect(model.groups.get('1.2')?.map((frame) => frame.label)).toEqual(['1', '2', '3', '4']);
    const chapterOne = model.counts.perNode[model.tree.byId.get('c1') as number];
    expect(chapterOne).toMatchObject({ exercises: 0, exercisesTotal: 8, withSolutionTotal: 8 });
    expect(model.unplaced).toEqual([]);
    expect(model.withoutId).toBe(0);
    expect(bookModel(project.frames, project.outline?.entries, 4)).toBe(model);
    expect(entryOfSection(model, '1.2')?.title).toBe('1.2 Subtracting integers');
    expect(entryOfSection(model, 'nope')).toBeUndefined();
  });

  it('reports exercises filed under a section that is not in the outline, and entries without an id', () => {
    const project = workbook({ exercises: true });
    const entries = (project.outline?.entries ?? []).map((entry) => (entry.id === '2.1' ? { title: entry.title, page: entry.page, depth: entry.depth } : entry));
    const model = bookModel(project.frames, entries, 4);
    expect(model.unplaced.map((frame) => `${frame.section}:${frame.label}`)).toEqual(['2.1:1', '2.1:2']);
    expect(model.withoutId).toBe(1);
  });

  it('offers a menu of the sections that have an id, indented by depth', () => {
    const project = workbook();
    const choices = sectionChoices(bookModel(project.frames, project.outline?.entries, 4));
    expect(choices.map((choice) => choice.id)).toEqual(['c1', '1.1', '1.2', 'c2', '2.1', 'answers']);
    expect(choices[0]?.text).toBe('Chapter 1 Integers (c1)');
    expect(choices[1]?.text.startsWith('  ')).toBe(true);
  });
});

describe('the labels on a crowded page', () => {
  /** Two columns of 22 small frames each, as on a practice page. */
  const crowded = (height: number, pitch: number) => {
    const items = [];
    for (let column = 0; column < 2; column += 1) {
      for (let r = 0; r < 22; r += 1) items.push({ id: `c${column}r${r}`, label: String(column * 22 + r + 1), rect: row(0.07 + r * pitch, column === 0 ? 0.07 : 0.53, height) });
    }
    return items;
  };
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('puts each label beside its frame, in the free space, and readable', () => {
    const items = crowded(0.0345, 0.039).map((item) => ({ ...item, rect: { ...item.rect, right: item.rect.left + 0.4 } }));
    const box = { width: 892, height: 1263 };
    const chips = placeChips(items, box);
    expect(chips.size).toBe(44);
    for (const chip of chips.values()) {
      expect(chip.side).toBe('left');
      expect(chip.h).toBeGreaterThanOrEqual(11);
      expect(chip.x).toBeGreaterThanOrEqual(0);
      expect(chip.x + chip.w).toBeLessThanOrEqual(box.width);
    }
    const list = [...chips.values()];
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) expect(overlap(list[i] as never, list[j] as never)).toBe(false);
    // The labels of the right-hand column sit in the gutter, not on top of the left-hand column.
    const rightChip = chips.get('c1r3');
    const leftFrameRight = 0.47 * box.width;
    expect(rightChip && rightChip.x >= leftFrameRight).toBe(true);
  });

  it('makes the labels as small as the frames require, but never below 11 pixels, and never lets them pile up', () => {
    const items = crowded(0.011, 0.0125).map((item) => ({ ...item, rect: { ...item.rect, right: item.rect.left + 0.4 } }));
    const chips = placeChips(items, { width: 892, height: 1263 });
    const list = [...chips.values()];
    expect(Math.min(...list.map((chip) => chip.h))).toBeGreaterThanOrEqual(11);
    expect(Math.max(...list.map((chip) => chip.h))).toBeLessThanOrEqual(18);
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) expect(overlap(list[i] as never, list[j] as never)).toBe(false);
  });

  it('goes to the right, or inside the frame, when there is no room on the left', () => {
    const box = { width: 400, height: 600 };
    const wide = placeChips([{ id: 'a', label: 'A.12(a)', rect: { left: 0.02, top: 0.2, right: 0.6, bottom: 0.25 } }], box).get('a');
    expect(wide?.side).toBe('right');
    const full = placeChips([{ id: 'b', label: 'A.12(a)', rect: { left: 0.01, top: 0.2, right: 0.99, bottom: 0.25 } }], box).get('b');
    expect(full?.side).toBe('inside');
    expect(full && full.x >= 0.01 * box.width).toBe(true);
  });
});

describe('plain words for the core\'s refusals', () => {
  it('drops the step a batch names and the commands the core suggests', () => {
    const error = new McPrepError('E_OTHER', 'Operation 0 (add): Something is wrong with `mcprep frames list`.', { hint: 'Run `mcprep validate`.' });
    expect(plainError(error)).not.toMatch(/Operation 0|mcprep|`/);
    expect(plainError(new McPrepError('E_LABEL', 'The label "x" is not valid.', { hint: 'Write the number as the book prints it.' }))).toBe('The label "x" is not valid. Write the number as the book prints it.');
    expect(plainError(new McPrepError('E_AUTHORITY_UNIT', 'f1 is a part of the unit u1.', { hint: 'Merge the parts first (`mcprep frames merge`).' }))).toContain('Join its parts first');
    expect(plainError(new Error('disk full'))).toBe('disk full');
  });

  it('explains the rules about books on the screen, not on the command line', () => {
    const fix = guiFix({ severity: 'error', code: 'duplicate-exercise', message: 'x', fix: 'Run `mcprep exercises label f1 <label>`.' });
    expect(fix).toContain('own number');
    expect(guiFix({ severity: 'warning', code: 'clips-line', message: 'm', fix: 'Move the edge.' })).toBe('Move the edge.');
  });
});

describe('the store: two kinds of exercise', () => {
  it('draws a book exercise: the form offers the section and the next number, and the exercise is filed under it', async () => {
    const { store } = await started();
    store.setTool('book');
    store.startDraft(0, row(0.33));
    expect(store.state.draft).toMatchObject({ section: '1.1', label: '1', error: null });
    expect(store.nextLabelIn('1.2')).toBe('1');
    expect(store.confirmDraft('1', '1.1')).toBe(true);
    expect(store.state.draft).toBeNull();
    const first = store.state.project?.frames[0] as Frame;
    expect(first).toMatchObject({ kind: 'exercise', authority: 'book', label: '1', section: '1.1', page: 0 });
    expect(store.state.selection).toBe(first.id);
    expect(store.state.dirty).toBe(true);
    // The next one in the same section is offered the next number.
    store.startDraft(0, row(0.37));
    expect(store.state.draft).toMatchObject({ section: '1.1', label: '2' });
    expect(store.confirmDraft('2.', '1.1')).toBe(true);
    expect(store.state.project?.frames.map((frame) => frame.label).sort()).toEqual(['1', '2']);
    // And after 5a comes 5b.
    store.startDraft(0, row(0.41));
    expect(store.confirmDraft('5a', '1.1')).toBe(true);
    store.startDraft(0, row(0.45));
    expect(store.state.draft?.label).toBe('5b');
    // Undo takes back the last exercise added and drops a form that is still open.
    store.undo();
    expect(store.state.draft).toBeNull();
    expect(store.state.project?.frames.map((frame) => frame.label).sort()).toEqual(['1', '2']);
  });

  it('drops a drawn exercise that is waiting for its number when another page is shown', async () => {
    const { store } = await started();
    store.startDraft(0, row(0.33));
    store.setPage(0);
    expect(store.state.draft).not.toBeNull();
    store.setPage(1);
    expect(store.state.draft).toBeNull();
  });

  it('keeps the form open and says what is wrong, in plain words, when the exercise cannot be filed', async () => {
    const { store } = await started(workbook({ exercises: true }));
    store.startDraft(0, row(0.5));
    expect(store.confirmDraft('', '1.1')).toBe(false);
    expect(store.state.draft?.error).toContain('exactly as the book prints');
    expect(store.confirmDraft('3a', '1.1')).toBe(false);
    expect(store.state.draft?.error).toMatch(/already has an exercise 3a/);
    expect(store.confirmDraft('9', undefined)).toBe(false);
    expect(store.state.draft?.error).toBe('Choose the section the exercise belongs to.');
    expect(store.state.project?.frames).toHaveLength(10);
    expect(store.state.notice).toBeNull();
    store.cancelDraft();
    expect(store.state.draft).toBeNull();
  });

  it('offers no section where the book has none, and says how to get one', async () => {
    const { store } = await started(workbook({ outline: false }));
    store.startDraft(0, row(0.33));
    expect(store.state.draft?.section).toBeUndefined();
    expect(store.state.draft?.note).toContain('no sections yet');
    expect(store.confirmDraft('1', undefined)).toBe(false);
    const adopted = store.adoptPdfOutline();
    expect(adopted.ok).toBe(true);
    expect(store.state.project?.outline?.entries.every((entry) => entry.id !== undefined)).toBe(true);
  });

  it('tells a frame of the book from one a person framed: no positional number, and back again', async () => {
    const { store } = await started();
    store.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.33, 0.9, 0.35] }, { op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.37, 0.9, 0.39] }], { select: null });
    const [a, b] = store.state.project?.frames as [Frame, Frame];
    expect(frameIndex(store.state.project?.frames ?? []).numbers.get(a.id)?.label).toBe('E1');

    const marked = store.markAsBook(a.id, '5a', '1.1');
    expect(marked.ok).toBe(true);
    expect(store.state.notice?.text).toContain('is now the exercise 1.1:5a');
    const index = frameIndex(store.state.project?.frames ?? []);
    expect(index.numbers.has(a.id)).toBe(false);
    expect(index.numbers.get(b.id)?.label).toBe('E1');
    expect(labelOf(index, store.selected() ?? a)).toBeDefined();

    expect(store.markAsBook(a.id, '6', '1.1').ok).toBe(false);
    const clash = store.markAsBook(b.id, '5a', '1.1');
    expect(clash.ok).toBe(false);
    expect(clash.error).toMatch(/already has an exercise 5a/);

    const back = store.unmark(a.id);
    expect(back.ok).toBe(true);
    expect(frameIndex(store.state.project?.frames ?? []).numbers.get(a.id)?.label).toBe('E1');
    expect(store.state.project?.frames.find((frame) => frame.id === a.id)?.authority).toBeUndefined();
    expect(store.unmark(a.id).error).toContain('is not an authoritative exercise');
  });

  it('refuses to make a part of an exercise a book exercise, and explains', async () => {
    const { store } = await started();
    store.apply([{ op: 'add', ref: 'x', kind: 'exercise', page: 0, rect: [0.1, 0.33, 0.9, 0.45] }, { op: 'split', id: '@x', at: [0.39] }], { select: null });
    const part = store.state.project?.frames[0] as Frame;
    const refused = store.markAsBook(part.id, '1', '1.1');
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/single exercise|has parts/);
    expect(store.state.project?.frames.every((frame) => frame.authority === undefined)).toBe(true);
    // Joining the parts makes it a single exercise, which can be marked.
    expect(store.joinParts(part.unit as string).ok).toBe(true);
    const single = store.state.project?.frames[0] as Frame;
    expect(store.markAsBook(single.id, '1', '1.1').ok).toBe(true);
  });

  it('does not cut a book exercise into parts, whatever asks: the tool, the card or an operation', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const book = store.state.project?.frames[0] as Frame;
    const cut = store.cutIntoParts(book.id);
    expect(cut).toEqual({ ok: false, created: [], notes: [], error: NO_PARTS_REASON });
    const split = store.apply([{ op: 'split', id: book.id, at: [(book.rect.top + book.rect.bottom) / 2] }], { quiet: true });
    expect(split.ok).toBe(false);
    expect(split.error).toContain('authoritative exercise');
    expect(split.error).not.toMatch(/`|mcprep/);
    expect(store.apply([{ op: 'area', id: book.id, rect: [0.1, 0.1, 0.9, 0.2] }], { quiet: true }).ok).toBe(false);
    expect(store.state.project?.frames.filter((frame) => frame.unit !== undefined)).toHaveLength(0);
  });

  it('cuts an exercise a person framed into parts where the markers are, and joins them again', async () => {
    const { store } = await started(workbook());
    store.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.405, 0.9, 0.47] }], { select: 'created' });
    const frame = store.state.project?.frames[0] as Frame;
    const result = store.cutIntoParts(frame.id);
    expect(result.ok).toBe(true);
    expect(store.state.project?.frames.filter((entry) => entry.unit !== undefined).length).toBeGreaterThanOrEqual(2);
    const unit = store.state.project?.frames[0]?.unit as string;
    expect(store.joinParts(unit).ok).toBe(true);
    expect(store.state.project?.frames).toHaveLength(1);
  });

  it('changes the number and the section of a book exercise, refusing a clash or a missing section in plain words', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const one = store.state.project?.frames.find((frame) => frame.section === '1.1' && frame.label === '1') as Frame;
    expect(store.setBookLabel(one.id, '3a').error).toMatch(/Section 1\.1 already has an exercise 3a/);
    expect(store.setBookLabel(one.id, '1').ok).toBe(true);
    expect(store.setBookLabel(one.id, '1b').ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === one.id)?.label).toBe('1b');
    expect(store.setBookSection(one.id, 'nope').error).toContain('not in the Sections list');
    expect(store.setBookSection(one.id, '2.1').ok).toBe(true);
    expect(store.setBookSection(one.id, '2.1').ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === one.id)?.section).toBe('2.1');
    const clash = store.state.project?.frames.find((frame) => frame.section === '2.1' && frame.label === '2') as Frame;
    expect(store.setBookLabel(one.id, clash.label as string).error).toContain('already has');
  });

  it('attaches context to a book exercise and to an ordinary one alike', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const book = store.state.project?.frames.find((frame) => frame.section === '1.2' && frame.label === '1') as Frame;
    expect(store.addRegion('context', book.id, 1, { left: 0.1, top: 0.1, right: 0.9, bottom: 0.12 }).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.context).toHaveLength(1);
    store.apply([{ op: 'add', kind: 'exercise', page: 2, rect: [0.1, 0.5, 0.9, 0.55] }], { select: 'created' });
    const ordinary = store.selected() as Frame;
    expect(store.addRegion('context', ordinary.id, 2, { left: 0.1, top: 0.4, right: 0.9, bottom: 0.45 }).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === ordinary.id)?.context).toHaveLength(1);
    expect(store.removeRegion('context', book.id, 0).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.context).toBeUndefined();
  });
});

describe('the store: solutions, hidden from the learner', () => {
  const key = (n: number) => ({ left: 0.1, top: 0.17 + n * 0.02, right: 0.5, bottom: 0.19 + n * 0.02 });

  it('attaches a region of any page of the PDF to an exercise as its solution, and takes it away again', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const book = store.state.project?.frames.find((frame) => frame.section === '1.1' && frame.label === '1') as Frame;
    // The workbook already has one solution for each exercise: add a second (an answer printed on two lines of the key).
    expect(store.addRegion('solution', book.id, 3, key(5)).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.solution).toHaveLength(2);
    expect(store.state.dirty).toBe(true);
    expect(frameIndex(store.state.project?.frames ?? []).pages.get(3)?.solution.filter((region) => region.frame.id === book.id)).toHaveLength(2);
    expect(store.removeRegion('solution', book.id, 1).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.solution).toHaveLength(1);
    expect(store.removeRegion('solution', book.id, 0).ok).toBe(true);
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.solution).toBeUndefined();
    expect(store.removeRegion('solution', book.id, 0).error).toContain('no solution regions');
    // One undo brings the last one back.
    store.undo();
    expect(store.state.project?.frames.find((frame) => frame.id === book.id)?.solution).toHaveLength(1);
  });

  it('works for an ordinary exercise too, but not for a question, and says why in plain words', async () => {
    const { store } = await started(workbook());
    store.apply([{ op: 'add', kind: 'exercise', page: 0, rect: [0.1, 0.33, 0.9, 0.35] }, { op: 'add', kind: 'question', page: 0, rect: [0.1, 0.5, 0.9, 0.52] }], { select: null });
    const [exercise, question] = store.state.project?.frames as [Frame, Frame];
    expect(store.addRegion('solution', exercise.id, 3, key(0)).ok).toBe(true);
    const refused = store.addRegion('solution', question.id, 3, key(1));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe(`Only exercises can have a solution; ${question.id} is a question.`);
    expect(store.state.notice).toMatchObject({ kind: 'error' });
  });

  it('allows at most eight regions and says so', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const book = store.state.project?.frames[0] as Frame;
    for (let n = 1; n < 8; n += 1) expect(store.addRegion('solution', book.id, 3, key(n)).ok).toBe(true);
    const ninth = store.addRegion('solution', book.id, 3, key(9));
    expect(ninth.ok).toBe(false);
    expect(ninth.error).toContain('at most 8');
  });

  it('shows a region on its page and marks it for a moment', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const book = store.state.project?.frames[0] as Frame;
    const region = book.solution?.[0] as { page: number; rect: Frame['rect'] };
    store.showRegion(region.page, region.rect);
    expect(store.state.page).toBe(3);
    expect(store.state.focus).toMatchObject({ page: 3, region: region.rect });
    expect(store.state.focus.until).toBeGreaterThan(Date.now());
    store.showPlace(1, 0.1);
    expect(store.state.focus).toMatchObject({ page: 1, y: 0.1 });
    expect(store.state.page).toBe(1);
  });

  it('counts the exercises that have a solution, so that the ones without are known', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const index = frameIndex(store.state.project?.frames ?? []);
    expect(index.bookWithSolution).toBe(10);
    const book = store.state.project?.frames[0] as Frame;
    store.removeRegion('solution', book.id, 0);
    const after = frameIndex(store.state.project?.frames ?? []);
    expect(after.bookWithSolution).toBe(9);
    expect(store.state.validation?.book).toEqual({ exercises: 10, withSolution: 9 });
  });
});

