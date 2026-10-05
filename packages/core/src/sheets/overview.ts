import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs/atomic.js';
import type { PdfDocument } from '../pdf/document.js';
import { overlayFont, renderRegionCanvas, type DrawnView } from '../pdf/render.js';
import { loadCanvas } from '../pdf/runtime.js';
import { McPrepError } from '../rules/issues.js';

/**
 * Overview sheets: every page of a book, or a range of pages, drawn small and several side by side on a sheet, each under its
 * caption ("p. 12", the zero-based page) and inside a thin border, in the order of the book, a fixed number to a sheet. They show the
 * structure of the pages (headings, boxes, numbered items, figures, an answer key, two columns) so that one picture shows eight
 * pages instead of one. The large print can be read and small print cannot, so a page that matters is looked at at reading size
 * with `render`.
 * The sheets are files (`overview-0001.png`, ...) and `overview.json` lists which pages are on each of them and how the cells are
 * laid out. Each page is drawn once, at the size of its cell, and every sheet is written as soon as its pages are drawn, so the
 * memory used does not depend on the length of the book. The same PDF and options give the same files.
 */

export const OVERVIEW_FORMAT = 'math-canvas-overview';
export const OVERVIEW_VERSION = 1;
export const OVERVIEW_FILE = 'overview.json';
export const OVERVIEW_DEFAULTS = { perSheet: 8, columns: 4, cellWidth: 380 } as const;
export const OVERVIEW_LIMITS = { perSheet: 12, columns: 12, minScale: 0.2, maxScale: 2, maxPixels: 40_000_000 } as const;

/** The white between the cells and round the sheet, the strip of the caption above a page, and the border round a page, in pixels. */
const GAP = 8;
const CAPTION = 22;
const BORDER = 1;
/** How many pages are measured to find the size that most pages of the range have. */
const SIZE_SAMPLE = 32;
/** The longest side of an image that most vision models take in without reducing it. */
const COMFORTABLE_SIDE = 1568;

export interface OverviewOptions {
  /** The first page drawn (zero-based; default 0). */
  from?: number;
  /** The last page drawn (zero-based, inclusive; default the last page of the PDF). */
  to?: number;
  /** Pages on a sheet, at most (default 8, at most 12). */
  perSheet?: number;
  /** Pages side by side (default 4; a sheet is never wider than its number of pages). */
  columns?: number;
  /** Pixels per point for a page of the usual size (default: a cell about 380 pixels wide). */
  scale?: number;
}

export interface OverviewSheet {
  /** 1 is the first. */
  number: number;
  file: string;
  /** The zero-based pages on the sheet, in the order of the cells: left to right, then the next row. */
  pages: number[];
  width: number;
  height: number;
}

export interface OverviewManifest {
  format: typeof OVERVIEW_FORMAT;
  version: typeof OVERVIEW_VERSION;
  /** The number of pages of the PDF. */
  pageCount: number;
  /** The first and the last page of the range that is drawn (zero-based, inclusive). */
  from: number;
  to: number;
  perSheet: number;
  columns: number;
  /** Pixels per point of a page of `pageSize`; a page of another size is drawn smaller if it does not fit the cell. */
  scale: number;
  /** In points, the size that most pages of the range have: the cells are made for it. */
  pageSize: { width: number; height: number };
  /** One cell: the caption strip and the page with its border. */
  cellWidth: number;
  cellHeight: number;
  /** The white between the cells and round the sheet. */
  gap: number;
  /** The height of the caption strip at the top of a cell. */
  captionHeight: number;
  sheets: OverviewSheet[];
}

export interface OverviewPlan {
  manifest: OverviewManifest;
  /** Things the person who asked should know: a last page that was cut back, sheets larger than a model takes in whole. */
  notes: string[];
}

export function overviewFileName(number: number): string {
  return `overview-${String(number).padStart(4, '0')}.png`;
}

function whole(value: number | undefined, fallback: number, name: string, least: number, most?: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < least || (most !== undefined && chosen > most)) {
    const range = most === undefined ? `from ${least}` : `from ${least} to ${most}`;
    throw new McPrepError('E_USAGE', `--${name} must be a whole number ${range}, not ${String(chosen)}.`);
  }
  return chosen;
}

