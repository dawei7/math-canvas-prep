import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, close, framesOf, launch, openProject, stateOf, type Running } from './helpers/e2e.js';
import { buildBigBook } from './helpers/big-book.js';

/**
 * Deriving the sections of a book in the built application: the button, the progress and stopping of a long search on a
 * big book (the window stays responsive), the review with the evidence, taking sections without touching the exercises
 * filed under them. Synthetic books only. Needs `npm run build` and Electron: `npm run test:e2e`.
 */
let work: string;
let running: Running | undefined;
const win = (): Running['win'] => (running as Running).win;

const outlineIds = (): Promise<(string | undefined)[]> => stateOf(win(), (s) => ((s['project'] as { outline?: { entries: { id?: string }[] } }).outline?.entries ?? []).map((entry) => entry.id));
const sectionTab = (): Promise<void> => win().getByRole('tab', { name: /Sections/ }).click();

beforeAll(async () => {
  if (!available) return;
  const built = await import('@mcprep/core/testing');
  work = mkdtempSync(join(tmpdir(), 'mcprep-derive-'));
  writeFileSync(join(work, 'textbook.pdf'), built.buildSyntheticBook().pdf);
  running = await launch(work, join(work, 'textbook.pdf'));
}, 120_000);

afterAll(async () => {
  await close(running);
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!available)('deriving the sections of a book in the desktop app', () => {
  it('has a button for it in the Sections panel, and no longer the plain "Find headings"', async () => {
    await sectionTab();
    expect(await win().getByRole('button', { name: 'Derive sections' }).isVisible()).toBe(true);
    expect(await win().getByRole('button', { name: 'Find headings' }).count()).toBe(0);
  });

  it('reads the text of a page exactly as the command line does: the same fonts, so the same lines, snaps, proposals and heading positions', async () => {
    const core = await import('@mcprep/core');
    const pdf = await core.PdfDocument.fromBytes(readFileSync(join(work, 'textbook.pdf')));
    const direct = await pdf.pageText(4, { fonts: true });
    await pdf.close();
    const inApp = await win().evaluate(() => window.mcprep.pageText(4));
    expect(inApp.lines.length).toBe(direct.lines.length);
    expect(inApp.lines.map((line) => [line.text, line.rect])).toEqual(direct.lines.map((line) => [line.text, line.rect]));
  });

  it('reads the book and shows what it found, with the evidence, before anything is changed', async () => {
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    expect(await win().locator('.derive-summary').innerText()).toBe('7 sections found (2 chapters, 4 sections): 7 new, 0 different from yours, 0 the same.');
    expect(await win().locator('.derive-row').count()).toBe(7);
    expect(await win().locator('.derive-row .section-chip').allInnerTexts()).toEqual(['Chapter 0', '0.1', '0.2', 'Chapter 1', '1.1', '1.2']);
    expect(await win().locator('.derive-row .derive-tag').allInnerTexts()).toEqual(Array(7).fill('New'));
    // Nothing was changed: the project has no sections and nothing to save.
    expect(await outlineIds()).toEqual([]);
    expect(await stateOf(win(), (s) => s['dirty'])).toBe(false);
    // A click shows the evidence (pages counted from 1 like everywhere in the window), goes to the heading and marks it on the page.
    await win().locator('.derive-row', { hasText: 'Whole Numbers' }).click();
    await win().waitForSelector('.derive-detail');
    const evidence = await win().locator('.derive-detail').innerText();
    expect(evidence).toContain('lesson heading');
    expect(evidence).toContain('page 5, 0.0987 from the top');
    expect(evidence).toContain('"Whole Numbres"');
    await win().waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '4');
    expect(await win().locator('.derive-mark').allTextContents()).toEqual(['0.1']);
    expect(await win().locator('.derive-mark.selected').count()).toBe(1);
    // The evidence of a section that two sources disagree on lists the other spelling.
    expect(await win().locator('.derive-detail').innerText()).toContain('Other spellings of the title');
  });

  it('takes the ticked sections as one step of the history, and the window says what it did', async () => {
    await win().getByLabel('Take Answers').uncheck();
    expect(await win().getByRole('button', { name: /Accept selected/ }).innerText()).toBe('Accept selected (6)');
    await win().getByRole('button', { name: /Accept selected/ }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
    expect(await outlineIds()).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2']);
    expect(await win().locator('.section-row').count()).toBe(6);
    expect(await win().locator('.toast-success').innerText()).toContain('The book now has 6 sections (6 new). Undo takes it back.');
    expect(await stateOf(win(), (s) => (s['project'] as { outline: { source: string } }).outline.source)).toBe('derived');
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(1);
    expect(await stateOf(win(), (s) => s['dirty'])).toBe(true);
    // The heading marks of the new sections are on their pages.
    expect(await win().locator('.section-mark').count()).toBeGreaterThan(0);
  });

  it('finds the same sections again as the same, and the one that is missing as new; taking the rest changes nothing it should not', async () => {
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    expect(await win().locator('.derive-summary').innerText()).toBe('7 sections found (2 chapters, 4 sections): 1 new, 0 different from yours, 6 the same.');
    expect(await win().locator('.derive-row').count()).toBe(1); // the filter shows what is new or different
    expect(await win().locator('.derive-row .section-title').innerText()).toBe('Answers');
    await win().getByRole('button', { name: 'Accept all' }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
    expect(await outlineIds()).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(2);
  });

  it('says that nothing is new when the sections are what the book prints, and refuses to apply it again', async () => {
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    expect(await win().locator('.derive-summary').innerText()).toContain('the book already has exactly these: nothing new, nothing different');
    expect(await win().locator('.derive-row').count()).toBe(7); // nothing is new, so the filter shows all
    await win().getByRole('button', { name: 'Accept all' }).click();
    expect(await win().locator('.derive-review .form-error').innerText()).toBe('Nothing would change: the sections of the book already are these.');
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(2);
    await win().getByRole('button', { name: 'Discard' }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
    expect(await win().locator('.section-row').count()).toBe(7);
  });

  it('is saved as the project file the command line reads, with the ids, labels and heading positions', async () => {
    await win().keyboard.press('Control+s');
    await win().waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const saved = JSON.parse(readFileSync(join(work, 'textbook.mcprep.json'), 'utf8')) as { outline: { source: string; entries: { id: string; label?: string; top?: number; page: number; depth: number }[] } };
    expect(saved.outline.source).toBe('derived');
    expect(saved.outline.entries.map((entry) => entry.id)).toEqual(['c0', '0.1', '0.2', 'c1', '1.1', '1.2', 'Answers']);
    expect(saved.outline.entries[1]).toMatchObject({ label: '0.1', page: 4, depth: 1, top: 0.0987 });
  });

  it('never lets an exercise lose its section: the section of the person stays, or its exercises move where the person says', async () => {
    // A project whose sections have other ids (as an outline from the PDF's bookmarks would), with exercises filed under them.
    await win().evaluate(() => {
      const store = (window as unknown as { __store: { setOutline(entries: unknown[], source: string): void; apply(ops: unknown[]): void } }).__store;
      store.setOutline([{ title: '0.1 Whole Numbers', page: 4, depth: 0, id: 'whole', label: '0.1' }, { title: 'Graphs', page: 12, depth: 0, id: 'graphs' }], 'manual');
      store.apply([
        { op: 'add', authority: 'book', label: '1', section: 'whole', page: 5, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.25 } },
        { op: 'add', authority: 'book', label: '2', section: 'whole', page: 5, rect: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.35 } },
        { op: 'add', authority: 'book', label: '1', section: 'graphs', page: 13, rect: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.25 } },
      ]);
    });
    expect(await framesOf(win())).toHaveLength(3);
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    const yours = win().locator('.yours');
    expect(await yours.innerText()).toContain('2 sections of yours are not in the list');
    expect(await yours.locator('.yours-row').count()).toBe(2);
    expect(await yours.locator('.yours-row').first().innerText()).toContain('looks like 0.1');
    // Taking every section found keeps both sections of the person: exercises are filed under them.
    await win().getByRole('button', { name: 'Accept all' }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
    expect(await outlineIds()).toEqual(expect.arrayContaining(['whole', 'graphs', 'c0', '0.1']));
    expect((await framesOf(win())).map((frame) => frame.section)).toEqual(['whole', 'whole', 'graphs']);
    expect(await stateOf(win(), (s) => (s['validation'] as { errors: unknown[] }).errors.length)).toBe(0);
    // Undo, then move the exercises of "whole" and "graphs" to the sections that look the same.
    await win().keyboard.press('Control+z');
    expect(await outlineIds()).toEqual(['whole', 'graphs']);
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    await win().getByRole('button', { name: /Move exercises to the same-looking sections/ }).click();
    expect(await win().locator('.derive-effect').innerText()).toContain('3 exercises move to the section you chose');
    await win().getByRole('button', { name: 'Accept all' }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
    const after = await framesOf(win());
    // "Graphs" has no printed number: it looks like the chapter of that title.
    expect(after.map((frame) => `${frame.section}:${frame.label}`)).toEqual(['0.1:1', '0.1:2', 'c1:1']);
    expect(await outlineIds()).not.toContain('whole');
    expect(await stateOf(win(), (s) => (s['validation'] as { errors: unknown[] }).errors.length)).toBe(0);
  });
});

describe.skipIf(!available)('a long search on a big book', () => {
  let big: Running | undefined;
  let bigWork: string;
  let bigPages = 0;
  const bigWin = (): Running['win'] => (big as Running).win;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    if (!available) return;
    // 2 150 pages: reading them takes several seconds, long enough to watch it and to stop it. Only the PDF is written; the window makes the project.
    bigWork = mkdtempSync(join(tmpdir(), 'mcprep-derive-big-'));
    const book = buildBigBook({ exercises: 80000 });
    bigPages = book.pageCount;
    writeFileSync(join(bigWork, 'workbook.pdf'), book.pdf);
    writeFileSync(join(bigWork, 'small.pdf'), (await import('@mcprep/core/testing')).buildSyntheticBook().pdf);
    big = await launch(bigWork, join(bigWork, 'workbook.pdf'));
    await bigWin().getByRole('tab', { name: /Sections/ }).click();
  }, 180_000);

  afterAll(async () => {
    console.log(`derive on the big book (ms): ${JSON.stringify(timings)}`);
    await close(big);
    if (bigWork) rmSync(bigWork, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A timer every 20 ms in the window: how late it fires says how long the window was busy. */
  async function probe(): Promise<void> {
    await bigWin().evaluate(() => {
      const holder = window as unknown as { __late: number[]; __probe: ReturnType<typeof setInterval> };
      holder.__late = [];
      let last = performance.now();
      holder.__probe = setInterval(() => {
        const now = performance.now();
        holder.__late.push(now - last - 20);
        last = now;
      }, 20);
    });
  }

  const lateness = (): Promise<{ max: number; count: number }> =>
    bigWin().evaluate(() => {
      const holder = window as unknown as { __late: number[]; __probe: ReturnType<typeof setInterval> };
      clearInterval(holder.__probe);
      return { max: Math.round(Math.max(0, ...holder.__late)), count: holder.__late.length };
    });

  it('shows how far it is while it reads, and the window stays responsive', async () => {
    await probe();
    const started = performance.now();
    await bigWin().getByRole('button', { name: 'Derive sections' }).click();
    await bigWin().waitForSelector('.audit-bar');
    const bar = bigWin().getByRole('progressbar');
    await bigWin().waitForFunction(() => Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 0);
    expect(await bar.getAttribute('aria-valuemax')).toBe(String(bigPages));
    expect(await bigWin().locator('.audit-phase').innerText()).toBe('Reading the text of the pages');
    // The button cannot be pressed twice while it runs; the project is untouched.
    expect(await bigWin().getByRole('button', { name: 'Derive sections' }).isDisabled()).toBe(true);
    const seen = new Set<number>();
    while ((await bigWin().locator('.audit-bar').count()) > 0 && performance.now() - started < 120000) {
      seen.add(Number(await bar.getAttribute('aria-valuenow', { timeout: 500 }).catch(() => '0')));
      await bigWin().waitForTimeout(100);
    }
    timings['derive'] = Math.round(performance.now() - started);
    // It reported more than once on the way (about ten times a second).
    expect(seen.size).toBeGreaterThan(3);
    await bigWin().waitForSelector('.derive-review');
    const late = await lateness();
    timings['latest timer (ms)'] = late.max;
    expect(late.count).toBeGreaterThan(20);
    // The window kept answering: no pause of a quarter of a second, though the main process was reading 2 150 pages.
    expect(late.max).toBeLessThan(250);
    await bigWin().getByRole('button', { name: 'Discard' }).click();
  });

  it('stops when the person presses Stop: nothing is changed, and the search can run again', async () => {
    // The document is opened again: its text is read again (a document remembers the pages it has read, which would make the search instant).
    await openProject(bigWin(), join(bigWork, 'workbook.mcprep.json'));
    await bigWin().getByRole('tab', { name: /Sections/ }).click();
    await bigWin().getByRole('button', { name: 'Derive sections' }).click();
    await bigWin().waitForFunction(() => Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 5);
    await bigWin().getByRole('button', { name: 'Stop' }).click();
    await bigWin().waitForSelector('.audit-bar', { state: 'detached' });
    expect(await bigWin().locator('.toast').innerText()).toContain('Stopped. Nothing was changed.');
    expect(await bigWin().locator('.derive-review').count()).toBe(0);
    expect(await stateOf(bigWin(), (s) => (s['audit'] as { job: string | null }).job)).toBeNull();
    expect(await stateOf(bigWin(), (s) => s['dirty'])).toBe(false);
    expect(await bigWin().getByRole('button', { name: 'Derive sections' }).isEnabled()).toBe(true);
  });

  it('is stopped by opening another document, and what it found is not shown for the other one', async () => {
    await openProject(bigWin(), join(bigWork, 'workbook.mcprep.json'));
    await bigWin().getByRole('tab', { name: /Sections/ }).click();
    await bigWin().getByRole('button', { name: 'Derive sections' }).click();
    await bigWin().waitForFunction(() => Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 5);
    await openProject(bigWin(), join(bigWork, 'small.pdf'));
    await bigWin().waitForFunction(() => (window as unknown as { __store: { state: { audit: { job: string | null } } } }).__store.state.audit.job === null, undefined, { timeout: 60000 });
    expect(await stateOf(bigWin(), (s) => (s['doc'] as { pdfPath: string }).pdfPath)).toContain('small.pdf');
    expect(await bigWin().locator('.derive-review').count()).toBe(0);
    expect(await stateOf(bigWin(), (s) => s['derive'])).toBeNull();
    // The other document can be searched at once.
    await bigWin().getByRole('tab', { name: /Sections/ }).click();
    await bigWin().getByRole('button', { name: 'Derive sections' }).click();
    await bigWin().waitForSelector('.derive-review');
    expect(await bigWin().locator('.derive-summary').innerText()).toContain('7 sections found');
    await bigWin().getByRole('button', { name: 'Discard' }).click();
  });

  it('is stopped from the window the way the main process sees it too: the call ends as stopped, at the next page', async () => {
    await openProject(bigWin(), join(bigWork, 'workbook.mcprep.json'));
    const outcome = await bigWin().evaluate(
      () =>
        new Promise<{ ok: boolean; cancelled?: boolean; done: number }>((resolve) => {
          const api = window.mcprep;
          let done = 0;
          const off = api.onProgress((progress) => {
            done = progress.done;
            if (progress.done === 0) void api.cancelAudit();
          });
          void api.deriveSections().then((result) => {
            off();
            resolve({ ok: result.ok, ...(result.ok ? {} : { cancelled: result.cancelled }), done });
          });
        }),
    );
    expect(outcome).toEqual({ ok: false, cancelled: true, done: 0 });
  });
});
