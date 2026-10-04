import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, applyOperations, deriveSections, exerciseToOperation, isAuthoritative, newProject, readProjectFile, solutionToOperation, toOutlineEntries, type ExerciseProposal, type Frame, type OutlineEntry, type PageText, type Project, type SolutionProposal } from '@mcprep/core';
import { run } from '@mcprep/cli';
import type { Api, AuditOutcome, BookRequest, BookResult } from '../src/shared/api.js';
import { runExercises, runSolutions, type AuditHooks } from '../src/main/audit.js';
import { bookRows, defaultTicks, describePlan, exerciseRefs, ghostsOn, planBook, viewRows, SURE_FROM, type BookRow } from '../src/renderer/logic/proposals.js';
import { Store } from '../src/renderer/logic/store.js';
import { fakeApi, openedDocument } from './helpers/fake-api.js';

/**
 * The exercises and answers the search finds in a book, in the Propose panel: the rows (new, different, the same), the filters,
 * the findings that are not rows, the batch that applying them writes (the same the command line writes), and the flow in the
 * store. The book is the synthetic textbook: 112 exercises in four sections and the 112 answers of its answer key.
 */

const quiet: AuditHooks = { report: () => undefined, check: () => undefined };

let work: string;
let pdfBytes: Uint8Array;
let pages: PageText[];
let outline: OutlineEntry[];
let exercises: BookResult & { kind: 'exercises' };

