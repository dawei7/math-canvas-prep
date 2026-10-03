import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as CanvasNamespace from '@napi-rs/canvas';
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Loading pdf.js and the canvas lazily, and finding the font and cmap data that pdf.js needs in Node. A host that
 * bundles this package (the desktop app) can point `configurePdfRuntime` at the right folder.
 */

export type PdfJs = typeof PdfJsModule;
export type CanvasModule = typeof CanvasNamespace;

let pdfjsPromise: Promise<PdfJs> | undefined;
let canvasPromise: Promise<CanvasModule> | undefined;
let dataRoot: string | undefined;

/** Tells where pdfjs-dist keeps `standard_fonts` and `cmaps` (the pdfjs-dist package folder). */
export function configurePdfRuntime(options: { pdfjsRoot?: string }): void {
  if (options.pdfjsRoot !== undefined) dataRoot = options.pdfjsRoot;
}

export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export function loadCanvas(): Promise<CanvasModule> {
  canvasPromise ??= import('@napi-rs/canvas');
  return canvasPromise;
}

function resolveRoot(): string {
  if (dataRoot !== undefined) return dataRoot;
  let base: string;
  try {
    base = import.meta.url;
  } catch {
    base = join(process.cwd(), 'noop.js');
  }
  const require = createRequire(base || join(process.cwd(), 'noop.js'));
  dataRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  return dataRoot;
}

/** The folders of pdf.js data as plain paths with a trailing slash (pdf.js appends the file name). */
export function pdfDataDirs(): { standardFonts: string; cmaps: string; root: string } {
  const root = resolveRoot().replace(/\\/g, '/').replace(/\/$/, '');
  return { root, standardFonts: `${root}/standard_fonts/`, cmaps: `${root}/cmaps/` };
}
