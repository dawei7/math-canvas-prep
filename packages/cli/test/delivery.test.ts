import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { VERSION } from '@mcprep/core';
import { buildPdf, buildSampleSheet } from '@mcprep/core/testing';
import { DELIVERY_STATUSES, checkDelivery, copyBundles, deliveryMarkdown, deliveryReport, parseDeliveryArguments, runDeliveryCheck, type DeliveryResult } from '../src/index.js';
import { writeSurveyRecord } from './audited.js';
import { RECORDS, acknowledge, cliIn, complete, confirmed, copyDelivery, finalGate, laidOut, queueBook, touchOneFrame, withAcknowledgement, writeReference, type Delivered } from './delivered.js';
import { tempDir } from './helpers.js';

/**
 * The independent check of a delivery (packages/cli/src/delivery.ts): what an agent hands over is opened again, the gate is run again in
 * memory, the bundle is compared with what the project gives now. The deliveries are built from the synthetic workbook with the real command
 * line, as the runbook ends them; every scenario is a copy of one finished delivery that something happens to.
 */

let perfect: Delivered;
let waiting: Delivered;

beforeAll(async () => {
  perfect = await laidOut('algebra');
  await complete(perfect);
  waiting = await withAcknowledgement(await laidOut('geometry'));
}, 120_000);

const check = (d: Delivered, allowZero?: string[]): Promise<DeliveryResult> => checkDelivery(d.book, { work: d.work, ...(allowZero !== undefined ? { allowZero } : {}) });
const sha = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');
const certificateOf = async (d: Delivered): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(d.folder, 'book.audit-gate.json'), 'utf8')) as Record<string, unknown>;
const writeCertificate = (d: Delivered, certificate: Record<string, unknown>): Promise<void> => writeFile(join(d.folder, 'book.audit-gate.json'), `${JSON.stringify(certificate, null, 1)}\n`);

