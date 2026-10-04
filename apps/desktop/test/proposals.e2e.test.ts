import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeProject } from '@mcprep/core';
import { available, cliIn, close, framesOf, launch, stateOf, type Running } from './helpers/e2e.js';
import { bookResultsOf, buildBigBook, type BigBook } from './helpers/big-book.js';

/**
 * Finding the exercises and the answers of a book in the built application: the whole way through the main process on the
 * synthetic textbook (112 exercises, 112 answers), and the speed of the window with the result of a book of 5 000 exercises
 * (the proposals are made from the synthetic big book's own frames and handed to the window as the main process would).
 * Needs `npm run build` and Electron: `npm run test:e2e`.
 */
let work: string;
let running: Running | undefined;
let cli: (...args: string[]) => string;
const win = (): Running['win'] => (running as Running).win;

const tab = (name: RegExp): Promise<void> => win().getByRole('tab', { name }).click();
const mode = (name: string): Promise<void> => win().getByRole('button', { name, exact: true }).click();
const frameCount = (): Promise<number> => framesOf(win()).then((frames) => frames.length);

beforeAll(async () => {
  if (!available) return;
  const built = await import('@mcprep/core/testing');
  work = mkdtempSync(join(tmpdir(), 'mcprep-proposals-'));
  writeFileSync(join(work, 'textbook.pdf'), built.buildSyntheticBook().pdf);
  cli = cliIn(work);
  running = await launch(work, join(work, 'textbook.pdf'));
}, 120_000);

