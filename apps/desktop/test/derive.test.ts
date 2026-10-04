import { beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, applyOperations, deriveSections, newProject, toOutlineEntries, validateProject, type BookStructure, type Operation, type OutlineEntry, type PageText, type Project } from '@mcprep/core';
import type { Api, AuditOutcome } from '../src/shared/api.js';
import { compareOutline, confidenceLevel, defaultSelection, describeOutcome, differences, filterRows, inWindowPages, resolveDerive, UNSURE_BELOW, type DeriveChoices } from '../src/renderer/logic/derive.js';
import { bookModel } from '../src/renderer/logic/model.js';
import { Store } from '../src/renderer/logic/store.js';
import { fakeApi, openedDocument } from './helpers/fake-api.js';

/**
 * Deriving the sections of a book in the window: what is new, different or the same compared with the outline the project
 * has; what taking some or all of them does to the outline and, above all, to the exercises filed under it; and the flow in
 * the store (progress, stopping, review, one undoable step). The book is the synthetic textbook of the core's tests.
 */

let pdfBytes: Uint8Array;
let pages: PageText[];
let structure: BookStructure;

beforeAll(async () => {
  const built = await import('@mcprep/core/testing');
  const book = built.buildSyntheticBook();
  pdfBytes = book.pdf;
  const pdf = await PdfDocument.fromBytes(pdfBytes);
  pages = await pdf.allPageText({ fonts: true });
  await pdf.close();
  structure = deriveSections(pages);
});

const ids = (entries: readonly OutlineEntry[] | undefined): (string | undefined)[] => (entries ?? []).map((entry) => entry.id);
const derivedEntries = (): OutlineEntry[] => toOutlineEntries(structure);

/** A project of the book with these sections and these book exercises (a few lines each, one under the other). */
function bookProject(entries: OutlineEntry[] | undefined, exercises: { section: string; label: string; page?: number }[] = []): Project {
  const base = newProject({ pdf: { path: 'book.pdf', sha256: 'd'.repeat(64), bytes: pdfBytes.length, pageCount: pages.length }, title: 'Algebra', now: new Date('2026-10-04T12:00:00Z') });
  const operations: Operation[] = [];
  if (entries !== undefined) operations.push({ op: 'outline.set', entries, source: 'manual' });
  exercises.forEach((exercise, at) => {
    const top = 0.1 + 0.04 * (at % 20);
    operations.push({ op: 'add', authority: 'book', label: exercise.label, section: exercise.section, page: exercise.page ?? 5 + Math.floor(at / 20), rect: { left: 0.1, top, right: 0.9, bottom: top + 0.03 } });
  });
  return applyOperations(base, operations, { pageCount: pages.length }).project;
}

const inputOf = (project: Project) => ({ structure, entries: project.outline?.entries ?? [], groups: bookModel(project.frames, project.outline?.entries, pages.length).groups });

const choose = (selected: Iterable<string>, rest: Partial<DeriveChoices> = {}): DeriveChoices => ({ selected: new Set(selected), keepOthers: false, moves: {}, ...rest });
const everyId = (): string[] => structure.entries.map((entry) => entry.id);