/** Every file and folder under `dir` with the SHA-256 of its bytes (the hidden ones too, so that a lock or a temporary file shows). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = 'folder';
        await walk(path);
      } else out[relative(dir, path)] = await sha(path);
    }
  };
  await walk(dir);
  return out;
}

describe('PERFECT', () => {
  it('is said of a book that was audited, passed audit gate --final, and was exported, and the facts of the re-run are reported', async () => {
    const result = await check(perfect);
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({
      status: 'PERFECT',
      name: 'algebra',
      files: { project: 'book.mcprep.json', certificate: 'book.audit-gate.json', notes: null, bundle: 'book.mcbundle' },
      sections: 4,
      exercises: 112,
      withAnswer: 112,
      visual: { entries: 112, exercises: 112, covered: 112, mismatches: 0, defects: 0, exhaustive: true },
      survey: { pages: 21, entries: 10, missing: 0, uncovered: 0, unmarked: 0, exhaustive: true },
      acknowledgements: { total: 0, unconfirmed: 0, selfConfirmed: 0 },
      open: { total: 0, byCode: {} },
      reference: null,
      certificate: { state: 'passed', passed: true, perfect: true, ink: true },
      rerun: { passed: true, perfect: true },
      bundle: { state: 'ok', accepted: true, differences: [] },
    });
    expect(result.pdf.sha256).toBe(await sha(perfect.pdf));
    expect(result.bundle.sha256).toBe(await sha(join(perfect.folder, 'book.mcbundle')));
    expect(result.visual?.file).toBe(join(perfect.folder, 'visual'));
    expect(result.survey?.file).toBe(join(perfect.folder, 'survey'));
    expect(result.seconds).toBeGreaterThanOrEqual(0);
  });

  it('needs the acknowledgements confirmed by somebody else: AWAITING CONFIRMATION until they are, then PERFECT', async () => {
    const d = await copyDelivery(waiting);
    const before = await check(d);
    expect(before.status).toBe('AWAITING CONFIRMATION');
    expect(before.reasons).toHaveLength(1);
    expect(before.reasons[0]).toContain('1 acknowledgement waits for a second reviewer (reference-count 0.1)');
    expect(before.reasons[0]).toContain('mcprep audit confirm --by NAME');
    expect(before).toMatchObject({ acknowledgements: { total: 1, unconfirmed: 1, selfConfirmed: 0 }, reference: { differences: 1 }, certificate: { state: 'passed', passed: true, perfect: false }, rerun: { passed: true, perfect: false }, bundle: { state: 'ok' }, files: { notes: 'book.audit-notes.json' } });
    await confirmed(d);
    const after = await check(d);
    expect(after.reasons).toEqual([]);
    expect(after).toMatchObject({ status: 'PERFECT', acknowledgements: { total: 1, unconfirmed: 0, selfConfirmed: 0 }, certificate: { perfect: true }, rerun: { perfect: true } });
  });

  it('reads the sheets the certificate names, with the reference of the queue (and its chapter offset) as the gate takes them', async () => {
    const d = await copyDelivery(perfect);
    // The agent's gate ran with the sheets that were looked at; the queue says the reference, with chapters counted from 1 for a book that counts from 0.
    expect((await d.cli(['exercises', 'sheets', '--out', 'sheets', '--solutions', '--per-sheet', '56'])).code).toBe(0);
    const manifest = JSON.parse(await readFile(join(d.folder, 'sheets', 'sheets.json'), 'utf8')) as { sheets: unknown[] };
    await writeFile(join(d.folder, 'sheets', 'seen.txt'), `1-${manifest.sheets.length}`);
    const reference = join(d.root, 'inbox', 'algebra.reference.json');
    await writeFile(
      reference,
      JSON.stringify({
        chapters: [
          { number: 1, title: 'Basics', sections: [{ number: 1, title: 'Whole Numbers', exercise_count: 70 }, { number: 2, title: 'Word Problems', exercise_count: 14 }] },
          { number: 2, title: 'Geometry', sections: [{ number: 1, title: 'Points and Lines', exercise_count: 12 }, { number: 2, title: 'Triangles and Ratios', exercise_count: 16 }] },
        ],
      }),
    );
    const book = { ...d.book, reference, referenceChapterOffset: -1 };
    const gate = await d.cli(['audit', 'gate', '--reference', reference, '--chapter-offset', '-1', '--sheets-seen', 'sheets/seen.txt', ...RECORDS, '--final']);
    expect(gate.code, gate.stdout).toBe(0);
    const result = await checkDelivery(book, { work: d.work });
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ status: 'PERFECT', reference: { differences: 0 } });
    // Without the offset the labels of the reference are not the book's: two sections are only in the reference, two only in the book, two
    // have another count and another title.
    const wrong = await checkDelivery({ ...book, referenceChapterOffset: 0 }, { work: d.work });
    expect(wrong.status).toBe('MISMATCH');
    expect(wrong.open?.byCode).toEqual({ 'reference-count': 2, 'reference-extra': 2, 'reference-missing': 2, 'reference-title': 2 });
    // The sheets of the certificate are read again: one that is no longer listed as looked at opens a finding that the certificate does not have.
    await writeFile(join(d.folder, 'sheets', 'seen.txt'), '1');
    const unseen = await checkDelivery(book, { work: d.work });
    expect(unseen.status).toBe('MISMATCH');
    expect(unseen.open?.byCode).toEqual({ 'sheets-unseen': 1 });
    expect(unseen.reasons[0]).toContain('The certificate says the gate passed, but the re-run has 1 open finding (sheets-unseen 1)');
  });

  it('works for a book whose name has spaces and brackets, in the folder of its name and in the name of its copy', async () => {
    const d = await copyDelivery(perfect, { name: 'Book One (2nd ed.)' });
    const result = await check(d);
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ status: 'PERFECT', name: 'Book One (2nd ed.)' });
    const out = await tempDir('mcprep-bundles-');
    expect((await copyBundles([result], out)).map((entry) => entry.path)).toEqual([join(out, 'perfect', 'Book One (2nd ed.).mcbundle')]);
    expect(await readdir(join(out, 'perfect'))).toEqual(['Book One (2nd ed.).mcbundle']);
  });

  it('reads a visual record that is one file as well as a folder of them', async () => {
    const d = await copyDelivery(perfect);
    const entries = [...(JSON.parse(await readFile(join(d.folder, 'visual', 'sheet-001.json'), 'utf8')) as unknown[]), ...(JSON.parse(await readFile(join(d.folder, 'visual', 'sheet-002.json'), 'utf8')) as unknown[])];
    await writeFile(join(d.folder, 'visual.json'), JSON.stringify({ visual: entries }));
    await rm(join(d.folder, 'visual'), { recursive: true });
    await writeSurveyRecord(d.folder);
    await rm(join(d.folder, 'survey'), { recursive: true });
    expect((await d.cli(['audit', 'gate', '--visual', 'visual.json', '--survey', 'survey.json', '--final'])).code).toBe(0);
    const result = await check(d);
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ status: 'PERFECT', visual: { file: join(d.folder, 'visual.json'), entries: 112, exercises: 112 }, survey: { file: join(d.folder, 'survey.json'), pages: 21, entries: 10 } });
    // A path of the certificate that is relative is taken from the work folder; a certificate of an older gate has no `ink` and says it in its verify part.
    const certificate = await certificateOf(d);
    (certificate['checks'] as { visual: { file: string }; verify: { ink: boolean } }).visual.file = 'visual.json';
    delete certificate['ink'];
    await writeCertificate(d, certificate);
    const older = await check(d);
    expect(older.reasons).toEqual([]);
    expect(older).toMatchObject({ status: 'PERFECT', certificate: { ink: true }, visual: { file: join(d.folder, 'visual.json') } });
    (certificate['checks'] as { verify: { ink: boolean } }).verify.ink = false;
    await writeCertificate(d, certificate);
    expect((await check(d)).certificate).toMatchObject({ ink: false });
  });

  it('compiles the item patterns of the certificate, written as escapes, and says so when one is no expression', async () => {
    const d = await copyDelivery(perfect);
    const gate = await d.cli(['audit', 'gate', '--item-pattern', '^L(?:ö|oe)sung\\s+(\\d+)', ...RECORDS, '--final']);
    expect(gate.code, gate.stdout).toBe(0);
    expect(((await certificateOf(d))['itemPatterns'] as string[])[0]).toBe('^L(?:\\u00f6|oe)sung\\s+(\\d+)');
    expect((await check(d)).status).toBe('PERFECT');
    const certificate = await certificateOf(d);
    certificate['itemPatterns'] = ['(['];
    await writeCertificate(d, certificate);
    const broken = await check(d);
    expect(broken.status).toBe('UNREADABLE');
    expect(broken.reasons[0]).toContain('The certificate lists the item pattern "(["');
  });
});

describe('NOT FINISHED: what is still to do', () => {
  it('says the certificate is stale after a later repair, and the bundle too; the gate again and the export again make it PERFECT', async () => {
    const d = await copyDelivery(perfect);
    const id = await touchOneFrame(d);
    const stale = await check(d);
    expect(stale.status).toBe('NOT FINISHED');
    expect(stale.reasons[0]).toContain('The certificate is stale');
    expect(stale.reasons[1]).toContain('The bundle is stale');
    expect(stale.reasons[1]).toContain(`1 frame differs (${id})`);
    expect(stale).toMatchObject({ certificate: { state: 'stale', passed: true, perfect: true }, bundle: { state: 'stale' }, rerun: { passed: true, perfect: true } });
    // The agent runs the gate again but forgets to export again: the certificate is current, the bundle is not.
    expect((await finalGate(d)).code).toBe(0);
    const forgotten = await check(d);
    expect(forgotten.status).toBe('MISMATCH');
    expect(forgotten.certificate?.state).toBe('passed');
    expect((await d.cli(['export', '--out', 'book.mcbundle'])).code).toBe(0);
    const done = await check(d);
    expect(done.reasons).toEqual([]);
    expect(done.status).toBe('PERFECT');
  });

  it('lists the acknowledgements that wait among the rest of what is to do', async () => {
    const d = await copyDelivery(waiting);
    await rm(join(d.folder, 'book.mcbundle'));
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain('1 acknowledgement waits for a second reviewer (reference-count 0.1)');
    expect(result.reasons[1]).toContain('There is no bundle');
  });

  it('says there is no bundle, and that several are too many', async () => {
    const d = await copyDelivery(perfect);
    const bundle = join(d.folder, 'book.mcbundle');
    await copyFile(bundle, join(d.folder, 'other.mcbundle'));
    const two = await check(d);
    expect(two.status).toBe('NOT FINISHED');
    expect(two.reasons[0]).toContain('The work folder holds 2 bundles (book.mcbundle, other.mcbundle): exactly one is expected');
    expect(two.bundle).toMatchObject({ state: 'ambiguous', accepted: false });
    await rm(bundle);
    await rm(join(d.folder, 'other.mcbundle'));
    const none = await check(d);
    expect(none.status).toBe('NOT FINISHED');
    expect(none.reasons).toHaveLength(1);
    expect(none.reasons[0]).toContain('There is no bundle (*.mcbundle) in the work folder');
    expect(none).toMatchObject({ bundle: { state: 'missing', sha256: null }, files: { bundle: null }, certificate: { state: 'passed' }, rerun: { perfect: true } });
  });

  it('says what the importer\'s check rejects in a bundle', async () => {
    const d = await copyDelivery(perfect);
    const path = join(d.folder, 'book.mcbundle');
    const bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons[0]).toContain("The importer's check rejects the bundle:");
    expect(result.reasons[0]).toContain('Export again');
    expect(result.bundle).toMatchObject({ state: 'rejected', accepted: false });
    expect(result.bundle.sha256).toBe(await sha(path));
  });

  it('says how many exercises the visual record covers and what is open when entries are missing', async () => {
    const d = await copyDelivery(perfect);
    // Three exercises have no entry: two of section 0.1 (in the first file) and one of 1.2 (in the second).
    for (const file of ['sheet-001.json', 'sheet-002.json']) {
      const path = join(d.folder, 'visual', file);
      const entries = JSON.parse(await readFile(path, 'utf8')) as { ref: string }[];
      await writeFile(path, JSON.stringify(entries.filter((entry) => !['0.1:7', '0.1:8', '1.2:3'].includes(entry.ref))));
    }
    expect((await finalGate(d)).code).toBe(4);
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons[0]).toBe('The re-run has 2 open findings (visual-missing 2).');
    expect(result.reasons[1]).toBe('The visual record covers 109 of 112 exercises.');
    expect(result).toMatchObject({ visual: { entries: 109, exercises: 112, covered: 109, exhaustive: false }, open: { total: 2, byCode: { 'visual-missing': 2 } }, certificate: { passed: false, perfect: false }, rerun: { passed: false, perfect: false } });
  });

  it('lists the three most frequent codes of what is open, with their counts', async () => {
    const d = await copyDelivery(perfect);
    // Four defects of different kinds: an exercise deleted (numbered text left behind and more), a wrong label, a missing instruction.
    for (const args of [['frames', 'delete', '0.1:12'], ['frames', 'delete', '0.1:13'], ['frames', 'delete', '0.2:7'], ['exercises', 'label', '1.1:3', '13']]) expect((await d.cli(args)).code, args.join(' ')).toBe(0);
    expect((await d.cli(['audit', 'gate'])).code).toBe(4);
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    const open = result.open;
    expect(open?.total).toBeGreaterThanOrEqual(4);
    const counts = Object.entries(open?.byCode ?? {});
    const ordered = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    expect(counts).toEqual(ordered);
    const top = ordered.slice(0, 3).map(([code, n]) => `${code} ${n}`).join(', ');
    expect(result.reasons[0]).toBe(`The re-run has ${open?.total} open findings (${top}${ordered.length > 3 ? `, and ${ordered.length - 3} more code${ordered.length - 3 === 1 ? '' : 's'}` : ''}).`);
  });

  it('asks for the certificate that is missing, misnamed, or one of several, and for the pixel check that did not run', async () => {
    const d = await copyDelivery(perfect);
    const path = join(d.folder, 'book.audit-gate.json');
    await rename(path, join(d.folder, 'other.audit-gate.json'));
    const misnamed = await check(d);
    expect(misnamed.status).toBe('NOT FINISHED');
    expect(misnamed.reasons[0]).toContain('The certificate other.audit-gate.json is not named after the project: the tools read book.audit-gate.json');
    await rm(join(d.folder, 'other.audit-gate.json'));
    const none = await check(d);
    expect(none.status).toBe('NOT FINISHED');
    expect(none.reasons[0]).toBe('There is no certificate (book.audit-gate.json): run audit gate --final.');
    expect(none).toMatchObject({ certificate: null, rerun: { passed: true }, bundle: { state: 'ok' } });
    // The gate was run for a quick loop, without the pixel check: the certificate says so, and the re-run (which always draws the edges) does not need to.
    expect((await d.cli(['audit', 'gate', ...RECORDS, '--no-ink'])).code).toBe(0);
    const quick = await check(d);
    expect(quick.status).toBe('NOT FINISHED');
    expect(quick.reasons[0]).toContain('The pixel check of the edges did not run when the gate ran');
    expect(quick).toMatchObject({ certificate: { ink: false, perfect: false }, rerun: { perfect: true } });
    await copyFile(join(d.folder, 'book.audit-gate.json'), join(d.folder, 'second.audit-gate.json'));
    const several = await check(d);
    expect(several.reasons[0]).toContain('The work folder holds 2 certificates (book.audit-gate.json, second.audit-gate.json)');
  });

  it('asks for a new gate when the certificate does not say what the project is now: not perfect, or not passed, although nothing is open', async () => {
    const d = await copyDelivery(waiting);
    // The gate said passed with an unconfirmed note and was not run again after the reviewer confirmed it.
    expect((await d.cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(0);
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('The certificate says passed but not perfect (1 acknowledgement had no second reviewer), although the re-run is perfect now. Run audit gate --final again.');
    // The gate failed on a difference from the reference; the note for it was written and confirmed afterwards, and the gate was not run again.
    const e = await copyDelivery(perfect);
    const reference = await writeReference(e);
    expect((await e.cli(['audit', 'gate', '--reference', reference, ...RECORDS])).code).toBe(4);
    await acknowledge(e, reference);
    expect((await e.cli(['audit', 'confirm', '--by', 'reviewer', '--all'])).code).toBe(0);
    const later = await checkDelivery({ ...e.book, reference }, { work: e.work });
    expect(later.status).toBe('NOT FINISHED');
    expect(later.reasons).toEqual(['The certificate says the gate did not pass (1 open finding when it ran), although the re-run finds none now. Run audit gate again.']);
    expect(later).toMatchObject({ certificate: { state: 'failed', passed: false }, rerun: { passed: true, perfect: true }, acknowledgements: { total: 1, unconfirmed: 0 } });
    // A gate that failed and findings that are still open: the new run says so.
    const f = await copyDelivery(perfect);
    expect((await f.cli(['frames', 'delete', '0.1:12'])).code).toBe(0);
    expect((await f.cli(['audit', 'gate'])).code).toBe(4);
    const open = await check(f);
    expect(open.status).toBe('NOT FINISHED');
    expect(open.reasons[0]).toMatch(/^The re-run has \d+ open findings/);
    expect(open.certificate).toMatchObject({ state: 'failed', passed: false });
  });

  it('says the certificate names no visual record, or no survey record, when the gate ran without one', async () => {
    const d = await copyDelivery(perfect);
    expect((await d.cli(['audit', 'gate', '--survey', 'survey'])).code).toBe(0);
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons).toEqual(['The certificate names no visual record (the gate ran without --visual): nothing proves that every exercise was looked at.']);
    expect(result).toMatchObject({ visual: null, survey: { exhaustive: true }, certificate: { passed: true, perfect: false }, rerun: { passed: true, perfect: false } });
    // Without the survey record: the pages were not shown to have been looked at.
    expect((await d.cli(['audit', 'gate', '--visual', 'visual'])).code).toBe(0);
    const unsurveyed = await check(d);
    expect(unsurveyed.status).toBe('NOT FINISHED');
    expect(unsurveyed.reasons).toEqual(['The certificate names no survey record (the gate ran without --survey): nothing proves that every page of the book was looked at.']);
    expect(unsurveyed).toMatchObject({ survey: null, visual: { exhaustive: true }, certificate: { passed: true, perfect: false }, rerun: { passed: true, perfect: false } });
    // Neither: both are said, the visual record first.
    expect((await d.cli(['audit', 'gate'])).code).toBe(0);
    const neither = await check(d);
    expect(neither.reasons).toHaveLength(2);
    expect(neither.reasons[0]).toContain('names no visual record');
    expect(neither.reasons[1]).toContain('names no survey record');
  });

  it('says a survey record with a page missing is open, with the findings of the gate named', async () => {
    const d = await copyDelivery(perfect);
    // The answers at the back (pages 18-20) were never written down, and a gate with that record passes nothing.
    const path = join(d.folder, 'survey', 'overview-2.json');
    const entries = JSON.parse(await readFile(path, 'utf8')) as { kind: string }[];
    await writeFile(path, JSON.stringify(entries.filter((entry) => entry.kind !== 'answers')));
    expect((await finalGate(d)).code).toBe(4);
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons[0]).toBe('The re-run has 1 open finding (survey-missing 1).');
    expect(result).toMatchObject({ survey: { pages: 21, missing: 3, exhaustive: false }, certificate: { passed: false, perfect: false }, rerun: { passed: false, perfect: false }, open: { total: 1, byCode: { 'survey-missing': 1 } } });
  });

  it('says the bundle is of another state when the project cannot be exported at all now', async () => {
    const d = await copyDelivery(perfect);
    const path = join(d.folder, 'book.mcprep.json');
    const project = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete project['outline'];
    await writeFile(path, JSON.stringify(project));
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons[0]).toContain('The certificate is stale');
    expect(result.reasons[1]).toMatch(/^The re-run has \d+ open findings \(section-unknown \d+/);
    expect(result.reasons[2]).toContain('The bundle is stale: the project cannot be exported as it is now: The bundle cannot be written');
    expect(result.reasons[2]).toContain('E_BUNDLE_INVALID');
    expect(result.bundle).toMatchObject({ state: 'stale', accepted: true });
    expect(result.bundle.differences).toHaveLength(1);
  });

  it('says that a notes file is not the one the tools read', async () => {
    const d = await copyDelivery(waiting);
    await copyFile(join(d.folder, 'book.audit-notes.json'), join(d.folder, 'extra.audit-notes.json'));
    const result = await check(d);
    expect(result.status).toBe('NOT FINISHED');
    expect(result.reasons.some((reason) => reason.includes('The work folder holds 2 notes files (book.audit-notes.json, extra.audit-notes.json)'))).toBe(true);
    await rm(join(d.folder, 'book.audit-notes.json'));
    const misnamed = await check(d);
    expect(misnamed.reasons.some((reason) => reason.includes('The notes file extra.audit-notes.json is not named after the project'))).toBe(true);
  });
});

describe('MISMATCH: what the delivery claims is not what the files show', () => {
  it('says a bundle that is not the project\'s is one, when the certificate is current: the frames, the title, the outline', async () => {
    const d = await copyDelivery(perfect);
    const id = await touchOneFrame(d);
    expect((await finalGate(d)).code).toBe(0);
    const frames = await check(d);
    expect(frames.status).toBe('MISMATCH');
    expect(frames.reasons).toHaveLength(1);
    expect(frames.reasons[0]).toContain('The certificate is current and says the gate passed, but the bundle differs from the project');
    expect(frames.reasons[0]).toContain(`frames.json is not the project's frames: 1 frame differs (${id})`);
    expect(frames.reasons[0]).toMatch(/\((\d+) frames in the bundle, \1 in the project\)/);
    expect(frames.reasons[0]).toContain('Export again.');
    expect(frames).toMatchObject({ bundle: { state: 'stale', accepted: true }, certificate: { state: 'passed', perfect: true }, rerun: { perfect: true } });
    // The title and the author of the project are in the manifest too: the frames of the bundle are right, the document is not.
    const e = await copyDelivery(perfect);
    expect((await e.cli(['book', 'meta', '--title', 'A New Title', '--author', 'An Author'])).code).toBe(0);
    const meta = await check(e);
    expect(meta.status).toBe('MISMATCH');
    expect(meta.bundle.differences).toEqual(['its title is "Synthetic Algebra Workbook", the project\'s is "A New Title"', 'its author is none, the project\'s is "An Author"']);
    // The outline of the project changed and the gate was run again: outline.json is not the project's.
    const f = await copyDelivery(perfect);
    const outline = (await f.cli(['outline'])).json.result as unknown as { entries: { id: string; title: string }[] };
    const first = outline.entries[0] as { id: string; title: string };
    expect((await f.cli(['outline', 'update', first.id, '--title', 'A Better Title'])).code).toBe(0);
    expect((await finalGate(f)).code).toBe(0);
    const changed = await check(f);
    expect(changed.status).toBe('MISMATCH');
    expect(changed.bundle.differences).toHaveLength(1);
    expect(changed.bundle.differences[0]).toMatch(/^outline\.json is not the project's outline \(\d+ entries in the bundle, \d+ in the project\)$/);
  });

  it('says a certificate edited to say perfect while something is open does not describe the project', async () => {
    const d = await copyDelivery(perfect);
    expect((await d.cli(['frames', 'delete', '0.1:12'])).code).toBe(0);
    expect((await d.cli(['audit', 'gate'])).code).toBe(4);
    // The certificate is current and says the gate failed; by hand it is made to say that it passed and that the book is perfect.
    const certificate = await certificateOf(d);
    Object.assign(certificate, { passed: true, perfect: true, open: [], unconfirmed: 0 });
    await writeCertificate(d, certificate);
    const result = await check(d);
    expect(result.status).toBe('MISMATCH');
    expect(result.reasons[0]).toMatch(/^The certificate says the gate passed, but the re-run has \d+ open findings \(.*numbered-text-left-behind.*\)\. The certificate does not describe this project\.$/);
    expect(result.certificate).toMatchObject({ state: 'passed', passed: true, perfect: true });
    expect(result.rerun).toMatchObject({ passed: false, perfect: false });
    // The bundle that was exported before the frame was deleted is not the project's either; the gate's own bundle finding is not counted twice.
    expect(result.reasons.some((reason) => reason.includes('the bundle differs from the project') && reason.includes('only in the bundle'))).toBe(true);
    expect(result.open?.byCode).not.toHaveProperty('bundle-stale');
  });

  it('says a certificate that says perfect, with a visual record that is no longer there or lost entries, is not backed', async () => {
    const d = await copyDelivery(perfect);
    // The record named by the certificate is gone: nothing stands behind "perfect".
    await rename(join(d.folder, 'visual'), join(d.folder, 'moved'));
    const gone = await check(d);
    expect(gone.status).toBe('MISMATCH');
    expect(gone.reasons[0]).toBe(`The certificate says perfect, but the re-run is not: the visual record that the certificate names (${join(d.folder, 'visual')}) does not exist.`);
    expect(gone.visual).toBeNull();
    await rename(join(d.folder, 'moved'), join(d.folder, 'visual'));
    expect((await check(d)).status).toBe('PERFECT');
    // Entries are taken out of the record after the certificate was written.
    const path = join(d.folder, 'visual', 'sheet-002.json');
    const entries = JSON.parse(await readFile(path, 'utf8')) as { ref: string }[];
    await writeFile(path, JSON.stringify(entries.slice(5)));
    const lost = await check(d);
    expect(lost.status).toBe('MISMATCH');
    expect(lost.reasons[0]).toMatch(/^The certificate says the gate passed, but the re-run has 1 open finding \(visual-missing \d\)/);
    expect(lost.reasons).toContain('The visual record covers 107 of 112 exercises.');
  });

  it('says a certificate that says perfect, with a survey record that is gone, lost a page, or was edited to disagree with the project, is not backed', async () => {
    const d = await copyDelivery(perfect);
    // The record named by the certificate is gone: nothing shows that every page was looked at.
    await rename(join(d.folder, 'survey'), join(d.folder, 'moved'));
    const gone = await check(d);
    expect(gone.status).toBe('MISMATCH');
    expect(gone.reasons).toEqual([`The certificate says perfect, but the re-run is not: the survey record that the certificate names (${join(d.folder, 'survey')}) does not exist.`]);
    expect(gone).toMatchObject({ survey: null, rerun: { passed: true, perfect: false } });
    await rename(join(d.folder, 'moved'), join(d.folder, 'survey'));
    expect((await check(d)).status).toBe('PERFECT');
    // A range is taken out of the record after the certificate was written: two pages have no entry.
    const path = join(d.folder, 'survey', 'overview-1.json');
    const entries = JSON.parse(await readFile(path, 'utf8')) as { from: number; to: number; kind: string }[];
    await writeFile(path, JSON.stringify(entries.filter((entry) => entry.from !== 3)));
    const lost = await check(d);
    expect(lost.status).toBe('MISMATCH');
    expect(lost.reasons[0]).toBe('The certificate says the gate passed, but the re-run has 1 open finding (survey-missing 1). The certificate does not describe this project.');
    expect(lost).toMatchObject({ survey: { missing: 2, exhaustive: false }, open: { total: 1, byCode: { 'survey-missing': 1 } } });
    // A range is edited to say that pages hold no exercise where the project has exercises on them: the record and the project disagree.
    await writeFile(path, JSON.stringify(entries.map((entry) => (entry.from === 5 ? { ...entry, kind: 'text' } : entry))));
    const unmarked = await check(d);
    expect(unmarked.status).toBe('MISMATCH');
    expect(unmarked.reasons[0]).toBe('The certificate says the gate passed, but the re-run has 1 open finding (survey-unmarked 1). The certificate does not describe this project.');
    expect(unmarked).toMatchObject({ survey: { unmarked: 2, exhaustive: false } });
  });

  it('does not count a confirmation that the one who wrote the note wrote for itself, however its name is spelled', async () => {
    const d = await copyDelivery(waiting);
    const path = join(d.folder, 'book.audit-notes.json');
    const notes = JSON.parse(await readFile(path, 'utf8')) as { acknowledgements: Record<string, unknown>[] };
    const note = notes.acknowledgements[0] as Record<string, unknown>;
    const confirmedBy = (name: string): Promise<void> => writeFile(path, JSON.stringify({ ...notes, acknowledgements: [{ ...note, confirmed: true, confirmedBy: name, confirmedAt: '2026-10-05T10:00:00Z' }] }));
    await confirmedBy(' WRITER ');
    const result = await check(d);
    expect(result.status).toBe('MISMATCH');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('1 acknowledgement confirmed by the one who wrote it (reference-count 0.1, written and confirmed by writer)');
    expect(result.reasons[0]).toContain('the notes file was edited by hand');
    expect(result.acknowledgements).toEqual({ total: 1, unconfirmed: 1, selfConfirmed: 1 });
    // The tools read it as no confirmation: the gate says the same, and the check still does not accept the delivery.
    expect((await finalGate(d)).code).toBe(4);
    expect((await check(d)).status).toBe('MISMATCH');
    // With white space inside the name the tools see another reviewer (they only cut the ends); the check ignores all the spaces.
    await confirmedBy('W R I T E R');
    expect((await finalGate(d)).code).toBe(0);
    const spaced = await check(d);
    expect(spaced.status).toBe('MISMATCH');
    expect(spaced.reasons).toHaveLength(1);
    expect(spaced.acknowledgements).toEqual({ total: 1, unconfirmed: 1, selfConfirmed: 1 });
    // A confirmation by somebody else is one.
    await confirmedBy('reviewer');
    const fine = await check(d);
    expect(fine.reasons).toEqual([]);
    expect(fine).toMatchObject({ status: 'PERFECT', acknowledgements: { total: 1, unconfirmed: 0, selfConfirmed: 0 } });
  });

  it('says a project made on another PDF than the one of the queue is the work of another file', async () => {
    const d = await copyDelivery(perfect);
    const other = join(d.root, 'inbox', 'other.pdf');
    await writeFile(other, buildSampleSheet().pdf);
    const result = await checkDelivery({ ...d.book, pdf: other }, { work: d.work });
    expect(result.status).toBe('MISMATCH');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("The project was made on another PDF than the queue's");
    expect(result.reasons[0]).toContain(`it records SHA-256 ${(await sha(d.pdf)).slice(0, 12)}...`);
    expect(result.reasons[0]).toContain(`has ${(await sha(other)).slice(0, 12)}...`);
    expect(result.pdf.sha256).toBe(await sha(other));
    // Nothing of it counts: no bundle of it is offered for copying.
    expect(result.bundle.accepted).toBe(false);
  });
});

/**
 * A book that really prints no exercise: 21 pages of running text (no numbered item anywhere), the sections of the workbook as its outline. Delivered like the
 * others: `inbox/<name>.pdf`, `work/<name>/` with the project. (The census of numbered runs would keep a book open that prints exercises and has no frame.)
 */
