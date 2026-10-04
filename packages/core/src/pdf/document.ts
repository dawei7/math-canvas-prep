import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { INK_BANDS, INK_MAP_SIDE, type InkMap, type OutlineEntry, type PageSize, type PageText } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import { cleanTitle, normalizeOutline } from '../rules/outline.js';
import { findHeaderFooterKeys, groupTextLines, markHeaderFooter, type RawTextItem } from './lines.js';
import { loadCanvas, loadPdfJs, pdfDataDirs } from './runtime.js';

export interface PdfOpenOptions {
  password?: string;
}

const PAGE_CACHE = 6;

export interface TextOptions {
  /** Also find out which lines are set in bold (reads the fonts of the page; slower). */
  fonts?: boolean;
  /** Also compute the ink profile (renders the page at low resolution; slower). */
  ink?: boolean;
  /** Also compute the ink map, a picture of the page for placing an edge between two lines (slower still). */
  inkMap?: boolean;
}

/** PostScript names of bold faces: Helvetica-Bold, Arial-BoldMT, MinionPro-Semibold, CMBX12 (TeX), ... */
function isBoldFontName(name: string): boolean {
  return /bold|black|heavy|demi|cmbx|cmssbx|cmb\d/i.test(name);
}

/**
 * A PDF opened for analysis and rendering: page sizes as displayed (after /Rotate), text lines in page fractions, the
 * document's own outline, and PNG rendering of pages and regions. Reading uses pdf.js; nothing leaves the machine.
 */
export class PdfDocument {
  readonly pageCount: number;
  readonly bytes: number;
  readonly sha256: string;
  private readonly doc: PDFDocumentProxy;
  private readonly pages = new Map<number, PDFPageProxy>();
  private readonly textCache = new Map<number, { text: PageText; fonts: boolean }>();
  private readonly sizeCache = new Map<number, PageSize>();
  private readonly inkCache = new Map<number, number[]>();
  private readonly inkMapCache = new Map<number, InkMap>();
  private headerKeys: Set<string> | undefined;

  private constructor(doc: PDFDocumentProxy, bytes: number, sha256: string) {
    this.doc = doc;
    this.pageCount = doc.numPages;
    this.bytes = bytes;
    this.sha256 = sha256;
  }

