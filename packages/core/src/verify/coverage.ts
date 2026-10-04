import { LIMITS } from '../rules/constants.js';
import type { Rect } from '../model/types.js';
import { draft, type Draft, type Exercise, type Where } from './common.js';
import { excerpt } from './labels.js';
import type { ItemStart, PieceKind } from './lineclass.js';
import type { Piece } from './regions.js';
import { chainOf, coveredShare, pagesOfRange, pos, zoneLead, type Covering, type Run, type Zone } from './run.js';
import { sectionAtKey } from './key.js';
import { VERIFY_LIMITS } from './types.js';

/**
 * No text left behind: every line of the text layer inside the zone of an exercise section, inside the answer key and between
 * the regions of one exercise must be in some region, unless it is furniture (a running header, a page number) or a heading.
 * What is left is reported where it matters: a numbered line is a missed exercise (or answer), the lines under a region are
 * probably its cut-off end, the lines between two regions of one exercise are a span that skips text.
 */

interface Uncovered {
  piece: Piece;
  page: number;
  kind: PieceKind;
  item: ItemStart | undefined;
}

const height = (piece: Piece): number => Math.max(1e-6, piece.rect.bottom - piece.rect.top);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
const centreOf = (piece: Piece): number => (piece.rect.left + piece.rect.right) / 2;
const xOverlap = (piece: Piece, rect: Rect): number => Math.min(piece.rect.right, rect.right) - Math.max(piece.rect.left, rect.left);

/** The exercise whose last region ends at the bottom of the page before and in the column of a piece at the top of a page: the piece may be the rest of it. */
function continuedFrom(run: Run, page: number, piece: Piece): Covering | undefined {
  let best: Covering | undefined;
  for (const region of run.covering(page - 1)) {
    if (region.kind !== 'exercise' && region.kind !== 'continues') continue;
    const chain = chainOf(region.frame);
    const last = chain[chain.length - 1] as (typeof chain)[number];
    if (last.page !== region.page || last.rect !== region.rect) continue;
    if (xOverlap(piece, region.rect) < 0.3 * (piece.rect.right - piece.rect.left)) continue;
    if (best === undefined || region.rect.bottom > best.rect.bottom) best = region;
  }
  return best;
}

/** The region a piece goes on from: it starts right under it, in its column. */
function regionAbove(run: Run, page: number, piece: Piece, kinds: readonly Covering['kind'][]): Covering | undefined {
  let best: Covering | undefined;
  for (const region of run.covering(page)) {
    if (!kinds.includes(region.kind)) continue;
    const gap = piece.rect.top - region.rect.bottom;
    if (gap < -0.5 * height(piece) || gap > VERIFY_LIMITS.blockGap * height(piece)) continue;
    if (piece.rect.left < region.rect.left - 0.02 || piece.rect.left >= region.rect.right) continue;
    if (best === undefined || Math.abs(gap) < Math.abs(piece.rect.top - best.rect.bottom)) best = region;
  }
  return best;
}