async function proseBook(name: string): Promise<Delivered> {
  const root = await tempDir('mcprep-delivery-');
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'inbox'));
  const folder = join(root, 'work', name);
  await mkdir(folder);
  const pdf = join(root, 'inbox', `${name}.pdf`);
  const bytes = buildPdf({
    pages: Array.from({ length: 21 }, (_unused, index) => ({
      texts: [
        { text: `Page ${index + 1} of the notes: the argument goes on in plain sentences.`, x: 72, y: 100, size: 11 },
        { text: 'A paragraph follows the paragraph before it, and no item of it carries a number.', x: 72, y: 120, size: 11 },
      ],
    })),
  });
  await writeFile(pdf, bytes);
  await copyFile(pdf, join(folder, 'book.pdf'));
  const cli = cliIn(folder);
  for (const args of [
    ['init', 'book.pdf', '--title', 'Notes without exercises'],
    ['outline', 'add', '--title', 'Whole Numbers', '--label', '0.1', '--id', '0.1', '--page', '0'],
    ['outline', 'add', '--title', 'Word Problems', '--label', '0.2', '--id', '0.2', '--page', '8'],
  ]) {
    const done = await cli(args);
    if (done.code !== 0) throw new Error(`${args.join(' ')} failed: ${done.stdout}`);
  }
  return { root, work: join(root, 'work'), folder, name, pdf, book: queueBook(name, pdf), cli };
}

