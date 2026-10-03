import { deflateSync } from 'node:zlib';

/**
 * A tiny dependency-free PDF writer for tests, examples and documentation. It makes multi-page documents with text at
 * known positions (standard fonts, no embedding), simple rectangles, an optional outline (bookmarks), rotated pages and
 * scan-like pages (an image and no text). Everything is synthetic: no real textbook or exam is ever needed.
 *
 * All coordinates are in points of the page *as displayed*, origin top-left, y downwards. For text, `y` is the baseline.
 * A page with `rotate` is authored upright in display space: the writer adds the matrix that makes the rotated page
 * read normally, so the displayed result is the same for every rotation.
 */

export type PdfFont = 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Courier';

export interface PdfText {
  text: string;
  /** Left edge in points. */
  x: number;
  /** Baseline in points from the top of the displayed page. */
  y: number;
  size?: number;
  font?: PdfFont;
}

export interface PdfBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Gray level 0 (black) to 1 (white) to fill with; when absent the outline is stroked. */
  fill?: number;
}

export interface PdfScan {
  /** Dark bars painted into the image, as fractions of the page: stand-ins for lines of printed text. */
  bars: { left: number; top: number; right: number; bottom: number }[];
}

export interface PdfPageSpec {
  /** Displayed width and height in points (default A4: 595 x 842). */
  width?: number;
  height?: number;
  /** The page's /Rotate value. */
  rotate?: 0 | 90 | 180 | 270;
  texts?: PdfText[];
  boxes?: PdfBox[];
  /** A scan-like page: an image and no text layer. */
  scan?: PdfScan;
}

export interface PdfOutlineSpec {
  title: string;
  /** Zero-based page. */
  page: number;
  depth?: number;
}

export interface PdfSpec {
  title?: string;
  pages: PdfPageSpec[];
  outline?: PdfOutlineSpec[];
}

export const A4 = { width: 595, height: 842 } as const;

const FONT_RESOURCES: Record<PdfFont, string> = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Times-Roman': 'F3',
  Courier: 'F4',
};

/** A PDF literal string in WinAnsi (Latin-1 range); other characters become '?'. */
function literal(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code >= 32 && code < 127) out += char;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `${out})`;
}

/** A PDF text string as UTF-16BE hex with a byte order mark, for titles that may hold any character. */
function hexText(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

const num = (value: number): string => (Math.round(value * 1000) / 1000).toString();

/** The matrix that carries display space (origin bottom-left, y up) onto the unrotated user space of the page. */
function displayMatrix(rotate: number, width: number, height: number): string {
  switch (rotate) {
    case 90:
      return `0 1 -1 0 ${num(height)} 0 cm`;
    case 180:
      return `-1 0 0 -1 ${num(width)} ${num(height)} cm`;
    case 270:
      return `0 -1 1 0 0 ${num(width)} cm`;
    default:
      return '1 0 0 1 0 0 cm';
  }
}

function scanImage(page: PdfScan): { width: number; height: number; data: Buffer } {
  const width = 150;
  const height = 210;
  const pixels = Buffer.alloc(width * height, 0xf2);
  for (const bar of page.bars) {
    const x0 = Math.max(0, Math.floor(bar.left * width));
    const x1 = Math.min(width, Math.ceil(bar.right * width));
    const y0 = Math.max(0, Math.floor(bar.top * height));
    const y1 = Math.min(height, Math.ceil(bar.bottom * height));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) pixels[y * width + x] = 0x38;
  }
  return { width, height, data: deflateSync(pixels, { level: 9 }) };
}

