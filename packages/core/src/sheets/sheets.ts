import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bookExercisesInOrder } from '../book/summary.js';
import { writeFileAtomic } from '../fs/atomic.js';
import { bookReference, normalizeLabel } from '../model/authority.js';
import type { Frame, Rect } from '../model/types.js';
import { canonicalJson } from '../calllog.js';
import type { Canvas } from '@napi-rs/canvas';
import { loadCanvas } from '../pdf/runtime.js';
import { overlayFont, renderRegionCanvas } from '../pdf/render.js';
import type { Project } from '../project/model.js';
import { McPrepError } from '../rules/issues.js';
import { sampleSession } from '../sample/session.js';
import type { ProjectSession } from '../session.js';
import { createHash } from 'node:crypto';

/**
 * Contact sheets for an exhaustive look at an audit: every exercise of the book (or of a section, or of the fixed sample), cropped
 * with its instruction (blue), its own region (red), its continuations (orange) and, when asked, its answer (green), one region
 * under the other in a cell of a fixed width, each cell captioned with `SECTION:LABEL` and the pages of its regions; the cells in
 * the order of the book, a fixed number to a sheet. The sheets are files (`sheet-0001.png`, ...) and `sheets.json` lists what is on
 * each of them, with a hash of its content, so that a sheet that a later repair changed can be told from one that was looked at.
 */

export const SHEETS_FORMAT = 'math-canvas-sheets';
export const SHEETS_VERSION = 1;

export const SHEET_COLORS = { context: '#0060e0', main: '#e00000', continues: '#e08000', solution: '#00a000' } as const;
export const SHEET_DEFAULTS = { perSheet: 12, cellWidth: 740, heightCap: 2600, maxHeight: 6000 } as const;

// How a sheet is laid out: two cells wide, a region of a page drawn this many pixels wide before it is fitted to the cell.
const COLUMNS = 2;
const GAP = 8;
const CAPTION = 26;
const PAD = 4;
const PAGE_PIXELS = 1000;
const MAX_PART_HEIGHT = 1100;
const MARGIN = 0.012;

export type SheetScope = 'all' | 'sample' | 'section';

export interface SheetPart {
  kind: keyof typeof SHEET_COLORS;
  page: number;
  rect: Rect;
}

export interface SheetEntry {
  number: number;
  file: string;
  refs: string[];
  /** The zero-based pages that the regions of its cells are on. */
  pages: number[];
  /** What the sheet shows: a hash of the regions of its cells (a repair that moves one changes it). */
  hash: string;
  /** How tall the sheet is, in pixels (as planned from the regions; the picture is within a few pixels of it). */
  height: number;
  /** A single cell taller than the cap, on a sheet of its own. */
  tall?: true;
  /** A single cell taller than the most a sheet may be, drawn at this share of its size (under 1) so that the sheet is that tall. */
  scaled?: number;
}

export interface SheetsManifest {
  format: typeof SHEETS_FORMAT;
  version: typeof SHEETS_VERSION;
  scope: SheetScope;
  sections?: string[];
  perSheet: number;
  solutions: boolean;
  cellWidth: number;
  /** A new sheet is started when the next cell would make the sheet taller than this many pixels, whatever `perSheet` says (`perSheet` is the most cells). */
  heightCap: number;
  /** A sheet is never taller than this: a single cell that is taller is drawn smaller. */
  maxHeight: number;
  exercises: number;
  sheets: SheetEntry[];
}

/** The regions of an exercise, in the order they are drawn: its instructions, its own region, its continuations, its answer. */
export function partsOf(frame: Frame, solutions: boolean): SheetPart[] {
  return [
    ...(frame.context ?? []).map((region): SheetPart => ({ kind: 'context', page: region.page, rect: region.rect })),
    { kind: 'main', page: frame.page, rect: frame.rect },
    ...(frame.continues ?? []).map((region): SheetPart => ({ kind: 'continues', page: region.page, rect: region.rect })),
    ...(solutions ? (frame.solution ?? []).map((region): SheetPart => ({ kind: 'solution', page: region.page, rect: region.rect })) : []),
  ];
}

/** Pages as a caption: `p. 1, 2-3`. */
export function pagesCaption(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return `p. ${parts.join(', ')}`;
}

interface Cell {
  ref: string;
  frame: Frame;
}