describe('ZERO EXERCISES', () => {
  /**
   * The workbook with its sections and no exercise at all (an audit that found nothing), exported. `honest` says what the survey record of the
   * pages shows: a book that really prints no exercise (every page is text), or the pages as they are printed (the practice sets are there).
   */
  async function empty(name: string, honest = true): Promise<Delivered> {
    const d = honest ? await proseBook(name) : await laidOut(name);
    if (!honest) {
      const path = join(d.folder, 'book.mcprep.json');
      const project = JSON.parse(await readFile(path, 'utf8')) as { frames: unknown[] };
      project.frames = [];
      await writeFile(path, JSON.stringify(project));
    }
    if (honest) await writeFile(join(d.folder, 'survey.json'), JSON.stringify([{ from: 0, to: 20, kind: 'text' }]));
    else await writeSurveyRecord(d.folder);
    const gate = await d.cli(['audit', 'gate', '--survey', 'survey.json']);
    expect(gate.code, gate.stdout).toBe(honest ? 0 : 4);
    expect((await d.cli(['export', '--out', 'book.mcbundle'])).code).toBe(0);
    return d;
  }

  it('is what the survey of the pages shows when the audit found nothing in a book that prints exercises: the missed ones are open', async () => {
    const d = await empty('missed', false);
    const result = await check(d);
    expect(result.status).toBe('ZERO EXERCISES');
    expect(result.reasons[0]).toContain('The audit has 0 exercises. A person decides');
    expect(result.reasons[1]).toMatch(/^The re-run has \d+ open findings \(.*survey-uncovered \d+.*\)\.$/);
    expect(result.reasons[1]).toContain('numbered-run-uncovered');
    expect(result).toMatchObject({ exercises: 0, survey: { pages: 21, exhaustive: false }, certificate: { state: 'failed', passed: false } });
    expect((result.survey?.uncovered ?? 0) > 0).toBe(true);
    // Allowing it does not help: the pages that hold exercises are still open.
    const allowed = await check(d, ['missed']);
    expect(allowed.status).toBe('NOT FINISHED');
    expect(allowed.reasons[0]).toMatch(/^The re-run has \d+ open findings \(.*survey-uncovered \d+.*\)\.$/);
  });

  it('needs a person\'s decision, and the reference of the queue is told when it lists exercises; --allow-zero says the decision was taken', async () => {
    const d = await empty('empty');
    const without = await check(d);
    expect(without.status).toBe('ZERO EXERCISES');
    expect(without.reasons[0]).toContain('The audit has 0 exercises. A person decides whether the book prints none (then list it with --allow-zero NAME)');
    expect(without).toMatchObject({ exercises: 0, withAnswer: 0, bundle: { state: 'ok' } });
    // The reference of the queue lists exercises that the audit did not find; the agent's gate with it says so, and so does the check.
    const reference = join(d.root, 'inbox', 'empty.reference.json');
    await writeFile(reference, JSON.stringify({ sections: [{ label: '0.1', exercise_count: 70 }, { label: '0.2', exercise_count: 14 }] }));
    expect((await d.cli(['audit', 'gate', '--reference', reference, '--survey', 'survey.json'])).code).toBe(4);
    const listed = await checkDelivery({ ...d.book, reference }, { work: d.work });
    expect(listed.status).toBe('ZERO EXERCISES');
    expect(listed.reasons[0]).toContain('The audit has 0 exercises, but the reference lists 84 exercises: the audit probably missed them.');
    expect(listed.reasons[1]).toMatch(/^The re-run has \d+ open findings/);
    // The agent's gate that did not have the reference passes: the certificate does not describe the project that the queue's reference is for.
    expect((await d.cli(['audit', 'gate', '--survey', 'survey.json'])).code).toBe(0);
    const mismatch = await checkDelivery({ ...d.book, reference }, { work: d.work });
    expect(mismatch.status).toBe('MISMATCH');
    expect(mismatch.reasons[0]).toContain('The certificate says the gate passed, but the re-run has');
    expect(mismatch.reasons[1]).toContain('The audit has 0 exercises, but the reference lists 84 exercises');
    // A book without exercises has none to look at: with the decision it is PERFECT, with the pixel check done, every page surveyed and nothing unconfirmed.
    const allowed = await check(d, ['EMPTY']);
    expect(allowed.reasons).toEqual([]);
    expect(allowed.status).toBe('PERFECT');
    // The decision is for that book: another name does not do.
    expect((await check(d, ['empty-2'])).status).toBe('ZERO EXERCISES');
  });
});

