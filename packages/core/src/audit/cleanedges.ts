import type { PageText, Rect } from '../model/types.js';
import { edgeInkOf, type DarkPicture } from '../verify/edge-ink.js';
import { VERIFY_LIMITS } from '../verify/types.js';
import type { BookExercises } from './exercises.js';
import type { BookSolutions } from './solutions.js';

/**
 * The regions of the proposals are cut from the boxes of the lines of the text layer, which are taller than what is printed in them: an
 * edge that stands between two lines can still run through the descender of the line above or the ascender of the line below, and an
 * edge at the foot of a table can lie on its rule. The pixel check of `exercises verify` (`edge-on-ink`) finds such edges; the audit
 * moves them to where they do not cut, by the very measure that check takes (`edgeInkOf` on the page drawn at two pixels per point):
 *
 * - an edge that cuts ink moves to the nearest row (or column) that does not. Which way depends on whose ink it is, by where most of it
 *   lies: ink that is mostly outside the region is a neighbour's and the edge moves in, past the part that reaches into the region; ink
 *   that is mostly inside is the region's own and the edge moves out, past the rest of it (at most `CLEAN_REACH` of the page); a
 *   mixture moves to the nearest clean place either way, into the region only a few pixels (as far as it takes to leave a line of a
 *   neighbour that the edge runs through);
 * - an edge that moves out never takes in printed ink of a piece of text that is not part of the region, nor a piece that the text check
 *   would then read as inside it;
 * - an edge that moves in never leaves a piece of its own text less than 60 percent inside (a left or right edge never enters the own
 *   text at all), unless another region of the group holds more of that piece, and no edge makes a region smaller or taller than the
 *   size check (`region-size`) allows;
 * - two regions of one kind that were cut by the same ink and now lie on each other share one row (or column) between their texts, or
 *   their edges stay where they were;
 * - a region that has an edge cutting ink after all that, which it did not have before, is left as it was.
 *
 * An edge that cuts no ink is never touched, so a book that has none comes back as it was.
 */

/** How far an edge may move out of its region to get out of ink, as a fraction of the page (about ten points). */
export const CLEAN_REACH = 0.012;

/** How far an edge may move into its region without a text of a neighbour to leave (the white under the descenders of the line above is a pixel or two away). */
export const INWARD_PIXELS = 4;

/** The ink of a line can stand this many pixels outside its box (the bar of a root, the tall bracket of a fraction). */
const GLYPH_SLACK = 6;

/** An edge that moves into its region leaves every piece of the own text at least this share inside (or as much as it was, when that was less). */
export const OWN_SHARE = 0.6;

/** Printed pixels of the text of neighbours that a move out may take in: a graze of an antialiased glyph, not a stroke. */
export const FOREIGN_PIXELS = 2;

/** A region keeps this much room from the sizes of `region-size` (the rectangle is written with four decimals). */
const SIZE_MARGIN = 1.02;

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface CleanItem {
  /** The rectangle of the region; moved in place (only the edges that move are changed). */
  rect: Rect;
  /** Regions of one group are not left on each other: the regions of exercises, those of answers, the instructions. */
  group: 'exercise' | 'solution' | 'context';
}

interface Pixels {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Piece {
  rect: Rect;
  /** The pixels the box of the piece covers. */
  box: Pixels;
}

interface Work {
  item: CleanItem;
  originalPx: Pixels;
  px: Pixels;
  /** The pieces of text that are part of the region. */
  own: Set<Piece>;
  /** The other regions of its group on the page. */
  peers: Work[];
  moved: Set<Side>;
  /** The edges that cut ink before anything moved. */
  cutBefore: ReadonlySet<Side>;
  /** A region that went back to where it was (the rest of the page does not move it again). */
  locked: boolean;
}

const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];

