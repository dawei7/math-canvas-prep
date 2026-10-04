import { describe, expect, it } from 'vitest';
import { isAuthoritative, labelStyleProblem, normalizeLabel } from '../src/model/authority.js';
import type { Frame, PageText } from '../src/model/types.js';
import { checkBook, lintBook } from '../src/rules/book.js';
import { parseFrames, type CheckOptions } from '../src/rules/frames.js';
import { checkDocumentInfo } from '../src/rules/info.js';
import { lintAgainstText, lintFrames } from '../src/rules/lint.js';
import { checkOutline } from '../src/rules/outline.js';
import { bookFrame, bookOutline, ordinary } from './book-helpers.js';
import { frame, rect } from './helpers.js';

const strict: CheckOptions = { pageCount: 6, strictShapes: true };
const exercise = { id: 'e1', kind: 'exercise', page: 0, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } };
const book = { ...exercise, authority: 'book', label: '5a', section: '1.1' };
const codes = (raw: unknown, options: CheckOptions = strict): string[] => parseFrames(raw, options).issues.map((entry) => `${entry.severity}:${entry.code}`);

describe('an authoritative frame', () => {
  it('is read with its authority, label and section', () => {
    const result = parseFrames([book], strict);
    expect(result.issues).toEqual([]);
    expect(result.frames[0]).toMatchObject({ id: 'e1', authority: 'book', label: '5a', section: '1.1' });
    expect(isAuthoritative(result.frames[0] as Frame)).toBe(true);
    expect(isAuthoritative(frame('x', 'question', 0, rect(0.1, 0.1, 0.9, 0.2)))).toBe(false);
  });

  it.each([
    ['an authority that is not "book"', { ...book, authority: 'user' }, 'error:bad-authority'],
    ['an authority that is not a text', { ...book, authority: 5 }, 'error:bad-authority'],
    ['an authority on a question', { ...book, kind: 'question' }, 'error:authority-not-exercise'],
    ['an authority on a bookmark', { ...book, kind: 'bookmark' }, 'error:authority-not-exercise'],
    ['a unit together with an authority', { ...book, unit: 'u1' }, 'error:authority-unit'],
    ['an authority without a label', { ...exercise, authority: 'book', section: '1.1' }, 'error:label-missing'],
    ['an authority without a section', { ...exercise, authority: 'book', label: '5a' }, 'error:section-missing'],
    ['a label without an authority', { ...exercise, label: '5a' }, 'error:label-without-authority'],
    ['a section without an authority', { ...exercise, section: '1.1' }, 'error:section-without-authority'],
    ['a label that is not a text', { ...book, label: 5 }, 'error:bad-label'],
    ['a section that is not a text', { ...book, section: 5 }, 'error:bad-section'],
  ])('rejects %s', (_name, raw, expected) => {
    const result = parseFrames([raw], strict);
    expect(result.issues.map((entry) => `${entry.severity}:${entry.code}`)).toContain(expected);
    expect(result.frames).toHaveLength(0);
  });

  it('names the frame and the fix in every message', () => {
    for (const raw of [{ ...book, unit: 'u1' }, { ...book, label: undefined }, { ...book, section: 'no good' }, { ...book, label: '(a)' }]) {
      const issue = parseFrames([raw], strict).issues[0];
      expect(issue?.frameId).toBe('e1');
      expect(issue?.message).toContain('e1');
      expect(issue?.fix?.length ?? 0).toBeGreaterThan(10);
    }
    const unit = parseFrames([{ ...book, unit: 'u1' }], strict).issues[0];
    expect(unit?.fix).toContain('separate exercises');
    expect(unit?.fix).toContain('context');
  });

  it.each(['5', '12', '5a', 'A.3', 'II-4', '5(a)', 'Problem 3', 'a'.repeat(24), 'α1', '3/4', '1_2'])('accepts the label %j', (label) => {
    expect(codes([{ ...book, label }])).toEqual([]);
  });

  it.each(['', ' 5', '(a)', '.5', '-5', 'x'.repeat(25), 'a\tb', 'a\nb', '5*', '5,3', '§3'])('rejects the label %j', (label) => {
    expect(codes([{ ...book, label }])).toEqual(['error:bad-label']);
  });

  it.each(['1.1', 'c3', 'A_b-c.9', 'x'.repeat(60), '7'])('accepts the section id %j', (section) => {
    expect(codes([{ ...book, section }])).toEqual([]);
  });

  it.each(['', 'a b', '.x', '-x', '_x', 'x'.repeat(61), 'a/b', 'ü'])('rejects the section id %j', (section) => {
    expect(codes([{ ...book, section }])).toEqual(['error:bad-section']);
  });

  it('is tolerant in a project file about nulls, strict in a bundle', () => {
    const loose = { ...exercise, authority: null, label: null, section: null, solution: null };
    expect(codes([loose], { pageCount: 6 })).toEqual([]);
    expect(codes([loose])).toContain('error:bad-authority');
  });

  it('may continue and have context and a solution', () => {
    const rich = { ...book, continues: [{ page: 1, rect: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.2 } }], context: [{ page: 0, rect: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.09 } }], solution: [{ page: 5, rect: { left: 0.1, top: 0.4, right: 0.9, bottom: 0.45 } }] };
    const result = parseFrames([rich], strict);
    expect(result.issues).toEqual([]);
    expect(result.frames[0]?.solution).toHaveLength(1);
    expect(result.frames[0]?.continues).toHaveLength(1);
  });
});