describe('NOT STARTED and UNREADABLE', () => {
  it('says nothing was started when there is no work folder or no project in it', async () => {
    const d = await copyDelivery(perfect);
    const ghost = await checkDelivery(queueBook('ghost', d.pdf), { work: d.work });
    expect(ghost.status).toBe('NOT STARTED');
    expect(ghost.reasons).toEqual([`There is no work folder ${join(d.work, 'ghost')}.`]);
    expect(ghost).toMatchObject({ sections: null, exercises: null, visual: null, acknowledgements: null, open: null, rerun: null, certificate: null, bundle: { state: 'missing' } });
    await mkdir(join(d.work, 'blank'));
    await writeFile(join(d.work, 'blank', 'progress.md'), 'A1 done');
    const blank = await checkDelivery(queueBook('blank', d.pdf), { work: d.work });
    expect(blank.status).toBe('NOT STARTED');
    expect(blank.reasons[0]).toContain('There is no project file (*.mcprep.json)');
    // A bundle or a certificate without a project is not a delivery.
    await copyFile(join(d.folder, 'book.mcbundle'), join(d.work, 'blank', 'blank.mcbundle'));
    expect((await checkDelivery(queueBook('blank', d.pdf), { work: d.work })).status).toBe('NOT STARTED');
  });

  it('says a file that cannot be read is why, with what is wrong with it', async () => {
    const d = await copyDelivery(perfect);
    const project = join(d.folder, 'book.mcprep.json');
    const good = await readFile(project, 'utf8');
    await writeFile(project, '{ "format": ');
    const broken = await check(d);
    expect(broken.status).toBe('UNREADABLE');
    expect(broken.reasons[0]).toContain('is not valid JSON');
    expect(broken.reasons[0]).toContain('E_PROJECT_JSON');
    expect(broken.bundle).toMatchObject({ state: 'unverified', accepted: true });
    await writeFile(project, good);
    await copyFile(project, join(d.folder, 'second.mcprep.json'));
    const two = await check(d);
    expect(two.status).toBe('UNREADABLE');
    expect(two.reasons[0]).toContain('The work folder holds 2 project files (book.mcprep.json, second.mcprep.json): exactly one is expected.');
    await rm(join(d.folder, 'second.mcprep.json'));
    const certificate = join(d.folder, 'book.audit-gate.json');
    await writeFile(certificate, '{ not json');
    const bad = await check(d);
    expect(bad.status).toBe('UNREADABLE');
    expect(bad.reasons[0]).toContain('The certificate book.audit-gate.json is not JSON');
    await writeFile(certificate, JSON.stringify({ hello: 1 }));
    expect((await check(d)).reasons[0]).toContain('The certificate book.audit-gate.json is not a gate certificate');
  });

  it('says the PDF of the queue cannot be read', async () => {
    const d = await copyDelivery(perfect);
    const result = await checkDelivery({ ...d.book, pdf: join(d.root, 'inbox', 'gone.pdf') }, { work: d.work });
    expect(result.status).toBe('UNREADABLE');
    expect(result.reasons[0]).toContain('Cannot read the PDF');
    expect(result.reasons[0]).toContain('E_PDF_MISSING');
  });

  it('says the PDF of the project is missing, or is not the one it was made on, with the error of the tools', async () => {
    const d = await copyDelivery(perfect);
    const pdf = join(d.folder, 'book.pdf');
    await rename(pdf, join(d.folder, 'moved.pdf'));
    const missing = await check(d);
    expect(missing.status).toBe('UNREADABLE');
    expect(missing.reasons[0]).toContain('does not exist');
    expect(missing.reasons[0]).toContain('E_PDF_MISSING');
    // The bundle was checked by the importer before the re-run failed; it stays unverified against the project.
    expect(missing.bundle).toMatchObject({ state: 'unverified', accepted: true });
    await writeFile(pdf, buildSampleSheet().pdf);
    const changed = await check(d);
    expect(changed.status).toBe('UNREADABLE');
    expect(changed.reasons[0]).toContain('is not the one this project was made for');
    expect(changed.reasons[0]).toContain('E_PDF_CHANGED');
  });
});

