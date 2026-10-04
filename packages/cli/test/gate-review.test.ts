import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Frame, Project } from '@mcprep/core';
import { NON_ACKNOWLEDGEABLE } from '@mcprep/core';
import { auditedBook, visualRecord, type VisualEntry } from './audited.js';
import { isPng, type Cli, type Result } from './helpers.js';

/**
 * The gate cannot be talked round: the defects of the audit are never acknowledged, a note needs the page and a quote of its text, a
 * second reviewer confirms it, the exercises that were looked at are proved one by one, and a missing instruction is found wherever it is.
 */

interface Finding {
  code: string;
  ref: string;
  page: number | null;
  message: string;
  evidence: string;
  acknowledgeable: boolean;
}
interface Gate {
  passed: boolean;
  perfect: boolean;
  ink: boolean;
  unconfirmed: number;
  open: Finding[];
  acknowledged: { finding: Finding; acknowledgement: { code: string; ref: string; confirmed: boolean; confirmedBy?: string } }[];
  refusedAcknowledgements: { acknowledgement: { code: string; ref: string }; why: string }[];
  checks: { verify: { ink: boolean }; visual: { entries: number; exercises: number; missing: number; mismatches: number; defects: number; exhaustive: boolean } | null; sheets: { exhaustive: boolean } | null };
}
const gateOf = (done: Result): Gate => done.json.result as unknown as Gate;
const said = (done: Result): string => `${done.json.error?.message ?? ''} ${done.json.error?.hint ?? ''}`;
const named = (gate: Gate): string[] => gate.open.map((finding) => `${finding.code} ${finding.ref}`);

const REASON = 'The book prints it so, on the page named, which anybody can see there.';
const QUOTE = 'Evaluate each expression';

