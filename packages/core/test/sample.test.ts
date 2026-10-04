import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import { EXERCISE_REASONS, SAMPLE_FORMAT, SAMPLE_VERSION, SOLUTION_REASONS } from '../src/sample/types.js';
import { pagesToSample, sampleProject } from '../src/sample/sample.js';
import { Workbook, around, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * A book of three sections in two chapters with every layout the rules name: a continuation, an instruction on another page,
 * two exercises in a row, three in a row, a narrow (small) region, a tall one (a figure), an answer of three lines and an answer
 * that is a picture. Book order: s1:1..6, s2:1..4, s3:1..5 (15 exercises).
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

async function sample(options: Parameters<typeof sampleProject>[2] = {}, change?: (frames: Map<string, Frame>) => void): Promise<ReturnType<typeof sampleProject>> {
  const { workbook, frames } = book();
  change?.(frames);
  return sampleProject(workbook.project(), await pagesOf(workbook.pdf()), options);
}

const listing = (report: ReturnType<typeof sampleProject>, which: 'exercises' | 'solutions'): [string, string][] => report[which].map((entry) => [entry.ref, entry.reasons.join('+')]);

describe('the sample of exercises', () => {
  it('takes the first and the last of every section, one of each layout, and fills up with an even stride', async () => {
    const report = await sample({ exercises: 14, solutions: 3 });
    expect(report.format).toBe(SAMPLE_FORMAT);
    expect(report.version).toBe(SAMPLE_VERSION);
    expect(listing(report, 'exercises')).toEqual([
      ['s1:1', 'first-in-section'],
      ['s1:2', 'stride'],
      ['s1:3', 'smallest'],
      ['s1:4', 'stride'],
      ['s1:5', 'stride'],
      ['s1:6', 'last-in-section'],
      ['s2:1', 'first-in-section+has-continuation'],
      ['s2:2', 'context-on-another-page'],
      ['s2:3', 'two-in-a-row'],
      ['s2:4', 'last-in-section'],
      ['s3:1', 'first-in-section+three-in-a-row'],
      ['s3:2', 'stride'],
      ['s3:4', 'longest+beside-a-figure'],
      ['s3:5', 'last-in-section'],
    ]);
    expect(report.summary).toEqual({ sections: 3, exercises: 15, withSolution: 15, sampledExercises: 14, sampledSolutions: report.solutions.length });
    expect(report.exercises.map((entry) => entry.kind)).toEqual(Array(14).fill('exercise'));
    expect(report.exercises.every((entry) => entry.region === 'main')).toBe(true);
    expect(report.exercises.find((entry) => entry.ref === 's2:2')).toMatchObject({ reason: 'context-on-another-page', page: 1 });
    expect(report.notes).toEqual([]);
  });

  it('is every exercise when the book has fewer than the sample asks for', async () => {
    const report = await sample();
    expect(report.exercises).toHaveLength(15);
    expect(report.options).toEqual({ exercises: 40, solutions: 20 });
    expect(report.exercises.filter((entry) => entry.reason === 'stride')).toHaveLength(5);
  });

  it('never drops what the rules name, however small the number', async () => {
    const report = await sample({ exercises: 1 });
    expect(report.exercises).toHaveLength(10);
    expect(report.exercises.some((entry) => entry.reason === 'stride')).toBe(false);
  });

  it('leaves the exercises out for 0, and says which layouts the book does not have', async () => {
    expect((await sample({ exercises: 0 })).exercises).toEqual([]);
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
    const first = sampleProject(workbook.project(), pages, { exercises: 14, solutions: 12 });
    const again = sampleProject(workbook.project(), pages, { exercises: 14, solutions: 12 });
    expect(again).toEqual(first);
    const shuffled = workbook.project();
    shuffled.frames = [...shuffled.frames].reverse();
    shuffled.frames.splice(3, 0, shuffled.frames.pop() as Frame);
    expect(sampleProject(shuffled, pages, { exercises: 14, solutions: 12 })).toEqual(first);
  });

  it('says there is nothing to sample for a project without book exercises', async () => {
    const workbook = new Workbook(1);
    const report = sampleProject(workbook.project(), await pagesOf(workbook.pdf()));
    expect(report.exercises).toEqual([]);
    expect(report.solutions).toEqual([]);
    expect(report.notes[0]).toContain('no book exercises');
  });
});

describe('the sample of answers', () => {
  it('takes the answers of the exercises above, the one with the most lines, a picture, and the first of every chapter', async () => {
    const report = await sample({ exercises: 14, solutions: 3 });
    expect(listing(report, 'solutions')).toEqual([
      ['s1:1', 'of-first-in-section+first-of-chapter-key'],
      ['s1:2', 'of-sampled-exercise+most-lines'],
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
      ['s3:4', 'of-sampled-exercise+picture-only'],
      ['s3:5', 'of-last-in-section'],
    ]);
    expect(report.solutions.every((entry) => entry.kind === 'solution' && entry.region === 'solution:0')).toBe(true);
    expect(report.solutions.find((entry) => entry.ref === 's3:4')?.page).toBe(6);
    expect(report.solutions.find((entry) => entry.ref === 's1:1')?.page).toBe(5);
  });

  it('is only the special answers when no exercises are sampled, and filled up with an even stride', async () => {
    const special = await sample({ exercises: 0, solutions: 3 });
    expect(listing(special, 'solutions')).toEqual([
      ['s1:1', 'first-of-chapter-key'],
      ['s1:2', 'most-lines'],
      ['s3:1', 'first-of-chapter-key'],
      ['s3:4', 'picture-only'],
    ]);
    const filled = await sample({ exercises: 0, solutions: 8 });
    expect(listing(filled, 'solutions').filter(([, reasons]) => reasons === 'stride').map(([ref]) => ref)).toEqual(['s1:3', 's1:5', 's2:2', 's3:2']);
    expect(filled.solutions).toHaveLength(8);
  });

  it('leaves the answers out for 0', async () => {
    expect((await sample({ solutions: 0 })).solutions).toEqual([]);
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

describe('the reasons', () => {
  it('are all documented in docs/AUDIT_A_BOOK.md, with the rule that picks them', () => {
    const text = readFileSync(new URL('../../../docs/AUDIT_A_BOOK.md', import.meta.url), 'utf8');
    for (const reason of [...EXERCISE_REASONS, ...SOLUTION_REASONS]) expect(text, reason).toContain(`\`${reason}\``);
  });
});