describe('what the check does to the work folders', () => {
  it('leaves every file of every work folder as it was: no certificate, no export, no lock, no temporary file', async () => {
    const stale = await copyDelivery(perfect);
    await touchOneFrame(stale);
    const open = await copyDelivery(waiting);
    await rm(join(open.folder, 'book.audit-gate.json'));
    for (const d of [perfect, waiting, stale, open]) {
      const before = await snapshot(d.folder);
      expect(Object.keys(before).length).toBeGreaterThan(3);
      await check(d);
      expect(await snapshot(d.folder)).toEqual(before);
    }
    // The queue's PDF and the work root are not touched either.
    const roots = await snapshot(stale.root);
    await check(stale);
    expect(await snapshot(stale.root)).toEqual(roots);
  });
});

describe('copying the bundles', () => {
  it('sorts them by what was found, replaces an earlier copy, and takes only what the importer accepts', async () => {
    // Six books in one work root, one of each kind.
    const good = await copyDelivery(perfect, { name: 'good' });
    const wait = await copyDelivery(waiting, { name: 'wait', into: good });
    const late = await copyDelivery(perfect, { name: 'late', into: good });
    await touchOneFrame(late);
    const broken = await copyDelivery(perfect, { name: 'broken', into: good });
    await writeFile(join(broken.folder, 'book.mcbundle'), 'not a bundle');
    const none = await copyDelivery(perfect, { name: 'none', into: good });
    await rm(join(none.folder, 'book.mcbundle'));
    const unreadable = await copyDelivery(perfect, { name: 'unreadable', into: good });
    await writeFile(join(unreadable.folder, 'book.mcprep.json'), '{ not json');
    const books = [good, wait, late, broken, none, unreadable];
    const results = await Promise.all(books.map((d) => check(d)));
    expect(results.map((result) => result.status)).toEqual(['PERFECT', 'AWAITING CONFIRMATION', 'NOT FINISHED', 'NOT FINISHED', 'NOT FINISHED', 'UNREADABLE']);
    const out = await tempDir('mcprep-bundles-');
    const before = await Promise.all(books.map((d) => snapshot(d.folder)));
    const copied = await copyBundles(results, out);
    // The bundle that the importer accepts goes with the status, even when the project cannot be read; the rejected one and the missing one do not go.
    expect(copied.map((entry) => `${entry.folder}/${entry.name}`)).toEqual(['perfect/good', 'awaiting-confirmation/wait', 'draft/late', 'draft/unreadable']);
    expect((await readdir(join(out, 'perfect'))).sort()).toEqual(['good.mcbundle']);
    expect((await readdir(join(out, 'awaiting-confirmation'))).sort()).toEqual(['wait.mcbundle']);
    expect((await readdir(join(out, 'draft'))).sort()).toEqual(['late.mcbundle', 'unreadable.mcbundle']);
    expect(await sha(join(out, 'perfect', 'good.mcbundle'))).toBe(await sha(join(good.folder, 'book.mcbundle')));
    expect(await sha(join(out, 'draft', 'late.mcbundle'))).toBe(await sha(join(late.folder, 'book.mcbundle')));
    // The work folders are as they were.
    expect(await Promise.all(books.map((d) => snapshot(d.folder)))).toEqual(before);

    // Later the reviewer confirms the note, and the late book is exported again after its repair: both move up, and no copy is left in the old place.
    await confirmed(wait);
    expect((await finalGate(late)).code).toBe(0);
    expect((await late.cli(['export', '--out', 'book.mcbundle'])).code).toBe(0);
    const again = await Promise.all([wait, late].map((d) => check(d)));
    expect(again.map((result) => result.status)).toEqual(['PERFECT', 'PERFECT']);
    await copyBundles(again, out);
    expect((await readdir(join(out, 'perfect'))).sort()).toEqual(['good.mcbundle', 'late.mcbundle', 'wait.mcbundle']);
    expect(await readdir(join(out, 'awaiting-confirmation'))).toEqual([]);
    expect(await readdir(join(out, 'draft'))).toEqual(['unreadable.mcbundle']);
    expect(await sha(join(out, 'perfect', 'late.mcbundle'))).toBe(await sha(join(late.folder, 'book.mcbundle')));

    // A bundle that changed is copied over its earlier copy, and nothing but bundles is in the folders (no temporary file is left).
    const old = await sha(join(out, 'perfect', 'good.mcbundle'));
    expect((await good.cli(['book', 'meta', '--title', 'Another Title'])).code).toBe(0);
    expect((await good.cli(['export', '--out', 'book.mcbundle'])).code).toBe(0);
    const renewed = await check(good);
    expect(renewed.status).toBe('PERFECT');
    await copyBundles([renewed], out);
    const copy = await sha(join(out, 'perfect', 'good.mcbundle'));
    expect(copy).not.toBe(old);
    expect(copy).toBe(await sha(join(good.folder, 'book.mcbundle')));
    for (const folder of ['perfect', 'awaiting-confirmation', 'draft']) expect((await readdir(join(out, folder))).every((name) => name.endsWith('.mcbundle'))).toBe(true);
  });
});