async function projectOf(cli: Cli): Promise<{ path: string; project: Project; by(ref: string): Frame }> {
  const path = join(cli.dir, 'book.mcprep.json');
  const project = JSON.parse(await readFile(path, 'utf8')) as Project;
  return { path, project, by: (ref) => project.frames.find((frame) => `${frame.section as string}:${frame.label as string}` === ref) as Frame };
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

/** The seven defects of the cold-start test of the harness, injected into the audited workbook by hand. */
async function injectSeven(cli: Cli): Promise<{ deleted: Frame }> {
  const { path, project, by } = await projectOf(cli);
  // The top edge cuts the label line: 0.010 (a cut of 0.008 only touches the tops of the digits, which nobody sees).
  by('0.1:5').rect = { ...by('0.1:5').rect, top: round(by('0.1:5').rect.top + 0.01) };
  by('0.1:20').rect = { ...by('0.1:20').rect, bottom: round(by('0.1:20').rect.bottom + 0.012) };
  const deleted = by('0.2:7');
  project.frames = project.frames.filter((frame) => frame !== deleted);
  by('1.1:3').label = '13';
  by('0.1:11').solution = structuredClone(by('0.1:12').solution);
  delete by('1.2:5').context;
  const cut = (by('0.1:45').solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
  by('0.1:45').solution = [{ page: cut.page, rect: { ...cut.rect, bottom: round((cut.rect.top + cut.rect.bottom) / 2) } }];
  await writeFile(path, JSON.stringify(project));
  return { deleted };
}

describe('the defects of the audit cannot be acknowledged', () => {
  it('refuses every one of them with the command that repairs it, and takes no note for them from the file either', async () => {
    const cli = await auditedBook();
    for (const code of Object.keys(NON_ACKNOWLEDGEABLE)) {
      const done = await cli(['audit', 'ack', '--code', code, '--ref', '1.2:5', '--page', '16', '--quote', QUOTE, '--reason', REASON]);
      expect(done.code, code).toBe(2);
      expect(said(done), code).toContain('can never be acknowledged');
      expect(said(done), code).toContain('Repair it');
      expect(said(done), code).toContain('mcprep');
    }
    expect(Object.keys(NON_ACKNOWLEDGEABLE)).toHaveLength(14);
    // A note written into the file by hand covers nothing: the gate lists it as refused and the finding stays open.
    const { path, project, by } = await projectOf(cli);
    delete by('1.2:5').context;
    await writeFile(path, JSON.stringify(project));
    await writeFile(
      join(cli.dir, 'book.audit-notes.json'),
      JSON.stringify({ format: 'math-canvas-audit-notes', version: 1, acknowledgements: [{ code: 'context-inconsistent', ref: '1.2:5', reason: REASON, evidence: { page: 16, quote: QUOTE }, by: 'agent', confirmed: true, confirmedBy: 'someone else' }] }),
    );
    const gate = gateOf(await cli(['audit', 'gate']));
    expect(gate.passed).toBe(false);
    expect(named(gate)).toContain('context-inconsistent 1.2:5');
    expect(gate.open.find((finding) => finding.code === 'context-inconsistent')?.acknowledgeable).toBe(false);
    expect(gate.refusedAcknowledgements).toHaveLength(1);
    expect(gate.refusedAcknowledgements[0]?.why).toContain('can never be acknowledged');
    const text = await cli(['audit', 'gate'], { json: false });
    expect(text.stdout).toContain('A note is not allowed and covers nothing (context-inconsistent 1.2:5)');
  });
});

describe('audit ack tells everything that is wrong at once', () => {
  it('lists the problems together with the call that would do, keeps what is right in it, and accepts the call as corrected', async () => {
    const cli = await auditedBook();
    await cli(['frames', 'delete', '0.1:12']);
    const bare = await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1', '--reason', 'no']);
    expect(bare.code).toBe(2);
    const message = bare.json.error?.message ?? '';
    expect(message).toMatch(/^4 things are wrong with this acknowledgement:/);
    for (const part of ['1. --page is missing', '2. --quote is missing', '3. "0.1" is a section', 'so give --count 1', '4. The reason has 2 characters']) expect(message).toContain(part);
    const hint = bare.json.error?.hint ?? '';
    expect(hint).toContain('mcprep audit ack --code numbered-text-left-behind --ref 0.1 --page 5 --quote "<');
    expect(hint).toContain('--count 1');
    // A quote that is not on the page and a count that is wrong are two things; the call keeps the reason, which is right.
    const two = await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1', '--page', '5', '--quote', 'not on this page', '--reason', REASON, '--count', '3']);
    expect(two.code).toBe(2);
    expect(two.json.error?.message).toMatch(/^2 things are wrong/);
    expect(two.json.error?.message).toContain('is not in the text of page 5');
    expect(two.json.error?.message).toContain('1 finding matches');
    expect(two.json.error?.hint).toContain(JSON.stringify(REASON));
    expect(two.json.error?.hint).toContain('--count 1');
    // One thing wrong is told alone, as before, and the call as it was told works.
    const one = await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1', '--page', '5', '--quote', QUOTE, '--reason', REASON]);
    expect(one.code).toBe(2);
    expect(one.json.error?.message).toMatch(/^"0\.1" is a section/);
    expect((await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1', '--page', '5', '--quote', QUOTE, '--reason', REASON, '--count', '1'])).code).toBe(0);
    // Without a finding, the form is still told together with it.
    const none = await cli(['audit', 'ack', '--code', 'duplicate', '--ref', '0.1:3', '--reason', 'no']);
    expect(none.code).toBe(2);
    expect(none.json.error?.message).toMatch(/^2 things are wrong/);
    expect(none.json.error?.message).toContain('There is no finding duplicate for 0.1:3 now');
    expect(none.json.error?.message).toContain('The reason has 2 characters');
  });
});

describe('the seven defects of the cold-start test', () => {
  it('are all found, with the pixel check, and each by a finding that names its exercise', async () => {
    const cli = await auditedBook();
    await injectSeven(cli);
    const done = await cli(['audit', 'gate', '--ink']);
    expect(done.code).toBe(4);
    const open = named(gateOf(done));
    for (const expected of [
      'edge-on-ink 0.1:5',
      'overlap 0.1:20',
      'numbered-text-left-behind 0.2:7',
      'label-not-first 1.1:13',
      'solution-label-missing 0.1:11',
      'context-inconsistent 1.2:5',
      'answer-left-behind 0.1:45',
    ]) expect(open, expected).toContain(expected);
  });

  it('stay found when the exercise that was missing is put back without its instruction, until its instruction is copied from its neighbour', async () => {
    const cli = await auditedBook();
    const { deleted } = await injectSeven(cli);
    const rect = `${deleted.rect.left},${deleted.rect.top},${deleted.rect.right},${deleted.rect.bottom}`;
    expect((await cli(['exercises', 'add', '--section', '0.2', '--label', '7', '--page', String(deleted.page), '--rect', rect])).code).toBe(0);
    const answer = (deleted.solution as NonNullable<Frame['solution']>)[0] as NonNullable<Frame['solution']>[number];
    expect((await cli(['solution', 'add', '0.2:7', '--page', String(answer.page), '--rect', `${answer.rect.left},${answer.rect.top},${answer.rect.right},${answer.rect.bottom}`])).code).toBe(0);
    const gate = gateOf(await cli(['audit', 'gate']));
    expect(gate.passed).toBe(false);
    const finding = gate.open.find((entry) => entry.code === 'context-inconsistent' && entry.ref === '0.2:7');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('printed right above it');
    expect(finding?.message).toContain('0.2:8');
    // The instruction of the exercise after it is two regions (it crosses a page break): copy both, as the list of regions prints them.
    const listed = (await cli(['exercises', 'list', '--section', '0.2', '--regions'])).json.result as unknown as { exercises: { reference: string; regions: { context: { page: number; rect: Frame['rect'] }[] } }[] };
    const next = listed.exercises.find((entry) => entry.reference === '0.2:8') as (typeof listed.exercises)[number];
    expect(next.regions.context).toHaveLength(2);
    for (const region of next.regions.context) {
      const copied = await cli(['context', 'add', '0.2:7', '--page', String(region.page), '--rect', `${region.rect.left},${region.rect.top},${region.rect.right},${region.rect.bottom}`]);
      expect(copied.code).toBe(0);
    }
    expect(named(gateOf(await cli(['audit', 'gate'])))).not.toContain('context-inconsistent 0.2:7');
    // The same for 1.2:5 in the middle of a group of three columns.
    const middle = (await cli(['exercises', 'list', '--section', '1.2', '--regions'])).json.result as unknown as { exercises: { reference: string; regions: { context: { page: number; rect: Frame['rect'] }[] } }[] };
    for (const region of (middle.exercises.find((entry) => entry.reference === '1.2:4') as (typeof middle.exercises)[number]).regions.context) {
      expect((await cli(['context', 'add', '1.2:5', '--page', String(region.page), '--rect', `${region.rect.left},${region.rect.top},${region.rect.right},${region.rect.bottom}`])).code).toBe(0);
    }
    expect(named(gateOf(await cli(['audit', 'gate'])))).not.toContain('context-inconsistent 1.2:5');
  });
});

describe('the pixel check of the edges is part of the gate', () => {
  it('runs by default and is recorded in the certificate; --no-ink skips it for a quick loop, and the book is not perfect until it has run', async () => {
    const cli = await auditedBook();
    await writeFile(join(cli.dir, 'visual.json'), JSON.stringify(await visualRecord(cli.dir)));
    const full = await cli(['audit', 'gate', '--visual', 'visual.json', '--final']);
    expect(full.code).toBe(0);
    expect(gateOf(full)).toMatchObject({ passed: true, perfect: true, ink: true });
    expect(gateOf(full).checks.verify.ink).toBe(true);
    expect(JSON.parse(await readFile(join(cli.dir, 'book.audit-gate.json'), 'utf8'))).toMatchObject({ ink: true, perfect: true });
    expect((await cli(['audit', 'gate', '--visual', 'visual.json', '--ink'])).code).toBe(0);
    expect(gateOf(await cli(['audit', 'gate', '--visual', 'visual.json', '--ink'])).ink).toBe(true);
    // The quick loop: it passes, says it did not look at the edges, and is not perfect.
    const quick = await cli(['audit', 'gate', '--visual', 'visual.json', '--no-ink']);
    expect(quick.code).toBe(0);
    expect(gateOf(quick)).toMatchObject({ passed: true, perfect: false, ink: false });
    expect(gateOf(quick).checks.verify.ink).toBe(false);
    expect(JSON.parse(await readFile(join(cli.dir, 'book.audit-gate.json'), 'utf8'))).toMatchObject({ ink: false, perfect: false });
    const text = await cli(['audit', 'gate', '--visual', 'visual.json', '--no-ink'], { json: false });
    expect(text.stdout).toContain('WITHOUT the pixel check of the edges: --no-ink');
    expect(text.stdout).toContain('run the gate without --no-ink');
    const final = await cli(['audit', 'gate', '--visual', 'visual.json', '--no-ink', '--final'], { json: false });
    expect(final.code).toBe(4);
    expect(final.stdout).toContain('--final: the book is not perfect yet, so the exit code is 4: run the gate without --no-ink.');
    expect((await cli(['audit', 'gate', '--status'], { json: false })).stdout).toContain('the pixel check of the edges did not run (run the gate without --no-ink)');
    expect((await cli(['audit', 'gate', '--status'])).json.result).toMatchObject({ status: 'passed', ink: false, perfect: false });
    expect((await cli(['export', '--out', 'book.mcbundle'], { json: false })).stdout).toContain('the pixel check of the edges did not run');
    // Together the two options contradict each other.
    const both = await cli(['audit', 'gate', '--ink', '--no-ink']);
    expect(both.code).toBe(2);
    expect(said(both)).toContain('--ink and --no-ink together');
    // And the full gate again is perfect.
    expect(gateOf(await cli(['audit', 'gate', '--visual', 'visual.json', '--final']))).toMatchObject({ perfect: true, ink: true });
    expect((await cli(['export', '--out', 'book.mcbundle'], { json: false })).stdout).not.toContain('pixel check');
  });

  it('finds an edge that cuts ink without being asked to, in the gate, in audit ack and in audit review; --no-ink does not look', async () => {
    const cli = await auditedBook();
    const { path, project, by } = await projectOf(cli);
    const frame = by('0.1:5');
    frame.rect = { ...frame.rect, top: round(frame.rect.top + 0.01) };
    await writeFile(path, JSON.stringify(project));
    const gate = gateOf(await cli(['audit', 'gate']));
    expect(gate.passed).toBe(false);
    const found = gate.open.find((finding) => finding.code === 'edge-on-ink' && finding.ref === '0.1:5');
    expect(found?.message).toContain('The top edge of the region of 0.1:5');
    expect(found?.message).toContain('cuts printed ink: the ink goes on across it at');
    expect(found?.evidence).toMatch(/ink goes across it at \d+ px/);
    expect(named(gateOf(await cli(['audit', 'gate', '--no-ink'])))).not.toContain('edge-on-ink 0.1:5');
    // The note for it: audit ack runs the pixel check as well, so the finding exists; with --no-ink it does not.
    const quote = 'Evaluate each expression';
    const page = String(found?.page);
    const args = ['audit', 'ack', '--code', 'edge-on-ink', '--ref', '0.1:5', '--page', page, '--quote', quote, '--reason', 'The book prints the number touching the top of the box on this page.'];
    const nothing = await cli([...args, '--no-ink']);
    expect(nothing.code).toBe(2);
    expect(said(nothing)).toContain('There is no finding edge-on-ink for 0.1:5 now');
    expect((await cli(args)).code).toBe(0);
    expect(named(gateOf(await cli(['audit', 'gate'])))).not.toContain('edge-on-ink 0.1:5');
    const review = (await cli(['audit', 'review', '--out', 'review'])).json.result as unknown as { entries: { status: string }[] };
    expect(review.entries.map((entry) => entry.status)).toEqual(['applies']);
    const without = (await cli(['audit', 'review', '--out', 'review', '--no-ink'])).json.result as unknown as { entries: { status: string }[] };
    expect(without.entries.map((entry) => entry.status)).toEqual(['unused']);
  });
});

describe('exercises list --regions', () => {
  it('prints the instruction, continuation and solution regions as page:left,top,right,bottom, and gives the objects in JSON', async () => {
    const cli = await auditedBook();
    const text = await cli(['exercises', 'list', '--section', '0.2', '--regions'], { json: false });
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/0\.2:8 {2}\(frame f\d+, page 10/);
    expect(text.stdout).toMatch(/context: 9:0\.1309,0\.8742,0\.7611,0\.9001 {2}10:0\.1309,0\.0951,0\.5807,0\.121/);
    expect(text.stdout).toMatch(/solution: 19:/);
    const json = (await cli(['exercises', 'list', '--section', '0.2', '--regions'])).json.result as unknown as { exercises: { reference: string; context: number; regions: { context: { page: number; rect: { left: number } }[]; continues: unknown[]; solution: unknown[] } }[] };
    const eight = json.exercises.find((entry) => entry.reference === '0.2:8') as (typeof json.exercises)[number];
    expect(eight.context).toBe(2);
    expect(eight.regions.context.map((region) => region.page)).toEqual([9, 10]);
    expect(eight.regions.solution).toHaveLength(1);
    const plain = (await cli(['exercises', 'list', '--section', '0.2'])).json.result as unknown as { exercises: { regions?: unknown }[] };
    expect(plain.exercises[0]?.regions).toBeUndefined();
  });
});

describe('a second reviewer', () => {
  async function withNote(): Promise<Cli> {
    const cli = await auditedBook();
    await cli(['frames', 'delete', '0.1:12']);
    const ack = await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', QUOTE, '--reason', REASON, '--by', 'writer']);
    expect(ack.code).toBe(0);
    return cli;
  }

  it('confirms what another reviewer wrote, never one\'s own, and a note that is replaced is not confirmed again', async () => {
    const cli = await withNote();
    // The finding is open apart from the one acknowledged: the gate does not pass, but the note applies and is not confirmed.
    const first = gateOf(await cli(['audit', 'gate']));
    expect(first.acknowledged[0]?.acknowledgement).toMatchObject({ code: 'numbered-text-left-behind', ref: '0.1:12', confirmed: false });
    const own = await cli(['audit', 'confirm', '--by', ' Writer ', '--all']);
    expect(own.code).toBe(2);
    expect(said(own)).toContain('a second reviewer must be someone else');
    const nothing = await cli(['audit', 'confirm', '--by', 'reviewer']);
    expect(nothing.code).toBe(2);
    expect(said(nothing)).toContain('Name the acknowledgement to confirm');
    const both = await cli(['audit', 'confirm', '--by', 'reviewer', '--all', '--ref', '0.1:12']);
    expect(both.code).toBe(2);
    expect(said(both)).toContain('do not combine');
    const wrong = await cli(['audit', 'confirm', '--by', 'reviewer', '--ref', '9.9:1']);
    expect(wrong.code).toBe(2);
    expect(said(wrong)).toContain('No acknowledgement for 9.9:1');
    expect(said(wrong)).toContain('numbered-text-left-behind 0.1:12');
    const done = await cli(['audit', 'confirm', '--by', 'reviewer', '--ref', '0.1:12', '--code', 'numbered-text-left-behind']);
    expect(done.code).toBe(0);
    expect((done.json.result as unknown as { confirmed: { confirmedBy: string }[] }).confirmed[0]?.confirmedBy).toBe('reviewer');
    expect((await cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(2);
    const second = gateOf(await cli(['audit', 'gate']));
    expect(second.acknowledged[0]?.acknowledgement).toMatchObject({ confirmed: true, confirmedBy: 'reviewer' });
    // The same note again (a better reason) replaces it, and the second reviewer has to look again.
    const again = await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', QUOTE, '--reason', `${REASON} Seen again.`, '--by', 'writer']);
    expect(again.json.result).toMatchObject({ replaced: true });
    expect(gateOf(await cli(['audit', 'gate'])).acknowledged[0]?.acknowledgement.confirmed).toBe(false);
  });

  it('does not count a confirmation that the writer wrote into the file for itself', async () => {
    const cli = await withNote();
    const path = join(cli.dir, 'book.audit-notes.json');
    const notes = JSON.parse(await readFile(path, 'utf8')) as { acknowledgements: Record<string, unknown>[] };
    Object.assign(notes.acknowledgements[0] as object, { confirmed: true, confirmedBy: 'WRITER' });
    await writeFile(path, JSON.stringify(notes));
    expect(gateOf(await cli(['audit', 'gate'])).acknowledged[0]?.acknowledgement.confirmed).toBe(false);
  });

  it('is told by the gate, by the status and by export how many notes wait for it; perfect needs none', async () => {
    const cli = await auditedBook();
    const wrong = [
      { label: '0.1', title: 'Whole Numbers', exercise_count: 68 },
      { label: '0.2', title: 'Word Problems', exercise_count: 14 },
      { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
      { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
    ];
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections: wrong }));
    await writeFile(join(cli.dir, 'visual.json'), JSON.stringify(await visualRecord(cli.dir)));
    expect((await cli(['audit', 'ack', '--code', 'reference-count', '--ref', '0.1', '--count', '1', '--page', '5', '--quote', QUOTE, '--reason', 'The book prints 70 exercises in 0.1 and the reference lists 68.', '--reference', 'reference.json', '--by', 'writer'])).code).toBe(0);
    const gate = await cli(['audit', 'gate', '--reference', 'reference.json', '--visual', 'visual.json']);
    expect(gate.code).toBe(0);
    expect(gateOf(gate)).toMatchObject({ passed: true, unconfirmed: 1, perfect: false });
    const text = await cli(['audit', 'gate', '--reference', 'reference.json', '--visual', 'visual.json'], { json: false });
    expect(text.stdout).toContain('1 acknowledgement is not yet confirmed by a second reviewer');
    const final = await cli(['audit', 'gate', '--reference', 'reference.json', '--visual', 'visual.json', '--final']);
    expect(final.code).toBe(4);
    const exported = await cli(['export', '--out', 'book.mcbundle'], { json: false });
    expect(exported.stdout).toContain('1 acknowledgement is not yet confirmed by a second reviewer');
    expect((await cli(['audit', 'gate', '--status'], { json: false })).stdout).toContain('1 acknowledgement is not yet confirmed by a second reviewer');
    expect((await cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(0);
    const perfect = await cli(['audit', 'gate', '--reference', 'reference.json', '--visual', 'visual.json', '--final']);
    expect(perfect.code).toBe(0);
    expect(gateOf(perfect)).toMatchObject({ passed: true, unconfirmed: 0, perfect: true });
    expect((await cli(['export', '--out', 'book.mcbundle'], { json: false })).stdout).not.toContain('not yet confirmed');
  });

  it('is given the picture, the reason and the quote of every note to look at: audit review', async () => {
    const cli = await withNote();
    const done = await cli(['audit', 'review', '--out', 'review']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as { unconfirmed: number; entries: { number: number; code: string; ref: string; page: number; quoteOnPage: boolean; status: string; image: string; confirmed: boolean; line: string }[] };
    expect(result.unconfirmed).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ number: 1, code: 'numbered-text-left-behind', ref: '0.1:12', page: 5, quoteOnPage: true, status: 'applies', confirmed: false });
    const files = (await readdir(join(cli.dir, 'review'))).sort();
    expect(files).toEqual(['001-numbered-text-left-behind-0.1_12.png', 'index.md', 'review.json']);
    expect(isPng(await readFile(join(cli.dir, 'review', files[0] as string)))).toBe(true);
    const index = await readFile(join(cli.dir, 'review', 'index.md'), 'utf8');
    expect(index).toContain('numbered-text-left-behind 0.1:12 p.5');
    expect(index).toContain(REASON);
    expect(index).toContain(`quote: "${QUOTE}"`);
    expect(index).toContain('NOT confirmed');
    expect(index).toContain('mcprep audit confirm --by YOUR-NAME --ref 0.1:12 --code numbered-text-left-behind --page 5');
    // A note whose quote is not on the page is marked, and one whose finding is gone is listed as unused.
    const path = join(cli.dir, 'book.audit-notes.json');
    const notes = JSON.parse(await readFile(path, 'utf8')) as { acknowledgements: { evidence: { quote: string } }[] };
    (notes.acknowledgements[0] as { evidence: { quote: string } }).evidence.quote = 'a text that no page holds';
    await writeFile(path, JSON.stringify(notes));
    const marked = (await cli(['audit', 'review', '--out', 'review'])).json.result as unknown as { entries: { quoteOnPage: boolean }[] };
    expect(marked.entries[0]?.quoteOnPage).toBe(false);
    expect(await readFile(join(cli.dir, 'review', 'index.md'), 'utf8')).toContain('(NOT on the page');
    expect((await cli(['audit', 'review'])).code).toBe(2);
    const empty = await auditedBook();
    const none = await empty(['audit', 'review', '--out', 'review']);
    expect(none.code).toBe(0);
    expect(await readFile(join(empty.dir, 'review', 'index.md'), 'utf8')).toContain('There are no acknowledgements.');
  });
});

describe('the visual record: proof that every exercise was looked at', () => {
  async function recorded(): Promise<{ cli: Cli; entries: VisualEntry[] }> {
    const cli = await auditedBook();
    return { cli, entries: await visualRecord(cli.dir) };
  }
  const write = (cli: Cli, entries: unknown): Promise<void> => writeFile(join(cli.dir, 'visual.json'), JSON.stringify(entries));

  it('passes for a record of what is printed, covers every exercise and makes the sheets exhaustive; perfect with nothing to confirm', async () => {
    const { cli, entries } = await recorded();
    await write(cli, entries);
    const done = await cli(['audit', 'gate', '--visual', 'visual.json', '--final']);
    expect(done.code).toBe(0);
    const gate = gateOf(done);
    expect(gate).toMatchObject({ passed: true, perfect: true, unconfirmed: 0 });
    expect(gate.checks.visual).toMatchObject({ entries: 112, exercises: 112, missing: 0, mismatches: 0, defects: 0, exhaustive: true });
    // The same record in an object, and a bare list of sheets with it.
    await write(cli, { visual: entries });
    expect((await cli(['audit', 'gate', '--visual', 'visual.json'])).code).toBe(0);
    expect((await cli(['exercises', 'sheets', '--out', 'sheets', '--per-sheet', '56'])).code).toBe(0);
    const manifest = JSON.parse(await readFile(join(cli.dir, 'sheets', 'sheets.json'), 'utf8')) as { sheets: unknown[] };
    await writeFile(join(cli.dir, 'sheets', 'seen.txt'), `1-${manifest.sheets.length}`);
    const both = gateOf(await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt', '--visual', 'visual.json']));
    expect(both.checks.sheets?.exhaustive).toBe(true);
    // The sheets alone are not the exhaustive pass: nothing proves they were looked at.
    const alone = await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt']);
    expect(alone.code).toBe(0);
    expect(gateOf(alone)).toMatchObject({ passed: true, perfect: false });
    expect(gateOf(alone).checks.sheets?.exhaustive).toBe(false);
    expect((await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt', '--final'])).code).toBe(4);
  });

  it('opens a finding for every exercise without an entry, one per section', async () => {
    const { cli, entries } = await recorded();
    await write(cli, entries.filter((entry) => !['0.1:7', '0.1:8', '1.2:3'].includes(entry.ref)));
    const gate = gateOf(await cli(['audit', 'gate', '--visual', 'visual.json']));
    expect(gate.passed).toBe(false);
    expect(named(gate)).toEqual(['visual-missing 0.1', 'visual-missing 1.2']);
    expect(gate.open[0]?.message).toContain('2 exercises of section 0.1 have no entry');
    expect(gate.checks.visual).toMatchObject({ missing: 3, exhaustive: false });
    expect(gate.open.every((finding) => !finding.acknowledgeable)).toBe(true);
    expect(gateOf(await cli(['audit', 'gate', '--visual', 'visual.json', '--final'])).perfect).toBe(false);
  });

  it('shows that a cell was not looked at: an instruction that is not there, words that are not in the region, an answer with another number', async () => {
    const { cli, entries } = await recorded();
    const { path, project, by } = await projectOf(cli);
    delete by('1.2:5').context;
    await writeFile(path, JSON.stringify(project));
    // The record is written as the instruction of 1.2:5 were there (nobody looked at the cell), and with wrong words and a wrong answer.
    const tampered = entries.map((entry) => {
      if (entry.ref === '1.2:5') return { ...entry, instruction: true };
      if (entry.ref === '0.1:3') return { ...entry, startsWith: 'words that are not there' };
      if (entry.ref === '0.2:4') return { ...entry, answerStartsWith: '9' };
      if (entry.ref === '0.1:9') return { ...entry, answerStartsWith: '' };
      return entry;
    });
    await write(cli, tampered);
    const gate = gateOf(await cli(['audit', 'gate', '--visual', 'visual.json']));
    const mismatches = gate.open.filter((finding) => finding.code === 'visual-mismatch');
    expect(mismatches.map((finding) => finding.ref)).toEqual(['0.1:3', '0.1:9', '0.2:4', '1.2:5']);
    expect(mismatches.find((finding) => finding.ref === '1.2:5')?.message).toContain('the record says the cell shows an instruction (a blue box), but the exercise has none');
    expect(mismatches.find((finding) => finding.ref === '0.1:3')?.message).toContain('is not in the text of its region');
    expect(mismatches.find((finding) => finding.ref === '0.2:4')?.message).toContain('the record says the answer starts with "9"');
    expect(mismatches.find((finding) => finding.ref === '0.1:9')?.message).toContain('starts with ""');
    expect(mismatches.every((finding) => !finding.acknowledgeable)).toBe(true);
    expect(gate.checks.visual).toMatchObject({ mismatches: 4, exhaustive: true });
    // Whoever looked and wrote what the cell shows (no blue box) gets the defect from the other checks, and may say so in the record.
    const honest = entries.map((entry) => (entry.ref === '1.2:5' ? { ...entry, instruction: false, ok: false, defect: 'context-missing' } : entry));
    await write(cli, honest);
    const open = named(gateOf(await cli(['audit', 'gate', '--visual', 'visual.json'])));
    expect(open).toContain('visual-defect 1.2:5');
    expect(open).toContain('context-inconsistent 1.2:5');
    expect(open.filter((entry) => entry.startsWith('visual-mismatch'))).toEqual([]);
  });

  it('refuses an entry that is no exercise, one that repeats, one that lacks a field, and a record that is not JSON', async () => {
    const { cli, entries } = await recorded();
    await write(cli, [...entries.filter((entry) => entry.ref !== '0.1:20'), { ref: '7.7:7', startsWith: 'x y z', instruction: false, answerStartsWith: '', ok: true }, { ...(entries[0] as VisualEntry) }, { ref: '0.1:20', startsWith: 'only this' }]);
    const gate = gateOf(await cli(['audit', 'gate', '--visual', 'visual.json']));
    const messages = gate.open.filter((finding) => finding.code === 'visual-mismatch').map((finding) => finding.message);
    expect(messages.some((message) => message.includes('7.7:7, which is no exercise of this project'))).toBe(true);
    expect(messages.some((message) => message.includes('two entries for 0.1:1'))).toBe(true);
    expect(messages.some((message) => message.includes('has no "instruction"'))).toBe(true);
    await writeFile(join(cli.dir, 'visual.json'), '[{ not json');
    const broken = await cli(['audit', 'gate', '--visual', 'visual.json']);
    expect(broken.code).toBe(3);
    expect(said(broken)).toContain('is not JSON');
    expect(said(broken)).toContain('one entry per exercise');
    await writeFile(join(cli.dir, 'visual.json'), '{"entries": 5}');
    expect((await cli(['audit', 'gate', '--visual', 'visual.json'])).code).toBe(3);
    expect((await cli(['audit', 'gate', '--visual', 'missing.json'])).code).toBe(3);
  });

  it('has a schema', async () => {
    const cli = await auditedBook();
    const done = await cli(['schema', 'visual']);
    expect(done.code).toBe(0);
    expect((done.json.result as unknown as { schema: { type: string } }).schema.type).toBe('array');
  });
});
