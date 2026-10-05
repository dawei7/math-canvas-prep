import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptanceArguments,
  formatSeconds,
  groupFindings,
  indexMarkdown,
  itemPatternProblem,
  licenseStated,
  loadFolderQueue,
  loadQueue,
  loadQueueFile,
  nameProblem,
  parseFacts,
  parseSummary,
  suggestFrontMatter,
  type AcceptanceSummary,
  type IndexRow,
  type QueuedBook,
} from '../src/audit-queue.js';
import { tempDir } from './helpers.js';

const PDF = '%PDF-1.4\n% a stand-in: the queue only looks at the names\n';

async function folderWith(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('mcprep-queue-');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...name.split('/')), content);
  }
  return dir;
}

const GOOD = {
  title: 'Beginning Algebra',
  folder: 'Books\\Algebra',
  author: 'A. Author',
  series: 'Prerequisites',
  description: 'A short description.',
  license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  sourceUrl: 'https://example.org/the-book',
  notice: 'Beginning Algebra by A. Author, licensed under CC BY 3.0.',
  options: { chapterWords: 'chapter, kapitel', practiceWords: ['exercises', 'problems'], itemPattern: ['^([A-Z]\\.\\d+)\\s+(.*)$'], instructions: 'margin' },
  maxItems: 40,
  reference: 'reference.json',
  referenceChapterOffset: -1,
};

describe('a folder of books', () => {
  it('takes every PDF of the folder as a book, named by its file, and reads the sidecar beside it', async () => {
    const dir = await folderWith({
      'algebra.pdf': PDF,
      'algebra.meta.json': JSON.stringify(GOOD),
      'reference.json': '{}',
      'Calculus Notes.pdf': PDF,
      'notes.txt': 'not a book',
      '.hidden.pdf': PDF,
      'archive/deep.pdf': PDF,
    });
    const queue = await loadFolderQueue(dir);
    expect(queue.mode).toBe('folder');
    expect(queue.problems).toEqual([]);
    expect(queue.warnings).toEqual([]);
    expect(queue.books.map((book) => book.name)).toEqual(['algebra', 'Calculus Notes']);
    const [algebra, notes] = queue.books as [QueuedBook, QueuedBook];
    expect(algebra.pdf).toBe(join(dir, 'algebra.pdf'));
    expect(algebra).toMatchObject({
      title: 'Beginning Algebra',
      folder: 'Books/Algebra',
      info: { author: 'A. Author', series: 'Prerequisites', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, sourceUrl: 'https://example.org/the-book' },
      options: { chapterWords: ['chapter', 'kapitel'], practiceWords: ['exercises', 'problems'], itemPattern: ['^([A-Z]\\.\\d+)\\s+(.*)$'], instructions: 'margin' },
      maxItems: 40,
      referenceChapterOffset: -1,
    });
    expect(algebra.reference).toBe(join(dir, 'reference.json'));
    expect(licenseStated(algebra)).toBe(true);
    // A book without a sidecar: a title from the file name, the default folder, and nothing known about the licence.
    expect(notes).toMatchObject({ title: 'Calculus Notes', folder: 'Books', info: {}, options: {} });
    expect(licenseStated(notes)).toBe(false);
  });

  it('says what is wrong with a sidecar and leaves that book out, the others stay', async () => {
    const dir = await folderWith({
      'good.pdf': PDF,
      'typo.pdf': PDF,
      'typo.meta.json': JSON.stringify({ licence: { name: 'CC BY 3.0' }, title: 'Typo' }),
      'broken.pdf': PDF,
      'broken.meta.json': '{ "title": ',
      'nolicensename.pdf': PDF,
      'nolicensename.meta.json': JSON.stringify({ license: { url: 'https://example.org/l' } }),
      'badurl.pdf': PDF,
      'badurl.meta.json': JSON.stringify({ sourceUrl: 'example.org/book' }),
      'pattern.pdf': PDF,
      'pattern.meta.json': JSON.stringify({ options: { itemPattern: ['^\\d+\\)'], instructions: 'sometimes' }, maxItems: 0 }),
      'words.pdf': PDF,
      'words.meta.json': JSON.stringify({ options: { stopWords: [], answerMarkers: ['^Section (\\d)$', '^(unclosed'], backwords: ['back'] } }),
      'offset.pdf': PDF,
      'offset.meta.json': JSON.stringify({ referenceChapterOffset: -1 }),
      'missing.pdf': PDF,
      'missing.meta.json': JSON.stringify({ reference: 'nowhere.json' }),
      'orphan.meta.json': '{}',
    });
    const queue = await loadFolderQueue(dir);
    expect(queue.books.map((book) => book.name)).toEqual(['good']);
    const problem = (name: string): string => queue.problems.find((entry) => entry.name === name)?.message ?? '';
    expect(problem('typo')).toContain('unknown field "licence" (did you mean "license"?)');
    expect(problem('broken')).toContain('broken.meta.json cannot be read');
    expect(problem('nolicensename')).toContain('needs a name');
    expect(problem('badurl')).toContain('not a web address');
    expect(problem('pattern')).toContain('has no group for the label');
    expect(problem('pattern')).toContain('options.instructions must be one of');
    expect(problem('pattern')).toContain('maxItems must be a whole number');
    expect(problem('words')).toContain('options.stopWords needs at least one word');
    expect(problem('words')).toContain('options.answerMarkers "^(unclosed" is not usable');
    expect(problem('words')).toContain('unknown field "backwords" (did you mean "backWords"?)');
    expect(problem('offset')).toContain('referenceChapterOffset needs a reference');
    expect(problem('missing')).toContain('nowhere.json does not exist');
    expect(queue.warnings).toEqual(['orphan.meta.json has no PDF beside it (orphan.pdf): it is not used.']);
  });

  it('reports a folder without PDFs, and a path that does not exist', async () => {
    const empty = await loadFolderQueue(await folderWith({ 'readme.txt': 'nothing' }));
    expect(empty.books).toEqual([]);
    expect(empty.warnings.join(' ')).toContain('There is no PDF in');
    const missing = await loadQueue(join(await tempDir('mcprep-queue-'), 'nowhere'));
    expect(missing.problems[0]?.message).toContain('does not exist');
  });
});

