import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { numberFrames } from '../src/model/numbering.js';
import { PdfDocument } from '../src/pdf/document.js';
import { applyOperations } from '../src/project/ops.js';
import { newProject } from '../src/project/model.js';
import { validateProject } from '../src/project/validate.js';
import { deriveOutline, numbersNamedIn, proposalSetToOperations, proposeFrames } from '../src/propose/index.js';
import type { PageText } from '../src/model/types.js';
import { buildPdf, paragraph, type PdfText } from '../src/testing/pdf-writer.js';
import { buildSampleSheet } from '../src/testing/sample.js';

describe('proposals on the synthetic sample', () => {
  let doc: PdfDocument;
  let pages: PageText[];
  beforeAll(async () => {
    doc = await PdfDocument.fromBytes(buildSampleSheet().pdf);
    pages = await doc.allPageText({ fonts: true, ink: true });
  });
  afterAll(async () => {
    await doc.close();
  });

  it('finds the five exercises and the two blocks worth a bookmark, in reading order', () => {
    const set = proposeFrames(pages);
    expect(set.proposals.map((proposal) => `${proposal.kind}:${proposal.title.split(' ').slice(0, 2).join(' ')}`)).toEqual([
      'exercise:Exercise 1.',
      'exercise:Exercise 2.',
      'exercise:Exercise 3.',
      'exercise:Exercise 4.',
      'bookmark:Definition 5.1',
      'exercise:Exercise 5.',
      'bookmark:Remark. The',
    ]);
    expect(set.proposals.map((proposal) => proposal.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(set.proposals.filter((proposal) => proposal.kind === 'exercise').map((proposal) => proposal.number)).toEqual(['1', '2', '3', '4', '5']);
    for (const proposal of set.proposals.filter((entry) => entry.kind === 'exercise')) {
      expect(proposal.confidence).toBeGreaterThanOrEqual(0.8);
      expect(proposal.evidence.length).toBeGreaterThan(1);
    }
  });

  it('starts a frame just above its first line and leaves the running header and footer out', () => {
    const set = proposeFrames(pages);
    const first = set.proposals[0];
    const line = pages[0]?.lines.find((entry) => entry.text.startsWith('Exercise 1.'));
    expect(first?.rect.top).toBeCloseTo((line?.rect.top ?? 0) - 0.006, 4);
    for (const proposal of set.proposals) {
      expect(proposal.rect.top).toBeGreaterThan(0.06);
      expect(proposal.rect.bottom).toBeLessThan(0.93);
    }
  });

  it('ends an exercise where the text ends (blank answer space is left out) and reaches over a figure', () => {
    const set = proposeFrames(pages);
    const one = set.proposals[0];
    const three = set.proposals[2];
    const five = set.proposals[5];
    const lastLineOfOne = pages[0]?.lines.find((entry) => entry.text.startsWith('it at x = 2.'));
    expect(one?.rect.bottom).toBeCloseTo((lastLineOfOne?.rect.bottom ?? 0) + 0.004, 3);
    expect(three && three.rect.bottom - three.rect.top).toBeLessThan(0.06);
    // The figure box of the sample spans 360..470 pt = 0.4276..0.5582 of the page.
    expect(five?.rect.bottom).toBeGreaterThan(0.55);
    expect(five?.rect.bottom).toBeLessThan(0.6);
    const withoutInk = proposeFrames(pages.map((page) => ({ ...page, ink: undefined })));
    // Without the ink profile only the text is known: the frame ends after the figure's label, inside the figure.
    expect(withoutInk.proposals[5]?.rect.bottom).toBeLessThan(0.51);
  });

  it('finds the parts (a) (b) (c) of exercise 2, with the shared statement as a candidate for context', () => {
    const two = proposeFrames(pages).proposals[1];
    expect(two?.parts?.style).toBe('letter');
    expect(two?.parts?.markers.map((marker) => marker.ordinal)).toEqual([1, 2, 3]);
    expect(two?.parts?.dividers).toHaveLength(2);
    const lineB = pages[0]?.lines.find((entry) => entry.text.startsWith('(b)'));
    expect(two?.parts?.dividers[0]).toBeCloseTo((lineB?.rect.top ?? 0) - 0.006, 4);
    expect(two?.parts?.first).toBeDefined();
    expect(two?.parts?.preamble?.bottom).toBe(two?.parts?.first);
    expect(two?.parts?.preamble?.top).toBe(two?.rect.top);
  });

  it('follows an exercise onto the next page and does not run on into other blocks', () => {
    const set = proposeFrames(pages);
    const four = set.proposals[3];
    expect(four?.continues).toHaveLength(1);
    expect(four?.continues?.[0]?.page).toBe(2);
    const rest = pages[2]?.lines.find((entry) => entry.text.startsWith('(a, b)'));
    expect(four?.continues?.[0]?.rect.top).toBeCloseTo((rest?.rect.top ?? 0) - 0.006, 4);
    expect(four?.parts).toBeUndefined();
    // Exercise 2 ends before the instruction at the top of the next page: no continuation.
    expect(set.proposals[1]?.continues).toBeUndefined();
  });

  it('recognises the instruction printed for exercises 3 and 4 as their context', () => {
    const set = proposeFrames(pages);
    expect(set.contexts).toHaveLength(1);
    expect(set.contexts[0]).toMatchObject({ id: 'c1', page: 1, numbers: ['3', '4'], appliesTo: ['p3', 'p4'] });
    expect(set.contexts[0]?.text).toContain('Instructions for Exercises 3 and 4');
  });

  it('turns proposals into operations that make a valid project', () => {
    const set = proposeFrames(pages);
    const ops = proposalSetToOperations(set);
    expect(ops.map((op) => op.op)).toEqual(['add', 'add', 'split', 'add', 'add', 'add', 'add', 'split', 'add', 'context.add', 'context.add']);
    const project = newProject({ pdf: { path: 'x.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: 3 }, title: 'Sample' });
    const result = applyOperations(project, ops, { pageCount: 3 });
    const validation = validateProject(result.project);
    expect(validation.errors).toEqual([]);
    const labels = [...numberFrames(result.project.frames).values()].map((entry) => entry.label).sort();
    expect(labels).toEqual(['B1', 'B2', 'E1', 'E2.1', 'E2.2', 'E2.3', 'E3', 'E4', 'E5.1', 'E5.2']);
    // The statements above (a) became context of exercises 2 and 5; the instruction is context of 3 and 4.
    const withContext = result.project.frames.filter((frame) => (frame.context?.length ?? 0) > 0);
    expect(withContext).toHaveLength(4);
    const parts = result.project.frames.filter((frame) => frame.unit !== undefined);
    expect(parts).toHaveLength(5);
  });

  it('can keep the statement inside the first part, as the app does', () => {
    const set = proposeFrames(pages);
    const ops = proposalSetToOperations(set, { parts: 'keep', contexts: false });
    const split = ops.find((op) => op.op === 'split');
    expect(split).toMatchObject({ op: 'split' });
    expect((split as { first?: number }).first).toBeUndefined();
    expect(proposalSetToOperations(set, { parts: 'none' }).some((op) => op.op === 'split')).toBe(false);
    const only = proposalSetToOperations(set, { only: ['p1'], contexts: true });
    expect(only).toHaveLength(1);
  });

  it('lists lower-confidence lines separately and honours the threshold', () => {
    expect(proposeFrames(pages, { minConfidence: 0.99 }).proposals.length).toBeLessThan(7);
    expect(proposeFrames(pages, { bookmarks: false }).proposals.every((proposal) => proposal.kind === 'exercise')).toBe(true);
    expect(proposeFrames(pages, { pages: [0] }).proposals).toHaveLength(2);
  });

  it('derives only the title as a heading in this sample', () => {
    const outline = deriveOutline(pages);
    expect(outline.entries.map((entry) => entry.title)).toEqual(['Calculus Sheet 1']);
  });
});

describe('other layouts', () => {
  const open = (bytes: Uint8Array): Promise<PdfDocument> => PdfDocument.fromBytes(bytes);

  it('says there is nothing to propose on a scan', async () => {
    const doc = await open(buildPdf({ pages: [{ scan: { bars: [{ left: 0.1, top: 0.2, right: 0.9, bottom: 0.25 }] } }] }));
    const set = proposeFrames(await doc.allPageText());
    expect(set.proposals).toEqual([]);
    expect(set.notes[0]).toContain('text layer');
    await doc.close();
  });

  it('reads German exercise words and umlauts', async () => {
    const texts: PdfText[] = [];
    texts.push(...paragraph({ x: 72, y: 100, lines: ['Aufgabe 1. Berechne die Ableitung.'] }).texts);
    texts.push(...paragraph({ x: 72, y: 200, lines: ['Aufgabe 2. Zeige, dass die Funktion stetig ist.'] }).texts);
    texts.push(...paragraph({ x: 72, y: 300, lines: ['Übung 3. Bestimme alle Nullstellen.'] }).texts);
    const doc = await open(buildPdf({ pages: [{ texts }] }));
    const set = proposeFrames(await doc.allPageText());
    expect(set.proposals.map((proposal) => proposal.number)).toEqual(['1', '2', '3']);
    await doc.close();
  });

  it('proposes numbered items "1." "2." "3." with a lower confidence that still passes', async () => {
    const texts: PdfText[] = [];
    texts.push({ text: 'Problems', x: 72, y: 80, size: 14, font: 'Helvetica-Bold' });
    for (let n = 1; n <= 4; n += 1) texts.push(...paragraph({ x: 72, y: 120 + n * 90, lines: [`${n}. Show that the sequence converges.`, 'Use the definition of convergence.'] }).texts);
    const doc = await open(buildPdf({ pages: [{ texts }] }));
    const set = proposeFrames(await doc.allPageText());
    expect(set.proposals).toHaveLength(4);
    expect(set.proposals.every((proposal) => proposal.confidence >= 0.5 && proposal.confidence < 0.9)).toBe(true);
    await doc.close();
  });

  it('does not take an isolated numbered line in running text for an exercise', async () => {
    const texts: PdfText[] = [];
    for (let row = 0; row < 8; row += 1) texts.push({ text: row === 4 ? '7. See the discussion in the appendix for details.' : `Plain paragraph text line ${row}.`, x: row === 4 ? 100 : 72, y: 100 + row * 16, size: 11 });
    for (let n = 1; n <= 3; n += 1) texts.push({ text: `${n}. A real numbered item with enough words.`, x: 72, y: 300 + n * 40 });
    const doc = await open(buildPdf({ pages: [{ texts }] }));
    const set = proposeFrames(await doc.allPageText());
    expect(set.proposals.map((proposal) => proposal.number)).toEqual(['1', '2', '3']);
    await doc.close();
  });

  it('keeps tables of contents with dot leaders out of the proposals', async () => {
    const texts: PdfText[] = [
      { text: '1. Sets and maps ........................ 5', x: 72, y: 100 },
      { text: '2. Sequences ............................ 11', x: 72, y: 120 },
      { text: '3. Series ............................... 17', x: 72, y: 140 },
    ];
    const doc = await open(buildPdf({ pages: [{ texts }] }));
    expect(proposeFrames(await doc.allPageText()).proposals).toEqual([]);
    await doc.close();
  });

  it('derives a table of contents from large and numbered headings', async () => {
    const pagesSpec = [0, 1].map((p) => {
      const texts: PdfText[] = [];
      texts.push({ text: `${p + 1} ${p === 0 ? 'Sets and maps' : 'Sequences'}`, x: 72, y: 90, size: 18, font: 'Helvetica-Bold' });
      texts.push(...paragraph({ x: 72, y: 125, lines: ['Some introductory text of the chapter that goes on for a while,', 'with a second line of ordinary text.'] }).texts);
      texts.push({ text: `${p + 1}.1 ${p === 0 ? 'Sets' : 'Convergence'}`, x: 72, y: 200, size: 13, font: 'Helvetica-Bold' });
      texts.push(...paragraph({ x: 72, y: 225, lines: ['More ordinary text under the section heading, long enough to be a', 'paragraph of its own.'] }).texts);
      texts.push({ text: `${p + 1}.2 ${p === 0 ? 'Maps' : 'Limits'}`, x: 72, y: 320, size: 13, font: 'Helvetica-Bold' });
      texts.push(...paragraph({ x: 72, y: 345, lines: ['Text of the second section, again a normal paragraph.'] }).texts);
      return { texts };
    });
    const doc = await open(buildPdf({ pages: pagesSpec }));
    const outline = deriveOutline(await doc.allPageText({ fonts: true }));
    expect(outline.entries.map((entry) => [entry.title, entry.page, entry.depth])).toEqual([
      ['1 Sets and maps', 0, 0],
      ['1.1 Sets', 0, 1],
      ['1.2 Maps', 0, 1],
      ['2 Sequences', 1, 0],
      ['2.1 Convergence', 1, 1],
      ['2.2 Limits', 1, 1],
    ]);
    expect(outline.entries.every((entry) => entry.evidence.length > 0 && entry.confidence >= 0.55)).toBe(true);
    await doc.close();
  });

  it('gives no headings for a scan', () => {
    const none = deriveOutline([{ page: 0, size: { width: 595, height: 842, rotation: 0 }, lines: [], columns: 1, hasText: false }]);
    expect(none.entries).toEqual([]);
    expect(none.notes[0]).toContain('text layer');
  });
});

describe('the instruction words', () => {
  it('reads the exercise numbers an instruction names', () => {
    expect(numbersNamedIn('Instructions for Exercises 3 and 4')).toEqual(['3', '4']);
    expect(numbersNamedIn('Aufgaben 2-5: Berechne')).toEqual(['2', '3', '4', '5']);
    expect(numbersNamedIn('Exercises 1, 2 and 7')).toEqual(['1', '2', '7']);
    expect(numbersNamedIn('Problems 4 to 6')).toEqual(['4', '5', '6']);
    expect(numbersNamedIn('Just text')).toEqual([]);
  });
});
