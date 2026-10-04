import type { SKRSContext2D } from '@napi-rs/canvas';
import { KIND_COLORS, type OverlayBox } from '../model/overlay.js';
import { clampRect, rectHeight, rectWidth } from '../model/rect.js';
import type { Rect } from '../model/types.js';
import { McPrepError } from '../rules/issues.js';
import type { PdfDocument } from './document.js';
import { loadCanvas, pdfDataDirs } from './runtime.js';

export interface RenderOptions {
  /** Pixels per point. When absent it is chosen so that the longer side is about `maxSide` pixels. */
  scale?: number;
  /** Longer side in pixels when `scale` is not given (default 1600 for a page, 1400 for a crop). */
  maxSide?: number;
  /** Draw a labelled coordinate grid with lines every `grid` of the page (for example 0.1 or 0.05). */
  grid?: number | false;
  /** Draw these boxes (frames, continuations, context) with their labels. */
  boxes?: OverlayBox[];
  /** Crop only: how much of the page around the rectangle to include, as a fraction of the page (default 0.01). */
  padding?: number;
}

export interface RenderedImage {
  png: Uint8Array;
  width: number;
  height: number;
  /** Pixels per point. */
  scale: number;
  /** The part of the page shown, in page fractions. */
  view: Rect;
}

let fontsRegistered = false;

async function registerFonts(): Promise<string> {
  const { GlobalFonts } = await loadCanvas();
  if (!fontsRegistered) {
    fontsRegistered = true;
    const dir = pdfDataDirs().standardFonts;
    try {
      GlobalFonts.registerFromPath(`${dir}LiberationSans-Regular.ttf`, 'McPrep Sans');
      GlobalFonts.registerFromPath(`${dir}LiberationSans-Bold.ttf`, 'McPrep Sans Bold');
    } catch {
      // The overlay then uses whatever sans-serif the system has.
    }
  }
  return GlobalFonts.has('McPrep Sans') ? 'McPrep Sans' : 'sans-serif';
}

async function renderView(doc: PdfDocument, index: number, view: Rect, options: RenderOptions, defaultSide: number): Promise<RenderedImage> {
  const { createCanvas } = await loadCanvas().catch((error: unknown) => {
    throw new McPrepError('E_RENDER_UNAVAILABLE', `Rendering needs the @napi-rs/canvas package, which could not be loaded: ${(error as Error).message}`, {
      hint: 'Reinstall the dependencies (npm install). Text analysis, validation and export work without rendering.',
      cause: error,
    });
  });
  const family = await registerFonts();
  const page = await doc.rawPage(index);
  const size = await doc.pageSize(index);
  const pointsWide = rectWidth(view) * size.width;
  const pointsTall = rectHeight(view) * size.height;
  const maxSide = options.maxSide ?? defaultSide;
  let scale = options.scale ?? Math.min(4, maxSide / Math.max(pointsWide, pointsTall));
  scale = Math.max(0.2, Math.min(scale, 6));
  const x0 = Math.floor(view.left * size.width * scale);
  const y0 = Math.floor(view.top * size.height * scale);
  const width = Math.max(1, Math.ceil(view.right * size.width * scale) - x0);
  const height = Math.max(1, Math.ceil(view.bottom * size.height * scale) - y0);
  if (width * height > 40_000_000) {
    throw new McPrepError('E_RENDER_SIZE', `The image would be ${width} x ${height} pixels; that is too large.`, {
      hint: 'Use a smaller --scale or --max-side.',
    });
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const viewport = page.getViewport({ scale, offsetX: -x0, offsetY: -y0 });
  // pdf.js types its parameters with DOM canvas types; the @napi-rs/canvas objects are compatible at run time.
  await page.render({ canvasContext: context, canvas, viewport } as never).promise;

  const exact: Rect = {
    left: x0 / (size.width * scale),
    top: y0 / (size.height * scale),
    right: (x0 + width) / (size.width * scale),
    bottom: (y0 + height) / (size.height * scale),
  };
  if (options.boxes && options.boxes.length > 0) drawBoxes(context, width, height, exact, options.boxes, family);
  if (options.grid) drawGrid(context, width, height, exact, options.grid, family);
  const png = await canvas.encode('png');
  return { png: new Uint8Array(png), width, height, scale, view: clampRect(exact) };
}

/** A whole page as a PNG. */
export async function renderPage(doc: PdfDocument, index: number, options: RenderOptions = {}): Promise<RenderedImage> {
  doc.assertPage(index);
  return renderView(doc, index, { left: 0, top: 0, right: 1, bottom: 1 }, options, 1600);
}

/** A page as a bitmap of dark pixels (1) and light ones (0): a pixel is dark when its luminance is below `threshold` (default 150). */
export interface DarkPicture {
  width: number;
  height: number;
  dark: Uint8Array;
}

/**
 * A whole page drawn at `scale` pixels per point (default 2, reduced for a huge page) and reduced to dark and light pixels,
 * without making a PNG: for measuring how much ink lies along a line of the page.
 */
export async function renderDark(doc: PdfDocument, index: number, options: { scale?: number; threshold?: number } = {}): Promise<DarkPicture> {
  doc.assertPage(index);
  const { createCanvas } = await loadCanvas().catch((error: unknown) => {
    throw new McPrepError('E_RENDER_UNAVAILABLE', `Rendering needs the @napi-rs/canvas package, which could not be loaded: ${(error as Error).message}`, {
      hint: 'Reinstall the dependencies (npm install). Text analysis, validation and export work without rendering.',
      cause: error,
    });
  });
  const page = await doc.rawPage(index);
  const size = await doc.pageSize(index);
  let scale = options.scale ?? 2;
  while (size.width * scale * size.height * scale > 12_000_000 && scale > 0.5) scale *= 0.8;
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: context, canvas, viewport } as never).promise;
  const data = context.getImageData(0, 0, width, height).data;
  const threshold = options.threshold ?? 150;
  const dark = new Uint8Array(width * height);
  for (let at = 0, pixel = 0; pixel < dark.length; at += 4, pixel += 1) {
    if (0.299 * (data[at] as number) + 0.587 * (data[at + 1] as number) + 0.114 * (data[at + 2] as number) < threshold) dark[pixel] = 1;
  }
  return { width, height, dark };
}

