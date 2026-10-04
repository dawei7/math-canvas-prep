import { beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, applyOperations, newProject, type Frame, type Operation, type OutlineEntry, type PageText, type Project } from '@mcprep/core';
import type { AuthoritySample } from '@mcprep/core/testing';
import { visibleRange, scrollToReveal } from '../src/renderer/logic/list.js';
import { bookModel } from '../src/renderer/logic/model.js';
import { buildSectionRows, canMove, canShiftDepth, exercisesUnder, idsUnder, sectionWarnings, suggestSectionId } from '../src/renderer/logic/sections.js';
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

function workbook(options: { exercises?: boolean; entries?: OutlineEntry[] } = {}): Project {
  const base = newProject({ pdf: { path: 'workbook.pdf', sha256: 'c'.repeat(64), bytes: 5553, pageCount: 4 }, title: 'Pre-Algebra Workbook', now: new Date('2026-10-04T12:00:00Z') });
  const operations: Operation[] = [{ op: 'outline.set', entries: options.entries ?? authority.sections, source: 'manual' }];
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

async function started(project: Project, outline: { title: string; page: number; depth: number }[] | null = authority.pdfOutline): Promise<Store> {
  const api = fakeApi({ pdf: () => authority.pdf, texts: () => texts, fresh: () => project });
  const store = new Store(api);
  await store.openDocument(openedDocument(project, 4, outline));
  return store;
}

const modelOf = (project: Project) => bookModel(project.frames, project.outline?.entries, 4);
const ids = (project: Project): (string | undefined)[] => (project.outline?.entries ?? []).map((entry) => entry.id);

describe('the rows of the Sections list', () => {
  it('lists every entry in the order of the book with its counts, and folds a subtree away', () => {
    const project = workbook({ exercises: true });
    const model = modelOf(project);
    const rows = buildSectionRows(model, { collapsed: {}, filter: 'all' });
    expect(rows.map((row) => row.entry.id)).toEqual(['c1', '1.1', '1.2', 'c2', '2.1', 'answers']);
    expect(rows.map((row) => [row.own, row.total, row.totalSolved])).toEqual([
      [0, 8, 8],
      [4, 4, 4],
      [4, 4, 4],
      [0, 2, 2],
      [2, 2, 2],
      [0, 0, 0],
    ]);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, false, false, true, false, false]);
    const folded = buildSectionRows(model, { collapsed: { c1: true }, filter: 'all' });
    expect(folded.map((row) => row.entry.id)).toEqual(['c1', 'c2', '2.1', 'answers']);
    expect(folded[0]?.collapsed).toBe(true);
    // A filter ignores what is folded away and shows the matches in a flat list.
    expect(buildSectionRows(model, { collapsed: { c1: true }, filter: 'empty' }).map((row) => row.entry.id)).toEqual(['answers']);
  });

  it('filters the sections without exercises, the exercises without a solution and the problems, and searches', () => {
    const project = workbook({ exercises: true });
    const frames = project.frames.map((frame) => (frame.section === '1.2' && frame.label === '3' ? ((): Frame => { const copy = { ...frame }; delete copy.solution; return copy; })() : frame));
    const model = bookModel(frames, project.outline?.entries, 4);
    expect(buildSectionRows(model, { collapsed: {}, filter: 'unsolved' }).map((row) => row.entry.id)).toEqual(['1.2']);
    expect(buildSectionRows(model, { collapsed: {}, filter: 'all', query: 'fract' }).map((row) => row.entry.id)).toEqual(['c2', '2.1']);
    expect(buildSectionRows(model, { collapsed: {}, filter: 'all', query: '1.2' }).map((row) => row.entry.id)).toEqual(['1.2']);
    const entries = (project.outline?.entries ?? []).map((entry) => (entry.id === '1.2' ? { title: entry.title, page: entry.page, depth: entry.depth } : entry.id === '2.1' ? { ...entry, id: '1.1' } : entry));
    const broken = bookModel([], entries, 4);
    const problems = buildSectionRows(broken, { collapsed: {}, filter: 'problems' });
    expect(problems.map((row) => [row.entry.title, row.problems])).toEqual([
      ['1.2 Subtracting integers', ['no id']],
      ['2.1 Equivalent fractions', ['id used twice']],
    ]);
  });

  it('warns about ids used twice, sections without an id, exercises under an unknown section, sections still empty', () => {
    const project = workbook({ exercises: true });
    expect(sectionWarnings(modelOf(project))).toMatchObject({ duplicateIds: [], withoutId: [], unplaced: [], empty: 1, unsolved: 0 });
    const entries = (project.outline?.entries ?? []).map((entry) => (entry.id === 'c2' ? { ...entry, id: '1.1' } : entry.id === '2.1' ? { title: entry.title, page: entry.page, depth: entry.depth } : entry));
    const warnings = sectionWarnings(bookModel(project.frames, entries, 4));
    expect(warnings.duplicateIds).toEqual(['1.1']);
    expect(warnings.withoutId).toEqual([4]);
    expect(warnings.unplaced.map((frame) => `${frame.section}:${frame.label}`)).toEqual(['2.1:1', '2.1:2']);
  });

  it('knows which entries can go deeper or shallower and which can move', () => {
    const model = modelOf(workbook());
    // c1 [1.1 1.2] c2 [2.1] answers
    expect(canShiftDepth(model, 0, 1)).toBe(false);
    expect(canShiftDepth(model, 0, -1)).toBe(false);
    expect(canShiftDepth(model, 1, -1)).toBe(true);
    expect(canShiftDepth(model, 1, 1)).toBe(false);
    expect(canShiftDepth(model, 2, 1)).toBe(true);
    // Chapter 2 can become a section of Chapter 1 (it follows a section, which is one level deeper).
    expect(canShiftDepth(model, 3, 1)).toBe(true);
    expect(canShiftDepth(model, 5, 1)).toBe(true);
    expect(canMove(model, 0)).toEqual({ up: false, down: true });
    expect(canMove(model, 2)).toEqual({ up: true, down: false });
    expect(canMove(model, 5)).toEqual({ up: true, down: false });
    expect(canMove(model, 99)).toEqual({ up: false, down: false });
  });

  it('finds the ids under a section and the exercises filed there', () => {
    const project = workbook({ exercises: true });
    const model = modelOf(project);
    expect(idsUnder(model, 0, true)).toEqual(['c1', '1.1', '1.2']);
    expect(idsUnder(model, 0, false)).toEqual(['c1']);
    expect(exercisesUnder(model, idsUnder(model, 0, true))).toBe(8);
    expect(exercisesUnder(model, ['2.1'])).toBe(2);
    expect(suggestSectionId(model, 1)).toBe('1.1');
    const anonymous = bookModel([], [{ title: '3.4 Powers', page: 0, depth: 0 }, { title: 'Powers', page: 1, depth: 0, id: '3.4' }], 4);
    expect(suggestSectionId(anonymous, 0)).toBe('3.4-2');
  });
});

