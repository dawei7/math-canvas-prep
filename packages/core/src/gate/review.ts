import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Frame, Rect, Region } from '../model/types.js';
import { renderPage, renderRegion } from '../pdf/render.js';
import { findFrame } from '../project/ops.js';
import type { ProjectSession } from '../session.js';
import { foldText } from '../verify/labels.js';
import { judge } from './gate.js';
import { collectFindings, patternsOf, readNotes, type GateRunOptions } from './run.js';
import type { Acknowledgement, GateFinding } from './types.js';

/**
 * What a second reviewer needs to check the acknowledgements quickly: for every one, a picture of what it is about (the exercise's region,
 * or the place on the page, without any grid), a line that says what was acknowledged and why, and an index. The reviewer looks at the
 * picture, reads the reason and the quote, and confirms (`audit confirm`) only what the book really prints.
 */

export interface ReviewEntry {
  number: number;
  code: string;
  ref: string;
  page: number | null;
  by: string;
  confirmed: boolean;
  confirmedBy?: string;
  reason: string;
  quote?: string;
  /** Whether the quote is in the text of the page (false: the note is wrong); null when it has no page. */
  quoteOnPage: boolean | null;
  /** `applies`: it covers findings now; `unused`: its finding is gone; `stale`: the number of findings changed; `refused`: it is not allowed. */
  status: 'applies' | 'unused' | 'stale' | 'refused';
  findings: number;
  finding?: string;
  image: string | null;
  /** One line for people: code, ref, page, reason, quote. */
  line: string;
}

