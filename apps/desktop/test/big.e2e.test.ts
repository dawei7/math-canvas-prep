import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeProject } from '@mcprep/core';
import { available, cliIn, close, drag, framesOf, gotoPage, launch, stateOf, tool, type Running } from './helpers/e2e.js';
import { buildBigBook, type BigBook } from './helpers/big-book.js';

/**
 * The built application with a book of 5 000 book exercises, 100 sections and an answer key of 5 000 regions: opening,
 * scrolling, selecting, drawing, saving and taking over a change an agent made must stay quick, the 44 small frames of a
 * two-column page must stay readable and clickable, and only what is in view may be in the document. Needs `npm run build`
 * and Electron: `npm run test:e2e`.
 */
let work: string;
let big: BigBook;
let running: Running | undefined;
let cli: (...args: string[]) => string;
const timings: Record<string, number> = {};

const win = (): Running['win'] => (running as Running).win;

/** How long it takes until the condition holds in the page, from now. */
async function until(label: string, condition: () => boolean, timeout = 30000): Promise<number> {
  const started = performance.now();
  await win().waitForFunction(condition, undefined, { timeout });
  const took = performance.now() - started;
  timings[label] = Math.round(took);
  return took;
}

beforeAll(async () => {
  if (!available) return;
  big = buildBigBook();
  work = mkdtempSync(join(tmpdir(), 'mcprep-big-'));
  writeFileSync(join(work, 'practice.pdf'), big.pdf);
  writeFileSync(join(work, 'practice.mcprep.json'), serializeProject({ ...big.project, modifiedBy: 'cli' }));
  cli = cliIn(work);
  const started = performance.now();
  running = await launch(work, join(work, 'practice.mcprep.json'));
  await win().waitForSelector('.frame');
  timings['open'] = Math.round(performance.now() - started);
}, 120_000);

