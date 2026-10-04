/**
 * The arithmetic of a long list that draws only the rows in view (a book can have thousands of frames and hundreds of
 * sections; a row for each would make every change of the project slow). Fixed row heights make it a division.
 */

/** The rows to draw for a viewport: [first, end), with `overscan` rows more on each side, never outside 0..count. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): { first: number; end: number } {
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight) + overscan);
  return { first: Math.min(first, count), end: Math.max(Math.min(first, count), end) };
}

/** Where to scroll so that row `index` is in view, or undefined when it already is (centred when it has to move). */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number | undefined {
  const top = index * rowHeight;
  if (top >= scrollTop && top + rowHeight <= scrollTop + viewport) return undefined;
  return Math.max(0, top - viewport / 2 + rowHeight / 2);
}
