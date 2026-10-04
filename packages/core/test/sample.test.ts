import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Frame, OutlineEntry, PageText, Rect, TextLine } from '../src/model/types.js';
import { bookExercisesInOrder } from '../src/book/summary.js';
import { newProject, type Project } from '../src/project/model.js';
import { EXERCISE_REASONS, SAMPLE_FORMAT, SAMPLE_VERSION, SOLUTION_REASONS, type SampleReport } from '../src/sample/types.js';
import { pagesToSample, sampleProject } from '../src/sample/sample.js';
import { Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * A book of three sections in two chapters with every layout the rules name: a continuation, an instruction on another page,
 * two exercises in a row, three in a row, a narrow (small) region, a tall one (a figure), an answer of three lines and an answer
 * that is a picture. Book order: s1:1..6, s1:... s2:1..4, s3:1..5 (15 exercises). Chapter c1 holds s1 and s2, chapter c2 holds s3.
 */
function book(): { workbook: Workbook; frames: Map<string, Frame> } {
  const workbook = new Workbook(7);
  workbook.outline = sectionEntries([
    { id: 'c1', page: 0, depth: 0, top: 0.01 },
    { id: 's1', page: 0, depth: 1, top: 0.02 },
    { id: 's2', page: 1, depth: 1, top: 0.02 },
    { id: 'c2', page: 3, depth: 0, top: 0.01 },
    { id: 's3', page: 3, depth: 1, top: 0.02 },
    { id: 'key', page: 5, depth: 0, top: 0.01 },
  ]);
  const frames = new Map<string, Frame>();
  const add = (frame: Frame): Frame => {
    frames.set(`${frame.section as string}:${frame.label as string}`, frame);
    return frame;
  };
  let answer = 0;
  const answerOf = (frame: Frame, text: string, extra = 0): void => {
    const y = 100 + 20 * answer;
    workbook.answer(frame, 5, 72, y, `${frame.label as string}. ${text}`);
    if (extra > 0) {
      workbook.text(5, 72, y + 14, 'second line of the answer');
      workbook.text(5, 72, y + 28, 'third line of the answer');
      frame.solution = [around(5, 72, y, { lines: 3, leading: 14 })];
    }
    answer += extra > 0 ? 3 : 1;
  };
  for (let n = 1; n <= 6; n += 1) {
    const frame = add(workbook.exercise('s1', String(n), 0, 72, 100 + 40 * (n - 1)));
    if (n === 3) frame.rect = { ...frame.rect, right: frame.rect.left + 0.1 };
    answerOf(frame, String(n * 7), n === 2 ? 1 : 0);
  }
  const s21 = add(workbook.exercise('s2', '1', 1, 72, 100));
  s21.continues = [{ page: 2, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.14 } }];
  const s22 = add(workbook.exercise('s2', '2', 1, 72, 140));
  s22.context = [{ page: 0, rect: { left: 0.1, top: 0.7, right: 0.9, bottom: 0.73 } }];
  const s23 = add(workbook.exercise('s2', '3', 1, 72, 200, { width: 190 }));
  const s24 = add(workbook.exercise('s2', '4', 1, 320, 200, { width: 190 }));
  for (const frame of [s21, s22, s23, s24]) answerOf(frame, '42');
  const s31 = add(workbook.exercise('s3', '1', 3, 72, 100, { width: 140 }));
  const s32 = add(workbook.exercise('s3', '2', 3, 230, 100, { width: 140 }));
  const s33 = add(workbook.exercise('s3', '3', 3, 390, 100, { width: 140 }));
  const s34 = add(workbook.exercise('s3', '4', 3, 72, 300));
  s34.rect = { ...s34.rect, top: 0.3, bottom: 0.45 };
  const s35 = add(workbook.exercise('s3', '5', 3, 72, 500));
  for (const frame of [s31, s32, s33]) answerOf(frame, '5');
  // The answer to s3:4 is a picture on a scanned page.
  workbook.scan[6] = [{ left: 0.1, top: 0.2, right: 0.5, bottom: 0.25 }];
  s34.solution = [{ page: 6, rect: { left: 0.1, top: 0.19, right: 0.5, bottom: 0.26 } }];
  answerOf(s35, '9');
  return { workbook, frames };
}

