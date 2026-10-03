import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The real application, driven like a person: Electron with the built bundle, a synthetic sample, real mouse and keyboard.
 * Needs `npm run build` and Electron's binary. It does not run in CI (no display); run it with `npm run test:e2e`.
 */
const root = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const appDir = join(root, 'apps/desktop');
const electronPath = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const cliBin = join(root, 'packages/cli/bin/mcprep.js');
const available = existsSync(join(appDir, 'out/main.cjs')) && existsSync(electronPath) && existsSync(join(root, 'packages/cli/dist/index.js'));

let work: string;
let app: ElectronApplication;
let win: Page;
const errors: string[] = [];

const cli = (...args: string[]): string => execFileSync(process.execPath, [cliBin, ...args], { cwd: work, encoding: 'utf8' });
const frames = (): Promise<{ id: string; kind: string; page: number; unit?: string; rect: { left: number; top: number; right: number; bottom: number }; context?: unknown[] }[]> =>
  win.evaluate(() => (window as unknown as { __store: { state: { project: { frames: never[] } } } }).__store.state.project.frames);
const state = <T>(pick: (s: Record<string, unknown>) => T): Promise<T> =>
  win.evaluate(`(${pick.toString()})(window.__store.state)`) as Promise<T>;

/** Page fractions to window coordinates on the overlay of the page that is showing. */
async function at(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await win.locator('svg.overlay').boundingBox();
  if (!box) throw new Error('no page is showing');
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}

async function drag(from: [number, number], to: [number, number]): Promise<void> {
  const a = await at(...from);
  const b = await at(...to);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await win.mouse.move(b.x, b.y, { steps: 4 });
  await win.mouse.up();
}

async function tool(name: string): Promise<void> {
  await win.locator(`button.round[title^="${name}"]`).click();
}

async function openProject(path: string): Promise<void> {
  await win.evaluate((p) => (window as unknown as { __store: { open(o: unknown): Promise<void> }; mcprep: { openPath(p: string): Promise<unknown> } }).mcprep.openPath(p).then((o) => (window as unknown as { __store: { open(o: unknown): Promise<void> } }).__store.open(o)), path);
  await win.waitForSelector('.page canvas');
}

beforeAll(async () => {
  if (!available) return;
  work = mkdtempSync(join(tmpdir(), 'mcprep-desktop-'));
  copyFileSync(join(root, 'examples/sample.pdf'), join(work, 'sheet.pdf'));
  cli('init', 'sheet.pdf', '--title', 'Calculus Sheet 1');
  cli('propose', '--apply');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>;
  // Its own user-data folder: the test must not add its temporary projects to the recent list of the person running it.
  app = await electron.launch({ executablePath: electronPath, args: [appDir, `--user-data-dir=${join(work, 'user-data')}`, join(work, 'sheet.mcprep.json')], env });
  win = await app.firstWindow();
  win.on('pageerror', (error) => errors.push(error.message));
  win.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await win.waitForSelector('.page canvas');
  await win.waitForSelector('.frame');
  await win.waitForFunction(() => document.querySelector('.page canvas') !== null && (document.querySelector('.page canvas') as HTMLCanvasElement).width > 100);
});

