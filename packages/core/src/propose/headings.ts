import type { OutlineEntry, PageText, TextLine } from '../model/types.js';
import { LIMITS } from '../rules/constants.js';
import { cleanTitle, normalizeOutline } from '../rules/outline.js';
import { bodyFontSize } from './exercises.js';

/**
 * Headings for a table of contents when the PDF has no outline: font size, bold, position and numbering decide, and the
 * depth comes from the numbering ("1", "1.1", "1.1.2") or, without numbers, from the rank of the font size. Every entry
 * carries its evidence. The result is a starting point to check and edit; it fits `outline.json` once accepted.
 */

export interface HeadingEntry extends OutlineEntry {
  confidence: number;
  evidence: string[];
}

export interface OutlineProposal {
  entries: HeadingEntry[];
  bodyFontSize: number;
  notes: string[];
}

export interface DeriveOptions {
  minConfidence?: number;
}

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$/;
const KEYWORD = /^(chapter|section|part|appendix|kapitel|abschnitt|teil|anhang|chapitre|capítulo|capitolo)\s+(\d+|[IVXL]+|[A-Z])\b/iu;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

interface Scored {
  page: number;
  line: TextLine;
  title: string;
  confidence: number;
  evidence: string[];
  numberDepth?: number;
}

export function deriveOutline(pages: readonly PageText[], options: DeriveOptions = {}): OutlineProposal {
  const minConfidence = options.minConfidence ?? 0.55;
  const withText = pages.filter((page) => page.hasText);
  if (withText.length === 0) {
    return { entries: [], bodyFontSize: 0, notes: ['No page has a text layer, so no headings can be found. Write the contents by hand with `outline set`.'] };
  }
  const body = bodyFontSize(withText);
  const sawFonts = withText.some((page) => page.lines.some((line) => line.bold !== undefined));
  const pitches: number[] = [];
  for (const page of withText) {
    for (let i = 1; i < page.lines.length; i += 1) {
      const a = page.lines[i - 1] as TextLine;
      const b = page.lines[i] as TextLine;
      if (a.column === b.column && b.rect.top > a.rect.top) pitches.push(b.rect.top - a.rect.top);
    }
  }
  const pitch = median(pitches);

  const scored: Scored[] = [];
  for (const page of withText) {
    page.lines.forEach((line, index) => {
      if (line.headerFooter === true) return;
      const text = line.text.trim();
      if (text.length < 2 || /^\d+$/.test(text)) return;
      if (/\.{4,}\s*\d+\s*$/.test(text)) return;
      let score = 0;
      const evidence: string[] = [];
      const ratio = body > 0 ? line.fontSize / body : 1;
      if (ratio >= 1.5) {
        score += 0.6;
        evidence.push(`font size ${line.fontSize} is ${ratio.toFixed(1)}x the body text (${body})`);
      } else if (ratio >= 1.2) {
        score += 0.45;
        evidence.push(`font size ${line.fontSize} is ${ratio.toFixed(1)}x the body text (${body})`);
      } else if (ratio >= 1.08) {
        score += 0.25;
        evidence.push(`font size ${line.fontSize} is slightly larger than the body text (${body})`);
      }
      if (line.bold === true) {
        score += 0.2;
        evidence.push('set in bold');
      }
      const numbered = NUMBERED.exec(text);
      let numberDepth: number | undefined;
      if (numbered) {
        const parts = (numbered[1] as string).split('.').length;
        numberDepth = parts - 1;
        score += parts >= 2 ? 0.25 : 0.2;
        evidence.push(`numbered like a heading ("${numbered[1] as string}")`);
      }
      if (KEYWORD.test(text)) {
        score += 0.3;
        evidence.push('starts with a chapter or section word');
      }
      if (score === 0) return;
      if (line.chars <= 80) score += 0.1;
      if (line.chars > 120) score -= 0.5;
      else if (line.chars > 70 && /[.;,]$/.test(text)) score -= 0.25;
      if (/[.!?]$/.test(text) && !numbered && line.chars > 40) score -= 0.2;
      const previous = page.lines[index - 1];
      if (previous && pitch > 0 && previous.column === line.column) {
        const gap = line.rect.top - previous.rect.top;
        if (gap >= 1.5 * pitch) {
          score += 0.1;
          evidence.push('standing apart from the line above');
        }
      }
      if (!sawFonts && numbered && ratio < 1.08) evidence.push('no font information: numbering and spacing only (run with fonts to also use bold)');
      const entry: Scored = { page: page.page, line, title: cleanTitle(text), confidence: score, evidence };
      if (numberDepth !== undefined) entry.numberDepth = numberDepth;
      scored.push(entry);
    });
  }

  // Wrapped headings: consecutive lines of the same size, tightly spaced, are one heading.
  const merged: Scored[] = [];
  for (const entry of scored) {
    const last = merged[merged.length - 1];
    if (last && last.page === entry.page && last.line.fontSize === entry.line.fontSize && entry.line.column === last.line.column) {
      const gap = entry.line.rect.top - last.line.rect.bottom;
      if (gap >= -0.002 && gap <= 0.012 && last.numberDepth === undefined && entry.numberDepth === undefined && ratioOf(entry, body) >= 1.2) {
        last.title = cleanTitle(`${last.title} ${entry.title}`);
        last.evidence.push('continues on the next line');
        continue;
      }
    }
    merged.push(entry);
  }

  const accepted = merged.filter((entry) => entry.confidence >= minConfidence);
  // Depth: numbering where there is one, otherwise the rank of the font size (largest first).
  const sizes = [...new Set(accepted.filter((entry) => entry.numberDepth === undefined).map((entry) => entry.line.fontSize))].sort((a, b) => b - a);
  const entries: HeadingEntry[] = accepted.map((entry) => {
    const depth = entry.numberDepth !== undefined ? entry.numberDepth : Math.max(0, sizes.indexOf(entry.line.fontSize));
    return {
      title: entry.title.slice(0, LIMITS.outlineTitleMax),
      page: entry.page,
      depth: Math.min(depth, LIMITS.outlineDepthMax),
      confidence: Math.min(0.99, Math.round(entry.confidence * 100) / 100),
      evidence: entry.evidence,
    };
  });
  // Make the depths fit the format (a child is at most one deeper than the entry before).
  const fitted = normalizeOutline(entries, Math.max(...pages.map((page) => page.page)) + 1);
  const result = entries.slice(0, fitted.length).map((entry, index) => ({ ...entry, depth: (fitted[index] as OutlineEntry).depth }));
  const notes: string[] = [];
  if (result.length === 0) notes.push('No line looks like a heading. Write the contents by hand with `outline set`.');
  return { entries: result, bodyFontSize: body, notes };
}

function ratioOf(entry: Scored, body: number): number {
  return body > 0 ? entry.line.fontSize / body : 1;
}
