import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument } from '../src/pdf/document.js';
import type { PageText, TextLine } from '../src/model/types.js';
import { buildSyntheticBook, type BookAnchor, type SyntheticBook } from '../src/testing/book.js';

/** The text line that holds the anchor point (the line whose box contains it). */
function lineAt(pages: readonly PageText[], anchor: BookAnchor): TextLine | undefined {
  const page = pages[anchor.page];
  return page?.lines.find(
    (line) => anchor.x >= line.rect.left - 0.002 && anchor.x <= line.rect.right + 0.002 && anchor.y >= line.rect.top - 0.002 && anchor.y <= line.rect.bottom + 0.002,
  );
}

describe('the synthetic book', () => {
  let book: SyntheticBook;
  let doc: PdfDocument;
  let pages: PageText[];
  beforeAll(async () => {
    book = buildSyntheticBook();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true });
  });
  afterAll(async () => {
    await doc.close();
  });

  it('has the structure it promises', () => {
    expect(pages.length).toBe(book.pageCount);
    expect(book.truth.chapters.map((chapter) => chapter.label)).toEqual(['Chapter 0', 'Chapter 1']);
    expect(book.truth.sections.map((section) => section.id)).toEqual(['0.1', '0.2', '1.1', '1.2']);
    expect(book.truth.items.length).toBe(70 + 14 + 12 + 16);
    expect(book.truth.answers.length).toBe(book.truth.items.length);
    // Every practice set runs over more pages than one in at least two sections.
    const spans = book.truth.sections.map((section) => section.practiceLastPage - section.practiceFirstPage + 1);
    expect(spans.filter((span) => span >= 2).length).toBeGreaterThanOrEqual(2);
  });

  it('prints the printed page number in the footer, one more than the page index', () => {
    for (const index of [3, 8, 15]) {
      const footer = pages[index]?.lines.find((line) => line.headerFooter === true && line.rect.top > 0.9);
      expect(footer?.text).toBe(String(index + 1));
    }
  });

  it('prints every item where the truth says: the anchors lie on lines that carry the label', () => {
    for (const item of book.truth.items) {
      const first = lineAt(pages, item.anchors[0] as BookAnchor);
      expect(first, `${item.section} ${item.label}`).toBeDefined();
      expect(first?.text.startsWith(`${item.label})`) || first?.text.startsWith(`${item.label}.`), `${item.section} ${item.label}: "${first?.text ?? ''}"`).toBe(true);
    }
    // Every other anchor of an item lies on some printed line too.
    for (const item of book.truth.items) {
      for (const anchor of item.anchors) expect(lineAt(pages, anchor), `${item.section} ${item.label}`).toBeDefined();
    }
  });

  it('prints every answer where the truth says', () => {
    for (const answer of book.truth.answers) {
      const line = lineAt(pages, answer.anchors[0] as BookAnchor);
      expect(line?.text.startsWith(`${answer.label})`), `${answer.section} ${answer.label}: "${line?.text ?? ''}"`).toBe(true);
    }
  });

  it('makes lines the heuristics must cope with: merged table-of-contents entries, a split instruction and a split item', () => {
    const toc = pages[book.truth.tocPages[0] as number] as PageText;
    expect(toc.lines.some((line) => /\d+Chapter 1: Graphs1\.1 /.test(line.text))).toBe(true);
    expect(toc.lines.some((line) => /Whole Numbres/.test(line.text))).toBe(true);
    // The instruction of the word problems crosses a page break: its second line is the first line of the next page.
    const crossing = book.truth.instructions.find((instruction) => new Set(instruction.anchors.map((anchor) => anchor.page)).size === 2);
    expect(crossing?.section).toBe('0.2');
    // One word problem has lines on two pages.
    const split = book.truth.items.find((item) => new Set(item.anchors.map((anchor) => anchor.page)).size === 2 && item.layout === 'rows1');
    expect(split?.label).toBe('11');
  });

  it('can leave the table of contents and the answer key out, and the section markers', async () => {
    const bare = buildSyntheticBook({ toc: false, answerKey: false });
    expect(bare.truth.tocPages).toEqual([]);
    expect(bare.truth.answerKeyPage).toBeUndefined();
    expect(bare.truth.answers.length).toBe(0);
    expect(bare.pageCount).toBeLessThan(book.pageCount);
    const unmarked = buildSyntheticBook({ markers: false });
    const copy = await PdfDocument.fromBytes(unmarked.pdf);
    try {
      const all = await copy.allPageText();
      const key = all.slice(unmarked.truth.answerKeyPage as number);
      const markers = key.flatMap((page) => page.lines.filter((line) => /^\d\.\d$/.test(line.text)));
      expect(markers.length).toBe(0);
    } finally {
      await copy.close();
    }
  });
});
