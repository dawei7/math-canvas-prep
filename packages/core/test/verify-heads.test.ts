import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/model/types.js';
import type { VerifyCode, VerifyFinding, VerifyReport } from '../src/verify/types.js';
import { verifyProject, pagesToVerify } from '../src/verify/verify.js';
import { Workbook, pagesOf, sectionEntries } from './verify-helpers.js';

/**
 * Running heads, an imprint and a tall region that stands alone on its page: what an exercise booklet prints and what `exercises verify`
 * must not take for text that was left behind or for a region that is too tall. Every text is made up.
 */

async function check(book: Workbook): Promise<VerifyReport> {
  const project = book.project();
  const wanted = new Set(pagesToVerify(project));
  const source = await pagesOf(book.pdf());
  return verifyProject(project, (page) => (wanted.has(page) ? source(page) : undefined));
}
const all = (report: VerifyReport, code: VerifyCode): VerifyFinding[] => report.findings.filter((finding) => finding.code === code);

/** A booklet of `pages` pages (more than twelve: the reader looks at a sample of twelve to find the running heads): four exercises on page 5 of section "a". */
function booklet(pages = 40): { book: Workbook; frames: Frame[] } {
  const book = new Workbook(pages);
  book.outline = sectionEntries([{ id: 'a', page: 4, top: 0.02, label: '1', title: 'Erste Schritte' }]);
  const frames: Frame[] = [];
  for (let n = 1; n <= 4; n += 1) frames.push(book.exercise('a', `1.${n}`, 5, 72, 100 + 40 * (n - 1), { marker: `Aufgabe 1.${n} (Titel).`, words: 'Berechnen Sie den Wert.', width: 300 }));
  return { book, frames };
}

describe('a running head that the reader did not flag', () => {
  it('is furniture when it stands on the row of the page number, even on one page only', async () => {
    const { book } = booklet();
    // The page number is flagged on the pages of the sample (it repeats); the title of the chapter stands on page 6 alone.
    for (let page = 0; page < 40; page += 1) book.text(page, 498, 42, String(page + 1), 10);
    book.text(6, 90, 42, 'Zweiter Teil des Heftes', 10);
    const report = await check(book);
    expect(all(report, 'text-left-behind')).toEqual([]);
    expect(all(report, 'numbered-text-left-behind')).toEqual([]);
  });

  it('is text that was left behind when it stands lower on the page, in the body of the zone', async () => {
    const { book } = booklet();
    for (let page = 0; page < 40; page += 1) book.text(page, 498, 42, String(page + 1), 10);
    book.text(6, 90, 300, 'Zweiter Teil des Heftes', 10);
    const found = all(await check(book), 'text-left-behind');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ page: 6 });
  });

  it('is furniture when the same text stands at the same place on three consecutive pages', async () => {
    const { book } = booklet();
    for (const page of [5, 6, 7]) book.text(page, 90, 42, 'Kopf des ersten Abschnitts', 10);
    expect(all(await check(book), 'text-left-behind')).toEqual([]);
  });

  it('is no head when the text stands on two pages only (it can be anything), nor when it stands at different places', async () => {
    const two = booklet();
    for (const page of [5, 6]) two.book.text(page, 90, 42, 'Kopf des ersten Abschnitts', 10);
    expect(all(await check(two.book), 'text-left-behind').map((finding) => finding.page)).toEqual([6]);
    const moving = booklet();
    [5, 6, 7].forEach((page, k) => moving.book.text(page, 90, 42 + 40 * k, 'Kopf des ersten Abschnitts', 10));
    expect(all(await check(moving.book), 'text-left-behind').length).toBeGreaterThan(0);
  });

  it('is no head when it starts like an item: a numbered line at the top of three pages is an exercise or an answer', async () => {
    const { book } = booklet();
    for (const page of [5, 6, 7]) book.text(page, 90, 42, '3. Ein Satz, der wie eine Aufgabe beginnt', 10);
    const report = await check(book);
    expect(all(report, 'numbered-text-left-behind').length + all(report, 'text-left-behind').length).toBeGreaterThan(0);
  });
});

describe('the pages that are read', () => {
  it('include the two pages on each side of the pages that are checked: a head is told from text by the pages beside it', () => {
    const { book } = booklet();
    const wanted = pagesToVerify(book.project());
    // The exercises stand on page 5 and the zone of the section starts there: pages 3 and 4 are only beside it.
    expect(wanted.slice(0, 3)).toEqual([3, 4, 5]);
  });
});

describe('an imprint page', () => {
  it('is furniture when its text stands in the bottom of the page and nothing stands above it', async () => {
    const { book } = booklet();
    book.text(6, 82, 746, '123 456 789 (01/99)', 10);
    book.text(6, 376, 772, '© 2026 Beispielhochschule', 8);
    expect(all(await check(book), 'text-left-behind')).toEqual([]);
  });

  it('is a page like any other when a line stands above the bottom of the page', async () => {
    const { book } = booklet();
    book.text(6, 82, 746, '123 456 789 (01/99)', 10);
    book.text(6, 82, 300, 'Eine Zeile im Körper der Seite.', 11);
    expect(all(await check(book), 'text-left-behind').length).toBeGreaterThan(0);
  });
});

describe('region-size for an exercise that is alone on its page', () => {
  const tall = (frame: Frame): void => {
    frame.rect = { ...frame.rect, bottom: frame.rect.top + 0.6 };
  };

  it('does not measure its height: a booklet prints one to a page and leaves room to answer in', async () => {
    const book = new Workbook(6);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1', title: 'Erste Schritte' }]);
    for (let n = 1; n <= 4; n += 1) tall(book.exercise('a', `1.${n}`, n, 72, 100, { marker: `Aufgabe 1.${n} (Titel).`, words: 'Berechnen Sie den Wert.', width: 300 }));
    const report = await check(book);
    expect(all(report, 'region-size')).toEqual([]);
  });

  it('still measures it when another exercise stands on the page, and measures the width and the area always', async () => {
    const book = new Workbook(6);
    book.outline = sectionEntries([{ id: 'a', page: 0, top: 0.02, label: '1', title: 'Erste Schritte' }]);
    tall(book.exercise('a', '1.1', 1, 72, 100, { marker: 'Aufgabe 1.1 (Titel).', words: 'Berechnen Sie den Wert.', width: 300 }));
    book.exercise('a', '1.2', 1, 72, 600, { marker: 'Aufgabe 1.2 (Titel).', words: 'Berechnen Sie den Wert.', width: 300 });
    const thin = book.exercise('a', '1.3', 2, 72, 100, { marker: 'Aufgabe 1.3 (Titel).', words: 'Berechnen Sie den Wert.', width: 300 });
    thin.rect = { ...thin.rect, right: thin.rect.left + 0.02 };
    book.exercise('a', '1.4', 3, 72, 100, { marker: 'Aufgabe 1.4 (Titel).', words: 'Berechnen Sie den Wert.', width: 300 });
    const found = all(await check(book), 'region-size');
    expect(found.map((finding) => finding.ref)).toEqual(['a:1.1', 'a:1.3']);
    expect(found[0]?.message).toContain('height');
    expect(found[1]?.message).toContain('width');
  });
});