afterAll(async () => {
  console.log(`timings (ms): ${JSON.stringify(timings)}`);
  await close(running);
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!available)('the desktop app with a book of 5 000 exercises and 100 sections', () => {
  it('opens in seconds and puts into the document only what is in view: one page of frames and a screenful of rows', async () => {
    expect(timings['open']).toBeLessThan(30000);
    expect(await win().locator('.frame').count()).toBe(44);
    expect(await win().locator('.frame .chip').count()).toBe(44);
    const rows = await win().locator('.frames-list .vrow').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(60);
    expect(await win().locator('.statusbar').innerText()).toContain('5000 book exercises');
    // For a look at the result (not part of the check): MCPREP_SHOT_DIR=some/folder npm run test:e2e
    if (process.env['MCPREP_SHOT_DIR']) await win().screenshot({ path: join(process.env['MCPREP_SHOT_DIR'], 'big-open.png') });
    expect(await win().locator('.tab.active .badge').innerText()).toBe('5000');
    // The groups of the list are the sections; the first rows are section 1.1 and its exercises.
    expect(await win().locator('.frames-list .frame-group').first().innerText()).toContain('1.1 Practice set 1');
    expect(await win().locator('.frames-list .frame-row .chip').first().innerText()).toBe('1');
    // A thumbnail for each page, each drawn only when it comes into view.
    await win().waitForSelector('.thumbs .thumb');
    expect(await win().locator('.thumbs .thumb').count()).toBe(135);
  });

  it('reads the text of the pages in the background without making the window wait', async () => {
    await until('text of all pages', () => Object.keys((window as unknown as { __store: { state: { texts: object } } }).__store.state.texts).length === 135, 120000);
    expect(timings['text of all pages']).toBeLessThan(120000);
    // The checks ran again once the text was there: the project is valid and has no warning (the synthetic book is clean).
    await win().waitForFunction(() => (window as unknown as { __store: { state: { validation: { ok: boolean; warnings: unknown[] } } } }).__store.state.validation.ok === true);
    await win().waitForFunction(() => (window as unknown as { __store: { state: { validation: { warnings: unknown[] } } } }).__store.state.validation.warnings.length === 0);
    expect(await win().locator('.tab', { hasText: 'Checks' }).innerText()).toContain('✓');
  });

  it('keeps the 44 labels of a two-column page readable and clickable: beside the frames, 11 pixels or more, none on another', async () => {
    const boxes = await win().locator('.frame .chip rect').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    expect(boxes).toHaveLength(44);
    for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(10.5);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i] as { x: number; y: number; width: number; height: number };
        const b = boxes[j] as { x: number; y: number; width: number; height: number };
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `labels ${i} and ${j}`).toBe(false);
      }
    }
    const sizes = await win().locator('.frame .chip text').evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(8);
    // A label in the right-hand column selects its frame when clicked.
    await tool(win(), 'Select');
    const target = (await framesOf(win())).find((frame) => frame.page === 0 && frame.label === '30') as { id: string };
    await win().locator('.frame[data-label="30"] .chip').first().click();
    expect(await stateOf(win(), (s) => s['selection'])).toBe(target.id);
    // And so does its body.
    const body = await win().locator('.frame[data-label="31"] .body').first().boundingBox();
    expect(body).not.toBeNull();
    await win().mouse.click((body?.x ?? 0) + (body?.width ?? 0) * 0.3, (body?.y ?? 0) + (body?.height ?? 0) / 2);
    expect(await stateOf(win(), (s) => (s['selection'] as string) === ((s['project'] as { frames: { id: string; label?: string; page: number }[] }).frames.find((frame) => frame.page === 0 && frame.label === '31') as { id: string }).id)).toBe(true);
    if (process.env['MCPREP_SHOT_DIR']) await win().screenshot({ path: join(process.env['MCPREP_SHOT_DIR'], 'big-selected.png') });
    await win().keyboard.press('Escape');
  });

  it('stays smooth while scrolling the list, choosing frames in it and moving through the pages: no long pauses', async () => {
    await win().evaluate(() => {
      const holder = window as unknown as { __long: number[] };
      holder.__long = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) holder.__long.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    // Scroll the list far down in steps, as a wheel does.
    const started = performance.now();
    for (const row of [200, 900, 2100, 3600, 4800]) {
      await win().locator('.frames-list').evaluate((node, y) => {
        node.scrollTop = y;
      }, row * 34);
      await win().waitForTimeout(60);
    }
    timings['scroll the list five times'] = Math.round(performance.now() - started);
    // The rows that were drawn are the ones at that place of the list, and there are still few of them.
    await win().waitForFunction(() => document.querySelectorAll('.frames-list .vrow').length > 0);
    expect(await win().locator('.frames-list .vrow').count()).toBeLessThan(60);
    // Choose a frame in the list: its page is shown at once.
    const chosen = await win().locator('.frames-list .frame-row').nth(8);
    const label = await chosen.locator('.chip').innerText();
    const clicked = performance.now();
    await chosen.click();
    await win().waitForFunction(() => document.querySelector('.frame.selected') !== null);
    timings['choose a frame in the list'] = Math.round(performance.now() - clicked);
    expect(timings['choose a frame in the list']).toBeLessThan(1500);
    expect(await win().locator('.frame.selected .chip text').first().textContent()).toBe(label);
    expect(await win().locator('.inspector').innerText()).toContain('Book exercise');
    // Walk through thirty pages with the arrow key.
    const walked = performance.now();
    for (let n = 0; n < 30; n += 1) await win().keyboard.press('ArrowRight');
    await win().waitForTimeout(300);
    timings['thirty pages with the arrow key'] = Math.round(performance.now() - walked);
    const long = await win().evaluate(() => (window as unknown as { __long: number[] }).__long);
    timings['longest pause'] = Math.round(Math.max(0, ...long));
    expect(Math.max(0, ...long)).toBeLessThan(700);
  });

  it('lists by section, filters and finds by number', async () => {
    await win().locator('.segment', { hasText: 'Framed by you' }).click();
    expect(await win().locator('.frames-list').count()).toBe(0);
    expect(await win().locator('.frames-panel .empty').innerText()).toContain('Nothing framed by you yet');
    await win().locator('.segment', { hasText: 'Book exercises' }).click();
    await win().locator('input[aria-label="Find a frame by its number"]').fill('4.3:17');
    await win().waitForSelector('.frames-list .frame-row');
    const rows = await win().locator('.frames-list .vrow').allInnerTexts();
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('4.3 Practice set');
    expect(rows[1]).toContain('17');
    expect(await win().locator('.frames-panel [role="status"]').innerText()).toContain('1 of 5000 listed');
    await win().locator('.frames-list .frame-row').click();
    await win().waitForFunction(() => document.querySelector('.frame.selected') !== null);
    expect(await win().locator('.inspector input[aria-label="Printed number"]').inputValue()).toBe('17');
    await win().locator('input[aria-label="Find a frame by its number"]').fill('');
    await win().locator('.segment', { hasText: 'All' }).click();
    // A folded section shows its heading only.
    await win().locator('.frames-list').evaluate((node) => {
      node.scrollTop = 0;
    });
    await win().locator('.frames-list .frame-group').first().click();
    expect(await win().locator('.frames-list .frame-group').first().innerText()).toContain('▸');
    await win().locator('.frames-list .frame-group').first().click();
  });

  it('lists the hundred sections, with their counts, in a list of its own that draws only what is in view', async () => {
    await win().locator('.tab', { hasText: 'Sections' }).click();
    const rows = await win().locator('.sections-list .section-row').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(40);
    expect(await win().locator('.tab.active .badge').innerText()).toBe('100');
    expect(await win().locator('.sections-panel [role="status"]').first().innerText()).toContain('100 sections · 5000 book exercises · 5000 with a solution (100%)');
    await win().locator('.sections-panel input[aria-label="Find a section"]').fill('5.3');
    await win().waitForSelector('.section-row');
    expect(await win().locator('.section-row').count()).toBe(1);
    await win().locator('.section-row').click();
    const entry = (big.project.outline?.entries ?? []).find((candidate) => candidate.id === '5.3') as { page: number };
    await win().waitForFunction((page) => document.querySelector('.page')?.getAttribute('data-page') === String(page), entry.page);
    expect(await win().locator('.section-mark').count()).toBeGreaterThanOrEqual(1);
    await win().locator('.sections-panel input[aria-label="Find a section"]').fill('');
    await win().locator('.tab', { hasText: 'Frames' }).click();
  });

  it('draws a book exercise on a crowded page: the form, the next number, the new frame, in a blink', async () => {
    await gotoPage(win(), 0);
    await win().locator('.page-scroll').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await win().waitForTimeout(200);
    await tool(win(), 'Book exercise');
    const started = performance.now();
    await drag(win(), [0.07, 0.94], [0.47, 0.96]);
    await win().waitForSelector('.draft-form input.label-input:focus');
    timings['draw and open the form'] = Math.round(performance.now() - started);
    expect(timings['draw and open the form']).toBeLessThan(2500);
    // Section 1.1 has 44 exercises: the next number is 45.
    expect(await win().locator('.draft-form select').inputValue()).toBe('1.1');
    expect(await win().locator('.draft-form input.label-input').inputValue()).toBe('45');
    const confirmed = performance.now();
    await win().keyboard.press('Enter');
    await until('the new frame is in the project', () => (window as unknown as { __store: { state: { project: { frames: unknown[] } } } }).__store.state.project.frames.length === 5001, 10000);
    timings['confirm the form'] = Math.round(performance.now() - confirmed);
    expect(timings['confirm the form']).toBeLessThan(2000);
    expect(await win().locator('.frame').count()).toBe(45);
    await tool(win(), 'Select');
  });

  it('saves 5 000 frames, atomically, in seconds, and the command line reads the same book', async () => {
    const started = performance.now();
    await win().keyboard.press('Control+s');
    await win().waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false, undefined, { timeout: 30000 });
    timings['save'] = Math.round(performance.now() - started);
    expect(timings['save']).toBeLessThan(8000);
    const disk = JSON.parse(readFileSync(join(work, 'practice.mcprep.json'), 'utf8')) as { modifiedBy: string; frames: unknown[] };
    expect(disk.modifiedBy).toBe('desktop');
    expect(disk.frames).toHaveLength(5001);
    const book = JSON.parse(cli('book', 'show', '--json')) as { result: { totals: { exercises: number; withSolution: number; sections: number } } };
    expect(book.result.totals).toMatchObject({ exercises: 5001, withSolution: 5000, sections: 100 });
  });

  it('takes over the change an agent makes to the file, quietly, in seconds', async () => {
    await gotoPage(win(), 3);
    const before = await stateOf(win(), (s) => (s['project'] as { revision: number }).revision);
    cli('exercises', 'label', '1.2:5', '5x');
    const started = performance.now();
    await win().waitForSelector('.toast-agent', { timeout: 20000 });
    timings['live reload'] = Math.round(performance.now() - started);
    expect(await win().locator('.toast-agent').innerText()).toContain('Updated by cli: 1 changed');
    expect(await stateOf(win(), (s) => (s['project'] as { revision: number }).revision)).toBeGreaterThan(before);
    const changed = (await framesOf(win())).find((frame) => frame.section === '1.2' && frame.label === '5x');
    expect(changed).toBeDefined();
    expect(await stateOf(win(), (s) => s['page'])).toBe(3);
    expect(await stateOf(win(), (s) => s['dirty'])).toBe(false);
    expect(timings['live reload']).toBeLessThan(15000);
  });

  it('raised no errors in the page while all of this happened', () => {
    expect((running as Running).errors.filter((message) => !message.includes('Content Security Policy'))).toEqual([]);
  });
});