/** What a sheet shows, as a hash: the exercises and their regions, with or without the answers. */
export function sheetHash(frames: readonly Frame[], solutions: boolean): string {
  const content = frames.map((frame) => ({ section: frame.section, label: frame.label, parts: partsOf(frame, solutions) }));
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export interface SheetsOptions {
  scope: SheetScope;
  sections?: readonly string[];
  perSheet?: number;
  solutions?: boolean;
  cellWidth?: number;
}

export interface SheetsPlan {
  manifest: SheetsManifest;
  cells: Map<number, Cell[]>;
}

const refOf = (frame: Frame): string => bookReference(frame.section as string, normalizeLabel(frame.label as string).label);

/** How tall a cell is, in pixels, from the regions it shows (the same arithmetic as the drawing, without drawing). */
async function cellHeight(session: ProjectSession, frame: Frame, solutions: boolean, cellWidth: number): Promise<number> {
  const doc = await session.document();
  let total = CAPTION + PAD;
  for (const part of partsOf(frame, solutions)) {
    const size = await doc.pageSize(part.page);
    const wide = (Math.min(1, part.rect.right + MARGIN) - Math.max(0, part.rect.left - MARGIN)) * PAGE_PIXELS;
    const tall = (Math.min(1, part.rect.bottom + MARGIN) - Math.max(0, part.rect.top - MARGIN)) * size.height * (PAGE_PIXELS / size.width);
    const k = Math.min(1, (cellWidth - 2 * PAD) / wide, MAX_PART_HEIGHT / tall);
    total += Math.max(1, Math.round(tall * k)) + PAD;
  }
  return total;
}

/** The height of a sheet whose cells have these heights: two cells to a row, a row as tall as its taller cell. */
export function sheetHeight(heights: readonly number[]): number {
  let total = GAP;
  for (let i = 0; i < heights.length; i += COLUMNS) total += Math.max(...heights.slice(i, i + COLUMNS)) + GAP;
  return total;
}

/** Which exercises go on sheets and on which: the order of the book, `perSheet` to a sheet. */
export async function planSheets(session: ProjectSession, options: SheetsOptions): Promise<SheetsPlan> {
  const project: Project = session.project;
  const perSheet = options.perSheet ?? SHEET_DEFAULTS.perSheet;
  if (!Number.isInteger(perSheet) || perSheet < 1) throw new McPrepError('E_USAGE', `--per-sheet must be a whole number from 1, not ${perSheet}.`);
  const solutions = options.solutions === true;
  let frames = bookExercisesInOrder(project.frames, project.outline?.entries).filter((frame) => frame.label !== undefined && frame.section !== undefined);
  if (options.scope === 'section') {
    const wanted = new Set(options.sections ?? []);
    const known = new Set<string>([...(project.outline?.entries ?? []).flatMap((entry) => (entry.id !== undefined ? [entry.id] : [])), ...frames.map((frame) => frame.section as string)]);
    const missing = [...wanted].filter((id) => !known.has(id));
    if (wanted.size === 0 || missing.length > 0) {
      throw new McPrepError('E_USAGE', wanted.size === 0 ? 'Name a section: --section ID.' : `There ${missing.length === 1 ? 'is no section' : 'are no sections'} ${missing.map((id) => `"${id}"`).join(', ')} in this project.`, {
        hint: `The sections are ${[...known].slice(0, 12).join(', ')}${known.size > 12 ? ', ...' : ''}.`,
      });
    }
    frames = frames.filter((frame) => wanted.has(frame.section as string));
  } else if (options.scope === 'sample') {
    const report = await sampleSession(session, {});
    const refs = new Set(report.exercises.map((entry) => entry.ref));
    frames = frames.filter((frame) => refs.has(refOf(frame)));
  }
  const cellWidth = options.cellWidth ?? SHEET_DEFAULTS.cellWidth;
  // The cells in the order of the book, a sheet closed when it has `perSheet` cells or the next would make it taller than the cap.
  const groups: { cells: Cell[]; heights: number[] }[] = [];
  for (const frame of frames) {
    const height = await cellHeight(session, frame, solutions, cellWidth);
    const last = groups[groups.length - 1];
    if (last && last.cells.length < perSheet && sheetHeight([...last.heights, height]) <= SHEET_DEFAULTS.heightCap) {
      last.cells.push({ ref: refOf(frame), frame });
      last.heights.push(height);
    } else groups.push({ cells: [{ ref: refOf(frame), frame }], heights: [height] });
  }
  const cells = new Map<number, Cell[]>();
  const sheets: SheetEntry[] = [];
  groups.forEach((group, index) => {
    const number = index + 1;
    const height = sheetHeight(group.heights);
    const tall = group.cells.length === 1 && height > SHEET_DEFAULTS.heightCap;
    // A cell taller than the most a sheet may be is drawn smaller, by what the parts of it (all but the captions and the gaps) allow.
    const fixed = GAP * 2 + CAPTION + PAD;
    const scaled = tall && height > SHEET_DEFAULTS.maxHeight ? Math.floor(((SHEET_DEFAULTS.maxHeight - fixed) / (height - fixed)) * 1000) / 1000 : undefined;
    cells.set(number, group.cells);
    sheets.push({
      number,
      file: `sheet-${String(number).padStart(4, '0')}.png`,
      refs: group.cells.map((cell) => cell.ref),
      pages: [...new Set(group.cells.flatMap((cell) => partsOf(cell.frame, solutions).map((part) => part.page)))].sort((a, b) => a - b),
      hash: sheetHash(
        group.cells.map((cell) => cell.frame),
        solutions,
      ),
      height: scaled !== undefined ? SHEET_DEFAULTS.maxHeight : height,
      ...(tall ? { tall: true as const } : {}),
      ...(scaled !== undefined ? { scaled } : {}),
    });
  });
  return {
    manifest: {
      format: SHEETS_FORMAT,
      version: SHEETS_VERSION,
      scope: options.scope,
      ...(options.scope === 'section' ? { sections: [...(options.sections ?? [])] } : {}),
      perSheet,
      solutions,
      cellWidth,
      heightCap: SHEET_DEFAULTS.heightCap,
      maxHeight: SHEET_DEFAULTS.maxHeight,
      exercises: frames.length,
      sheets,
    },
    cells,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing

export interface RenderSheetsOptions {
  outDir: string;
  /** Render only the sheets this says yes to (the others are listed in the manifest but not drawn again). */
  only?: (number: number) => boolean;
  onSheet?: (done: number, total: number) => void;
}

/** Draws the sheets of a plan into `outDir`, then writes `sheets.json` (always the whole list). Returns the numbers of the sheets drawn. */
export async function renderSheets(session: ProjectSession, plan: SheetsPlan, options: RenderSheetsOptions): Promise<number[]> {
  const doc = await session.document();
  const canvasModule = await loadCanvas();
  const family = await overlayFont();
  await mkdir(options.outDir, { recursive: true });
  const { manifest } = plan;
  const cellWidth = manifest.cellWidth;
  const todo = manifest.sheets.filter((sheet) => options.only === undefined || options.only(sheet.number));
  let done = 0;
  for (const sheet of todo) {
    const cells = plan.cells.get(sheet.number) as Cell[];
    const drawn: { caption: string; parts: { canvas: Canvas; width: number; height: number }[]; height: number }[] = [];
    for (const cell of cells) {
      const parts = partsOf(cell.frame, manifest.solutions);
      const pieces: (typeof drawn)[number]['parts'] = [];
      for (const part of parts) {
        const size = await doc.pageSize(part.page);
        const view = await renderRegionCanvas(doc, part.page, part.rect, { scale: PAGE_PIXELS / size.width, padding: 0.012 });
        const g = view.canvas.getContext('2d');
        const span = view.view;
        const fx = (x: number): number => ((x - span.left) / (span.right - span.left)) * view.width;
        const fy = (y: number): number => ((y - span.top) / (span.bottom - span.top)) * view.height;
        g.strokeStyle = SHEET_COLORS[part.kind];
        g.lineWidth = 3;
        g.strokeRect(fx(part.rect.left), fy(part.rect.top), fx(part.rect.right) - fx(part.rect.left), fy(part.rect.bottom) - fy(part.rect.top));
        const k = Math.min(1, (cellWidth - 2 * PAD) / view.width, MAX_PART_HEIGHT / view.height) * (sheet.scaled ?? 1);
        pieces.push({ canvas: view.canvas, width: Math.max(1, Math.round(view.width * k)), height: Math.max(1, Math.round(view.height * k)) });
      }
      drawn.push({ caption: `${cell.ref}   ${pagesCaption(parts.map((part) => part.page))}`, parts: pieces, height: CAPTION + pieces.reduce((sum, piece) => sum + piece.height + PAD, PAD) });
    }
    const rows: (typeof drawn)[] = [];
    for (let i = 0; i < drawn.length; i += COLUMNS) rows.push(drawn.slice(i, i + COLUMNS));
    const total = rows.reduce((sum, row) => sum + Math.max(...row.map((cell) => cell.height)) + GAP, GAP);
    const surface = canvasModule.createCanvas(Math.min(COLUMNS, drawn.length) * (cellWidth + GAP) + GAP, total);
    const g = surface.getContext('2d');
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, surface.width, surface.height);
    let y = GAP;
    for (const row of rows) {
      let x = GAP;
      for (const cell of row) {
        g.fillStyle = '#ffffff';
        g.fillRect(x, y, cellWidth, cell.height);
        g.fillStyle = '#00006e';
        g.font = `bold 16px "${family}"`;
        g.textBaseline = 'middle';
        g.fillText(cell.caption, x + 6, y + CAPTION / 2);
        let at = y + CAPTION;
        for (const piece of cell.parts) {
          g.drawImage(piece.canvas, x + PAD, at, piece.width, piece.height);
          at += piece.height + PAD;
        }
        x += cellWidth + GAP;
      }
      y += Math.max(...row.map((cell) => cell.height)) + GAP;
    }
    await writeFileAtomic(join(options.outDir, sheet.file), new Uint8Array(await surface.encode('png')));
    done += 1;
    options.onSheet?.(done, todo.length);
  }
  await writeFileAtomic(join(options.outDir, 'sheets.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return todo.map((sheet) => sheet.number);
}
