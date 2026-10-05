import type { PageText, TextLine } from '../model/types.js';
import { bodyFontSize } from '../propose/exercises.js';
import { DEFAULT_CHAPTER_WORDS } from './toc.js';

/**
 * The headings of a book that name its structure, found on the pages themselves: a chapter opener ("Chapter 3 :
 * Title", or a number and a title in large type), the start of a lesson (a small label line such as "3.2" above a
 * large heading, or a large heading that starts with the label), the heading of a practice set ("3.2 Practice - Title",
 * "3.2.4 Exercises", or the one word "Exercises" alone on a line), the headings that end a practice set or hold the
 * answers of a section ("3.2.5 Answers", "Warm-up Answers") and the headings of the answer key ("Answers - Chapter
 * 3"). Only the printed words, sizes and positions are used. The words are options.
 */

export interface BookPatterns {
  /** Words that open a chapter heading ("Chapter 3"). */
  chapterWords: string[];
  /**
   * Words and phrases that name a set of practice problems ("Practice", "Exercises", "Review Questions"). Several words are
   * a phrase. A word earlier in the list wins over a later one when a section has more than one such heading.
   */
  practiceWords: string[];
  /** Words that open the answer key ("Answers", "Solutions"). */
  answerWords: string[];
  /**
   * Phrases that end the exercises of a section when a heading says them alone on its line ("Warm-up Answers"). The
   * answer words end them too ("Answers", "Selected Answers"), and so does the next section.
   */
  stopWords: string[];
  /**
   * Regular expressions (case-insensitive, one group: the section label) for the lines of an answer key that mark where the
   * answers of a section start ("Section 1.1 (p. 5)"). A line that holds the label alone ("2.3") and a large heading that
   * starts with a section label are markers without being listed.
   */
  answerMarkers: string[];
  /**
   * The words that name one exercise printed inside the text ("1.2.3 Aufgabe: ...", "2.1 Exercise. ..."): a line that starts with a
   * number of two or three levels, one of these words and a colon or a full stop is the start of an exercise of its own.
   */
  itemWords: string[];
  /**
   * The words of the link that leads back from an answer to its place ("zurück", "back"), alone on a line at the right margin:
   * the end of an answer that starts with a line like "Lösung 1.2.3". The links that lead to the answer ("Lösung") are made
   * from the answer words.
   */
  backWords: string[];
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
    'review questions',
    'review',
  ],
  answerWords: ['answers', 'answer key', 'answer set', 'solutions', 'lösungen', 'loesungen', 'antworten', 'réponses', 'reponses', 'respuestas', 'soluzioni', 'oplossingen'],
  stopWords: ['review queue answers'],
  answerMarkers: ['^Section\\s+(\\d{1,2}\\.\\d{1,2})\\b'],
  itemWords: ['aufgabe', 'übung', 'uebung', 'exercise', 'problem', 'task', 'question', 'exercice', 'ejercicio', 'esercizio', 'oefening'],
  backWords: ['zurück', 'zurueck', 'back', 'return', 'retour', 'volver', 'indietro', 'terug'],
};

/** Practice words that count only when a heading is nothing but the word ("Review" is a heading of exercises, "3.1 Review" is a section). */
const WEAK_PRACTICE_WORDS = new Set(['review']);

/** How a practice heading was recognised, in the order the tool tries them. */
export type PracticeForm = 'labelled' | 'subsection' | 'alone';

export type HeadingKind = 'chapter' | 'lesson' | 'practice' | 'answers-chapter' | 'answers' | 'stop' | 'answer-title';

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
  /** The number after the section's, in a heading like "3.2.4 Exercises" ("4"). */
  sub?: string;
  /** For a practice heading: how it was recognised. */
  form?: PracticeForm;
  /** For a practice heading: the position of its word in `practiceWords` (smaller is stronger). */
  rank?: number;
  /** For an answers heading: it says that only some answers are printed ("Selected Answers"). */
  selected?: boolean;
  /** For a chapter opener made of a number and a title ("3 Shapes"): to be confirmed by another source. */
  weak?: boolean;
}

