import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { scrollToReveal, visibleRange } from '../logic/list.js';

/**
 * A list of rows of one height that puts only the rows in view (and a few more on each side) into the document. Thousands of
 * rows cost no more than a screenful. It fills the space its parent gives it and scrolls by itself.
 */
export function VirtualList<T>({
  rows,
  rowHeight,
  renderRow,
  rowKey,
  scrollTo,
  onRange,
  label,
  class: className = '',
}: {
  rows: readonly T[];
  rowHeight: number;
  renderRow: (row: T, index: number) => preact.JSX.Element;
  rowKey: (row: T, index: number) => string;
  /**
   * Scroll to this row when `tick` changes, or when the row appears (its index becomes known): only if it is out of view.
   * A row that moves because the list above it changed (a folded group) does not make the list jump.
   */
  scrollTo?: { index: number; tick: number } | null;
  /** Called with the rows in view: a list loads what its rows need (the text of their pages). */
  onRange?: (first: number, end: number) => void;
  label: string;
  class?: string;
}): preact.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 480 });
  const rangeCallback = useRef(onRange);
  rangeCallback.current = onRange;

  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return undefined;
    const measure = (): void => setView((old) => (old.height === node.clientHeight ? old : { ...old, height: node.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { first, end } = visibleRange(view.top, view.height, rowHeight, rows.length);

  useEffect(() => {
    rangeCallback.current?.(first, end);
  }, [first, end, rows]);

  useEffect(() => {
    const node = element.current;
    if (!node || !scrollTo || scrollTo.index < 0) return;
    const target = scrollToReveal(scrollTo.index, node.scrollTop, node.clientHeight, rowHeight);
    if (target !== undefined) {
      node.scrollTop = target;
      setView((old) => ({ ...old, top: node.scrollTop }));
    }
  }, [scrollTo?.tick, (scrollTo?.index ?? -1) >= 0]);

  // The rows shrank (a filter, a folded group): the scroll position may be beyond the end now.
  useEffect(() => {
    const node = element.current;
    if (node && node.scrollTop > Math.max(0, rows.length * rowHeight - node.clientHeight)) {
      node.scrollTop = Math.max(0, rows.length * rowHeight - node.clientHeight);
      setView((old) => ({ ...old, top: node.scrollTop }));
    }
  }, [rows.length]);

  const shown: preact.JSX.Element[] = [];
  for (let at = first; at < end; at += 1) {
    const row = rows[at] as T;
    shown.push(
      <div class="vrow" role="listitem" key={rowKey(row, at)} style={{ top: `${at * rowHeight}px`, height: `${rowHeight}px` }}>
        {renderRow(row, at)}
      </div>,
    );
  }
  return (
    <div
      class={`vlist ${className}`}
      ref={element}
      role="list"
      aria-label={label}
      onScroll={(event) => {
        const top = (event.currentTarget as HTMLDivElement).scrollTop;
        setView((old) => (old.top === top ? old : { ...old, top }));
      }}
    >
      <div class="vlist-inner" style={{ height: `${rows.length * rowHeight}px` }}>
        {shown}
      </div>
    </div>
  );
}
