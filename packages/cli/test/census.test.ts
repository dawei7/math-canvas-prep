import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExoticBook, buildNumberedBook, buildPdf, type ExoticBook, type NumberedBook, type PdfPageSpec } from '@mcprep/core/testing';
import { cliFor } from './audited.js';
import type { Cli, Result } from './helpers.js';

/**
 * `exercises census`, the finding numbered-run-uncovered at the gate, and two synthetic books that the census was made for: a statistics workbook whose
 * exercise sets are headed "1.6 Exercises" with items numbered on through the chapter (a bibliography, a printed contents and an index of numbered
 * entries in it, answers to the odd items only), and a book whose layout the finder of exercises does not read at all (boxed items "7)" in two columns).
 */

interface Run {
  id: string;
  pages: number[];
  firstPage: number;
  lastPage: number;
  first: string;
  last: string;
  count: number;
  missing: number;
  scheme: string;
  step: number;
  parity?: string;
  heading?: string;
  start: string;
  coverage: number;
  covered: boolean;
  itemsOutside?: number;
  items?: { page: number; label: string; n: number; text: string; covered: boolean }[];
}
interface Left {
  id: string;
  firstPage: number;
  lastPage: number;
  count: number;
  reason: string;
}
interface Census {
  format: string;
  version: number;
  pages: number;
  minRun: number;
  listed?: number;
  summary: { runs: number; items: number; pagesWithRuns: number; covered: number; uncovered: number; itemsOutside: number; leftOut: number };
  runs: Run[];
  leftOut: Left[];
}
interface Finding {
  source: string;
  code: string;
  severity: string;
  ref: string;
  page: number | null;
  message: string;
  evidence: string;
  acknowledgeable: boolean;
}
interface Gate {
  passed: boolean;
  perfect: boolean;
  unconfirmed: number;
  open: Finding[];
  acknowledged: { finding: Finding; acknowledgement: { confirmed: boolean; by: string; confirmedBy?: string } }[];
  unusedAcknowledgements: unknown[];
  checks: { survey: { exhaustive: boolean; pages: number; missing: number; uncovered: number; unmarked: number } | null };
}

const censusOf = (done: Result): Census => done.json.result as unknown as Census;
const gateOf = (done: Result): Gate => done.json.result as unknown as Gate;
const said = (done: Result): string => `${done.json.error?.message ?? ''} ${done.json.error?.hint ?? ''}`;
const uncoveredRefs = (gate: Gate): string[] => gate.open.filter((finding) => finding.code === 'numbered-run-uncovered').map((finding) => finding.ref).sort();
const rectArg = (rect: { left: number; top: number; right: number; bottom: number }): string => `${rect.left},${rect.top},${rect.right},${rect.bottom}`;

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };
const schemaOf = (name: string): object => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;
const census = (): Validator => new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schemaOf('census'));

async function must(cli: Cli, args: string[], options?: { stdin?: string }): Promise<Result> {
  const done = await cli(args, options);
  if (done.code !== 0) throw new Error(`${args.join(' ')} failed (${done.code}): ${done.stdout}${done.stderr}`);
  return done;
}

/** The statistics workbook as a project with its outline and no exercise. */
async function numberedProject(): Promise<{ cli: Cli; book: NumberedBook }> {
  const book = buildNumberedBook();
  const cli = await cliFor(book.pdf);
  await must(cli, ['init', 'book.pdf', '--title', book.title]);
  await must(cli, ['outline', 'set', '-'], { stdin: JSON.stringify(book.outline) });
  return { cli, book };
}

