import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeExercises, type BookExercises, type ExerciseProposal } from '../src/audit/exercises.js';
import { findLabelledItems, labelledItemPatterns, proposeLabelledExercises } from '../src/audit/labelled.js';
import { deriveSections, deriveSectionsFromBookmarks, locateSections, type BookEntry, type BookStructure } from '../src/audit/sections.js';
import { numberBookmarks } from '../src/audit/bookmarks.js';
import { hasLeader } from '../src/audit/scan.js';
import { measureInk } from '../src/verify/ink-measure.js';
import { VERIFY_LIMITS } from '../src/verify/types.js';
import type { InkMap, PageText } from '../src/model/types.js';
import { PdfDocument } from '../src/pdf/document.js';
import type { Project } from '../src/project/model.js';
import { buildBooklet, type Booklet } from '../src/testing/booklet.js';
import { verifyProject } from '../src/verify/verify.js';
import { inkProfile, page, type Spec } from './audit-pages.js';

/**
 * An exercise booklet: each exercise starts with its word and its number ("Aufgabe 1.2 (Mengen). ...") at the top of a page of its
 * own, under a running head that holds the title of its chapter; the printed contents list a line for each chapter and each
 * exercise; the last page is an imprint. The synthetic booklet of `buildBooklet` goes through the real text extraction and the
 * whole audit, with the default words and options.
 */