export interface HeadingScan {
  body: number;
  chapters: HeadingHit[];
  lessons: HeadingHit[];
  practices: HeadingHit[];
  /** Headings of practice sets that do not carry a label ("Practice - Title", "Exercises"): `number` and `label` are empty. */
  unlabeledPractices: HeadingHit[];
  /** "Answers - Chapter 3" and similar headings of the answer key. */
  answerChapters: HeadingHit[];
  /** Headings of the answers of one section: "3.2.5 Answers", "3.2.5 Selected Answers" (the section is `number`). */
  answerSections: HeadingHit[];
  /** Headings alone on a line that end the exercises of a section ("Warm-up Answers", "Answers", "3.2.5 Answers"). */
  stops: HeadingHit[];
  /** Large lines that end in an answer phrase and name no section ("... Answer Key"): the title of an answer key. */
  answerTitles: HeadingHit[];
}

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A word or a phrase as a regular expression source (the spaces of a phrase match any white space). */
const phraseSource = (word: string): string => word.trim().split(/\s+/).map(escapeWord).join('\\s+');

/** A test for text that starts with one of the words or phrases (case ignored, the spaces of a phrase match any white space); never true when there are none. */
export function startsWithWord(words: readonly string[]): (text: string) => boolean {
  const list = words.map((word) => word.trim()).filter((word) => word !== '');
  if (list.length === 0) return () => false;
  const regex = new RegExp(`^(?:${list.map(phraseSource).join('|')})\\b`, 'iu');
  return (text) => regex.test(text.trim());
}

/** Lines that end above this height of the page (half an inch of a letter page) are the margin: running heads, never text of an exercise or an answer. */
export const TOP_MARGIN = 0.045;

/**
 * A running header or footer, a page number, or a line in the top margin: never part of an exercise or an answer. A line in the
 * margin that `keep` names (the marker of a section in an answer key, the first item of a page) is not furniture: a page may
 * start at its very top. `lines` are the lines of the page, for the page number at its top (see `isPageNumber`).
 */
export function isFurnitureLine(line: TextLine, keep?: (text: string) => boolean, lines?: readonly TextLine[]): boolean {
  return isRunningLine(line) || (lines !== undefined && isPageNumber(line, lines)) || (line.rect.bottom <= TOP_MARGIN && keep?.(line.text) !== true);
}

/** A running header or footer, or a page number: lines that are never part of the structure. */
export function isRunningLine(line: TextLine): boolean {
  if (line.headerFooter !== true) return false;
  return line.rect.top > 0.85 || line.chars >= 4;
}

/**
 * A bare number that the reader took for a running line and that stands alone on its row (no other line within a tenth of the
 * page width of it) is the page number, also at the top of the page. A digit set small beside a symbol (the index of a root, an
 * exponent) that the reader took for one is part of its line, and so is the repeated "1." that starts the answers of a key.
 */
export function isPageNumber(line: TextLine, lines: readonly TextLine[]): boolean {
  if (line.headerFooter !== true || !/^\s*\d{1,4}\s*$/.test(line.text)) return false;
  return !lines.some((other) => {
    if (other === line) return false;
    const shared = Math.min(line.rect.bottom, other.rect.bottom) - Math.max(line.rect.top, other.rect.top);
    if (shared <= 0.3 * (line.rect.bottom - line.rect.top)) return false;
    return Math.max(other.rect.left - line.rect.right, line.rect.left - other.rect.right) < 0.1;
  });
}

/** The dots between a title and its page number in a table of contents. */
const LEADERS = /(?:\.{3,}|(?:\.\s+){3,}\.?)/;

/**
 * Whether the text holds a long run of leader dots (five or more, not the three of an ellipsis in a formula): a line of a printed
 * contents (a title, the dots, a page number) is no heading and no item.
 */
export const hasLeader = (text: string): boolean => /(?:\.{5,}|(?:\.\s+){4,}\.?)/.test(text);

interface Phrase {
  word: string;
  rank: number;
  regex: RegExp;
}

const phrases = (words: readonly string[]): Phrase[] => words.map((word, rank) => ({ word, rank, regex: new RegExp(`^${phraseSource(word)}\\b`, 'iu') }));

/** The longest phrase that starts `text`, and what follows it. */
function leadingPhrase(text: string, list: readonly Phrase[]): { phrase: Phrase; rest: string } | undefined {
  let best: { phrase: Phrase; rest: string; length: number } | undefined;
  for (const phrase of list) {
    const found = phrase.regex.exec(text);
    if (found && (best === undefined || found[0].length > best.length)) best = { phrase, rest: text.slice(found[0].length), length: found[0].length };
  }
  return best;
}

/** What may follow a heading word on its line without making it a sentence: nothing, "(continued)", a page number. */
const NOTHING_MORE = /^\s*(?:\(\s*continued\s*\)\s*)?(?:\d{1,4}\s*)?$/iu;

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

/**
 * The title that stands under (or beside) a chapter heading that holds only the chapter's number ("Chapter 0" above
 * "Prerequisites"): the next large line that is close below and is no heading of its own.
 */