/** A region of a page as a PNG; the grid labels are page coordinates, so the crop can be read in page fractions. */
export async function renderRegion(doc: PdfDocument, index: number, rect: Rect, options: RenderOptions = {}): Promise<RenderedImage> {
  doc.assertPage(index);
  const pad = options.padding ?? 0.01;
  const view = clampRect({ left: rect.left - pad, top: rect.top - pad, right: rect.right + pad, bottom: rect.bottom + pad });
  return renderView(doc, index, view, options, 1400);
}

// ---------------------------------------------------------------------------------------------------------------------
// Overlays

function mapper(width: number, height: number, view: Rect): { x: (value: number) => number; y: (value: number) => number } {
  return {
    x: (value) => ((value - view.left) / rectWidth(view)) * width,
    y: (value) => ((value - view.top) / rectHeight(view)) * height,
  };
}

function drawGrid(context: SKRSContext2D, width: number, height: number, view: Rect, step: number, family: string): void {
  const map = mapper(width, height, view);
  const fontPx = Math.max(10, Math.min(14, Math.round(Math.min(width, height) / 55)));
  context.save();
  context.font = `${fontPx}px "${family}"`;
  context.textBaseline = 'top';
  const decimals = step < 0.1 ? 2 : 1;
  const labelled = (value: number): boolean => step >= 0.1 || Math.abs(value * 20 - Math.round(value * 20)) < 1e-6;
  const draw = (vertical: boolean): void => {
    const from = Math.ceil((vertical ? view.left : view.top) / step - 1e-9);
    const to = Math.floor((vertical ? view.right : view.bottom) / step + 1e-9);
    for (let n = from; n <= to; n += 1) {
      const value = n * step;
      const major = Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;
      context.strokeStyle = major ? 'rgba(220, 38, 38, 0.55)' : 'rgba(220, 38, 38, 0.28)';
      context.lineWidth = major ? 1.2 : 0.8;
      context.beginPath();
      if (vertical) {
        const x = Math.round(map.x(value)) + 0.5;
        context.moveTo(x, 0);
        context.lineTo(x, height);
      } else {
        const y = Math.round(map.y(value)) + 0.5;
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
      if (!labelled(value)) continue;
      const text = value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
      const label = text === '' ? '0' : text;
      const textWidth = context.measureText(label).width;
      const places: [number, number][] = vertical
        ? [
            [map.x(value) + 2, 2],
            [map.x(value) + 2, height - fontPx - 4],
          ]
        : [
            [2, map.y(value) + 1],
            [width - textWidth - 6, map.y(value) + 1],
          ];
      for (const [px, py] of places) {
        context.fillStyle = 'rgba(255, 255, 255, 0.85)';
        context.fillRect(px - 1, py - 1, textWidth + 4, fontPx + 3);
        context.fillStyle = major ? '#b91c1c' : '#dc2626';
        context.fillText(label, px + 1, py);
      }
    }
  };
  draw(true);
  draw(false);
  context.restore();
}

function drawBoxes(context: SKRSContext2D, width: number, height: number, view: Rect, boxes: OverlayBox[], family: string): void {
  const map = mapper(width, height, view);
  const fontPx = Math.max(11, Math.min(15, Math.round(Math.min(width, height) / 50)));
  context.save();
  context.font = `bold ${fontPx}px "${family}"`;
  context.textBaseline = 'middle';
  for (const box of boxes) {
    const color = KIND_COLORS[box.kind];
    const x = map.x(box.rect.left);
    const y = map.y(box.rect.top);
    const w = map.x(box.rect.right) - x;
    const h = map.y(box.rect.bottom) - y;
    context.fillStyle = `${color}14`;
    context.fillRect(x, y, w, h);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash(box.dashed ? [7, 5] : []);
    context.strokeRect(x, y, w, h);
    context.setLineDash([]);
    const tagWidth = context.measureText(box.label).width + 10;
    const tagHeight = fontPx + 6;
    const tagY = y - tagHeight >= 0 ? y - tagHeight : y;
    context.fillStyle = color;
    context.fillRect(x, tagY, tagWidth, tagHeight);
    context.fillStyle = '#ffffff';
    context.fillText(box.label, x + 5, tagY + tagHeight / 2 + 1);
  }
  context.restore();
}