const toPixels = (rect: Rect, picture: DarkPicture): Pixels => ({
  x0: Math.max(0, Math.round(rect.left * picture.width)),
  x1: Math.min(picture.width - 1, Math.round(rect.right * picture.width) - 1),
  y0: Math.max(0, Math.round(rect.top * picture.height)),
  y1: Math.min(picture.height - 1, Math.round(rect.bottom * picture.height) - 1),
});

/** The rectangle whose pixel edges are these (the measure takes the first row inside from the top edge and the last one from the bottom edge). */
const toRect = (px: Pixels, picture: DarkPicture): Rect => ({ left: px.x0 / picture.width, top: px.y0 / picture.height, right: (px.x1 + 1) / picture.width, bottom: (px.y1 + 1) / picture.height });

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/** The edges of the pixel rectangle that cut ink, by the rule of `edge-on-ink`: ink goes across at two pixels or more, or more than two percent of the pixels around the edge are dark. */
function cutSides(picture: DarkPicture, px: Pixels): Set<Side> {
  const ink = edgeInkOf(picture, toRect(px, picture));
  return new Set(SIDES.filter((side) => (ink.cross?.[side] ?? 0) >= VERIFY_LIMITS.inkCrossPixels || ink[side] > VERIFY_LIMITS.inkEdgeShare));
}

const cuts = (picture: DarkPicture, px: Pixels, side: Side): boolean => cutSides(picture, px).has(side);

/** The pieces of text of a page that count (a line joined from pieces side by side is read piece by piece, as the text check reads it). */
function piecesOf(page: PageText | undefined, picture: DarkPicture): Piece[] {
  const pieces: Piece[] = [];
  const add = (rect: Rect): void =>
    void pieces.push({
      rect,
      box: { x0: Math.floor(rect.left * picture.width), x1: Math.ceil(rect.right * picture.width) - 1, y0: Math.floor(rect.top * picture.height), y1: Math.ceil(rect.bottom * picture.height) - 1 },
    });
  for (const line of page?.lines ?? []) {
    if (line.headerFooter === true || line.text.trim().length === 0) continue;
    if (line.parts !== undefined && line.parts.length >= 2) for (const part of line.parts) add(part.rect);
    else add(line.rect);
  }
  return pieces;
}

/** The pieces that stand in the rectangle: their centre is inside. */
function ownPieces(pieces: readonly Piece[], rect: Rect): Set<Piece> {
  const own = new Set<Piece>();
  for (const piece of pieces) {
    const x = (piece.rect.left + piece.rect.right) / 2;
    const y = (piece.rect.top + piece.rect.bottom) / 2;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) own.add(piece);
  }
  return own;
}

const positionOf = (px: Pixels, side: Side): number => (side === 'top' ? px.y0 : side === 'bottom' ? px.y1 : side === 'left' ? px.x0 : px.x1);

function withPosition(px: Pixels, side: Side, value: number): Pixels {
  return side === 'top' ? { ...px, y0: value } : side === 'bottom' ? { ...px, y1: value } : side === 'left' ? { ...px, x0: value } : { ...px, x1: value };
}

/** Whether a position of the side is further out than another. */
const outward = (side: Side, from: number, to: number): boolean => (side === 'top' || side === 'left' ? to < from : to > from);

/** How many rows (columns) two ranges share. */
const shared = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1);

/** The rows or columns an edge crosses when it moves out to a position, over the extent of the region. */
function stripOf(px: Pixels, side: Side, position: number): Pixels {
  if (side === 'top') return { x0: px.x0, x1: px.x1, y0: position, y1: px.y0 - 1 };
  if (side === 'bottom') return { x0: px.x0, x1: px.x1, y0: px.y1 + 1, y1: position };
  if (side === 'left') return { x0: position, x1: px.x0 - 1, y0: px.y0, y1: px.y1 };
  return { x0: px.x1 + 1, x1: position, y0: px.y0, y1: px.y1 };
}