export function buildPdf(spec: PdfSpec): Uint8Array {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (buffer: Buffer): void => {
    chunks.push(buffer);
    length += buffer.length;
  };
  const text = (value: string): void => push(Buffer.from(value, 'latin1'));

  // Object numbers: 1 catalog, 2 pages, 3 info, 4-7 fonts, then per page (page, content, optional image), then outline.
  const fontIds = { F1: 4, F2: 5, F3: 6, F4: 7 };
  let next = 8;
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  const imageIds: (number | undefined)[] = [];
  for (const page of spec.pages) {
    pageIds.push(next++);
    contentIds.push(next++);
    imageIds.push(page.scan ? next++ : undefined);
  }
  const outlineRootId = spec.outline && spec.outline.length > 0 ? next++ : undefined;
  const outlineItemIds = (spec.outline ?? []).map(() => next++);
  const objectCount = next;

  const begin = (id: number): void => {
    offsets[id] = length;
    text(`${id} 0 obj\n`);
  };

  text('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  begin(1);
  text(
    `<< /Type /Catalog /Pages 2 0 R${outlineRootId ? ` /Outlines ${outlineRootId} 0 R /PageMode /UseOutlines` : ''} >>\nendobj\n`,
  );
  begin(2);
  text(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj\n`);
  begin(3);
  text(`<< /Title ${hexText(spec.title ?? 'Synthetic test document')} /Producer ${hexText('math-canvas-prep test writer')} >>\nendobj\n`);
  const fontNames: [number, string][] = [
    [fontIds.F1, 'Helvetica'],
    [fontIds.F2, 'Helvetica-Bold'],
    [fontIds.F3, 'Times-Roman'],
    [fontIds.F4, 'Courier'],
  ];
  for (const [id, name] of fontNames) {
    begin(id);
    text(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>\nendobj\n`);
  }

  spec.pages.forEach((page, index) => {
    const width = page.width ?? A4.width;
    const height = page.height ?? A4.height;
    const rotate = page.rotate ?? 0;
    const mediaWidth = rotate === 90 || rotate === 270 ? height : width;
    const mediaHeight = rotate === 90 || rotate === 270 ? width : height;
    const imageId = imageIds[index];

    let content = `q ${displayMatrix(rotate, width, height)}\n`;
    for (const box of page.boxes ?? []) {
      const y = height - box.y - box.h;
      if (box.fill !== undefined) content += `${num(box.fill)} g ${num(box.x)} ${num(y)} ${num(box.w)} ${num(box.h)} re f 0 g\n`;
      else content += `0.5 w ${num(box.x)} ${num(y)} ${num(box.w)} ${num(box.h)} re S\n`;
    }
    if (page.scan && imageId) {
      content += `q ${num(width)} 0 0 ${num(height)} 0 0 cm /Im1 Do Q\n`;
    }
    for (const item of page.texts ?? []) {
      const resource = FONT_RESOURCES[item.font ?? 'Helvetica'];
      content += `BT /${resource} ${num(item.size ?? 11)} Tf ${num(item.x)} ${num(height - item.y)} Td ${literal(item.text)} Tj ET\n`;
    }
    content += 'Q\n';

    const pageId = pageIds[index] as number;
    const contentId = contentIds[index] as number;
    begin(pageId);
    text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(mediaWidth)} ${num(mediaHeight)}]${rotate ? ` /Rotate ${rotate}` : ''} ` +
        `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R /F4 ${fontIds.F4} 0 R >>` +
        `${imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    begin(contentId);
    const body = Buffer.from(content, 'latin1');
    text(`<< /Length ${body.length} >>\nstream\n`);
    push(body);
    text('\nendstream\nendobj\n');
    if (page.scan && imageId) {
      const image = scanImage(page.scan);
      begin(imageId);
      text(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray ` +
          `/BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.length} >>\nstream\n`,
      );
      push(image.data);
      text('\nendstream\nendobj\n');
    }
  });

  if (outlineRootId && spec.outline) {
    const items = spec.outline;
    const parent: (number | undefined)[] = [];
    const children: number[][] = items.map(() => []);
    const rootChildren: number[] = [];
    const stack: number[] = [];
    items.forEach((item, index) => {
      const depth = Math.min(item.depth ?? 0, stack.length);
      stack.length = depth;
      const parentIndex = depth === 0 ? undefined : stack[depth - 1];
      parent[index] = parentIndex;
      if (parentIndex === undefined) rootChildren.push(index);
      else (children[parentIndex] as number[]).push(index);
      stack.push(index);
    });
    const descendants = (index: number): number =>
      (children[index] as number[]).reduce((sum, child) => sum + 1 + descendants(child), 0);
    const itemId = (index: number): number => outlineItemIds[index] as number;
    begin(outlineRootId);
    const first = rootChildren[0];
    const last = rootChildren[rootChildren.length - 1];
    text(
      `<< /Type /Outlines${first !== undefined ? ` /First ${itemId(first)} 0 R /Last ${itemId(last as number)} 0 R` : ''} /Count ${rootChildren.reduce((sum, child) => sum + 1 + descendants(child), 0)} >>\nendobj\n`,
    );
    items.forEach((item, index) => {
      const siblings = parent[index] === undefined ? rootChildren : (children[parent[index] as number] as number[]);
      const position = siblings.indexOf(index);
      const own = children[index] as number[];
      const pageId = pageIds[Math.min(Math.max(item.page, 0), pageIds.length - 1)] as number;
      const height = spec.pages[Math.min(Math.max(item.page, 0), pageIds.length - 1)]?.height ?? A4.height;
      begin(itemId(index));
      text(
        `<< /Title ${hexText(item.title)} /Parent ${parent[index] === undefined ? outlineRootId : itemId(parent[index] as number)} 0 R` +
          `${position > 0 ? ` /Prev ${itemId(siblings[position - 1] as number)} 0 R` : ''}` +
          `${position < siblings.length - 1 ? ` /Next ${itemId(siblings[position + 1] as number)} 0 R` : ''}` +
          `${own.length > 0 ? ` /First ${itemId(own[0] as number)} 0 R /Last ${itemId(own[own.length - 1] as number)} 0 R /Count ${descendants(index)}` : ''}` +
          ` /Dest [${pageId} 0 R /XYZ 0 ${num(height)} null] >>\nendobj\n`,
      );
    });
  }

  const xref = length;
  text(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let id = 1; id < objectCount; id += 1) text(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers to lay text out

export interface Paragraph {
  lines: string[];
  x: number;
  /** Baseline of the first line, in points from the top. */
  y: number;
  size?: number;
  leading?: number;
  font?: PdfFont;
}

/** Text lines one below the other; returns them and the baseline of the next free line. */
export function paragraph(spec: Paragraph): { texts: PdfText[]; next: number } {
  const size = spec.size ?? 11;
  const leading = spec.leading ?? size * 1.35;
  const texts = spec.lines.map((line, index): PdfText => {
    const item: PdfText = { text: line, x: spec.x, y: spec.y + index * leading, size };
    if (spec.font !== undefined) item.font = spec.font;
    return item;
  });
  return { texts, next: spec.y + spec.lines.length * leading };
}
