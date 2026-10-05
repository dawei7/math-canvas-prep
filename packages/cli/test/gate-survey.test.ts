import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@mcprep/core';
import { auditedBook, surveyRecord, visualRecord, writeSurveyRecord, type SurveyEntry } from './audited.js';
import type { Cli, Result } from './helpers.js';

/**
 * The survey record: proof that every page of the book was looked at. The synthetic workbook has 21 pages: 0-2 front matter, 3-4 text (a chapter
 * opener and a lesson), 5-6 exercises, 7-8 text, 9-11 exercises, 12-13 text, 14 exercises, 15 text, 16-17 exercises, 18-20 the answer key.
 */

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
  open: Finding[];
  checks: { visual: { exhaustive: boolean } | null; survey: { file: string; pages: number; entries: number; missing: number; uncovered: number; unmarked: number; exhaustive: boolean } | null };
}
const gateOf = (done: Result): Gate => done.json.result as unknown as Gate;
const said = (done: Result): string => `${done.json.error?.message ?? ''} ${done.json.error?.hint ?? ''}`;
const survey = (gate: Gate): Finding[] => gate.open.filter((finding) => finding.source === 'survey');
const named = (gate: Gate): string[] => survey(gate).map((finding) => `${finding.code} ${finding.ref}`);

const REASON = 'The book prints it so, on the page named, which anybody can see there.';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };
const schemaOf = (name: string): object => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;

async function recorded(): Promise<{ cli: Cli; entries: SurveyEntry[] }> {
  const cli = await auditedBook();
  return { cli, entries: await writeSurveyRecord(cli.dir) };
}
const write = (cli: Cli, entries: unknown, file = 'survey.json'): Promise<void> => writeFile(join(cli.dir, file), JSON.stringify(entries));
async function edit(cli: Cli, change: (project: Project) => void): Promise<void> {
  const path = join(cli.dir, 'book.mcprep.json');
  const project = JSON.parse(await readFile(path, 'utf8')) as Project;
  change(project);
  await writeFile(path, JSON.stringify(project));
}

describe('the survey record of the synthetic workbook', () => {
  it('is what a careful person writes from the pages: ranges of front matter, text, exercises and answers', async () => {
    const entries = await surveyRecord();
    expect(entries).toEqual([
      { from: 0, to: 2, kind: 'front' },
      { from: 3, to: 4, kind: 'text' },
      { from: 5, to: 6, kind: 'exercises' },
      { from: 7, to: 8, kind: 'text' },
      { from: 9, to: 11, kind: 'exercises' },
      { from: 12, to: 13, kind: 'text' },
      { from: 14, to: 14, kind: 'exercises' },
      { from: 15, to: 15, kind: 'text' },
      { from: 16, to: 17, kind: 'exercises' },
      { from: 18, to: 20, kind: 'answers' },
    ]);
    const valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schemaOf('survey'));
    expect(valid(entries), JSON.stringify(valid.errors)).toBe(true);
  });
});