describe('a long list', () => {
  it('draws only the rows in view, with a few more on each side', () => {
    expect(visibleRange(0, 460, 46, 5000)).toEqual({ first: 0, end: 16 });
    expect(visibleRange(46 * 1000, 460, 46, 5000)).toEqual({ first: 994, end: 1016 });
    expect(visibleRange(46 * 4990, 460, 46, 5000)).toEqual({ first: 4984, end: 5000 });
    expect(visibleRange(0, 460, 46, 3)).toEqual({ first: 0, end: 3 });
    expect(visibleRange(9999, 460, 46, 0)).toEqual({ first: 0, end: 0 });
    expect(visibleRange(-50, 100, 20, 10, 0)).toEqual({ first: 0, end: 5 });
  });

  it('scrolls only when the row is out of view, and then centres it', () => {
    expect(scrollToReveal(3, 0, 460, 46)).toBeUndefined();
    expect(scrollToReveal(100, 0, 460, 46)).toBe(100 * 46 - 230 + 23);
    expect(scrollToReveal(0, 500, 460, 46)).toBe(0);
  });
});

describe('the store: editing the sections', () => {
  it('adds a section after the selected one, or below it, at the page shown', async () => {
    const store = await started(workbook());
    store.setPage(1);
    const added = store.addSection({ after: 1, title: 'Practice' });
    expect(added).toMatchObject({ ok: true, index: 2 });
    const entries = store.state.project?.outline?.entries ?? [];
    expect(entries.map((entry) => entry.title)).toEqual(['Chapter 1 Integers', '1.1 Adding integers', 'Practice', '1.2 Subtracting integers', 'Chapter 2 Fractions', '2.1 Equivalent fractions', 'Answers']);
    expect(entries[2]).toMatchObject({ depth: 1, page: 1 });
    expect(entries[2]?.id).toBeUndefined();
    expect(store.state.sectionSelection).toBe(2);
    // A subsection goes at the end of what is below its parent.
    expect(store.addSection({ after: 0, child: true, title: 'Warm-up' }).index).toBe(4);
    expect(store.state.project?.outline?.entries[4]).toMatchObject({ title: 'Warm-up', depth: 1 });
    store.undo();
    expect(store.state.project?.outline?.entries).toHaveLength(7);
  });

  it('starts from the PDF\'s bookmarks when the project has no sections of its own', async () => {
    const store = await started(workbook({ entries: [] }), authority.pdfOutline);
    store.apply([{ op: 'outline.clear' }]);
    expect(store.state.project?.outline).toBeUndefined();
    const added = store.addSection({ title: 'Extra' });
    expect(added.ok).toBe(true);
    expect(store.state.project?.outline?.entries).toHaveLength(authority.pdfOutline.length + 1);
    expect(store.state.project?.outline?.entries.at(-1)?.title).toBe('Extra');
    store.apply([{ op: 'outline.clear' }]);
    expect(store.giveSectionIds().ok).toBe(true);
    expect(ids(store.state.project as Project).every((id) => id !== undefined)).toBe(true);
    expect(ids(store.state.project as Project)).toEqual(['1', '1.1', '1.2', '2', '2.1', 'Answers']);
  });

  it('changes the title, number, id, page and position of a section', async () => {
    const store = await started(workbook({ exercises: true }));
    expect(store.updateSection(2, { title: 'Subtracting' }).ok).toBe(true);
    expect(store.updateSection(2, { label: '1.2.', top: 0.12, page: 1 }).ok).toBe(true);
    expect(store.state.project?.outline?.entries[2]).toMatchObject({ title: 'Subtracting', label: '1.2.', top: 0.12 });
    expect(store.updateSection(2, { label: null, top: null }).ok).toBe(true);
    expect(store.state.project?.outline?.entries[2]?.label).toBeUndefined();
    expect(store.state.project?.outline?.entries[2]?.top).toBeUndefined();
    expect(store.updateSection(2, { page: 9 }).error).toContain('does not exist');
    expect(store.updateSection(2, { top: 3 }).error).toContain('from 0 to 1');
    expect(store.updateSection(2, { title: '  ' }).error).toContain('must not be empty');
    expect(store.updateSection(2, { label: 'x'.repeat(30) }).error).toContain('at most 24 characters');
  });

  it('renames the id of a section and takes its exercises along, and refuses an id that is taken', async () => {
    const store = await started(workbook({ exercises: true }));
    const result = store.updateSection(2, { id: 'subtracting' });
    expect(result.ok).toBe(true);
    expect(store.state.notice?.text).toContain('The 4 exercises of section "1.2" now name "subtracting"');
    expect(store.state.project?.frames.filter((frame) => frame.section === 'subtracting')).toHaveLength(4);
    expect(store.state.project?.frames.some((frame) => frame.section === '1.2')).toBe(false);
    expect(store.state.validation?.errors).toEqual([]);
    const clash = store.updateSection(2, { id: '1.1' });
    expect(clash.ok).toBe(false);
    expect(clash.error).toContain('already the id of another outline entry');
    // A section with exercises cannot lose its id.
    const lose = store.updateSection(2, { id: null });
    expect(lose.ok).toBe(false);
    expect(lose.error).toMatch(/4 exercises/);
    expect(lose.error).not.toMatch(/`|mcprep/);
    expect(store.updateSection(2, { id: 'has space' }).error).toContain('A-Z a-z 0-9');
  });

  it('makes a section and everything below it deeper or shallower, keeping the shape of the subtree', async () => {
    const store = await started(workbook());
    const depths = (): number[] => (store.state.project?.outline?.entries ?? []).map((entry) => entry.depth);
    expect(depths()).toEqual([0, 1, 1, 0, 1, 0]);
    // Chapter 2 and its section go under Chapter 1: one level deeper, both.
    expect(store.shiftSectionDepth(3, 1).ok).toBe(true);
    expect(depths()).toEqual([0, 1, 1, 1, 2, 0]);
    expect(store.shiftSectionDepth(3, -1).ok).toBe(true);
    expect(depths()).toEqual([0, 1, 1, 0, 1, 0]);
    expect(store.shiftSectionDepth(0, -1).error).toContain('from 0 to 8');
    expect(store.shiftSectionDepth(99, 1).error).toContain('does not exist');
  });

  it('moves a section with its subsections past its sibling, and keeps the exercises filed', async () => {
    const store = await started(workbook({ exercises: true }));
    expect(store.moveSection(3, -1).ok).toBe(true);
    expect((store.state.project?.outline?.entries ?? []).map((entry) => entry.id)).toEqual(['c2', '2.1', 'c1', '1.1', '1.2', 'answers']);
    expect(store.state.sectionSelection).toBe(0);
    expect(store.state.validation?.errors).toEqual([]);
    expect(store.moveSection(0, -1).error).toBe('It is the first section on its level.');
    expect(store.moveSection(0, 1).ok).toBe(true);
    expect((store.state.project?.outline?.entries ?? []).map((entry) => entry.id)).toEqual(['c1', '1.1', '1.2', 'c2', '2.1', 'answers']);
    expect(store.state.sectionSelection).toBe(3);
    expect(store.moveSection(5, 1).error).toBe('It is the last section on its level.');
    // Moving one level-1 section past its sibling.
    expect(store.moveSection(2, -1).ok).toBe(true);
    expect((store.state.project?.outline?.entries ?? []).slice(0, 3).map((entry) => entry.id)).toEqual(['c1', '1.2', '1.1']);
  });

  it('refuses to delete a section that exercises are filed under, in plain words, unless they go to another section', async () => {
    const store = await started(workbook({ exercises: true }));
    const refused = store.deleteSection(2);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('4 exercises are filed under the section "1.2". Move them to another section first, or delete them.');
    expect(store.state.project?.outline?.entries).toHaveLength(6);
    // Their numbers 1 to 4 are taken in 1.1: the exercises cannot go there, and the section stays.
    const clash = store.deleteSection(2, { moveTo: '1.1' });
    expect(clash.ok).toBe(false);
    expect(clash.error).toMatch(/Section 1\.1 would have two exercises numbered/);
    expect(store.state.project?.outline?.entries).toHaveLength(6);
    expect(store.state.project?.frames.filter((frame) => frame.section === '1.2')).toHaveLength(4);
    const moved = store.deleteSection(2, { moveTo: 'answers' });
    expect(moved.ok).toBe(true);
    expect(store.state.project?.outline?.entries.map((entry) => entry.id)).toEqual(['c1', '1.1', 'c2', '2.1', 'answers']);
    expect(store.state.project?.frames.filter((frame) => frame.section === 'answers')).toHaveLength(4);
    expect(store.state.validation?.errors).toEqual([]);
  });

  it('deletes a section without exercises, with or without the sections below it', async () => {
    const store = await started(workbook());
    expect(store.deleteSection(3).ok).toBe(true);
    // The section below moved up one level.
    expect((store.state.project?.outline?.entries ?? []).map((entry) => [entry.id, entry.depth])).toEqual([['c1', 0], ['1.1', 1], ['1.2', 1], ['2.1', 0], ['answers', 0]]);
    store.undo();
    expect(store.deleteSection(3, { subtree: true }).ok).toBe(true);
    expect((store.state.project?.outline?.entries ?? []).map((entry) => entry.id)).toEqual(['c1', '1.1', '1.2', 'answers']);
    expect(store.state.sectionSelection).toBeNull();
  });

  it('gives every section an id and adopts the PDF\'s bookmarks as sections with ids', async () => {
    const project = workbook({ entries: authority.sections.map(({ title, page, depth }) => ({ title, page, depth })) });
    const store = await started(project);
    expect(sectionWarnings(store.book()).withoutId).toHaveLength(6);
    expect(store.giveSectionIds().ok).toBe(true);
    expect(ids(store.state.project as Project)).toEqual(['1', '1.1', '1.2', '2', '2.1', 'Answers']);
    expect(store.giveSectionIds().notes).toContain('Every outline entry already has an id.');
    const adopted = store.adoptPdfOutline();
    expect(adopted.ok).toBe(true);
    expect(store.state.project?.outline?.source).toBe('pdf');
    const none = await started(project, null);
    expect(none.adoptPdfOutline().error).toBe('The PDF has no bookmarks.');
  });

  it('sets where a heading starts from a click on the page: the text line there, else the height clicked', async () => {
    const store = await started(workbook());
    store.pickHeading(2);
    expect(store.state.picking).toBe(2);
    expect(store.state.tool).toBe('select');
    const result = store.pickHeadingAt(1, 0.1234567);
    expect(result.ok).toBe(true);
    expect(store.state.picking).toBeNull();
    expect(store.state.project?.outline?.entries[2]).toMatchObject({ page: 1, top: 0.1235 });
    expect(store.pickHeadingAt(0, 0.1).error).toBe('No section is waiting for a heading.');
    store.pickHeading(1);
    store.setTool('book');
    expect(store.state.picking).toBeNull();
  });

  it('shows the heading of a section on its page and remembers which one is selected', async () => {
    const store = await started(workbook());
    store.goToSection(4);
    expect(store.state.sectionSelection).toBe(4);
    expect(store.state.page).toBe(2);
    expect(store.state.focus).toMatchObject({ page: 2, y: authority.sections[4]?.top });
    store.selectSection(null);
    expect(store.state.sectionSelection).toBeNull();
    store.toggleSection('c1');
    expect(store.state.collapsedSections).toEqual({ c1: true });
    store.toggleSection('c1');
    expect(store.state.collapsedSections).toEqual({});
  });
});
