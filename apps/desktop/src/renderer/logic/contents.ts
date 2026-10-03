import { countFrames, type Frame, type FrameKind, type OutlineEntry, type Project } from '@mcprep/core/pure';

export interface SectionCount {
  /** Zero-based first and last page of the section. */
  from: number;
  to: number;
  counts: Record<FrameKind, number>;
}

/**
 * How many exercises (an exercise with parts counts once), questions and bookmarks each section of the contents holds: from
 * its page up to the page before the next entry at the same or a higher level (the last section runs to the end).
 */
export function sectionCounts(entries: readonly OutlineEntry[], frames: readonly Frame[], pageCount: number): SectionCount[] {
  return entries.map((entry, index) => {
    let end = pageCount - 1;
    for (let next = index + 1; next < entries.length; next += 1) {
      const candidate = entries[next] as OutlineEntry;
      if (candidate.depth <= entry.depth) {
        end = candidate.page > entry.page ? candidate.page - 1 : entry.page;
        break;
      }
    }
    const inside = frames.filter((frame) => frame.page >= entry.page && frame.page <= end);
    return { from: entry.page, to: end, counts: countFrames(inside) };
  });
}

/** What is different between two versions of a project, in a few words, for the quiet "updated by an agent" note. */
export interface ChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
  outline: boolean;
  meta: boolean;
}

export function summarizeChange(before: Project, after: Project): ChangeSummary {
  const old = new Map(before.frames.map((frame) => [frame.id, JSON.stringify(frame)]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const frame of after.frames) {
    const was = old.get(frame.id);
    if (was === undefined) added.push(frame.id);
    else if (was !== JSON.stringify(frame)) changed.push(frame.id);
  }
  const now = new Set(after.frames.map((frame) => frame.id));
  const removed = before.frames.filter((frame) => !now.has(frame.id)).map((frame) => frame.id);
  return {
    added,
    removed,
    changed,
    outline: JSON.stringify(before.outline ?? null) !== JSON.stringify(after.outline ?? null),
    meta: JSON.stringify(before.meta) !== JSON.stringify(after.meta),
  };
}

export function describeChange(summary: ChangeSummary): string {
  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`${summary.added.length} added`);
  if (summary.changed.length > 0) parts.push(`${summary.changed.length} changed`);
  if (summary.removed.length > 0) parts.push(`${summary.removed.length} removed`);
  if (summary.outline) parts.push('contents changed');
  if (summary.meta) parts.push('title or folder changed');
  return parts.length > 0 ? parts.join(', ') : 'no visible change';
}