beforeAll(async () => {
  const built = await import('@mcprep/core/testing');
  pdfBytes = built.buildSyntheticBook().pdf;
  work = mkdtempSync(join(tmpdir(), 'mcprep-proposals-'));
  const pdf = await PdfDocument.fromBytes(pdfBytes);
  pages = await pdf.allPageText({ fonts: true });
  outline = toOutlineEntries(deriveSections(pages));
  exercises = (await runExercises(pdf, { kind: 'exercises', outline }, quiet)) as BookResult & { kind: 'exercises' };
  await pdf.close();
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sectionsProject = (): Project => {
  const base = newProject({ pdf: { path: 'book.pdf', sha256: 'e'.repeat(64), bytes: pdfBytes.length, pageCount: pages.length }, title: 'Synthetic Algebra Workbook', now: new Date('2026-10-04T12:00:00Z') });
  return applyOperations(base, [{ op: 'outline.set', entries: outline, source: 'derived' }], { pageCount: pages.length }).project;
};

/** The project with every proposed exercise applied. */
function withExercises(): Project {
  const project = sectionsProject();
  const model = bookRows(exercises, project.frames);
  const plan = planBook('exercises', model.rows, new Set(model.rows.map((row) => row.key)));
  return applyOperations(project, plan.operations, { pageCount: pages.length }).project;
}

async function solutionsFor(project: Project): Promise<BookResult & { kind: 'solutions' }> {
  const pdf = await PdfDocument.fromBytes(pdfBytes);
  const result = await runSolutions(pdf, { kind: 'solutions', outline, exercises: exerciseRefs(project.frames) }, quiet);
  await pdf.close();
  return result as BookResult & { kind: 'solutions' };
}

const clone = <T>(value: T): T => structuredClone(value);

describe('the rows of the exercises the search found', () => {
  it('has a row for each exercise, named SECTION:LABEL, new when the book has none yet', () => {
    const model = bookRows(exercises, sectionsProject().frames);
    expect(model.rows).toHaveLength(112);
    expect(model.counts).toMatchObject({ total: 112, new: 112, different: 0, same: 0, refused: 0 });
    expect(model.rows[0]).toMatchObject({ key: '0.1:1', section: '0.1', label: '1', state: 'new', frame: undefined, page: 5, title: '1) 8 - 7' });
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(112);
    expect(model.byKey.get('1.2:16')?.section).toBe('1.2');
    // The ghost of an exercise: its frame and the instruction that governs it.
    expect(model.rows[0]?.pieces.map((piece) => piece.role)).toEqual(['main', 'context']);
    expect(Object.keys(defaultTicks(model.rows))).toHaveLength(112);
  });

  it('is built once for a result and a version of the frames', () => {
    const project = sectionsProject();
    expect(bookRows(exercises, project.frames)).toBe(bookRows(exercises, project.frames));
    expect(bookRows(exercises, [...project.frames])).not.toBe(bookRows(exercises, project.frames));
  });

  it('says that the book has them all when it has: nothing new, nothing different, nothing ticked', () => {
    const model = bookRows(exercises, withExercises().frames);
    expect(model.counts).toMatchObject({ total: 112, new: 0, different: 0, same: 112 });
    expect(Object.keys(defaultTicks(model.rows))).toEqual([]);
    const plan = planBook('exercises', model.rows, new Set(model.rows.map((row) => row.key)));
    expect(plan.operations).toEqual([]);
    expect(plan.skipped).toBe(112);
  });

  it('calls an exercise the book has differently different, says how, and replaces it only when asked', () => {
    const project = withExercises();
    const moved = project.frames.map((frame) => (frame.label === '3' && frame.section === '0.1' ? { ...frame, rect: { ...frame.rect, top: frame.rect.top + 0.01, bottom: frame.rect.bottom + 0.01 } } : frame));
    const model = bookRows(exercises, moved);
    expect(model.counts).toMatchObject({ different: 1, same: 111, new: 0 });
    const row = model.byKey.get('0.1:3') as BookRow;
    expect(row.state).toBe('different');
    expect(row.changes).toEqual(['its frame is somewhere else or has another size']);
    expect(row.frame?.id).toBeDefined();
    // Without a tick it is not part of "apply all"; ticked, it replaces the book's own in place.
    expect(planBook('exercises', model.rows, new Set()).operations).toEqual([]);
    const plan = planBook('exercises', model.rows, new Set(['0.1:3']));
    expect(plan.operations).toEqual([exerciseToOperation(row.proposal as ExerciseProposal, { replace: true })]);
    expect(plan).toMatchObject({ added: 0, replaced: 1 });
    const after = applyOperations({ ...project, frames: moved }, plan.operations, { pageCount: pages.length }).project;
    expect(bookRows(exercises, after.frames).counts).toMatchObject({ same: 112, different: 0 });
    expect(after.frames).toHaveLength(112);
    expect(after.frames.find((frame) => frame.label === '3' && frame.section === '0.1')?.id).toBe(row.frame?.id);
  });

  it('says what differs: the page, the instruction, the part on the next page', () => {
    const project = withExercises();
    const other = project.frames.map((frame) => {
      if (frame.section === '0.2' && frame.label === '1') return { ...frame, page: frame.page + 1 };
      if (frame.section === '0.2' && frame.label === '2') {
        const copy = { ...frame };
        delete copy.context;
        return copy;
      }
      return frame;
    });
    const model = bookRows(exercises, other);
    expect(model.byKey.get('0.2:1')?.changes[0]).toMatch(/^it is on page \d+ in the book, the search found it on page \d+$/);
    expect(model.byKey.get('0.2:2')?.changes).toContain('its instruction differs');
  });

  it('cannot apply a number the bundle does not allow, and says so', () => {
    const result = clone(exercises);
    const first = result.exercises.sections[0]?.proposals[0] as ExerciseProposal;
    first.label = '$5';
    const model = bookRows(result, sectionsProject().frames);
    const row = model.byKey.get('0.1:$5') as BookRow;
    expect(row.refusal).toContain('is not a label the bundle allows');
    expect(model.counts.refused).toBe(1);
    expect(defaultTicks(model.rows)['0.1:$5']).toBeUndefined();
    const plan = planBook('exercises', model.rows, new Set(['0.1:$5', '0.1:2']));
    expect(plan.operations).toHaveLength(1);
    expect(plan.refused.map((entry) => entry.key)).toEqual(['0.1:$5']);
    expect(describePlan('exercises', plan)).toBe('Added 1 book exercise; 1 left out (0.1:$5). Undo takes it back.');
    expect(model.findings.find((group) => group.title === 'Left out')?.lines[0]?.text).toContain('0.1:$5');
  });
});

describe('what the list shows', () => {
  const rejectedOf = (...keys: string[]): Record<string, true> => Object.fromEntries(keys.map((key) => [key, true as const]));

  function mixed(): { rows: BookRow[] } {
    const project = withExercises();
    const frames = project.frames
      .filter((frame) => !(frame.section === '1.1' && Number(frame.label) > 9)) // three of 1.1 are not in the book
      .map((frame) => (frame.section === '1.2' && frame.label === '1' ? { ...frame, page: frame.page + 1 } : frame));
    return { rows: bookRows(exercises, frames).rows };
  }

  it('lists what is new or different by default and takes the dismissed ones out', () => {
    const { rows } = mixed();
    expect(viewRows(rows, { filter: 'todo', confidence: 'any', rejected: {} }).map((row) => row.key)).toEqual(['1.1:10', '1.1:11', '1.1:12', '1.2:1']);
    expect(viewRows(rows, { filter: 'new', confidence: 'any', rejected: {} })).toHaveLength(3);
    expect(viewRows(rows, { filter: 'different', confidence: 'any', rejected: {} }).map((row) => row.key)).toEqual(['1.2:1']);
    expect(viewRows(rows, { filter: 'same', confidence: 'any', rejected: {} })).toHaveLength(108);
    expect(viewRows(rows, { filter: 'all', confidence: 'any', rejected: {} })).toHaveLength(112);
    const dismissed = rejectedOf('1.1:11');
    expect(viewRows(rows, { filter: 'todo', confidence: 'any', rejected: dismissed }).map((row) => row.key)).toEqual(['1.1:10', '1.1:12', '1.2:1']);
    expect(viewRows(rows, { filter: 'all', confidence: 'any', rejected: dismissed })).toHaveLength(111);
    expect(viewRows(rows, { filter: 'rejected', confidence: 'any', rejected: dismissed }).map((row) => row.key)).toEqual(['1.1:11']);
  });

  it('filters by how sure the search is, and by a text', () => {
    const { rows } = mixed();
    const sure = viewRows(rows, { filter: 'all', confidence: 'sure', rejected: {} });
    const unsure = viewRows(rows, { filter: 'all', confidence: 'unsure', rejected: {} });
    expect(sure.every((row) => row.confidence >= SURE_FROM)).toBe(true);
    expect(unsure.every((row) => row.confidence < SURE_FROM)).toBe(true);
    expect(sure.length + unsure.length).toBe(112);
    expect(viewRows(rows, { filter: 'all', confidence: 'any', rejected: {}, query: '1.2:1' }).map((row) => row.key)).toEqual(['1.2:1', '1.2:10', '1.2:11', '1.2:12', '1.2:13', '1.2:14', '1.2:15', '1.2:16']);
    expect(viewRows(rows, { filter: 'all', confidence: 'any', rejected: {}, query: '  8 - 7 ' }).map((row) => row.key)).toContain('0.1:1');
    expect(viewRows(rows, { filter: 'all', confidence: 'any', rejected: {}, query: 'nothing like this' })).toEqual([]);
  });

  it('has the ghosts of a page: only the rows of that page, built once for a list', () => {
    const { rows } = mixed();
    const onFive = ghostsOn(rows, 5);
    expect(onFive.length).toBeGreaterThan(10);
    expect(onFive.every(({ piece }) => piece.page === 5)).toBe(true);
    expect(ghostsOn(rows, 5)).toBe(onFive);
    expect(ghostsOn(rows, 0)).toEqual([]);
    // The instruction of an exercise is drawn on its own page, which can be another one.
    expect(onFive.some(({ piece }) => piece.role === 'context')).toBe(true);
  });
});

describe('the batch that applying writes', () => {
  it('is the batch the command line writes: the same operations in the same order, and the same project comes out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprep-cross-'));
    try {
      writeFileSync(join(dir, 'book.pdf'), pdfBytes);
      const cli = async (...args: string[]): Promise<{ code: number; out: string }> => {
        let out = '';
        const code = await run([...args, '--json'], { stdout: (text) => (out += text), stderr: () => undefined, stdin: () => Promise.resolve(''), cwd: dir, env: {} });
        return { code, out };
      };
      expect((await cli('init', 'book.pdf', '--title', 'Synthetic Algebra Workbook')).code).toBe(0);
      expect((await cli('outline', 'derive', '--book', '--apply')).code).toBe(0);
      const proposed = await cli('exercises', 'propose', '--ops', 'ops.json', '--details', 'details.json');
      expect(proposed.code).toBe(0);
      const { readFileSync } = await import('node:fs');
      const cliOps = (JSON.parse(readFileSync(join(dir, 'ops.json'), 'utf8')) as { operations: unknown[] }).operations;
      const cliProposals = (JSON.parse(readFileSync(join(dir, 'details.json'), 'utf8')) as { proposals: ExerciseProposal[] }).proposals;
      // The search of the main process finds the proposals the command line finds.
      expect(JSON.parse(JSON.stringify(exercises.exercises.sections.flatMap((section) => section.proposals)))).toEqual(cliProposals);
      // The batch of "apply all" is the batch of --ops.
      const project = (await readProjectFile(join(dir, 'book.mcprep.json'))) as Project;
      const model = bookRows(exercises, project.frames);
      const plan = planBook('exercises', model.rows, new Set(Object.keys(defaultTicks(model.rows))));
      expect(JSON.parse(JSON.stringify(plan.operations))).toEqual(cliOps);
      // And applying it, in the window and by the command line, gives the same frames.
      expect((await cli('exercises', 'propose', '--apply')).code).toBe(0);
      const byCli = (await readProjectFile(join(dir, 'book.mcprep.json'))) as Project;
      const byWindow = applyOperations(project, plan.operations, { pageCount: pages.length }).project;
      expect(byWindow.frames).toEqual(byCli.frames);
      expect(byCli.frames).toHaveLength(112);
      // The answers: the same, again.
      const answers = await solutionsFor(byWindow);
      const solutionModel = bookRows(answers, byWindow.frames);
      const solutionPlan = planBook('solutions', solutionModel.rows, new Set(Object.keys(defaultTicks(solutionModel.rows))));
      expect((await cli('solutions', 'propose', '--ops', 'solutions.json')).code).toBe(0);
      const cliSolutionOps = (JSON.parse(readFileSync(join(dir, 'solutions.json'), 'utf8')) as { operations: unknown[] }).operations;
      expect(JSON.parse(JSON.stringify(solutionPlan.operations))).toEqual(cliSolutionOps);
      expect((await cli('solutions', 'propose', '--apply')).code).toBe(0);
      const solvedByCli = (await readProjectFile(join(dir, 'book.mcprep.json'))) as Project;
      const solvedByWindow = applyOperations(byWindow, solutionPlan.operations, { pageCount: pages.length }).project;
      expect(solvedByWindow.frames).toEqual(solvedByCli.frames);
      expect(solvedByCli.frames.every((frame) => (frame.solution?.length ?? 0) > 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('takes a new exercise, replaces a different one only when ticked, and skips the same', () => {
    const project = withExercises();
    const frames = project.frames
      .filter((frame) => !(frame.section === '1.1' && frame.label === '12'))
      .map((frame) => (frame.section === '1.2' && frame.label === '1' ? { ...frame, page: frame.page + 1 } : frame));
    const model = bookRows(exercises, frames);
    const everything = new Set(model.rows.map((row) => row.key));
    const plan = planBook('exercises', model.rows, everything);
    expect(plan).toMatchObject({ added: 1, replaced: 1, skipped: 110 });
    expect(plan.operations).toHaveLength(2);
    expect(plan.operations.map((operation) => ('replace' in operation && operation.replace === true ? 'replace' : 'add'))).toEqual(['add', 'replace']);
    expect(describePlan('exercises', plan)).toBe('Added 1 book exercise, replaced 1 book exercise. Undo takes it back.');
    expect(describePlan('solutions', { operations: [], added: 3, replaced: 1, skipped: 0, refused: [] })).toBe('Gave 3 exercises their solution, replaced 1 solution. Undo takes it back.');
  });
});

describe('the answers the search found', () => {
  it('has a row for each answer of an exercise the book has, new when the exercise has no solution yet', async () => {
    const project = withExercises();
    const answers = await solutionsFor(project);
    const model = bookRows(answers, project.frames);
    expect(model.rows).toHaveLength(112);
    expect(model.counts).toMatchObject({ new: 112, different: 0, same: 0 });
    const first = model.rows[0] as BookRow;
    expect(first).toMatchObject({ key: '0.1:1', state: 'new', title: '1) -11' });
    expect(first.pieces.map((piece) => piece.role)).toEqual(['solution']);
    expect(first.page).toBeGreaterThanOrEqual(18); // the answer key is at the back
    expect(first.frame?.id).toBeDefined();
    const plan = planBook('solutions', model.rows, new Set(Object.keys(defaultTicks(model.rows))));
    expect(plan.operations[0]).toEqual(solutionToOperation('0.1:1', (first.proposal as SolutionProposal).regions));
    expect(plan.added).toBe(112);
  });

  it('is the same once applied, different when the exercise has another solution', async () => {
    const project = withExercises();
    const answers = await solutionsFor(project);
    const rows = bookRows(answers, project.frames).rows;
    const solved = applyOperations(project, planBook('solutions', rows, new Set(rows.map((row) => row.key))).operations, { pageCount: pages.length }).project;
    expect(bookRows(answers, solved.frames).counts).toMatchObject({ same: 112, new: 0, different: 0 });
    const tampered = solved.frames.map((frame) => (frame.section === '1.1' && frame.label === '2' ? { ...frame, solution: [{ page: 20, rect: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.25 } }] } : frame));
    const model = bookRows(answers, tampered);
    expect(model.byKey.get('1.1:2')).toMatchObject({ state: 'different', changes: ['its solution is somewhere else in the answer key'] });
    const plan = planBook('solutions', model.rows, new Set(['1.1:2']));
    expect(plan).toMatchObject({ added: 0, replaced: 1 });
  });

  it('lists the answers without an exercise and the exercises without an answer, live', async () => {
    const project = withExercises();
    const answers = await solutionsFor(project);
    // Two exercises of 1.1 are not in the book: their answers have no exercise.
    const fewer = project.frames.filter((frame) => !(frame.section === '1.1' && (frame.label === '11' || frame.label === '12')));
    const model = bookRows(answers, fewer);
    expect(model.rows).toHaveLength(110);
    expect(model.findings.find((group) => group.title === 'Answers without an exercise in the book')?.lines).toEqual([{ section: '1.1', text: '1.1: 11, 12' }]);
    // An answer that the search did not find: its exercise has none.
    const missing = clone(answers);
    missing.solutions.sections.find((section) => section.section === '0.2')!.answers.splice(0, 2);
    const without = bookRows(missing, project.frames);
    expect(without.findings.find((group) => group.title === 'Exercises without an answer')?.lines).toEqual([{ section: '0.2', text: '0.2: 1, 2' }]);
  });

  it('cannot apply an answer that would need more than eight regions', async () => {
    const project = withExercises();
    const answers = clone(await solutionsFor(project));
    const answer = answers.solutions.sections[0]?.answers[0] as SolutionProposal;
    answer.regions = Array.from({ length: 9 }, (_unused, at) => ({ page: 18, rect: { left: 0.1, top: 0.1 + at * 0.05, right: 0.3, bottom: 0.13 + at * 0.05 } }));
    const model = bookRows(answers, project.frames);
    expect(model.byKey.get('0.1:1')?.refusal).toBe('its answer would need 9 regions, at most 8 are allowed');
    expect(planBook('solutions', model.rows, new Set(['0.1:1'])).refused).toHaveLength(1);
  });
});

describe('the search in the main process', () => {
  it('finds the exercises of the sections of the window, all of them or one', async () => {
    const pdf = await PdfDocument.fromBytes(pdfBytes);
    const one = (await runExercises(pdf, { kind: 'exercises', outline, sections: ['1.1'] }, quiet)) as BookResult & { kind: 'exercises' };
    expect(one.exercises.sections.map((section) => [section.section, section.proposals.length])).toEqual([['1.1', 12]]);
    const byLabel = (await runExercises(pdf, { kind: 'exercises', outline, sections: ['0.2'] }, quiet)) as BookResult & { kind: 'exercises' };
    expect(byLabel.exercises.sections.map((section) => section.section)).toEqual(['0.2']);
    await pdf.close();
  });

  it('says in plain words what is missing: sections with ids, a section that exists, exercises to match the answers to', async () => {
    const pdf = await PdfDocument.fromBytes(pdfBytes);
    const flat: OutlineEntry[] = outline.map(({ title, page, depth }) => ({ title, page, depth }));
    await expect(runExercises(pdf, { kind: 'exercises', outline: flat }, quiet)).rejects.toThrow('The book has no sections with ids yet');
    await expect(runExercises(pdf, { kind: 'exercises', outline, sections: ['9.9'] }, quiet)).rejects.toThrow('There is no section "9.9"');
    await expect(runSolutions(pdf, { kind: 'solutions', outline, exercises: [] }, quiet)).rejects.toThrow('The book has no book exercises yet');
    await pdf.close();
  });

  it('reports its steps and stops between pages', async () => {
    const pdf = await PdfDocument.fromBytes(pdfBytes);
    const phases: string[] = [];
    await runExercises(pdf, { kind: 'exercises', outline }, { report: (phase) => phases.push(phase), check: () => undefined });
    expect([...new Set(phases)]).toEqual(['Reading the text of the pages', 'Looking at the white between the lines', 'Looking for the exercises']);
    let checks = 0;
    await expect(
      runExercises(pdf, { kind: 'exercises', outline }, {
        report: () => undefined,
        check: () => {
          checks += 1;
          if (checks > 25) throw new Error('stopped');
        },
      }),
    ).rejects.toThrow('stopped');
    expect(checks).toBe(26); // 21 pages are read, the practice pages are looked at next: it stops there
    await pdf.close();
  });
});

// ---------------------------------------------------------------------------------------------------------- the store

type Fake = ReturnType<typeof fakeApi>;

async function opened(project: Project, overrides: Partial<Api> = {}): Promise<{ store: Store; api: Fake; requests: BookRequest[] }> {
  const requests: BookRequest[] = [];
  const api = fakeApi(
    { pdf: () => pdfBytes, texts: () => pages, fresh: () => project },
    {
      proposeBook: (request) => {
        requests.push(request);
        return Promise.resolve({ ok: true, result: request.kind === 'exercises' ? exercises : ({ kind: 'solutions', solutions: { sections: [], notes: [] }, notes: [] } as BookResult) });
      },
      ...overrides,
    },
  );
  const store = new Store(api);
  await store.openDocument(openedDocument(project, pages.length, null));
  return { store, api, requests };
}

const keysOf = (rows: readonly BookRow[]): string[] => rows.map((row) => row.key);

describe('looking for the exercises in the store', () => {
  it('asks the main process with the window’s own sections, shows what it found and applies nothing', async () => {
    const project = sectionsProject();
    const { store, requests } = await opened(project);
    await store.proposeBook('exercises');
    expect(requests).toEqual([{ kind: 'exercises', outline }]);
    expect(store.state.tab).toBe('propose');
    expect(store.state.proposeMode).toBe('exercises');
    expect(store.state.audit).toEqual({ job: null, stopping: false });
    expect(store.state.project).toBe(project);
    const review = store.bookReview('exercises');
    expect(review?.filter).toBe('todo');
    expect(Object.keys(review?.ticked ?? {})).toHaveLength(112);
    expect(store.bookModel('exercises')?.counts.new).toBe(112);
    expect(store.bookListed('exercises')).toBe(store.bookListed('exercises'));
  });

  it('can be limited to one section, which is what "Find its exercises" does', async () => {
    const { store, requests } = await opened(sectionsProject());
    await store.proposeBook('exercises', { scope: '1.2' });
    expect(requests[0]).toEqual({ kind: 'exercises', outline, sections: ['1.2'] });
    expect(store.state.bookScope).toBe('1.2');
  });

  it('applies all as one undoable step, says what it did, and is quiet when run again', async () => {
    const project = sectionsProject();
    const { store } = await opened(project);
    await store.proposeBook('exercises');
    const keys = store.applicableKeys('exercises', store.bookListed('exercises'), 'all');
    expect(keys).toHaveLength(112);
    const result = store.applyBook('exercises', keys);
    expect(result.ok).toBe(true);
    expect((store.state.project as Project).frames.filter(isAuthoritative)).toHaveLength(112);
    expect(store.state.past).toHaveLength(1);
    expect(store.bookReview('exercises')?.summary).toBe('Added 112 book exercises. Undo takes it back.');
    expect(store.state.notice).toMatchObject({ kind: 'success', text: 'Added 112 book exercises. Undo takes it back.' });
    expect(store.bookModel('exercises')?.counts).toMatchObject({ new: 0, same: 112 });
    expect(store.bookListed('exercises')).toEqual([]);
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'all')).toEqual([]);
    // Looking again finds the same, and nothing to do.
    await store.proposeBook('exercises');
    expect(store.bookReview('exercises')?.filter).toBe('all');
    expect(store.bookModel('exercises')?.counts).toMatchObject({ total: 112, same: 112, new: 0, different: 0 });
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'all')).toEqual([]);
    expect(store.applyBook('exercises', []).ok).toBe(false);
    expect(store.bookReview('exercises')?.error).toBe('Nothing is selected.');
    expect(store.state.past).toHaveLength(1);
    store.undo();
    expect((store.state.project as Project).frames).toHaveLength(0);
    expect(store.bookModel('exercises')?.counts.new).toBe(112);
  });

  it('applies only what is ticked, and not what was dismissed', async () => {
    const { store } = await opened(sectionsProject());
    await store.proposeBook('exercises');
    store.tickRows('exercises', store.bookListed('exercises'), false);
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'selected')).toEqual([]);
    store.tickBook('exercises', '1.1:1', true);
    store.tickBook('exercises', '1.1:2', true);
    store.rejectBook('exercises', '1.1:2', true);
    expect(store.bookReview('exercises')?.ticked['1.1:2']).toBeUndefined();
    expect(keysOf(store.bookListed('exercises'))).not.toContain('1.1:2');
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'selected')).toEqual(['1.1:1']);
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'all')).toHaveLength(111);
    store.applyBook('exercises', ['1.1:1']);
    expect((store.state.project as Project).frames.map((frame) => `${frame.section}:${frame.label}`)).toEqual(['1.1:1']);
    // The dismissal can be taken back.
    store.setBookFilter('exercises', 'rejected');
    expect(keysOf(store.bookListed('exercises'))).toEqual(['1.1:2']);
    store.rejectBook('exercises', '1.1:2', false);
    store.setBookFilter('exercises', 'new');
    expect(keysOf(store.bookListed('exercises'))).toContain('1.1:2');
  });

  it('replaces a different exercise only when it is ticked', async () => {
    const full = withExercises();
    const moved = { ...full, frames: full.frames.map((frame) => (frame.section === '0.2' && frame.label === '4' ? { ...frame, rect: { ...frame.rect, left: frame.rect.left + 0.02, right: frame.rect.right + 0.02 } } : frame)) };
    const { store } = await opened(moved);
    await store.proposeBook('exercises');
    expect(store.bookReview('exercises')?.filter).toBe('todo');
    expect(keysOf(store.bookListed('exercises'))).toEqual(['0.2:4']);
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'all')).toEqual([]); // different ones are never taken without a tick
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'selected')).toEqual([]);
    store.tickBook('exercises', '0.2:4', true);
    expect(store.applicableKeys('exercises', store.bookListed('exercises'), 'selected')).toEqual(['0.2:4']);
    const before = (store.state.project as Project).frames.find((frame) => frame.section === '0.2' && frame.label === '4') as Frame;
    expect(store.applyBook('exercises', ['0.2:4']).ok).toBe(true);
    const after = (store.state.project as Project).frames.find((frame) => frame.section === '0.2' && frame.label === '4') as Frame;
    expect(after.id).toBe(before.id);
    expect(after.rect).not.toEqual(before.rect);
    expect(store.bookReview('exercises')?.summary).toBe('Replaced 1 book exercise. Undo takes it back.');
  });

  it('refuses a batch that would make the book invalid, says why, and changes nothing', async () => {
    const project = sectionsProject();
    const broken = clone(exercises);
    (broken.exercises.sections[0]?.proposals[0] as ExerciseProposal).section = 'no-such-section';
    const { store } = await opened(project, { proposeBook: () => Promise.resolve({ ok: true, result: broken }) });
    await store.proposeBook('exercises');
    const result = store.applyBook('exercises', store.applicableKeys('exercises', store.bookListed('exercises'), 'all'));
    expect(result.ok).toBe(false);
    expect(store.bookReview('exercises')?.error).toBe('Not applied: The section "no-such-section" does not exist.');
    expect(store.state.project).toBe(project);
    expect(store.state.past).toHaveLength(0);
  });

  it('shows why a search found nothing to look at, and a failure', async () => {
    const failing = await opened(sectionsProject(), { proposeBook: () => Promise.resolve({ ok: false, cancelled: false, message: 'The book has no sections with ids yet.' }) });
    await failing.store.proposeBook('exercises');
    expect(failing.store.state.bookMessage).toEqual({ kind: 'exercises', text: 'The book has no sections with ids yet.' });
    expect(failing.store.bookReview('exercises')).toBeNull();
    expect(failing.store.state.audit.job).toBeNull();
    const throwing = await opened(sectionsProject(), { proposeBook: () => Promise.reject(new Error('boom')) });
    await throwing.store.proposeBook('solutions');
    expect(throwing.store.state.bookMessage).toEqual({ kind: 'solutions', text: 'boom' });
  });

  it('asks the answers of the exercises the book has, and keeps the two searches apart', async () => {
    const project = withExercises();
    const { store, requests } = await opened(project);
    await store.proposeBook('solutions');
    expect(requests[0]?.kind).toBe('solutions');
    expect((requests[0] as { exercises: unknown[] }).exercises).toHaveLength(112);
    expect(store.state.proposeMode).toBe('solutions');
    expect(store.bookReview('solutions')).not.toBeNull();
    expect(store.bookReview('exercises')).toBeNull();
    await store.proposeBook('exercises');
    expect(store.bookReview('solutions')).not.toBeNull();
    expect(store.bookReview('exercises')).not.toBeNull();
    expect(store.state.proposeMode).toBe('exercises');
    store.discardBook('exercises');
    expect(store.bookReview('exercises')).toBeNull();
  });

  it('goes to the page of a proposal and names its ghost', async () => {
    const { store } = await opened(sectionsProject());
    await store.proposeBook('exercises');
    store.focusBook('exercises', '1.2:3');
    expect(store.bookReview('exercises')?.focus).toBe('1.2:3');
    expect(store.state.focus.ghost).toBe('book:1.2:3');
    expect(store.state.page).toBe(store.bookModel('exercises')?.byKey.get('1.2:3')?.page);
  });

  it('a new document starts without proposals', async () => {
    const { store } = await opened(sectionsProject());
    await store.proposeBook('exercises');
    await store.openDocument(openedDocument(sectionsProject(), pages.length, null));
    expect(store.bookReview('exercises')).toBeNull();
    expect(store.state.proposeMode).toBe('frames');
  });
});