export interface ReviewResult {
  outDir: string;
  indexPath: string;
  jsonPath: string;
  entries: ReviewEntry[];
  unconfirmed: number;
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
const compact = (text: string): string => foldText(text).toLowerCase().replace(/\s+/g, '');

const ANSWER_CODES = new Set(['answer-left-behind', 'answer-clipped', 'no-solution', 'solution-no-text']);

/** The region of a frame on a page: its solution for what is about answers, else its own region, else any other that is on the page. */
function regionOn(frame: Frame, page: number, code: string): Rect | undefined {
  const own: Region = { page: frame.page, rect: frame.rect };
  const order = ANSWER_CODES.has(code) ? [...(frame.solution ?? []), own, ...(frame.continues ?? []), ...(frame.context ?? [])] : [own, ...(frame.continues ?? []), ...(frame.context ?? []), ...(frame.solution ?? [])];
  return order.find((region) => region.page === page)?.rect;
}

export async function reviewAcknowledgements(session: ProjectSession, options: GateRunOptions & { outDir: string }): Promise<ReviewResult> {
  const notes = await readNotes(session);
  const collected = await collectFindings(session, { ...options, itemPatterns: patternsOf(notes, options.itemPatterns), sheets: false, bundle: false, visual: undefined });
  const judged = judge(collected.findings, notes.acknowledgements);
  const covers = new Map<Acknowledgement, GateFinding[]>();
  for (const item of judged.acknowledged) covers.set(item.acknowledgement, [...(covers.get(item.acknowledgement) ?? []), item.finding]);
  const stale = new Set(judged.stale.map((item) => item.acknowledgement));
  const refused = new Set(judged.refused.map((item) => item.acknowledgement));
  const doc = await session.document();
  await mkdir(options.outDir, { recursive: true });

  const entries: ReviewEntry[] = [];
  let number = 0;
  for (const note of notes.acknowledgements) {
    number += 1;
    const found = covers.get(note) ?? [];
    const first = found[0];
    const page = first?.page ?? note.evidence.page ?? null;
    const status: ReviewEntry['status'] = refused.has(note) ? 'refused' : stale.has(note) ? 'stale' : found.length > 0 ? 'applies' : 'unused';
    let text = '';
    let lines: { text: string; rect: Rect }[] = [];
    if (page !== null && page >= 0 && page < doc.pageCount) {
      const pageText = await doc.pageText(page);
      lines = pageText.lines.map((line) => ({ text: line.text, rect: line.rect }));
      text = compact(lines.map((line) => line.text).join(' '));
    }
    const quote = note.evidence.quote;
    const quoteOnPage = page === null || quote === undefined ? null : text.includes(compact(quote));

    // The picture: the line of the finding when its text is on the page, else the region of the exercise, else the page.
    let image: string | null = null;
    if (page !== null && page >= 0 && page < doc.pageCount) {
      const frame = first !== undefined ? findFrame(session.project, first.ref) : findFrame(session.project, note.ref);
      const wanted = first !== undefined ? compact(first.evidence).slice(0, 14) : '';
      const line = wanted.length >= 6 ? lines.find((entry) => compact(entry.text).includes(wanted)) : undefined;
      const exercise = frame !== undefined ? regionOn(frame, page, note.code) : undefined;
      const name = `${String(number).padStart(3, '0')}-${safe(note.code)}-${safe(note.ref)}.png`;
      let png: Uint8Array;
      if (line !== undefined && first !== undefined && !/^(?:duplicate|gap|order|label-outlier|region-size|non-numeric-label|no-solution|reference-)/.test(note.code)) {
        const rect: Rect = { left: 0.04, right: 0.96, top: Math.max(0, line.rect.top - 0.05), bottom: Math.min(1, line.rect.bottom + 0.1) };
        png = (await renderRegion(doc, page, rect, { padding: 0, maxSide: 1100 })).png;
      } else if (exercise !== undefined) {
        png = (await renderRegion(doc, page, exercise, { padding: 0.025, maxSide: 1100 })).png;
      } else png = (await renderPage(doc, page, { maxSide: 1400 })).png;
      await writeFileAtomic(join(options.outDir, name), png);
      image = name;
    }
    const where = page === null ? '' : ` p.${page}`;
    const line = `${String(number).padStart(3, '0')} ${note.code} ${note.ref}${where} | by ${note.by}, ${note.confirmed ? `confirmed by ${note.confirmedBy ?? '?'}` : 'NOT confirmed'} | reason: ${note.reason}${quote !== undefined ? ` | quote: "${quote}"${quoteOnPage === false ? ' (NOT on the page)' : ''}` : ''}${status !== 'applies' ? ` | ${status.toUpperCase()}` : ''}`;
    entries.push({
      number,
      code: note.code,
      ref: note.ref,
      page,
      by: note.by,
      confirmed: note.confirmed,
      ...(note.confirmedBy !== undefined ? { confirmedBy: note.confirmedBy } : {}),
      reason: note.reason,
      ...(quote !== undefined ? { quote } : {}),
      quoteOnPage,
      status,
      findings: found.length,
      ...(first !== undefined ? { finding: first.message } : {}),
      image,
      line,
    });
  }

  const unconfirmed = entries.filter((entry) => entry.status === 'applies' && !entry.confirmed).length;
  const md: string[] = [
    '# Acknowledgements to check',
    '',
    entries.length === 0
      ? 'There are no acknowledgements.'
      : `${entries.length} acknowledgement${entries.length === 1 ? '' : 's'}, ${unconfirmed} that apply and ${unconfirmed === 1 ? 'is' : 'are'} not yet confirmed. An acknowledgement says that the BOOK itself prints what the finding is about. Look at each picture and read the reason and the quote; confirm only what the book really prints, and repair everything else.`,
    '',
    ...entries.map((entry) => `- ${entry.line}${entry.image !== null ? ` | [${entry.image}](${entry.image})` : ''}`),
    '',
  ];
  for (const entry of entries) {
    md.push(`## ${entry.number}. ${entry.code} ${entry.ref}${entry.page !== null ? ` (page ${entry.page})` : ''}`, '');
    md.push(`- written by: ${entry.by}; ${entry.confirmed ? `confirmed by ${entry.confirmedBy ?? '?'}` : 'not confirmed'}; status: ${entry.status}${entry.findings > 0 ? `; covers ${entry.findings} finding${entry.findings === 1 ? '' : 's'}` : ''}`);
    md.push(`- reason: ${entry.reason}`);
    if (entry.quote !== undefined) md.push(`- quote: "${entry.quote}"${entry.quoteOnPage === false ? ' (NOT on the page: the note is wrong)' : ''}`);
    if (entry.finding !== undefined) md.push(`- the finding: ${entry.finding}`);
    md.push('', entry.image !== null ? `![${entry.code} ${entry.ref}](${entry.image})` : '(no picture: the finding has no page)', '');
    if (entry.status === 'applies' && !entry.confirmed) md.push(`Confirm it: \`mcprep audit confirm --by YOUR-NAME --ref ${entry.ref} --code ${entry.code}${entry.page !== null ? ` --page ${entry.page}` : ''}\``, '');
  }
  const indexPath = join(options.outDir, 'index.md');
  const jsonPath = join(options.outDir, 'review.json');
  await writeFileAtomic(indexPath, `${md.join('\n')}\n`);
  await writeFileAtomic(jsonPath, `${JSON.stringify({ unconfirmed, entries }, null, 1)}\n`);
  return { outDir: options.outDir, indexPath, jsonPath, entries, unconfirmed };
}
