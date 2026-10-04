import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, cliIn, click, close, drag, framesOf, gotoPage, launch, root, stateOf, tool, type Running } from './helpers/e2e.js';

/**
 * The editing of a book as an authority, driven like a person on the built application: a synthetic workbook (examples/
 * workbook) whose sections are known, book exercises drawn with the mouse, their printed numbers and sections, solutions,
 * and the same project read back by the command line. Needs `npm run build` and Electron: `npm run test:e2e`.
 */
let work: string;
let running: Running | undefined;
let cli: (...args: string[]) => string;

/** Where the synthetic workbook prints each exercise, as page fractions (the same numbers the sample is built from). */
interface Place {
  section: string;
  label: string;
  page: number;
  rect: { left: number; top: number; right: number; bottom: number };
  solution: { page: number; rect: { left: number; top: number; right: number; bottom: number } }[];
  context?: { page: number; rect: { left: number; top: number; right: number; bottom: number } }[];
}
let places: Place[];
let sections: { id?: string; title: string; page: number; depth: number }[];

const placeOf = (section: string, label: string): Place => places.find((place) => place.section === section && place.label === label) as Place;

/** Draws around a printed exercise with the Book exercise tool: a little above its first line and below its last. */
async function drawBook(place: Place): Promise<void> {
  const win = (running as Running).win;
  await drag(win, [place.rect.left - 0.01, place.rect.top - 0.003], [place.rect.right + 0.01, place.rect.bottom + 0.003]);
  await win.waitForSelector('.draft-form input.label-input:focus');
}

beforeAll(async () => {
  if (!available) return;
  const built = await import('@mcprep/core/testing');
  const sample = built.buildAuthoritySample();
  places = sample.exercises.map((exercise) => ({ section: exercise.section, label: exercise.label, page: exercise.page, rect: exercise.rect, solution: exercise.solution, ...(exercise.context ? { context: exercise.context } : {}) }));
  sections = sample.sections;
  work = mkdtempSync(join(tmpdir(), 'mcprep-book-'));
  copyFileSync(join(root, 'examples/workbook/workbook.pdf'), join(work, 'book.pdf'));
  cli = cliIn(work);
  cli('init', 'book.pdf', '--title', 'Pre-Algebra Workbook');
  writeFileSync(join(work, 'sections.json'), JSON.stringify(sections));
  cli('outline', 'set', 'sections.json');
  running = await launch(work, join(work, 'book.mcprep.json'));
});