/** The printed pixels of a stretch of the page that lie in the box of a piece of text that is not part of the region. */
function foreignInk(picture: DarkPicture, pieces: readonly Piece[], work: Work, strip: Pixels): number {
  let count = 0;
  for (const piece of pieces) {
    if (work.own.has(piece)) continue;
    const x0 = Math.max(strip.x0, piece.box.x0);
    const x1 = Math.min(strip.x1, piece.box.x1);
    const y0 = Math.max(strip.y0, piece.box.y0);
    const y1 = Math.min(strip.y1, piece.box.y1);
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) count += picture.dark[y * picture.width + x] as number;
  }
  return count;
}

/** The share of a piece that lies between the two edges of the region along one axis. */
function insideShare(piece: Piece, px: Pixels, picture: DarkPicture, vertical: boolean): number {
  const from = vertical ? piece.rect.top : piece.rect.left;
  const to = vertical ? piece.rect.bottom : piece.rect.right;
  const low = vertical ? px.y0 / picture.height : px.x0 / picture.width;
  const high = vertical ? (px.y1 + 1) / picture.height : (px.x1 + 1) / picture.width;
  return to - from <= 0 ? 1 : Math.max(0, Math.min(to, high) - Math.max(from, low)) / (to - from);
}

/**
 * Whether the region would take in a piece of text that is not part of it when a side moves out to a position: printed pixels of such a
 * piece lie in the rows or columns the edge crosses, or the text check would read a piece as inside the region that it did not read so.
 */
function takesIn(pieces: readonly Piece[], work: Work, side: Side, position: number, picture: DarkPicture): boolean {
  if (foreignInk(picture, pieces, work, stripOf(work.px, side, position)) > FOREIGN_PIXELS) return true;
  const moved = withPosition(work.px, side, position);
  for (const piece of pieces) {
    if (work.own.has(piece)) continue;
    // The text check: the centre of the piece is between the left and the right edge and half of it is between the top and the bottom edge.
    const reads = (px: Pixels): boolean => {
      const x = (piece.rect.left + piece.rect.right) / 2;
      return x >= px.x0 / picture.width && x <= (px.x1 + 1) / picture.width && insideShare(piece, px, picture, true) >= 0.5;
    };
    if (reads(moved) && !reads(work.px)) return true;
  }
  return false;
}

/**
 * How many pixels an edge may move into its region: a few, and as far as it takes to leave a line of text of a neighbour that the edge
 * runs through (the region has a strip of that line, which is no part of it).
 */
function inwardReach(pieces: readonly Piece[], work: Work, side: Side): number {
  const here = positionOf(work.px, side);
  let reach = INWARD_PIXELS;
  for (const piece of pieces) {
    if (work.own.has(piece)) continue;
    const box = piece.box;
    if (side === 'top' || side === 'bottom') {
      if (shared(work.px.x0, work.px.x1, box.x0, box.x1) < 2 || here < box.y0 || here > box.y1) continue;
      reach = Math.max(reach, side === 'top' ? box.y1 + GLYPH_SLACK - here : here - box.y0 + GLYPH_SLACK);
    } else {
      if (shared(work.px.y0, work.px.y1, box.y0, box.y1) < 2 || here < box.x0 || here > box.x1) continue;
      reach = Math.max(reach, side === 'left' ? box.x1 + GLYPH_SLACK - here : here - box.x0 + GLYPH_SLACK);
    }
  }
  return reach;
}

/** How far from an edge the ink that it cuts is followed, in pixels. */
const MASS_WINDOW = 64;

/** How far an edge may move into its region to let go of the ink of a neighbour that reaches into it, as a fraction of the page (about twenty points). */
const RELEASE_REACH = 0.024;

/** The ink on one side of an edge must be this many times the ink on the other for the edge to say whose it is. */
const MASS_RATIO = 1.5;