describe('a queue file', () => {
  it('reads the books of the file with paths relative to it, and a name of its own', async () => {
    const dir = await folderWith({ 'shelf/one.pdf': PDF, 'shelf/two.pdf': PDF, 'ref/one.json': '{}' });
    const file = join(dir, 'queue.json');
    await writeFile(
      file,
      JSON.stringify({
        books: [
          { pdf: 'shelf/one.pdf', title: 'One', reference: 'ref/one.json' },
          { pdf: join(dir, 'shelf', 'two.pdf'), name: 'second', license: { name: 'CC BY-SA 4.0' }, maxItems: 30 },
        ],
      }),
    );
    const queue = await loadQueueFile(file);
    expect(queue.mode).toBe('queue');
    expect(queue.problems).toEqual([]);
    expect(queue.books.map((book) => [book.name, book.title])).toEqual([['one', 'One'], ['second', 'second']]);
    expect(queue.books[0]?.pdf).toBe(join(dir, 'shelf', 'one.pdf'));
    expect(queue.books[0]?.reference).toBe(join(dir, 'ref', 'one.json'));
    expect(queue.books[1]).toMatchObject({ info: { license: { name: 'CC BY-SA 4.0' } }, maxItems: 30 });
    expect((await loadQueue(file)).books).toHaveLength(2);
  });

  it('refuses what cannot be run and names the entry: no pdf, a missing file, a name used twice, a wrong name', async () => {
    const dir = await folderWith({ 'a.pdf': PDF, 'b.pdf': PDF, 'text.txt': 'x' });
    const file = join(dir, 'queue.json');
    await writeFile(
      file,
      JSON.stringify({
        extra: 1,
        books: [
          { pdf: 'a.pdf' },
          { title: 'no pdf' },
          { pdf: 'gone.pdf' },
          { pdf: 'b.pdf', name: 'A' },
          { pdf: 'b.pdf', name: 'a/b' },
          { pdf: 'text.txt' },
          { pdf: 'b.pdf', name: 'fine', author: 7 },
        ],
      }),
    );
    const queue = await loadQueueFile(file);
    expect(queue.books.map((book) => book.name)).toEqual(['a']);
    const messages = queue.problems.map((entry) => `${entry.name}: ${entry.message}`);
    expect(messages.find((text) => text.startsWith('books[1]'))).toContain('needs a "pdf"');
    expect(messages.find((text) => text.startsWith('gone'))).toContain('does not exist');
    expect(messages.find((text) => text.startsWith('A:'))).toContain('already used');
    expect(messages.find((text) => text.startsWith('a/b'))).toContain('cannot be used as the name');
    expect(messages.find((text) => text.startsWith('text'))).toContain('is not a PDF');
    expect(messages.find((text) => text.startsWith('fine'))).toContain('author: must be a text');
    expect(queue.warnings).toEqual(['The field "extra" of the queue is not used.']);
    await writeFile(file, '{ "books": 3 }');
    expect((await loadQueueFile(file)).problems[0]?.message).toContain('a list of books');
  });
});