/** Lines that stand together: close one under the other, at about the same left edge. */
function blocks(items: readonly Uncovered[]): Uncovered[][] {
  const sorted = [...items].sort((a, b) => a.piece.rect.top - b.piece.rect.top || a.piece.rect.left - b.piece.rect.left);
  const clusters: Uncovered[][] = [];
  for (const item of sorted) {
    let target: Uncovered[] | undefined;
    for (const cluster of clusters) {
      for (const other of cluster.slice(-3)) {
        const gap = item.piece.rect.top - other.piece.rect.bottom;
        if (gap <= VERIFY_LIMITS.blockGap * Math.max(height(item.piece), height(other.piece)) && Math.abs(item.piece.rect.left - other.piece.rect.left) < 0.08) {
          target = cluster;
          break;
        }
      }
      if (target) break;
    }
    if (target) target.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

/** A block split where a numbered line starts: the lines before the first number, then each number with the lines that follow it. */
function groups(block: readonly Uncovered[]): Uncovered[][] {
  const result: Uncovered[][] = [];
  let current: Uncovered[] = [];
  for (const entry of block) {
    if (entry.item !== undefined && current.length > 0) {
      result.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0) result.push(current);
  return result;
}

const text = (group: readonly Uncovered[]): string => excerpt(group.map((entry) => entry.piece.text).join(' '), VERIFY_LIMITS.evidenceLength);
const count = (group: readonly Uncovered[]): string => (group.length === 1 ? 'a line' : `${group.length} lines`);

// ---------------------------------------------------------------------------------------------------------------------
// The gaps inside an exercise: what lies between two consecutive regions of one frame

interface Gap {
  frame: Exercise;
  /** Index of the region the gap follows in the chain of the frame (0 is the main region). */
  after: number;
  /** The pages the gap touches and whether a piece of a page lies in it. */
  pages: number[];
  has(page: number, piece: Piece): boolean;
}

const SMALL = 0.004;

function gapsOf(exercise: Exercise): Gap[] {
  const chain = chainOf(exercise.frame);
  const result: Gap[] = [];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const a = chain[i] as (typeof chain)[number];
    const b = chain[i + 1] as (typeof chain)[number];
    const below = (piece: Piece, rect: Rect): boolean => piece.rect.top >= rect.bottom - SMALL && xOverlap(piece, rect) >= 0.5 * (piece.rect.right - piece.rect.left);
    const above = (piece: Piece, rect: Rect): boolean => piece.rect.bottom <= rect.top + SMALL && xOverlap(piece, rect) >= 0.5 * (piece.rect.right - piece.rect.left);
    if (a.page === b.page) {
      if (b.rect.top >= a.rect.bottom - SMALL) {
        const span: Rect = { left: Math.min(a.rect.left, b.rect.left), right: Math.max(a.rect.right, b.rect.right), top: a.rect.bottom, bottom: b.rect.top };
        result.push({ frame: exercise, after: i, pages: [a.page], has: (page, piece) => page === a.page && piece.rect.top >= span.top - SMALL && piece.rect.bottom <= span.bottom + SMALL && xOverlap(piece, span) >= 0.5 * (piece.rect.right - piece.rect.left) });
      } else if (b.rect.left >= a.rect.right - 0.02) {
        result.push({ frame: exercise, after: i, pages: [a.page], has: (page, piece) => page === a.page && (below(piece, a.rect) || above(piece, b.rect)) });
      }
    } else if (a.page < b.page) {
      const pages: number[] = [];
      for (let page = a.page; page <= b.page; page += 1) pages.push(page);
      result.push({
        frame: exercise,
        after: i,
        pages,
        has: (page, piece) => {
          if (page === a.page) return below(piece, a.rect) || (piece.rect.left >= a.rect.right - 0.02 && piece.rect.top >= a.rect.top - SMALL);
          if (page === b.page) return above(piece, b.rect) || piece.rect.right <= b.rect.left + 0.02;
          return page > a.page && page < b.page;
        },
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------

export function checkCoverage(run: Run): Draft[] {
  const drafts: Draft[] = [];
  const { layout } = run;
  const pageCount = run.project.pdf.pageCount;

  // The pages to look at: the zones, the key, and the pages inside a span.
  const gapsByPage = new Map<number, Gap[]>();
  const spans: Gap[] = [];
  for (const exercise of run.state.exercises) {
    if (exercise.frame.continues === undefined || exercise.frame.continues.length === 0) continue;
    for (const gap of gapsOf(exercise)) {
      spans.push(gap);
      for (const page of gap.pages) {
        const list = gapsByPage.get(page);
        if (list) list.push(gap);
        else gapsByPage.set(page, [gap]);
      }
    }
  }
  const pages = new Set<number>();
  for (const zone of layout.zones) for (const page of pagesOfRange(zoneLead(zone), zone.end, pageCount)) pages.add(page);
  if (layout.key !== undefined && !run.filtered) for (let page = layout.key.first; page <= Math.min(layout.key.last, pageCount - 1); page += 1) pages.add(page);
  for (const page of gapsByPage.keys()) if (page >= 0 && page < pageCount) pages.add(page);

  /** The zone a place is in, and whether it is only in the lead above the first exercise (where a numbered line is judged, nothing else). */
  const zoneAt = (at: number): { zone: Zone; lead: boolean } | undefined => {
    let found: { zone: Zone; lead: boolean } | undefined;
    for (const zone of layout.zones) {
      const from = zoneLead(zone);
      if (from > at) break;
      if (at >= zone.start && at < zone.end) found = { zone, lead: false };
      else if (at >= from && at < zone.start && found === undefined) found = { zone, lead: true };
    }
    return found;
  };

  // Where the answers are: on every page that has a solution region, from the first of them to a little below the last; for the key
  // at the back of the book, from the first answer on to the end of its last page.
  const bands = new Map<number, { top: number; bottom: number }>();
  for (const frame of run.filtered ? run.state.exercises.map((exercise) => exercise.frame) : run.project.frames) {
    for (const region of frame.solution ?? []) {
      const held = bands.get(region.page);
      if (held) {
        held.top = Math.min(held.top, region.rect.top);
        held.bottom = Math.max(held.bottom, region.rect.bottom);
      } else bands.set(region.page, { top: region.rect.top, bottom: region.rect.bottom });
    }
  }
  if (layout.key !== undefined && !run.filtered) {
    for (let page = layout.key.first; page <= Math.min(layout.key.last, pageCount - 1); page += 1) {
      const held = bands.get(page);
      bands.set(page, { top: page === layout.key.first ? (held?.top ?? 0) : 0, bottom: 1 });
    }
  }
  for (const page of bands.keys()) if (page >= 0 && page < pageCount) pages.add(page);

  const stats = new Map<Zone, { covered: number; total: number }>();
  const byGap = new Map<Gap, Uncovered[]>();
  const byGroup = new Map<string, { zone: Zone | undefined; domain: 'exercise' | 'answers'; page: number; items: Uncovered[] }>();
  for (const page of [...pages].sort((a, b) => a - b)) {
    const lines = run.index.page(page);
    if (!lines.hasText) continue;
    const kinds = run.kinds(page);
    const regions = run.covering(page);
    const band = bands.get(page);
    for (const piece of lines.pieces) {
      const kind = kinds.kind(piece);
      if (kind === 'furniture' || kind === 'heading' || kind === 'symbol') continue;
      const middle = (piece.rect.top + piece.rect.bottom) / 2;
      const inBand = band !== undefined && middle >= band.top - 0.01 && middle <= band.bottom + 0.04;
      const hit = zoneAt(pos(page, middle));
      const zone = hit?.zone;
      // Above the first exercise only a numbered line is looked at: the exercise before the first, that the audit missed.
      const item = kinds.item(piece);
      if (hit?.lead === true && (kind !== 'item' || inBand || item?.dotted === true)) continue;
      const covered = coveredShare(piece.rect, regions) >= VERIFY_LIMITS.coveredShare;
      if (zone !== undefined && hit?.lead !== true && !inBand) {
        const held = stats.get(zone) ?? { covered: 0, total: 0 };
        held.total += 1;
        if (covered) held.covered += 1;
        stats.set(zone, held);
      }
      if (covered) continue;
      // A dotted number counts examples and definitions as well as exercises: in the exercises it does not make a missed exercise.
      const entry: Uncovered = { piece, page, kind, item: item?.dotted === true && !inBand ? undefined : item };
      const gap = (gapsByPage.get(page) ?? []).find((candidate) => candidate.has(page, piece));
      if (gap) {
        const list = byGap.get(gap);
        if (list) list.push(entry);
        else byGap.set(gap, [entry]);
        continue;
      }
      const domain = inBand ? 'answers' : zone !== undefined ? 'exercise' : undefined;
      if (domain === undefined) continue;
      const key = `${domain}|${zone?.id ?? ''}|${page}`;
      const held = byGroup.get(key);
      if (held) held.items.push(entry);
      else byGroup.set(key, { zone, domain, page, items: [entry] });
    }
  }

  // A section is a practice set when its exercises are together: most of the text from the first of them to the end of the section is
  // in regions. Where they stand inline between paragraphs of ordinary text, the text between them is not an exercise left behind.
  const inline = run.inline;
  for (const zone of layout.zones) {
    const held = stats.get(zone);
    // Fewer than three exercises are no block (a block is told from inline exercises by how much text lies between them).
    const few = zone.exercises.length < VERIFY_LIMITS.practiceMinExercises;
    if (!few && (held === undefined || held.total === 0 || held.covered >= VERIFY_LIMITS.practiceShare * held.total)) continue;
    inline.add(zone);
    if (few || held === undefined) continue;
    drafts.push(
      draft(
        'inline-section',
        'info',
        zone.id,
        Math.floor(zone.start),
        `The exercises of section ${zone.id} are not together in a block (${zone.exercises.length} of them; ${held.covered} of the ${held.total} lines from the first exercise to the end of the section are in a region): text that no region holds is not checked there, the end of each exercise region is.`,
        `${held.covered} of ${held.total} lines in a region`,
        { section: zone.rank, page: Math.floor(zone.start), top: zone.start - Math.floor(zone.start), left: 0 },
      ),
    );
  }

  // --- span-gap: text between two regions of one exercise --------------------------------------------------------------------
  for (const gap of spans) {
    const found = byGap.get(gap);
    if (!found || found.length === 0) continue;
    const first = [...found].sort((a, b) => a.page - b.page || a.piece.rect.top - b.piece.rect.top)[0] as Uncovered;
    const exercise = gap.frame;
    const chain = chainOf(exercise.frame);
    const from = (chain[gap.after] as (typeof chain)[number]).page;
    const to = (chain[gap.after + 1] as (typeof chain)[number]).page;
    drafts.push(
      draft(
        'span-gap',
        'error',
        exercise.ref,
        first.page,
        `${exercise.ref} goes on in another region (page ${from} to page ${to}), but ${count(found)} of text between the two regions ${found.length === 1 ? 'is' : 'are'} in no region: the span skips part of the exercise.`,
        text(found.sort((a, b) => a.page - b.page || a.piece.rect.top - b.piece.rect.top)),
        { ...exercise.where, page: first.page, top: first.piece.rect.top, left: first.piece.rect.left },
      ),
    );
  }

  // --- the zones, the answers and the key ----------------------------------------------------------------------------------------
  for (const { zone, domain, page, items } of [...byGroup.values()].sort((a, b) => a.page - b.page || (a.zone?.start ?? 0) - (b.zone?.start ?? 0))) {
    if (domain === 'exercise' && zone !== undefined && inline.has(zone)) continue;
    const regions = run.covering(page);
    const where = (entry: Uncovered): Where => ({ section: zone?.rank ?? 1_500_000, page, top: entry.piece.rect.top, left: entry.piece.rect.left });
    const numbered = items.filter((entry) => entry.item !== undefined);
    // A page that no region touches at all (a glossary, an index, a chapter review that was not audited) is one finding.
    if (regions.length === 0 && items.length >= 3) {
      const first = [...items].sort((a, b) => a.piece.rect.top - b.piece.rect.top || a.piece.rect.left - b.piece.rect.left)[0] as Uncovered;
      const label = numbered[0]?.item?.label;
      if (numbered.length >= 3 && domain === 'exercise') {
        drafts.push(
          draft(
            'numbered-text-left-behind',
            'error',
            `${zone?.id ?? 'key'}:${label as string}`,
            page,
            `Page ${page} has ${items.length} lines of text, ${numbered.length} of them numbered, and no region at all: exercises that were missed, or a part of the book that is not an exercise set.`,
            text([first]),
            where(first),
          ),
        );
      } else if (numbered.length >= 3) {
        drafts.push(
          draft('answer-left-behind', 'error', `${sectionAtKey(run, page, first.piece.rect.top) ?? 'key'}:${label as string}`, page, `Page ${page} of the answer key has ${items.length} lines of text, ${numbered.length} of them numbered, and no region at all: answers that belong to no exercise.`, text([first]), where(first)),
        );
      } else {
        drafts.push(
          draft('text-left-behind', domain === 'exercise' ? 'warning' : 'info', zone?.id ?? sectionAtKey(run, page, first.piece.rect.top) ?? 'key', page, `Page ${page} has ${items.length} lines of text and no region at all.`, text([first]), where(first)),
        );
      }
      continue;
    }
    for (const block of blocks(items)) {
      for (const group of groups(block)) {
        const first = group[0] as Uncovered;
        const where1 = where(first);
        const item = first.item;
        const sectionGuess = domain === 'answers' ? (sectionAtKey(run, page, first.piece.rect.top) ?? zone?.id) : zone?.id;
        if (item !== undefined) {
          if (domain === 'exercise') {
            drafts.push(
              draft(
                'numbered-text-left-behind',
                'error',
                `${zone?.id as string}:${item.label}`,
                page,
                `A line that starts like exercise ${item.label} (${count(group)} of text on page ${page}) is in no region of section ${zone?.id as string}: an exercise or a part that was missed.`,
                text(group),
                where1,
              ),
            );
          } else {
            drafts.push(
              draft(
                'answer-left-behind',
                'error',
                `${sectionGuess ?? 'key'}:${item.label}`,
                page,
                `A line that starts like the answer ${item.label} (${count(group)} of text on page ${page}) is in no solution region: an answer that belongs to no exercise, or an exercise that was missed.`,
                text(group),
                where1,
              ),
            );
          }
          continue;
        }
        if (domain === 'exercise') {
          const above = regionAbove(run, page, first.piece, ['exercise', 'continues']);
          const owner = above === undefined ? undefined : run.refOf(above.frame);
          const before = owner === undefined && first.piece.rect.top < 0.25 ? continuedFrom(run, page, first.piece) : undefined;
          const earlier = before === undefined ? undefined : run.refOf(before.frame);
          drafts.push(
            draft(
              'text-left-behind',
              'warning',
              owner ?? earlier ?? zone?.id ?? 'key',
              page,
              owner !== undefined
                ? `${count(group)} of text on page ${page} go on right below the region of ${owner} and are in no region: its bottom edge may cut the exercise off.`
                : earlier !== undefined
                  ? `${count(group)} of text at the top of page ${page} ${group.length === 1 ? 'is' : 'are'} in no region: probably the rest of ${earlier}, which ends on the page before (a continuation is missing).`
                  : `${count(group)} of text on page ${page} in the exercises of section ${zone?.id as string} ${group.length === 1 ? 'is' : 'are'} in no region.`,
              text(group),
              where1,
            ),
          );
          continue;
        }
        const clipped = regionAbove(run, page, first.piece, ['solution']);
        if (clipped !== undefined) {
          const owner = run.refOf(clipped.frame);
          drafts.push(
            draft('answer-clipped', 'warning', owner, page, `${count(group)} of text on page ${page} go on right below the solution region of ${owner} and are in no region: the answer may be cut off at its bottom edge.`, text(group), where1),
          );
        } else {
          drafts.push(
            draft('text-left-behind', 'info', sectionGuess ?? 'key', page, `${count(group)} of text on page ${page} in the answers ${group.length === 1 ? 'is' : 'are'} in no solution region.`, text(group), where1),
          );
        }
      }
    }
  }

  // --- an inline section: every exercise region ends where its own text ends, and holds no other exercise ---------------------------
  for (const zone of layout.zones) {
    if (!inline.has(zone)) continue;
    const labels = new Set(zone.exercises.map((exercise) => exercise.label));
    for (const exercise of zone.exercises) {
      for (const region of chainOf(exercise.frame)) {
        if (region.page < 0 || region.page >= pageCount) continue;
        const lines = run.index.page(region.page);
        if (!lines.hasText) continue;
        const kinds = run.kinds(region.page);
        const inside = lines.pieces.filter((piece) => {
          const centre = centreOf(piece);
          const middle = (piece.rect.top + piece.rect.bottom) / 2;
          return !piece.headerFooter && centre >= region.rect.left && centre <= region.rect.right && middle >= region.rect.top && middle <= region.rect.bottom;
        });
        if (inside.length === 0) continue;
        // No line of the region starts another exercise of the section.
        const own = inside[0] as Piece;
        for (const piece of inside) {
          if (piece === own) continue;
          const item = kinds.item(piece);
          if (item === undefined || item.part || item.label === exercise.label || !labels.has(item.label)) continue;
          drafts.push(
            draft(
              'region-holds-item',
              'error',
              exercise.ref,
              region.page,
              `The region of ${exercise.ref} on page ${region.page} holds a line that starts exercise ${item.label} of the same section: it reaches into the next exercise.`,
              excerpt(piece.text, VERIFY_LIMITS.evidenceLength),
              { ...exercise.where, page: region.page, top: piece.rect.top, left: piece.rect.left },
            ),
          );
          break;
        }
        // The text ends where the region ends: what follows is a gap, a numbered item, a heading or another exercise.
        // The last line of the text itself: at the left margin of the region (a link set at the right, a centred formula do not end a paragraph).
        const margin = Math.min(...inside.map((piece) => piece.rect.left));
        const body = inside.filter((piece) => piece.rect.left <= margin + 0.06);
        const last = [...body].sort((a, b) => b.rect.top - a.rect.top || a.rect.left - b.rect.left)[0] as Piece;
        // A paragraph that goes on has a line that reaches the right margin of the column; a short last line ends it.
        const reach = Math.max(...lines.pieces.filter((piece) => !piece.headerFooter && Math.abs(piece.rect.left - margin) <= 0.06).map((piece) => piece.rect.right));
        if (last.rect.right - margin < VERIFY_LIMITS.openEndLength * (reach - margin)) continue;
        const tops = [...new Set(body.map((piece) => Math.round(piece.rect.top * 10000)))].sort((a, b) => a - b);
        const pitch = tops.length >= 2 ? median(tops.slice(1).map((top, i) => (top - (tops[i] as number)) / 10000)) : 1.35 * height(last);
        const regions = run.covering(region.page);
        let next: Piece | undefined;
        for (const piece of lines.pieces) {
          if (piece.headerFooter || piece.rect.top < region.rect.bottom - 0.5 * height(piece)) continue;
          if (piece.rect.left >= region.rect.right || piece.rect.right <= region.rect.left) continue;
          if (xOverlap(piece, region.rect) < 0.3 * (piece.rect.right - piece.rect.left)) continue;
          if (next === undefined || piece.rect.top < next.rect.top) next = piece;
        }
        if (next === undefined || kinds.kind(next) !== 'text' && kinds.kind(next) !== 'instruction') continue;
        if (coveredShare(next.rect, regions) >= VERIFY_LIMITS.coveredShare) continue;
        if (next.rect.top - last.rect.top > VERIFY_LIMITS.openEndPitch * pitch) continue;
        drafts.push(
          draft(
            'region-open-end',
            'warning',
            exercise.ref,
            region.page,
            `The text goes on directly below the bottom edge of the region of ${exercise.ref} on page ${region.page} (no gap after its last line): its bottom edge may cut the exercise off.`,
            excerpt(next.text, VERIFY_LIMITS.evidenceLength),
            { ...exercise.where, page: region.page, top: next.rect.top, left: next.rect.left },
          ),
        );
      }
    }
  }

  // --- continuation-limit: the exercise already has the most regions it may have, and text follows ---------------------------------
  for (const exercise of run.state.exercises) {
    const continues = exercise.frame.continues;
    if (continues === undefined || continues.length < LIMITS.maxRegions) continue;
    const last = continues[continues.length - 1] as (typeof continues)[number];
    const follower = followerOf(run, last.page, last.rect);
    if (follower === undefined) continue;
    drafts.push(
      draft(
        'continuation-limit',
        'warning',
        exercise.ref,
        follower.page,
        `${exercise.ref} already has ${LIMITS.maxRegions} continuation regions, the most a frame can have, and text goes on after the last one (page ${follower.page}): the exercise is longer than its regions.`,
        excerpt(follower.piece.text, VERIFY_LIMITS.evidenceLength),
        { ...exercise.where, page: follower.page, top: follower.piece.rect.top, left: follower.piece.rect.left },
      ),
    );
  }
  return drafts;
}

/** The first line of text that follows a region and is in no region: right under it, or at the top of the next page. */
function followerOf(run: Run, page: number, rect: Rect): { page: number; piece: Piece } | undefined {
  for (const at of [page, page + 1]) {
    if (at >= run.project.pdf.pageCount) continue;
    const lines = run.index.page(at);
    const kinds = run.kinds(at);
    const regions = run.covering(at);
    for (const piece of lines.pieces) {
      const kind = kinds.kind(piece);
      if (kind === 'furniture' || kind === 'heading' || kind === 'symbol') continue;
      if (coveredShare(piece.rect, regions) >= VERIFY_LIMITS.coveredShare) continue;
      if (at === page) {
        const gap = piece.rect.top - rect.bottom;
        if (gap < -0.5 * height(piece) || gap > 2.5 * height(piece)) continue;
        if (piece.rect.left < rect.left - 0.02 || piece.rect.left >= rect.right) continue;
      } else if (piece.rect.top > 0.3 || centreOf(piece) < rect.left - 0.1 || centreOf(piece) > rect.right + 0.1) continue;
      return { page: at, piece };
    }
  }
  return undefined;
}