  static async open(path: string, options: PdfOpenOptions = {}): Promise<PdfDocument> {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      throw new McPrepError('E_PDF_MISSING', `Cannot read the PDF "${path}": ${(error as Error).message}`, {
        hint: 'Check the path; for a project, the PDF path is relative to the project file.',
        cause: error,
      });
    }
    return PdfDocument.fromBytes(data, options);
  }

  static async fromBytes(bytes: Uint8Array, options: PdfOpenOptions = {}): Promise<PdfDocument> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const length = bytes.byteLength;
    const pdfjs = await loadPdfJs();
    const dirs = pdfDataDirs();
    const task = pdfjs.getDocument({
      // pdf.js takes ownership of the buffer it is given, so it gets a copy.
      data: new Uint8Array(bytes),
      standardFontDataUrl: dirs.standardFonts,
      cMapUrl: dirs.cmaps,
      cMapPacked: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      ...(options.password !== undefined ? { password: options.password } : {}),
    });
    try {
      const doc = await task.promise;
      return new PdfDocument(doc, length, sha256);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'PasswordException') {
        throw new McPrepError('E_PDF_PASSWORD', 'The PDF is password protected.', {
          hint: 'Remove the password first; the bundle must carry a PDF the app can open.',
          cause: error,
        });
      }
      throw new McPrepError('E_PDF_INVALID', `The file is not a readable PDF: ${(error as Error).message}`, {
        hint: 'Check that the file is a complete, undamaged PDF.',
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    for (const page of this.pages.values()) page.cleanup();
    this.pages.clear();
    await this.doc.destroy();
  }

  assertPage(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new McPrepError('E_PAGE', `Page ${String(index)} does not exist: this PDF has ${this.pageCount} page${this.pageCount === 1 ? '' : 's'} (zero-based 0..${this.pageCount - 1}).`, {
        hint: 'Pages are zero-based: the first page is 0.',
      });
    }
  }

  /** The pdf.js page (cached for a few pages). */
  async rawPage(index: number): Promise<PDFPageProxy> {
    this.assertPage(index);
    const cached = this.pages.get(index);
    if (cached) {
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const page = await this.doc.getPage(index + 1);
    this.pages.set(index, page);
    if (this.pages.size > PAGE_CACHE) {
      const oldest = this.pages.keys().next().value as number;
      this.pages.get(oldest)?.cleanup();
      this.pages.delete(oldest);
    }
    return page;
  }

  /** The page as displayed (after its own /Rotate), in points. */
  async pageSize(index: number): Promise<PageSize> {
    const cached = this.sizeCache.get(index);
    if (cached) return cached;
    const page = await this.rawPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const size: PageSize = { width: viewport.width, height: viewport.height, rotation: ((page.rotate % 360) + 360) % 360 };
    this.sizeCache.set(index, size);
    return size;
  }

  async pageSizes(): Promise<PageSize[]> {
    const sizes: PageSize[] = [];
    for (let index = 0; index < this.pageCount; index += 1) sizes.push(await this.pageSize(index));
    return sizes;
  }

  private async extractLines(index: number, withFonts: boolean): Promise<PageText> {
    const pdfjs = await loadPdfJs();
    const page = await this.rawPage(index);
    const size = await this.pageSize(index);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const bold = new Map<string, boolean>();
    if (withFonts) {
      // Reading the operator list makes pdf.js load the fonts, which gives their real names (Helvetica-Bold, CMBX12).
      await page.getOperatorList();
      for (const entry of content.items) {
        if (!('fontName' in entry) || bold.has(entry.fontName) || !page.commonObjs.has(entry.fontName)) continue;
        const font = page.commonObjs.get(entry.fontName) as { name?: unknown } | undefined;
        bold.set(entry.fontName, isBoldFontName(typeof font?.name === 'string' ? font.name : ''));
      }
    }
    const items: RawTextItem[] = [];
    for (const item of content.items) {
      if (!('str' in item) || item.str.length === 0) continue;
      const style = content.styles[item.fontName];
      if (style?.vertical === true) continue;
      const [a, b, c, d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform) as [number, number, number, number, number, number];
      if (a <= 0 || Math.abs(Math.atan2(b, a)) > 0.17) continue;
      const fontSize = Math.hypot(c, d);
      items.push({
        text: item.str,
        left: e,
        right: e + item.width * viewport.scale,
        baseline: f,
        fontSize,
        ascent: style?.ascent ?? 0,
        descent: style?.descent ?? 0,
        ...(bold.has(item.fontName) ? { bold: bold.get(item.fontName) as boolean } : {}),
      });
    }
    const grouped = groupTextLines(items, size);
    const chars = grouped.lines.reduce((sum, line) => sum + line.chars, 0);
    return { page: index, size, lines: grouped.lines, columns: grouped.columns, hasText: chars >= 2 };
  }

  /**
   * The text lines of a page in reading order, without the running-header analysis (see {@link pageText}). With
   * `fonts`, lines also say whether they are set in bold (this reads the page's fonts, which takes longer).
   */
  async rawPageText(index: number, options: TextOptions = {}): Promise<PageText> {
    this.assertPage(index);
    const cached = this.textCache.get(index);
    if (cached && (options.fonts !== true || cached.fonts)) return cached.text;
    const text = await this.extractLines(index, options.fonts === true);
    this.textCache.set(index, { text, fonts: options.fonts === true });
    return text;
  }

  /**
   * Running headers and footers of the document: lines that repeat in the top or bottom band of several pages. Found
   * once from a sample of up to 12 pages spread over the document.
   */
  private async headerFooterKeys(): Promise<Set<string>> {
    if (this.headerKeys) return this.headerKeys;
    const sample: number[] = [];
    const count = Math.min(12, this.pageCount);
    for (let i = 0; i < count; i += 1) {
      sample.push(count === 1 ? 0 : Math.round((i * (this.pageCount - 1)) / (count - 1)));
    }
    const texts: PageText[] = [];
    for (const index of [...new Set(sample)]) texts.push(await this.rawPageText(index));
    this.headerKeys = findHeaderFooterKeys(texts);
    return this.headerKeys;
  }

  /**
   * How much ink there is in each horizontal band of the page: the page is drawn at low resolution and, for each of
   * INK_BANDS bands from top to bottom, the share of the width with a dark pixel is returned.
   */
  async inkProfile(index: number): Promise<number[]> {
    this.assertPage(index);
    const cached = this.inkCache.get(index);
    if (cached) return cached;
    const { createCanvas } = await loadCanvas();
    const page = await this.rawPage(index);
    const size = await this.pageSize(index);
    const scale = Math.min(1, 420 / Math.max(size.width, size.height));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, canvas, viewport } as never).promise;
    const data = context.getImageData(0, 0, width, height).data;
    const bands = new Array<number>(INK_BANDS).fill(0);
    const counts = new Array<number>(INK_BANDS).fill(0);
    for (let y = 0; y < height; y += 1) {
      const band = Math.min(INK_BANDS - 1, Math.floor((y / height) * INK_BANDS));
      let dark = 0;
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const luminance = 0.299 * (data[at] as number) + 0.587 * (data[at + 1] as number) + 0.114 * (data[at + 2] as number);
        if (luminance < 235) dark += 1;
      }
      bands[band] = (bands[band] as number) + dark / width;
      counts[band] = (counts[band] as number) + 1;
    }
    const profile = bands.map((value, i) => Math.round((value / Math.max(1, counts[i] as number)) * 1000) / 1000);
    this.inkCache.set(index, profile);
    return profile;
  }

  /**
   * Which pixels of the page are dark: the page is drawn so that its longer side is {@link INK_MAP_SIDE} pixels, and a
   * pixel is dark when it is clearly darker than paper. Edges of frames are placed in white rows of this picture.
   */
  async inkMap(index: number): Promise<InkMap> {
    this.assertPage(index);
    const cached = this.inkMapCache.get(index);
    if (cached) return cached;
    const { createCanvas } = await loadCanvas();
    const page = await this.rawPage(index);
    const size = await this.pageSize(index);
    const viewport = page.getViewport({ scale: INK_MAP_SIDE / Math.max(size.width, size.height) });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, canvas, viewport } as never).promise;
    const data = context.getImageData(0, 0, width, height).data;
    const stride = Math.ceil(width / 8);
    const bits = new Uint8Array(stride * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const luminance = 0.299 * (data[at] as number) + 0.587 * (data[at + 1] as number) + 0.114 * (data[at + 2] as number);
        if (luminance < 170) bits[y * stride + (x >> 3)] = (bits[y * stride + (x >> 3)] as number) | (0x80 >> (x & 7));
      }
    }
    const map: InkMap = { width, height, bits };
    this.inkMapCache.set(index, map);
    return map;
  }

  /** The text lines of a page in reading order, running headers and footers marked. */
  async pageText(index: number, options: TextOptions = {}): Promise<PageText> {
    let text = markHeaderFooter(await this.rawPageText(index, options), await this.headerFooterKeys());
    if (options.ink === true) text = { ...text, ink: await this.inkProfile(index) };
    if (options.inkMap === true) text = { ...text, inkMap: await this.inkMap(index) };
    return text;
  }

  /** Text of every page (marked); for proposals over a whole document. */
  async allPageText(options: TextOptions & { onProgress?: (done: number, total: number) => void } = {}): Promise<PageText[]> {
    const keys = await this.headerFooterKeys();
    const pages: PageText[] = [];
    for (let index = 0; index < this.pageCount; index += 1) {
      let text = markHeaderFooter(await this.rawPageText(index, options), keys);
      if (options.ink === true) text = { ...text, ink: await this.inkProfile(index) };
      if (options.inkMap === true) text = { ...text, inkMap: await this.inkMap(index) };
      pages.push(text);
      options.onProgress?.(index + 1, this.pageCount);
    }
    return pages;
  }

  /**
   * The document's own outline (bookmarks) flattened in reading order, or null when it has none. Entries whose
   * destination cannot be resolved to a page are skipped.
   */
  async outline(): Promise<OutlineEntry[] | null> {
    const roots = await this.doc.getOutline();
    if (!roots || roots.length === 0) return null;
    const entries: OutlineEntry[] = [];
    type Node = { title: string; dest: string | unknown[] | null; items: Node[] };
    const walk = async (nodes: Node[], depth: number): Promise<void> => {
      for (const node of nodes) {
        const page = await this.resolveDestination(node.dest);
        const title = cleanTitle(node.title);
        let nextDepth = depth;
        if (title.length > 0 && page !== undefined) {
          entries.push({ title, page, depth });
          nextDepth = depth + 1;
        }
        if (node.items.length > 0) await walk(node.items, nextDepth);
      }
    };
    await walk(roots as Node[], 0);
    const normalized = normalizeOutline(entries, this.pageCount);
    return normalized.length > 0 ? normalized : null;
  }

  private async resolveDestination(dest: string | unknown[] | null): Promise<number | undefined> {
    try {
      const resolved = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
      const target: unknown = resolved[0];
      if (typeof target === 'number') return target;
      if (typeof target === 'object' && target !== null) {
        return await this.doc.getPageIndex(target as { num: number; gen: number });
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