async function sample(options: Parameters<typeof sampleProject>[2] = {}, change?: (frames: Map<string, Frame>) => void): Promise<SampleReport> {
  const { workbook, frames } = book();
  change?.(frames);
  return sampleProject(workbook.project(), await pagesOf(workbook.pdf()), options);
}

const listing = (report: SampleReport, which: 'exercises' | 'solutions'): [string, string][] => report[which].map((entry) => [entry.ref, entry.reasons.join('+')]);

describe('the sample of exercises is capped, and the rules come in this order: layouts, chapters, sections, the rest', () => {
  it('is every exercise when the book has fewer than the cap, each with the first rule that picked it first', async () => {
    const report = await sample();
    expect(report.format).toBe(SAMPLE_FORMAT);
    expect(report.version).toBe(SAMPLE_VERSION);
    expect(report.options).toEqual({ exercises: 40, solutions: 20, perSection: false });
    expect(listing(report, 'exercises')).toEqual([
      ['s1:1', 'first-in-section'],
      ['s1:2', 'stride'],
      ['s1:3', 'smallest'],
      ['s1:4', 'stride'],
      ['s1:5', 'stride'],
      ['s1:6', 'last-in-section'],
      ['s2:1', 'has-continuation+first-in-section'],
      ['s2:2', 'context-on-another-page'],
      ['s2:3', 'two-in-a-row'],
      ['s2:4', 'last-in-section'],
      ['s3:1', 'three-in-a-row+first-in-section'],
      ['s3:2', 'stride'],
      ['s3:3', 'stride'],
      ['s3:4', 'longest+beside-a-figure'],
      ['s3:5', 'last-in-section'],
    ]);
    expect(report.summary).toEqual({ sections: 3, exercises: 15, withSolution: 15, sampledExercises: 15, sampledSolutions: 15 });
    expect(report.exercises.every((entry) => entry.kind === 'exercise' && entry.region === 'main')).toBe(true);
    expect(report.exercises.find((entry) => entry.ref === 's2:2')).toMatchObject({ reason: 'context-on-another-page', page: 1 });
    expect(report.notes).toEqual([]);
  });

  it('is cut to the cap: the layouts first, then the first and the last exercise of the chapters, then a stride of sections, then the rest', async () => {
    const report = await sample({ exercises: 10, solutions: 3 });
    expect(listing(report, 'exercises')).toEqual([
      ['s1:1', 'first-in-section'],
      ['s1:2', 'stride'],
      ['s1:3', 'smallest'],
      ['s2:1', 'has-continuation'],
      ['s2:2', 'context-on-another-page'],
      ['s2:3', 'two-in-a-row'],
      ['s2:4', 'last-in-section'],
      ['s3:1', 'three-in-a-row+first-in-section'],
      ['s3:4', 'longest+beside-a-figure'],
      ['s3:5', 'last-in-section'],
    ]);
    expect(report.notes).toContain('Sections: no room is left in 10 exercises for the first and the last exercise of the 3 sections; --per-section takes every section.');
  });

  it('thins a rule that does not fit by an even stride that keeps its ends, and says so', async () => {
    const report = await sample({ exercises: 5 });
    // The six layout exercises are s2:1, s2:2, s2:3, s3:1, s3:4, s1:3; five of six at index 0, 1, 2, 3 and the last.
    expect(listing(report, 'exercises')).toEqual([
      ['s1:3', 'smallest'],
      ['s2:1', 'has-continuation'],
      ['s2:2', 'context-on-another-page'],
      ['s2:3', 'two-in-a-row'],
      ['s3:1', 'three-in-a-row+first-in-section'],
    ]);
    expect(report.notes).toContain('The layout kinds: 5 of 6 taken, thinned by an even stride to stay within 5 exercises.');
    expect(report.notes).toContain('The first and the last exercise of every chapter: 0 of 3 taken, thinned by an even stride to stay within 5 exercises.');
    // Never cut off at the end: with room for one chapter exercise, the first of the chapters is taken, not the last ones.
    const roomForOne = await sample({ exercises: 7 });
    expect(roomForOne.exercises.map((entry) => entry.ref)).toEqual(['s1:1', 's1:3', 's2:1', 's2:2', 's2:3', 's3:1', 's3:4']);
    expect(roomForOne.notes).toContain('The first and the last exercise of every chapter: 1 of 3 taken, thinned by an even stride to stay within 7 exercises.');
  });

  it('takes the first and the last exercise of an even stride of sections when less than twice as many are left, keeping the first and the last section', () => {
    // Twelve sections in three chapters, 18 exercises: 5 layout exercises and 5 more of the chapters are 10; 8 are left, which is
    // less than 24: floor(8 / 2) = 4 of the 12 sections, at index 0, 3, 6 and the last, 11.
    const twelve = bigBook({ chapters: 3, perChapter: 4 });
    const report = sampleProject(twelve.project, twelve.pages, { exercises: 18 });
    expect(report.exercises).toHaveLength(18);
    expect(report.notes).toContain('Sections: the first and the last exercise of 4 of the 12 sections (an even stride that keeps the first and the last section) to stay within 18 exercises; --per-section takes every section.');
    const reasons = new Map(report.exercises.map((entry) => [entry.ref, entry.reasons]));
    // The second section of the stride (index 3, 1.4) is the chapter's last: nothing new; the third (index 6, 2.3) and the last section (index 11, 3.4) are new.
    for (const ref of ['1.1:8', '2.3:1', '2.3:9', '3.4:1']) expect(reasons.get(ref), ref).toContain(ref.endsWith(':1') ? 'first-in-section' : 'last-in-section');
  });

  it('with --per-section ignores the cap for the sections: every section has its first and its last exercise', async () => {
    const report = await sample({ exercises: 5, solutions: 2, perSection: true });
    expect(report.options.perSection).toBe(true);
    expect(listing(report, 'exercises').map(([ref]) => ref)).toEqual(['s1:1', 's1:3', 's1:6', 's2:1', 's2:2', 's2:3', 's2:4', 's3:1', 's3:5']);
    for (const ref of ['s1:1', 's1:6', 's2:1', 's2:4', 's3:1', 's3:5']) expect(report.exercises.map((entry) => entry.ref), ref).toContain(ref);
    expect(report.notes).toContain('--per-section: the first and the last exercise of every section are in the sample, so it has 9 exercises, more than the 5 asked for.');
  });

  it('leaves the exercises out for 0, and says which layouts the book does not have', async () => {
    expect((await sample({ exercises: 0 })).exercises).toEqual([]);
    expect((await sample({ exercises: 0, perSection: true })).exercises).toEqual([]);
    const plain = await sample({}, (frames) => {
      for (const frame of frames.values()) {
        delete frame.continues;
        delete frame.context;
      }
      (frames.get('s2:4') as Frame).rect = { ...(frames.get('s2:4') as Frame).rect, top: 0.3, bottom: 0.32 };
      (frames.get('s3:2') as Frame).rect = { ...(frames.get('s3:2') as Frame).rect, top: 0.5, bottom: 0.52 };
      (frames.get('s3:3') as Frame).rect = { ...(frames.get('s3:3') as Frame).rect, top: 0.6, bottom: 0.62 };
    });
    expect(plain.notes).toEqual([
      'No exercise continues on another region (a continuation).',
      'No exercise has its instruction on another page than its own.',
      'No two exercises stand in one row.',
      'No three exercises stand in one row.',
    ]);
  });

  it('does not depend on the order of the frames in the file, and is the same every time', async () => {
    const { workbook } = book();
    const pages = await pagesOf(workbook.pdf());
    for (const options of [{}, { exercises: 10, solutions: 3 }, { exercises: 5, solutions: 2, perSection: true }, { exercises: 7, solutions: 20 }]) {
      const first = sampleProject(workbook.project(), pages, options);
      expect(sampleProject(workbook.project(), pages, options)).toEqual(first);
      const shuffled = workbook.project();
      shuffled.frames = [...shuffled.frames].reverse();
      shuffled.frames.splice(3, 0, shuffled.frames.pop() as Frame);
      expect(sampleProject(shuffled, pages, options)).toEqual(first);
    }
  });

  it('says there is nothing to sample for a project without book exercises', async () => {
    const workbook = new Workbook(1);
    const report = sampleProject(workbook.project(), await pagesOf(workbook.pdf()));
    expect(report.exercises).toEqual([]);
    expect(report.solutions).toEqual([]);
    expect(report.notes[0]).toContain('no book exercises');
  });
});

