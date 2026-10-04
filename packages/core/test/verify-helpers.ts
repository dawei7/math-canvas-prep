import { PdfDocument } from '../src/pdf/document.js';
import type { Frame, OutlineEntry, PageText, Rect, Region } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';
import { buildPdf, type PdfFont, type PdfPageSpec, type PdfText } from '../src/testing/pdf-writer.js';
import type { PageSource } from '../src/verify/verify.js';

/**
 * A tiny workbook for the tests of `verify` and `sample`: text placed on the pages of a synthetic PDF, and the frames that go
 * with it (an exercise per printed line, an answer per printed line of a key). The page is A4 (595 x 842 points); `y` is the
 * baseline of a line in points from the top, `x` its left edge. Everything is invented.
 */

const HEIGHT = 842;
const WIDTH = 595;
const round = (value: number): number => Math.round(value * 10000) / 10000;

/** A region around one printed line (or a few): a little above its first baseline, a little below its last. */
export function around(page: number, x: number, y: number, options: { width?: number; lines?: number; leading?: number } = {}): Region {
  const lines = options.lines ?? 1;
  const leading = options.leading ?? 15;
  return { page, rect: { left: round((x - 4) / WIDTH), top: round((y - 11) / HEIGHT), right: round((x + (options.width ?? 220)) / WIDTH), bottom: round((y + (lines - 1) * leading + 5) / HEIGHT) } };
}

export class Workbook {
  readonly pages: PdfText[][] = [];
  readonly frames: Frame[] = [];
  outline: OutlineEntry[] = [];
  private counter = 0;

  constructor(private readonly pageCount: number) {
    for (let page = 0; page < pageCount; page += 1) this.pages.push([]);
  }

  text(page: number, x: number, y: number, text: string, size = 11, font?: PdfFont): this {
    const item: PdfText = { text, x, y, size };
    if (font !== undefined) item.font = font;
    (this.pages[page] as PdfText[]).push(item);
    return this;
  }

  /** A printed exercise: the text `<label>. <words>` at (x, y) and an authoritative frame around it. */
  exercise(section: string, label: string, page: number, x: number, y: number, options: { words?: string; marker?: string; id?: string; extra?: Partial<Frame>; width?: number } = {}): Frame {
    this.counter += 1;
    this.text(page, x, y, `${options.marker ?? `${label}.`} ${options.words ?? 'Evaluate the expression.'}`);
    const region = around(page, x, y, options.width !== undefined ? { width: options.width } : {});
    const frame: Frame = { id: options.id ?? `f${this.counter}`, kind: 'exercise', page, rect: region.rect, authority: 'book', label, section, ...options.extra };
    this.frames.push(frame);
    return frame;
  }

  /** A printed answer: the text at (x, y) and a solution region around it, attached to the frame. */
  answer(frame: Frame, page: number, x: number, y: number, text: string, options: { width?: number } = {}): Region {
    this.text(page, x, y, text);
    const region = around(page, x, y, options.width !== undefined ? { width: options.width } : {});
    frame.solution = [...(frame.solution ?? []), region];
    return region;
  }

  /** An ordinary exercise (framed by a person): the text and a frame without authority. */
  ordinary(page: number, x: number, y: number, words: string, extra: Partial<Frame> = {}): Frame {
    this.counter += 1;
    this.text(page, x, y, words);
    const frame: Frame = { id: `f${this.counter}`, kind: 'exercise', page, rect: around(page, x, y).rect, ...extra };
    this.frames.push(frame);
    return frame;
  }

  /** A page with a scan instead of text: dark bars where the lines would be. */
  scan: Rect[][] = [];

  spec(): PdfPageSpec[] {
    return this.pages.map((texts, page) => {
      const bars = this.scan[page];
      return bars !== undefined ? { texts, scan: { bars } } : { texts };
    });
  }

  pdf(): Uint8Array {
    return buildPdf({ title: 'Verify test workbook', pages: this.spec() });
  }

  project(): Project {
    return { ...newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount: this.pageCount }, title: 'A Workbook' }), outline: { source: 'manual', entries: this.outline }, frames: this.frames };
  }
}

/** The codes that the checks of whole pages, instructions, the key, spans and ink report (tested in verify-coverage.test.ts). */
export const COVERAGE_CODES = [
  'span-gap',
  'continuation-order',
  'continuation-limit',
  'numbered-text-left-behind',
  'answer-left-behind',
  'text-left-behind',
  'answer-clipped',
  'context-range',
  'context-missing',
  'context-not-nearest',
  'solution-section-mismatch',
  'solution-order',
  'edge-on-ink',
  'edge-interlocked',
  'region-open-end',
  'region-holds-item',
  'inline-section',
  'context-inconsistent',
  'stray-frame',
] as const;

/** The text of every page of a PDF, as the checks take it (read with the real extraction, fonts included: the tools read bold lines). */
export async function pagesOf(pdf: Uint8Array): Promise<PageSource> {
  const doc = await PdfDocument.fromBytes(pdf);
  try {
    const texts: PageText[] = await doc.allPageText({ fonts: true });
    return (page) => texts[page];
  } finally {
    await doc.close();
  }
}

/** The outline of a workbook: chapters and sections with ids, labels and the position of their headings. */
export function sectionEntries(entries: { id: string; page: number; depth?: number; top?: number; title?: string; label?: string }[]): OutlineEntry[] {
  return entries.map((entry) => ({ title: entry.title ?? `Section ${entry.id}`, page: entry.page, depth: entry.depth ?? 0, id: entry.id, label: entry.label ?? entry.id, ...(entry.top !== undefined ? { top: entry.top } : {}) }));
}