afterAll(async () => {
  // A window with unsaved changes asks before it closes; the test is done with it.
  await win?.evaluate(() => window.mcprep.setDirty(false)).catch(() => undefined);
  await app?.close();
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!available)('the desktop app', () => {
  it('opens the project, draws the page with pdf.js and shows the frames with their labels', async () => {
    expect(await win.title()).toBe('Math Canvas Prep');
    await win.waitForFunction(() => {
      const canvas = document.querySelector('.page canvas') as HTMLCanvasElement;
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!data) return false;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4 * 7) if ((data[i] as number) < 100) dark += 1;
      return dark > 200;
    });
    expect(await win.locator('.frame').count()).toBe(2);
    expect(await win.locator('.chip text').allTextContents()).toEqual(expect.arrayContaining(['E1', 'E2', 'E2.1', 'E2.2', 'E2.3']));
    expect(await win.locator('.statusbar').innerText()).toContain('5 exercises');
    await win.waitForSelector('.thumbs .thumb');
    expect(await win.locator('.rail button.round').count()).toBe(8);
    expect(await win.locator('.thumbs .thumb').count()).toBe(3);
    expect(await win.locator('.tab').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('Frames'), expect.stringContaining('Contents'), expect.stringContaining('Checks'), expect.stringContaining('Propose')]));
  });

  it('is locked down: no Node, no network, no navigation, a fixed API and a strict policy', async () => {
    const facts = await win.evaluate(async () => {
      const results: Record<string, unknown> = {};
      results['require'] = typeof (window as unknown as { require?: unknown }).require;
      results['process'] = typeof (window as unknown as { process?: unknown }).process;
      results['api'] = Object.keys((window as unknown as { mcprep: object }).mcprep).sort();
      try {
        await fetch('https://example.com/');
        results['fetch'] = 'allowed';
      } catch {
        results['fetch'] = 'blocked';
      }
      results['csp'] = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
      return results;
    });
    expect(facts['require']).toBe('undefined');
    expect(facts['process']).toBe('undefined');
    expect(facts['fetch']).toBe('blocked');
    expect(String(facts['csp'])).toContain("default-src 'none'");
    expect(String(facts['csp'])).not.toContain("'unsafe-eval'");
    expect(facts['api']).toEqual(['chooseAndOpenPdf', 'chooseAndOpenProject', 'copyToFolder', 'deriveOutline', 'onDiskChange', 'onMenu', 'openPath', 'pageText', 'pathForFile', 'propose', 'readPdf', 'ready', 'recent', 'reloadProject', 'reveal', 'saveProject', 'setDirty', 'exportBundle'].sort());
  });

  it('draws an exercise with the mouse, snaps it to the lines, and undoes and redoes it', async () => {
    const before = (await frames()).length;
    await tool('Exercise');
    await drag([0.1, 0.5], [0.9, 0.6]);
    const after = await frames();
    expect(after).toHaveLength(before + 1);
    const created = after.find((frame) => frame.rect.top > 0.45 && frame.kind === 'exercise' && frame.page === 0);
    expect(created).toBeDefined();
    expect(await state((s) => s['dirty'])).toBe(true);
    expect(await win.locator('.save-state').innerText()).toContain('Unsaved');
    await win.keyboard.press('Control+z');
    expect(await frames()).toHaveLength(before);
    await win.keyboard.press('Control+y');
    expect(await frames()).toHaveLength(before + 1);
  });

  it('makes a one-line frame from a click on a line of text', async () => {
    await tool('Bookmark');
    await win.evaluate(() => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(2));
    await win.waitForFunction(() => (window as unknown as { __store: { state: { texts: Record<number, unknown> } } }).__store.state.texts[2] !== undefined);
    const lines = (await state((s) => (s['texts'] as Record<number, { lines: { text: string; rect: { top: number; bottom: number; left: number; right: number } }[] }>)[2]?.lines)) ?? [];
    const figure = lines.find((line) => line.text.startsWith('Figure 1'));
    expect(figure).toBeDefined();
    const point = await at(((figure?.rect.left ?? 0) + (figure?.rect.right ?? 0)) / 2, ((figure?.rect.top ?? 0) + (figure?.rect.bottom ?? 0)) / 2);
    const before = (await frames()).length;
    await win.mouse.click(point.x, point.y);
    const added = (await frames()).filter((frame) => frame.page === 2 && frame.kind === 'bookmark');
    expect((await frames()).length).toBe(before + 1);
    const line = added.find((frame) => frame.rect.top > 0.45 && frame.rect.top < 0.5);
    expect(line).toBeDefined();
    expect((line?.rect.bottom ?? 0) - (line?.rect.top ?? 0)).toBeLessThan(0.03);
    await win.keyboard.press('Control+z');
    await tool('Select');
  });

  it('moves a frame by dragging it, resizes it by an outward handle and deletes it with the key', async () => {
    await win.evaluate(() => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(1));
    await win.waitForTimeout(300);
    const exercise = (await frames()).find((frame) => frame.page === 1 && frame.kind === 'exercise' && frame.rect.top < 0.3 && frame.rect.top > 0.2);
    expect(exercise).toBeDefined();
    const id = exercise?.id as string;
    const start = exercise?.rect as { left: number; top: number; right: number; bottom: number };
    await drag([(start.left + start.right) / 2, (start.top + start.bottom) / 2], [(start.left + start.right) / 2, (start.top + start.bottom) / 2 + 0.05]);
    const moved = (await frames()).find((frame) => frame.id === id)?.rect as typeof start;
    expect(moved.top - start.top).toBeCloseTo(0.05, 2);
    // The south handle sits below the outline.
    const handle = await win.locator('.handle-s rect').last().boundingBox();
    const frameBox = await win.locator('.frame.selected .body').first().boundingBox();
    expect(handle && frameBox && handle.y > frameBox.y + frameBox.height - 1).toBe(true);
    await win.mouse.move((handle?.x ?? 0) + (handle?.width ?? 0) / 2, (handle?.y ?? 0) + (handle?.height ?? 0) / 2);
    await win.mouse.down();
    await win.mouse.move((handle?.x ?? 0) + (handle?.width ?? 0) / 2, (handle?.y ?? 0) + 30, { steps: 5 });
    await win.mouse.up();
    const grown = (await frames()).find((frame) => frame.id === id)?.rect as typeof start;
    expect(grown.bottom).toBeGreaterThan(moved.bottom + 0.01);
    expect(grown.top).toBeCloseTo(moved.top, 3);
    const count = (await frames()).length;
    await win.keyboard.press('Delete');
    expect(await frames()).toHaveLength(count - 1);
  });

  it('cuts and joins parts with slicers: plus, minus and a drag, and the parts always tile', async () => {
    await win.evaluate(() => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(0));
    await win.waitForTimeout(300);
    const parts = (await frames()).filter((frame) => frame.unit !== undefined && frame.page === 0);
    expect(parts).toHaveLength(3);
    await win.locator('.chip', { hasText: 'E2' }).first().click();
    const plus = win.locator('.frame.unit.selected .round-button', { hasText: '+' });
    await plus.click();
    expect((await frames()).filter((frame) => frame.unit === parts[0]?.unit)).toHaveLength(4);
    await win.locator('.frame.unit.selected .slicer .round-button').first().click();
    expect((await frames()).filter((frame) => frame.unit === parts[0]?.unit)).toHaveLength(3);
    const cut = (await frames()).filter((frame) => frame.unit === parts[0]?.unit).sort((a, b) => a.rect.top - b.rect.top)[1]?.rect.top as number;
    await drag([0.4, cut], [0.4, cut + 0.004]);
    const tiled = (await frames()).filter((frame) => frame.unit === parts[0]?.unit).sort((a, b) => a.rect.top - b.rect.top);
    for (let i = 1; i < tiled.length; i += 1) expect(Math.abs((tiled[i]?.rect.top ?? 0) - (tiled[i - 1]?.rect.bottom ?? 1))).toBeLessThan(0.002);
    expect(await state((s) => (s['validation'] as { ok: boolean }).ok)).toBe(true);
  });

  it('saves atomically, with the project on disk as the CLI sees it', async () => {
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const disk = JSON.parse(readFileSync(join(work, 'sheet.mcprep.json'), 'utf8')) as { modifiedBy: string; revision: number; frames: unknown[] };
    expect(disk.modifiedBy).toBe('desktop');
    expect(disk.frames.length).toBe((await frames()).length);
    expect(JSON.parse(cli('validate', '--json')) as { ok: boolean }).toMatchObject({ ok: true });
    expect(await win.locator('.save-state').innerText()).toContain('Saved');
  });

  it('shows what an agent changed, quietly, without losing its place', async () => {
    const before = (await frames()).length;
    await win.evaluate(() => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(1));
    cli('frames', 'add', '--kind', 'question', '--page', '1', '--rect', '0.1,0.55,0.9,0.62');
    await win.waitForSelector('.toast-agent', { timeout: 15000 });
    expect(await win.locator('.toast-agent').innerText()).toContain('Updated by cli: 1 added');
    // The notice is a readable bar (once it collapsed to a 30 px pill because it shared a class name with the help buttons).
    const toast = await win.locator('.toast-agent').boundingBox();
    expect(toast?.width).toBeGreaterThan(200);
    expect(toast?.height).toBeLessThan(60);
    expect((await frames()).length).toBe(before + 1);
    expect(await state((s) => s['page'])).toBe(1);
    expect(await win.locator('.agent-dot').count()).toBe(1);
    expect(await state((s) => s['dirty'])).toBe(false);
  });

  it('notices a hand edit of the project file even when nobody raised the revision', async () => {
    const path = join(work, 'sheet.mcprep.json');
    const before = (await frames()).length;
    const file = JSON.parse(readFileSync(path, 'utf8')) as { frames: unknown[] };
    file.frames.push({ id: 'hand1', kind: 'question', page: 1, rect: [0.1, 0.66, 0.9, 0.72] });
    writeFileSync(path, JSON.stringify(file, null, 2));
    await expect.poll(async () => (await frames()).length, { timeout: 15000 }).toBe(before + 1);
    expect(await state((s) => s['dirty'])).toBe(false);
    cli('frames', 'delete', 'hand1');
    await expect.poll(async () => (await frames()).length, { timeout: 15000 }).toBe(before);
  });

  it('asks which version to keep when an agent saves while there are unsaved edits', async () => {
    await tool('Bookmark');
    await drag([0.1, 0.4], [0.9, 0.45]);
    expect(await state((s) => s['dirty'])).toBe(true);
    cli('frames', 'add', '--kind', 'question', '--page', '2', '--rect', '0.1,0.7,0.9,0.78');
    await win.waitForSelector('[role="alertdialog"]', { timeout: 15000 });
    expect(await win.locator('[role="alertdialog"]').innerText()).toContain('cli');
    await win.getByText('Keep mine').click();
    await win.keyboard.press('Control+s');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { dirty: boolean } } }).__store.state.dirty === false);
    const disk = JSON.parse(readFileSync(join(work, 'sheet.mcprep.json'), 'utf8')) as { frames: unknown[]; modifiedBy: string };
    expect(disk.modifiedBy).toBe('desktop');
    expect(disk.frames.length).toBe((await frames()).length);
    await tool('Select');
  });

  it('lists the frames, the contents with counts, the checks and lets the contents be edited', async () => {
    await win.locator('.tab', { hasText: 'Frames' }).click();
    expect(await win.locator('.rows .row').count()).toBeGreaterThan(8);
    await win.locator('.tab', { hasText: 'Contents' }).click();
    expect(await win.locator('.outline-row').count()).toBe(4);
    expect(await win.locator('.outline-row').first().innerText()).toMatch(/\d/);
    await win.getByText('Edit PDF bookmarks').click();
    const title = win.locator('.outline-row .title-input').first();
    await title.fill('Renamed chapter');
    await title.press('Enter');
    await win.waitForFunction(() => (window as unknown as { __store: { state: { project: { outline?: { entries: { title: string }[] } } } } }).__store.state.project.outline?.entries[0]?.title === 'Renamed chapter');
    await win.locator('.tab', { hasText: 'Checks' }).click();
    expect(await win.locator('.verdict').innerText()).toContain('No errors');
  });

  it('brings a frame chosen in a list into view and opens every page at its top', async () => {
    await win.locator('.tab', { hasText: 'Frames' }).click();
    await win.evaluate(() => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(0));
    await win.waitForTimeout(300);
    // The row shows the first words of the frame, although the person has not looked at its page yet.
    await win.locator('.side .rows .row', { hasText: 'Exercise 4' }).click();
    await win.waitForFunction(() => (document.querySelector('.page-scroll') as HTMLElement).scrollTop > 0);
    const scroller = await win.locator('.page-scroll').boundingBox();
    const body = await win.locator('.frame.selected .body').first().boundingBox();
    expect(scroller && body && body.y >= scroller.y - 1 && body.y + body.height <= scroller.y + scroller.height + 1).toBe(true);
    await win.getByRole('button', { name: 'Next page' }).click();
    await win.waitForFunction(() => (document.querySelector('.page-scroll') as HTMLElement).scrollTop === 0);
    await win.getByRole('button', { name: 'Previous page' }).click();
    await tool('Select');
  });

  it('exports the bundle after showing the validation, and the importer check accepts it', async () => {
    const out = join(work, 'out.mcbundle');
    await app.evaluate(({ dialog }, path) => {
      (dialog as unknown as { showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }> }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
    }, out);
    await win.keyboard.press('Control+e');
    await win.waitForSelector('[role="dialog"]');
    expect(await win.locator('[role="dialog"]').innerText()).toContain('The importer would accept this project');
    await win.getByRole('button', { name: 'Export...' }).click();
    await win.waitForSelector('.verdict-box.ok[role="status"]', { timeout: 30000 });
    expect(existsSync(out)).toBe(true);
    const check = JSON.parse(cli('import-check', out, '--json')) as { result: { wouldImport: boolean; outline?: unknown[] } };
    expect(check.result.wouldImport).toBe(true);
    expect(check.result.outline).toHaveLength(4);
    await win.getByRole('button', { name: 'Close' }).click();
  });

  it('proposes frames as ghosts and accepts or rejects them one by one or all at once', async () => {
    cli('init', 'sheet.pdf', '--out', 'fresh.mcprep.json', '--title', 'Fresh');
    await openProject(join(work, 'fresh.mcprep.json'));
    expect((await frames()).length).toBe(0);
    await win.locator('.tab', { hasText: 'Propose' }).click();
    await win.getByRole('button', { name: 'Find proposals' }).click();
    await win.waitForSelector('.ghost', { timeout: 60000 });
    expect(await win.locator('.ghost').count()).toBe(2);
    expect(await win.locator('.side .rows .row').count()).toBe(7);
    await win.locator('.ghost .round-button').first().click();
    expect((await frames()).length).toBe(1);
    await win.locator('.side .rows .row .mini-button[aria-label="Reject"]').first().click();
    expect(await win.locator('.side .rows .row').count()).toBe(5);
    await win.getByRole('button', { name: /Accept all/ }).click();
    expect(await win.locator('.side .rows .row').count()).toBe(0);
    expect(await state((s) => (s['validation'] as { ok: boolean }).ok)).toBe(true);
    expect((await frames()).length).toBeGreaterThan(6);
  });

  it('offers the recent projects that still exist, and not the ones that were deleted', async () => {
    cli('init', 'sheet.pdf', '--out', 'gone.mcprep.json', '--title', 'Gone soon');
    await openProject(join(work, 'gone.mcprep.json'));
    const titles = async (): Promise<string[]> => (await win.evaluate(() => window.mcprep.recent())).map((entry) => entry.title);
    expect(await titles()).toContain('Gone soon');
    rmSync(join(work, 'gone.mcprep.json'));
    expect(await titles()).not.toContain('Gone soon');
    await openProject(join(work, 'sheet.mcprep.json'));
  });

  it('does not navigate away and opens no new windows, whatever the page tries', async () => {
    const url = win.url();
    await win.evaluate(() => {
      window.open('https://example.com/', '_blank');
      window.location.href = 'https://example.com/';
    });
    await win.waitForTimeout(800);
    expect(win.url()).toBe(url);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  it('raised no errors in the page while all of this happened (apart from the blocked requests the test made)', () => {
    expect(errors.filter((message) => !message.includes('example.com') && !message.includes('Content Security Policy'))).toEqual([]);
  });
});