describe('the report', () => {
  const results = async (): Promise<DeliveryResult[]> => {
    const d = await copyDelivery(perfect);
    const ghost = await checkDelivery(queueBook('ghost', d.pdf), { work: d.work });
    const stale = await checkDelivery(d.book, { work: d.work });
    await rm(join(d.folder, 'book.mcbundle'));
    const none = await checkDelivery({ ...d.book, name: 'algebra' }, { work: d.work });
    return [stale, ghost, { ...none, name: 'second | book' }];
  };

  it('is DELIVERY.md with the date, the queue, the version, a line for each status, a row for each book and a block for each that is not perfect', async () => {
    const found = await results();
    const input = { checkedAt: new Date('2026-10-05T10:20:30Z'), queue: '/books/queue.json', work: '/books/work', allowZero: ['ghost'], results: found };
    const text = deliveryMarkdown(input);
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Delivery check 2026-10-05: `/books/queue.json`');
    expect(text).toContain(`Checked 2026-10-05 10:20 UTC with Math Canvas Prep ${VERSION}.`);
    for (const status of DELIVERY_STATUSES) expect(lines).toContain(`- ${status}: ${found.filter((result) => result.status === status).length}`);
    // One line for each status, in this order, before the table.
    const totals = lines.slice(0, lines.findIndex((line) => line.startsWith('| # |'))).filter((line) => line.startsWith('- '));
    expect(totals.map((line) => line.split(':')[0])).toEqual(DELIVERY_STATUSES.map((status) => `- ${status}`));
    const rows = lines.filter((line) => /^\| \d+ \|/.test(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('| 1 | algebra | PERFECT | 4 | 112 | 112/112 | 0/0 | ok | - |');
    expect(rows[1]).toMatch(/^\| 2 \| ghost \| NOT STARTED \| - \| - \| - \| - \| missing \| There is no work folder .* \|$/);
    expect(rows[2]).toMatch(/^\| 3 \| second \\\| book \| NOT FINISHED \| 4 \| 112 \| 112\/112 \| 0\/0 \| missing \| There is no bundle/);
    expect(lines).toContain('## ghost: NOT STARTED');
    expect(lines).toContain('## second | book: NOT FINISHED');
    expect(lines).not.toContain('## algebra: PERFECT');
    // Each block lists all the reasons and then what the re-run found.
    expect(lines.some((line) => /^Found: the re-run did not run\. SHA-256 of the PDF -, of the bundle -\. Checked in [\d.]+ s\.$/.test(line))).toBe(true);
    expect(lines.some((line) => /^Found: 112 exercises \(112 with an answer\) in 4 sections; reference differences -; survey record 10 ranges for 21 pages; open none\. SHA-256 of the PDF [0-9a-f]{12}\.\.\., of the bundle -\. Checked in [\d.]+ s\.$/.test(line))).toBe(true);
    expect(lines).toContain('- There is no bundle (*.mcbundle) in the work folder: export it (mcprep export).');
    expect(text).toContain('whether anybody looked at the pictures of the visual pass');
    expect(text).toContain('A person samples a few books of every batch');
  });

  it('is DELIVERY.json with the same facts, one object for each book', async () => {
    const found = await results();
    const report = deliveryReport({ checkedAt: new Date('2026-10-05T10:20:30.123Z'), queue: '/books/queue.json', work: '/books/work', allowZero: ['x'], results: found });
    expect(report).toMatchObject({ format: 'math-canvas-delivery-check', version: 1, tool: { name: 'math-canvas-prep', version: VERSION }, checkedAt: '2026-10-05T10:20:30Z', queue: '/books/queue.json', work: '/books/work', allowZero: ['x'], perfect: false });
    expect(report.totals).toEqual({ PERFECT: 1, 'AWAITING CONFIRMATION': 0, 'NOT FINISHED': 1, MISMATCH: 0, 'ZERO EXERCISES': 0, UNREADABLE: 0, 'NOT STARTED': 1 });
    expect(report.books.map((book) => book.status)).toEqual(['PERFECT', 'NOT STARTED', 'NOT FINISHED']);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(deliveryReport({ checkedAt: new Date(), queue: 'q', work: 'w', results: found.slice(0, 1) }).perfect).toBe(true);
    expect(deliveryReport({ checkedAt: new Date(), queue: 'q', work: 'w', results: [] }).perfect).toBe(false);
  });
});

describe('the program', () => {
  /** A queue file for a root that has the books of the deliveries in its `work` folder and their PDFs in `inbox`. */
  async function queueOf(d: Delivered, extra: object[] = []): Promise<string> {
    const queue = join(d.root, 'queue.json');
    await writeFile(queue, JSON.stringify({ books: [{ pdf: relative(d.root, d.pdf), name: d.name }, ...extra] }));
    return queue;
  }
  const run = async (cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await runDeliveryCheck(args, { stdout: (text) => void (out += text), stderr: (text) => void (err += text), cwd });
    return { code, out, err };
  };

  it('reads the arguments, with the lists joined and a name given twice', () => {
    expect(parseDeliveryArguments(['queue.json', '--work', 'w'])).toEqual({ args: { source: 'queue.json', work: 'w', allowZero: [] } });
    expect(parseDeliveryArguments(['q', '--work', 'w', '--out', 'o', '--only', 'a, b', '--only', 'c', '--allow-zero', 'x,y', '--copy-bundles', 'c'])).toEqual({ args: { source: 'q', work: 'w', out: 'o', only: ['a', 'b', 'c'], allowZero: ['x', 'y'], copyBundles: 'c' } });
    expect(parseDeliveryArguments(['--help'])).toEqual({ help: true });
    expect(parseDeliveryArguments([]).problem).toContain('name the queue file');
    expect(parseDeliveryArguments(['a', 'b', '--work', 'w']).problem).toContain('one queue file');
    expect(parseDeliveryArguments(['a']).problem).toContain('--work is needed');
    expect(parseDeliveryArguments(['a', '--work']).problem).toBe('--work needs a value');
    expect(parseDeliveryArguments(['a', '--work', 'w', '--sample', '4']).problem).toBe('unknown option --sample');
  });

  it('exits 0 only when every book that was checked is PERFECT, 1 when one is not, and writes DELIVERY.md and DELIVERY.json to --out', async () => {
    const d = await copyDelivery(perfect);
    const queue = await queueOf(d, [{ pdf: relative(d.root, d.pdf), name: 'ghost' }]);
    const out = await tempDir('mcprep-delivery-out-');
    const mixed = await run(d.root, queue, '--work', d.work, '--out', out);
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain('2 books in');
    expect(mixed.out).toMatch(/\[1\/2\] algebra: PERFECT \(\d+(\.\d)? s\)/);
    expect(mixed.out).toContain('[2/2] ghost: NOT STARTED');
    expect(mixed.out).toMatch(/1\s+algebra\s+PERFECT\s+4\s+112\s+112\/112\s+0\/0\s+ok\s+-/);
    expect(mixed.out).toMatch(/2\s+ghost\s+NOT STARTED/);
    expect(mixed.out).toContain('PERFECT 1, NOT STARTED 1');
    expect((await readdir(out)).sort()).toEqual(['DELIVERY.json', 'DELIVERY.md']);
    const json = JSON.parse(await readFile(join(out, 'DELIVERY.json'), 'utf8')) as { perfect: boolean; books: { name: string; status: string }[]; work: string };
    expect(json.perfect).toBe(false);
    expect(json.books.map((book) => `${book.name} ${book.status}`)).toEqual(['algebra PERFECT', 'ghost NOT STARTED']);
    expect(await readFile(join(out, 'DELIVERY.md'), 'utf8')).toContain('## ghost: NOT STARTED');
    // Only the books asked for are checked and count; the names are matched without regard to case.
    const only = await run(d.root, queue, '--work', d.work, '--out', out, '--only', 'ALGEBRA');
    expect(only.code).toBe(0);
    expect(only.out).toContain('1 book in');
    expect((JSON.parse(await readFile(join(out, 'DELIVERY.json'), 'utf8')) as { books: unknown[] }).books).toHaveLength(1);
    // Without --out the files go to the work root (never into the work folder of a book).
    const into = await run(d.root, queue, '--work', d.work, '--only', 'algebra');
    expect(into.code).toBe(0);
    expect((await readdir(d.work)).sort()).toEqual(['DELIVERY.json', 'DELIVERY.md', 'algebra']);
  });

  it('reads a folder of PDFs as the queue, with the reference of its sidecar, and lists a book the queue cannot use as UNREADABLE', async () => {
    const d = await copyDelivery(perfect);
    const out = await tempDir('mcprep-delivery-out-');
    const inbox = join(d.root, 'inbox');
    await writeFile(join(inbox, 'algebra.meta.json'), JSON.stringify({ reference: 'algebra.reference.json' }));
    await writeFile(join(inbox, 'algebra.reference.json'), JSON.stringify({ sections: [{ label: '0.1', exercise_count: 70 }, { label: '0.2', exercise_count: 14 }, { label: '1.1', exercise_count: 12 }, { label: '1.2', exercise_count: 16 }] }));
    const ok = await run(d.root, inbox, '--work', d.work, '--out', out);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(((JSON.parse(await readFile(join(out, 'DELIVERY.json'), 'utf8')) as { books: DeliveryResult[] }).books[0] as DeliveryResult).reference).toMatchObject({ differences: 0 });
    // A book whose sidecar is wrong is in the queue as a problem: it is listed, UNREADABLE, and the exit code says 1.
    await writeFile(join(inbox, 'algebra.meta.json'), JSON.stringify({ licence: { name: 'x' } }));
    const bad = await run(d.root, inbox, '--work', d.work, '--out', out);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('algebra: UNREADABLE (the queue cannot use it as it is written)');
    expect(await readFile(join(out, 'DELIVERY.md'), 'utf8')).toContain('unknown field "licence" (did you mean "license"?)');
  });

  it('exits 2 for a usage error and says what is wrong', async () => {
    const d = await copyDelivery(perfect);
    const queue = await queueOf(d);
    const out = await tempDir('mcprep-delivery-out-');
    const usage = 'usage: node scripts/check-delivery.mjs';
    const cases: [string[], string][] = [
      [[], 'name the queue file'],
      [[queue], '--work is needed'],
      [[queue, '--work'], '--work needs a value'],
      [[queue, '--work', d.work, '--bogus', 'x'], 'unknown option --bogus'],
      [[queue, '--work', join(d.work, 'nowhere')], 'is not a folder'],
      [[queue, '--work', d.work, '--only', 'nothing'], '--only: no such book: nothing. The books are algebra.'],
      [[queue, '--work', d.work, '--allow-zero', 'nothing'], '--allow-zero: no such book: nothing'],
      [[queue, '--work', d.work, '--out', join(d.folder, 'reports')], `lies in the work folder ${d.folder}`],
      [[queue, '--work', d.work, '--out', out, '--copy-bundles', d.folder], `lies in the work folder ${d.folder}`],
      [[join(d.root, 'nothing.json'), '--work', d.work], 'nothing.json does not exist'],
      [[join(d.root, 'queue.json'), '--work', d.work, '--only', ''], 'There is no book to check'],
    ];
    await writeFile(join(d.root, 'broken.json'), '{ "books": ');
    await writeFile(join(d.root, 'empty.json'), JSON.stringify({ books: [] }));
    cases.push([[join(d.root, 'broken.json'), '--work', d.work], 'broken.json cannot be read'], [[join(d.root, 'empty.json'), '--work', d.work], 'There is no book to check']);
    for (const [args, message] of cases) {
      const done = await run(d.root, ...args);
      expect(done.code, args.join(' ')).toBe(2);
      expect(done.err, args.join(' ')).toContain(message);
      expect(done.err).toContain(usage);
    }
    const help = await run(d.root, '--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain(usage);
    // Nothing was written for any of them.
    expect(await readdir(out)).toEqual([]);
    expect(await readdir(d.folder)).not.toContain('reports');
  });

  it('copies the bundles with --copy-bundles and says how many went where', async () => {
    const good = await copyDelivery(perfect, { name: 'good' });
    await copyDelivery(waiting, { name: 'wait', into: good });
    const queue = join(good.root, 'queue.json');
    await writeFile(queue, JSON.stringify({ books: [{ pdf: 'inbox/good.pdf', name: 'good' }, { pdf: 'inbox/wait.pdf', name: 'wait', reference: 'inbox/wait.reference.json' }] }));
    const out = await tempDir('mcprep-delivery-out-');
    const copies = await tempDir('mcprep-delivery-copies-');
    let text = '';
    const code = await runDeliveryCheck([queue, '--work', good.work, '--out', out, '--copy-bundles', copies], { stdout: (chunk) => void (text += chunk), stderr: () => undefined, cwd: good.root });
    expect(code).toBe(1);
    expect(text).toContain('Copied 2 bundles to');
    expect(text).toContain('perfect 1, awaiting-confirmation 1, draft 0');
    expect(await readdir(join(copies, 'perfect'))).toEqual(['good.mcbundle']);
    expect(await readdir(join(copies, 'awaiting-confirmation'))).toEqual(['wait.mcbundle']);
    // Nothing is copied into a work folder or the work root, and the report is where --out says.
    expect((await readdir(good.work)).sort()).toEqual(['good', 'wait']);
    expect((await readdir(out)).sort()).toEqual(['DELIVERY.json', 'DELIVERY.md']);
  });
});