describe('a long search for the exercises: progress, stopping, one at a time', () => {
  function pending(): { promise: Promise<AuditOutcome<BookResult>>; finish: (outcome: AuditOutcome<BookResult>) => void } {
    let finish: (outcome: AuditOutcome<BookResult>) => void = () => undefined;
    const promise = new Promise<AuditOutcome<BookResult>>((resolve) => {
      finish = resolve;
    });
    return { promise, finish };
  }

  it('shows the job, stops on request and changes nothing', async () => {
    const wait = pending();
    let cancelled = 0;
    const { store } = await opened(sectionsProject(), {
      proposeBook: () => wait.promise,
      cancelAudit: () => {
        cancelled += 1;
        wait.finish({ ok: false, cancelled: true, message: 'Stopped.' });
        return Promise.resolve();
      },
    });
    const running = store.proposeBook('exercises');
    expect(store.state.audit).toEqual({ job: 'exercises', stopping: false });
    store.reportProgress({ phase: 'Looking at the white between the lines', done: 3, total: 40 });
    expect(store.progress.value?.done).toBe(3);
    store.cancelAudit();
    await running;
    expect(cancelled).toBe(1);
    expect(store.state.audit).toEqual({ job: null, stopping: false });
    expect(store.bookReview('exercises')).toBeNull();
    expect(store.state.notice?.text).toBe('Stopped. Nothing was changed.');
  });

  it('does not run two searches at once, nor a search while the sections are being derived', async () => {
    const wait = pending();
    let calls = 0;
    const { store } = await opened(sectionsProject(), {
      proposeBook: () => {
        calls += 1;
        return wait.promise;
      },
    });
    const first = store.proposeBook('exercises');
    await store.proposeBook('solutions');
    await store.deriveSections();
    expect(calls).toBe(1);
    wait.finish({ ok: true, result: exercises });
    await first;
    expect(store.bookReview('exercises')).not.toBeNull();
  });

  it('ignores the answer for a document that is no longer open', async () => {
    const wait = pending();
    const { store } = await opened(sectionsProject(), { proposeBook: () => wait.promise });
    const running = store.proposeBook('exercises');
    await store.openDocument(openedDocument(sectionsProject(), pages.length, null));
    wait.finish({ ok: true, result: exercises });
    await running;
    expect(store.bookReview('exercises')).toBeNull();
    expect(store.state.audit.job).toBeNull();
  });
});