describe('solution regions', () => {
  const region = { page: 5, rect: { left: 0.1, top: 0.4, right: 0.9, bottom: 0.45 } };

  it('are allowed on exercises, up to eight', () => {
    expect(codes([{ ...exercise, solution: [region] }])).toEqual([]);
    expect(codes([{ ...exercise, solution: Array.from({ length: 8 }, () => region) }])).toEqual([]);
    expect(codes([{ ...exercise, solution: Array.from({ length: 9 }, () => region) }])).toEqual(['error:too-many-regions']);
    expect(parseFrames([{ ...exercise, solution: Array.from({ length: 9 }, () => region) }], strict).issues[0]?.message).toContain('"solution"');
  });

  it('are refused on questions and bookmarks, naming the frame', () => {
    for (const kind of ['question', 'bookmark']) {
      const issue = parseFrames([{ ...exercise, kind, solution: [region] }], strict).issues[0];
      expect(issue).toMatchObject({ severity: 'error', code: 'solution-not-exercise', frameId: 'e1' });
    }
    expect(codes([{ ...exercise, kind: 'question', solution: [] }])).toEqual([]);
  });

  it('must be valid regions on pages of the document', () => {
    expect(codes([{ ...exercise, solution: [{ ...region, page: 6 }] }])).toEqual(['error:page-out-of-range']);
    expect(codes([{ ...exercise, solution: [{ ...region, page: -1 }] }])).toEqual(['error:page-out-of-range']);
    expect(codes([{ ...exercise, solution: [{ ...region, page: 1.5 }] }])).toEqual(['error:bad-page']);
    expect(codes([{ ...exercise, solution: [{ page: 1, rect: { left: 0.1, top: 0.4, right: 0.11, bottom: 0.41 } }] }])).toEqual(['error:rect-too-small']);
    expect(codes([{ ...exercise, solution: [{ page: 1, rect: { left: 0.1, top: 0.4, right: 0.9, bottom: 0.3 } }] }])).toEqual(['error:rect-inverted']);
    expect(codes([{ ...exercise, solution: 'x' }])).toEqual(['error:bad-regions']);
    expect(codes([{ ...exercise, solution: [{ page: 1, rect: { left: 0.1, top: 0.4, right: 0.9, bottom: 1.2 } }] }])).toEqual(['error:rect-off-page']);
    expect(codes([{ ...exercise, solution: [{ page: 1, rect: { left: 0.1, top: 0.4, right: 0.9, bottom: 1.003 } }] }])).toEqual(['repair:rect-clamped']);
  });
});

describe('labels as people write them', () => {
  it('drops the punctuation a book prints after a number, and says so', () => {
    expect(normalizeLabel('5.')).toEqual({ label: '5', changes: expect.arrayContaining([expect.stringContaining('"."')]) });
    expect(normalizeLabel('5)').label).toBe('5');
    expect(normalizeLabel('a)').label).toBe('a');
    expect(normalizeLabel('5(a)')).toEqual({ label: '5(a)', changes: [] });
    expect(normalizeLabel('  5   a ').label).toBe('5 a');
    expect(normalizeLabel('A.3').label).toBe('A.3');
    expect(normalizeLabel('.').label).toBe('.');
  });

  it('recognises a label that looks copied from the page', () => {
    expect(labelStyleProblem('5')).toBeUndefined();
    expect(labelStyleProblem('A.3')).toBeUndefined();
    expect(labelStyleProblem('5(a)')).toBeUndefined();
    expect(labelStyleProblem('5.')).toContain('"."');
    expect(labelStyleProblem('5)')).toContain('")"');
    expect(labelStyleProblem('5 ')).toContain('spaces');
    expect(labelStyleProblem('5  a')).toContain('spaces');
  });
});

