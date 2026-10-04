import { bookReference, isAuthoritative, numberFrames, type Frame, type Issue, type Project, type Rect } from '@mcprep/core';

export const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export const rectText = (rect: Rect): string => `${round4(rect.left)},${round4(rect.top)},${round4(rect.right)},${round4(rect.bottom)}`;

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Plain aligned columns, two spaces apart, no borders. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return '';
  const widths = (all[0] as string[]).map((_unused, column) => Math.max(...all.map((row) => (row[column] ?? '').length)));
  return all.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] as number))).join('  ').trimEnd()).join('\n');
}

/** How many rows or lines of a long list a person is shown; the JSON always has everything. */
export const TEXT_LIMIT = 60;

/** Like {@link table}, but only the first `limit` rows, then one line that says how many more there are. */
export function tableLimited(rows: string[][], headers: string[], limit = TEXT_LIMIT): string {
  if (rows.length <= limit) return table(rows, headers);
  return `${table(rows.slice(0, limit), headers)}\n... and ${rows.length - limit} more (use --json to see all)`;
}

/** One line per issue: `error [unit-gap] f3: message` and, indented, the fix. */
export function issueLines(issues: readonly Issue[], indent = '', limit = Number.POSITIVE_INFINITY): string[] {
  const shown = issues.slice(0, limit);
  const lines = shown.flatMap((item) => {
    const where = item.frameId ? ` ${item.frameId}:` : '';
    const out = [`${indent}${item.severity} [${item.code}]${where} ${item.message}`];
    if (item.fix) out.push(`${indent}  fix: ${item.fix}`);
    return out;
  });
  if (issues.length > shown.length) lines.push(`${indent}... and ${issues.length - shown.length} more (use --json to see all)`);
  return lines;
}

export interface FrameSummary {
  id: string;
  /**
   * For a frame you framed yourself the positional label (`E2.1`, `Q1`, `B3`), computed, never stored; for an
   * authoritative exercise the label the book prints (`5a`).
   */
  label: string;
  kind: Frame['kind'];
  /** `book`: an authoritative exercise audited from a book; `user`: everything a person framed for themselves. */
  authority: 'book' | 'user';
  /** `SECTION:LABEL` of an authoritative exercise: how to name it in any command that takes a frame. */
  reference?: string;
  /** The id of the outline entry an authoritative exercise belongs to. */
  section?: string;
  page: number;
  rect: Rect;
  unit?: string;
  part?: number;
  partCount?: number;
  continues?: number;
  context?: number;
  /** Number of solution regions (hidden from the learner). */
  solution?: number;
}

export function summarizeFrame(frame: Frame, labels: ReturnType<typeof numberFrames>): FrameSummary {
  const info = labels.get(frame.id);
  const book = isAuthoritative(frame);
  const summary: FrameSummary = { id: frame.id, label: book ? (frame.label ?? frame.id) : (info?.label ?? frame.id), kind: frame.kind, authority: book ? 'book' : 'user', page: frame.page, rect: frame.rect };
  if (book && frame.section !== undefined) {
    summary.section = frame.section;
    summary.reference = bookReference(frame.section, frame.label ?? frame.id);
  }
  if (frame.unit !== undefined) summary.unit = frame.unit;
  if (info?.part !== undefined) summary.part = info.part;
  if (info?.partCount !== undefined) summary.partCount = info.partCount;
  if (frame.continues && frame.continues.length > 0) summary.continues = frame.continues.length;
  if (frame.context && frame.context.length > 0) summary.context = frame.context.length;
  if (frame.solution && frame.solution.length > 0) summary.solution = frame.solution.length;
  return summary;
}

export const byPosition = (a: { page: number; rect: Rect; id: string }, b: { page: number; rect: Rect; id: string }): number =>
  a.page - b.page || a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.id.localeCompare(b.id);

export function summarizeFrames(project: Project, ids?: readonly string[]): FrameSummary[] {
  const numbers = numberFrames(project.frames);
  const wanted = ids ? new Set(ids) : undefined;
  return project.frames
    .filter((frame) => (wanted ? wanted.has(frame.id) : true))
    .map((frame) => summarizeFrame(frame, numbers))
    .sort(byPosition);
}

export function frameRows(summaries: readonly FrameSummary[]): string[][] {
  return summaries.map((entry) => {
    const notes: string[] = [];
    if (entry.authority === 'book') notes.push('book');
    if (entry.unit !== undefined) notes.push(`unit ${entry.unit}`);
    if (entry.continues) notes.push(`continues ${entry.continues}`);
    if (entry.context) notes.push(`context ${entry.context}`);
    if (entry.solution) notes.push(`solution ${entry.solution}`);
    return [entry.id, entry.reference ?? entry.label, entry.kind, String(entry.page), rectText(entry.rect), notes.join(', ')];
  });
}

export const FRAME_HEADERS = ['id', 'label', 'kind', 'page', 'rect (left,top,right,bottom)', 'notes'];