describe('the synthetic textbook, as the search reads it', () => {
  it('finds two chapters, four sections and the answers', () => {
    expect(ids(structure.entries)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
    expect(structure.chapters).toBe(2);
    expect(structure.sections).toBe(4);
  });
});

describe('the pages in the evidence', () => {
  it('counts from 1 like the window, except the page numbers the book prints', () => {
    expect(inWindowPages('lesson heading: the label "0.1" stands alone (page 4, 0.0987 from the top)')).toBe('lesson heading: the label "0.1" stands alone (page 5, 0.0987 from the top)');
    expect(inWindowPages('printed table of contents: "Whole Numbres", printed page 5 = page 4 of the file')).toBe('printed table of contents: "Whole Numbres", printed page 5 = page 5 of the file');
    expect(inWindowPages('the heading "Answers - Chapter 0" on page 18 opens the answers of a chapter')).toBe('the heading "Answers - Chapter 0" on page 19 opens the answers of a chapter');
    expect(inWindowPages('2 entries of the printed contents could not be read (garbled text on pages 3, 4); the headings on the pages were used instead')).toBe('2 entries of the printed contents could not be read (garbled text on pages 4, 5); the headings on the pages were used instead');
    expect(inWindowPages('0.2: the printed table of contents says page 7, the lesson heading is on page 8; the heading was used')).toBe('0.2: the printed table of contents says page 8, the lesson heading is on page 9; the heading was used');
  });

  it('leaves what the book says inside quotation marks as printed', () => {
    expect(inWindowPages('instruction: "Turn to page 10 and read pages 3, 4" (printed on 2 pages), continues on page 7, 8')).toBe('instruction: "Turn to page 10 and read pages 3, 4" (printed on 2 pages), continues on page 8, 9');
    expect(inWindowPages('the heading "see page 3" on page 12')).toBe('the heading "see page 3" on page 13');
  });

  it('leaves everything else alone: decimals, other numbers, text without pages', () => {
    expect(inWindowPages('(page 0, 0.31 from the top)')).toBe('(page 1, 0.31 from the top)');
    expect(inWindowPages('the heading is 0.31 from the top, 12 sections follow: 0.1 to 0.12')).toBe('the heading is 0.31 from the top, 12 sections follow: 0.1 to 0.12');
    expect(inWindowPages('no page number here')).toBe('no page number here');
  });

  it('is what the evidence of the real search looks like, as a person reads it next to the page', () => {
    const lesson = structure.entries.find((entry) => entry.id === '0.1');
    expect(lesson?.evidence[0]).toContain('(page 4, 0.0987 from the top)');
    expect(inWindowPages(lesson?.evidence[0] ?? '')).toContain('(page 5, 0.0987 from the top)');
    expect(inWindowPages(lesson?.evidence[1] ?? '')).toContain('printed page 5 = page 5 of the file');
  });
});

describe('comparing the derived sections with the outline of the project', () => {
  it('calls everything new when the project has no sections, and takes it all by default', () => {
    const plan = compareOutline(inputOf(bookProject(undefined)));
    expect(plan.rows.map((row) => row.status)).toEqual(Array(7).fill('new'));
    expect(plan.yours).toEqual([]);
    expect(plan.counts).toMatchObject({ total: 7, new: 7, changed: 0, same: 0, chapters: 2, sections: 4 });
    expect([...defaultSelection(plan)]).toEqual(everyId());
  });

  it('calls a project that has exactly these sections the same: nothing new, nothing different', () => {
    const project = bookProject(derivedEntries(), [{ section: '0.1', label: '1' }, { section: '1.2', label: '1' }]);
    const plan = compareOutline(inputOf(project));
    expect(plan.rows.map((row) => row.status)).toEqual(Array(7).fill('same'));
    expect(plan.counts).toMatchObject({ new: 0, changed: 0, same: 7 });
    expect(plan.yours).toEqual([]);
    expect(plan.rows.find((row) => row.entry.id === '0.1')?.exercises).toBe(1);
    expect(defaultSelection(plan).size).toBe(0);
    const outcome = resolveDerive(inputOf(project), plan, choose(everyId()));
    expect(outcome.nothing).toBe(true);
    expect(outcome.moves).toEqual([]);
  });

  it('says in words what differs, with pages and levels counted the way the window shows them', () => {
    const entries = derivedEntries().map((entry) => (entry.id === '0.1' ? { ...entry, title: 'Whole Numbres', page: entry.page + 1, top: 0.3, depth: 0, label: '0.01' } : entry.id === '0.2' ? { id: entry.id, title: entry.title, page: entry.page, depth: entry.depth } : entry));
    const plan = compareOutline(inputOf(bookProject(entries)));
    const first = plan.rows.find((row) => row.entry.id === '0.1');
    expect(first?.status).toBe('changed');
    expect(first?.changes).toEqual(['title "Whole Numbres" → "Whole Numbers"', 'page 6 → 5', 'heading position 0.30 → 0.10', 'level 1 → 2', 'printed number "0.01" → "0.1"']);
    expect(plan.rows.find((row) => row.entry.id === '0.2')?.changes).toEqual(['heading position 0.10 added', 'printed number "0.2" added']);
    expect(plan.counts).toMatchObject({ new: 0, changed: 2, same: 5 });
    // A difference of spacing or of the last digit of a position is not a difference.
    expect(differences({ title: 'A  B', page: 2, depth: 1, top: 0.12341 }, { title: 'A B', page: 2, depth: 1, top: 0.1234 })).toEqual([]);
  });

  it('lists the sections of the project the derived list does not have, with their exercises and the one that looks the same', () => {
    const entries: OutlineEntry[] = [
      { title: '0.1 Whole Numbers', page: 4, depth: 0, id: 'sec-0-1', label: '0.1' },
      { title: 'Points and lines', page: 13, depth: 0, id: 'lines' },
      { title: 'My own notes', page: 2, depth: 0, id: 'notes' },
      { title: 'Without an id', page: 3, depth: 0 },
    ];
    const project = bookProject(entries, [{ section: 'sec-0-1', label: '1' }, { section: 'sec-0-1', label: '2' }, { section: 'lines', label: '1' }]);
    const plan = compareOutline(inputOf(project));
    expect(plan.yours.map((row) => [row.entry.id, row.exercises, row.suggested])).toEqual([
      ['sec-0-1', 2, '0.1'],
      ['lines', 1, '1.1'],
      ['notes', 0, undefined],
      [undefined, 0, undefined],
    ]);
  });

  it('filters the rows and says how sure the search is', () => {
    const project = bookProject(derivedEntries().slice(0, 3));
    const plan = compareOutline(inputOf(project));
    expect(filterRows(plan.rows, 'new').map((row) => row.entry.id)).toEqual(['c1', '1.1', '1.2', 'Answers']);
    expect(filterRows(plan.rows, 'same').map((row) => row.entry.id)).toEqual(['c0', '0.1', '0.2']);
    expect(filterRows(plan.rows, 'changes')).toHaveLength(4);
    expect(filterRows(plan.rows, 'changed')).toEqual([]);
    expect(filterRows(plan.rows, 'all')).toHaveLength(7);
    expect(filterRows(plan.rows, 'unsure')).toEqual([]);
    expect(confidenceLevel(0.99)).toBe('high');
    expect(confidenceLevel(0.7)).toBe('middle');
    expect(confidenceLevel(UNSURE_BELOW - 0.01)).toBe('low');
  });
});

describe('what taking the derived sections does', () => {
  const bookmarks = (): OutlineEntry[] => [
    { title: 'Number Sense', page: 3, depth: 0, id: 'number-sense' },
    { title: '0.1 Whole Numbers', page: 4, depth: 1, id: 'whole' },
    { title: 'Graphs', page: 12, depth: 0, id: 'graphs' },
    { title: 'Appendix', page: 19, depth: 0, id: 'appendix' },
  ];

  it('replaces the sections the project has by the derived ones when all are taken, and says what went', () => {
    const project = bookProject(bookmarks());
    const outcome = resolveDerive(inputOf(project), compareOutline(inputOf(project)), choose(everyId()));
    expect(ids(outcome.entries)).toEqual(everyId());
    expect(outcome.replacing).toBe(true);
    expect(outcome.removed).toBe(4);
    expect(outcome.kept).toBe(0);
    expect(outcome.taken).toEqual({ new: 7, changed: 0, same: 0 });
    expect(outcome.nothing).toBe(false);
    expect(outcome.entries[1]).toEqual({ title: 'Whole Numbers', page: 4, depth: 1, id: '0.1', label: '0.1', top: 0.0987 });
  });

  it('keeps the sections the person asks to keep, in their place in the book', () => {
    const project = bookProject(bookmarks());
    const outcome = resolveDerive(inputOf(project), compareOutline(inputOf(project)), choose(everyId(), { keepOthers: true }));
    expect(outcome.kept).toBe(4);
    expect(outcome.removed).toBe(0);
    // Ordered by page, then by position: "Appendix" (page 19) is last, "Number Sense" (page 3) goes before the first derived entry on page 3 or after it, never inside a later chapter.
    const pagesInOrder = outcome.entries.map((entry) => entry.page);
    expect(pagesInOrder).toEqual([...pagesInOrder].sort((a, b) => a - b));
    expect(ids(outcome.entries).slice(-2)).toEqual(['Answers', 'appendix']);
  });

  it('never leaves an exercise without its section: a section that holds exercises stays unless they move', () => {
    const project = bookProject(bookmarks(), [{ section: 'whole', label: '1' }, { section: 'whole', label: '2' }, { section: 'graphs', label: '1' }]);
    const plan = compareOutline(inputOf(project));
    const kept = resolveDerive(inputOf(project), plan, choose(everyId()));
    expect(ids(kept.entries)).toContain('whole');
    expect(ids(kept.entries)).toContain('graphs');
    expect(ids(kept.entries)).not.toContain('number-sense');
    expect(kept.keptWithExercises).toBe(2);
    expect(kept.removed).toBe(2);
    expect(kept.moves).toEqual([]);

    const moved = resolveDerive(inputOf(project), plan, choose(everyId(), { moves: { whole: '0.1' } }));
    expect(ids(moved.entries)).not.toContain('whole');
    expect(ids(moved.entries)).toContain('graphs');
    expect(moved.moves).toEqual(project.frames.filter((frame) => frame.section === 'whole').map((frame) => ({ id: frame.id, section: '0.1' })));
    expect(moved.keptWithExercises).toBe(1);
  });

  it('keeps a section whose exercises were to move to a section that is not taken', () => {
    const project = bookProject(bookmarks(), [{ section: 'whole', label: '1' }]);
    const plan = compareOutline(inputOf(project));
    const withoutTarget = everyId().filter((id) => id !== '0.1');
    const outcome = resolveDerive(inputOf(project), plan, choose(withoutTarget, { moves: { whole: '0.1' } }));
    expect(outcome.blocked).toEqual(['whole']);
    expect(ids(outcome.entries)).toContain('whole');
    expect(outcome.moves).toEqual([]);
  });

  it('removes nothing of the project when only a part of the derived list is taken', () => {
    const project = bookProject(bookmarks());
    const plan = compareOutline(inputOf(project));
    const outcome = resolveDerive(inputOf(project), plan, choose(['0.1', '0.2']));
    expect(outcome.replacing).toBe(false);
    expect(outcome.removed).toBe(0);
    expect(ids(outcome.entries)).toEqual(expect.arrayContaining(['number-sense', 'whole', 'graphs', 'appendix', '0.1', '0.2']));
    expect(outcome.entries).toHaveLength(6);
  });

  it('leaves the sections of the project as they are when nothing is taken', () => {
    const project = bookProject(bookmarks());
    const outcome = resolveDerive(inputOf(project), compareOutline(inputOf(project)), choose([]));
    expect(outcome.nothing).toBe(true);
    expect(outcome.entries).toEqual(project.outline?.entries);
  });

  it('keeps the own version of a different section that was not taken, and replaces it when taken', () => {
    const entries = derivedEntries().map((entry) => (entry.id === '0.2' ? { ...entry, title: 'My title' } : entry));
    const project = bookProject(entries);
    const plan = compareOutline(inputOf(project));
    expect(plan.rows.find((row) => row.entry.id === '0.2')?.status).toBe('changed');
    const untouched = resolveDerive(inputOf(project), plan, choose(everyId().filter((id) => id !== '0.2')));
    expect(untouched.nothing).toBe(true);
    expect(untouched.entries.find((entry) => entry.id === '0.2')?.title).toBe('My title');
    const taken = resolveDerive(inputOf(project), plan, choose(everyId()));
    expect(taken.nothing).toBe(false);
    expect(taken.taken).toMatchObject({ changed: 1, same: 6 });
    expect(taken.entries.find((entry) => entry.id === '0.2')?.title).toBe('Word Problems');
  });

  it('describes what was done in one sentence', () => {
    const project = bookProject(bookmarks(), [{ section: 'whole', label: '1' }]);
    const outcome = resolveDerive(inputOf(project), compareOutline(inputOf(project)), choose(everyId()));
    expect(describeOutcome(outcome)).toBe('The book now has 8 sections (7 new); 1 of your sections stay because exercises are filed under them. Undo takes it back.');
  });
});

// ---------------------------------------------------------------------------------------------------------- the store

type Fake = ReturnType<typeof fakeApi>;

function storeWith(project: Project, overrides: Partial<Api> = {}): { store: Store; api: Fake } {
  const api = fakeApi({ pdf: () => pdfBytes, texts: () => pages, fresh: () => project }, { deriveSections: () => Promise.resolve({ ok: true, result: structure }), ...overrides });
  return { store: new Store(api), api };
}

async function opened(project: Project, overrides: Partial<Api> = {}): Promise<{ store: Store; api: Fake }> {
  const made = storeWith(project, overrides);
  await made.store.openDocument(openedDocument(project, pages.length, null));
  return made;
}

const validIn = (store: Store): boolean => {
  const project = store.state.project as Project;
  const known = new Set((project.outline?.entries ?? []).map((entry) => entry.id));
  return project.frames.every((frame) => frame.section === undefined || known.has(frame.section)) && (store.state.validation?.errors.length ?? 0) === 0;
};

describe('deriving the sections in the store', () => {
  it('reads the book, shows what it found for review (nothing is applied yet) and takes the new sections by default', async () => {
    const { store } = await opened(bookProject(undefined));
    const before = store.state.project;
    await store.deriveSections();
    expect(store.state.audit).toEqual({ job: null, stopping: false });
    expect(store.state.tab).toBe('sections');
    expect(store.state.project).toBe(before);
    expect(Object.keys(store.state.derive?.selected ?? {})).toEqual(everyId());
    expect(store.state.derive?.filter).toBe('changes');
    expect(store.derivePlan()?.counts).toMatchObject({ total: 7, new: 7 });
    expect(store.deriveOutcome()?.nothing).toBe(false);
  });

  it('takes all of them as one undoable step and says what it did', async () => {
    const { store } = await opened(bookProject(undefined));
    const result = store.applyDerive('all');
    expect(result.ok).toBe(false); // nothing was derived yet
    await store.deriveSections();
    const applied = store.applyDerive('all');
    expect(applied.ok).toBe(true);
    expect(store.state.derive).toBeNull();
    expect(store.state.project?.outline).toEqual({ source: 'derived', entries: derivedEntries() });
    expect(store.state.notice).toMatchObject({ kind: 'success', text: 'The book now has 7 sections (7 new). Undo takes it back.' });
    expect(store.state.past).toHaveLength(1);
    expect(store.state.dirty).toBe(true);
    store.undo();
    expect(store.state.project?.outline).toBeUndefined();
  });

  it('takes only the selected sections and removes nothing of the project', async () => {
    const own: OutlineEntry[] = [{ title: 'Preface', page: 1, depth: 0, id: 'preface' }];
    const { store } = await opened(bookProject(own));
    await store.deriveSections();
    store.selectDerived('none');
    store.setDerived('0.1', true);
    store.setDerived('0.2', true);
    expect(store.deriveOutcome()?.replacing).toBe(false);
    expect(store.applyDerive('selected').ok).toBe(true);
    expect(ids(store.state.project?.outline?.entries)).toEqual(['preface', '0.1', '0.2']);
  });

  it('refuses to apply when nothing would change, and says so', async () => {
    const { store } = await opened(bookProject(derivedEntries()));
    await store.deriveSections();
    expect(store.state.derive?.filter).toBe('all');
    expect(store.deriveOutcome()?.nothing).toBe(true);
    const result = store.applyDerive('all');
    expect(result.ok).toBe(false);
    expect(store.state.derive?.error).toBe('Nothing would change: the sections of the book already are these.');
    expect(store.state.past).toHaveLength(0);
  });

  it('keeps every exercise under a section that exists, whatever is chosen', async () => {
    const entries: OutlineEntry[] = [
      { title: '0.1 Whole Numbers', page: 4, depth: 0, id: 'sec-0-1', label: '0.1' },
      { title: 'Graphs', page: 12, depth: 0, id: 'graphs' },
      { title: 'Empty', page: 2, depth: 0, id: 'empty' },
    ];
    const exercises = [{ section: 'sec-0-1', label: '1' }, { section: 'sec-0-1', label: '2' }, { section: 'graphs', label: '1' }];
    const choices: { selected: 'all' | 'none' | 'new' | 'changes'; keepOthers: boolean; moveWhole: boolean; moveGraphs: boolean }[] = [];
    for (const selected of ['all', 'none', 'new', 'changes'] as const) for (const keepOthers of [false, true]) for (const moveWhole of [false, true]) for (const moveGraphs of [false, true]) choices.push({ selected, keepOthers, moveWhole, moveGraphs });
    let applied = 0;
    for (const choice of choices) {
      const { store } = await opened(bookProject(entries, exercises));
      await store.deriveSections();
      store.selectDerived(choice.selected);
      store.setKeepOthers(choice.keepOthers);
      if (choice.moveWhole) store.moveSectionTo('sec-0-1', '0.1');
      if (choice.moveGraphs) store.moveSectionTo('graphs', 'c1');
      const result = store.applyDerive('selected');
      if (result.ok) {
        applied += 1;
        expect(validIn(store), JSON.stringify(choice)).toBe(true);
      } else expect(store.state.project?.frames.length).toBe(3);
      expect(store.state.project?.frames).toHaveLength(3);
    }
    // Most combinations change something (the others have nothing to apply); none of them leaves an exercise without its section.
    expect(applied).toBeGreaterThanOrEqual(24);
  });

  it('moves the exercises of a section to the section that looks the same, in the same step', async () => {
    const entries: OutlineEntry[] = [
      { title: '0.1 Whole Numbers', page: 4, depth: 0, id: 'sec-0-1', label: '0.1' },
      { title: 'Points and Lines', page: 13, depth: 0, id: 'lines' },
    ];
    const { store } = await opened(bookProject(entries, [{ section: 'sec-0-1', label: '1' }, { section: 'sec-0-1', label: '2' }, { section: 'lines', label: '1' }]));
    await store.deriveSections();
    expect(store.derivePlan()?.yours.map((row) => row.suggested)).toEqual(['0.1', '1.1']);
    store.moveToSuggested();
    expect(store.state.derive?.moves).toEqual({ 'sec-0-1': '0.1', lines: '1.1' });
    expect(store.deriveOutcome()?.moves).toHaveLength(3);
    expect(store.applyDerive('all').ok).toBe(true);
    const project = store.state.project as Project;
    expect(project.frames.map((frame) => `${frame.section}:${frame.label}`)).toEqual(['0.1:1', '0.1:2', '1.1:1']);
    expect(ids(project.outline?.entries)).toEqual(everyId());
    expect(validIn(store)).toBe(true);
    expect(store.state.past).toHaveLength(1);
    store.undo();
    expect(store.state.project?.frames.map((frame) => frame.section)).toEqual(['sec-0-1', 'sec-0-1', 'lines']);
  });

  it('shows the reason in the review when the window refuses the change (two exercises with one number in a section)', async () => {
    const entries = derivedEntries();
    const project = bookProject([...entries, { title: 'Old', page: 8, depth: 0, id: 'old' }], [{ section: '0.2', label: '1' }, { section: 'old', label: '1' }]);
    const { store } = await opened(project);
    await store.deriveSections();
    store.moveSectionTo('old', '0.2');
    const result = store.applyDerive('selected');
    expect(result.ok).toBe(false);
    expect(store.state.derive?.error).toContain('two exercises numbered 1');
    expect(store.state.project).toBe(project);
  });

  it('shows a plain message when nothing was found, and when the search failed', async () => {
    const empty: BookStructure = { ...structure, entries: [], chapters: 0, sections: 0, notes: ['No chapters or sections were found.'] };
    const { store } = await opened(bookProject(undefined), { deriveSections: () => Promise.resolve({ ok: true, result: empty }) });
    await store.deriveSections();
    expect(store.derivePlan()?.counts.total).toBe(0);
    expect(store.applyDerive('all').ok).toBe(false);
    store.discardDerive();
    expect(store.state.derive).toBeNull();

    const failing = await opened(bookProject(undefined), { deriveSections: () => Promise.resolve({ ok: false, cancelled: false, message: 'The PDF could not be read.' }) });
    await failing.store.deriveSections();
    expect(failing.store.state.derive).toBeNull();
    expect(failing.store.state.notice).toMatchObject({ kind: 'error', text: 'The sections could not be derived: The PDF could not be read.' });
    expect(failing.store.state.audit.job).toBeNull();

    const throwing = await opened(bookProject(undefined), { deriveSections: () => Promise.reject(new Error('boom')) });
    await throwing.store.deriveSections();
    expect(throwing.store.state.notice?.text).toBe('The sections could not be derived: boom');
    expect(throwing.store.state.audit.job).toBeNull();
  });
});

describe('a long search: progress, stopping, one at a time', () => {
  function pending(): { promise: Promise<AuditOutcome<BookStructure>>; finish: (outcome: AuditOutcome<BookStructure>) => void } {
    let finish: (outcome: AuditOutcome<BookStructure>) => void = () => undefined;
    const promise = new Promise<AuditOutcome<BookStructure>>((resolve) => {
      finish = resolve;
    });
    return { promise, finish };
  }

  it('reports the progress only while the search runs, and not through the editor state', async () => {
    const wait = pending();
    const { store } = await opened(bookProject(undefined), { deriveSections: () => wait.promise });
    store.reportProgress({ phase: 'Reading the text of the pages', done: 5, total: 20 });
    expect(store.progress.value).toBeNull(); // no search is running: a late message is ignored
    const running = store.deriveSections();
    expect(store.state.audit).toEqual({ job: 'sections', stopping: false });
    let renders = 0;
    store.subscribe(() => {
      renders += 1;
    });
    let barRenders = 0;
    store.progress.subscribe(() => {
      barRenders += 1;
    });
    store.reportProgress({ phase: 'Reading the text of the pages', done: 5, total: 20 });
    store.reportProgress({ phase: 'Reading the text of the pages', done: 6, total: 20 });
    expect(store.progress.value).toEqual({ phase: 'Reading the text of the pages', done: 6, total: 20 });
    expect(renders).toBe(0);
    expect(barRenders).toBe(2);
    wait.finish({ ok: true, result: structure });
    await running;
    expect(store.progress.value).toBeNull();
    expect(store.state.audit.job).toBeNull();
  });

  it('stops on request: the main process is told, and nothing is changed', async () => {
    const wait = pending();
    let cancelled = 0;
    const { store } = await opened(bookProject(undefined), {
      deriveSections: () => wait.promise,
      cancelAudit: () => {
        cancelled += 1;
        wait.finish({ ok: false, cancelled: true, message: 'Stopped.' });
        return Promise.resolve();
      },
    });
    const project = store.state.project;
    const running = store.deriveSections();
    store.cancelAudit();
    expect(store.state.audit).toEqual({ job: 'sections', stopping: true });
    store.cancelAudit(); // a second click does nothing more
    await running;
    expect(cancelled).toBe(1);
    expect(store.state.audit).toEqual({ job: null, stopping: false });
    expect(store.state.derive).toBeNull();
    expect(store.state.project).toBe(project);
    expect(store.state.notice).toMatchObject({ kind: 'info', text: 'Stopped. Nothing was changed.' });
  });

  it('runs one search at a time', async () => {
    const wait = pending();
    let calls = 0;
    const { store } = await opened(bookProject(undefined), {
      deriveSections: () => {
        calls += 1;
        return wait.promise;
      },
    });
    const first = store.deriveSections();
    await store.deriveSections();
    expect(calls).toBe(1);
    expect(store.state.notice?.text).toBe('A search is still running: wait for it, or stop it first.');
    wait.finish({ ok: true, result: structure });
    await first;
    expect(store.state.derive).not.toBeNull();
  });

  it('ignores the answer for a document that is no longer open', async () => {
    const wait = pending();
    const { store } = await opened(bookProject(undefined), { deriveSections: () => wait.promise });
    const running = store.deriveSections();
    await store.openDocument(openedDocument(bookProject(undefined), pages.length, null));
    wait.finish({ ok: true, result: structure });
    await running;
    expect(store.state.derive).toBeNull();
    expect(store.state.audit.job).toBeNull();
  });

  it('keeps the review between tabs, and a new document starts without one', async () => {
    const { store } = await opened(bookProject(undefined));
    await store.deriveSections();
    store.setTab('frames');
    store.setTab('sections');
    expect(store.state.derive).not.toBeNull();
    await store.openDocument(openedDocument(bookProject(undefined), pages.length, null));
    expect(store.state.derive).toBeNull();
  });

  it('shows the heading of the derived section on its page when it is looked at', async () => {
    const { store } = await opened(bookProject(undefined));
    await store.deriveSections();
    store.focusDerived('1.1');
    expect(store.state.derive?.focus).toBe('1.1');
    expect(store.state.page).toBe(13);
    expect(store.state.focus).toMatchObject({ page: 13, y: 0.0987 });
  });
});

describe('a project with exercises stays valid whatever the sections', () => {
  it('has no error after taking the derived list over exercises in sections it replaces', async () => {
    const entries = derivedEntries();
    const { store } = await opened(bookProject(entries, [{ section: '0.1', label: '1' }, { section: '1.2', label: '1' }]));
    await store.deriveSections();
    expect(store.derivePlan()?.counts).toMatchObject({ new: 0, changed: 0 });
    const project = store.state.project as Project;
    expect(validateProject(project).errors).toEqual([]);
  });
});
