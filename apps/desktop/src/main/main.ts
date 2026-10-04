import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import { configurePdfRuntime } from '@mcprep/core';
import type { OpenOutcome, RecentEntry } from '../shared/api.js';
import { DocumentService } from './service.js';

/**
 * The Electron main process: one window, a custom `mcprep-app://` scheme that serves the editor from the application
 * folder (so that a strict Content-Security-Policy with no network access applies), a minimal typed IPC surface, and the
 * document service. The renderer has no Node access: context isolation, sandbox, no navigation, no new windows, no
 * permissions, and every request to the network is cancelled.
 */

const SCHEME = 'mcprep-app';
const RENDERER_DIR = join(__dirname, 'renderer');
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const service = new DocumentService();
let mainWindow: BrowserWindow | undefined;
let dirty = false;

// --------------------------------------------------------------------------------------------------------- recent files

const recentFile = (): string => join(app.getPath('userData'), 'recent.json');

/** The recent projects that still exist (a project that was moved or deleted is not offered). */
async function readRecent(): Promise<RecentEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentFile(), 'utf8'));
    const list = Array.isArray(parsed) ? (parsed as RecentEntry[]).filter((entry) => typeof entry?.path === 'string').slice(0, 12) : [];
    const present = await Promise.all(list.map((entry) => access(entry.path).then(() => true, () => false)));
    return list.filter((_entry, index) => present[index]);
  } catch {
    return [];
  }
}

async function remember(outcome: OpenOutcome): Promise<void> {
  if (!outcome.ok) return;
  const { projectPath, project } = outcome.document;
  const list = (await readRecent()).filter((entry) => entry.path !== projectPath);
  list.unshift({ path: projectPath, title: project.meta.title, openedAt: new Date().toISOString() });
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2));
}

// -------------------------------------------------------------------------------------------------------------- window

/** Messages for the editor wait until it says it is ready (it registers its listeners after it has started). */
let rendererReady = false;
const waiting: { channel: string; args: unknown[] }[] = [];

function send(channel: string, ...args: unknown[]): void {
  if (!rendererReady) {
    waiting.push({ channel, args });
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Math Canvas Prep',
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Cancel', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'The project has unsaved changes.',
      detail: 'Close the window and lose them?',
    });
    if (choice === 0) event.preventDefault();
  });
  void window.loadURL(`${SCHEME}://app/index.html`);
  return window;
}