/** The size, in points, that most of the pages measured have (the first of them on a tie): cells are made for it. */
async function usualPageSize(doc: PdfDocument, from: number, to: number): Promise<{ width: number; height: number }> {
  const count = to - from + 1;
  const sample = count <= SIZE_SAMPLE ? Array.from({ length: count }, (_unused, at) => from + at) : Array.from({ length: SIZE_SAMPLE }, (_unused, at) => from + Math.round((at * (count - 1)) / (SIZE_SAMPLE - 1)));
  const seen = new Map<string, { width: number; height: number; count: number }>();
  let failure: unknown;
  for (const page of [...new Set(sample)]) {
    try {
      const size = await doc.pageSize(page);
      const key = `${Math.round(size.width * 10)}x${Math.round(size.height * 10)}`;
      const entry = seen.get(key);
      if (entry) entry.count += 1;
      else seen.set(key, { width: size.width, height: size.height, count: 1 });
    } catch (error) {
      failure ??= error;
    }
  }
  let best: { width: number; height: number; count: number } | undefined;
  for (const entry of seen.values()) if (best === undefined || entry.count > best.count) best = entry;
  if (best === undefined) throw failure instanceof Error ? failure : new McPrepError('E_PAGE', 'No page of the range could be measured.');
  return { width: Math.round(best.width * 100) / 100, height: Math.round(best.height * 100) / 100 };
}

/**
 * Which pages go on which sheet and how big everything is, from the options and the size of the pages (nothing is drawn). The plan
 * depends only on the PDF and the options, so it is the same each time and does not change with the sheets that are drawn later.
 */
export async function planOverview(doc: PdfDocument, options: OverviewOptions = {}): Promise<OverviewPlan> {
  const pageCount = doc.pageCount;
  const notes: string[] = [];
  const from = whole(options.from, 0, 'from', 0);
  let to = whole(options.to, pageCount - 1, 'to', 0);
  if (from >= pageCount) {
    throw new McPrepError('E_USAGE', `--from ${from} is past the last page: this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'} (zero-based 0..${pageCount - 1}), so there is nothing to draw.`, { hint: 'Pages are zero-based: the first page is 0.' });
  }
  if (from > to) throw new McPrepError('E_USAGE', `The range of pages is empty: --from ${from} is after --to ${to}.`, { hint: 'Pages are zero-based and the range includes both ends: --from 0 --to 7 is the first eight pages.' });
  if (to > pageCount - 1) {
    notes.push(`--to ${to} is past the last page; the range ends at page ${pageCount - 1} (this PDF has ${pageCount} pages).`);
    to = pageCount - 1;
  }
  const perSheet = whole(options.perSheet, OVERVIEW_DEFAULTS.perSheet, 'per-sheet', 1, OVERVIEW_LIMITS.perSheet);
  const total = to - from + 1;
  const columns = Math.min(whole(options.columns, OVERVIEW_DEFAULTS.columns, 'columns', 1, OVERVIEW_LIMITS.columns), perSheet, total);
  if (options.scale !== undefined && !(options.scale >= OVERVIEW_LIMITS.minScale && options.scale <= OVERVIEW_LIMITS.maxScale)) {
    throw new McPrepError('E_USAGE', `--scale must be a number of pixels per point from ${OVERVIEW_LIMITS.minScale} to ${OVERVIEW_LIMITS.maxScale}, not ${String(options.scale)}.`, {
      hint: `The default draws a page about ${OVERVIEW_DEFAULTS.cellWidth} pixels wide (0.62 for a letter page).`,
    });
  }

  const pageSize = await usualPageSize(doc, from, to);
  const scale = options.scale ?? (OVERVIEW_DEFAULTS.cellWidth - 2 * BORDER) / pageSize.width;
  // A page of the usual size is drawn at `scale` less a hair, so that its picture is not a pixel wider than the cell it was measured for.
  const pictureWidth = Math.max(1, Math.ceil(pageSize.width * scale * (1 - 1e-9)));
  const pictureHeight = Math.max(1, Math.ceil(pageSize.height * scale * (1 - 1e-9)));
  const cellWidth = pictureWidth + 2 * BORDER;
  const cellHeight = CAPTION + pictureHeight + 2 * BORDER;

  const sheets: OverviewSheet[] = [];
  for (let first = from; first <= to; first += perSheet) {
    const pages = Array.from({ length: Math.min(perSheet, to - first + 1) }, (_unused, at) => first + at);
    const rows = Math.ceil(pages.length / columns);
    sheets.push({ number: sheets.length + 1, file: overviewFileName(sheets.length + 1), pages, width: GAP + columns * (cellWidth + GAP), height: GAP + rows * (cellHeight + GAP) });
  }
  const largest = sheets.reduce((most, sheet) => (sheet.width * sheet.height > most.width * most.height ? sheet : most), sheets[0] as OverviewSheet);
  if (largest.width * largest.height > OVERVIEW_LIMITS.maxPixels) {
    throw new McPrepError('E_USAGE', `A sheet would be ${largest.width} x ${largest.height} pixels, which is too large.`, { hint: 'Use fewer pages on a sheet (--per-sheet), fewer columns or a smaller --scale.' });
  }
  const longest = Math.max(largest.width, largest.height);
  if (longest > COMFORTABLE_SIDE) {
    notes.push(`A sheet is up to ${largest.width} x ${largest.height} pixels: an image with a side over about ${COMFORTABLE_SIDE} pixels is usually reduced before a model sees it, which blurs the print. Fewer pages on a sheet (--per-sheet, --columns) or a smaller --scale keep it sharp.`);
  }
  return {
    manifest: {
      format: OVERVIEW_FORMAT,
      version: OVERVIEW_VERSION,
      pageCount,
      from,
      to,
      perSheet,
      columns,
      scale: Math.round(scale * 1e6) / 1e6,
      pageSize,
      cellWidth,
      cellHeight,
      gap: GAP,
      captionHeight: CAPTION,
      sheets,
    },
    notes,
  };
}