describe('the rules that look at several frames', () => {
  it('reject the same exercise twice, naming both frames, and let the same label stand in another section', () => {
    const list = [bookFrame('f1', '1.1', '5a', 0, 0.4, 0.5), bookFrame('f2', '1.1', '5a', 0, 0.5, 0.6), bookFrame('f3', '1.2', '5a', 1, 0.2, 0.3), bookFrame('f4', '1.1', '5b', 0, 0.6, 0.7), bookFrame('f5', '1.1', '5a', 0, 0.7, 0.8)];
    const issues = checkBook(list, bookOutline());
    expect(issues.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['duplicate-exercise:f2', 'duplicate-exercise:f5']);
    expect(issues[0]?.message).toContain('f1');
    expect(issues[0]?.message).toContain('"5a"');
    expect(issues[0]?.message).toContain('"1.1"');
    expect(issues[0]?.fix).toContain('exercises label f2');
    expect(issues[0]?.fix).toContain('frames delete f2');
    expect(issues.every((entry) => entry.severity === 'error')).toBe(true);
  });

  it('judge the first duplicate in reading order the original, whatever the order in the list', () => {
    const issues = checkBook([bookFrame('late', '1.1', '5', 1, 0.5, 0.6), bookFrame('early', '1.1', '5', 0, 0.4, 0.5)], bookOutline());
    expect(issues).toMatchObject([{ code: 'duplicate-exercise', frameId: 'late', data: { other: 'early' } }]);
  });

  it('need every section to be an outline entry with that id', () => {
    const list = [bookFrame('f1', '1.1', '1', 0, 0.4, 0.5), bookFrame('f2', '9.9', '2', 0, 0.5, 0.6)];
    const issues = checkBook(list, bookOutline());
    expect(issues).toMatchObject([{ severity: 'error', code: 'section-unknown', frameId: 'f2' }]);
    expect(issues[0]?.message).toContain('9.9');
    expect(issues[0]?.message).toContain('known: c1, 1.1, 1.2, c2, 2.1');
    expect(issues[0]?.fix).toContain('outline add');
  });

  it('explain that a book without an outline has no sections', () => {
    for (const outline of [undefined, [], [{ title: 'No id', page: 0, depth: 0 }]]) {
      const issues = checkBook([bookFrame('f1', '1.1', '1', 0, 0.4, 0.5)], outline);
      expect(issues.map((entry) => entry.code)).toEqual(['section-unknown']);
      expect(issues[0]?.message).toContain('no outline entry with an id');
      expect(issues[0]?.fix).toContain('outline ids');
    }
  });

  it('say nothing about ordinary frames, with or without an outline', () => {
    const list = [ordinary('a', 0, 0.1, 0.2), ordinary('b', 0, 0.3, 0.4, { label: undefined })];
    expect(checkBook(list, undefined)).toEqual([]);
    expect(checkBook(list, bookOutline())).toEqual([]);
  });
});