afterAll(async () => {
  await close(running);
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!available)('finding the exercises and the answers of a book in the desktop app', () => {
  it('has three ways to propose and says what a book search needs first: sections, then exercises for the answers', async () => {
    await tab(/Propose/);
    expect(await win().locator('.modes .mode').allInnerTexts()).toEqual(['Frames', 'Book exercises', 'Solutions']);
    await mode('Book exercises');
    expect(await win().getByRole('button', { name: 'Find the exercises' }).isDisabled()).toBe(true);
    expect(await win().locator('.book-proposals .warn-line').innerText()).toContain('The book has no sections yet');
    await mode('Solutions');
    expect(await win().getByRole('button', { name: 'Find the answers' }).isDisabled()).toBe(true);
    expect(await win().locator('.book-proposals .warn-line').innerText()).toContain('The book has no book exercises yet');
    // The way on: "Find the sections first" goes to the Sections panel, where the book is read.
    await mode('Book exercises');
    await win().getByRole('button', { name: 'Find the sections first' }).click();
    await win().getByRole('button', { name: 'Derive sections' }).click();
    await win().waitForSelector('.derive-review');
    await win().getByRole('button', { name: 'Accept all' }).click();
    await win().waitForSelector('.derive-review', { state: 'detached' });
  });

  it('reads the book and lists its 112 exercises with the evidence, applying nothing', async () => {
    await tab(/Propose/);
    await mode('Book exercises');
    await win().getByRole('button', { name: 'Find the exercises' }).click();
    await win().waitForSelector('.book-row');
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toBe('112 exercises found in 4 sections: 112 new, 0 different from yours, 0 in the book already.');
    expect(await win().getByRole('button', { name: /Apply all/ }).innerText()).toBe('Apply all (112)');
    expect(await win().locator('.tab.active .badge').innerText()).toBe('112');
    expect(await frameCount()).toBe(0);
    // Only the rows in view are in the document.
    expect(await win().locator('.book-row').count()).toBeLessThan(40);
    expect(await win().locator('.book-row').first().innerText()).toContain('1) 8 - 7');
    // The ghost of every exercise of the page that is showing: the printed number, the frame and the instruction above it.
    await win().locator('.book-row').first().click();
    await win().waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '5');
    await win().waitForSelector('.book-ghost');
    const onPage = await win().locator('.book-ghost').count();
    expect(onPage).toBeGreaterThanOrEqual(44);
    expect(await win().locator('.book-ghost .chip text').first().textContent()).toBe('1');
    expect(await win().locator('.region-context').count()).toBeGreaterThan(0);
    // The evidence of the exercise, with the pages as the window counts them.
    const evidence = await win().locator('.derive-detail').innerText();
    expect(evidence).toContain('0.1:1');
    expect(evidence).toContain('starts with "1)"');
    expect(evidence).toContain('instruction: "Evaluate each expression."');
    // The first ghost carries its own buttons.
    expect(await win().locator('.book-ghost .round-button').count()).toBe(2);
    // A page without exercises has no ghost.
    await win().evaluate(() => window.__store.setPage(0));
    await win().waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '0');
    expect(await win().locator('.book-ghost').count()).toBe(0);
  });

  it('dismisses one, filters by how sure the search is, finds a number, and applies only what is ticked', async () => {
    await win().locator('.book-proposals input[aria-label="Find a proposal"]').fill('0.2:');
    await win().getByRole('button', { name: 'Apply all (14)' }).waitFor();
    expect((await win().locator('.book-row .chip').allInnerTexts()).slice(0, 3)).toEqual(['1', '2', '3']);
    // The search is sure of all of them (85% and 90%): the list of the ones it is not sure of is empty, and nothing is lost by looking.
    await win().getByLabel('How sure the search is').selectOption('unsure');
    await win().getByRole('button', { name: 'Apply all (0)' }).waitFor();
    expect(await win().locator('.book-proposals .empty').innerText()).toBe('No proposal matches.');
    await win().getByLabel('How sure the search is').selectOption('sure');
    await win().getByRole('button', { name: 'Apply all (14)' }).waitFor();
    await win().getByLabel('How sure the search is').selectOption('any');
    await win().getByRole('button', { name: 'Dismiss 0.2:3' }).click();
    await win().getByRole('button', { name: 'Apply all (13)' }).waitFor();
    // Nothing is ticked but 13 rows: untick all listed, tick two, apply them.
    await win().getByRole('button', { name: 'none' }).click();
    expect(await win().getByRole('button', { name: /Apply selected/ }).innerText()).toBe('Apply selected (0)');
    await win().getByLabel('Take 0.2:1', { exact: true }).check();
    await win().getByLabel('Take 0.2:2', { exact: true }).check();
    await win().getByRole('button', { name: /Apply selected/ }).click();
    await win().waitForFunction(() => (window as unknown as { __store: { state: { project: { frames: unknown[] } } } }).__store.state.project.frames.length === 2);
    expect((await framesOf(win())).map((frame) => `${frame.section}:${frame.label}`)).toEqual(['0.2:1', '0.2:2']);
    expect(await win().locator('.derive-effect.applied').innerText()).toBe('Added 2 book exercises. Undo takes it back.');
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(2);
    // The dismissed one can be brought back.
    await win().getByLabel('Which proposals to show').selectOption('rejected');
    await win().waitForFunction(() => document.querySelectorAll('.book-row').length === 1);
    await win().getByRole('button', { name: 'Bring back 0.2:3' }).click();
    await win().getByLabel('Which proposals to show').selectOption('todo');
    await win().locator('.book-proposals input[aria-label="Find a proposal"]').fill('');
  });

  it('applies all the rest as one step, then says that the book has everything', async () => {
    expect(await win().getByRole('button', { name: /Apply all/ }).innerText()).toBe('Apply all (110)');
    await win().getByRole('button', { name: /Apply all/ }).click();
    await win().waitForFunction(() => (window as unknown as { __store: { state: { project: { frames: unknown[] } } } }).__store.state.project.frames.length === 112);
    expect(await win().locator('.derive-effect.applied').innerText()).toBe('Added 110 book exercises. Undo takes it back.');
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(3);
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toContain('All 112 exercises are in the book already');
    expect(await win().getByRole('button', { name: /Apply all/ }).isDisabled()).toBe(true);
    expect(await win().locator('.statusbar').innerText()).toContain('112 book exercises');
    // The book exercises are the printed numbers, filed under the sections found.
    const frames = await framesOf(win());
    expect(frames.every((frame) => frame.authority === 'book')).toBe(true);
    expect(frames.filter((frame) => frame.section === '0.1')).toHaveLength(70);
    expect(frames.filter((frame) => frame.context !== undefined && frame.context.length > 0).length).toBe(112);
    // Running the search again finds the same and offers nothing.
    await win().getByRole('button', { name: 'Find again' }).click();
    await win().waitForSelector('.book-proposals .derive-summary');
    await win().waitForFunction(() => document.querySelector('.book-proposals .derive-summary')?.textContent?.includes('All 112 exercises are in the book already'));
    expect(await win().getByRole('button', { name: /Apply all/ }).isDisabled()).toBe(true);
    expect(await frameCount()).toBe(112);
    expect(await stateOf(win(), (s) => (s['past'] as unknown[]).length)).toBe(3);
  });

  it('shows an exercise the book has differently as different, and replaces it only when it is ticked', async () => {
    // A person moved the frame of 1.2:5 by hand.
    await win().evaluate(() => {
      const store = window.__store as unknown as { state: { project: { frames: { id: string; section?: string; label?: string; rect: { left: number; top: number; right: number; bottom: number } }[] } }; apply(ops: unknown[], options?: unknown): void };
      const frame = store.state.project.frames.find((entry) => entry.section === '1.2' && entry.label === '5');
      if (!frame) throw new Error('no frame');
      store.apply([{ op: 'update', id: frame.id, rect: { ...frame.rect, left: frame.rect.left + 0.02, right: frame.rect.right + 0.02 } }]);
    });
    await win().getByRole('button', { name: 'Find again' }).click();
    await win().waitForFunction(() => document.querySelectorAll('.book-row').length === 1);
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toBe('112 exercises found in 4 sections: 0 new, 1 different from yours, 111 in the book already.');
    expect(await win().locator('.book-row .derive-tag').innerText()).toBe('Different');
    expect(await win().locator('.book-row .change').innerText()).toBe('its frame is somewhere else or has another size');
    // "Apply all" does not touch it: the book's own is kept until the person says otherwise.
    expect(await win().getByRole('button', { name: /Apply all/ }).isDisabled()).toBe(true);
    expect(await win().getByRole('button', { name: /Apply selected/ }).isDisabled()).toBe(true);
    await win().getByLabel('Replace yours with 1.2:5', { exact: true }).check();
    expect(await win().getByRole('button', { name: /Apply selected/ }).innerText()).toBe('Apply selected (1)');
    await win().getByRole('button', { name: /Apply selected/ }).click();
    await win().waitForFunction(() => document.querySelector('.derive-effect.applied')?.textContent?.startsWith('Replaced 1 book exercise'));
    expect(await frameCount()).toBe(112);
    await win().waitForFunction(() => document.querySelector('.book-proposals .derive-summary')?.textContent?.includes('All 112 exercises are in the book already'));
  });

  it('finds the answers and gives each exercise its hidden solution, shown as dashed green regions in the answer key', async () => {
    await mode('Solutions');
    await win().getByRole('button', { name: 'Find the answers' }).click();
    await win().waitForSelector('.book-row');
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toBe('112 answers found: 112 new, 0 different from yours, 0 in the book already.');
    expect(await win().locator('.book-row .chip').first().innerText()).toBe('S 1');
    await win().locator('.book-row').first().click();
    await win().waitForFunction(() => Number(document.querySelector('.page')?.getAttribute('data-page')) >= 18);
    await win().waitForSelector('.book-ghost');
    expect(await win().locator('.book-ghost').count()).toBeGreaterThanOrEqual(40);
    expect(await win().locator('.book-ghost .chip text').first().textContent()).toBe('S 1');
    await win().getByRole('button', { name: /Apply all/ }).click();
    await win().waitForFunction(() => document.querySelector('.derive-effect.applied')?.textContent?.startsWith('Gave 112 exercises their solution'));
    const frames = await framesOf(win());
    expect(frames.every((frame) => (frame.solution?.length ?? 0) > 0)).toBe(true);
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toContain('All 112 answers are in the book already');
    // The ghosts are replaced by the solution regions themselves.
    expect(await win().locator('.book-ghost').count()).toBe(0);
    expect(await win().locator('.region-solution').count()).toBeGreaterThan(40);
  });

  it('is saved as the project the command line reads: 112 exercises, each with a solution', async () => {
    await win().keyboard.press('Control+s');
    await win().waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const shown = JSON.parse(cli('book', 'show', '--json')) as { result: { totals: { exercises: number; withSolution: number; withoutSolution: number; unfiled: number } } };
    expect(shown.result.totals).toMatchObject({ exercises: 112, withSolution: 112, withoutSolution: 0, unfiled: 0 });
  });

  it('looks in one section only, from the Sections list: Find its exercises', async () => {
    // A fresh start: the exercises of 1.1 are removed, then found again from the section.
    await win().evaluate(() => {
      const store = window.__store as unknown as { state: { project: { frames: { id: string; section?: string }[] } }; apply(ops: unknown[], options?: unknown): void };
      store.apply(store.state.project.frames.filter((frame) => frame.section === '1.1').map((frame) => ({ op: 'delete', id: frame.id })));
    });
    expect(await frameCount()).toBe(100);
    await tab(/Sections/);
    await win().locator('.section-row', { hasText: 'id 1.1' }).click();
    await win().getByRole('button', { name: 'Find its exercises' }).click();
    await win().waitForSelector('.book-row');
    expect(await win().locator('.tab.active').innerText()).toContain('Propose');
    expect(await win().locator('.modes .mode.active').innerText()).toBe('Book exercises');
    expect(await win().locator('.book-proposals .derive-summary').innerText()).toBe('12 exercises found in 1 section: 12 new, 0 different from yours, 0 in the book already.');
    expect(await win().locator('select[aria-label="Which sections to search"]').inputValue()).toBe('1.1');
    await win().getByRole('button', { name: /Apply all/ }).click();
    await win().waitForFunction(() => (window as unknown as { __store: { state: { project: { frames: unknown[] } } } }).__store.state.project.frames.length === 112);
  });
});

