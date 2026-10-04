import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

/**
 * What the end-to-end tests share: where the built application and the command line are, how to start the application
 * with a project and its own user-data folder, and how to drive the page like a person (page fractions to mouse positions).
 */
export const root = new URL('../../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const appDir = join(root, 'apps/desktop');
export const electronPath = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
export const cliBin = join(root, 'packages/cli/bin/mcprep.js');
export const available = existsSync(join(appDir, 'out/main.cjs')) && existsSync(electronPath) && existsSync(join(root, 'packages/cli/dist/index.js'));

export interface Running {
  app: ElectronApplication;
  win: Page;
  /** Messages the page logged as errors or threw. */
  errors: string[];
}

/** The `mcprep` command line, run in a folder. */
export const cliIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync(process.execPath, [cliBin, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export async function launch(work: string, project: string): Promise<Running> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>;
  // Its own user-data folder: a test must not add its temporary projects to the recent list of the person running it.
  const app = await electron.launch({ executablePath: electronPath, args: [appDir, `--user-data-dir=${join(work, 'user-data')}`, project], env });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (error) => errors.push(error.message));
  win.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await win.waitForSelector('.page canvas');
  await win.waitForFunction(() => (document.querySelector('.page canvas') as HTMLCanvasElement | null)?.width !== undefined && (document.querySelector('.page canvas') as HTMLCanvasElement).width > 100);
  return { app, win, errors };
}

export async function close(running: Running | undefined): Promise<void> {
  // A window with unsaved changes asks before it closes; the test is done with it.
  await running?.win.evaluate(() => window.mcprep.setDirty(false)).catch(() => undefined);
  await running?.app.close();
}

/** Page fractions to window coordinates on the overlay of the page that is showing. */
export async function at(win: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await win.locator('svg.overlay').boundingBox();
  if (!box) throw new Error('no page is showing');
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}

export async function drag(win: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await at(win, ...from);
  const b = await at(win, ...to);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await win.mouse.move(b.x, b.y, { steps: 4 });
  await win.mouse.up();
}

export async function click(win: Page, x: number, y: number): Promise<void> {
  const point = await at(win, x, y);
  await win.mouse.click(point.x, point.y);
}

export async function tool(win: Page, name: string): Promise<void> {
  await win.locator(`button.round[title^="${name}"]`).click();
}

export interface TestFrame {
  id: string;
  kind: string;
  page: number;
  unit?: string;
  authority?: string;
  label?: string;
  section?: string;
  rect: { left: number; top: number; right: number; bottom: number };
  context?: { page: number; rect: TestFrame['rect'] }[];
  continues?: { page: number; rect: TestFrame['rect'] }[];
  solution?: { page: number; rect: TestFrame['rect'] }[];
}

export const framesOf = (win: Page): Promise<TestFrame[]> => win.evaluate(() => (window as unknown as { __store: { state: { project: { frames: never[] } } } }).__store.state.project.frames);

export const stateOf = <T>(win: Page, pick: (s: Record<string, unknown>) => T): Promise<T> => win.evaluate(`(${pick.toString()})(window.__store.state)`) as Promise<T>;

export const gotoPage = async (win: Page, page: number): Promise<void> => {
  await win.evaluate((n) => (window as unknown as { __store: { setPage(n: number): void } }).__store.setPage(n), page);
  await win.waitForFunction((n) => document.querySelector('.page')?.getAttribute('data-page') === String(n), page);
  await win.waitForTimeout(150);
};

export async function openProject(win: Page, path: string): Promise<void> {
  await win.evaluate(
    (p) =>
      (window as unknown as { mcprep: { openPath(p: string): Promise<unknown> } }).mcprep
        .openPath(p)
        .then((outcome) => (window as unknown as { __store: { open(o: unknown): Promise<void> } }).__store.open(outcome)),
    path,
  );
  await win.waitForSelector('.page canvas');
}