describe('warnings about a book', () => {
  it('notice a label that carries the punctuation the book prints', () => {
    const issues = lintBook([bookFrame('f1', '1.1', '5.', 0, 0.4, 0.5), bookFrame('f2', '1.1', '6)', 0, 0.5, 0.6), bookFrame('f3', '1.1', '7(a)', 0, 0.6, 0.7), bookFrame('f4', '1.1', 'A.3', 0, 0.7, 0.8)], bookOutline(), 6);
    expect(issues.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['label-style:f1', 'label-style:f2']);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.fix).toContain('exercises label f1');
  });

  it('notice an exercise that is printed in another section than the one it is filed under', () => {
    const outline = bookOutline();
    // Page 0 from 0.3 is 1.1 (whose heading is at 0.3), page 0 above that is Chapter 1; page 1 from 0.1 is 1.2; page 3 is Chapter 2.
    const fine = [
      bookFrame('a', '1.1', '1', 0, 0.35, 0.5),
      bookFrame('b', 'c1', '2', 0, 0.35, 0.5), // a section contains its subsections
      bookFrame('c', '1.1', '3', 1, 0.02, 0.08), // 1.1 runs until 1.2 starts at page 1, 0.1
      bookFrame('d', '1.2', '4', 1, 0.2, 0.3),
      bookFrame('e', '2.1', '5', 4, 0.5, 0.6),
    ];
    expect(lintBook(fine, outline, 6)).toEqual([]);
    const wrong = [
      bookFrame('a', '1.2', '1', 0, 0.35, 0.5), // printed in 1.1
      bookFrame('b', '1.1', '2', 0, 0.1, 0.2), // above the heading of 1.1: Chapter 1, not 1.1
      bookFrame('c', '2.1', '3', 3, 0.05, 0.15), // above the heading of 2.1: Chapter 2
      bookFrame('d', 'c2', '4', 1, 0.4, 0.5), // in chapter 1
    ];
    const issues = lintBook(wrong, outline, 6);
    // In reading order: b (page 0, 0.1), a (page 0, 0.35), d (page 1), c (page 3).
    expect(issues.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['section-mismatch:b', 'section-mismatch:a', 'section-mismatch:d', 'section-mismatch:c']);
    const [b, a, d, c] = issues;
    expect(a?.message).toContain('page 0');
    expect(a?.message).toContain('1.1 Sets');
    expect(a?.message).toContain('Maps');
    expect(a?.fix).toContain('exercises section a 1.1');
    expect(b?.message).toContain('Chapter 1 Sets');
    expect(b?.fix).toContain('exercises section b c1');
    expect(d?.fix).toContain('exercises section d 1.2');
    expect(c?.message).toContain('Chapter 2 Numbers');
    expect(c?.fix).toContain('exercises section c c2');
  });

  it('notice an exercise above the first heading, and ignore unknown sections (an error elsewhere)', () => {
    const outline = [{ title: 'One', page: 2, depth: 0, id: 's1' }];
    const issues = lintBook([bookFrame('a', 's1', '1', 0, 0.2, 0.3), bookFrame('b', 'zz', '2', 3, 0.2, 0.3)], outline, 6);
    expect(issues.map((entry) => `${entry.code}:${entry.frameId}`)).toEqual(['section-mismatch:a']);
    expect(issues[0]?.message).toContain('above the first outline entry');
  });

  it('say nothing without authoritative frames', () => {
    expect(lintBook([ordinary('a', 0, 0.1, 0.2)], bookOutline(), 6)).toEqual([]);
  });
});

describe('warnings about solution regions', () => {
  const key = { page: 5, rect: rect(0.1, 0.4, 0.9, 0.45) };
  const codesOf = (list: Frame[]): string[] => lintFrames(list).map((entry) => `${entry.code}:${entry.frameId ?? ''}`);

  it('are quiet for answers in the key, shared by several exercises', () => {
    const list = [bookFrame('a', '1.1', '1', 0, 0.1, 0.2, { solution: [key] }), bookFrame('b', '1.1', '2', 0, 0.3, 0.4, { solution: [key] }), ordinary('c', 1, 0.1, 0.2, { solution: [key] })];
    expect(lintFrames(list)).toEqual([]);
  });

  it('warn when a solution region lies on the exercise itself, or on its continuation', () => {
    const own = bookFrame('a', '1.1', '1', 0, 0.1, 0.3, { solution: [{ page: 0, rect: rect(0.1, 0.1, 0.9, 0.2) }] });
    expect(codesOf([own])).toEqual(['solution-overlaps-frame:a']);
    const continued = bookFrame('b', '1.1', '2', 0, 0.5, 0.6, { continues: [{ page: 1, rect: rect(0.1, 0.1, 0.9, 0.3) }], solution: [key, { page: 1, rect: rect(0.1, 0.15, 0.9, 0.25) }] });
    const issues = lintFrames([continued]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'solution-overlaps-frame', frameId: 'b', page: 1 });
    expect(issues[0]?.message).toContain('solution region 1');
    expect(issues[0]?.fix).toContain('solution remove b --index 1');
  });

  it('warn when a solution region is the region of another exercise', () => {
    const other = bookFrame('x', '1.1', '9', 3, 0.2, 0.3);
    const copied = bookFrame('a', '1.1', '1', 0, 0.1, 0.2, { solution: [{ page: 3, rect: rect(0.1002, 0.2, 0.9, 0.3004) }] });
    const issues = lintFrames([other, copied]);
    expect(issues).toMatchObject([{ severity: 'warning', code: 'solution-is-exercise', frameId: 'a', page: 3, data: { other: 'x' } }]);
    const apart = bookFrame('a', '1.1', '1', 0, 0.1, 0.2, { solution: [{ page: 3, rect: rect(0.1, 0.21, 0.9, 0.31) }] });
    expect(lintFrames([other, apart])).toEqual([]);
    const onContinuation = bookFrame('y', '1.1', '8', 0, 0.5, 0.6, { continues: [{ page: 4, rect: rect(0.1, 0.1, 0.9, 0.2) }] });
    expect(codesOf([onContinuation, bookFrame('a', '1.1', '1', 0, 0.1, 0.2, { solution: [{ page: 4, rect: rect(0.1, 0.1, 0.9, 0.2) }] })])).toEqual(['solution-is-exercise:a']);
    const question = frame('q', 'question', 3, rect(0.1, 0.2, 0.9, 0.3));
    expect(lintFrames([question, copied]).map((entry) => entry.code)).toEqual([]);
  });

  it('read the printed lines of a solution region like those of a frame', () => {
    const page: PageText = {
      page: 5,
      size: { width: 595, height: 842, rotation: 0 },
      columns: 1,
      hasText: true,
      lines: [
        { text: '21) 17', rect: rect(0.1, 0.4, 0.5, 0.412), fontSize: 10, column: 0, chars: 6 },
        { text: '22) 0', rect: rect(0.1, 0.42, 0.5, 0.432), fontSize: 10, column: 0, chars: 5 },
      ],
    };
    const pages = new Map([[5, page]]);
    const clipped = bookFrame('a', '1.1', '22', 0, 0.1, 0.2, { solution: [{ page: 5, rect: rect(0.1, 0.426, 0.9, 0.5) }] });
    const issues = lintAgainstText([clipped], pages);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'clips-line', frameId: 'a' });
    expect(issues[0]?.message).toContain('solution[0]');
    const clean = bookFrame('a', '1.1', '22', 0, 0.1, 0.2, { solution: [{ page: 5, rect: rect(0.1, 0.416, 0.9, 0.436) }] });
    expect(lintAgainstText([clean], pages)).toEqual([]);
  });
});