/** `overview.json` as text: the head one field to a line and each sheet on a line of its own, so that it is short to read. */
export function formatOverviewManifest(manifest: OverviewManifest): string {
  const { sheets, ...head } = manifest;
  const lines = JSON.stringify(head, null, 1).split('\n');
  lines.pop();
  lines[lines.length - 1] = `${lines[lines.length - 1] as string},`;
  lines.push(' "sheets": [', ...sheets.map((sheet, at) => `  ${JSON.stringify(sheet)}${at < sheets.length - 1 ? ',' : ''}`), ' ]', '}');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing

export interface RenderOverviewOptions {
  outDir: string;
  /** Draw only the sheets this says yes to (the others stay listed in `overview.json`, but are not drawn again). */
  only?: (number: number) => boolean;
  onSheet?: (done: number, total: number) => void;
}

export interface OverviewResult {
  /** The numbers of the sheets that were drawn. */
  drawn: number[];
  /** Pages that could not be drawn: their cell says so. */
  failed: { page: number; message: string }[];
  /** Files of the folder that look like sheets of an earlier run and that `overview.json` does not list. */
  unlisted: string[];
}

const WHOLE_PAGE = { left: 0, top: 0, right: 1, bottom: 1 } as const;

/**
 * Writes `overview.json` (always the whole list) and draws the sheets of a plan into `outDir`, one at a time, each file written as soon
 * as its pages are drawn. The list comes first: it does not depend on the sheets that get drawn, and it is there when a long run is cut
 * off, so that the sheets that are missing can be drawn with `from-sheet`.
 */
export async function renderOverview(doc: PdfDocument, plan: OverviewPlan, options: RenderOverviewOptions): Promise<OverviewResult> {
  const canvasModule = await loadCanvas().catch((error: unknown) => {
    throw new McPrepError('E_RENDER_UNAVAILABLE', `Rendering needs the @napi-rs/canvas package, which could not be loaded: ${(error as Error).message}`, {
      hint: 'Reinstall the dependencies (npm install). Text analysis, validation and export work without rendering.',
      cause: error,
    });
  });
  const family = await overlayFont();
  try {
    await mkdir(options.outDir, { recursive: true });
  } catch (error) {
    throw new McPrepError('E_WRITE', `Cannot create the folder "${options.outDir}": ${(error as Error).message}`, { hint: 'Check that the path is a folder, or can become one, and that it is writable.', cause: error });
  }
  const { manifest } = plan;
  const pictureWidth = manifest.cellWidth - 2 * BORDER;
  const pictureHeight = manifest.cellHeight - manifest.captionHeight - 2 * BORDER;
  const todo = manifest.sheets.filter((sheet) => options.only === undefined || options.only(sheet.number));
  const failed: OverviewResult['failed'] = [];
  await writeFileAtomic(join(options.outDir, OVERVIEW_FILE), formatOverviewManifest(manifest));
  let done = 0;
  for (const sheet of todo) {
    const surface = canvasModule.createCanvas(sheet.width, sheet.height);
    const g = surface.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    for (const [at, page] of sheet.pages.entries()) {
      const x = manifest.gap + (at % manifest.columns) * (manifest.cellWidth + manifest.gap);
      const y = manifest.gap + Math.floor(at / manifest.columns) * (manifest.cellHeight + manifest.gap);
      g.font = `bold 15px "${family}"`;
      g.textBaseline = 'middle';
      g.fillStyle = '#1a1a1a';
      g.fillText(`p. ${page}`, x + 2, y + manifest.captionHeight / 2);
      const top = y + manifest.captionHeight + BORDER;
      let view: DrawnView | undefined;
      try {
        const size = await doc.pageSize(page);
        // A page of another size than the usual one is fitted into the cell (a hair under, so that it is not a pixel too wide).
        const scale = Math.min(pictureWidth / size.width, pictureHeight / size.height) * (1 - 1e-9);
        view = await renderRegionCanvas(doc, page, WHOLE_PAGE, { scale, padding: 0 });
      } catch (error) {
        if (error instanceof McPrepError && error.code === 'E_RENDER_UNAVAILABLE') throw error;
        failed.push({ page, message: (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? 'unknown error' });
      }
      if (view === undefined) {
        g.fillStyle = '#eeeeee';
        g.fillRect(x + BORDER, top, pictureWidth, pictureHeight);
        g.strokeStyle = '#808080';
        g.lineWidth = 1;
        g.strokeRect(x + BORDER - 0.5, top - 0.5, pictureWidth + 1, pictureHeight + 1);
        g.font = `13px "${family}"`;
        g.textAlign = 'center';
        g.fillStyle = '#a00000';
        const said = g.measureText('this page could not be drawn').width <= pictureWidth - 8 ? 'this page could not be drawn' : 'not drawn';
        g.fillText(said, x + manifest.cellWidth / 2, top + pictureHeight / 2);
        g.textAlign = 'left';
        continue;
      }
      // The picture is as big as the page at that scale; one that came out larger than the cell (a page far from the usual size, at the least scale the renderer draws) is reduced.
      const shrink = Math.min(1, pictureWidth / view.width, pictureHeight / view.height);
      const width = Math.max(1, Math.round(view.width * shrink));
      const height = Math.max(1, Math.round(view.height * shrink));
      const left = x + BORDER + Math.floor((pictureWidth - width) / 2);
      if (shrink < 1) g.drawImage(view.canvas, left, top, width, height);
      else g.drawImage(view.canvas, left, top);
      g.strokeStyle = '#808080';
      g.lineWidth = 1;
      g.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);
    }
    await writeFileAtomic(join(options.outDir, sheet.file), new Uint8Array(await surface.encode('png')));
    done += 1;
    options.onSheet?.(done, todo.length);
  }
  const listed = new Set(manifest.sheets.map((sheet) => sheet.file));
  const unlisted = (await readdir(options.outDir)).filter((name) => /^overview-\d{4,}\.png$/.test(name) && !listed.has(name)).sort();
  return { drawn: todo.map((sheet) => sheet.number), failed, unlisted };
}
