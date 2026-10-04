import { readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditedBook } from './audited.js';
import { isPng, type Result } from './helpers.js';

interface Finding {
  source: string;
  code: string;
  severity: string;
  ref: string;
  page: number | null;
  message: string;
  evidence: string;
}
interface Gate {
  format: string;
  version: number;
  passed: boolean;
  perfect: boolean;
  unconfirmed: number;
  project: { name: string; frames: string; outline: string; hash: string };
  counts: { exercises: number; sections: number; solutions: number; open: number; acknowledged: number };
  checks: { validate: { errors: number }; verify: { errors: number; warnings: number }; reference: { differences: number } | null; sheets: { sheets: number; seen: number; missing: number[]; current: boolean } | null };
  open: Finding[];
  acknowledged: { finding: Finding; acknowledgement: { code: string; ref: string; reason: string; by: string } }[];
  staleAcknowledgements: { acknowledgement: { code: string; ref: string }; why: string }[];
  unusedAcknowledgements: { code: string; ref: string }[];
  itemPatterns: string[];
  certificate: string;
}
const gateOf = (done: Result): Gate => done.json.result as unknown as Gate;
const SECTIONS = [
  { label: '0.1', title: 'Whole Numbers', exercise_count: 70 },
  { label: '0.2', title: 'Word Problems', exercise_count: 14 },
  { label: '1.1', title: 'Points and Lines', exercise_count: 12 },
  { label: '1.2', title: 'Triangles and Ratios', exercise_count: 16 },
];

interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
const { default: Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js') as { default: new (options: object) => { compile(schema: object): Validator } };

describe('audit gate', () => {
  it('passes on a book that the proposals audited and nothing else touched, and writes the certificate', async () => {
    const cli = await auditedBook();
    const done = await cli(['audit', 'gate']);
    expect(done.code).toBe(0);
    const gate = gateOf(done);
    expect(gate).toMatchObject({ format: 'math-canvas-audit-gate', version: 1, passed: true, counts: { exercises: 112, sections: 4, solutions: 112, open: 0, acknowledged: 0 }, open: [] });
    expect(gate.project.hash).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(await readFile(join(cli.dir, 'book.audit-gate.json'), 'utf8')) as Gate;
    expect(written.passed).toBe(true);
    expect(written.project).toEqual(gate.project);
    const exported = await cli(['export', '--out', 'book.mcbundle']);
    expect(exported.code).toBe(0);
    expect((exported.json.result as unknown as { gate: { status: string } }).gate.status).toBe('passed');
    const status = await cli(['audit', 'gate', '--status']);
    expect(status.code).toBe(0);
    expect(status.json.result).toMatchObject({ status: 'passed' });
    const schema = JSON.parse(readFileSync(new URL('../../../schemas/gate.schema.json', import.meta.url), 'utf8')) as object;
    const valid = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
    expect(valid(written), JSON.stringify(valid.errors)).toBe(true);
  });

  it('keeps a letter outside ASCII in a pattern intact: an escape in the certificate, read from a file or the notes, refused when mangled', async () => {
    const cli = await auditedBook();
    const pattern = '^L(?:ö|oe)sung\\s+(\\d+)';
    const escaped = '^L(?:\\u00f6|oe)sung\\s+(\\d+)';
    const done = await cli(['audit', 'gate', '--item-pattern', pattern]);
    expect(done.code).toBe(0);
    expect(gateOf(done).itemPatterns).toEqual([escaped]);
    // Nothing in the certificate is outside ASCII, so no program that shows or copies it can mangle the pattern.
    expect([...(await readFile(join(cli.dir, 'book.audit-gate.json')))].every((byte) => byte < 0x80)).toBe(true);
    // The same pattern from a UTF-8 file with a byte order mark, and from the notes file.
    await writeFile(join(cli.dir, 'patterns.txt'), `${String.fromCharCode(0xfeff)}${pattern}\r\n\r\n`);
    expect(gateOf(await cli(['audit', 'gate', '--item-pattern-file', 'patterns.txt'])).itemPatterns).toEqual([escaped]);
    await writeFile(join(cli.dir, 'book.audit-notes.json'), JSON.stringify({ format: 'math-canvas-audit-notes', version: 1, itemPatterns: [escaped], acknowledgements: [] }));
    expect(gateOf(await cli(['audit', 'gate'])).itemPatterns).toEqual([escaped]);
    // A pattern whose letter did not arrive (U+FFFD, or UTF-8 read as Latin-1) is refused, with what to do instead.
    for (const letters of [String.fromCharCode(0xfffd), `${String.fromCharCode(0xc3)}${String.fromCharCode(0xb6)}`]) {
      const mangled = await cli(['audit', 'gate', '--item-pattern', `^L(?:${letters}|oe)sung\\s+(\\d+)`]);
      expect(mangled.code).toBe(2);
      expect(mangled.json.error?.hint).toContain('--item-pattern-file');
    }
    expect((await cli(['audit', 'gate', '--item-pattern-file', 'missing.txt'])).code).toBe(3);
  });

  it('does not pass when something is open, says what, and exits with code 4; a change makes the certificate stale', async () => {
    const cli = await auditedBook();
    expect((await cli(['audit', 'gate'])).code).toBe(0);
    // An exercise that was missed: its line is left behind.
    expect((await cli(['frames', 'delete', '0.1:12'])).code).toBe(0);
    const status = await cli(['audit', 'gate', '--status']);
    expect(status.code).toBe(4);
    expect(status.json.result).toMatchObject({ status: 'stale' });
    const done = await cli(['audit', 'gate']);
    expect(done.code).toBe(4);
    const gate = gateOf(done);
    expect(gate.passed).toBe(false);
    expect(gate.open.map((finding) => `${finding.code} ${finding.ref}`)).toContain('numbered-text-left-behind 0.1:12');
    expect(gate.open.length).toBeGreaterThanOrEqual(2);
    const text = await cli(['audit', 'gate'], { json: false });
    expect(text.stdout).toContain('Gate NOT passed');
    expect(text.stdout).toContain('numbered-text-left-behind');
    expect((await cli(['audit', 'gate', '--status'])).json.result).toMatchObject({ status: 'failed' });
  });

  it('applies an acknowledgement for what the book prints, lists it with its reason, and drops it when its findings change', async () => {
    const cli = await auditedBook();
    const wrong = SECTIONS.map((section) => (section.label === '0.1' ? { ...section, exercise_count: 68 } : section));
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections: wrong }));
    const failing = await cli(['audit', 'gate', '--reference', 'reference.json']);
    expect(failing.code).toBe(4);
    expect(gateOf(failing).open.map((finding) => `${finding.code} ${finding.ref}`)).toEqual(['reference-count 0.1']);
    const ack = await cli(['audit', 'ack', '--code', 'reference-count', '--ref', '0.1', '--count', '1', '--page', '5', '--quote', 'Evaluate each expression', '--reason', 'The practice set of 0.1 prints 70 exercises; the reference lists 68 (checked on pages 5 and 6).', '--reference', 'reference.json', '--by', 'tester']);
    expect(ack.code).toBe(0);
    expect(ack.json.result).toMatchObject({ covers: 1, replaced: false, acknowledgement: { confirmed: false } });
    const passed = await cli(['audit', 'gate', '--reference', 'reference.json']);
    expect(passed.code).toBe(0);
    const gate = gateOf(passed);
    // The gate passes, and says that nobody but the one who wrote the note has looked at it.
    expect(gate).toMatchObject({ passed: true, unconfirmed: 1, counts: { acknowledged: 1, open: 0 } });
    expect((await cli(['audit', 'confirm', '--by', 'tester', '--all'])).code).toBe(2);
    expect((await cli(['audit', 'confirm', '--by', 'reviewer', '--ref', '0.1', '--code', 'reference-count'])).code).toBe(0);
    expect(gateOf(await cli(['audit', 'gate', '--reference', 'reference.json']))).toMatchObject({ passed: true, unconfirmed: 0 });
    expect(gate.acknowledged[0]).toMatchObject({ finding: { code: 'reference-count', ref: '0.1' }, acknowledgement: { by: 'tester' } });
    expect(gate.acknowledged[0]?.acknowledgement.reason).toContain('prints 70 exercises');
    // The reference is repaired: the note is for a finding that is gone.
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections: SECTIONS }));
    const later = gateOf(await cli(['audit', 'gate', '--reference', 'reference.json']));
    expect(later.passed).toBe(true);
    expect(later.unusedAcknowledgements).toMatchObject([{ code: 'reference-count', ref: '0.1' }]);
    // The note covers the one finding it was made for, not the new ones.
    await writeFile(join(cli.dir, 'reference.json'), JSON.stringify({ sections: SECTIONS.map((section) => (section.label === '0.1' ? { ...section, exercise_count: 68 } : { ...section, exercise_count: section.exercise_count + 1 })) }));
    const more = await cli(['audit', 'gate', '--reference', 'reference.json']);
    expect(more.code).toBe(4);
    expect(gateOf(more).open.map((finding) => finding.ref)).toEqual(['0.2', '1.1', '1.2']);
    expect(gateOf(more).counts.acknowledged).toBe(1);
  });

  it('refuses what is not allowed, and every refusal says what is wrong and what to give instead', async () => {
    const cli = await auditedBook();
    const reason = 'The book prints it so, on the page named.';
    const ack = (...args: string[]): Promise<Result> => cli(['audit', 'ack', ...args]);
    const said = (done: Result): string => `${done.json.error?.message ?? ''} ${done.json.error?.hint ?? ''}`;
    const blanket = await ack('--code', 'duplicate', '--ref', '*', '--reason', reason);
    expect(blanket.code).toBe(2);
    expect(said(blanket)).toContain('wildcard');
    const unknown = await ack('--code', 'everything', '--ref', '0.1', '--reason', reason);
    expect(unknown.code).toBe(2);
    expect(said(unknown)).toContain('is not the code of a finding that can be acknowledged');
    expect(said(unknown)).toContain('duplicate');
    const short = await ack('--code', 'duplicate', '--ref', '0.1:3', '--reason', 'no');
    expect(short.code).toBe(2);
    expect(said(short)).toContain('has 2 characters');
    expect(said(short)).toContain('at least 10');
    const lacking = await ack('--code', 'duplicate');
    expect(lacking.code).toBe(2);
    expect(said(lacking)).toContain('--ref, --reason are missing');
    const missing = await ack('--code', 'duplicate', '--ref', '0.1:3', '--page', '5', '--reason', reason);
    expect(missing.code).toBe(2);
    expect(said(missing)).toContain('There is no finding duplicate for 0.1:3 now');
    expect(said(missing)).toContain('mcprep audit gate');
    const bare = await ack('--code', 'gap', '--ref', '0.1', '--reason', reason);
    expect(bare.code).toBe(2);
    expect(said(bare)).toContain('is a section: say how many findings the note covers with --count N');
    const validate = await ack('--code', 'validate', '--ref', '0.1:3', '--reason', reason);
    expect(validate.code).toBe(2);
    await cli(['frames', 'delete', '0.1:12']);
    const section = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1', '--reason', reason);
    expect(section.code).toBe(2);
    expect(said(section)).toContain('how many findings');
    const noPage = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--reason', reason);
    expect(noPage.code).toBe(2);
    expect(said(noPage)).toContain('--page is missing');
    expect(said(noPage)).toContain('page 5');
    const wrongPage = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '9', '--reason', reason);
    expect(wrongPage.code).toBe(2);
    expect(said(wrongPage)).toContain('is not on page 9');
    const noQuote = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--reason', reason);
    expect(noQuote.code).toBe(2);
    expect(said(noQuote)).toContain('--quote is missing');
    expect(said(noQuote)).toContain('mcprep lines 5');
    // The quote must be on the page: a piece of the finding's own message is not.
    const fromMessage = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', 'starts like exercise 12', '--reason', reason);
    expect(fromMessage.code).toBe(2);
    expect(said(fromMessage)).toContain('is not in the text of page 5');
    const tooShort = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', 'ab', '--reason', reason);
    expect(tooShort.code).toBe(2);
    expect(said(tooShort)).toContain('4 to 60 characters');
    // The reason must not be the text of the finding.
    const finding = gateOf(await cli(['audit', 'gate'])).open.find((entry) => entry.code === 'numbered-text-left-behind' && entry.ref === '0.1:12') as Finding;
    const repeated = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', 'Evaluate each expression', '--reason', finding.message);
    expect(repeated.code).toBe(2);
    expect(said(repeated)).toContain('The reason repeats the text of the finding');
    const wrongCount = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1', '--count', '5', '--page', '5', '--quote', 'Evaluate each expression', '--reason', reason);
    expect(wrongCount.code).toBe(2);
    expect(said(wrongCount)).toContain('Give --count 1');
    // The note that is right is added.
    const fine = await ack('--code', 'numbered-text-left-behind', '--ref', '0.1:12', '--page', '5', '--quote', 'Evaluate each expression', '--reason', reason);
    expect(fine.code).toBe(0);
  });

  it('turns a note for a section into a stale one when more findings match than it says', async () => {
    const cli = await auditedBook();
    const reason = 'The book prints these two lines between its exercises.';
    await cli(['frames', 'delete', '0.1:12']);
    await cli(['frames', 'delete', '0.1:13']);
    expect((await cli(['audit', 'ack', '--code', 'numbered-text-left-behind', '--ref', '0.1', '--count', '2', '--page', '5', '--quote', 'Evaluate each expression', '--reason', reason])).code).toBe(0);
    await cli(['frames', 'delete', '0.1:14']);
    const gate = gateOf(await cli(['audit', 'gate']));
    expect(gate.staleAcknowledgements).toHaveLength(1);
    expect(gate.staleAcknowledgements[0]?.why).toContain('3 match');
    expect(gate.open.filter((finding) => finding.code === 'numbered-text-left-behind')).toHaveLength(3);
  });

  it('asks that the contact sheets are current and were looked at, and that the bundle is current', async () => {
    const cli = await auditedBook();
    const made = await cli(['exercises', 'sheets', '--out', 'sheets', '--per-sheet', '56']);
    expect(made.code).toBe(0);
    const manifest = JSON.parse(await readFile(join(cli.dir, 'sheets', 'sheets.json'), 'utf8')) as { scope: string; exercises: number; heightCap: number; sheets: { number: number; refs: string[]; hash: string; height: number }[] };
    const count = manifest.sheets.length;
    const files = (await readdir(join(cli.dir, 'sheets'))).sort();
    expect(files).toEqual([...manifest.sheets.map((sheet) => `sheet-${String(sheet.number).padStart(4, '0')}.png`), 'sheets.json']);
    expect(isPng(await readFile(join(cli.dir, 'sheets', 'sheet-0001.png')))).toBe(true);
    expect(manifest).toMatchObject({ scope: 'all', exercises: 112, heightCap: 2600 });
    // perSheet is the most cells; the height cap closes a sheet earlier.
    expect(count).toBeGreaterThanOrEqual(2);
    expect(manifest.sheets.every((sheet) => sheet.refs.length <= 56 && sheet.height <= 2600)).toBe(true);
    expect(manifest.sheets.flatMap((sheet) => sheet.refs)).toHaveLength(112);
    expect(manifest.sheets[0]?.refs[0]).toBe('0.1:1');
    await writeFile(join(cli.dir, 'sheets', 'seen.txt'), '1');
    const unseen = await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt']);
    expect(unseen.code).toBe(4);
    expect(gateOf(unseen).open.map((finding) => finding.code)).toEqual(['sheets-unseen']);
    expect(gateOf(unseen).checks.sheets).toMatchObject({ sheets: count, seen: 1, missing: Array.from({ length: count - 1 }, (_unused, k) => k + 2), current: true });
    await writeFile(join(cli.dir, 'sheets', 'seen.txt'), `1-${count}`);
    expect((await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt'])).code).toBe(0);
    // A repair that moves an exercise makes the sheet that shows it stale.
    const frame = (await cli(['exercises', 'list', '--section', '0.2'])).json.result as unknown as { exercises?: { id: string; rect: { left: number; top: number; right: number; bottom: number } }[]; frames?: { id: string; rect: { left: number; top: number; right: number; bottom: number } }[] };
    const first = (frame.exercises ?? frame.frames ?? [])[0];
    expect(first).toBeDefined();
    await cli(['frames', 'update', (first as { id: string }).id, '--rect', `${(first as { rect: { left: number } }).rect.left},${(first as { rect: { top: number } }).rect.top},${(first as { rect: { right: number } }).rect.right + 0.01},${(first as { rect: { bottom: number } }).rect.bottom}`]);
    const stale = gateOf(await cli(['audit', 'gate', '--sheets-seen', 'sheets/seen.txt']));
    expect(stale.open.map((finding) => finding.code)).toContain('sheets-stale');
    // Partial sheets do not count as the exhaustive pass.
    await cli(['exercises', 'sheets', '--out', 'partial', '--section', '1.2']);
    await writeFile(join(cli.dir, 'partial', 'seen.txt'), '1');
    expect(gateOf(await cli(['audit', 'gate', '--sheets-seen', 'partial/seen.txt'])).open.map((finding) => finding.code)).toContain('sheets-partial');
  });
});
