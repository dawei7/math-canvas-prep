import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef } from 'preact/hooks';
import { useStore } from '../hooks.js';
import type { Store } from '../logic/store.js';
import { drawPage } from '../pdf.js';

const THUMB_WIDTH = 104;

function Thumb({ pdf, page, current, count, onSelect }: { pdf: PDFDocumentProxy; page: number; current: boolean; count: number; onSelect: () => void }): preact.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = holder.current;
    if (!element) return undefined;
    let drawn = false;
    let drawing: ReturnType<typeof drawPage> | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (drawn || !entries.some((entry) => entry.isIntersecting)) return;
      drawn = true;
      void pdf.getPage(page + 1).then((loaded) => {
        if (!canvas.current) return;
        const width = loaded.getViewport({ scale: 1 }).width;
        drawing = drawPage(loaded, canvas.current, THUMB_WIDTH / width);
        return drawing.done;
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      drawing?.cancel();
    };
  }, [pdf, page]);
  return (
    <button ref={holder} class={`thumb ${current ? 'current' : ''}`} onClick={onSelect} aria-label={`Page ${page + 1}`}>
      <canvas ref={canvas} />
      <span class="thumb-number">{page + 1}</span>
      {count > 0 ? <span class="thumb-count">{count}</span> : null}
    </button>
  );
}

export function Thumbnails({ store, pdf }: { store: Store; pdf: PDFDocumentProxy | null }): preact.JSX.Element {
  const state = useStore(store);
  const pages = state.doc?.pageSizes.length ?? 0;
  const counts = new Map<number, number>();
  for (const frame of state.project?.frames ?? []) counts.set(frame.page, (counts.get(frame.page) ?? 0) + 1);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.thumb.current')?.scrollIntoView({ block: 'nearest' });
  }, [state.page]);
  return (
    <div class="thumbs" ref={list} aria-label="Pages">
      {pdf ? Array.from({ length: pages }, (_unused, page) => <Thumb key={page} pdf={pdf} page={page} current={page === state.page} count={counts.get(page) ?? 0} onSelect={() => store.setPage(page)} />) : null}
    </div>
  );
}