describe('outline entries as sections', () => {
  const entry = { title: '1.1 Sets', page: 0, depth: 0 };
  const check = (...entries: Record<string, unknown>[]): string[] => checkOutline(entries, 4).issues.map((item) => `${item.severity}:${item.code}`);

  it('keep id, label and top', () => {
    const result = checkOutline([{ ...entry, id: '1.1', label: ' 1.1 ', top: 0.25 }, { title: 'Next', page: 1, depth: 0 }], 4);
    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([{ title: '1.1 Sets', page: 0, depth: 0, id: '1.1', label: '1.1', top: 0.25 }, { title: 'Next', page: 1, depth: 0 }]);
  });

  it.each([
    ['a bad id', { id: 'no good' }, 'error:outline-bad-id'],
    ['an id that is not a text', { id: 5 }, 'error:outline-bad-id'],
    ['an empty id', { id: '' }, 'error:outline-bad-id'],
    ['an id that starts with a dot', { id: '.x' }, 'error:outline-bad-id'],
    ['an id that is too long', { id: 'x'.repeat(61) }, 'error:outline-bad-id'],
    ['a label that is too long', { label: 'x'.repeat(25) }, 'error:outline-bad-label'],
    ['a label that is not a text', { label: 3 }, 'error:outline-bad-label'],
    ['a top below 0', { top: -0.1 }, 'error:outline-bad-top'],
    ['a top above 1', { top: 1.1 }, 'error:outline-bad-top'],
    ['a top that is not a number', { top: '0.2' }, 'error:outline-bad-top'],
  ])('rejects %s', (_name, extra, expected) => {
    expect(check({ ...entry, ...extra })).toEqual([expected]);
  });

  it('accepts the limits', () => {
    expect(check({ ...entry, id: 'x'.repeat(60), label: 'x'.repeat(24), top: 0 }, { ...entry, id: 'y', top: 1 })).toEqual([]);
    expect(check({ ...entry, label: '   ' })).toEqual([]);
    expect(check({ ...entry, id: null, label: null, top: null })).toEqual([]);
  });

  it('rejects an id used twice and names both entries', () => {
    const issues = checkOutline([{ ...entry, id: 'a' }, { title: 'Two', page: 1, depth: 0, id: 'a' }], 4).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'outline-duplicate-id' });
    expect(issues[0]?.message).toContain('"a"');
    expect(issues[0]?.message).toContain('entry 1');
    expect(issues[0]?.message).toContain('entry 0');
    expect(issues[0]?.message).toContain('Two');
  });
});