/** The printed ink that an edge cuts, followed from the edge over the pixels that touch (a window around it): how much lies on each side, and how deep into the region it goes. */
interface Mass {
  inside: number;
  outside: number;
  /** The rows (columns) of the region that the ink takes, counted from the edge. */
  depth: number;
  /** The rows (columns) outside the region that it takes (the walk stops at the window). */
  outsideDepth: number;
}

function massOf(picture: DarkPicture, px: Pixels, side: Side): Mass {
  const { width, height, dark } = picture;
  const horizontal = side === 'top' || side === 'bottom';
  const edge = positionOf(px, side);
  const alongFrom = horizontal ? px.x0 : px.y0;
  const alongTo = horizontal ? px.x1 : px.y1;
  const from = Math.max(0, alongFrom - 2);
  const to = Math.min((horizontal ? width : height) - 1, alongTo + 2);
  const lowAcross = Math.max(0, edge - MASS_WINDOW);
  const highAcross = Math.min((horizontal ? height : width) - 1, edge + MASS_WINDOW);
  const span = to - from + 1;
  const at = (along: number, across: number): number => (horizontal ? (dark[across * width + along] as number) : (dark[along * width + across] as number));
  const seen = new Uint8Array(Math.max(0, span * (highAcross - lowAcross + 1)));
  const index = (along: number, across: number): number => (across - lowAcross) * span + (along - from);
  const stack: number[] = [];
  const visit = (along: number, across: number): void => {
    if (along < from || along > to || across < lowAcross || across > highAcross || at(along, across) !== 1 || seen[index(along, across)] === 1) return;
    seen[index(along, across)] = 1;
    stack.push(along, across);
  };
  // The ink in the rows (columns) around the edge, along the region, starts the walk.
  for (let across = edge - 1; across <= edge + 1; across += 1) for (let along = alongFrom; along <= alongTo; along += 1) visit(along, across);
  const sign = side === 'top' || side === 'left' ? 1 : -1;
  const mass: Mass = { inside: 0, outside: 0, depth: 0, outsideDepth: 0 };
  while (stack.length > 0) {
    const across = stack.pop() as number;
    const along = stack.pop() as number;
    const offset = (across - edge) * sign;
    if (offset >= 0) {
      mass.inside += 1;
      mass.depth = Math.max(mass.depth, offset);
    } else {
      mass.outside += 1;
      mass.outsideDepth = Math.max(mass.outsideDepth, -offset);
    }
    for (let a = -1; a <= 1; a += 1) for (let b = -1; b <= 1; b += 1) visit(along + a, across + b);
  }
  return mass;
}

/** Which way an edge that cuts ink moves: in when the ink is mostly outside (a neighbour's), out when it is mostly inside (the region's own), else either way. */
function wayOf(mass: Mass): 'in' | 'out' | 'either' {
  // How far the ink reaches on each side of the edge tells first (a glyph, a figure), the amount of it second (a rule has no reach).
  if (mass.outsideDepth > mass.depth * MASS_RATIO + 2) return 'in';
  if (mass.depth > mass.outsideDepth * MASS_RATIO + 2) return 'out';
  if (mass.outside > mass.inside * MASS_RATIO) return 'in';
  return mass.inside > mass.outside * MASS_RATIO ? 'out' : 'either';
}

/** Whether a side can move into its region to a position: the region has text of its own, none of it is left less than `OWN_SHARE` inside, and the move is short. */
function mayMoveIn(work: Work, side: Side, position: number, picture: DarkPicture, cap: number): boolean {
  if (work.own.size === 0 || Math.abs(position - positionOf(work.px, side)) > cap) return false;
  // A white column inside the text (between the number and the words) is no place for a side edge: it stays outside the own text.
  if (side === 'left' && position > Math.min(...[...work.own].map((piece) => piece.box.x0))) return false;
  if (side === 'right' && position < Math.max(...[...work.own].map((piece) => piece.box.x1))) return false;
  const moved = withPosition(work.px, side, position);
  const vertical = side === 'top' || side === 'bottom';
  for (const piece of work.own) {
    // A piece that another region of the group holds more of (the numerator of the next answer, which the box of this one reaches into) may go.
    if (work.peers.some((peer) => peer.own.has(piece) && insideShare(piece, peer.px, picture, vertical) > insideShare(piece, work.px, picture, vertical) + 0.1)) continue;
    if (insideShare(piece, moved, picture, vertical) < Math.min(OWN_SHARE, insideShare(piece, work.px, picture, vertical))) return false;
  }
  return true;
}

