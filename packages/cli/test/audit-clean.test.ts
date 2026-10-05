import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf, type PdfText } from '@mcprep/core/testing';
import { run } from '../src/run.js';
import { tempDir, type Cli, type Result } from './helpers.js';

/**
 * A practice set with tight leading (a line every 13 points for a 12 point font, with descenders and ascenders in every line) and an
 * answer key set the same way: the regions cut from the boxes of the lines run through the descenders of the line above, and the audit
 * moves their edges to where they cut no ink (`exercises verify --ink` measures the same ink). Synthetic: every text is made up.
 */

const ITEMS = 14;

function tightBook(pitch: number): Uint8Array {
  const practice: PdfText[] = [{ text: '1.1 Practice - Title', x: 200, y: 98, size: 16.9, font: 'Helvetica-Bold' }];
  for (let k = 0; k < ITEMS; k += 1) practice.push({ text: `${k + 1}) gypqj gypqj Qfgy (gypqj) jgqpy yq`, x: 85, y: 150 + k * pitch, size: 12 });
  const key: PdfText[] = [{ text: 'Answers - Chapter 1', x: 200, y: 98, size: 16.9, font: 'Helvetica-Bold' }, { text: 'Section 1.1 (p. 1)', x: 85, y: 130, size: 12, font: 'Helvetica-Bold' }];
  for (let k = 0; k < ITEMS; k += 1) key.push({ text: `${k + 1}) jgqpy yq (gyp)`, x: 85, y: 160 + k * pitch, size: 12 });
  const filler: PdfText[] = [{ text: 'A page of the book.', x: 100, y: 100 }];
  return buildPdf({ pages: [{ texts: practice }, { texts: filler }, { texts: key }] });
}

async function workspace(pitch: number): Promise<Cli> {
  const dir = await tempDir();
  await writeFile(join(dir, 'tight.pdf'), tightBook(pitch));
  const cli = (async (args, opts = {}) => {
    let out = '';
    let err = '';
    const withJson = opts.json === false ? args : [...args, '--json'];
    const code = await run(withJson, {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      stdin: () => Promise.resolve(opts.stdin ?? ''),
      cwd: dir,
      env: { ...opts.env },
    });
    let json: Result['json'] = { ok: false, command: '', result: {} };
    if (opts.json !== false && out.trim().startsWith('{')) json = JSON.parse(out) as Result['json'];
    return { code, stdout: out, stderr: err, json };
  }) as Cli;
  Object.defineProperty(cli, 'dir', { value: dir });
  const made = await cli(['init', 'tight.pdf', '--title', 'Tight Leading']);
  if (made.code !== 0) throw new Error(`init failed: ${made.stdout}${made.stderr}`);
  const derived = await cli(['outline', 'derive', '--book', '--apply']);
  if (derived.code !== 0) throw new Error(`outline derive failed: ${derived.stdout}${derived.stderr}`);
  return cli;
}

interface Proposed {
  proposals: { label: string; rect: { top: number; bottom: number; left: number; right: number }; solution?: unknown }[];
  counts: { exercises: number; withSolution: number; unchanged: number; added: number };
  edges?: { moved: number; regions: number };
  notes: string[];
  applied: boolean;
}

interface Verified {
  summary: { errors: number; warnings: number };
  findings: { code: string; ref: string }[];
}

const verified = async (cli: Cli): Promise<Verified> => (await cli(['exercises', 'verify', '--ink'])).json.result as unknown as Verified;

/** The findings of the pixel check: an edge that cuts ink (a warning) or one that only tips of ink go across (information). */
const PIXEL_CODES = ['edge-on-ink', 'edge-interlocked'];

const edgesOnInk = async (cli: Cli): Promise<number> => (await verified(cli)).findings.filter((finding) => PIXEL_CODES.includes(finding.code)).length;

/** The findings of the text check: everything but the pixel check. */
const textFindings = async (cli: Cli): Promise<string[]> =>
  (await verified(cli)).findings
    .filter((finding) => !PIXEL_CODES.includes(finding.code))
    .map((finding) => `${finding.code} ${finding.ref}`)
    .sort();

describe('the edges of the regions of a book with tight leading', () => {
  it('moves the edges that cut ink out of it when the exercises and the answers are proposed, and says so', async () => {
    const cli = await workspace(13);
    const done = await cli(['exercises', 'propose', '--solutions']);
    expect(done.code).toBe(0);
    const result = done.json.result as unknown as Proposed;
    expect(result.counts.exercises).toBe(ITEMS);
    expect(result.counts.withSolution).toBe(ITEMS);
    // Every region but the first has its top in the descenders of the line above: about two edges of the exercises and of the answers each.
    expect(result.edges?.moved).toBeGreaterThanOrEqual(ITEMS);
    expect(result.edges?.regions).toBeGreaterThanOrEqual(ITEMS);
    expect(result.notes.join(' ')).toMatch(/moved out of printed ink/);
    const text = await cli(['exercises', 'propose', '--solutions'], { json: false });
    expect(text.stdout).toMatch(/edges? of \d+ regions? moved out of printed ink/);
  });

  it('leaves the regions as they are cut from the text layer with --keep-edges, and the pixel check then finds the edges that cut', async () => {
    const kept = await workspace(13);
    const done = await kept(['exercises', 'propose', '--solutions', '--keep-edges', '--apply']);
    expect(done.code).toBe(0);
    expect((done.json.result as unknown as Proposed).edges).toBeUndefined();
    const cut = await edgesOnInk(kept);
    expect(cut).toBeGreaterThanOrEqual(ITEMS - 1);
    const cleaned = await workspace(13);
    expect((await cleaned(['exercises', 'propose', '--solutions', '--apply'])).code).toBe(0);
    expect(await edgesOnInk(cleaned)).toBe(0);
    // Nothing else changes: the text check reports what it reported for the regions as cut from the text layer, and no error.
    expect((await verified(cleaned)).summary.errors).toBe(0);
    expect(await textFindings(cleaned)).toEqual(await textFindings(kept));
  });

  it('proposes the same regions when it is run again, so that applying twice stores nothing new, and cleans the answers of `solutions propose` alike', async () => {
    const cli = await workspace(13);
    expect((await cli(['exercises', 'propose', '--apply'])).code).toBe(0);
    const again = await cli(['exercises', 'propose', '--apply']);
    const result = again.json.result as unknown as Proposed;
    expect(result.counts.unchanged).toBe(ITEMS);
    expect(result.counts.added).toBe(0);
    const first = await cli(['solutions', 'propose', '--apply']);
    expect(first.code).toBe(0);
    expect((first.json.result as { edges?: { moved: number } }).edges?.moved).toBeGreaterThanOrEqual(ITEMS - 1);
    const second = await cli(['solutions', 'propose', '--apply']);
    expect((second.json.result as { counts: { unchanged: number; added: number } }).counts).toMatchObject({ unchanged: ITEMS, added: 0 });
    expect(await edgesOnInk(cli)).toBe(0);
  });

  it('moves nothing in a book whose lines stand clear of each other', async () => {
    const cli = await workspace(16);
    const done = await cli(['exercises', 'propose', '--solutions']);
    expect((done.json.result as unknown as Proposed).edges).toEqual({ moved: 0, regions: 0 });
    expect((done.json.result as unknown as Proposed).notes.join(' ')).not.toMatch(/moved out of printed ink/);
  });
});