describe('an exercise booklet that prints "Aufgabe 1.2 (Title)." at the top of a page', () => {
  let book: Booklet;
  let doc: PdfDocument;
  let pages: PageText[];
  let structure: BookStructure;
  let exercises: BookExercises;
  const proposals = (): ExerciseProposal[] => exercises.sections.flatMap((section) => section.proposals);
  const exercise = (label: string): ExerciseProposal => proposals().find((proposal) => proposal.label === label) as ExerciseProposal;

  beforeAll(async () => {
    book = buildBooklet();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true, ink: true, inkMap: true });
    structure = deriveSections(pages);
    exercises = proposeExercises(pages, structure.entries);
  });
  afterAll(async () => {
    await doc.close();
  });

  it('is a booklet whose chapter heads change with the chapter: only the head that stands on three pages is flagged by the reader', () => {
    const head = (index: number): boolean | undefined => pages[index]?.lines.find((line) => line.rect.top < 0.05 && line.text.length > 4)?.headerFooter;
    expect(head(4)).toBe(true);
    expect(head(7)).toBeUndefined();
    // The page number is flagged on every page that has one.
    expect(pages[7]?.lines.find((line) => line.text === '8')?.headerFooter).toBe(true);
  });

  it('reads the anchors but not the lines of the printed contents, which have the same words and numbers', () => {
    const hits = findLabelledItems(pages);
    expect(hits.map((hit) => `${hit.page}:${hit.label}`)).toEqual(book.exercises.map((entry) => `${entry.page}:${entry.label}`));
    expect(hits.every((hit) => hit.form === 'keyword-first')).toBe(true);
    const contents = book.contentsPages.flatMap((index) => pages[index]?.lines.filter((line) => /^Aufgabe/.test(line.text)) ?? []);
    expect(contents).toHaveLength(5);
    expect(contents.every((line) => hasLeader(line.text))).toBe(true);
  });

  it('takes the chapters of the printed contents for the sections, with the numbers they print, and lists no exercise as an entry of the book', () => {
    expect(structure.entries.map((entry) => [entry.kind, entry.id, entry.label, entry.page, entry.title])).toEqual([
      ['section', '1', '1', 4, 'Erste Schritte'],
      ['section', '2', '2', 7, 'Zweiter Teil'],
    ]);
    expect(structure.sections).toBe(2);
    expect(structure.notes.join(' ')).toContain('the 2 chapters are the sections');
    expect(structure.notes.join(' ')).toContain('5 exercises are printed inside the text of 2 sections');
    expect(structure.notes.join(' ')).not.toContain('no practice heading found');
  });

  it('does not take a running head and its page number for an entry of the contents (a head with a space leader looks like one)', () => {
    expect(structure.toc.pages).toEqual(book.contentsPages);
    expect(structure.toc.entries).toBe(7);
  });

  it('proposes each exercise under the chapter of its number, on its own page, without a continuation', () => {
    expect(proposals().map((proposal) => `${proposal.section}:${proposal.label}`)).toEqual(book.exercises.map((entry) => `${entry.section}:${entry.label}`));
    for (const truth of book.exercises) {
      expect(exercise(truth.label).page, truth.label).toBe(truth.page);
      expect(exercise(truth.label).continues, truth.label).toBeUndefined();
      expect(exercise(truth.label).title, truth.label).toContain(truth.words.slice(0, 8) === '' ? '' : `Aufgabe ${truth.label} (${truth.title})`);
    }
    expect(exercises.sections.map((section) => [section.section, section.first, section.last, section.proposals.length])).toEqual([
      ['1', '1.1', '1.3', 3],
      ['2', '2.1', '2.2', 2],
    ]);
  });

  it('starts each region at its label and ends it at the last ink of its page: a figure drawn under the text is inside, room to answer in is not', () => {
    for (const truth of book.exercises) {
      const found = exercise(truth.label);
      expect(found.rect.bottom, truth.label).toBeGreaterThanOrEqual(truth.lastInk - 0.001);
      expect(found.rect.bottom, truth.label).toBeLessThan(truth.lastInk + 0.012);
    }
    // The figure of 1.2 reaches far below its text.
    expect(exercise('1.2').rect.bottom).toBeGreaterThan(0.47);
    expect(exercise('1.1').rect.bottom).toBeLessThan(0.23);
    expect(exercise('1.1').evidence.join(' ')).toContain('ends at the last ink of its page');
  });

  it('keeps the running head, the page number and the heading of the chapter out of every region', () => {
    for (const found of proposals()) {
      for (const line of pages[found.page]?.lines ?? []) {
        const inside = line.rect.top >= found.rect.top - 1e-6 && line.rect.bottom <= found.rect.bottom + 1e-6;
        const furniture = line.headerFooter === true || line.rect.top < 0.05 || line.fontSize >= 15;
        if (furniture) expect(inside, `${found.label}: "${line.text}"`).toBe(false);
      }
    }
    // The first exercise of a chapter starts below the heading of the chapter.
    expect(exercise('1.1').rect.top).toBeGreaterThan(0.12);
    expect(exercise('2.1').rect.top).toBeGreaterThan(0.12);
  });

  it('spreads a region over the width of the text block: a figure or a field may be wider than the lines', () => {
    const left = Math.min(...proposals().map((found) => found.rect.left));
    const right = Math.max(...proposals().map((found) => found.rect.right));
    for (const found of proposals()) {
      expect(found.rect.left, found.label).toBeCloseTo(left, 3);
      expect(found.rect.right, found.label).toBeCloseTo(right, 3);
    }
  });

  it('holds the whole box that the template draws around the statement, border included, and no edge of a region runs through ink', async () => {
    const measured = await measureInk(
      doc,
      proposals().map((found) => ({ page: found.page, rect: found.rect })),
    );
    for (const found of proposals()) {
      const truth = book.exercises.find((entry) => entry.label === found.label) as Booklet['exercises'][number];
      // The box and its border (two points thick) are inside.
      expect(found.rect.left, found.label).toBeLessThan(book.boxSides.left - 0.002);
      expect(found.rect.right, found.label).toBeGreaterThan(book.boxSides.right + 0.002);
      expect(found.rect.top, found.label).toBeLessThan(truth.box.top - 0.002);
      expect(found.rect.bottom, found.label).toBeGreaterThan(truth.box.bottom + 0.002);
      // None of the four edges stands on ink, as the pixel check of exercises verify measures it.
      const edges = measured.lookup({ page: found.page, rect: found.rect });
      for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(edges?.[side] ?? 1, `${found.label} ${side}`).toBeLessThanOrEqual(VERIFY_LIMITS.inkEdgeShare);
    }
  });

  it('passes exercises verify without a finding but the information that no section has answers: no head, no imprint, no tall region is a finding', () => {
    const project = {
      format: 'mcprep.project',
      version: 1,
      pdf: { path: 'x.pdf', sha256: '0', bytes: 0, pageCount: pages.length },
      frames: proposals().map((proposal, index) => ({ id: `f${index + 1}`, kind: 'exercise', authority: 'book', page: proposal.page, rect: proposal.rect, section: proposal.section, label: proposal.label })),
      outline: { source: 'derived', entries: structure.entries.map((entry) => ({ title: entry.title, page: entry.page, depth: entry.depth, id: entry.id, label: entry.label, ...(entry.top !== undefined ? { top: entry.top } : {}) })) },
    } as unknown as Project;
    const report = verifyProject(project, (index) => pages[index]);
    expect(report.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(report.findings.map((finding) => finding.code)).toEqual(['no-solution', 'no-solution']);
    expect(report.sections.map((section) => [section.id, section.exercises, section.firstLabel, section.lastLabel])).toEqual([
      ['1', 3, '1.1', '1.3'],
      ['2', 2, '2.1', '2.2'],
    ]);
  });

  it('is found by default: the patterns of a text check read "Aufgabe 1.2" as the number of an exercise', () => {
    const [, wordFirst] = labelledItemPatterns() as [RegExp, RegExp, RegExp];
    for (const truth of book.exercises) {
      const line = pages[truth.page]?.lines.find((entry) => entry.text.startsWith(`Aufgabe ${truth.label}`));
      expect(wordFirst.exec(line?.text ?? '')?.[1], truth.label).toBe(truth.label);
    }
  });
});

