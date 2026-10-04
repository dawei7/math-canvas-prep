import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('asks to select an exercise first when the Solution tool has none to attach to', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 3);
    await tool(win, 'Select');
    await win.keyboard.press('Escape');
    expect(await stateOf(win, (s) => s['selection'])).toBeNull();
    await tool(win, 'Solution');
    expect(await win.locator('.tool-hint').innerText()).toContain('Select an exercise first');
    const answer = placeOf('1.1', '1').solution[0] as Place['solution'][number];
    await drag(win, [answer.rect.left - 0.01, answer.rect.top - 0.003], [answer.rect.right + 0.01, answer.rect.bottom + 0.003]);
    await win.locator('.toast').waitFor();
    expect(await win.locator('.toast').innerText()).toContain('Select an exercise first');
    expect((await framesOf(win)).filter((frame) => (frame.solution?.length ?? 0) > 0)).toHaveLength(0);
  });

  it('attaches the answer from the answer key to the selected exercise: select it, go to the key, draw the answer', async () => {
    const win = (running as Running).win;
    for (const label of ['1', '2', '3a']) {
      const place = placeOf('1.1', label);
      await gotoPage(win, place.page);
      await tool(win, 'Select');
      await click(win, place.rect.left + (place.rect.right - place.rect.left) * 0.3, (place.rect.top + place.rect.bottom) / 2);
      await tool(win, 'Solution');
      const hint = await win.locator('.tool-hint').innerText();
      expect(hint).toContain(`Solution for ${label}`);
      expect(hint).toContain('hidden from the learner');
      // The key is on another page: the exercise stays selected while the page changes.
      await gotoPage(win, 3);
      const answer = place.solution[0] as Place['solution'][number];
      await drag(win, [answer.rect.left - 0.01, answer.rect.top - 0.003], [answer.rect.right + 0.01, answer.rect.bottom + 0.003]);
    }
    const frames = await framesOf(win);
    for (const label of ['1', '2', '3a']) {
      const solution = frames.find((frame) => frame.label === label)?.solution ?? [];
      expect(solution).toHaveLength(1);
      expect(solution[0]?.page).toBe(3);
    }
    expect(frames.filter((frame) => (frame.solution?.length ?? 0) > 0)).toHaveLength(3);
  });

  it('draws the solution regions in a style of their own: green, dashed, with an S marker and the number of the exercise', async () => {
    const win = (running as Running).win;
    await tool(win, 'Select');
    const bodies = win.locator('.region-solution .region-body');
    expect(await bodies.count()).toBe(3);
    expect(await bodies.first().getAttribute('stroke')).toBe('#15803d');
    expect(await bodies.first().getAttribute('stroke-dasharray')).toBe('7 4');
    expect((await win.locator('g[data-owner] .chip text').allTextContents()).sort()).toEqual(['S 1', 'S 2', 'S 3a']);
    // A book exercise is amber and a solution green: never the same colour.
    expect(await win.locator('g[data-owner] .chip rect').first().getAttribute('fill')).toBe('#15803d');
  });

  it('lists the solutions on the exercise, hidden from the learner, and a click on one jumps to it', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 0);
    await tool(win, 'Select');
    const place = placeOf('1.1', '3a');
    await click(win, place.rect.left + (place.rect.right - place.rect.left) * 0.3, (place.rect.top + place.rect.bottom) / 2);
    const list = win.locator('.inspector .region-list-solution');
    expect(await list.locator('.hidden-badge').innerText()).toBe('hidden from the learner');
    expect(await list.locator('.region-item').count()).toBe(1);
    expect(await list.locator('.pill-page').innerText()).toBe('p4');
    expect(await list.locator('.pill-text').innerText()).toContain('3a. -2');
    await list.getByRole('button', { name: 'Remove solution region 1' }).waitFor();
    await list.locator('.region-pill').click();
    await win.waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '3');
    expect(await win.locator('.pulse').count()).toBe(1);
    await win.locator('.inspector').getByRole('button', { name: 'About solution' }).click();
    expect(await win.locator('.inspector .info-pop').innerText()).toContain('never sent to a tutor chat');
  });

  it('selects the exercise a solution region belongs to when the region is clicked, and removes it from the page or from the card', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 3);
    await tool(win, 'Select');
    const answer = placeOf('1.1', '2').solution[0] as Place['solution'][number];
    await click(win, (answer.rect.left + answer.rect.right) / 2, (answer.rect.top + answer.rect.bottom) / 2);
    const two = (await framesOf(win)).find((frame) => frame.label === '2') as { id: string };
    expect(await stateOf(win, (s) => s['selection'])).toBe(two.id);
    // The selected exercise's own region has a button to remove it right there.
    await win.locator('.region-solution.own .region-remove').click();
    expect((await framesOf(win)).find((frame) => frame.label === '2')?.solution).toBeUndefined();
    await win.keyboard.press('Control+z');
    expect((await framesOf(win)).find((frame) => frame.label === '2')?.solution).toHaveLength(1);
    // And from the card.
    await win.locator('.inspector').getByRole('button', { name: 'Remove solution region 1' }).click();
    expect((await framesOf(win)).find((frame) => frame.label === '2')?.solution).toBeUndefined();
    await win.keyboard.press('Control+z');
    expect((await framesOf(win)).filter((frame) => (frame.solution?.length ?? 0) > 0)).toHaveLength(3);
  });

  it('writes the solutions into the project file, where the command line lists them as the answer key', async () => {
    const win = (running as Running).win;
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const validation = JSON.parse(cli('validate', '--json')) as { ok: boolean };
    expect(validation.ok).toBe(true);
    const text = JSON.stringify((JSON.parse(cli('solution', 'list', '--json')) as { result: unknown }).result);
    for (const label of ['1', '2', '3a']) expect(text).toContain(`"label":"${label}"`);
  });

  it('lists the sections as a tree: printed number, title, id, page, the book exercises under each and how many have a solution', async () => {
    const win = (running as Running).win;
    await gotoPage(win, 0);
    await tool(win, 'Select');
    await win.keyboard.press('Escape');
    await win.locator('.tab', { hasText: 'Sections' }).click();
    expect(await win.locator('.section-row').count()).toBe(6);
    expect(await win.locator('.tab.active .badge').innerText()).toBe('6');
    const one = win.locator('.section-row', { hasText: 'id 1.1' });
    const text = await one.innerText();
    expect(text).toContain('1.1');
    expect(text).toContain('Adding integers');
    expect(text).toContain('p1');
    expect(await one.locator('.count.book').innerText()).toBe('📖 4');
    expect(await one.locator('.coverage').innerText()).toBe('🔑 3/4');
    // A chapter counts what is below it: none of its own, five in all, three with a solution.
    const chapter = win.locator('.section-row', { hasText: 'id c1' });
    expect(await chapter.locator('.count.book').innerText()).toBe('📖 0 (5)');
    expect(await chapter.locator('.coverage').innerText()).toBe('🔑 3/5');
    expect(await win.locator('.section-chip').first().innerText()).toBe('Chapter 1');
    // What is still to do: sections without exercises, and exercises without a solution.
    expect(await win.locator('.warn-line.note').first().innerText()).toContain('3 of 6 sections have no exercises yet');
    await win.locator('.sections-panel select[aria-label="Which sections to show"]').selectOption('empty');
    expect(await win.locator('.section-row').count()).toBe(3);
    await win.locator('.sections-panel select[aria-label="Which sections to show"]').selectOption('unsolved');
    expect((await win.locator('.section-row .section-sub').allInnerTexts()).map((entry) => entry.split('\n')[0])).toEqual(['id 1.1', 'id 1.2']);
    await win.locator('.sections-panel select[aria-label="Which sections to show"]').selectOption('all');
    // A folded chapter hides its sections.
    await chapter.getByRole('button', { name: 'Fold' }).click();
    expect(await win.locator('.section-row').count()).toBe(4);
    await chapter.getByRole('button', { name: 'Unfold' }).click();
    expect(await win.locator('.section-row').count()).toBe(6);
  });

  it('goes to the heading of a section when its row is clicked, and marks the headings on the page', async () => {
    const win = (running as Running).win;
    await win.locator('.section-row', { hasText: 'id 2.1' }).click();
    await win.waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '2');
    expect(await stateOf(win, (s) => s['sectionSelection'])).toBe(4);
    expect(await win.locator('.section-mark').count()).toBe(2);
    expect(await win.locator('.section-mark.selected text').textContent()).toBe('2.1 (2.1)');
    expect(await win.locator('.section-editor input[aria-label="Title"]').inputValue()).toBe('2.1 Equivalent fractions');
    await win.locator('.section-row', { hasText: 'id answers' }).click();
    await win.waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '3');
  });

  it('adds, edits, makes deeper and shallower, moves and deletes a section, saying in plain words what cannot be done', async () => {
    const win = (running as Running).win;
    await win.locator('.section-row', { hasText: 'id 2.1' }).click();
    await win.getByRole('button', { name: 'Add a section', exact: true }).click();
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Title');
    await win.keyboard.type('Review');
    await win.keyboard.press('Enter');
    let entries = await stateOf(win, (s) => (s['project'] as { outline: { entries: { title: string; depth: number; id?: string; page: number }[] } }).outline.entries);
    expect(entries.map((entry) => entry.title)).toEqual(['Chapter 1 Integers', '1.1 Adding integers', '1.2 Subtracting integers', 'Chapter 2 Fractions', '2.1 Equivalent fractions', 'Review', 'Answers']);
    expect(entries[5]).toMatchObject({ depth: 1, page: 2 });
    expect(entries[5]?.id).toBeUndefined();
    // A section without an id cannot hold exercises: the list says so and offers ids.
    expect(await win.locator('.warn-line', { hasText: 'has no id' }).innerText()).toContain('1 section has no id');
    await win.locator('.section-editor input[aria-label="Printed number"]').fill('R');
    await win.locator('.section-editor input[aria-label="Printed number"]').press('Enter');
    await win.locator('.sections-panel').getByRole('button', { name: 'Give ids (1)' }).click();
    entries = await stateOf(win, (s) => (s['project'] as { outline: { entries: { title: string; depth: number; id?: string; page: number }[] } }).outline.entries);
    expect(entries[5]?.id).toBe('R');
    // An id that another section has is refused, in plain words, and nothing changes.
    await win.locator('.section-editor input[aria-label="Id"]').fill('c1');
    await win.locator('.section-editor input[aria-label="Id"]').press('Enter');
    expect(await win.locator('.section-editor .form-error').innerText()).toContain('already the id of another outline entry');
    expect(await win.locator('.section-editor .form-error').innerText()).not.toMatch(/mcprep|`/);
    await win.locator('.section-editor input[aria-label="Id"]').fill('review');
    await win.locator('.section-editor input[aria-label="Id"]').press('Enter');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { project: { outline: { entries: { id?: string }[] } } } } }).__store.state.project.outline.entries[5]?.id === 'review');
    expect(await win.locator('.section-editor .form-error').count()).toBe(0);
    // Where it starts: page 3, a third of the way down.
    await win.locator('.section-editor input[aria-label="Page"]').fill('3');
    await win.locator('.section-editor input[aria-label="Page"]').press('Enter');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').fill('0.33');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').press('Enter');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').fill('7');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').press('Enter');
    expect(await win.locator('.section-editor .form-error').innerText()).toContain('from 0');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').fill('0.33');
    await win.locator('.section-editor input[aria-label="Top of the heading"]').press('Enter');
    entries = await stateOf(win, (s) => (s['project'] as { outline: { entries: { title: string; depth: number; id?: string; page: number; top?: number; label?: string }[] } }).outline.entries);
    expect(entries[5]).toMatchObject({ title: 'Review', id: 'review', label: 'R', page: 2, top: 0.33 });
    // One level shallower and back: with everything below it.
    await win.locator('.section-editor').getByRole('button', { name: 'Outdent' }).click();
    expect(((await stateOf(win, (s) => (s['project'] as { outline: { entries: { depth: number }[] } }).outline.entries))[5] as { depth: number }).depth).toBe(0);
    expect(await win.locator('.section-editor').getByRole('button', { name: 'Outdent' }).isDisabled()).toBe(true);
    await win.locator('.section-editor').getByRole('button', { name: 'Indent' }).click();
    expect(((await stateOf(win, (s) => (s['project'] as { outline: { entries: { depth: number }[] } }).outline.entries))[5] as { depth: number }).depth).toBe(1);
    // Moved up past its sibling, and down again.
    await win.locator('.section-editor').getByRole('button', { name: 'Move up' }).click();
    expect(((await stateOf(win, (s) => (s['project'] as { outline: { entries: { id?: string }[] } }).outline.entries))[4] as { id?: string }).id).toBe('review');
    await win.locator('.section-editor').getByRole('button', { name: 'Move down' }).click();
    // Deleted: it holds no exercise, so nothing has to move.
    await win.locator('.section-editor').getByRole('button', { name: 'Delete...' }).click();
    await win.locator('.delete-panel').getByRole('button', { name: 'Delete the section' }).click();
    await win.waitForFunction(() => (window as unknown as { __store: { state: { project: { outline: { entries: unknown[] } } } } }).__store.state.project.outline.entries.length === 6);
    expect(await win.locator('.section-row').count()).toBe(6);
    expect(await win.locator('.section-editor').count()).toBe(0);
  });

  it('moves the exercises of a section to another before it is deleted, and one undo brings it all back', async () => {
    const win = (running as Running).win;
    await win.locator('.section-row', { hasText: 'id 1.2' }).click();
    await win.locator('.section-editor').getByRole('button', { name: 'Delete...' }).click();
    const panel = win.locator('.delete-panel');
    expect(await panel.innerText()).toContain('1 book exercise is filed here');
    expect(await panel.getByRole('button', { name: 'Delete the section' }).isDisabled()).toBe(true);
    await panel.locator('select').selectOption('2.1');
    await panel.getByRole('button', { name: 'Delete the section' }).click();
    await win.waitForFunction(() => (window as unknown as { __store: { state: { project: { outline: { entries: unknown[] } } } } }).__store.state.project.outline.entries.length === 5);
    const moved = (await framesOf(win)).find((frame) => frame.page === 1 && frame.authority === 'book');
    expect(moved).toMatchObject({ section: '2.1', label: '1' });
    await win.keyboard.press('Control+z');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { project: { outline: { entries: unknown[] } } } } }).__store.state.project.outline.entries.length === 6);
    expect((await framesOf(win)).find((frame) => frame.page === 1 && frame.authority === 'book')).toMatchObject({ section: '1.2', label: '1' });
  });

  it('sets where a heading is from a click on the page', async () => {
    const win = (running as Running).win;
    await win.locator('.section-row', { hasText: 'id 2.1' }).click();
    await win.locator('.section-editor').getByRole('button', { name: 'Pick the heading on the page' }).click();
    expect(await win.locator('.tool-hint').innerText()).toContain('Click the heading of');
    await win.waitForFunction(() => document.querySelector('.page')?.getAttribute('data-page') === '2');
    // The heading "2.1  Equivalent fractions" is printed 230 points down on an 842 point page.
    await click(win, 0.3, 227 / 842);
    await win.waitForFunction(() => (window as unknown as { __store: { state: { picking: unknown } } }).__store.state.picking === null);
    const top = ((await stateOf(win, (s) => (s['project'] as { outline: { entries: { id?: string; top?: number }[] } }).outline.entries)).find((entry) => entry.id === '2.1') as { top: number }).top;
    expect(top).toBeGreaterThan(0.24);
    expect(top).toBeLessThan(0.28);
    expect(await win.locator('.tool-hint').count()).toBe(0);
  });

  it('writes the sections with their ids, printed numbers and heading positions into the project file', async () => {
    const win = (running as Running).win;
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const disk = JSON.parse(readFileSync(join(work, 'book.mcprep.json'), 'utf8')) as { outline: { source: string; entries: { id?: string; label?: string; top?: number }[] } };
    expect(disk.outline.source).toBe('manual');
    expect(disk.outline.entries.map((entry) => entry.id)).toEqual(['c1', '1.1', '1.2', 'c2', '2.1', 'answers']);
    expect(disk.outline.entries.every((entry) => entry.top !== undefined)).toBe(true);
    expect(JSON.parse(cli('validate', '--json')) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('edits what the bundle says about the work: licence, source and the notice the licence asks for, with plain messages', async () => {
    const win = (running as Running).win;
    await win.getByRole('button', { name: 'Document info' }).click();
    const dialog = win.locator('[role="dialog"][aria-label="Document information"]');
    expect(await dialog.locator('input[aria-label="Title"]').inputValue()).toBe('Pre-Algebra Workbook');
    await dialog.locator('input[aria-label="Author"]').fill('A. Author');
    await dialog.locator('input[aria-label="Licence"]').fill('CC BY 3.0');
    await dialog.locator('input[aria-label="Licence address"]').fill('https://creativecommons.org/licenses/by/3.0/');
    await dialog.locator('input[aria-label="Source address"]').fill('example.org/the-workbook');
    expect(await dialog.locator('.form-error').innerText()).toContain('starting with http:// or https://');
    expect(await dialog.getByRole('button', { name: 'Save' }).isDisabled()).toBe(true);
    await dialog.locator('input[aria-label="Source address"]').fill('https://example.org/the-workbook');
    await dialog.locator('textarea[aria-label="Notice"]').fill('Attribution: A. Author, Pre-Algebra Workbook, CC BY 3.0. Changes: marked for study.');
    await dialog.locator('input[aria-label="Series"]').fill('Prerequisites');
    await dialog.locator('input[aria-label="Folder"]').fill('Books\\Algebra');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await win.waitForSelector('[role="dialog"][aria-label="Document information"]', { state: 'detached' });
    const meta = await stateOf(win, (s) => (s['project'] as { meta: Record<string, unknown> }).meta);
    expect(meta).toMatchObject({
      title: 'Pre-Algebra Workbook',
      folder: 'Books/Algebra',
      author: 'A. Author',
      series: 'Prerequisites',
      license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
      sourceUrl: 'https://example.org/the-workbook',
      notice: 'Attribution: A. Author, Pre-Algebra Workbook, CC BY 3.0. Changes: marked for study.',
    });
    expect(await stateOf(win, (s) => s['dirty'])).toBe(true);
    // Escape closes it without a change.
    await win.getByRole('button', { name: 'Document info' }).click();
    await win.locator('input[aria-label="Author"]').fill('Somebody else');
    await win.keyboard.press('Escape');
    await win.waitForSelector('[role="dialog"][aria-label="Document information"]', { state: 'detached' });
    expect(((await stateOf(win, (s) => (s['project'] as { meta: { author: string } }).meta)) as { author: string }).author).toBe('A. Author');
  });

  it('shows the parts of the format the bundle uses, what it holds per section and the importer check, and writes the bundle and the summary', async () => {
    const { app, win } = running as Running;
    const bundle = join(work, 'book.mcbundle');
    const summaryPath = join(work, 'book.book.json');
    await app.evaluate(({ dialog }, paths) => {
      (dialog as unknown as { showSaveDialog: (_window: unknown, options: { filters?: { extensions: string[] }[] }) => Promise<{ canceled: boolean; filePath: string }> }).showSaveDialog = (_window, options) =>
        Promise.resolve({ canceled: false, filePath: options.filters?.[0]?.extensions[0] === 'json' ? paths.summary : paths.bundle });
    }, { bundle, summary: summaryPath });
    await win.keyboard.press('Control+e');
    const dialog = win.locator('[role="dialog"][aria-label="Export the bundle"]');
    await dialog.waitFor();
    const facts = await dialog.locator('.facts').innerText();
    expect(facts).toContain('5 in 2 sections: 3 with a solution (60%), 2 without');
    expect(await dialog.locator('.feature').allInnerTexts()).toEqual(['Sections', 'Book exercises', 'Hidden solutions']);
    const rows = await dialog.locator('.section-table tbody tr').allInnerTexts();
    expect(rows.map((row) => row.replace(/\s+/g, ' ').trim())).toEqual(['Chapter 1 Integers 0 (5) 3/5', '1.1 Adding integers 4 3/4', '1.2 Subtracting integers 1 0/1']);
    expect(await dialog.innerText()).toContain('The importer would accept this project');
    // The book exercises are filed under the project's own sections: the other contents are not offered.
    expect(await dialog.locator('input[type="radio"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).disabled))).toEqual([false, true, true]);
    await dialog.getByRole('button', { name: 'Export bundle...' }).click();
    await dialog.locator('.verdict-box.ok[role="status"]').waitFor({ timeout: 30000 });
    const checked = await dialog.locator('.importer-check').innerText();
    expect(checked).toContain('The importer check passed');
    expect(checked).toContain('Sections, Book exercises, Hidden solutions');
    expect(existsSync(bundle)).toBe(true);
    const inspected = JSON.parse(cli('inspect-bundle', bundle, '--json')) as { result: { manifest: { features: string[]; document: { author: string; license: { name: string }; notice: string } }; summary: { totals: { exercises: number; withSolution: number; sections: number } } } };
    expect(inspected.result.manifest.features).toEqual(['sections', 'authority', 'solution']);
    expect(inspected.result.manifest.document).toMatchObject({ author: 'A. Author', license: { name: 'CC BY 3.0' }, notice: 'Attribution: A. Author, Pre-Algebra Workbook, CC BY 3.0. Changes: marked for study.' });
    expect(inspected.result.summary.totals).toMatchObject({ exercises: 5, withSolution: 3, sections: 6 });
    // The summary next to it: the same plain JSON as `book export`, with each section's exercises.
    await dialog.getByRole('button', { name: 'Export book summary (JSON)...' }).click();
    await dialog.locator('.summary-result').waitFor({ timeout: 30000 });
    expect(await dialog.locator('.summary-result').innerText()).toContain('6 sections, 5 book exercises');
    const written = JSON.parse(readFileSync(summaryPath, 'utf8')) as { format: string; totals: { exercises: number }; document: { author: string }; sections: { id?: string; items?: { label: string }[] }[] };
    expect(written.format).toBe('math-canvas-book-summary');
    expect(written.document.author).toBe('A. Author');
    expect(written.sections.find((section) => section.id === '1.1')?.items?.map((item) => item.label)).toEqual(['1', '2', '3a', '3b']);
    const fromCli = (JSON.parse(cli('book', 'show', '--json', '--exercises')) as { result: unknown }).result;
    expect(written).toEqual(fromCli);
    await dialog.getByRole('button', { name: 'Close' }).click();
    // The export saved what was unsaved first.
    expect(await stateOf(win, (s) => s['dirty'])).toBe(false);
  });

  it('raised no errors in the page while all of this happened', () => {
    expect((running as Running).errors.filter((message) => !message.includes('Content Security Policy'))).toEqual([]);
  });
});