describe('the facts of a book', () => {
  it('takes the limits of what a document may say about itself from the format', () => {
    const tooLong = parseFacts({ author: 'x'.repeat(201) }, { name: 'a', baseDir: '/books', where: 'a.meta.json' });
    expect(tooLong.problems.join(' ')).toContain('at most 200 are allowed');
    const folder = parseFacts({ folder: '  ' }, { name: 'a', baseDir: '/books', where: 'a.meta.json' });
    expect(folder.problems.join(' ')).toContain('folder is empty');
    expect(parseFacts({ title: '' }, { name: 'a', baseDir: '/books', where: 'x' }).problems.join(' ')).toContain('title');
    expect(parseFacts('text', { name: 'a', baseDir: '/books', where: 'x' }).problems).toEqual(['x must be a JSON object.']);
    // The fields of a queue entry are not fields of a sidecar.
    expect(parseFacts({ pdf: 'a.pdf' }, { name: 'a', baseDir: '/books', where: 'x' }).problems[0]).toContain('unknown field "pdf"');
  });

  it('checks the name of a book and an item pattern the way the commands do', () => {
    expect(nameProblem('Beginning Algebra (2nd ed.)')).toBeUndefined();
    expect(nameProblem('a:b')).toContain('cannot be used');
    expect(nameProblem('trailing.')).toContain('cannot be used');
    expect(nameProblem(' padded')).toContain('cannot be used');
    expect(itemPatternProblem('^([A-Z]\\.\\d+)\\s+(.*)$')).toBeUndefined();
    expect(itemPatternProblem('^\\d+\\)')).toBe('it has no group for the label');
    expect(itemPatternProblem('^(unclosed')).toContain('Unterminated group');
  });

  it('knows whether the sidecar names a licence (it is optional)', () => {
    expect(licenseStated({ info: {} })).toBe(false);
    expect(licenseStated({ info: { author: 'A. Author' } })).toBe(false);
    expect(licenseStated({ info: { license: { name: 'CC BY 3.0' } } })).toBe(true);
  });
});

describe('the arguments of the acceptance script', () => {
  const book = (facts: Partial<QueuedBook> = {}): QueuedBook => ({ name: 'algebra', pdf: '/books/inbox/algebra.pdf', title: 'Algebra', folder: 'Books', info: {}, options: {}, ...facts });

  it('names the PDF, the results folder and the title, and passes nothing that is not known', () => {
    expect(acceptanceArguments(book(), { outDir: '/books/results/algebra' })).toEqual(['/books/inbox/algebra.pdf', '--out', '/books/results/algebra', '--name', 'algebra', '--title', 'Algebra', '--folder', 'Books']);
  });

  it('passes every fact of the sidecar as the option the script has for it', () => {
    const args = acceptanceArguments(
      book({
        title: 'Beginning Algebra',
        folder: 'Books/Algebra',
        info: { author: 'A. Author', series: 'S', description: 'D', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, sourceUrl: 'https://example.org/b', notice: 'N' },
        options: { chapterWords: ['chapter', 'kapitel'], practiceWords: ['exercises'], answerWords: ['answers'], stopWords: ['warm-up answers'], itemWords: ['aufgabe'], backWords: ['zurück'], answerMarkers: ['^Teil\\s+(\\d+\\.\\d+)'], itemPattern: ['^(a)$', '^(b)$'], instructions: 'bold' },
        maxItems: 40,
        reference: '/books/inbox/reference.json',
        referenceChapterOffset: -1,
      }),
      { outDir: '/out/algebra', sample: 31 },
    );
    expect(args).toEqual([
      '/books/inbox/algebra.pdf',
      '/books/inbox/reference.json',
      '--out', '/out/algebra',
      '--name', 'algebra',
      '--title', 'Beginning Algebra',
      '--folder', 'Books/Algebra',
      '--author', 'A. Author',
      '--series', 'S',
      '--description', 'D',
      '--license-name', 'CC BY 3.0',
      '--license-url', 'https://creativecommons.org/licenses/by/3.0/',
      '--source-url', 'https://example.org/b',
      '--notice', 'N',
      '--reference-chapter-offset', '-1',
      '--max-items', '40',
      '--chapter-words', 'chapter,kapitel',
      '--practice-words', 'exercises',
      '--answer-words', 'answers',
      '--stop-words', 'warm-up answers',
      '--item-words', 'aufgabe',
      '--back-words', 'zurück',
      '--answer-marker', '^Teil\\s+(\\d+\\.\\d+)',
      '--item-pattern', '^(a)$',
      '--item-pattern', '^(b)$',
      '--instructions', 'bold',
      '--sample', '31',
      '--solution-sample', '16',
    ]);
  });

  it('writes no licence option for a book that states none', () => {
    const args = acceptanceArguments(book({ info: { author: 'A. Author' } }), { outDir: '/o' });
    expect(args).toContain('--author');
    expect(args.some((arg) => arg.startsWith('--license'))).toBe(false);
  });
});