// ---------------------------------------------------------------------------------------------------------- scale

describe.skipIf(!available)('the window with the proposals of a book of 5 000 exercises', () => {
  let big: BigBook;
  let bigRunning: Running | undefined;
  let bigWork: string;
  let bigCli: (...args: string[]) => string;
  const bw = (): Running['win'] => (bigRunning as Running).win;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    if (!available) return;
    big = buildBigBook();
    bigWork = mkdtempSync(join(tmpdir(), 'mcprep-proposals-big-'));
    writeFileSync(join(bigWork, 'practice.pdf'), big.pdf);
    // The book as a person starts: the sections are there, no exercise yet.
    writeFileSync(join(bigWork, 'practice.mcprep.json'), serializeProject({ ...big.project, frames: [], seq: 0, modifiedBy: 'cli' }));
    bigCli = cliIn(bigWork);
    bigRunning = await launch(bigWork, join(bigWork, 'practice.mcprep.json'));
    const results = bookResultsOf(big);
    // The main process is replaced by what it would answer: the heuristics are tested on the textbook above.
    await bw().evaluate((answers) => {
      const store = window.__store as unknown as { api: Record<string, unknown> };
      store.api = { ...window.mcprep, proposeBook: (request: { kind: string }) => Promise.resolve({ ok: true, result: request.kind === 'exercises' ? answers.exercises : answers.solutions }) };
    }, results);
  }, 180_000);

  afterAll(async () => {
    console.log(`proposals of the big book (ms): ${JSON.stringify(timings)}`);
    await close(bigRunning);
    if (bigWork) rmSync(bigWork, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const probe = (): Promise<void> =>
    bw().evaluate(() => {
      const holder = window as unknown as { __late: number[]; __probe: ReturnType<typeof setInterval> };
      holder.__late = [];
      let last = performance.now();
      holder.__probe = setInterval(() => {
        const now = performance.now();
        holder.__late.push(now - last - 20);
        last = now;
      }, 20);
    });
  const lateness = (): Promise<number> =>
    bw().evaluate(() => {
      const holder = window as unknown as { __late: number[]; __probe: ReturnType<typeof setInterval> };
      clearInterval(holder.__probe);
      return Math.round(Math.max(0, ...holder.__late));
    });

  it('lists 5 000 proposals with a screenful of rows, and the ghosts of one page only', async () => {
    await bw().getByRole('tab', { name: /Propose/ }).click();
    await bw().getByRole('button', { name: 'Book exercises', exact: true }).click();
    const started = performance.now();
    await bw().getByRole('button', { name: 'Find the exercises' }).click();
    await bw().waitForSelector('.book-row');
    timings['open the list'] = Math.round(performance.now() - started);
    expect(await bw().locator('.book-proposals .derive-summary').innerText()).toBe('5000 exercises found in 90 sections: 5000 new, 0 different from yours, 0 in the book already; 2500 not sure.');
    expect(await bw().getByRole('button', { name: /Apply all/ }).innerText()).toBe('Apply all (5000)');
    expect(await bw().locator('.book-row').count()).toBeLessThan(40);
    expect(await bw().locator('.tab.active .badge').innerText()).toBe('5000');
    // The ghosts of the page that is showing (44 exercises) and no others.
    await bw().waitForSelector('.book-ghost');
    expect(await bw().locator('.book-ghost').count()).toBe(44);
    expect(await bw().locator('.book-ghost .chip').count()).toBe(44);
    if (process.env['MCPREP_SHOT_DIR']) await bw().screenshot({ path: join(process.env['MCPREP_SHOT_DIR'], 'proposals-big.png') });
    await bw().evaluate(() => window.__store.setPage(9));
    await bw().waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '9');
    expect(await bw().locator('.book-ghost').count()).toBe(44);
    expect(await bw().locator('.book-ghost').first().getAttribute('data-state')).toBe('new');
  });

  it('stays smooth while scrolling the list, filtering and searching among 5 000 proposals', async () => {
    await probe();
    const list = bw().locator('.book-list');
    for (let step = 0; step < 30; step += 1) {
      await list.evaluate((node, at) => {
        node.scrollTop = at * 600;
      }, step);
      await bw().waitForTimeout(16);
    }
    await bw().getByLabel('How sure the search is').selectOption('unsure');
    await bw().waitForFunction(() => /^Apply all [(](?!5000[)])[0-9]+[)]$/.test([...document.querySelectorAll('button')].find((button) => /^Apply all/.test(button.textContent ?? ''))?.textContent ?? ''));
    const unsure = Number(/[(]([0-9]+)[)]/.exec(await bw().getByRole('button', { name: /Apply all/ }).innerText())?.[1]);
    expect(unsure).toBeGreaterThan(1000);
    expect(unsure).toBeLessThan(4000);
    await bw().getByLabel('How sure the search is').selectOption('any');
    const started = performance.now();
    await bw().locator('input[aria-label="Find a proposal"]').fill('1.5:12');
    await bw().waitForFunction(() => document.querySelectorAll('.book-row').length === 1);
    timings['search'] = Math.round(performance.now() - started);
    expect(await bw().locator('.book-row .chip').innerText()).toBe('12');
    await bw().locator('input[aria-label="Find a proposal"]').fill('');
    const late = await lateness();
    timings['latest timer (ms)'] = late;
    expect(late).toBeLessThan(400);
  });

  it('applies 5 000 exercises as one step in seconds, and then has nothing left to do', async () => {
    const started = performance.now();
    await bw().getByRole('button', { name: /Apply all/ }).click();
    await bw().waitForFunction(() => (window as unknown as { __store: { state: { project: { frames: unknown[] } } } }).__store.state.project.frames.length === 5000, undefined, { timeout: 60000 });
    timings['apply 5000'] = Math.round(performance.now() - started);
    expect(timings['apply 5000']).toBeLessThan(30000);
    expect(await stateOf(bw(), (s) => (s['past'] as unknown[]).length)).toBe(1);
    expect(await bw().locator('.derive-effect.applied').innerText()).toBe('Added 5000 book exercises. Undo takes it back.');
    expect(await bw().getByRole('button', { name: /Apply all/ }).isDisabled()).toBe(true);
    expect(await bw().locator('.statusbar').innerText()).toContain('5000 book exercises');
    expect(await bw().locator('.book-ghost').count()).toBe(0);
  });

  it('gives the 5 000 exercises their solutions, and the file that is saved is the book the command line reads', async () => {
    await bw().getByRole('button', { name: 'Solutions', exact: true }).click();
    const started = performance.now();
    await bw().getByRole('button', { name: 'Find the answers' }).click();
    await bw().waitForSelector('.book-row');
    expect(await bw().locator('.book-proposals .derive-summary').innerText()).toBe('5000 answers found: 5000 new, 0 different from yours, 0 in the book already; 2500 not sure.');
    await bw().getByRole('button', { name: /Apply all/ }).click();
    await bw().waitForFunction(() => (window as unknown as { __store: { state: { project: { frames: { solution?: unknown[] }[] } } } }).__store.state.project.frames.every((frame) => (frame.solution?.length ?? 0) > 0), undefined, { timeout: 60000 });
    timings['solutions 5000'] = Math.round(performance.now() - started);
    const saveStarted = performance.now();
    await bw().keyboard.press('Control+s');
    await bw().waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false, undefined, { timeout: 30000 });
    timings['save'] = Math.round(performance.now() - saveStarted);
    const shown = JSON.parse(bigCli('book', 'show', '--json')) as { result: { totals: { exercises: number; withSolution: number; unfiled: number } } };
    expect(shown.result.totals).toMatchObject({ exercises: 5000, withSolution: 5000, unfiled: 0 });
  });
});
