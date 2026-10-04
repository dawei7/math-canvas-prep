import type { PageText, TextLine } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import { DEFAULT_CHAPTER_WORDS } from './toc.js';

/**
 * The headings of a book that name its structure, found on the pages themselves: a chapter opener ("Chapter 3 :
 * Title"), the start of a lesson (a small label line such as "3.2" above a large heading, or a large heading that
 * starts with the label), the heading of a practice set ("3.2 Practice - Title") and the headings of the answer key
 * ("Answers - Chapter 3"). Only the printed words, sizes and positions are used. The words are options.
 */

export interface BookPatterns {
  /** Words that open a chapter heading ("Chapter 3"). */
  chapterWords: string[];
  /** Words that name a set of practice problems ("Practice", "Exercises"). */
  practiceWords: string[];
  /** Words that open the answer key ("Answers", "Solutions"). */
  answerWords: string[];
}

export const DEFAULT_BOOK_PATTERNS: BookPatterns = {
  chapterWords: DEFAULT_CHAPTER_WORDS,
  practiceWords: [
    'practice',
    'exercises',
    'exercise',
    'problems',
    'problem set',
    'review exercises',
    'homework',
    'übungen',
    'uebungen',
    'aufgaben',
    'exercices',
    'ejercicios',
    'esercizi',
    'oefeningen',
  ],
  answerWords: ['answers', 'answer key', 'answer set', 'solutions', 'lösungen', 'loesungen', 'antworten', 'réponses', 'reponses', 'respuestas', 'soluzioni', 'oplossingen'],
};

export type HeadingKind = 'chapter' | 'lesson' | 'practice' | 'answers-chapter';

export interface HeadingHit {
  kind: HeadingKind;
  page: number;
  /** Index of the line in `PageText.lines`. */
  index: number;
  top: number;
  left: number;
  /** The text of the heading line. */
  text: string;
  fontSize: number;
  /** "6.4" for a section, "6" for a chapter. */
  number: string;
  /** "6.4" for a section, "Chapter 6" for a chapter. */
  label: string;
  /** The title as printed in the heading (not normalised). */
  title: string;
  evidence: string[];
}

export interface HeadingScan {
  body: number;
  chapters: HeadingHit[];
  lessons: HeadingHit[];
  practices: HeadingHit[];
  /** "Answers - Chapter 3" and similar headings of the answer key. */
  answerChapters: HeadingHit[];
}

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A running header or footer, or a page number: lines that are never part of the structure. */
export function isRunningLine(line: TextLine): boolean {
  if (line.headerFooter !== true) return false;
  return line.rect.top > 0.85 || line.chars >= 4;
}

/**
 * The large line that follows the label line at `index` closely: the next line in reading order that is set larger than
 * the body text and does not end above the label. (A line with a wrong, huge font size has a box that reaches far above
 * its text, so only its bottom is compared.)
 */
function headingBelow(lines: readonly TextLine[], index: number, body: number): { line: TextLine; index: number } | undefined {
  const label = lines[index] as TextLine;
  for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
    const line = lines[next] as TextLine;
    if (line.headerFooter === true) continue;
    if (line.rect.bottom < label.rect.bottom - 0.002) continue;
    if (line.rect.bottom - label.rect.bottom > 0.2 && line.fontSize < body * 3) continue;
    if (line.fontSize >= body * 1.2 && line.chars <= 110) return { line, index: next };
    // Another body line between the label and a heading means the label does not stand above a heading.
    if (line.fontSize < body * 1.2) return undefined;
  }
  return undefined;
}

export function scanHeadings(pages: readonly PageText[], patterns: Partial<BookPatterns> = {}): HeadingScan {
  const words: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...patterns };
  const withText = pages.filter((page) => page.hasText);
  const body = bodyFontSize(withText);
  const chapterHead = new RegExp(`^(${words.chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b\\s*[:.\\-–—]?\\s*(.*)$`, 'iu');
  const practiceHead = new RegExp(`^(\\d{1,2}\\.\\d{1,2})\\s+(?:${words.practiceWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]*\\s*(.*)$`, 'iu');
  const answersChapter = new RegExp(`^(?:${words.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]*\\s*(?:${words.chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b`, 'iu');
  const result: HeadingScan = { body, chapters: [], lessons: [], practices: [], answerChapters: [] };
  if (body <= 0) return result;
  for (const page of withText) {
    page.lines.forEach((line, index) => {
      if (isRunningLine(line)) return;
      const text = line.text.trim();
      if (text.length === 0) return;
      const larger = line.fontSize >= body * 1.25;
      const big = line.fontSize >= body * 1.1 || line.bold === true;
      let match = answersChapter.exec(text);
      if (match && larger) {
        result.answerChapters.push({
          kind: 'answers-chapter',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: match[1] as string,
          label: `Chapter ${match[1] as string}`,
          title: '',
          evidence: [`the heading "${text}" opens the answers of a chapter`],
        });
        return;
      }
      match = chapterHead.exec(text);
      if (match && larger && line.rect.top < 0.5 && line.chars <= 100) {
        const word = (match[1] as string).replace(/^./, (c) => c.toUpperCase());
        result.chapters.push({
          kind: 'chapter',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: match[2] as string,
          label: `${word} ${match[2] as string}`,
          title: (match[3] as string).trim(),
          evidence: [`"${text}" is set at ${line.fontSize} pt, body text ${body} pt`],
        });
        return;
      }
      match = practiceHead.exec(text);
      if (match && big && line.chars <= 110) {
        result.practices.push({
          kind: 'practice',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: match[1] as string,
          label: match[1] as string,
          title: (match[2] as string).trim(),
          evidence: [`the heading "${text}" opens the practice set of ${match[1] as string}`],
        });
        return;
      }
      // A lesson: a label line alone above a large heading, or a large heading that starts with the label.
      const labelOnly = /^(\d{1,2}\.\d{1,2})$/.exec(text);
      if (labelOnly && line.rect.top < 0.3 && line.rect.left < 0.4 && line.fontSize <= body * 1.2) {
        const below = headingBelow(page.lines, index, body);
        if (below) {
          result.lessons.push({
            kind: 'lesson',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text: `${text} ${below.line.text}`,
            fontSize: below.line.fontSize,
            number: labelOnly[1] as string,
            label: labelOnly[1] as string,
            title: below.line.text.trim(),
            evidence: [`the label "${text}" stands alone at the top of the page, above the heading "${below.line.text.slice(0, 60)}"`],
          });
        }
        return;
      }
      const inline = /^(\d{1,2}\.\d{1,2})\s+(\S.*)$/.exec(text);
      if (inline && larger && line.chars <= 100 && !practiceHead.test(text) && !/\.{3,}/.test(text)) {
        result.lessons.push({
          kind: 'lesson',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: inline[1] as string,
          label: inline[1] as string,
          title: (inline[2] as string).trim(),
          evidence: [`the heading "${text.slice(0, 60)}" starts with the label and is set at ${line.fontSize} pt`],
        });
      }
    });
  }
  return result;
}