describe('the same booklet with bookmarks', () => {
  let book: Booklet;
  let doc: PdfDocument;
  let pages: PageText[];
  beforeAll(async () => {
    book = buildBooklet({ bookmarks: true });
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true, ink: true });
  });
  afterAll(async () => {
    await doc.close();
  });

  it('numbers its chapters as printed ("1 Erste Schritte") and makes them the sections, the heading of each placed on its page', async () => {
    const bookmarks = (await doc.outline()) ?? [];
    expect(bookmarks.map((entry) => entry.title)).toEqual(['1 Erste Schritte', '2 Zweiter Teil']);
    const numbered = numberBookmarks(bookmarks, pages);
    expect(numbered?.flat).toBe(true);
    expect(numbered?.entries.map((entry) => [entry.id, entry.label, entry.title, entry.page, entry.depth])).toEqual([
      ['1', '1', 'Erste Schritte', 4, 0],
      ['2', '2', 'Zweiter Teil', 7, 0],
    ]);
    // The heading of the chapter stands under the running head, at about a tenth of the page.
    expect(numbered?.entries[0]?.top).toBeGreaterThan(0.09);
    expect(numbered?.entries[0]?.top).toBeLessThan(0.11);
    expect(numbered?.fit).toEqual({ found: 2, of: 2 });
  });

  it('derives sections that are sections, so that exercises can be proposed, and says why', async () => {
    const derived = deriveSectionsFromBookmarks(pages, (await doc.outline()) ?? []);
    expect(derived?.entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ['section', '1'],
      ['section', '2'],
    ]);
    expect(derived?.notes.join(' ')).toContain('one level of numbered chapters');
    const result = proposeExercises(pages, derived?.entries ?? []);
    expect(result.sections.flatMap((section) => section.proposals).map((entry) => entry.label)).toEqual(['1.1', '1.2', '1.3', '2.1', '2.2']);
  });

  it('reads a stored outline of such chapters the same way: depth 0, numbered, no deeper entry', async () => {
    const derived = deriveSectionsFromBookmarks(pages, (await doc.outline()) ?? []);
    const outline = (derived?.entries ?? []).map((entry) => ({ title: entry.title, page: entry.page, depth: entry.depth, id: entry.id, ...(entry.label !== undefined ? { label: entry.label } : {}), ...(entry.top !== undefined ? { top: entry.top } : {}) }));
    const located = locateSections(pages, outline);
    expect(located.entries.map((entry) => entry.kind)).toEqual(['section', 'section']);
    // Without exercises that name them, numbered entries of depth 0 are chapters, as they always were.
    const plain: PageText[] = pages.map((entry) => ({ ...entry, lines: entry.lines.filter((line) => !/^Aufgabe/.test(line.text)) }));
    expect(locateSections(plain, outline).entries.map((entry) => entry.kind)).toEqual(['chapter', 'chapter']);
  });

  it('numbers by counting when the titles print no numbers, and keeps the printed number when they do', async () => {
    const counted = numberBookmarks(
      [
        { title: 'Erste Schritte', page: 4, depth: 0 },
        { title: 'Zweiter Teil', page: 7, depth: 0 },
      ],
      pages,
    );
    expect(counted?.entries.map((entry) => [entry.id, entry.title])).toEqual([
      ['1', 'Erste Schritte'],
      ['2', 'Zweiter Teil'],
    ]);
    // Numbers that do not rise are no numbers: "2 Zweiter Teil" before "1 Erste Schritte" is counted, and fits no exercise order.
    const odd = numberBookmarks(
      [
        { title: '3 Erste Schritte', page: 4, depth: 0 },
        { title: '2 Zweiter Teil', page: 7, depth: 0 },
      ],
      pages,
    );
    expect(odd?.entries.map((entry) => entry.id)).toEqual(['1', '2']);
    // A single level of bookmarks that no printed exercise names is no outline of sections.
    expect(numberBookmarks([{ title: '1 A', page: 1, depth: 0 }, { title: '2 B', page: 2, depth: 0 }], pages.slice(0, 3))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pages built by hand: where an exercise goes on over a page break and where it does not

const section = (id: string, first: number): BookEntry => ({ title: `Chapter ${id}`, page: first, depth: 0, id, label: id, kind: 'section', confidence: 1, evidence: [], differences: [] });

const label = (n: string, top: number, text = 'Berechnen Sie den Wert des folgenden Ausdrucks und begründen Sie das Ergebnis.'): Spec => ({ text: `Aufgabe ${n} (Titel). ${text}`, left: 0.131, top });
const body = (top: number, text = 'Eine weitere Zeile der Aufgabe, die ganz normal weitergeht und lang genug ist.'): Spec => ({ text, left: 0.131, top });

/** An ink map of 400 x 600 pixels with dark rectangles (fractions of the page) on white. */
function inkMapOf(rects: { left: number; top: number; right: number; bottom: number }[]): InkMap {
  const width = 400;
  const height = 600;
  const stride = Math.ceil(width / 8);
  const bits = new Uint8Array(stride * height);
  for (const rect of rects) {
    for (let y = Math.floor(rect.top * height); y < Math.ceil(rect.bottom * height); y += 1) {
      for (let x = Math.floor(rect.left * width); x < Math.ceil(rect.right * width); x += 1) bits[y * stride + (x >> 3)] = (bits[y * stride + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return { width, height, bits };
}

describe('the sides of a region where there is ink', () => {
  // The label line is 80 characters: it ends at 0.131 + 80 * 0.0075 = 0.731, so the region's right edge is at 0.741 before it is moved.
  const statement = 'Berechnen Sie den Wert des Ausdrucks und begründen Sie ihn.';
  const book = (ink: InkMap): PageText[] => [{ ...page(0, [label('1.1', 0.105, statement), body(0.124, 'Zweite Zeile.')]), inkMap: ink }, page(1, [label('1.2', 0.105)]), page(2, [label('1.3', 0.105)])];
  const first = (pages: PageText[]): ExerciseProposal => proposeExercises(pages, [section('1', 0)]).sections[0]?.proposals[0] as ExerciseProposal;

  it('leave a rule that stands at one side (a vertical bar beside the exercise) outside: that edge moves into the white, the other side stays', () => {
    const bar = { left: 0.735, top: 0.09, right: 0.745, bottom: 0.3 };
    const plain = first(book(inkMapOf([])));
    const barred = first(book(inkMapOf([bar])));
    expect(plain.rect.right).toBeLessThan(0.745);
    expect(barred.rect.right).toBeGreaterThan(0.745);
    expect(barred.rect.right - 0.745).toBeLessThan(0.03);
    // A bar on one side is no box: the left edge stays where it was.
    expect(barred.rect.left).toBe(plain.rect.left);
  });

  it('hold the whole box drawn around the first line, borders included, up and down along the borders', () => {
    const frame = [
      { left: 0.11, top: 0.09, right: 0.115, bottom: 0.15 },
      { left: 0.745, top: 0.09, right: 0.75, bottom: 0.15 },
      { left: 0.11, top: 0.09, right: 0.75, bottom: 0.094 },
      { left: 0.11, top: 0.146, right: 0.75, bottom: 0.15 },
    ];
    const boxed = first(book(inkMapOf(frame)));
    expect(boxed.rect.left).toBeLessThan(0.11);
    expect(boxed.rect.right).toBeGreaterThan(0.75);
    expect(boxed.rect.top).toBeLessThan(0.09);
    expect(boxed.rect.bottom).toBeGreaterThan(0.15);
  });

  it('do not take two bars far above and below the line for a box: a box has a border on both sides of the line', () => {
    const bars = [{ left: 0.745, top: 0.02, right: 0.75, bottom: 0.04 }];
    const found = first(book(inkMapOf(bars)));
    expect(found.rect.top).toBeGreaterThan(0.1);
  });
});

describe('where an exercise that starts with its word ends', () => {
  const three = (specs: Spec[][]): PageText[] => specs.map((entry, index) => page(index, entry));

  it('at the last text of its page when the page is not filled, however the next page starts', () => {
    const pages = three([
      [label('1.1', 0.105), body(0.124), body(0.143)],
      [label('1.2', 0.105), body(0.124)],
      [label('1.3', 0.105), body(0.124)],
    ]);
    const result = proposeLabelledExercises(pages, [section('1', 0)]);
    const found = result.sections.get('1');
    expect(found?.proposals.map((entry) => [entry.label, entry.page, entry.continues])).toEqual([
      ['1.1', 0, undefined],
      ['1.2', 1, undefined],
      ['1.3', 2, undefined],
    ]);
    expect(found?.proposals[0]?.evidence.join(' ')).toContain('ends at the last ink of its page');
  });

  it('on the next page when its page is filled down to the bottom and the next page goes on with text', () => {
    const pages = three([
      [label('1.1', 0.105), body(0.124), body(0.143), body(0.84), body(0.859), body(0.878)],
      [body(0.105, 'und so geht die Aufgabe auf der nächsten Seite weiter, bis sie zu Ende ist.'), body(0.124, 'Hier steht der letzte Satz.')],
      [label('1.2', 0.105), body(0.124), label('1.3', 0.4)],
    ]);
    const found = proposeLabelledExercises(pages, [section('1', 0)]).sections.get('1');
    const first = found?.proposals[0];
    expect(first?.continues?.map((region) => region.page)).toEqual([1]);
    expect(first?.continues?.[0]?.rect.bottom).toBeLessThan(0.16);
    expect(found?.proposals[1]?.page).toBe(2);
    expect(found?.notes.join(' ')).toContain('1.1 (pages 0-1, 1 continuation region)');
  });

  it('above the next label of the same page, with a figure drawn between them inside the first region', () => {
    const ink = inkProfile([{ from: 0.2, to: 0.35 }]);
    const pages: PageText[] = [{ ...page(0, [label('1.1', 0.105), body(0.124), label('1.2', 0.5), body(0.519)]), ink }, page(1, [label('1.3', 0.105)]), page(2, [label('1.4', 0.105)])];
    const found = proposeLabelledExercises(pages, [section('1', 0)]).sections.get('1');
    const first = found?.proposals[0] as ExerciseProposal;
    // The figure (bands 40 to 70 of 200: 0.2 to 0.35) is inside, the label of 1.2 is not.
    expect(first.rect.bottom).toBeGreaterThan(0.35);
    expect(first.rect.bottom).toBeLessThan(0.5);
    expect(found?.proposals[1]?.rect.top).toBeGreaterThan(first.rect.bottom - 0.001);
    expect(first.evidence.join(' ')).toContain('ends above the next labelled exercise');
  });

  it('never at a sentence that merely names an exercise at the start of a line, nor at a line of a table of contents', () => {
    const pages = three([
      [label('1.1', 0.105), body(0.124), { text: 'Aufgabe 1.2 zeigt, dass der Weg über die Tabelle führt.', left: 0.131, top: 0.143 }, body(0.162)],
      [{ text: 'Aufgabe 1.3 (Tabellen)................................................................ 6', left: 0.131, top: 0.105 }, label('1.2', 0.2)],
      [label('1.3', 0.105)],
    ]);
    const hits = findLabelledItems(pages);
    expect(hits.map((hit) => hit.label)).toEqual(['1.1', '1.2', '1.3']);
    const found = proposeLabelledExercises(pages, [section('1', 0)]).sections.get('1');
    // The sentence is part of 1.1: its region holds the line under it too.
    expect(found?.proposals[0]?.rect.bottom).toBeGreaterThan(0.17);
  });

  it('never at the running head or the page number that stands at the top of the next page, when the exercise goes on there', () => {
    // The page number is flagged (it repeats on every page), the title of the chapter is not (it stands on two pages only).
    const flaggedNumber = (index: number): PageText => {
      const base = page(index, index === 1 ? [{ text: 'Zweiter Teil', left: 0.119, top: 0.04 }, body(0.105, 'und so geht die Aufgabe auf der nächsten Seite weiter, bis sie zu Ende ist.')] : []);
      return { ...base, lines: [...base.lines, { text: String(index + 1), rect: { left: 0.874, top: 0.039, right: 0.883, bottom: 0.051 }, fontSize: 10, column: 0, chars: 1, headerFooter: true }] };
    };
    const pages: PageText[] = [
      page(0, [label('1.1', 0.105), body(0.124), body(0.84), body(0.859), body(0.878)]),
      flaggedNumber(1),
      page(2, [label('1.2', 0.105), label('1.3', 0.3)]),
    ];
    const found = proposeExercises(pages, [section('1', 0)]).sections[0];
    const first = found?.proposals[0] as ExerciseProposal;
    expect(first.continues?.map((region) => region.page)).toEqual([1]);
    // The region of the rest starts at its first line (0.105), not at the head and the number (0.04).
    expect(first.continues?.[0]?.rect.top).toBeGreaterThan(0.09);
  });

  it('only when there are three of them: a single such line in a book is no layout', () => {
    const pages = three([[label('1.1', 0.105)], [body(0.105)], [body(0.105)]]);
    expect(proposeLabelledExercises(pages, [section('1', 0)]).active).toBe(false);
  });

  it('under the first section whose label starts the number, else the section the page lies in', () => {
    const pages = three([[label('1.1', 0.105)], [label('2.1', 0.105)], [label('2.2', 0.105)]]);
    const found = proposeLabelledExercises(pages, [section('1', 0), section('2', 1)]);
    expect([...found.sections.keys()]).toEqual(['1', '2']);
    expect(found.sections.get('2')?.proposals.map((entry) => entry.label)).toEqual(['2.1', '2.2']);
    expect(found.notes.join(' ')).toContain('3 exercises in 2 sections');
  });
});
