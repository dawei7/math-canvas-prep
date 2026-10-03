import { numberFrames, type Frame, type Issue, type Project, type Rect } from '@mcprep/core';

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

/** One line per issue: `error [unit-gap] f3: message` and, indented, the fix. */
export function issueLines(issues: readonly Issue[], indent = ''): string[] {
  return issues.flatMap((item) => {
    const where = item.frameId ? ` ${item.frameId}:` : '';
    const lines = [`${indent}${item.severity} [${item.code}]${where} ${item.message}`];
    if (item.fix) lines.push(`${indent}  fix: ${item.fix}`);
    return lines;
  });
}

export interface FrameSummary {
  id: string;
  /** The positional label (`E2.1`, `Q1`, `B3`), computed, never stored. */
  label: string;
  kind: Frame['kind'];
  page: number;
  rect: Rect;
  unit?: string;
  part?: number;
  partCount?: number;
  continues?: number;
  context?: number;
}

export function summarizeFrames(project: Project, ids?: readonly string[]): FrameSummary[] {
  const numbers = numberFrames(project.frames);
  const wanted = ids ? new Set(ids) : undefined;
  return project.frames
    .filter((frame) => (wanted ? wanted.has(frame.id) : true))
    .map((frame): FrameSummary => {
      const info = numbers.get(frame.id);
      const summary: FrameSummary = { id: frame.id, label: info?.label ?? frame.id, kind: frame.kind, page: frame.page, rect: frame.rect };
      if (frame.unit !== undefined) summary.unit = frame.unit;
      if (info?.part !== undefined) summary.part = info.part;
      if (info?.partCount !== undefined) summary.partCount = info.partCount;
      if (frame.continues && frame.continues.length > 0) summary.continues = frame.continues.length;
      if (frame.context && frame.context.length > 0) summary.context = frame.context.length;
      return summary;
    })
    .sort((a, b) => a.page - b.page || a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.id.localeCompare(b.id));
}

export function frameRows(summaries: readonly FrameSummary[]): string[][] {
  return summaries.map((entry) => {
    const notes: string[] = [];
    if (entry.unit !== undefined) notes.push(`unit ${entry.unit}`);
    if (entry.continues) notes.push(`continues ${entry.continues}`);
    if (entry.context) notes.push(`context ${entry.context}`);
    return [entry.id, entry.label, entry.kind, String(entry.page), rectText(entry.rect), notes.join(', ')];
  });
}

export const FRAME_HEADERS = ['id', 'label', 'kind', 'page', 'rect (left,top,right,bottom)', 'notes'];