/** Whether the region with a side at a position stays within the sizes the text check allows, or is no further from them than it was. */
function sizeOk(picture: DarkPicture, work: Work, side: Side, position: number): boolean {
  const size = (px: Pixels): { width: number; height: number; area: number } => {
    const rect = toRect(px, picture);
    return { width: rect.right - rect.left, height: rect.bottom - rect.top, area: (rect.right - rect.left) * (rect.bottom - rect.top) };
  };
  const before = size(work.px);
  const after = size(withPosition(work.px, side, position));
  if (after.width < VERIFY_LIMITS.minWidth * SIZE_MARGIN && after.width < before.width) return false;
  if (after.area < VERIFY_LIMITS.minArea * SIZE_MARGIN && after.area < before.area) return false;
  return !(after.height > VERIFY_LIMITS.maxHeight / SIZE_MARGIN && after.height > before.height);
}

/** Whether the edge of a side can stand at a position (the rules for the direction it moves in) and cuts no ink there. */
function usable(picture: DarkPicture, pieces: readonly Piece[], work: Work, side: Side, position: number, cap: number): boolean {
  const here = positionOf(work.px, side);
  if (position !== here && (outward(side, here, position) ? takesIn(pieces, work, side, position, picture) : !mayMoveIn(work, side, position, picture, cap))) return false;
  if (position !== here && !sizeOk(picture, work, side, position)) return false;
  return !cuts(picture, withPosition(work.px, side, position), side);
}

/** The nearest position of a side where its edge does not cut ink, or undefined. */
function cleanPosition(picture: DarkPicture, pieces: readonly Piece[], work: Work, side: Side, reach: number): number | undefined {
  const size = side === 'top' || side === 'bottom' ? picture.height : picture.width;
  const limit = Math.round(reach * size);
  const here = positionOf(work.px, side);
  const direction = side === 'top' || side === 'left' ? 1 : -1;
  // The ink the edge cuts says which way it goes: the ink of a neighbour is let go (the edge moves in, as far as the ink reaches into
  // the region), the ink of the region is taken in (the edge moves out). A mixture goes either way, the nearest clean place.
  const mass = massOf(picture, work.px, side);
  const way = wayOf(mass);
  const cap = way === 'in' ? Math.min(Math.round(RELEASE_REACH * size), Math.max(INWARD_PIXELS, mass.depth + 3)) : inwardReach(pieces, work, side);
  for (let distance = 1; distance <= Math.max(limit, cap); distance += 1) {
    // The inward position first: it takes in nothing.
    for (const position of [here + direction * distance, here - direction * distance]) {
      if (position < 1 || position > size - 2) continue;
      const out = outward(side, here, position);
      if (out ? way === 'in' || distance > limit : way === 'out') continue;
      if (usable(picture, pieces, work, side, position, cap)) return position;
    }
  }
  return undefined;
}

