import type { Frame, OutlineEntry, Region } from '../model/types.js';
import { buildPdf, type PdfText } from './pdf-writer.js';

/**
 * A three-page synthetic practice set with one exercise that spans pages: exercise 3 starts at the bottom of page 0, fills page
 * 1 completely (no number on it) and ends at the top of page 2. Everything is invented. `frames` and `outline` are what a
 * careful audit would store: the span is the main region and two continuations, one instruction (`context`) is shared by the
 * five exercises. Tests damage them (delete or swap a continuation, shrink one) to see what the checks say.
 */

export interface SpanBook {
  pdf: Uint8Array;
  pageCount: number;
  frames: Frame[];
  outline: OutlineEntry[];
}

const W = 595;
const H = 842;
const LEFT = 85;
const INDENT = 19.5;
const PITCH = 14.7;
const round = (value: number): number => Math.round(value * 10000) / 10000;

/** A region around `lines` printed lines, the first at baseline `y` and `x` its left edge. */
function around(page: number, x: number, y: number, lines: number, width: number): Region {
  return { page, rect: { left: round((x - 4) / W), top: round((y - 11) / H), right: round((x + width) / W), bottom: round((y + (lines - 1) * PITCH + 5) / H) } };
}

export function buildSpanBook(): SpanBook {
  const footer = (n: number): PdfText => ({ text: String(n), x: 292, y: 815, size: 10 });
  const page0: PdfText[] = [
    { text: '0.1 Practice - Long exercises', x: LEFT, y: 96, size: 16, font: 'Helvetica-Bold' },
    { text: 'Solve each problem.', x: LEFT, y: 140, size: 12, font: 'Helvetica-Bold' },
    { text: '1. Compute 2 + 3.', x: LEFT, y: 180 },
    { text: '2. Compute 4 + 5.', x: LEFT, y: 215 },
    { text: '3. A long problem with a table and a proof; read all of it before you start.', x: LEFT, y: 690 },
  ];
  for (let k = 1; k <= 6; k += 1) page0.push({ text: `first page of problem three, line ${k} of the statement and its setting`, x: LEFT + INDENT, y: 690 + k * PITCH });
  page0.push(footer(1));
  const page1: PdfText[] = [];
  for (let k = 1; k <= 46; k += 1) page1.push({ text: `middle page of problem three, line ${k} of the table and the data`, x: LEFT + INDENT, y: 72 + (k - 1) * PITCH });
  page1.push(footer(2));
  const page2: PdfText[] = [];
  for (let k = 1; k <= 5; k += 1) page2.push({ text: `last page of problem three, line ${k} of the final questions`, x: LEFT + INDENT, y: 72 + (k - 1) * PITCH });
  page2.push({ text: '4. Compute 6 + 7.', x: LEFT, y: 200 }, { text: '5. Compute 8 + 9.', x: LEFT, y: 235 }, footer(3));
  const pdf = buildPdf({ title: 'Span test', pages: [{ texts: page0 }, { texts: page1 }, { texts: page2 }] });

  const instruction: Region = around(0, LEFT, 140, 1, 150);
  const exercise = (id: string, label: string, region: Region, extra: Partial<Frame> = {}): Frame => ({ id, kind: 'exercise', page: region.page, rect: region.rect, authority: 'book', label, section: '0.1', context: [instruction], ...extra });
  const frames: Frame[] = [
    exercise('e1', '1', around(0, LEFT, 180, 1, 150)),
    exercise('e2', '2', around(0, LEFT, 215, 1, 150)),
    exercise('e3', '3', around(0, LEFT, 690, 7, 430), { continues: [around(1, LEFT + INDENT, 72, 46, 430), around(2, LEFT + INDENT, 72, 5, 430)] }),
    exercise('e4', '4', around(2, LEFT, 200, 1, 150)),
    exercise('e5', '5', around(2, LEFT, 235, 1, 150)),
  ];
  const outline: OutlineEntry[] = [{ title: 'Long exercises', page: 0, depth: 0, id: '0.1', label: '0.1', top: round(79 / H) }];
  return { pdf, pageCount: 3, frames, outline };
}