const frameOps = (book: NumberedBook, chapter: number): object[] => {
  const set = book.sets[chapter - 1] as NumberedBook['sets'][number];
  return set.items.map((item) => ({ op: 'add', kind: 'exercise', authority: 'book', section: set.section, label: item.label, page: item.page, rect: item.rect, ...(item.continues.length > 0 ? { continues: item.continues } : {}) }));
};
const solutionOps = (book: NumberedBook): object[] =>
  book.keys.flatMap((key) => key.items.map((item) => ({ op: 'solution.add', id: `${(book.sets[key.chapter - 1] as NumberedBook['sets'][number]).section}:${item.label}`, page: item.page, rect: item.rect })));

describe('exercises census on a textbook whose sets the finder was never asked about', () => {
  it('lists every run with its pages, labels, scheme, heading and coverage, and says what it left out; the runs are the ones the book prints', async () => {
    const { cli, book } = await numberedProject();
    const done = await cli(['exercises', 'census']);
    expect(done.code).toBe(0);
    const report = censusOf(done);
    expect(report).toMatchObject({ format: 'math-canvas-census', version: 1, pages: book.pageCount, minRun: 5, listed: 5 });
    expect(report.summary).toEqual({ runs: 5, items: 48, pagesWithRuns: 6, covered: 0, uncovered: 5, itemsOutside: 48, leftOut: 3 });
    expect(report.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, step: run.step, pages: run.pages }))).toEqual(book.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, step: run.step, pages: run.pages })));
    expect(report.runs.map((run) => run.heading)).toEqual(['1.6 Exercises', '2.5 Exercises', 'References', expect.stringContaining('Appendix A'), expect.stringContaining('Appendix A')]);
    expect(report.runs.map((run) => run.parity)).toEqual([undefined, undefined, undefined, 'odd', 'odd']);
    expect(report.runs[0]).toMatchObject({ scheme: 'k.', missing: 0, coverage: 0, covered: false, itemsOutside: 14, start: '1. Orchard yields. The table below shows the yield of forty' });
    expect(report.runs.every((run) => run.items === undefined)).toBe(true);
    // The printed contents and the index are no run, and the list says so: nothing is left out in silence.
    expect(report.leftOut).toMatchObject([
      { id: 'p1:1.1', reason: 'contents', firstPage: book.contentsPage },
      { id: 'p1:2.1', reason: 'contents', firstPage: book.contentsPage },
      { id: 'p8:1', reason: 'contents', firstPage: book.indexPage },
    ]);
    // The list of four steps is no run (fewer than five items), the bibliography is one (it is a candidate like any other).
    expect(report.runs.some((run) => run.pages.includes(book.stepsPage))).toBe(false);
    expect(report.runs.find((run) => run.id === `p${book.references.page}:1`)).toMatchObject({ count: book.references.count, heading: 'References' });
  });

  it('prints the table a person reads: the runs, the line above each, what was left out and what to do next', async () => {
    const { cli } = await numberedProject();
    const text = (await cli(['exercises', 'census'], { json: false })).stdout;
    expect(text).toContain('5 runs of 5 or more numbered items (48 items) on 6 pages of 11: 0 covered by the project, 5 not (48 items outside every region).');
    expect(text).toMatch(/p3:1\s+3-4\s+1\. to 14\.\s+14\s+k\.\s+0%\s+1\.6 Exercises/);
    expect(text).toMatch(/p10:1#2\s+10\s+1\. to 11\.\s+6\s+k\. odd only/);
    expect(text).toContain('Left out as no list of exercises or answers (the report lists each one with its reason): tables of contents, indexes and lists with leader dots: 3.');
    expect(text).toContain('Every run is a candidate');
    expect(text).toContain('audit ack --code numbered-run-uncovered --ref ID');
    expect(text).toContain('The gate reports every uncovered run of 5 items or more, and of 8 or more once the project covers 3 runs.');
  });

  it('takes --min-run for the shortest run and --uncovered for the runs that nothing covers, and refuses a minimum below two', async () => {
    const { cli, book } = await numberedProject();
    const long = censusOf(await cli(['exercises', 'census', '--min-run', '10']));
    expect(long).toMatchObject({ minRun: 10, summary: { runs: 2, items: 28 } });
    expect(long.runs.map((run) => run.id)).toEqual(['p3:1', 'p6:1']);
    const short = censusOf(await cli(['exercises', 'census', '--min-run', '3']));
    // The list of four steps is a run once the minimum is three.
    expect(short.runs.map((run) => run.id)).toContain(`p${book.stepsPage}:1`);
    expect(short.runs.length).toBeGreaterThan(5);
    for (const bad of ['1', '2.5', 'x']) {
      const refused = await cli(['exercises', 'census', '--min-run', bad]);
      expect(refused.code).toBe(2);
      expect(said(refused)).toMatch(/--min-run/);
    }
    await must(cli, ['frames', 'apply', '-'], { stdin: JSON.stringify({ operations: frameOps(book, 1) }) });
    const open = censusOf(await cli(['exercises', 'census', '--uncovered']));
    expect(open).toMatchObject({ listed: 4, summary: { runs: 5, covered: 1, uncovered: 4, itemsOutside: 34 } });
    expect(open.runs.map((run) => run.id)).toEqual(['p6:1', 'p9:1', 'p10:1', 'p10:1#2']);
    const all = censusOf(await cli(['exercises', 'census']));
    expect(all.runs[0]).toMatchObject({ id: 'p3:1', coverage: 1, covered: true, itemsOutside: 0 });
    const text = (await cli(['exercises', 'census', '--uncovered'], { json: false })).stdout;
    expect(text).not.toMatch(/p3:1\s/);
    expect(text).toMatch(/p6:1\s+6-7/);
    const none = (await cli(['exercises', 'census', '--uncovered', '--min-run', '30'], { json: false })).stdout;
    expect(none).toContain('No run of 30 or more numbered items was found');
  });

  it('writes the whole report with every item to --details, in the format of schemas/census.schema.json; so does the JSON result, without the items', async () => {
    const { cli } = await numberedProject();
    const done = await cli(['exercises', 'census', '--details', 'census.json']);
    expect(done.code).toBe(0);
    const written = JSON.parse(await readFile(join(cli.dir, 'census.json'), 'utf8')) as Census;
    const valid = census();
    expect(valid(written), JSON.stringify(valid.errors)).toBe(true);
    expect(valid(done.json.result), JSON.stringify(valid.errors)).toBe(true);
    expect(written.runs.map((run) => run.items?.length)).toEqual([14, 14, 9, 5, 6]);
    expect(written.runs[0]?.items?.[0]).toMatchObject({ page: 3, label: '1.', n: 1, covered: false });
    expect(written.runs[0]?.items?.[0]?.text).toMatch(/^1\. Orchard yields/);
    expect(written.summary).toEqual(censusOf(done).summary);
    expect(written.leftOut).toEqual(censusOf(done).leftOut);
    expect((await cli(['exercises', 'census', '--details', 'census.json'], { json: false })).stdout).toContain('Wrote the whole report to census.json.');
    // The same report is what `mcprep schema census` describes.
    const schema = await cli(['schema', 'census']);
    expect(schema.code).toBe(0);
  });

  it('reads the keyword labels of the book as an option: Aufgabe 1.1 ... without it is not a run, with --keyword it is', async () => {
    const lines = (from: number, to: number, y: number): { text: string; x: number; y: number; size: number }[] =>
      Array.from({ length: to - from + 1 }, (_unused, k) => ({ text: `Satz ${1}.${from + k} Berechne die Summe der ersten ${from + k + 2} Zahlen.`, x: 72, y: y + k * 30, size: 11 }));
    const spec: PdfPageSpec[] = [{ texts: lines(1, 8, 120) }];
    const cli = await cliFor(buildPdf({ title: 'Keywords', pages: spec }));
    await must(cli, ['init', 'book.pdf', '--title', 'Keywords']);
    // `Satz 1.3` is a label only when the word is given: the line starts with a word that no list of keywords has.
    expect(censusOf(await cli(['exercises', 'census'])).summary.runs).toBe(0);
    const named = censusOf(await cli(['exercises', 'census', '--keyword', 'Satz', '--keyword', 'Beispiel']));
    expect(named.runs[0]).toMatchObject({ scheme: 'keyword', keyword: 'Satz', first: 'Satz 1.1', last: 'Satz 1.8', count: 8, id: 'p0:Satz_1.1' });
  });

  it('says plainly that a book without a text layer has no run to list, instead of reading as a book without exercises', async () => {
    const spec: PdfPageSpec[] = [{ scan: { bars: [{ left: 0.1, top: 0.2, right: 0.8, bottom: 0.22 }] } }, { scan: { bars: [{ left: 0.1, top: 0.2, right: 0.8, bottom: 0.22 }] } }];
    const cli = await cliFor(buildPdf({ title: 'Scan', pages: spec }));
    await must(cli, ['init', 'book.pdf', '--title', 'Scan']);
    const done = await cli(['exercises', 'census']);
    expect(done.code).toBe(0);
    expect(censusOf(done).summary).toEqual({ runs: 0, items: 0, pagesWithRuns: 0, covered: 0, uncovered: 0, itemsOutside: 0, leftOut: 0 });
    const text = (await cli(['exercises', 'census'], { json: false })).stdout;
    expect(text).toContain('No run of 5 or more numbered items was found in the 2 pages of the text layer.');
    expect(text).toContain('a scan has no text layer');
  });
});