/** The position between low and high nearest to the middle that the test accepts, or undefined. */
function nearestClean(low: number, high: number, middle: number, clean: (position: number) => boolean): number | undefined {
  const start = Math.max(low, Math.min(high, middle));
  for (let distance = 0; distance <= high - low; distance += 1) {
    for (const candidate of distance === 0 ? [start] : [start - distance, start + distance]) {
      if (candidate >= low && candidate <= high && clean(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Puts a side back where it was. */
function restore(work: Work, side: Side): void {
  work.px = withPosition(work.px, side, positionOf(work.originalPx, side));
  work.moved.delete(side);
}

/**
 * Regions of one group that now lie on each other (a move took one into the other, both cut by the same ink) get one row or column
 * between their texts that is clean for both, within the reach of where their edges were; when there is none, the edges that moved go back.
 * The overlap that was there before the moves is not touched.
 */
function separate(picture: DarkPicture, pieces: readonly Piece[], works: Work[], reach: number): void {
  const rowReach = Math.round(reach * picture.height);
  const columnReach = Math.round(reach * picture.width);
  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    for (const a of works) {
      for (const b of works) {
        if (a === b || a.item.group !== b.item.group || a.item.group === 'context') continue;
        const columns = shared(a.px.x0, a.px.x1, b.px.x0, b.px.x1);
        const rows = shared(a.px.y0, a.px.y1, b.px.y0, b.px.y1);
        if (columns === 0 || rows === 0) continue;
        const beforeColumns = shared(a.originalPx.x0, a.originalPx.x1, b.originalPx.x0, b.originalPx.x1);
        const beforeRows = shared(a.originalPx.y0, a.originalPx.y1, b.originalPx.y0, b.originalPx.y1);
        const stacked = columns >= rows;
        // Only what the moves added: regions that overlapped before are left as they were.
        if (stacked ? beforeColumns > 0 && rows <= beforeRows : beforeRows > 0 && columns <= beforeColumns) continue;
        const [first, second] = stacked ? (a.px.y0 < b.px.y0 || (a.px.y0 === b.px.y0 && a.px.y1 <= b.px.y1) ? [a, b] : [b, a]) : a.px.x0 < b.px.x0 || (a.px.x0 === b.px.x0 && a.px.x1 <= b.px.x1) ? [a, b] : [b, a];
        if (first !== a) continue;
        changed = true;
        const free = !first.locked && !second.locked;
        if (stacked) {
          // The upper one ends at row - 1, the lower one starts at row.
          const low = Math.max(first.originalPx.y1 + 1 - INWARD_PIXELS, second.originalPx.y0 - rowReach);
          const high = Math.min(second.originalPx.y0 + INWARD_PIXELS, first.originalPx.y1 + 1 + rowReach);
          const row = free && low <= high ? nearestClean(low, high, Math.round((first.px.y1 + second.px.y0) / 2), (candidate) => usable(picture, pieces, first, 'bottom', candidate - 1, inwardReach(pieces, first, 'bottom')) && usable(picture, pieces, second, 'top', candidate, inwardReach(pieces, second, 'top'))) : undefined;
          if (row === undefined) {
            restore(first, 'bottom');
            restore(second, 'top');
          } else {
            first.px = { ...first.px, y1: row - 1 };
            second.px = { ...second.px, y0: row };
            first.moved.add('bottom');
            second.moved.add('top');
          }
        } else {
          const low = Math.max(first.originalPx.x1 + 1 - INWARD_PIXELS, second.originalPx.x0 - columnReach);
          const high = Math.min(second.originalPx.x0 + INWARD_PIXELS, first.originalPx.x1 + 1 + columnReach);
          const column = free && low <= high ? nearestClean(low, high, Math.round((first.px.x1 + second.px.x0) / 2), (candidate) => usable(picture, pieces, first, 'right', candidate - 1, inwardReach(pieces, first, 'right')) && usable(picture, pieces, second, 'left', candidate, inwardReach(pieces, second, 'left'))) : undefined;
          if (column === undefined) {
            restore(first, 'right');
            restore(second, 'left');
          } else {
            first.px = { ...first.px, x1: column - 1 };
            second.px = { ...second.px, x0: column };
            first.moved.add('right');
            second.moved.add('left');
          }
        }
      }
    }
    if (!changed) break;
  }
}

/** Whether the region has an edge that cuts ink now that it did not cut before the moves. */
const worse = (picture: DarkPicture, work: Work): boolean => work.moved.size > 0 && [...cutSides(picture, work.px)].some((side) => !work.cutBefore.has(side));

/**
 * Cleans the edges of the regions of one page, in place. Returns how many edges were moved. A region keeps the edges that did not move
 * exactly as they were.
 */
export function cleanPage(picture: DarkPicture, page: PageText | undefined, items: readonly CleanItem[], reach: number = CLEAN_REACH): number {
  const pieces = piecesOf(page, picture);
  const works: Work[] = items
    .filter((item) => item.rect.right > item.rect.left && item.rect.bottom > item.rect.top)
    .map((item) => {
      const px = toPixels(item.rect, picture);
      return { item, originalPx: px, px, own: ownPieces(pieces, item.rect), peers: [], moved: new Set<Side>(), cutBefore: cutSides(picture, px), locked: false };
    });
  for (const work of works) work.peers = works.filter((other) => other !== work && other.item.group === work.item.group);
  for (const work of works) {
    // Top and bottom first: the measure of a side holds along the other two.
    for (const side of SIDES) {
      if (!cuts(picture, work.px, side)) continue;
      const position = cleanPosition(picture, pieces, work, side, reach);
      if (position === undefined) continue;
      work.px = withPosition(work.px, side, position);
      work.moved.add(side);
    }
  }
  separate(picture, pieces, works, reach);
  // The moves changed the stretch along which the other edges are measured: an edge that was clean can cut now.
  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    for (const work of works) {
      if (!worse(picture, work)) continue;
      changed = true;
      work.px = work.originalPx;
      work.moved.clear();
      work.locked = true;
    }
    if (!changed) break;
    separate(picture, pieces, works, reach);
  }
  let moved = 0;
  for (const work of works) {
    const rect = toRect(work.px, picture);
    for (const side of work.moved) {
      work.item.rect[side] = round4(rect[side]);
      moved += 1;
    }
  }
  return moved;
}

export interface CleanResult {
  /** How many edges moved. */
  edges: number;
  /** How many regions have an edge that moved. */
  regions: number;
  /** How many pages were drawn. */
  pages: number;
}

/**
 * Cleans the edges of the regions of the exercises (their own region, continuations and instructions) and of the solutions. `render` draws
 * a page at two pixels per point (`renderDark`); a page is drawn once and dropped, so that a book of a thousand pages needs the memory of one.
 */
export async function cleanProposals(
  render: (page: number) => Promise<DarkPicture>,
  pages: readonly PageText[],
  exercises: BookExercises | undefined,
  solutions: BookSolutions | undefined,
): Promise<CleanResult> {
  const byPage = new Map<number, CleanItem[]>();
  const add = (page: number, rect: Rect, group: CleanItem['group']): void => {
    const list = byPage.get(page);
    if (list) list.push({ rect, group });
    else byPage.set(page, [{ rect, group }]);
  };
  for (const section of exercises?.sections ?? []) {
    for (const proposal of section.proposals) {
      add(proposal.page, proposal.rect, 'exercise');
      for (const region of proposal.continues ?? []) add(region.page, region.rect, 'exercise');
      for (const region of proposal.context) add(region.page, region.rect, 'context');
    }
  }
  for (const section of solutions?.sections ?? []) for (const answer of section.answers) for (const region of answer.regions) add(region.page, region.rect, 'solution');
  const result: CleanResult = { edges: 0, regions: 0, pages: 0 };
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const picture = await render(page);
    const items = byPage.get(page) as CleanItem[];
    const before = items.map((item) => ({ ...item.rect }));
    result.edges += cleanPage(picture, pages[page], items);
    result.regions += items.filter((item, at) => (['left', 'top', 'right', 'bottom'] as const).some((side) => item.rect[side] !== (before[at] as Rect)[side])).length;
    result.pages += 1;
  }
  return result;
}
