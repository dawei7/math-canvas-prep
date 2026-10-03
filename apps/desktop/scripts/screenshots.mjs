// Takes the screenshots of docs/DESKTOP.md from the synthetic sample, by driving the built app with Playwright.
// Needs `npm run build` and Electron's binary.   npm run screenshots --workspace @mcprep/desktop
/* global window, document -- the callbacks given to `evaluate` run in the app's window, not in Node */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const images = join(root, 'docs/img');
const work = mkdtempSync(join(tmpdir(), 'mcprep-shots-'));
mkdirSync(images, { recursive: true });
copyFileSync(join(root, 'examples/sample.pdf'), join(work, 'sheet.pdf'));
const cli = (...args) => execFileSync(process.execPath, [join(root, 'packages/cli/bin/mcprep.js'), ...args], { cwd: work, encoding: 'utf8' });
cli('init', 'sheet.pdf', '--title', 'Calculus Sheet 1', '--folder', 'Examples/Calculus');
cli('propose', '--apply');
cli('outline', 'pdf', '--adopt');
cli('init', 'sheet.pdf', '--out', 'fresh.mcprep.json', '--title', 'Calculus Sheet 1');

const electronPath = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined));
const app = await electron.launch({ executablePath: electronPath, args: [join(root, 'apps/desktop'), join(work, 'sheet.mcprep.json')], env });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  const [window] = BrowserWindow.getAllWindows();
  window?.setContentSize(1360, 840);
  window?.center();
});
await win.waitForSelector('.page canvas');
await win.waitForSelector('.thumbs .thumb');
await win.waitForTimeout(1500);

const shot = async (name) => {
  await win.evaluate(() => window.__store.dismissNotice());
  await win.waitForTimeout(500);
  // The status bar shows the project's real path, which is a temporary folder under the user's profile: show a neutral
  // path in the picture so that no user name ends up in the repository.
  await win.evaluate(() => {
    const path = document.querySelector('.statusbar .path');
    if (path) path.textContent = 'C:\\Books\\Calculus\\sheet.mcprep.json';
  });
  await win.screenshot({ path: join(images, `${name}.png`) });
  console.log(`wrote docs/img/${name}.png`);
};

// 1. The editor with the first page: the unit E2 selected, with its slicers and handles.
await win.locator('.chip', { hasText: 'E2' }).first().click();
await shot('desktop-editor');

// 2. Page 2 in the dark theme: the instruction (dashed) that Exercises 3 and 4 share, exercise 3 selected.
await win.evaluate(() => {
  window.__store.setTheme('dark');
  window.__store.setPage(1);
});
await win.waitForTimeout(500);
await win.evaluate(() => {
  const frame = window.__store.state.project.frames.find((entry) => entry.page === 1 && entry.context);
  window.__store.select(frame.id, { jump: true }); // as a click in the frame list: the frame is scrolled into view
});
await shot('desktop-dark');

// 3. The contents panel with its counts.
await win.evaluate(() => {
  window.__store.setTheme('light');
  window.__store.setPage(0);
  window.__store.setTab('contents');
});
await shot('desktop-contents');

// 4. Proposals as ghost frames on a project without frames.
await win.evaluate((path) => window.mcprep.openPath(path).then((outcome) => window.__store.open(outcome)), join(work, 'fresh.mcprep.json'));
await win.waitForSelector('.thumbs .thumb');
await win.evaluate(() => window.__store.runPropose());
await win.waitForSelector('.ghost');
await shot('desktop-propose');

// 5. The export dialog with the validation shown first.
await win.evaluate(() => window.__store.acceptAll());
await win.evaluate(() => {
  window.__store.setTab('frames');
  window.__store.openExport();
});
await shot('desktop-export');

await win.evaluate(() => window.mcprep.setDirty(false));
await app.close();
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