describe('the sample of answers is capped too', () => {
  it('takes the answers of the layout kinds, the one with the most lines, a picture, the first of every chapter, then the other sampled ones', async () => {
    const report = await sample();
    expect(listing(report, 'solutions')).toEqual([
      ['s1:1', 'first-of-chapter-key+of-first-in-section'],
      ['s1:2', 'most-lines+of-sampled-exercise'],
      ['s1:3', 'of-sampled-exercise'],
      ['s1:4', 'of-sampled-exercise'],
      ['s1:5', 'of-sampled-exercise'],
      ['s1:6', 'of-last-in-section'],
      ['s2:1', 'of-first-in-section+of-sampled-exercise'],
      ['s2:2', 'of-sampled-exercise'],
      ['s2:3', 'of-sampled-exercise'],
      ['s2:4', 'of-last-in-section'],
      ['s3:1', 'of-first-in-section+of-sampled-exercise+first-of-chapter-key'],
      ['s3:2', 'of-sampled-exercise'],
      ['s3:3', 'of-sampled-exercise'],
      ['s3:4', 'of-sampled-exercise+picture-only'],
      ['s3:5', 'of-last-in-section'],
    ]);
    expect(report.solutions.every((entry) => entry.kind === 'solution' && entry.region === 'solution:0')).toBe(true);
    expect(report.solutions.find((entry) => entry.ref === 's3:4')?.page).toBe(6);
    expect(report.solutions.find((entry) => entry.ref === 's1:1')?.page).toBe(5);
  });

  it('thins the answers of the layout kinds first when the cap is small, and the rules after them find no room', async () => {
    const report = await sample({ exercises: 10, solutions: 3 });
    // The answers of s2:1, s2:2, s2:3, s3:1, s3:4 and s1:3 (six): index 0, 2 and the last.
    expect(listing(report, 'solutions')).toEqual([
      ['s1:3', 'of-sampled-exercise'],
      ['s2:1', 'of-sampled-exercise'],
      ['s2:3', 'of-sampled-exercise'],
    ]);
    expect(report.notes).toContain('The answers of the layout kinds: 3 of 6 taken, thinned by an even stride to stay within 3 answers.');
    expect(report.notes).toContain('The answer with the most lines: 0 of 1 taken, thinned by an even stride to stay within 3 answers.');
  });

  it('makes room for the special answers after the layout answers, and fills the rest by a stride', async () => {
    const report = await sample({ exercises: 7, solutions: 20 });
    // Seven exercises: the layouts and s1:1. The answers: the six layouts, the most lines, the first of both chapters' keys, then a stride.
    expect(listing(report, 'solutions').map(([ref, reasons]) => `${ref}:${reasons}`)).toEqual([
      's1:1:first-of-chapter-key+of-first-in-section',
      's1:2:most-lines',
      's1:3:of-sampled-exercise',
      's1:4:stride',
      's1:5:stride',
      's1:6:stride',
      's2:1:of-sampled-exercise',
      's2:2:of-sampled-exercise',
      's2:3:of-sampled-exercise',
      's2:4:stride',
      's3:1:of-first-in-section+of-sampled-exercise+first-of-chapter-key',
      's3:2:stride',
      's3:3:stride',
      's3:4:of-sampled-exercise+picture-only',
      's3:5:stride',
    ]);
  });

  it('is only the special answers when no exercises are sampled, and a stride fills the rest', async () => {
    const special = await sample({ exercises: 0, solutions: 3 });
    expect(listing(special, 'solutions')).toEqual([
      ['s1:1', 'first-of-chapter-key'],
      ['s1:2', 'most-lines'],
      ['s3:4', 'picture-only'],
    ]);
    const filled = await sample({ exercises: 0, solutions: 8 });
    expect(listing(filled, 'solutions').filter(([, reasons]) => reasons === 'stride').map(([ref]) => ref)).toEqual(['s1:3', 's1:5', 's2:2', 's3:5']);
    expect(filled.solutions).toHaveLength(8);
  });

  it('with --per-section takes the answers of every sampled exercise, beyond the cap', async () => {
    const report = await sample({ exercises: 5, solutions: 2, perSection: true });
    expect(report.solutions.map((entry) => entry.ref)).toEqual(report.exercises.map((entry) => entry.ref));
    expect(report.notes).toContain('--per-section: the answers of every sampled exercise are in the sample, so it has 9 answers, more than the 2 asked for.');
  });

  it('leaves the answers out for 0', async () => {
    expect((await sample({ solutions: 0 })).solutions).toEqual([]);
    expect((await sample({ solutions: 0, perSection: true })).solutions).toEqual([]);
  });

  it('only counts the lines it has read: an answer on a page that was not read is neither a picture nor long', async () => {
    const { workbook } = book();
    const none = sampleProject(workbook.project(), () => undefined, { exercises: 0, solutions: 2 });
    expect(none.solutions.map((entry) => entry.reason)).toEqual(['first-of-chapter-key', 'first-of-chapter-key']);
    expect(none.notes).toEqual(['No answer has more than one line of text.', 'No answer is a picture without text.']);
  });

  it('names the pages whose text it reads: those of the answers', () => {
    expect(pagesToSample(book().workbook.project())).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A book of 77 sections in 11 chapters

interface Big {
  project: Project;
  pages: (page: number) => PageText | undefined;
  /** Section ids in the order of the book, and the labels of each. */
  sections: { id: string; chapter: number; count: number }[];
}

function line(text: string, rect: Rect): TextLine {
  return { text, rect, fontSize: 11, column: 0, chars: text.replace(/\s/g, '').length };
}

/**
 * `chapters` chapters of `perChapter` sections, one page for each section with 8 to 12 exercises: a row of two in the first
 * section, a row of three in the fourth, a continuation in the sixth, an instruction on the page before in the eighth, a tall
 * exercise in the eleventh (a figure, the longest) and a narrow one in the thirteenth (the smallest). The answers are lines
 * on key pages; one answer has three lines (section 21) and one is a picture (section 31). With `flat` there are no chapters:
 * every outline entry has depth 1.
 */
function bigBook(options: { chapters?: number; perChapter?: number; flat?: boolean } = {}): Big {
  const chapters = options.chapters ?? 11;
  const perChapter = options.perChapter ?? 7;
  const total = chapters * perChapter;
  const keyFirst = total + 1;
  const entries: OutlineEntry[] = [];
  const sections: Big['sections'] = [];
  for (let c = 0; c < chapters; c += 1) {
    if (options.flat !== true) entries.push({ title: `Chapter ${c + 1}`, page: c * perChapter, depth: 0, id: `c${c + 1}`, label: `Chapter ${c + 1}`, top: 0.01 });
    for (let j = 0; j < perChapter; j += 1) {
      const index = c * perChapter + j;
      const id = `${c + 1}.${j + 1}`;
      entries.push({ title: `Section ${id}`, page: index, depth: options.flat === true ? 1 : 1, id, label: id, top: 0.02 });
      sections.push({ id, chapter: c, count: 8 + (index % 5) });
    }
  }
  const texts = new Map<number, PageText>();
  const keyPage = (page: number): PageText => {
    let found = texts.get(page);
    if (!found) {
      found = { page, size: { width: 595, height: 842, rotation: 0 }, lines: [], columns: 1, hasText: true };
      texts.set(page, found);
    }
    return found;
  };
  const frames: Frame[] = [];
  let slot = 0;
  sections.forEach((section, index) => {
    const row = (i: number, k: number): number => (i < k ? 0 : i - k + 1);
    const wide = index === 0 ? 2 : index === 3 ? 3 : 1;
    for (let i = 0; i < section.count; i += 1) {
      const label = String(i + 1);
      const inRow = i < wide;
      const top = 0.1 + 0.07 * (wide > 1 ? row(i, wide) : i);
      const left = !inRow || wide === 1 ? 0.1 : 0.1 + (0.8 / wide) * i;
      const right = !inRow || wide === 1 ? 0.9 : left + 0.8 / wide - 0.02;
      const frame: Frame = { id: `f${frames.length + 1}`, kind: 'exercise', page: index, rect: { left, top, right, bottom: top + 0.05 }, authority: 'book', label, section: section.id };
      if (index === 5 && i === 3) frame.continues = [{ page: total, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.14 } }];
      if (index === 7 && i === 2) frame.context = [{ page: index - 1, rect: { left: 0.1, top: 0.9, right: 0.9, bottom: 0.93 } }];
      if (index === 10 && i === 4) frame.rect = { ...frame.rect, bottom: frame.rect.top + 0.2 };
      if (index === 12 && i === 1) frame.rect = { ...frame.rect, right: frame.rect.left + 0.1 };
      // The answer: a line on a key page (three lines for one, none for a picture).
      const page = keyFirst + Math.floor(slot / 50);
      const at = slot % 50;
      const answerTop = 0.04 + at * 0.018;
      const multi = index === 20 && i === 3;
      const picture = index === 30 && i === 5;
      const bottom = multi ? answerTop + 0.016 + 2 * 0.0045 : answerTop + 0.016;
      frame.solution = [{ page, rect: { left: 0.09, top: answerTop - 0.001, right: 0.4, bottom } }];
      if (!picture) keyPage(page).lines.push(line(`${label}. ${42}`, { left: 0.1, top: answerTop, right: 0.2, bottom: answerTop + 0.004 }));
      if (multi) {
        keyPage(page).lines.push(line('second line of the answer', { left: 0.1, top: answerTop + 0.0045, right: 0.3, bottom: answerTop + 0.0085 }));
        keyPage(page).lines.push(line('third line of the answer', { left: 0.1, top: answerTop + 0.009, right: 0.3, bottom: answerTop + 0.013 }));
      }
      if (picture) keyPage(page).lines.push(line('x', { left: 0.8, top: answerTop, right: 0.82, bottom: answerTop + 0.004 }));
      slot += 1;
      frames.push(frame);
    }
  });
  const pageCount = keyFirst + Math.ceil(slot / 50) + 1;
  const project = newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount }, title: 'A Big Book' });
  return { project: { ...project, frames, outline: { source: 'manual', entries }, seq: frames.length }, pages: (page) => texts.get(page), sections };
}