describe('audit gate --survey', () => {
  it('passes for a record that every page has one entry of and that fits the project; perfect with the visual record; the certificate says so and has a schema', async () => {
    const { cli, entries } = await recorded();
    await write(cli, await visualRecord(cli.dir), 'visual.json');
    const done = await cli(['audit', 'gate', '--survey', 'survey.json']);
    expect(done.code).toBe(0);
    const gate = gateOf(done);
    expect(gate).toMatchObject({ passed: true, perfect: false, open: [] });
    expect(gate.checks.survey).toMatchObject({ pages: 21, entries: entries.length, missing: 0, uncovered: 0, unmarked: 0, exhaustive: true });
    expect(gate.checks.survey?.file).toMatch(/survey\.json$/);
    const final = await cli(['audit', 'gate', '--visual', 'visual.json', '--survey', 'survey.json', '--final']);
    expect(final.code).toBe(0);
    expect(gateOf(final)).toMatchObject({ passed: true, perfect: true });
    const written = JSON.parse(await readFile(join(cli.dir, 'book.audit-gate.json'), 'utf8')) as { perfect: boolean; checks: { survey: { exhaustive: boolean } } };
    expect(written).toMatchObject({ perfect: true, checks: { survey: { exhaustive: true, pages: 21 } } });
    const valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schemaOf('gate'));
    expect(valid(written), JSON.stringify(valid.errors)).toBe(true);
    const text = await cli(['audit', 'gate', '--visual', 'visual.json', '--survey', 'survey.json', '--final'], { json: false });
    expect(text.stdout).toContain('survey record 10 ranges for 21 pages: 0 pages without an entry');
    expect(text.stdout).toContain('every page was looked at (the survey record has an entry for each and fits the project)');
    // The same record in an object.
    await write(cli, { survey: entries });
    expect((await cli(['audit', 'gate', '--survey', 'survey.json'])).code).toBe(0);
  });

  it('is not perfect without it: the gate passes, --final exits with 4, the status and the export say that no survey covers every page', async () => {
    const cli = await auditedBook();
    await write(cli, await visualRecord(cli.dir), 'visual.json');
    const plain = await cli(['audit', 'gate', '--visual', 'visual.json', '--final']);
    expect(plain.code).toBe(4);
    expect(gateOf(plain)).toMatchObject({ passed: true, perfect: false });
    expect(gateOf(plain).checks.survey).toBeNull();
    const text = await cli(['audit', 'gate', '--visual', 'visual.json', '--final'], { json: false });
    expect(text.stdout).toContain('Not exhaustive: there is no survey record of looking at every page (--survey FILE or FOLDER');
    expect(text.stdout).not.toContain('Not exhaustive: there is no visual record');
    expect(text.stdout).toContain('--final: the book is not perfect yet, so the exit code is 4');
    const status = await cli(['audit', 'gate', '--status']);
    expect(status.code).toBe(0);
    expect(status.json.result).toMatchObject({ status: 'passed', surveyed: false, perfect: false });
    expect((await cli(['audit', 'gate', '--status'], { json: false })).stdout).toContain('the survey record does not cover every page of the book (--survey FILE or FOLDER)');
    expect((await cli(['export', '--out', 'book.mcbundle'], { json: false })).stdout).toContain('Audit gate: not exhaustive, no survey record covers every page of the book');
    // With the record the status and the export are as they were.
    await writeSurveyRecord(cli.dir);
    const full = await cli(['audit', 'gate', '--visual', 'visual.json', '--survey', 'survey.json', '--final']);
    expect(full.code).toBe(0);
    expect((await cli(['audit', 'gate', '--status'])).json.result).toMatchObject({ status: 'passed', surveyed: true, perfect: true });
    const exported = (await cli(['export', '--out', 'book.mcbundle'], { json: false })).stdout;
    expect(exported).not.toContain('no survey record');
    // A certificate of a gate that had no survey stays not perfect after the record exists, until the gate runs with it.
    const without = JSON.parse(await readFile(join(cli.dir, 'book.audit-gate.json'), 'utf8')) as { perfect: boolean; checks: { survey: unknown } };
    without.perfect = true;
    without.checks.survey = null;
    await writeFile(join(cli.dir, 'book.audit-gate.json'), JSON.stringify(without));
    expect((await cli(['audit', 'gate', '--status'])).json.result).toMatchObject({ surveyed: false, perfect: false });
  });

  it('is not perfect with a survey that is not exhaustive, even when everything else is: --final says so', async () => {
    const { cli, entries } = await recorded();
    await write(cli, await visualRecord(cli.dir), 'visual.json');
    await write(cli, entries.filter((entry) => entry.kind !== 'front'));
    const done = await cli(['audit', 'gate', '--visual', 'visual.json', '--survey', 'survey.json', '--final'], { json: false });
    expect(done.code).toBe(4);
    expect(done.stdout).toContain('Gate NOT passed');
    expect(done.stdout).toContain('survey-missing');
  });

  describe('a record that is wrong, one example for each finding', () => {
    it('survey-missing: pages without an entry are ONE finding that counts them and names the first ranges', async () => {
      const { cli, entries } = await recorded();
      await write(cli, entries.filter((entry) => !(entry.kind === 'text' && (entry.from === 3 || entry.from === 12))));
      const done = await cli(['audit', 'gate', '--survey', 'survey.json']);
      expect(done.code).toBe(4);
      const gate = gateOf(done);
      expect(named(gate)).toEqual(['survey-missing survey']);
      const finding = survey(gate)[0] as Finding;
      expect(finding).toMatchObject({ source: 'survey', severity: 'error', page: 3, acknowledgeable: false });
      expect(finding.message).toContain('4 pages have no entry in the survey record: 3-4, 12-13');
      expect(gate.checks.survey).toMatchObject({ missing: 4, uncovered: 0, unmarked: 0, exhaustive: false });
      expect(gate.passed).toBe(false);
    });

    it('survey-overlap: a page in two entries is named with both of them', async () => {
      const { cli, entries } = await recorded();
      await write(cli, [{ from: 0, to: 3, kind: 'front' }, ...entries.slice(1)]);
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(gate)).toEqual(['survey-overlap pages 3']);
      expect(survey(gate)[0]?.message).toContain('Page 3 is in more than one entry of the survey record: the entry 1 (0-3, front) and the entry 2 (3-4, text)');
    });

    it('survey-range: an entry that is not in the format is named, with what is wrong with it', async () => {
      const { cli, entries } = await recorded();
      await write(cli, [{ from: 5, to: 2, kind: 'front' }, { from: 0, to: 99, kind: 'text' }, { from: 0, to: 1, kind: 'preface' }, { from: 'a', to: 1, kind: 'text' }, ...entries]);
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(gate)).toEqual(['survey-range entry 1', 'survey-range entry 2', 'survey-range entry 3', 'survey-range entry 4']);
      const messages = survey(gate).map((finding) => finding.message);
      expect(messages[0]).toContain('"from" (5) is after "to" (2)');
      expect(messages[1]).toContain('the range 0-99 is outside the pages of this book (0-20)');
      expect(messages[2]).toContain('"kind" is "preface", which is none of exercises, answers, both, text, blank, front, back');
      expect(messages[3]).toContain('"from" is not a whole number ("a")');
      expect(gate.checks.survey).toMatchObject({ entries: entries.length + 4, missing: 0, exhaustive: false });
    });

    it('survey-uncovered: an exercise page that nobody framed', async () => {
      const { cli } = await recorded();
      // The exercises of section 1.1 are on page 14: delete their frames (their answers go with them).
      await edit(cli, (project) => {
        project.frames = project.frames.filter((frame) => frame.page !== 14);
      });
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(gate)).toEqual(['survey-uncovered pages 14']);
      const finding = survey(gate)[0] as Finding;
      expect(finding.page).toBe(14);
      expect(finding.message).toContain('Page 14 is marked exercises (the entry 7, 14), and no exercise region touches it');
      expect(finding.message).toContain('frame its exercises (`mcprep exercises add`), or correct the record if the page holds none.');
      expect(gate.checks.survey).toMatchObject({ uncovered: 1, unmarked: 0, missing: 0, exhaustive: false });
      // The section has no exercise left, so the text checks look at no zone of it: the record is what shows that a page of exercises is not framed.
      expect(gate.passed).toBe(false);
    });

    it('survey-uncovered: an answers page without a solution region', async () => {
      const { cli } = await recorded();
      await edit(cli, (project) => {
        for (const frame of project.frames) if (frame.solution?.some((region) => region.page === 20)) delete frame.solution;
      });
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(gate)).toEqual(['survey-uncovered pages 20']);
      expect(survey(gate)[0]?.message).toContain('Page 20 is marked answers (the entry 10, 18-20), and no solution region touches it: frame its answers (`mcprep solution add`)');
    });

    it('survey-unmarked: an exercise region on a page the record marks as text, an answer region on a page marked as text', async () => {
      const { cli, entries } = await recorded();
      await write(cli, entries.map((entry) => (entry.from === 5 ? { ...entry, kind: 'text' } : entry)));
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(gate)).toEqual(['survey-unmarked pages 5-6']);
      expect(survey(gate)[0]?.message).toMatch(/^Pages 5-6 are marked text \(the entry 3, 5-6\), but 0\.1:\d+ has an exercise region on page 5/);
      expect(survey(gate)[0]?.message).toContain('the page holds exercises. Mark them exercises');
      expect(gate.checks.survey).toMatchObject({ unmarked: 2, uncovered: 0 });
      await write(cli, entries.map((entry) => (entry.kind === 'answers' ? { ...entry, kind: 'text' } : entry)));
      const answers = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(named(answers)).toEqual(['survey-unmarked pages 18-20']);
      expect(survey(answers)[0]?.message).toMatch(/but the solution region of \S+ lies on page 18/);
    });

    it('can never be acknowledged: audit ack refuses every code of the record with the command that repairs it, and a note in the file covers nothing', async () => {
      const { cli, entries } = await recorded();
      await write(cli, entries.filter((entry) => entry.kind !== 'front'));
      for (const code of ['survey-missing', 'survey-overlap', 'survey-range', 'survey-uncovered', 'survey-unmarked']) {
        const done = await cli(['audit', 'ack', '--code', code, '--ref', 'survey', '--page', '0', '--quote', 'Synthetic Algebra', '--reason', REASON, '--survey', 'survey.json']);
        expect(done.code, code).toBe(2);
        expect(said(done), code).toContain('can never be acknowledged');
        expect(said(done), code).toContain('Repair it');
        expect(said(done), code).toContain('mcprep');
      }
      await writeFile(join(cli.dir, 'book.audit-notes.json'), JSON.stringify({ format: 'math-canvas-audit-notes', version: 1, acknowledgements: [{ code: 'survey-missing', ref: 'survey', reason: REASON, evidence: { page: 0, quote: 'Synthetic Algebra' }, by: 'agent', confirmed: true, confirmedBy: 'someone else' }] }));
      const gate = gateOf(await cli(['audit', 'gate', '--survey', 'survey.json']));
      expect(gate.passed).toBe(false);
      expect(named(gate)).toEqual(['survey-missing survey']);
      expect(survey(gate)[0]?.acknowledgeable).toBe(false);
      const refused = (gate as unknown as { refusedAcknowledgements: { why: string }[] }).refusedAcknowledgements;
      expect(refused).toHaveLength(1);
      expect(refused[0]?.why).toContain('can never be acknowledged');
    });
  });

  describe('a folder of files', () => {
    /** One file for each three ranges: overview-1.json ... overview-4.json. */
    async function folder(cli: Cli, entries: SurveyEntry[], name = 'survey'): Promise<void> {
      await mkdir(join(cli.dir, name), { recursive: true });
      for (let at = 0; at * 3 < entries.length; at += 1) await write(cli, entries.slice(at * 3, at * 3 + 3), `${name}/overview-${at + 1}.json`);
    }

    it('is merged in the order of the file names and passes like the one file; the list of the sheets in it is not a record', async () => {
      const { cli, entries } = await recorded();
      await folder(cli, entries);
      const done = await cli(['audit', 'gate', '--survey', 'survey']);
      expect(done.code).toBe(0);
      expect(gateOf(done).checks.survey).toMatchObject({ pages: 21, entries: entries.length, exhaustive: true });
      expect(gateOf(done).checks.survey?.file).toMatch(/survey$/);
      await writeFile(join(cli.dir, 'survey', 'sheets.json'), JSON.stringify({ format: 'math-canvas-sheets', sheets: [] }));
      expect((await cli(['audit', 'gate', '--survey', 'survey'])).code).toBe(0);
      // A file written as an object works too.
      await write(cli, { survey: entries.slice(0, 3) }, 'survey/overview-1.json');
      expect((await cli(['audit', 'gate', '--survey', 'survey'])).code).toBe(0);
    });

    it('names the file of an entry that is wrong or that overlaps another, and the pages of a file that is missing', async () => {
      const { cli, entries } = await recorded();
      await folder(cli, entries);
      await write(cli, [...entries.slice(3, 6), { from: 20, to: 21, kind: 'answers' }], 'survey/overview-2.json');
      const range = gateOf(await cli(['audit', 'gate', '--survey', 'survey']));
      expect(named(range)).toContain('survey-range entry 4 of overview-2.json');
      expect(survey(range).find((finding) => finding.code === 'survey-range')?.message).toContain('the range 20-21 is outside the pages of this book (0-20)');
      // A range that two files both have.
      await folder(cli, entries);
      await write(cli, [...entries.slice(3, 6), entries[0]], 'survey/overview-2.json');
      const twice = gateOf(await cli(['audit', 'gate', '--survey', 'survey']));
      expect(named(twice)).toEqual(['survey-overlap pages 0-2']);
      expect(survey(twice)[0]?.message).toContain('the entry 1 of overview-1.json (0-2, front) and the entry 4 of overview-2.json (0-2, front)');
      // The file of the last pages is not there.
      await folder(cli, entries);
      await write(cli, [], 'survey/overview-4.json');
      expect(named(gateOf(await cli(['audit', 'gate', '--survey', 'survey'])))).toEqual(['survey-missing survey']);
    });

    it('refuses a folder without a .json file, a file that is no list, a file that is not JSON and a record that is not there', async () => {
      const { cli, entries } = await recorded();
      await mkdir(join(cli.dir, 'empty'));
      const none = await cli(['audit', 'gate', '--survey', 'empty']);
      expect(none.code).toBe(3);
      expect(said(none)).toContain('holds no .json file');
      await folder(cli, entries);
      await write(cli, { hello: 1 }, 'survey/notes.json');
      const bad = await cli(['audit', 'gate', '--survey', 'survey']);
      expect(bad.code).toBe(3);
      expect(said(bad)).toContain('notes.json');
      expect(said(bad)).toContain('is not a survey record');
      await writeFile(join(cli.dir, 'survey.json'), '[{ not json');
      const broken = await cli(['audit', 'gate', '--survey', 'survey.json']);
      expect(broken.code).toBe(3);
      expect(said(broken)).toContain('is not JSON');
      expect(said(broken)).toContain('"from": 0, "to": 17, "kind": "front"');
      expect((await cli(['audit', 'gate', '--survey', 'missing.json'])).code).toBe(3);
      await copyFile(join(cli.dir, 'survey', 'overview-1.json'), join(cli.dir, 'one.json'));
      expect((await cli(['audit', 'gate', '--survey', 'one.json'])).code).toBe(4);
    });
  });

  describe('the same option for audit ack and audit review', () => {
    it('accepts it and does not change what they do: a finding of the record is never acknowledged', async () => {
      const { cli } = await recorded();
      const wrong = [
        { label: '0.1', title: 'Whole Numbers', exercise_count: 68 },
        { label: '0.2', title: 'Word Problems', exercise_count: 14 },
        { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
        { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
      ];
      await write(cli, { sections: wrong }, 'reference.json');
      const ack = await cli(['audit', 'ack', '--code', 'reference-count', '--ref', '0.1', '--count', '1', '--page', '5', '--quote', 'Evaluate each expression', '--reason', 'The book prints 70 exercises in 0.1 and the reference lists 68.', '--reference', 'reference.json', '--survey', 'survey.json']);
      expect(ack.code).toBe(0);
      const review = await cli(['audit', 'review', '--out', 'review', '--reference', 'reference.json', '--survey', 'survey.json']);
      expect(review.code).toBe(0);
      expect((review.json.result as unknown as { entries: { status: string }[] }).entries.map((entry) => entry.status)).toEqual(['applies']);
    });
  });

  describe('the schema', () => {
    it('is printed by `mcprep schema survey` and accepts the records of the format and no other', async () => {
      const cli = await auditedBook();
      const done = await cli(['schema', 'survey']);
      expect(done.code).toBe(0);
      const schema = (done.json.result as unknown as { schema: { type: string } }).schema;
      expect(schema.type).toBe('array');
      const valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
      const good = [{ from: 0, to: 17, kind: 'front', note: 'title, contents' }, { from: 18, to: 18, kind: 'both' }];
      expect(valid(good), JSON.stringify(valid.errors)).toBe(true);
      for (const bad of [[{ from: 0, to: 1 }], [{ from: -1, to: 1, kind: 'text' }], [{ from: 0, to: 1, kind: 'preface' }], [{ from: 0.5, to: 1, kind: 'text' }], [{ from: 0, to: 1, kind: 'text', note: 'x'.repeat(121) }], [{ from: 0, to: 1, kind: 'text', extra: true }], { survey: [] }]) {
        expect(valid(bad), JSON.stringify(bad)).toBe(false);
      }
    });
  });
});
