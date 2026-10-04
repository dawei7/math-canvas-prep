// Takes the screenshots of docs/DESKTOP.md from the synthetic samples (examples/sample.pdf and examples/workbook), by
// driving the built app with Playwright. Needs `npm run build` and Electron's binary.
//   npm run screenshots --workspace @mcprep/desktop
/* global window, document -- the callbacks given to `evaluate` run in the app's window, not in Node */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// The workbook comes after the commands above (a folder with two projects makes the command line ask which one).
copyFileSync(join(root, 'examples/workbook/workbook.pdf'), join(work, 'workbook.pdf'));
copyFileSync(join(root, 'examples/workbook/workbook.mcprep.json'), join(work, 'workbook.mcprep.json'));

const electronPath = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined));
// Its own user-data folder, so that taking pictures does not change the recent list of the person who runs this.
const app = await electron.launch({ executablePath: electronPath, args: [join(root, 'apps/desktop'), `--user-data-dir=${join(work, 'user-data')}`, join(work, 'sheet.mcprep.json')], env });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  const [window] = BrowserWindow.getAllWindows();
  window?.setContentSize(1360, 840);
  window?.center();
});
await win.waitForSelector('.page canvas');
await win.waitForSelector('.thumbs .thumb');
await win.waitForTimeout(1500);

const shot = async (name, path = 'C:\\Books\\Calculus\\sheet.mcprep.json') => {
  await win.evaluate(() => window.__store.dismissNotice());
  await win.waitForTimeout(500);
  // The status bar shows the project's real path, which is a temporary folder under the user's profile: show a neutral
  // path in the picture so that no user name ends up in the repository.
  await win.evaluate((neutral) => {
    const path = document.querySelector('.statusbar .path');
    if (path) path.textContent = neutral;
  }, path);
  await win.screenshot({ path: join(images, `${name}.png`) });
  console.log(`wrote docs/img/${name}.png`);
};

// 1. The editor with the first page: the unit E2 selected, with its slicers and handles.
await win.locator('.page .chip', { hasText: 'E2' }).first().click();
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

// 3. Proposals as ghost frames on a project without frames.
await win.evaluate(() => {
  window.__store.setTheme('light');
  window.__store.select(null);
});
await win.evaluate((path) => window.mcprep.openPath(path).then((outcome) => window.__store.open(outcome)), join(work, 'fresh.mcprep.json'));
await win.waitForSelector('.thumbs .thumb');
await win.evaluate(() => window.__store.runPropose());
await win.waitForSelector('.ghost');
await shot('desktop-propose');

// 4. The export dialog of an ordinary project, with the validation shown first.
await win.evaluate(() => window.__store.acceptAll());
await win.evaluate(() => {
  window.__store.setTab('frames');
  window.__store.openExport();
});
await shot('desktop-export');
await win.evaluate(() => window.__store.closeExport());

// 5. The audit of a book (the synthetic workbook): a book exercise selected, with its context and its hidden solution,
//    the Frames list by section, and on the page the printed numbers of the exercises.
await win.evaluate((path) => window.mcprep.openPath(path).then((outcome) => window.__store.open(outcome)), join(work, 'workbook.mcprep.json'));
await win.waitForSelector('.frame.book');
await win.waitForTimeout(800);
await win.evaluate(() => {
  const frame = window.__store.state.project.frames.find((entry) => entry.label === '3a');
  window.__store.select(frame.id, { jump: true });
});
await win.waitForSelector('.inspector .region-list-solution');
await shot('desktop-book', 'C:\\Books\\Algebra\\workbook.mcprep.json');

// 6. The Sections list: the outline as a tree with the number of book exercises under each section and how many have a
//    solution; the heading of the selected section marked on its page.
await win.evaluate(() => {
  window.__store.select(null);
  window.__store.setTab('sections');
});
await win.locator('.section-row', { hasText: 'id 1.2' }).click();
await win.waitForSelector('.section-editor');
await shot('desktop-sections', 'C:\\Books\\Algebra\\workbook.mcprep.json');

// 7. The export dialog of the book: the parts of the format it uses, what it holds per section, the importer's verdict.
await win.evaluate(() => {
  window.__store.select(null);
  window.__store.setTab('frames');
  window.__store.openExport();
});
await shot('desktop-book-export', 'C:\\Books\\Algebra\\workbook.mcprep.json');

// 8. Deriving the sections of a book (the synthetic textbook): what the search found, with the evidence of the one that is looked at,
//    compared with the sections the project has (none yet), and its heading marked on the page.
await win.evaluate(() => window.__store.closeExport());
const testing = await import(pathToFileURL(join(root, 'packages/core/dist/testing.js')).href);
writeFileSync(join(work, 'textbook.pdf'), testing.buildSyntheticBook().pdf);
await win.evaluate((path) => window.mcprep.openPath(path).then((outcome) => window.__store.open(outcome)), join(work, 'textbook.pdf'));
await win.waitForSelector('.thumbs .thumb');
await win.evaluate(() => window.__store.setTab('sections'));
await win.getByRole('button', { name: 'Derive sections' }).click();
await win.waitForSelector('.derive-review');
await win.locator('.derive-row', { hasText: 'Whole Numbers' }).click();
await win.waitForSelector('.derive-detail');
await win.waitForTimeout(900);
await shot('desktop-derive', 'C:\\Books\\Algebra\\textbook.mcprep.json');

// 9. The numbered exercises of the practice sets, found in the book: ghosts with the printed numbers and the instruction above
//    them, the list with the state of each against the book, one of them looked at.
await win.getByRole('button', { name: 'Accept all' }).click();
await win.getByRole('tab', { name: /Propose/ }).click();
await win.getByRole('button', { name: 'Book exercises', exact: true }).click();
await win.getByRole('button', { name: 'Find the exercises' }).click();
await win.waitForSelector('.book-row');
await win.locator('.book-row').nth(2).click();
await win.waitForSelector('.book-ghost');
await win.waitForTimeout(900);
await shot('desktop-book-propose', 'C:\\Books\\Algebra\\textbook.mcprep.json');

await win.evaluate(() => window.mcprep.setDirty(false));
await app.close();
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