/** The even stride of the documentation, written out once more from its text: both ends stay. */
function stride<T>(list: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= list.length) return [...list];
  if (count === 1) return [list[0] as T];
  const taken: T[] = [];
  for (let k = 0; k < count - 1; k += 1) taken.push(list[Math.floor((k * list.length) / count)] as T);
  taken.push(list[list.length - 1] as T);
  return taken;
}

describe('a book of 77 sections in 11 chapters', () => {
  const big = bigBook();
  const ordered = bookExercisesInOrder(big.project.frames, big.project.outline?.entries);
  const refOf = (frame: Frame): string => `${frame.section as string}:${frame.label as string}`;
  const refs = ordered.map(refOf);

  it('has the size the numbers below are about', () => {
    expect(big.sections).toHaveLength(77);
    expect(refs.length).toBeGreaterThan(700);
  });

  it('gives exactly 40 exercises and 20 answers by default, with every layout kind, the first and the last exercise of the book and of every chapter', () => {
    const report = sampleProject(big.project, big.pages);
    expect(report.exercises).toHaveLength(40);
    expect(report.solutions).toHaveLength(20);
    expect(report.summary).toMatchObject({ sections: 77, sampledExercises: 40, sampledSolutions: 20 });
    const reasons = new Set(report.exercises.flatMap((entry) => entry.reasons));
    for (const kind of ['has-continuation', 'context-on-another-page', 'two-in-a-row', 'three-in-a-row', 'longest', 'smallest', 'beside-a-figure']) expect(reasons.has(kind as never), kind).toBe(true);
    const sampled = new Set(report.exercises.map((entry) => entry.ref));
    expect(sampled.has(refs[0] as string)).toBe(true);
    expect(sampled.has(refs[refs.length - 1] as string)).toBe(true);
    for (let c = 1; c <= 11; c += 1) {
      const own = ordered.filter((frame) => frame.section?.startsWith(`${c}.`));
      expect(sampled.has(refOf(own[0] as Frame)), `chapter ${c} first`).toBe(true);
      expect(sampled.has(refOf(own[own.length - 1] as Frame)), `chapter ${c} last`).toBe(true);
    }
    // The answers: the layouts' answers, the most lines, the picture, the first of every chapter's key.
    const answerReasons = new Set(report.solutions.flatMap((entry) => entry.reasons));
    for (const reason of ['most-lines', 'picture-only', 'first-of-chapter-key', 'of-sampled-exercise']) expect(answerReasons.has(reason as never), reason).toBe(true);
    expect(report.solutions.filter((entry) => entry.reasons.includes('first-of-chapter-key'))).toHaveLength(11);
    expect(report.notes.some((note) => note.startsWith('Sections: the first and the last exercise of 6 of the 77 sections'))).toBe(true);
  });

  it('is the same list twice and after the frames are put in another order', () => {
    const first = sampleProject(big.project, big.pages);
    expect(sampleProject(big.project, big.pages)).toEqual(first);
    const shuffled: Project = { ...big.project, frames: [...big.project.frames].reverse() };
    shuffled.frames.splice(100, 0, shuffled.frames.pop() as Frame);
    expect(sampleProject(shuffled, big.pages)).toEqual(first);
    expect(sampleProject(shuffled, big.pages, { perSection: true })).toEqual(sampleProject(big.project, big.pages, { perSection: true }));
  });

  it('is reproduced by the rules of the documentation written out once more', () => {
    const report = sampleProject(big.project, big.pages);
    const layout = report.exercises.filter((entry) => entry.reasons.some((reason) => ['has-continuation', 'context-on-another-page', 'two-in-a-row', 'three-in-a-row', 'longest', 'smallest', 'beside-a-figure'].includes(reason))).map((entry) => entry.ref);
    const chosen: string[] = [...layout];
    const add = (list: string[]): void => {
      for (const ref of list) if (!chosen.includes(ref)) chosen.push(ref);
    };
    // 2. The first and the last exercise of every chapter, in the order of the book.
    const chapterPicks: string[] = [];
    for (let c = 1; c <= 11; c += 1) {
      const own = refs.filter((ref) => ref.startsWith(`${c}.`));
      chapterPicks.push(own[0] as string, own[own.length - 1] as string);
    }
    add(stride(chapterPicks.filter((ref) => !chosen.includes(ref)), 40 - chosen.length));
    // 3. Less than twice the 77 sections is left: floor(left / 2) sections, the first and the last exercise of each.
    const left = 40 - chosen.length;
    const sectionIds = big.sections.map((section) => section.id);
    const picked = stride(sectionIds, Math.floor(left / 2));
    const sectionPicks = picked.flatMap((id) => {
      const own = refs.filter((ref) => ref.startsWith(`${id}:`));
      return [own[0] as string, own[own.length - 1] as string];
    });
    add(stride(sectionPicks.filter((ref) => !chosen.includes(ref)), 40 - chosen.length));
    // 4. An even stride over the rest.
    add(stride(refs.filter((ref) => !chosen.includes(ref)), 40 - chosen.length));
    expect(report.exercises.map((entry) => entry.ref)).toEqual(refs.filter((ref) => chosen.includes(ref)));
  });

  it('with --per-section has the first and the last exercise of every section, beyond the cap, and the answers of all of them', () => {
    const report = sampleProject(big.project, big.pages, { perSection: true });
    const sampled = new Set(report.exercises.map((entry) => entry.ref));
    for (const section of big.sections) {
      const own = refs.filter((ref) => ref.startsWith(`${section.id}:`));
      expect(sampled.has(own[0] as string), `${section.id} first`).toBe(true);
      expect(sampled.has(own[own.length - 1] as string), `${section.id} last`).toBe(true);
    }
    // 77 sections: 154 exercises are the first or the last of one; four more are the layouts that stand elsewhere (the continuation,
    // the instruction on the page before, the tall one that is also the longest, the narrow one).
    expect(report.exercises).toHaveLength(158);
    // The answers of those 158, and the two special answers (the most lines, the picture) of exercises that are not in the sample.
    expect(report.solutions).toHaveLength(160);
    const answered = new Set(report.solutions.map((entry) => entry.ref));
    for (const entry of report.exercises) expect(answered.has(entry.ref), entry.ref).toBe(true);
    expect(report.notes).toContain('--per-section: the first and the last exercise of every section are in the sample, so it has 158 exercises, more than the 40 asked for.');
    expect(report.notes).toContain('--per-section: the answers of every sampled exercise are in the sample, so it has 160 answers, more than the 20 asked for.');
  });

  it('is exactly as large as the caps say, whatever they are', () => {
    for (const [exercises, solutions] of [[12, 6], [8, 3], [25, 25], [60, 30], [1, 1]] as const) {
      const report = sampleProject(big.project, big.pages, { exercises, solutions });
      expect(report.exercises, `${exercises} exercises`).toHaveLength(exercises);
      expect(report.solutions, `${solutions} answers`).toHaveLength(solutions);
    }
  });

  it('takes the chapters first and last exercise with both ends when it must thin them', () => {
    const report = sampleProject(big.project, big.pages, { exercises: 12 });
    const sampled = new Set(report.exercises.map((entry) => entry.ref));
    expect(report.exercises).toHaveLength(12);
    // Seven layout exercises; five more from the chapters' twenty-two, the first of the first chapter and the last of the last among them.
    expect(sampled.has(refs[0] as string)).toBe(true);
    expect(sampled.has(refs[refs.length - 1] as string)).toBe(true);
  });
});