describe('the summary of a book', () => {
  const good: AcceptanceSummary = {
    name: 'algebra',
    title: 'Algebra',
    pages: 489,
    chapters: 11,
    sections: 77,
    exercises: 3027,
    withSolution: 3026,
    withoutAnswer: 1,
    answersWithoutExercise: 0,
    validation: { ok: true, errors: 0, warnings: 84 },
    verify: { errors: 0, warnings: 4, infos: 0, byCode: { 'warning context-overlaps-frame': 4 } },
    importCheck: { wouldImport: true },
    idempotent: true,
    license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
    licenseStated: true,
    author: 'A. Author',
    suggestions: [],
    reference: { sections: 77, found: 77, missing: [], extra: [], equalCounts: 72, countDifferences: [{ label: '1.7', title: 'Variation', reference: 20, found: 38 }], titleDifferences: 0, totalReference: 2944, totalFound: 3027 },
    edgesOnInk: 19,
    regions: 8953,
    toLookAt: ['1.7 Variation: the book prints 38 numbered exercises, the reference lists 20 (pages 60-62, crops/beyond-1.7-*.png)', '3.3: no answer for 35'],
    files: { project: 'algebra-audited.mcprep.json', bundle: 'algebra-audited.mcbundle', report: 'acceptance-report.md', details: 'acceptance-details.json', sheets: 'sheets', crops: 'crops' },
    seconds: 55,
  };

  it('is accepted when it has what the index needs, and refused with the name of what is missing', () => {
    expect(parseSummary(good).summary?.exercises).toBe(3027);
    expect(parseSummary({ ...good, pages: 'many' }).problem).toContain('"pages"');
    expect(parseSummary({ ...good, files: undefined }).problem).toContain('validation and no files');
    expect(parseSummary(null).problem).toContain('not a JSON object');
    expect(parseSummary({ ...good, toLookAt: 'x' }).problem).toContain('toLookAt');
  });

  const rows = (): IndexRow[] => [
    { name: 'algebra', status: 'ok', summary: good, seconds: 55, folder: 'algebra', licenseStated: true },
    {
      name: 'My Calculus',
      status: 'ok',
      summary: { ...good, name: 'My Calculus', title: 'My Calculus', license: null, licenseStated: false, author: null, importCheck: null, validation: { ok: false, errors: 2, warnings: 0 }, verify: { errors: 12, warnings: 3, infos: 0, byCode: { 'error overlap': 12 } }, reference: null, withSolution: 0, toLookAt: [], suggestions: [{ field: 'license.name', value: 'CC BY-SA 4.0', page: 1, evidence: 'This work is licensed under CC BY-SA 4.0.' }], files: { ...good.files, bundle: null } },
      seconds: 125,
      folder: 'My Calculus',
      licenseStated: false,
    },
    { name: 'broken', status: 'failed', reason: 'the script stopped (exit 1): The PDF is damaged.', seconds: 3, folder: 'broken', licenseStated: true },
    { name: 'typo', status: 'not run', reason: 'unknown field "licence"', seconds: 0, folder: 'typo' },
  ];

  it('is a table with a row for every book and a line for what went wrong with one', () => {
    const text = indexMarkdown({ generatedAt: new Date('2026-10-04T13:05:00Z'), source: '/books/inbox', outDir: '/books/results', rows: rows(), warnings: ['orphan.meta.json has no PDF beside it (orphan.pdf): it is not used.'] });
    expect(text).toContain('# Books audited');
    expect(text).toContain('2026-10-04 13:05 UTC. 4 books from /books/inbox: 2 audited, 2 not.');
    expect(text).toContain('| book | pages | chapters | sections | exercises | with answer | validation | text check | importer | licence | against the reference | time | files |');
    expect(text).toContain('| algebra | 489 | 11 | 77 | 3027 | 3026 (99.97 %) | ok: 0 errors, 84 warnings | ok: 0 errors, 4 warnings | accepts | CC BY 3.0 | 72 of 77 sections equal; 1 count differs | 55 s | [bundle](algebra/algebra-audited.mcbundle) [project](algebra/algebra-audited.mcprep.json) [report](algebra/acceptance-report.md) [sheets](algebra/sheets) |');
    expect(text).toContain('| My Calculus | 489 | 11 | 77 | 3027 | 0 (0 %) | **errors**: 2 errors, 0 warnings | **errors**: 12 errors, 3 warnings | **no bundle** |  | no reference | 2 min 05 s |');
    expect(text).toContain('[project](My%20Calculus/algebra-audited.mcprep.json)');
    expect(text).toContain('| broken |  |  |  |  |  |  |  |  | stated |  | 3 s | **FAILED**: the script stopped (exit 1): The PDF is damaged. [log](broken/run.log) |');
    expect(text).toContain('| typo |  |  |  |  |  |  |  |  |  |  | 0 s | **NOT RUN**: unknown field "licence"  |');
    expect(text).toContain('- orphan.meta.json has no PDF beside it');
  });

  it('mentions in one line that author, licence and notice are optional, names the books that state none, and shows suggestions as guesses', () => {
    const text = indexMarkdown({ generatedAt: new Date('2026-10-04T13:05:00Z'), source: '/books/inbox', outDir: '/books/results', rows: rows() });
    // A book that was not run says nothing about its licence.
    expect(text).toContain('Author, licence and notice are optional (the sidecar `<name>.meta.json` can say them; none stated for My Calculus). A bundle contains the whole book: keep it private. Nothing is uploaded.');
    expect(text).not.toContain('My Calculus, typo');
    expect(text).not.toMatch(/check before you share/i);
    expect(text).toContain('## My Calculus');
    expect(text).toContain('Read from the front matter of the PDF, as guesses (put what is right into `My Calculus.meta.json` and run it again with `--only "My Calculus"`; nothing was written into the bundle):');
    expect(text).toContain('- license.name: `CC BY-SA 4.0` (page 2: "This work is licensed under CC BY-SA 4.0.")');
    expect(text).not.toContain('`CC BY 3.0`');
    // Every book states one: no mention of the books without.
    const stated = indexMarkdown({ generatedAt: new Date('2026-10-04T13:05:00Z'), source: '/books/inbox', outDir: '/books/results', rows: [rows()[0] as IndexRow] });
    expect(stated).toContain('Author, licence and notice are optional (the sidecar `<name>.meta.json` can say them). A bundle contains the whole book');
  });

  it('lists what to look at for every book, the failures with their reason, and the three next steps', () => {
    const text = indexMarkdown({ generatedAt: new Date('2026-10-04T13:05:00Z'), source: '/books/inbox', outDir: '/books/results', rows: rows() });
    // Paths of the findings are given from the folder of the results.
    expect(text).toContain('## algebra\n\nTo look at:\n\n- 1.7 Variation: the book prints 38 numbered exercises, the reference lists 20 (pages 60-62, algebra/crops/beyond-1.7-*.png)\n- 3.3: no answer for 35');
    expect(text).toContain('Nothing to look at beyond the contact sheets.');
    expect(text).toContain('## broken\n\nFailed: the script stopped (exit 1): The PDF is damaged.');
    expect(text).toContain('## typo\n\nNot run: unknown field "licence"');
    expect(text).toMatch(/## Next\n\n1\. \*\*Look\.\*\*[^\n]*\n2\. \*\*Decide\.\*\*[^\n]*\n3\. \*\*Use\.\*\*[^\n]*Math Canvas library/);
  });

  it('formats times for people', () => {
    expect(formatSeconds(0.4)).toBe('0 s');
    expect(formatSeconds(59.4)).toBe('59 s');
    expect(formatSeconds(60)).toBe('1 min 00 s');
    expect(formatSeconds(3725)).toBe('62 min 05 s');
  });
});

describe('the findings of a book', () => {
  it('puts the same finding for many sections into one line that names them', () => {
    const findings = [
      'No answer key was found.',
      ...['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8'].map((label) => `${label}: no practice heading found, so no exercises can be proposed for it`),
      '2.1: the number 5 is printed twice',
      '2.2: the number 5 is printed twice',
      '3.1: no answer for 7',
    ];
    expect(groupFindings(findings)).toEqual([
      'No answer key was found.',
      'no practice heading found, so no exercises can be proposed for it (8 sections: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, ...)',
      '2.1: the number 5 is printed twice',
      '2.2: the number 5 is printed twice',
      '3.1: no answer for 7',
    ]);
    expect(groupFindings(findings, 2).filter((line) => line.includes('printed twice'))).toEqual(['the number 5 is printed twice (2 sections: 2.1, 2.2)']);
    expect(groupFindings([])).toEqual([]);
  });
});

describe('suggestions from the front matter', () => {
  const page = (...lines: string[]) => [{ page: 1, lines }];

  it('reads a Creative Commons licence from the words and from the address, and says where', () => {
    const found = suggestFrontMatter(page('This work is licensed under a Creative Commons Attribution 3.0 Unported License.', 'See http://creativecommons.org/licenses/by/3.0/ for the terms.'));
    expect(found).toEqual([
      { field: 'license.name', value: 'CC BY 3.0', page: 1, evidence: 'This work is licensed under a Creative Commons Attribution 3.0 Unported License.' },
      { field: 'license.url', value: 'https://creativecommons.org/licenses/by/3.0/', page: 1, evidence: 'See http://creativecommons.org/licenses/by/3.0/ for the terms.' },
    ]);
  });

  it('reads the short names and the longer ones with extra conditions', () => {
    expect(suggestFrontMatter(page('Released under CC BY-NC-SA 4.0')).map((entry) => entry.value)).toEqual(['CC BY-NC-SA 4.0']);
    expect(suggestFrontMatter(page('Licensed under CC BY')).map((entry) => entry.value)).toEqual(['CC BY']);
    expect(suggestFrontMatter(page('Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License')).map((entry) => entry.value)).toEqual(['CC BY-NC-SA 4.0']);
  });

  it('reads an author from a line that names one, and the holder of a copyright', () => {
    expect(suggestFrontMatter(page('Beginning Algebra', 'by Jane Q. Public', 'Second edition')).map((entry) => [entry.field, entry.value])).toEqual([['author', 'Jane Q. Public']]);
    expect(suggestFrontMatter(page('Copyright 2015 Jane Public')).map((entry) => [entry.field, entry.value])).toEqual([['author', 'Jane Public']]);
    // The full stop that ends the sentence is not part of the name; the dot of an initial is.
    expect(suggestFrontMatter(page('Copyright © 2009 Terry Sample.')).map((entry) => entry.value)).toEqual(['Terry Sample']);
    expect(suggestFrontMatter(page('by Jane Q. Public.')).map((entry) => entry.value)).toEqual(['Jane Q. Public']);
    expect(suggestFrontMatter(page('© 2012 Richard Roe and John Doe')).map((entry) => entry.value)).toEqual([]);
  });

  it('warns about "all rights reserved" and proposes nothing from a page that says nothing', () => {
    expect(suggestFrontMatter(page('Copyright 2015 Example Press. All rights reserved.')).map((entry) => [entry.field, entry.value])).toEqual([['warning', 'all rights reserved']]);
    expect(suggestFrontMatter(page('Chapter 1', 'Solve each equation.', 'Some rights reserved')).length).toBe(0);
    expect(suggestFrontMatter([])).toEqual([]);
  });

  it('never repeats a value and keeps at most eight', () => {
    const lines = Array.from({ length: 20 }, (_unused, k) => `by Author${String.fromCharCode(65 + k)} Name${String.fromCharCode(65 + k)}`);
    expect(suggestFrontMatter(page(...lines, ...lines)).length).toBeLessThanOrEqual(8);
    expect(suggestFrontMatter(page('Licensed under CC BY 3.0', 'Licensed under CC BY 3.0')).length).toBe(1);
  });
});
