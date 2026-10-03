import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

/**
 * pdf.js in the renderer: it draws the pages. Its worker, fonts, cmaps and wasm decoders are served from the application
 * folder by the custom scheme (no network). The text analysis (lines, proposals) is done in the main process with the same
 * code the command line uses, so the two never differ.
 */
const BASE = 'mcprep-app://app/';

pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.mjs`;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${BASE}wasm/`,
    iccUrl: `${BASE}iccs/`,
    isEvalSupported: false,
    enableXfa: false,
  });
  return task.promise;
}

export interface Drawing {
  cancel(): void;
  done: Promise<void>;
}

/** Draws a page into a canvas at `scale` CSS pixels per point (and the device's pixel ratio). */
export function drawPage(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): Drawing {
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width / ratio}px`;
  canvas.style.height = `${viewport.height / ratio}px`;
  const context = canvas.getContext('2d');
  if (!context) return { cancel: () => undefined, done: Promise.resolve() };
  const task: RenderTask = page.render({ canvasContext: context, canvas, viewport });
  return {
    cancel: () => task.cancel(),
    done: task.promise.then(
      () => undefined,
      (error: unknown) => {
        if ((error as { name?: string }).name !== 'RenderingCancelledException') throw error;
      },
    ),
  };
}