describe('the chapters of an outline', () => {
  it('are the entries of depth 0 that hold exercises, directly or below', () => {
    const big = bigBook({ chapters: 4, perChapter: 3 });
    const report = sampleProject(big.project, big.pages, { exercises: 40 });
    // 12 sections: layout exercises, then the first and the last of the four chapters (1.1, 1.3, 2.1, 2.3, 3.1, 3.3, 4.1, 4.3).
    const sampled = new Set(report.exercises.map((entry) => entry.ref));
    for (const section of ['1.1', '2.1', '3.1', '4.1']) expect(sampled.has(`${section}:1`), section).toBe(true);
    expect(report.exercises.filter((entry) => entry.reasons.includes('first-in-section')).length).toBeGreaterThanOrEqual(8);
  });

  it('are the entries at the top of an outline that has none of depth 0', () => {
    const flat = bigBook({ chapters: 5, perChapter: 4, flat: true });
    const report = sampleProject(flat.project, flat.pages, { exercises: 12 });
    // Every entry is at the top: the chapters rule picks the first and the last exercise of each of the 20 sections, thinned to what is left.
    expect(report.exercises).toHaveLength(12);
    const refs = bookExercisesInOrder(flat.project.frames, flat.project.outline?.entries).map((frame) => `${frame.section as string}:${frame.label as string}`);
    expect(report.exercises.map((entry) => entry.ref)).toContain(refs[0]);
    expect(report.exercises.map((entry) => entry.ref)).toContain(refs[refs.length - 1]);
    expect(report.notes.some((note) => note.startsWith('The first and the last exercise of every chapter:'))).toBe(true);
  });
});

describe('the reasons', () => {
  it('are all documented in docs/AUDIT_A_BOOK.md, with the rule that picks them', () => {
    const text = readFileSync(new URL('../../../docs/AUDIT_A_BOOK.md', import.meta.url), 'utf8');
    for (const reason of [...EXERCISE_REASONS, ...SOLUTION_REASONS]) expect(text, reason).toContain(`\`${reason}\``);
  });
});