function secure(): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function serveRenderer(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '') || 'index.html';
    const file = resolve(RENDERER_DIR, relative);
    if (!file.startsWith(RENDERER_DIR + sep) && file !== RENDERER_DIR) return new Response('Forbidden', { status: 403 });
    try {
      const upstream = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers({ 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ------------------------------------------------------------------------------------------------------------------ IPC

async function chooseAndOpen(kind: 'pdf' | 'project'): Promise<OpenOutcome | null> {
  if (!mainWindow) return null;
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'pdf' ? 'Open a PDF' : 'Open a project',
    properties: ['openFile'],
    filters: kind === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Math Canvas Prep project', extensions: ['json'] }],
  });
  const path = picked.filePaths[0];
  if (picked.canceled || path === undefined) return null;
  return openAndRemember(path);
}

async function openAndRemember(path: string): Promise<OpenOutcome> {
  const outcome = await service.open(path);
  await remember(outcome);
  if (outcome.ok) mainWindow?.setTitle(`${outcome.document.project.meta.title} - Math Canvas Prep`);
  return outcome;
}

function registerIpc(): void {
  const handle = (name: string, listener: (...args: never[]) => unknown): void => {
    ipcMain.handle(`mcprep:${name}`, async (_event, ...args: unknown[]) => (listener as (...inner: unknown[]) => unknown)(...args));
  };
  handle('chooseAndOpenPdf', () => chooseAndOpen('pdf'));
  handle('chooseAndOpenProject', () => chooseAndOpen('project'));
  handle('openPath', (path: string) => openAndRemember(String(path)));
  handle('recent', () => readRecent());
  handle('readPdf', async () => new Uint8Array(await service.readPdf()));
  handle('pageText', (page: number) => service.pageText(Number(page)));
  handle('propose', (request: Parameters<DocumentService['propose']>[0]) => service.propose(request));
  handle('deriveSections', () => service.deriveSections());
  handle('cancelAudit', () => service.cancelAudit());
  handle('saveProject', (project: Parameters<DocumentService['save']>[0], expected: number) => service.save(project, Number(expected)));
  handle('reloadProject', () => service.reload());
  handle('exportBundle', async (options: { outline: 'project' | 'pdf' | 'none' }) => {
    if (!mainWindow) return null;
    const picked = await dialog.showSaveDialog(mainWindow, { title: 'Export the bundle', defaultPath: service.defaultBundlePath(), filters: [{ name: 'Math Canvas bundle', extensions: ['mcbundle'] }] });
    if (picked.canceled || picked.filePath === undefined) return null;
    return service.exportBundle(picked.filePath, options.outline);
  });
  handle('exportBookSummary', async () => {
    if (!mainWindow) return null;
    const picked = await dialog.showSaveDialog(mainWindow, { title: 'Export the book summary', defaultPath: service.defaultSummaryPath(), filters: [{ name: 'Book summary (JSON)', extensions: ['json'] }] });
    if (picked.canceled || picked.filePath === undefined) return null;
    return service.exportBookSummary(picked.filePath);
  });
  handle('copyToFolder', async (path: string) => {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, { title: 'Copy the bundle to a folder', properties: ['openDirectory', 'createDirectory'] });
    const folder = picked.filePaths[0];
    if (picked.canceled || folder === undefined) return null;
    const target = join(folder, basename(String(path)));
    await copyFile(String(path), target);
    return target;
  });
  handle('reveal', (path: string) => {
    shell.showItemInFolder(String(path));
  });
  ipcMain.on('mcprep:ready', () => {
    rendererReady = true;
    for (const message of waiting.splice(0)) send(message.channel, ...message.args);
  });
  ipcMain.on('mcprep:setDirty', (_event, value: unknown) => {
    dirty = value === true;
    mainWindow?.setDocumentEdited(dirty);
  });
  service.onDiskChange = (change) => send('mcprep:diskChange', change);
  service.onProgress = (progress) => send('mcprep:progress', progress);
}

function buildMenu(): void {
  const command = (name: string) => (): void => send('mcprep:menu', name);
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF...', accelerator: 'CmdOrCtrl+O', click: command('open-pdf') },
        { label: 'Open project...', accelerator: 'CmdOrCtrl+Shift+O', click: command('open-project') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: command('save') },
        { label: 'Export bundle...', accelerator: 'CmdOrCtrl+E', click: command('export') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: command('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: command('redo') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: command('zoom-in') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: command('zoom-out') },
        { label: 'Fit width', accelerator: 'CmdOrCtrl+0', click: command('zoom-fit') },
        { label: 'Switch theme', click: command('theme') },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------------------------------------------------- startup

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/**
 * Where pdf.js keeps its fonts and cmaps. In the application folder (also when packaged); when run from the repository, npm
 * keeps one copy for all packages above the application folder. Without the fonts pdf.js measures the text with other
 * metrics, and the lines of a page (and so every proposal and every snapped frame) differ from what the command line sees.
 */
function pdfjsFolder(): string {
  const own = join(app.getAppPath(), 'node_modules', 'pdfjs-dist');
  if (existsSync(join(own, 'standard_fonts'))) return own;
  try {
    return dirname(createRequire(join(app.getAppPath(), 'package.json')).resolve('pdfjs-dist/package.json'));
  } catch {
    return own;
  }
}

app.whenReady().then(() => {
  configurePdfRuntime({ pdfjsRoot: pdfjsFolder() });
  secure();
  serveRenderer();
  registerIpc();
  buildMenu();
  mainWindow = createWindow();
  const argument = process.argv.slice(app.isPackaged ? 1 : 2).find((value) => /\.pdf$|\.mcprep\.json$/i.test(value));
  if (argument !== undefined) send('mcprep:menu', `open-path:${resolve(argument)}`);
  return undefined;
}).catch((error: unknown) => {
  dialog.showErrorBox('Math Canvas Prep could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const argument = argv.find((value) => /\.pdf$|\.mcprep\.json$/i.test(value));
    if (argument !== undefined) send('mcprep:menu', `open-path:${resolve(argument)}`);
  }
});

app.on('window-all-closed', () => {
  void service.close().finally(() => app.quit());
});