describe('the document info of a bundle', () => {
  const info = { author: ' A. Author ', series: 'Prerequisites', description: 'A book.', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, sourceUrl: 'https://example.org/the-book', notice: 'Attribution: A. Author. Changes: marked for study.' };

  it('is kept, trimmed, when it is in order', () => {
    const result = checkDocumentInfo(info, { strict: true, where: 'document' });
    expect(result.issues).toEqual([]);
    expect(result.info).toEqual({ ...info, author: 'A. Author' });
    expect(Object.keys(result.info)).toEqual(['author', 'series', 'description', 'license', 'sourceUrl', 'notice']);
  });

  it('is optional in every part', () => {
    expect(checkDocumentInfo({}, { strict: true, where: 'document' })).toEqual({ info: {}, issues: [] });
    expect(checkDocumentInfo('nonsense', { strict: true, where: 'document' })).toEqual({ info: {}, issues: [] });
    expect(checkDocumentInfo({ author: '  ', license: null, sourceUrl: null }, { strict: true, where: 'document' })).toEqual({ info: {}, issues: [] });
    expect(checkDocumentInfo({ license: { name: 'MIT' } }, { strict: true, where: 'meta' }).info).toEqual({ license: { name: 'MIT' } });
  });

  it('is judged strictly by a writer: too long, wrong kind and bad addresses are errors that name the field', () => {
    const bad = checkDocumentInfo(
      { author: 'x'.repeat(201), series: 5, description: 'x'.repeat(4001), notice: 'x'.repeat(4001), sourceUrl: 'example.org', license: { name: 'x'.repeat(101), url: 'ftp://x.org/a' } },
      { strict: true, where: 'meta' },
    );
    expect(bad.issues.every((item) => item.severity === 'error')).toBe(true);
    expect(bad.issues.map((item) => item.code).sort()).toEqual(['info-bad-type', 'info-bad-url', 'info-too-long', 'info-too-long', 'info-too-long', 'info-too-long'].sort());
    expect(bad.issues.find((item) => item.code === 'info-bad-url')?.message).toContain('meta.sourceUrl');
    expect(bad.issues.find((item) => item.code === 'info-too-long')?.fix).toContain('Shorten');
    expect(bad.info).toEqual({});
  });

  it('is judged leniently by a reader: texts are cut, what cannot be used is ignored', () => {
    const result = checkDocumentInfo(
      { author: 'x'.repeat(250), series: 5, description: 'ok', sourceUrl: 'javascript:alert(1)', license: { name: 'MIT', url: 'not a url' }, notice: 'n' },
      { strict: false, where: 'document' },
    );
    expect(result.info.author).toHaveLength(200);
    expect(result.info).toMatchObject({ description: 'ok', notice: 'n', license: { name: 'MIT' } });
    expect(result.info).not.toHaveProperty('series');
    expect(result.info).not.toHaveProperty('sourceUrl');
    expect(result.info.license).not.toHaveProperty('url');
    expect(result.issues.map((item) => `${item.severity}:${item.code}`).sort()).toEqual(['repair:info-cut', 'warning:info-ignored', 'warning:info-ignored', 'warning:info-ignored'].sort());
  });

  it('accepts http and https addresses of up to 500 characters only', () => {
    const long = `https://example.org/${'a'.repeat(480)}`;
    expect(checkDocumentInfo({ sourceUrl: long }, { strict: true, where: 'meta' }).issues).toEqual([]);
    expect(checkDocumentInfo({ sourceUrl: `${long}${'a'.repeat(20)}` }, { strict: true, where: 'meta' }).issues[0]?.code).toBe('info-bad-url');
    expect(checkDocumentInfo({ sourceUrl: 'http://example.org' }, { strict: true, where: 'meta' }).issues).toEqual([]);
    expect(checkDocumentInfo({ sourceUrl: 'file:///etc/passwd' }, { strict: true, where: 'meta' }).issues[0]?.code).toBe('info-bad-url');
  });

  it('needs a licence to have a name', () => {
    expect(checkDocumentInfo({ license: { url: 'https://x.org' } }, { strict: true, where: 'meta' }).issues[0]?.code).toBe('info-bad-license');
    expect(checkDocumentInfo({ license: 'MIT' }, { strict: true, where: 'meta' }).issues[0]?.code).toBe('info-bad-license');
    expect(checkDocumentInfo({ license: { name: '  ' } }, { strict: true, where: 'meta' }).issues[0]?.code).toBe('info-bad-license');
  });
});
