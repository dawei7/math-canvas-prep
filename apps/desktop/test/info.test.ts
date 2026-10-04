import { beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, applyOperations, newProject, type Operation, type PageText, type Project } from '@mcprep/core';
import type { AuthoritySample } from '@mcprep/core/testing';
import { exportFacts, percent } from '../src/renderer/logic/export.js';
import { checkInfoForm, formFromMeta, patchFromForm } from '../src/renderer/logic/info.js';
import { bookModel, frameIndex } from '../src/renderer/logic/model.js';
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

function workbook(options: { exercises?: boolean; outline?: boolean } = {}): Project {
  const base = newProject({ pdf: { path: 'workbook.pdf', sha256: 'c'.repeat(64), bytes: 5553, pageCount: 4 }, title: 'Pre-Algebra Workbook', now: new Date('2026-10-04T12:00:00Z') });
  const operations: Operation[] = [];
  if (options.outline !== false) operations.push({ op: 'outline.set', entries: authority.sections, source: 'manual' });
  if (options.exercises === true) {
    for (const exercise of authority.exercises) {
      operations.push({ op: 'add', authority: 'book', label: exercise.label, section: exercise.section, page: exercise.page, rect: exercise.rect, ...(exercise.context ? { context: exercise.context } : {}), ...(exercise.continues ? { continues: exercise.continues } : {}), solution: exercise.solution });
    }
  }
  return applyOperations(base, operations, { pageCount: 4 }).project;
}

async function started(project: Project, overrides: Parameters<typeof fakeApi>[1] = {}): Promise<{ store: Store; api: ReturnType<typeof fakeApi> }> {
  const api = fakeApi({ pdf: () => authority.pdf, texts: () => texts, fresh: () => project }, overrides);
  const store = new Store(api);
  await store.openDocument(openedDocument(project, 4, authority.pdfOutline));
  return { store, api };
}