function titleBelow(lines: readonly TextLine[], index: number, body: number): string {
  const label = lines[index] as TextLine;
  const parts: string[] = [];
  for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
    const line = lines[next] as TextLine;
    if (line.headerFooter === true) continue;
    if (line.rect.bottom < label.rect.bottom - 0.002 || line.rect.top - label.rect.bottom > 0.12) break;
    if (line.fontSize < body * 1.25 || line.chars > 80) break;
    if (/^(?:\d{1,2}\.\d{1,2}|chapter\b)/i.test(line.text.trim())) break;
    // A second line of the title is set in the same size as the first, directly under it.
    if (parts.length > 0 && Math.abs(line.fontSize - (lines[next - 1] as TextLine).fontSize) > 0.5) break;
    parts.push(line.text.trim());
  }
  return parts.join(' ');
}

/** Whether a line looks like the heading of something: set in bold, or larger than the body text. */
const headingLike = (line: TextLine, body: number): boolean => line.bold === true || line.fontSize >= body * 1.07;

export function scanHeadings(pages: readonly PageText[], patterns: Partial<BookPatterns> = {}): HeadingScan {
  const words: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...patterns };
  const withText = pages.filter((page) => page.hasText);
  const body = bodyFontSize(withText);
  const chapterHead = new RegExp(`^(${words.chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b\\s*[:.\\-–—]?\\s*(.*)$`, 'iu');
  const practiceList = words.practiceWords.map((word, rank) => ({ word, rank }));
  const titledWords = practiceList.filter((entry) => !WEAK_PRACTICE_WORDS.has(entry.word.toLowerCase()));
  const titledSource = titledWords.map((entry) => phraseSource(entry.word)).join('|');
  const practiceHead = new RegExp(`^(\\d{1,2}\\.\\d{1,2})\\s+(?:${titledSource})\\b\\s*[:.\\-–—]*\\s*(.*)$`, 'iu');
  const subsectionHead = new RegExp(`^(\\d{1,2}\\.\\d{1,2})\\.(\\d{1,3})\\.?\\s+(${practiceList.map((entry) => phraseSource(entry.word)).join('|')})\\b(.*)$`, 'iu');
  const unlabeledPractice = new RegExp(`^(?:${titledSource})\\b\\s*[:.\\-–—]*\\s*(.*)$`, 'iu');
  const practiceStarts = phrases(practiceList.map((entry) => entry.word));
  const answerSource = words.answerWords.map(phraseSource).join('|');
  const answersChapter = new RegExp(`^(?:${words.answerWords.map(escapeWord).join('|')})\\b\\s*[:.\\-–—]*\\s*(?:${words.chapterWords.map(escapeWord).join('|')})\\s+(\\d+|[IVXLC]+)\\b`, 'iu');
  const SELECTED = '(?:(selected|odd[- ]numbered|even[- ]numbered|partial|brief|short)\\s+)?';
  const answerSection = new RegExp(`^(\\d{1,2}\\.\\d{1,2})\\.(\\d{1,3})\\.?\\s+${SELECTED}(?:${answerSource})\\b(.*)$`, 'iu');
  const stopPhrases = [...words.stopWords, ...words.answerWords];
  const stopAlone = new RegExp(`^(?:\\d{1,2}\\.\\d{1,2}(?:\\.\\d{1,3})?\\.?\\s+)?${SELECTED}(?:${stopPhrases.map(phraseSource).join('|')})\\s*(?:\\d{1,4}\\s*)?$`, 'iu');
  const answerTitle = new RegExp(`(?:^|[,:\\-–—]\\s*|\\s)${SELECTED}(?:${answerSource})\\s*$`, 'iu');
  const numberTitle = /^(\d{1,2})\s+(\p{Lu}[^.:;!?]{1,70})$/u;
  const result: HeadingScan = { body, chapters: [], lessons: [], practices: [], unlabeledPractices: [], answerChapters: [], answerSections: [], stops: [], answerTitles: [] };
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
        const inline = (match[3] as string).trim();
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
          title: inline.length > 0 ? inline : titleBelow(page.lines, index, body),
          evidence: [`"${text}" is set at ${line.fontSize} pt, body text ${body} pt`],
        });
        return;
      }
      if (larger && line.rect.top < 0.45 && line.chars <= 80 && !LEADERS.test(text)) {
        const numbered = numberTitle.exec(text);
        if (numbered) {
          result.chapters.push({
            kind: 'chapter',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text,
            fontSize: line.fontSize,
            number: numbered[1] as string,
            label: `Chapter ${numbered[1] as string}`,
            title: (numbered[2] as string).trim(),
            evidence: [`"${text}" is a number and a title set at ${line.fontSize} pt, body text ${body} pt`],
            weak: true,
          });
        }
      }
      const leaders = LEADERS.test(text);
      // The heading of the answers of one section ("0.1.4 Answers", "9.3.2 Selected Answers"): the number after the section's.
      if (!leaders && headingLike(line, body) && line.chars <= 60) {
        const sectionAnswers = answerSection.exec(text);
        if (sectionAnswers && NOTHING_MORE.test(sectionAnswers[4] as string)) {
          const hit: HeadingHit = {
            kind: 'answers',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text,
            fontSize: line.fontSize,
            number: sectionAnswers[1] as string,
            label: sectionAnswers[1] as string,
            title: '',
            sub: sectionAnswers[2] as string,
            ...(sectionAnswers[3] !== undefined ? { selected: true } : {}),
            evidence: [`the heading "${text}" opens the ${sectionAnswers[3] !== undefined ? 'selected ' : ''}answers of ${sectionAnswers[1] as string}`],
          };
          result.answerSections.push(hit);
          result.stops.push({ ...hit, kind: 'stop' });
          return;
        }
        const stop = stopAlone.exec(text);
        if (stop) {
          result.stops.push({
            kind: 'stop',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text,
            fontSize: line.fontSize,
            number: '',
            label: '',
            title: '',
            evidence: [`the heading "${text}" ends the exercises above it`],
          });
          return;
        }
      }
      // The practice heading with a three-level number: "3.2.4 Exercises" belongs to section 3.2.
      if (!leaders && headingLike(line, body) && line.chars <= 80) {
        const sub = subsectionHead.exec(text);
        if (sub && /^\s*(?:[:.\-–—]\s*\S.{0,60})?$/u.test(sub[4] as string)) {
          const lead = leadingPhrase(sub[3] as string, practiceStarts);
          result.practices.push({
            kind: 'practice',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text,
            fontSize: line.fontSize,
            number: sub[1] as string,
            label: sub[1] as string,
            title: (sub[4] as string).replace(/^\s*[:.\-–—]\s*/, '').trim(),
            sub: sub[2] as string,
            form: 'subsection',
            rank: lead?.phrase.rank ?? 0,
            evidence: [`the heading "${text}" opens the practice set of ${sub[1] as string} (its subsection ${sub[2] as string})`],
          });
          return;
        }
      }
      match = practiceHead.exec(text);
      if (match && big && line.chars <= 110) {
        const lead = leadingPhrase(text.slice((match[1] as string).length).trim(), practiceStarts);
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
          form: 'labelled',
          rank: lead?.phrase.rank ?? 0,
          evidence: [`the heading "${text}" opens the practice set of ${match[1] as string}`],
        });
        return;
      }
      match = unlabeledPractice.exec(text);
      if (match && larger && line.chars <= 70 && line.rect.top < 0.6) {
        const lead = leadingPhrase(text, practiceStarts);
        result.unlabeledPractices.push({
          kind: 'practice',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: '',
          label: '',
          title: (match[1] as string).trim(),
          form: 'alone',
          rank: lead?.phrase.rank ?? 0,
          evidence: [`the heading "${text}" is set at ${line.fontSize} pt and names a practice set`],
        });
        return;
      }
      // A heading that is nothing but the word ("Exercises", "Review Questions"), centred or not, in any size that sets it apart.
      if (!leaders && headingLike(line, body) && line.chars <= 40) {
        const lead = leadingPhrase(text, practiceStarts);
        if (lead && NOTHING_MORE.test(lead.rest)) {
          result.unlabeledPractices.push({
            kind: 'practice',
            page: page.page,
            index,
            top: line.rect.top,
            left: line.rect.left,
            text,
            fontSize: line.fontSize,
            number: '',
            label: '',
            title: '',
            form: 'alone',
            rank: lead.phrase.rank,
            evidence: [`the heading "${text}" stands alone on its line (${line.bold === true ? 'bold, ' : ''}${line.fontSize} pt, body text ${body} pt) and names a practice set`],
          });
          return;
        }
      }
      // The title of an answer key: a large line that ends in "Answer Key" and names no section.
      if (larger && line.chars <= 100 && !leaders && !/^\d{1,2}\.\d{1,2}\b/.test(text) && answerTitle.test(text)) {
        result.answerTitles.push({
          kind: 'answer-title',
          page: page.page,
          index,
          top: line.rect.top,
          left: line.rect.left,
          text,
          fontSize: line.fontSize,
          number: '',
          label: '',
          title: text,
          evidence: [`the large line "${text}" ends in an answer phrase and names no section`],
        });
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