describe('the gate and numbered-run-uncovered, on the statistics workbook step by step', () => {
  it('reports every list of numbered items that no region covers in a project without any exercise, and exercises verify says so instead of "nothing to check"', async () => {
    const { cli, book } = await numberedProject();
    const done = await cli(['audit', 'gate']);
    expect(done.code).toBe(4);
    const gate = gateOf(done);
    expect(gate.passed).toBe(false);
    expect(uncoveredRefs(gate)).toEqual(book.runs.map((run) => run.id).sort());
    const first = gate.open.find((finding) => finding.ref === 'p3:1') as Finding;
    expect(first).toMatchObject({ source: 'verify', severity: 'warning', page: 3, acknowledgeable: true });
    expect(first.message).toBe("Pages 3-4: 14 numbered items (1. to 14.) lie outside every exercise, context and answer region; the line above them reads '1.6 Exercises'. If they are exercises, frame them; if the book prints another kind of list there (a bibliography, steps of a method), acknowledge it with the page and a quote.");
    const verify = (await cli(['exercises', 'verify'], { json: false })).stdout;
    expect(verify).toContain('There are no exercises to check');
    expect(verify).toContain('But the text layer holds 5 lists of numbered items that no region covers');
    expect(verify).toContain('[numbered-run-uncovered] p3:1');
    const text = (await cli(['audit', 'gate'], { json: false })).stdout;
    expect(text).toContain('numbered-run-uncovered');
  });

  it('goes quiet for a set once its exercises are framed with exercises add, and the acknowledgement of the bibliography goes through the second identity', async () => {
    const { cli, book } = await numberedProject();
    // The first set in one batch.
    await must(cli, ['frames', 'apply', '-'], { stdin: JSON.stringify({ operations: frameOps(book, 1) }) });
    expect(uncoveredRefs(gateOf(await cli(['audit', 'gate'])))).toEqual(['p10:1', 'p10:1#2', 'p6:1', 'p9:1']);
    // The second one with the command that a person or an agent types: `exercises add` for each exercise.
    const second = book.sets[1] as NumberedBook['sets'][number];
    for (const item of second.items) {
      const args = ['exercises', 'add', '--section', second.section, '--label', item.label, '--page', String(item.page), '--rect', rectArg(item.rect)];
      for (const more of item.continues) args.push('--continues', `${more.page}:${rectArg(more.rect)}`);
      await must(cli, args);
    }
    const afterSets = gateOf(await cli(['audit', 'gate']));
    expect(uncoveredRefs(afterSets)).toEqual(['p10:1', 'p10:1#2', 'p9:1']);
    expect(censusOf(await cli(['exercises', 'census'])).summary).toMatchObject({ covered: 2, uncovered: 3 });

    // The bibliography is a numbered list that is no exercise set: the book prints it, and the gate takes the word of two identities.
    const ack = await cli(['audit', 'ack', '--code', 'numbered-run-uncovered', '--ref', 'p9:1', '--page', String(book.references.page), '--quote', book.references.quote, '--reason', 'The book prints its numbered bibliography on this page and no exercise.']);
    expect(ack.code).toBe(0);
    const unconfirmed = gateOf(await cli(['audit', 'gate']));
    expect(uncoveredRefs(unconfirmed)).toEqual(['p10:1', 'p10:1#2']);
    expect(unconfirmed.unconfirmed).toBe(1);
    expect(unconfirmed.acknowledged.map((entry) => `${entry.finding.code} ${entry.finding.ref} ${entry.acknowledgement.confirmed}`)).toEqual(['numbered-run-uncovered p9:1 false']);
    expect((await cli(['audit', 'confirm', '--by', 'agent', '--all'])).code).not.toBe(0);
    expect((await cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(0);
    const confirmed = gateOf(await cli(['audit', 'gate']));
    expect(confirmed.unconfirmed).toBe(0);
    expect(confirmed.acknowledged[0]?.acknowledgement).toMatchObject({ confirmed: true, by: 'agent', confirmedBy: 'reviewer' });

    // The answer keys are covered by the solutions of their exercises. The book prints the answers to the odd exercises only, and says so on the page of each set.
    await must(cli, ['frames', 'apply', '-'], { stdin: JSON.stringify({ operations: solutionOps(book) }) });
    const solved = gateOf(await cli(['audit', 'gate']));
    expect(uncoveredRefs(solved)).toEqual([]);
    expect(solved.open.map((finding) => `${finding.code} ${finding.ref}`).sort()).toEqual(['no-solution 1.6', 'no-solution 2.5']);
    const census4 = censusOf(await cli(['exercises', 'census']));
    expect(census4.summary).toMatchObject({ covered: 4, uncovered: 1, itemsOutside: 9 });
    expect(census4.runs.filter((run) => !run.covered).map((run) => run.id)).toEqual(['p9:1']);
    for (const set of book.sets) {
      const done = await cli(['audit', 'ack', '--code', 'no-solution', '--ref', set.section, '--count', '1', '--page', String(set.headingPage), '--quote', 'odd-numbered exercises can be found in Appendix A', '--reason', 'The book prints only the answers to the odd exercises and says so under the heading of the set.']);
      expect(done.code, said(done)).toBe(0);
    }
    expect((await cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(0);
    const final = await cli(['audit', 'gate']);
    expect(final.code).toBe(0);
    expect(gateOf(final)).toMatchObject({ passed: true, open: [], unconfirmed: 0 });
    // The acknowledged list is still reported by the gate (nine items stay above the limit of eight once three runs are covered), and not unused.
    expect(gateOf(final).acknowledged.map((entry) => entry.finding.code).sort()).toEqual(['no-solution', 'no-solution', 'numbered-run-uncovered']);
    expect(gateOf(final).unusedAcknowledgements).toEqual([]);
    // A survey record written from what the book prints on each page fits the project.
    await writeFile(join(cli.dir, 'survey.json'), JSON.stringify(book.pages.map((entry) => ({ from: entry.page, to: entry.page, kind: entry.kind }))));
    const surveyed = await cli(['audit', 'gate', '--survey', 'survey.json']);
    expect(surveyed.code, JSON.stringify(gateOf(surveyed).open)).toBe(0);
    expect(gateOf(surveyed).checks.survey).toMatchObject({ pages: book.pageCount, missing: 0, uncovered: 0, unmarked: 0, exhaustive: true });
  });

  it('refuses an acknowledgement for the wrong page, without a quote and for a run that is not there, and says which runs are open', async () => {
    const { cli, book } = await numberedProject();
    const reason = 'The book prints its numbered bibliography on this page and no exercise.';
    const wrongPage = await cli(['audit', 'ack', '--code', 'numbered-run-uncovered', '--ref', 'p9:1', '--page', '3', '--quote', book.references.quote, '--reason', reason]);
    expect(wrongPage.code).toBe(2);
    expect(said(wrongPage)).toContain('The finding numbered-run-uncovered for p9:1 is not on page 3.');
    expect(said(wrongPage)).toContain('give --page 9');
    const noQuote = await cli(['audit', 'ack', '--code', 'numbered-run-uncovered', '--ref', 'p9:1', '--page', '9', '--reason', reason]);
    expect(noQuote.code).toBe(2);
    expect(said(noQuote)).toContain('--quote is missing');
    const nothing = await cli(['audit', 'ack', '--code', 'numbered-run-uncovered', '--ref', 'p9:99', '--page', '9', '--quote', book.references.quote, '--reason', reason]);
    expect(nothing.code).toBe(2);
    expect(said(nothing)).toContain('There is no finding numbered-run-uncovered for p9:99 now');
    expect(said(nothing)).toContain('p3:1 (page 3); p6:1 (page 6); p9:1 (page 9); p10:1#2 (page 10); p10:1 (page 10)');
    // Nothing was written, so the five runs are as open as they were.
    expect(uncoveredRefs(gateOf(await cli(['audit', 'gate'])))).toEqual(book.runs.map((run) => run.id).sort());
  });
});

/** The exotic book: what is printed where, framed from the truth the way a careful person would. */
async function exoticProject(): Promise<{ cli: Cli; book: ExoticBook }> {
  const book = buildExoticBook();
  const cli = await cliFor(book.pdf);
  await must(cli, ['init', 'book.pdf', '--title', book.title]);
  return { cli, book };
}

const sectionOf = (chapter: number): string => `ex${chapter}`;

function framingOps(book: ExoticBook): object[] {
  const { exercises, answers } = book.truth;
  return [
    ...exercises.map((item) => ({ op: 'add', kind: 'exercise', authority: 'book', section: sectionOf(item.chapter), label: item.label, page: item.page, rect: item.rect, ...(item.continues.length > 0 ? { continues: item.continues.map((piece) => ({ page: piece.page, rect: piece.rect })) } : {}) })),
    ...answers.flatMap((item) => [item, ...item.continues.map((piece) => ({ ...item, page: piece.page, rect: piece.rect }))].map((piece) => ({ op: 'solution.add', id: `${sectionOf(item.chapter)}:${item.label}`, page: piece.page, rect: piece.rect }))),
  ];
}

describe('a book whose layout the finder of exercises cannot read', () => {
  it('is read as no exercise at all by the finder, which is what the census is for: nothing but a layout that no heading word names', async () => {
    const { cli, book } = await exoticProject();
    await must(cli, ['outline', 'derive', '--book', '--apply']);
    await must(cli, ['exercises', 'propose', '--solutions', '--apply']);
    expect((await cli(['exercises', 'list'])).json.result).toMatchObject({ count: 0 });
    // The gate does not read it as "nothing to check" either: the census finds the four lists of numbered items.
    const gate = gateOf(await cli(['audit', 'gate']));
    expect(uncoveredRefs(gate)).toEqual(book.truth.runs.map((run) => run.id).sort());
    expect(gate.passed).toBe(false);
  });

  it('is read by the census as exactly the four runs the book prints: the boxed items of two chapters and the answers of two, the steps and the notes are no run', async () => {
    const { cli, book } = await exoticProject();
    const report = censusOf(await cli(['exercises', 'census']));
    const { truth } = book;
    expect(report.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, pages: run.pages, scheme: run.scheme, step: run.step }))).toEqual(
      truth.runs.map((run) => ({ id: run.id, first: run.first, last: run.last, count: run.count, pages: run.pages, scheme: 'k)', step: 1 })),
    );
    expect(report.summary).toMatchObject({ runs: 4, items: truth.exercises.length + truth.answers.length, covered: 0, leftOut: 0 });
    for (const notRun of truth.notRuns) expect(report.runs.some((run) => run.pages.includes(notRun.page) && run.count <= notRun.labels.length)).toBe(false);
    // The heading is only reported: the nearest line above the first item that is set larger (the pages are read without their fonts, so the small bold heading in the margin is not told from the text).
    expect(report.runs.map((run) => run.heading)).toEqual(['1 Sets and functions', '2 Counting', 'Chapter 1', 'Chapter 2']);
    expect(report.runs.map((run) => run.id)).toEqual(['p2:1_paren', 'p4:1_paren', 'p5:1_paren', 'p5:1_paren#2']);
    // With --min-run 11 only the two runs of nineteen are left.
    expect(censusOf(await cli(['exercises', 'census', '--min-run', '11'])).runs.map((run) => run.count)).toEqual([19, 19]);
  });

  it('is framed from the truth in one batch, and then the census covers every run and the gate passes with a survey record that says what every page holds', async () => {
    const { cli, book } = await exoticProject();
    await must(cli, ['outline', 'set', '-'], { stdin: JSON.stringify(book.truth.outline) });
    await must(cli, ['frames', 'apply', '-'], { stdin: JSON.stringify({ operations: framingOps(book) }) });
    const covered = censusOf(await cli(['exercises', 'census']));
    expect(covered.summary).toMatchObject({ runs: 4, covered: 4, uncovered: 0, itemsOutside: 0 });
    expect(covered.runs.map((run) => run.coverage)).toEqual([1, 1, 1, 1]);
    await writeFile(join(cli.dir, 'survey.json'), JSON.stringify(book.truth.pages.map((entry) => ({ from: entry.page, to: entry.page, kind: entry.kind }))));
    const done = await cli(['audit', 'gate', '--survey', 'survey.json']);
    expect(done.code, JSON.stringify(gateOf(done).open)).toBe(0);
    expect(gateOf(done)).toMatchObject({ passed: true, open: [] });
    expect(gateOf(done).checks.survey).toMatchObject({ pages: book.pageCount, missing: 0, uncovered: 0, unmarked: 0, exhaustive: true });
  });

  it('is partly covered when only the first ten of the nineteen items of a set are framed: the finding says how many lie outside', async () => {
    const { cli, book } = await exoticProject();
    await must(cli, ['outline', 'set', '-'], { stdin: JSON.stringify(book.truth.outline) });
    const first = framingOps(book).filter((op) => (op as { op: string; section?: string; label?: string }).op === 'add' && (op as { section: string }).section === 'ex1' && Number((op as { label: string }).label) <= 10);
    await must(cli, ['frames', 'apply', '-'], { stdin: JSON.stringify({ operations: first }) });
    const report = censusOf(await cli(['exercises', 'census']));
    const run = report.runs.find((entry) => entry.id === 'p2:1_paren') as Run;
    expect(run).toMatchObject({ count: 19, covered: false });
    expect(run.coverage).toBeCloseTo(10 / 19, 5);
    const gate = gateOf(await cli(['audit', 'gate']));
    const found = gate.open.find((finding) => finding.ref === 'p2:1_paren') as Finding;
    expect(found.message).toContain('9 of the 19 numbered items of the run 1) to 19) (from 11) on) lie outside every exercise, context and answer region');
  });
});