describe('the document information form', () => {
  const meta = { title: 'Pre-Algebra', folder: 'Books/Algebra', author: 'A. Author', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, sourceUrl: 'https://example.org/book', notice: 'Attribution: A. Author.' };

  it('shows what the project says, and nothing as an empty field', () => {
    expect(formFromMeta(meta)).toEqual({ title: 'Pre-Algebra', folder: 'Books/Algebra', author: 'A. Author', series: '', description: '', licenseName: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/', sourceUrl: 'https://example.org/book', notice: 'Attribution: A. Author.' });
    expect(formFromMeta({ title: 'T' }).licenseName).toBe('');
    expect(checkInfoForm(formFromMeta(meta))).toEqual({});
  });

  it('says what is wrong with each field in plain words', () => {
    const form = { ...formFromMeta(meta), title: '  ', author: 'x'.repeat(201), description: 'y'.repeat(4001), sourceUrl: 'example.org', licenseUrl: 'ftp://example.org/licence' };
    const problems = checkInfoForm(form);
    expect(problems.title).toContain('cannot be empty');
    expect(problems.author).toBe('The author is 201 characters long; at most 200 are allowed.');
    expect(problems.description).toContain('at most 4000');
    expect(problems.sourceUrl).toContain('starting with http:// or https://');
    expect(problems.licenseUrl).toContain('The licence address must be a full web address');
    expect(checkInfoForm({ ...formFromMeta(meta), licenseName: '' }).licenseName).toContain('needs the name of the licence');
    expect(checkInfoForm({ ...formFromMeta(meta), folder: 'a/b/c/d/e/f/g/h' }).folder).toContain('at most 7 levels');
    expect(checkInfoForm({ ...formFromMeta(meta), folder: '///' }).folder).toContain('names separated by');
    expect(checkInfoForm({ ...formFromMeta(meta), title: 'x'.repeat(201) }).title).toContain('at most 200');
    expect(Object.keys(checkInfoForm({ ...formFromMeta(meta), licenseName: '', licenseUrl: '' }))).toEqual([]);
  });

  it('makes one operation of what changed: an emptied field is removed, the licence as a whole', () => {
    const form = formFromMeta(meta);
    expect(patchFromForm(meta, form)).toBeUndefined();
    expect(patchFromForm(meta, { ...form, title: '  New title ' })).toEqual({ op: 'meta.set', title: 'New title' });
    expect(patchFromForm(meta, { ...form, author: '', series: 'Prerequisites', folder: '' })).toEqual({ op: 'meta.set', folder: null, author: null, series: 'Prerequisites' });
    expect(patchFromForm(meta, { ...form, licenseName: 'CC BY 4.0' })).toEqual({ op: 'meta.set', license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/3.0/' } });
    expect(patchFromForm(meta, { ...form, licenseUrl: '' })).toEqual({ op: 'meta.set', license: { name: 'CC BY 3.0', url: null } });
    expect(patchFromForm(meta, { ...form, licenseName: '', licenseUrl: '' })).toEqual({ op: 'meta.set', license: null });
    expect(patchFromForm({ title: 'T' }, { ...formFromMeta({ title: 'T' }), notice: 'Text' })).toEqual({ op: 'meta.set', notice: 'Text' });
  });
});

describe('the store: the document information', () => {
  it('changes what the bundle says as one undoable step, and the project is marked as changed', async () => {
    const { store } = await started(workbook());
    const patch = patchFromForm(store.state.project?.meta ?? { title: '' }, { ...formFromMeta(store.state.project?.meta ?? { title: '' }), author: 'A. Author', licenseName: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/', notice: 'Attribution: A. Author.' });
    expect(patch).toBeDefined();
    const result = store.setMeta(patch as NonNullable<typeof patch>);
    expect(result.ok).toBe(true);
    expect(store.state.project?.meta).toMatchObject({ author: 'A. Author', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, notice: 'Attribution: A. Author.' });
    expect(store.state.dirty).toBe(true);
    store.undo();
    expect(store.state.project?.meta.author).toBeUndefined();
    expect(store.state.dirty).toBe(false);
  });

  it('refuses what cannot go into a bundle, in plain words', async () => {
    const { store } = await started(workbook());
    const refused = store.setMeta({ op: 'meta.set', sourceUrl: 'ftp://example.org/book' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('is not a web address');
    expect(refused.error).not.toMatch(/`|mcprep/);
    expect(store.state.project?.meta.sourceUrl).toBeUndefined();
    expect(store.setMeta({ op: 'meta.set', title: ' ' }).ok).toBe(false);
  });

  it('opens and closes the dialog', async () => {
    const { store } = await started(workbook());
    store.openInfo();
    expect(store.state.infoOpen).toBe(true);
    store.closeInfo();
    expect(store.state.infoOpen).toBe(false);
  });
});

describe('what the export dialog says before it writes', () => {
  it('lists the optional parts of the format the bundle uses, as the writer decides', () => {
    const plain = workbook({ outline: false });
    const modelPlain = bookModel(plain.frames, plain.outline?.entries, 4);
    expect(exportFacts(plain, 'project', authority.pdfOutline, frameIndex(plain.frames), modelPlain).features).toEqual([]);
    const sections = workbook();
    expect(exportFacts(sections, 'project', null, frameIndex(sections.frames), bookModel(sections.frames, sections.outline?.entries, 4)).features).toEqual(['sections']);
    // The PDF's bookmarks have no ids, and the writer would not call them sections.
    expect(exportFacts(sections, 'pdf', authority.pdfOutline, frameIndex(sections.frames), bookModel(sections.frames, sections.outline?.entries, 4)).features).toEqual([]);
    expect(exportFacts(sections, 'none', null, frameIndex(sections.frames), bookModel(sections.frames, sections.outline?.entries, 4)).features).toEqual([]);
    const full = workbook({ exercises: true });
    expect(exportFacts(full, 'project', null, frameIndex(full.frames), bookModel(full.frames, full.outline?.entries, 4)).features).toEqual(['sections', 'authority', 'solution']);
  });

  it('counts what a person framed, the book exercises per section and how many have a solution', () => {
    const full = workbook({ exercises: true });
    const ordinary = applyOperations(full, [{ op: 'add', kind: 'question', page: 0, rect: [0.1, 0.5, 0.9, 0.52] }, { op: 'add', kind: 'exercise', page: 2, rect: [0.1, 0.6, 0.9, 0.65] }], { pageCount: 4 }).project;
    const facts = exportFacts(ordinary, 'project', null, frameIndex(ordinary.frames), bookModel(ordinary.frames, ordinary.outline?.entries, 4));
    expect(facts.ordinary).toEqual({ exercises: 1, questions: 1, bookmarks: 0 });
    expect(facts.book).toEqual({ exercises: 10, withSolution: 10, withoutSolution: 0, sections: 6, sectionsWithExercises: 3, unfiled: 0 });
    expect(facts.sections.map((row) => [row.label ?? row.title, row.own, row.total, row.totalSolved])).toEqual([
      ['Chapter 1', 0, 8, 8],
      ['1.1', 4, 4, 4],
      ['1.2', 4, 4, 4],
      ['Chapter 2', 0, 2, 2],
      ['2.1', 2, 2, 2],
    ]);
    expect(percent(8, 10)).toBe('80%');
    expect(percent(0, 0)).toBe('0%');
  });

  it('counts the book exercises without a solution and the ones filed under a section that does not exist', async () => {
    const { store } = await started(workbook({ exercises: true }));
    const frame = store.state.project?.frames[0];
    expect(frame).toBeDefined();
    store.removeRegion('solution', (frame as { id: string }).id, 0);
    const project = store.state.project as Project;
    const facts = exportFacts(project, 'project', null, frameIndex(project.frames), store.book());
    expect(facts.book).toMatchObject({ withSolution: 9, withoutSolution: 1 });
  });
});

describe('the store: exporting', () => {
  it('chooses the project\'s own contents when there are book exercises, and the PDF\'s otherwise', async () => {
    const { store } = await started(workbook({ exercises: true, outline: true }));
    store.openExport();
    expect(store.state.exporting).toMatchObject({ open: true, outline: 'project', summary: null });
    store.closeExport();
    const plain = await started(workbook({ outline: false }));
    plain.store.openExport();
    expect(plain.store.state.exporting.outline).toBe('pdf');
  });

  it('shows the importer check of the bundle that was written', async () => {
    const check = { wouldImport: true, features: ['sections', 'authority', 'solution'], frames: 10, outlineEntries: 6, warnings: 1, repairs: 0, steps: [{ step: 1, name: 'archive', status: 'ok', detail: 'opened' }] };
    const { store } = await started(workbook({ exercises: true }), { exportBundle: () => Promise.resolve({ ok: true, path: 'C:/out/book.mcbundle', bytes: 1000, frames: 10, outlineEntries: 6, issues: [], check }) });
    store.openExport();
    await store.runExport();
    const outcome = store.state.exporting.outcome;
    expect(outcome).toMatchObject({ ok: true, check: { features: ['sections', 'authority', 'solution'], frames: 10 } });
  });

  it('writes the book summary next to the bundle, saving first when there are unsaved changes', async () => {
    const calls: string[] = [];
    const { store, api } = await started(workbook({ exercises: true }), {
      exportBookSummary: () => {
        calls.push('summary');
        return Promise.resolve({ ok: true, path: 'C:/out/book.book.json', bytes: 5000, sections: 6, exercises: 10 });
      },
    });
    store.apply([{ op: 'meta.set', author: 'A. Author' }]);
    expect(store.state.dirty).toBe(true);
    store.openExport();
    await store.exportBookSummary();
    expect(api.saved).toHaveLength(1);
    expect(calls).toEqual(['summary']);
    expect(store.state.exporting.summary).toEqual({ ok: true, path: 'C:/out/book.book.json', bytes: 5000, sections: 6, exercises: 10 });
    expect(store.state.exporting.summaryBusy).toBe(false);
  });

  it('says so when the summary cannot be written, and when the project could not be saved first', async () => {
    const failing = await started(workbook({ exercises: true }), { exportBookSummary: () => Promise.resolve({ ok: false, message: 'Disk full.' }) });
    failing.store.openExport();
    await failing.store.exportBookSummary();
    expect(failing.store.state.exporting.summary).toEqual({ ok: false, message: 'Disk full.' });
    const unsaved = await started(workbook({ exercises: true }), { saveProject: () => Promise.resolve({ ok: false, code: 'error', message: 'read-only' }) });
    unsaved.store.apply([{ op: 'meta.set', author: 'A. Author' }]);
    unsaved.store.openExport();
    await unsaved.store.exportBookSummary();
    expect(unsaved.store.state.exporting.summary).toMatchObject({ ok: false });
    expect((unsaved.store.state.exporting.summary as { message: string }).message).toContain('could not be saved first');
  });
});
