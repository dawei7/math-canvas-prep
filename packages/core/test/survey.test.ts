import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import { parseSurvey, readSurvey, surveyFindings, SURVEY_KINDS, type ReadSurveyEntry } from '../src/gate/survey.js';
import { newProject, type Project } from '../src/project/model.js';
import { frame, rect, rejected, tempDir } from './helpers.js';

/**
 * The survey record is checked against the frames and nothing else: a project with frames on some pages of a book of twelve pages is enough,
 * no PDF is read. Pages 0-1 are front matter, 2-3 text, 4-5 a practice set (exercise regions on both, one exercise goes on from page 4 to 5), 6 text,
 * 7 a practice set whose instruction is printed on page 6, 8-9 text, 10-11 the answers.
 */

const PAGES = 12;
const book = (extra: Frame[] = []): Project => {
  const project = newProject({ pdf: { path: 'b.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: PAGES }, title: 'A book' });
  const exercise = (id: string, label: string, page: number, extraFields: Partial<Frame> = {}): Frame => frame(id, 'exercise', page, rect(0.1, 0.2, 0.9, 0.3), { authority: 'book', label, section: 's', ...extraFields });
  project.frames = [
    exercise('a', '1', 4, { continues: [{ page: 5, rect: rect(0.1, 0.1, 0.9, 0.2) }], solution: [{ page: 10, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
    exercise('b', '2', 5, { solution: [{ page: 10, rect: rect(0.1, 0.3, 0.9, 0.4) }] }),
    exercise('c', '3', 7, { context: [{ page: 6, rect: rect(0.1, 0.6, 0.9, 0.7) }], solution: [{ page: 11, rect: rect(0.1, 0.1, 0.9, 0.2) }] }),
    ...extra,
  ];
  return project;
};

/** The right record of the book above. */
const RIGHT = [
  { from: 0, to: 1, kind: 'front' },
  { from: 2, to: 3, kind: 'text' },
  { from: 4, to: 5, kind: 'exercises' },
  { from: 6, to: 6, kind: 'text' },
  { from: 7, to: 7, kind: 'exercises' },
  { from: 8, to: 9, kind: 'text' },
  { from: 10, to: 11, kind: 'answers' },
];

const read = (entries: readonly object[]): ReadSurveyEntry[] => entries.map((entry, at) => ({ ...entry, at }));
const check = (project: Project, entries: readonly object[]): ReturnType<typeof surveyFindings> => surveyFindings(project, read(entries), { file: 'survey.json' });
const codes = (result: ReturnType<typeof surveyFindings>): string[] => result.findings.map((entry) => `${entry.code} ${entry.ref}`);

describe('the survey record of a book that is right', () => {
  it('has no finding, is exhaustive and counts what it read', () => {
    const result = check(book(), RIGHT);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ file: 'survey.json', pages: PAGES, entries: 7, missing: 0, uncovered: 0, unmarked: 0, exhaustive: true });
  });

  it('takes a page that holds exercises and answers as both, and a page of one entry for each single page', () => {
    const project = book([frame('d', 'exercise', 10, rect(0.1, 0.5, 0.9, 0.6), { authority: 'book', label: '9', section: 's' })]);
    const record = RIGHT.flatMap((entry) => (entry.from === 10 ? [{ from: 10, to: 10, kind: 'both' }, { from: 11, to: 11, kind: 'answers' }] : [entry]));
    expect(check(project, record).summary.exhaustive).toBe(true);
    // The same page marked answers only: an exercise region lies on it.
    expect(codes(check(project, RIGHT))).toEqual(['survey-unmarked pages 10']);
  });

  it('is exhaustive with a note, kinds that hold nothing, and every kind of the format named', () => {
    expect(SURVEY_KINDS).toEqual(['exercises', 'answers', 'both', 'text', 'blank', 'front', 'back']);
    const record = [{ from: 0, to: 0, kind: 'blank', note: 'the cover is a picture' }, { from: 1, to: 1, kind: 'front' }, ...RIGHT.slice(1, 5), { from: 8, to: 9, kind: 'back' }, RIGHT[6]];
    expect(check(book(), record as object[]).summary.exhaustive).toBe(true);
  });
});

describe('survey-missing', () => {
  it('is one finding for all the pages without an entry, with the count and the first ranges', () => {
    const result = check(book(), RIGHT.filter((entry) => entry.kind !== 'front' && entry.from !== 8));
    expect(codes(result)).toEqual(['survey-missing survey']);
    const [found] = result.findings;
    expect(found).toMatchObject({ source: 'survey', severity: 'error', page: 0, acknowledgeable: false });
    expect(found?.message).toContain('4 pages have no entry in the survey record: 0-1, 8-9');
    expect(found?.evidence).toBe('2 ranges without an entry: 0-1, 8-9');
    expect(result.summary).toMatchObject({ missing: 4, exhaustive: false });
  });

  it('names at most eight ranges and says how many more there are; an empty record misses every page', () => {
    const project = newProject({ pdf: { path: 'b.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 40 }, title: 'Long' });
    const every = check(project, [{ from: 0, to: 0, kind: 'front' }, { from: 2, to: 2, kind: 'text' }, { from: 4, to: 4, kind: 'text' }, { from: 6, to: 6, kind: 'text' }, { from: 8, to: 8, kind: 'text' }, { from: 10, to: 10, kind: 'text' }, { from: 12, to: 12, kind: 'text' }, { from: 14, to: 14, kind: 'text' }, { from: 16, to: 16, kind: 'text' }, { from: 18, to: 39, kind: 'text' }]);
    expect(every.findings).toHaveLength(1);
    expect(every.findings[0]?.message).toContain('9 pages have no entry');
    expect(every.findings[0]?.message).toContain('1, 3, 5, 7, 9, 11, 13, 15, ... (1 more range)');
    expect(check(book(), []).findings[0]?.message).toContain('12 pages have no entry in the survey record: 0-11');
  });
});

describe('survey-overlap', () => {
  it('is one finding for each stretch that entries share, naming them', () => {
    const result = check(book(), [{ from: 0, to: 3, kind: 'front' }, ...RIGHT.slice(1, 3), { from: 5, to: 6, kind: 'text' }, ...RIGHT.slice(4)]);
    expect(codes(result)).toEqual(['survey-overlap pages 2-3', 'survey-overlap pages 5']);
    expect(result.findings[0]?.message).toContain('Pages 2-3 are in more than one entry of the survey record: the entry 1 (0-3, front) and the entry 2 (2-3, text)');
    expect(result.findings[1]?.message).toContain('Page 5 is in more than one entry');
    expect(result.findings.every((entry) => entry.source === 'survey' && !entry.acknowledgeable && entry.severity === 'error')).toBe(true);
    // A page in two entries has no kind: it is not judged against the frames.
    expect(result.summary).toMatchObject({ missing: 0, uncovered: 0, unmarked: 0, exhaustive: false });
  });
});

describe('survey-range', () => {
  it.each([
    ['from is after to', { from: 5, to: 4, kind: 'text' }, '"from" (5) is after "to" (4)'],
    ['the range is outside the book', { from: 10, to: 12, kind: 'text' }, 'the range 10-12 is outside the pages of this book (0-11)'],
    ['a negative page', { from: -1, to: 2, kind: 'text' }, 'the range -1-2 is outside'],
    ['an unknown kind', { from: 0, to: 1, kind: 'preface' }, '"kind" is "preface", which is none of exercises, answers, both, text, blank, front, back'],
    ['no kind', { from: 0, to: 1 }, '"kind" is missing'],
    ['no from', { to: 1, kind: 'front' }, '"from" is missing'],
    ['a page that is no whole number', { from: 0.5, to: 1, kind: 'front' }, '"from" is not a whole number (0.5)'],
    ['a page that is text', { from: '0', to: 1, kind: 'front' }, '"from" is not a whole number ("0")'],
    ['a note that is too long', { from: 0, to: 1, kind: 'front', note: 'x'.repeat(121) }, '"note" has 121 characters, at most 120 are allowed'],
    ['a note that is no text', { from: 0, to: 1, kind: 'front', note: 5 }, '"note" is not text'],
  ])('is a finding for an entry with %s, and the pages it would have covered have no entry', (_what, entry, said) => {
    const result = check(book(), [entry, ...RIGHT.slice(1)]);
    const found = result.findings.find((candidate) => candidate.code === 'survey-range');
    expect(found).toMatchObject({ source: 'survey', ref: 'entry 1', severity: 'error', acknowledgeable: false });
    expect(found?.message).toContain(said);
    expect(found?.message).toContain('`mcprep schema survey`');
    // The entry covers nothing; the pages 0-1 are missing, unless the entry is outside the book (then they are missing too).
    expect(result.findings.some((candidate) => candidate.code === 'survey-missing')).toBe(true);
    expect(result.summary.exhaustive).toBe(false);
  });

  it('names every problem of an entry in one finding, and an entry of a folder by its file', () => {
    const entries: ReadSurveyEntry[] = [{ from: 9, to: 3, kind: 'x', note: 'y'.repeat(130), file: 'overview-2.json', at: 1 }];
    const result = surveyFindings(book(), entries, { file: 'survey', inFolder: true });
    const found = result.findings.find((candidate) => candidate.code === 'survey-range');
    expect(found?.ref).toBe('entry 2 of overview-2.json');
    expect(found?.page).toBe(9);
    for (const part of ['"kind" is "x"', '"from" (9) is after "to" (3)', '"note" has 130 characters']) expect(found?.message).toContain(part);
  });
});

describe('survey-uncovered', () => {
  it('is a finding for a page marked exercises that no exercise region touches, for the pages of one entry together', () => {
    const result = check(book(), [...RIGHT.slice(0, 2), { from: 4, to: 7, kind: 'exercises' }, ...RIGHT.slice(5)]);
    expect(codes(result)).toEqual(['survey-uncovered pages 6']);
    expect(result.findings[0]?.message).toContain('Page 6 is marked exercises (the entry 3, 4-7), and no exercise region touches it');
    expect(result.findings[0]?.message).toContain('frame its exercises (`mcprep exercises add`), or correct the record if the page holds none.');
    // The instruction of the exercise on page 7 is printed on page 6 and does not count.
    expect(result.summary).toMatchObject({ uncovered: 1, unmarked: 0 });
  });

  it('counts the continuation of an exercise: a page that only holds its end is an exercise page', () => {
    const only = book().frames.filter((entry) => entry.id !== 'b');
    const project = book();
    project.frames = only;
    expect(check(project, RIGHT).findings).toEqual([]);
  });

  it('is a finding for pages marked answers that no solution region touches, and for the half of both that is missing', () => {
    const noKey = book();
    for (const entry of noKey.frames) if (entry.id === 'c') delete entry.solution;
    const result = check(noKey, RIGHT);
    expect(codes(result)).toEqual(['survey-uncovered pages 11']);
    expect(result.findings[0]?.message).toContain('Page 11 is marked answers (the entry 7, 10-11), and no solution region touches it: frame its answers (`mcprep solution add`)');
    const both = check(book(), [...RIGHT.slice(0, 4), { from: 7, to: 7, kind: 'both' }, ...RIGHT.slice(5)]);
    expect(codes(both)).toEqual(['survey-uncovered pages 7']);
    expect(both.findings[0]?.message).toContain('no solution region touches it');
  });

  it('does not count a frame that is not an exercise of the book: a stray exercise, a question, a bookmark', () => {
    const stray = book([frame('s', 'exercise', 8, rect(0.1, 0.1, 0.9, 0.2)), frame('q', 'question', 2, rect(0.1, 0.1, 0.9, 0.2)), frame('m', 'bookmark', 3, rect(0.1, 0.1, 0.9, 0.2))]);
    expect(check(stray, RIGHT).findings).toEqual([]);
    expect(check(stray, [...RIGHT.slice(0, 5), { from: 8, to: 9, kind: 'exercises' }, ...RIGHT.slice(6)]).findings.map((entry) => entry.code)).toEqual(['survey-uncovered']);
  });
});

describe('survey-unmarked', () => {
  it('is a finding for an exercise region on a page the record marks as text, and names the exercise', () => {
    const result = check(book(), [...RIGHT.slice(0, 1), { from: 2, to: 5, kind: 'text' }, ...RIGHT.slice(3)]);
    expect(codes(result)).toEqual(['survey-unmarked pages 4-5']);
    expect(result.findings[0]?.message).toContain('Pages 4-5 are marked text (the entry 2, 2-5), but s:1 has an exercise region on page 4');
    expect(result.findings[0]?.message).toContain('the page holds exercises. Mark them exercises');
    expect(result.summary).toMatchObject({ unmarked: 2, uncovered: 0 });
  });

  it('is a finding for each kind that holds no exercise: blank, front, back, answers', () => {
    for (const kind of ['blank', 'front', 'back', 'answers']) {
      const result = check(book(), [...RIGHT.slice(0, 4), { from: 7, to: 7, kind }, ...RIGHT.slice(5)]);
      expect(codes(result), kind).toContain('survey-unmarked pages 7');
    }
  });

  it('is a finding for a solution region on a page the record marks as text or exercises', () => {
    const result = check(book(), [...RIGHT.slice(0, 5), { from: 8, to: 11, kind: 'text' }]);
    expect(codes(result)).toEqual(['survey-unmarked pages 10-11']);
    expect(result.findings[0]?.message).toContain('the solution region of s:1 lies on page 10');
    expect(result.findings[0]?.message).toContain('the page holds answers');
    const exercises = check(book(), [...RIGHT.slice(0, 5), { from: 8, to: 9, kind: 'text' }, { from: 10, to: 11, kind: 'exercises' }]);
    expect(exercises.findings.map((entry) => `${entry.code} ${entry.ref}`).sort()).toEqual(['survey-uncovered pages 10-11', 'survey-unmarked pages 10-11']);
  });

  it('keeps apart the stretches of one entry that are not next to each other', () => {
    const project = book([frame('t', 'exercise', 9, rect(0.1, 0.1, 0.9, 0.2), { authority: 'book', label: '4', section: 's' })]);
    const result = check(project, [...RIGHT.slice(0, 5), { from: 8, to: 9, kind: 'text' }, RIGHT[6] as object]);
    expect(codes(result)).toEqual(['survey-unmarked pages 9']);
    const wide = check(project, [...RIGHT.slice(0, 1), { from: 2, to: 9, kind: 'text' }, RIGHT[6] as object]);
    expect(codes(wide)).toEqual(['survey-unmarked pages 4-5', 'survey-unmarked pages 7', 'survey-unmarked pages 9']);
  });
});

describe('reading a survey record', () => {
  it('takes a list, an object with a survey list or with entries, and keeps only what is written', () => {
    expect(parseSurvey(JSON.stringify(RIGHT.slice(0, 1)), 'f').entries).toEqual([{ from: 0, to: 1, kind: 'front' }]);
    expect(parseSurvey(JSON.stringify({ survey: [{ from: 0, to: 1 }] }), 'f').entries).toEqual([{ from: 0, to: 1 }]);
    expect(parseSurvey(JSON.stringify({ entries: [5, { kind: 'text', extra: 1 }] }), 'f').entries).toEqual([{}, { kind: 'text' }]);
    expect(parseSurvey(`${String.fromCharCode(0xfeff)}[]`, 'f').entries).toEqual([]);
  });

  it('refuses what is no JSON and what is no list, with the format', async () => {
    const broken = await rejected(Promise.resolve().then(() => parseSurvey('[{ not json', 'survey.json')));
    expect(broken.code).toBe('E_FILE');
    expect(broken.message).toContain('is not JSON');
    expect(broken.hint).toContain('"from": 0, "to": 17, "kind": "front"');
    const object = await rejected(Promise.resolve().then(() => parseSurvey('{"hello": 1}', 'survey.json')));
    expect(object.message).toContain('is not a survey record');
  });

  it('merges the files of a folder in the order of their names, numbers as numbers, and skips sheets.json', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'survey'));
    await writeFile(join(dir, 'survey', 'overview-10.json'), JSON.stringify([{ from: 80, to: 87, kind: 'text' }]));
    await writeFile(join(dir, 'survey', 'overview-2.json'), JSON.stringify({ survey: [{ from: 8, to: 15, kind: 'text' }, { from: 16, to: 16, kind: 'blank' }] }));
    await writeFile(join(dir, 'survey', 'overview-1.json'), JSON.stringify([{ from: 0, to: 7, kind: 'front' }]));
    await writeFile(join(dir, 'survey', 'sheets.json'), JSON.stringify({ format: 'something else' }));
    await writeFile(join(dir, 'survey', 'notes.txt'), 'not a record');
    const done = await readSurvey(join(dir, 'survey'));
    expect(done.entries.map((entry) => `${entry.file as string}#${entry.at}:${entry.from as number}`)).toEqual(['overview-1.json#0:0', 'overview-2.json#0:8', 'overview-2.json#1:16', 'overview-10.json#0:80']);
    expect(done.files.map((file) => file.split(/[\\/]/).pop())).toEqual(['overview-1.json', 'overview-2.json', 'overview-10.json']);
    await writeFile(join(dir, 'survey', 'other.json'), '{"hello": 1}');
    const bad = await rejected(readSurvey(join(dir, 'survey')));
    expect(bad.message).toContain('other.json');
    expect(bad.message).toContain('is not a survey record');
    await mkdir(join(dir, 'empty'));
    expect((await rejected(readSurvey(join(dir, 'empty')))).message).toContain('holds no .json file');
    expect((await rejected(readSurvey(join(dir, 'missing.json')))).code).toBe('E_FILE');
    await writeFile(join(dir, 'one.json'), JSON.stringify(RIGHT));
    expect((await readSurvey(join(dir, 'one.json'))).files).toEqual([join(dir, 'one.json')]);
  });
});