afterAll(async () => {
  await close(running);
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!available)('auditing a book in the desktop app', () => {
  it('has a tool for book exercises next to the one for exercises a person frames, each with its own symbol and an explanation', async () => {
    const win = (running as Running).win;
    const tools = await win.locator('.rail .tool .tool-label').allInnerTexts();
    expect(tools).toEqual(['Select', 'Exercise', 'Book exercise', 'Parts', 'Context', 'Solution', 'Continue', 'Question', 'Bookmark', 'Delete']);
    expect(await win.locator('button.round[title^="Book exercise"]').innerText()).not.toBe(await win.locator('button.round[title^="Exercise"]').innerText());
    await win.getByRole('button', { name: 'About Book exercise' }).click();
    expect(await win.locator('.info-pop').innerText()).toContain('printed number');
  });

  it('asks for the printed number and the section after drawing, and suggests them: previous + 1, the section at that place', async () => {
    const win = (running as Running).win;
    await tool(win, 'Book exercise');
    await drawBook(placeOf('1.1', '1'));
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('1');
    expect(await win.locator('.draft-form select').inputValue()).toBe('1.1');
    expect(await win.locator('.draft-form .form-title').innerText()).toBe('Book exercise');
    // The form is focused and the suggestion selected: Enter takes it.
    await win.keyboard.press('Enter');
    await win.waitForSelector('.draft-form', { state: 'detached' });
    let frames = await framesOf(win);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'exercise', page: 0, authority: 'book', label: '1', section: '1.1' });

    await drawBook(placeOf('1.1', '2'));
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('2');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.draft-form', { state: 'detached' });

    // The statement printed above (a) and (b) is not part of either exercise: 3a, then 3b after 3a.
    await drawBook(placeOf('1.1', '3a'));
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('3');
    await win.keyboard.type('3a');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.draft-form', { state: 'detached' });
    await drawBook(placeOf('1.1', '3b'));
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('3b');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.draft-form', { state: 'detached' });

    frames = await framesOf(win);
    expect(frames.map((frame) => `${frame.section}:${frame.label}`).sort()).toEqual(['1.1:1', '1.1:2', '1.1:3a', '1.1:3b']);
    expect(frames.every((frame) => frame.unit === undefined)).toBe(true);
    // The label on the page and in the list is the printed one, never an E-number.
    const onPage = await win.locator('.frame .chip text').allTextContents();
    expect(onPage.sort()).toEqual(['1', '2', '3a', '3b']);
    expect(await win.locator('.side .rows .chip').allTextContents()).toEqual(expect.arrayContaining(['1', '2', '3a', '3b']));
    expect((await win.locator('.statusbar').innerText()).includes('4 book exercises')).toBe(true);
    expect(await win.locator('.frame.book').count()).toBe(4);
  });

  it('offers the section at the place on the page, and the next number in that section', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 1);
    await drawBook(placeOf('1.2', '1'));
    expect(await win.locator('.draft-form select').inputValue()).toBe('1.2');
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('1');
    // Another section from the menu: the number offered follows it (section 1.1 has 1, 2, 3a, 3b; the newest is 3b).
    await win.locator('.draft-form select').selectOption('1.1');
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('3c');
    await win.locator('.draft-form select').selectOption('1.2');
    expect(await win.locator('.draft-form input.label-input').inputValue()).toBe('1');
    // Escape throws the drawing away.
    await win.keyboard.press('Escape');
    await win.waitForSelector('.draft-form', { state: 'detached' });
    expect(await framesOf(win)).toHaveLength(4);
    await drawBook(placeOf('1.2', '1'));
    await win.keyboard.press('Enter');
    await win.waitForSelector('.draft-form', { state: 'detached' });
    expect((await framesOf(win)).find((frame) => frame.page === 1)).toMatchObject({ section: '1.2', label: '1' });
  });

  it('says in plain words what is wrong with a number and keeps the form open', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 0);
    await tool(win, 'Book exercise');
    await drawBook({ ...placeOf('1.1', '3a'), rect: { left: 0.1, top: 0.55, right: 0.9, bottom: 0.57 } });
    await win.locator('.draft-form input.label-input').fill('3a');
    await win.keyboard.press('Enter');
    const error = win.locator('.draft-form .form-error');
    await error.waitFor();
    expect(await error.innerText()).toMatch(/Section 1\.1 already has an exercise 3a/);
    expect(await error.innerText()).not.toMatch(/mcprep|`/);
    expect(await framesOf(win)).toHaveLength(5);
    await win.locator('.draft-form input.label-input').fill('');
    await win.keyboard.press('Enter');
    expect(await win.locator('.draft-form .form-error').innerText()).toContain('exactly as the book prints');
    await win.locator('.draft-form input.label-input').fill('4#');
    await win.keyboard.press('Enter');
    expect(await win.locator('.draft-form .form-error').innerText()).toContain('cannot be a number');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.draft-form', { state: 'detached' });
    expect(await framesOf(win)).toHaveLength(5);
  });

  it('does not cut a book exercise into parts: the Parts tool explains, the card has the button off with an explanation', async () => {
    const win = (running as Running).win;
    const place = placeOf('1.1', '1');
    await tool(win, 'Parts');
    await click(win, (place.rect.left + place.rect.right) / 2, (place.rect.top + place.rect.bottom) / 2);
    await win.locator('.toast').waitFor();
    expect(await win.locator('.toast').innerText()).toContain('one printed exercise');
    expect((await framesOf(win)).filter((frame) => frame.unit !== undefined)).toHaveLength(0);
    await tool(win, 'Select');
    await click(win, (place.rect.left + place.rect.right) / 2, (place.rect.top + place.rect.bottom) / 2);
    const card = win.locator('.inspector');
    expect(await card.innerText()).toContain('Book exercise');
    const parts = card.locator('[role="group"][aria-label="Parts"]');
    expect(await parts.getByRole('button', { name: 'Cut into parts' }).isDisabled()).toBe(true);
    await parts.getByRole('button', { name: /About/ }).click();
    expect(await card.locator('.info-pop').innerText()).toContain('5a and 5b');
    await win.keyboard.press('Escape');
  });

  it('attaches the instruction as context to a book exercise, as to an ordinary one', async () => {
    const win = (running as Running).win;
    const statement = (placeOf('1.1', '3a').context ?? [])[0] as { page: number; rect: { left: number; top: number; right: number; bottom: number } };
    for (const label of ['3a', '3b']) {
      const place = placeOf('1.1', label);
      await tool(win, 'Select');
      await click(win, (place.rect.left + place.rect.right) / 2, (place.rect.top + place.rect.bottom) / 2);
      await tool(win, 'Context');
      expect(await win.locator('.tool-hint').innerText()).toContain(`Context for ${label}`);
      await drag(win, [statement.rect.left - 0.01, statement.rect.top - 0.002], [statement.rect.right + 0.01, statement.rect.bottom + 0.002]);
    }
    const frames = await framesOf(win);
    expect(frames.find((frame) => frame.label === '3a')?.context).toHaveLength(1);
    expect(frames.find((frame) => frame.label === '3b')?.context).toHaveLength(1);
    // An ordinary exercise takes context in just the same way.
    await gotoPage(win, 2);
    await tool(win, 'Exercise');
    const two = placeOf('2.1', '2');
    await drag(win, [two.rect.left - 0.01, two.rect.top - 0.003], [two.rect.right + 0.01, two.rect.bottom + 0.003]);
    await tool(win, 'Context');
    const one = placeOf('2.1', '1');
    await drag(win, [one.rect.left - 0.01, one.rect.top - 0.003], [one.rect.right + 0.01, one.rect.bottom + 0.003]);
    const ordinary = (await framesOf(win)).find((frame) => frame.page === 2 && frame.authority === undefined);
    expect(ordinary?.context).toHaveLength(1);
    expect(await win.locator('.frame .chip text').allTextContents()).toEqual(['E1']);
    await tool(win, 'Select');
  });

  it('turns a frame into a book exercise and back from its card, with the rules of the core in plain words', async () => {
    const win = (running as Running).win;
    const card = win.locator('.inspector');
    expect(await card.innerText()).toContain('Exercise');
    await card.getByRole('button', { name: 'Make it a book exercise...' }).click();
    expect(await card.locator('input.label-input').inputValue()).toBe('1');
    expect(await card.locator('select').inputValue()).toBe('2.1');
    await card.locator('input.label-input').fill('2');
    await card.getByRole('button', { name: 'Make book exercise' }).click();
    // 2.1 has no exercise 2 yet (the frame drawn with the Exercise tool is not one): the mark worked.
    await win.waitForFunction(() => document.querySelector('.inspector .inspector-title')?.textContent === 'Book exercise');
    expect((await framesOf(win)).find((frame) => frame.page === 2)).toMatchObject({ authority: 'book', label: '2', section: '2.1' });
    expect(await win.locator('.frame .chip text').allTextContents()).toEqual(['2']);
    // Back to an ordinary exercise: positional again.
    await card.getByRole('button', { name: 'Make it an ordinary exercise' }).click();
    await win.waitForFunction(() => document.querySelector('.inspector .inspector-title')?.textContent === 'Exercise');
    expect((await framesOf(win)).find((frame) => frame.page === 2)?.authority).toBeUndefined();
    expect(await win.locator('.frame .chip text').allTextContents()).toEqual(['E1']);
    // A number that is taken: the form says so and nothing changes.
    await gotoPage(win, 0);
    await tool(win, 'Exercise');
    await drag(win, [0.09, 0.6], [0.91, 0.63]);
    await tool(win, 'Select');
    await card.getByRole('button', { name: 'Make it a book exercise...' }).click();
    await card.locator('input.label-input').fill('3b');
    await card.getByRole('button', { name: 'Make book exercise' }).click();
    expect(await card.locator('.form-error').innerText()).toMatch(/already has an exercise 3b/);
    await card.getByRole('button', { name: 'Cancel' }).click();
    await win.keyboard.press('Delete');
  });

  it('saves book exercises as editable objects that the command line reads back, with their labels and sections', async () => {
    const win = (running as Running).win;
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const disk = JSON.parse(readFileSync(join(work, 'book.mcprep.json'), 'utf8')) as { modifiedBy: string; frames: { authority?: string; label?: string; section?: string; unit?: string }[] };
    expect(disk.modifiedBy).toBe('desktop');
    expect(disk.frames.filter((frame) => frame.authority === 'book').map((frame) => `${frame.section}:${frame.label}`).sort()).toEqual(['1.1:1', '1.1:2', '1.1:3a', '1.1:3b', '1.2:1']);
    expect(disk.frames.every((frame) => frame.unit === undefined)).toBe(true);
    const validation = JSON.parse(cli('validate', '--json')) as { ok: boolean };
    expect(validation.ok).toBe(true);
    const listed = JSON.parse(cli('exercises', 'list', '--json')) as { result: { exercises: { label: string }[] } };
    const labels = listed.result.exercises.map((entry) => entry.label).sort();
    expect(labels).toEqual(['1', '1', '2', '3a', '3b']);
  });

  it('shows what an agent changed in a book exercise, its printed number included, without losing the place', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 0);
    cli('exercises', 'label', '1.1:1', '1x');
    await win.waitForSelector('.toast-agent', { timeout: 15000 });
    await win.waitForFunction(() => [...document.querySelectorAll('.frame .chip text')].some((node) => node.textContent === '1x'));
    expect(await stateOf(win, (s) => s['page'])).toBe(0);
    cli('exercises', 'label', '1.1:1x', '1');
    await win.waitForFunction(() => ![...document.querySelectorAll('.frame .chip text')].some((node) => node.textContent === '1x'), undefined, { timeout: 15000 });
  });

  it('keeps the labels beside the frames and readable: nothing overlaps, and a label can be clicked to select', async () => {
    const win = (running as Running).win;
    await tool(win, 'Select');
    const boxes = await win.locator('.frame .chip rect').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    expect(boxes.length).toBe(4);
    for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(11);
    const chip = win.locator('.frame[data-label="3b"] .chip').first();
    await chip.click();
    expect(await stateOf(win, (s) => s['selection'])).toBe(((await framesOf(win)).find((frame) => frame.label === '3b') as { id: string }).id);
  });

  it('raised no errors in the page while all of this happened', () => {
    expect((running as Running).errors.filter((message) => !message.includes('Content Security Policy'))).toEqual([]);
  });
});
