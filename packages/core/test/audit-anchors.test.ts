import { describe, expect, it } from 'vitest';
import { proposeExercises } from '../src/audit/exercises.js';
import { DEFAULT_BOOK_PATTERNS, scanHeadings } from '../src/audit/scan.js';
import { deriveSections } from '../src/audit/sections.js';
import { STOP_HEADING, page, type Spec } from './audit-pages.js';

/**
 * The headings that anchor a practice set, in the three forms the tool tries in a fixed order ("3.2 Practice - Title", "3.2.4
 * Exercises", the word or phrase alone on its line), the headings that end it, and the words that are options. Pages are built
 * by hand and every text is made up.
 */

const heading = (text: string, top: number, size = 14, left = 0.12): Spec => ({ text, left, top, size, bold: true });
const body = (n: number, top: number): Spec[] => Array.from({ length: n }, (_, k) => ({ text: `a line of the lesson text number ${k}, long enough to be body text`, left: 0.12, top: top + k * 0.02 }));
const items = (top: number, count = 3): Spec[] => Array.from({ length: count }, (_, k) => ({ text: `${k + 1}. Compute ${k + 1} + ${k + 2}.`, left: 0.12, top: top + k * 0.03 }));

describe('the headings that name a practice set', () => {
  const pages = [
    page(0, [heading('Chapter 3 Slopes', 0.1, 24), heading('3.1 Lines', 0.2, 17), ...body(8, 0.26), heading('3.1.4 Exercises', 0.5), ...items(0.55), heading('3.1.5 Answers', 0.7), { text: '1. b', left: 0.12, top: 0.75 }]),
    page(1, [heading('3.2 Practice - Slopes', 0.1, 17), ...items(0.16), heading(STOP_HEADING, 0.4), { text: '1. a', left: 0.12, top: 0.45 }, heading('3.2.5 Selected Answers', 0.6)]),
    page(2, [heading('3.3 Triangles', 0.1, 17), ...body(6, 0.16), heading('Exercises', 0.45, 14, 0.43), ...items(0.5), heading('Review Questions', 0.7, 14, 0.4), ...items(0.75)]),
    page(3, [heading('Review', 0.1, 14, 0.45), heading('3.4 Review', 0.3, 17), heading('Answers - Chapter 3', 0.5, 17)]),
  ];
  const scan = scanHeadings(pages, DEFAULT_BOOK_PATTERNS);
  const summary = (hits: typeof scan.practices): string[] => hits.map((hit) => `${hit.page}:${hit.text}|${hit.number}|${hit.form}|${hit.sub ?? ''}`);

  it('reads a labelled heading, a numbered part of a section, and a word or phrase alone on its line, each as its own kind', () => {
    expect(summary(scan.practices)).toEqual(['0:3.1.4 Exercises|3.1|subsection|4', '1:3.2 Practice - Slopes|3.2|labelled|']);
    expect(summary(scan.unlabeledPractices)).toEqual(['2:Exercises||alone|', '2:Review Questions||alone|', '3:Review||alone|']);
  });

  it('ranks a phrase above the weak word it contains, and a word of the list above one that comes later', () => {
    const [exercises, questions, review] = scan.unlabeledPractices;
    expect(exercises?.rank).toBeLessThan(questions?.rank ?? 0);
    expect(questions?.rank).toBeLessThan(review?.rank ?? 0);
  });

  it('does not take "3.4 Review", a section with a weak word in its title, for a practice heading', () => {
    expect(scan.practices.some((hit) => hit.text.includes('3.4 Review'))).toBe(false);
    expect(scan.lessons.map((hit) => hit.number)).toContain('3.4');
  });

  it('reads the headings that end a set: the phrase of the stop words, the answers of a section (also the selected ones), the answer key', () => {
    expect(summary(scan.stops).map((line) => line.split('|')[0])).toEqual(['0:3.1.5 Answers', `1:${STOP_HEADING}`, '1:3.2.5 Selected Answers']);
    expect(scan.answerSections.map((hit) => [hit.number, hit.sub, hit.selected === true])).toEqual([['3.1', '5', false], ['3.2', '5', true]]);
    expect(scan.answerChapters.map((hit) => hit.text)).toEqual(['Answers - Chapter 3']);
  });

  it('takes the words from the options: other words find other headings, and the stop words are the option too', () => {
    const german = scanHeadings(pages, { ...DEFAULT_BOOK_PATTERNS, practiceWords: ['aufgaben'], stopWords: [] });
    expect(german.practices).toEqual([]);
    expect(german.unlabeledPractices).toEqual([]);
    expect(german.stops.map((hit) => hit.text)).not.toContain(STOP_HEADING);
    const phrase = scanHeadings(pages, { ...DEFAULT_BOOK_PATTERNS, stopWords: [...DEFAULT_BOOK_PATTERNS.stopWords, 'review questions'] });
    expect(phrase.stops.map((hit) => hit.text)).toContain('Review Questions');
  });
});

describe('the practice sets of a section, found in the order labelled, numbered part, alone', () => {
  const pages = [
    page(0, [heading('Chapter 3 Slopes', 0.1, 24), heading('3.1 Lines', 0.2, 17), ...body(8, 0.26), heading('3.1.4 Exercises', 0.5), ...items(0.55)]),
    page(1, [heading('3.2 Practice - Slopes', 0.1, 17), ...items(0.16), heading(STOP_HEADING, 0.4), { text: '1. an answer', left: 0.12, top: 0.45 }]),
    page(2, [heading('3.3 Triangles', 0.1, 17), ...body(6, 0.16), heading('Exercises', 0.45, 14, 0.43), ...items(0.5)]),
  ];
  const structure = deriveSections(pages);
  const sections = structure.entries.filter((entry) => entry.kind === 'section');

  it('says for each section which kind of heading its set was found from, and counts the kinds once for the book', () => {
    expect(sections.map((entry) => [entry.id, entry.practice?.form])).toEqual([['3.1', 'subsection'], ['3.2', 'labelled'], ['3.3', 'alone']]);
    expect(structure.practiceAnchors).toEqual({ labelled: 1, subsection: 1, alone: 1 });
    expect(structure.notes.join(' ')).toContain('practice sets found from: 1 labelled headings ("3.2 Practice - Title"), 1 numbered parts of a section ("3.2.4 Exercises"), 1 headings alone on their line ("Exercises"); the kinds are tried in this order for every section');
  });

  it('ends a set at the stop heading, so that the answers printed under it are not exercises', () => {
    const second = sections[1];
    expect(second?.practice?.end.page).toBe(1);
    expect(second?.practice?.end.top).toBeCloseTo(0.3995, 3);
    const exercises = proposeExercises(pages, structure.entries);
    expect(exercises.sections.map((section) => section.proposals.map((proposal) => proposal.label))).toEqual([['1', '2', '3'], ['1', '2', '3'], ['1', '2', '3']]);
  });

  it('uses the stronger kind when a section has two: the numbered part wins over the word alone', () => {
    const both = [
      page(0, [heading('Chapter 1 Sets', 0.1, 24), heading('1.1 Unions', 0.2, 17), ...body(5, 0.26), heading('Exercises', 0.45, 14, 0.43), ...items(0.5, 2), heading('1.1.7 Exercises', 0.7), ...items(0.75, 2)]),
    ];
    const entry = deriveSections(both).entries.find((candidate) => candidate.kind === 'section');
    expect(entry?.practice?.form).toBe('subsection');
    expect(entry?.practice?.text).toBe('1.1.7 Exercises');
  });
});
