import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_BOOK_PATTERNS,
  LIMITS,
  MIN_LABELLED,
  McPrepError,
  bookKey,
  bookKeyOf,
  bookReference,
  cleanProposals,
  compareSolution,
  compareWithProposal,
  deriveSections,
  deriveSectionsFromBookmarks,
  exerciseToOperation,
  findLabelledAnswers,
  findLabelledItems,
  labelledPages,
  locateSections,
  proposeExercises,
  proposeSolutions,
  renderDark,
  solutionToOperation,
  toOutlineEntries,
  type AnswerKey,
  type BookEntry,
  type BookExercises,
  type BookPatterns,
  type BookSolutions,
  type CleanResult,
  type ExerciseProposal,
  type Frame,
  type ItemPattern,
  type Operation,
  type PageText,
  type ProjectSession,
  type Region,
  type SectionExercises,
} from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, table } from '../format.js';
import type { CommandContext, CommandOutput, CommandSpec, OptionSpec } from '../types.js';
import { REPORT_OPTIONS, applyAndReport, reportFlags } from './common.js';

/**
 * The commands that audit a book: `outline derive --book` (chapters and sections from the printed contents and the
 * headings), `exercises propose` (the numbered exercises of the practice sets, with the instruction as context) and
 * `solutions propose` (the answers of the answer key at the back of the same PDF). They propose; nothing is written
 * unless `--apply` is given, and then it goes through the same operations, validation and atomic write as everything else.
 */

/** The words that make a heading of a book recognisable; the defaults are English, German, French, Spanish and Italian. */
export const BOOK_WORD_OPTIONS: OptionSpec[] = [
  { name: 'chapter-words', type: 'string', value: '<chapter,part,...>', description: 'Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults (chapter, part, unit, kapitel, chapitre, capítulo, ...).' },
  { name: 'practice-words', type: 'string', value: '<practice,exercises,...>', description: 'Words and phrases that name a practice set in a heading ("3.2 Practice - Title", "3.2.4 Exercises", or the phrase alone on its line: "Exercises", "Review Questions"), comma separated, replacing the defaults (practice, exercises, problems, review questions, review, übungen, aufgaben, ...). A word earlier in the list wins over a later one when a section has several such headings.' },
  { name: 'answer-words', type: 'string', value: '<answers,solutions,...>', description: 'Words that open the answer key and the header of a section in it ("Answers - Title"), and that name the answers printed right after a section ("3.2.5 Answers"), comma separated, replacing the defaults (answers, answer key, solutions, lösungen, ...).' },
  { name: 'stop-words', type: 'string', value: '<review queue answers,...>', description: 'Phrases that end the exercises of a section when a heading says them alone on its line, comma separated, replacing the default (review queue answers). The answer words, the answers of the section and the next section end them too.' },
  { name: 'item-words', type: 'string', value: '<aufgabe,exercise,...>', description: 'The words that name one exercise printed on its own, comma separated, replacing the defaults (aufgabe, übung, exercise, problem, task, question, ...). A line that starts with a number of two or three levels and one of these words and a colon or a full stop ("1.2.3 Aufgabe: ..."), or with one of these words and the number ("Aufgabe 1.2 (Title). ..."), is an exercise of its own; it ends at a link word at the right margin (an answer word: "Lösung"), above the next such line or heading, or at the last ink of its page.' },
  { name: 'back-words', type: 'string', value: '<zurück,back,...>', description: 'The words of the link that leads back from an answer to its place, alone at the right margin ("zurück", "back"), comma separated, replacing the defaults. An answer that starts with a line like "Lösung 1.2.3" ends at it.' },
  {
    name: 'answer-marker',
    type: 'string',
    multiple: true,
    value: '<regex>',
    description: 'A line of the answer key that marks where the answers of a section start, as a regular expression whose group 1 is the section label (default: "Section 1.1 (p. 5)"). A line that holds the label alone ("2.3") and a large heading that starts with a label are markers anyway. Give the option more than once for several; they replace the default.',
  },
];

export const ITEM_PATTERN_OPTION: OptionSpec = {
  name: 'item-pattern',
  type: 'string',
  multiple: true,
  value: '<regex>',
  description:
    'How the number of an exercise (or of an answer) starts a line, as a regular expression: group 1 is the label as printed (without the closing mark), group 2 the text after it. Replaces the defaults, which read "5)", "5.", "(5)" and "5a)"; give the option more than once for several. Example: --item-pattern "^([A-Z]\\.\\d+)\\s+(.*)$" for labels like "A.3".',
};

export const KEEP_EDGES_OPTION: OptionSpec = {
  name: 'keep-edges',
  type: 'boolean',
  description:
    'Keep the regions as they are cut from the text layer. Without it an edge that cuts printed ink (the descender of the line above, the rule at the foot of a table, a figure) is moved to the nearest row or column that does not, by the same measure as the pixel check of `exercises verify --ink` (the pages are drawn once; nothing is moved when they cannot be drawn).',
};

/** The edges of the proposed regions that cut printed ink go to where they do not (see `cleanProposals`); the proposals change in place. */
async function cleanEdges(
  context: CommandContext,
  session: ProjectSession,
  pages: readonly PageText[],
  exercises: BookExercises | undefined,
  solutions: BookSolutions | undefined,
): Promise<{ cleaned: CleanResult | undefined; notes: string[] }> {
  if (flag(context.options, 'keep-edges')) return { cleaned: undefined, notes: [] };
  try {
    const pdf = await session.document();
    const cleaned = await cleanProposals((page) => renderDark(pdf, page), pages, exercises, solutions);
    return {
      cleaned,
      notes: cleaned.edges > 0 ? [`${plural(cleaned.edges, 'edge')} of ${plural(cleaned.regions, 'region')} moved out of printed ink (\`exercises verify --ink\` measures the same ink); --keep-edges leaves the regions as cut from the text layer.`] : [],
    };
  } catch (error) {
    if (error instanceof McPrepError && error.code === 'E_RENDER_UNAVAILABLE') return { cleaned: undefined, notes: ['The edges of the regions were not moved out of printed ink: the pages cannot be drawn here (the pixel check needs the @napi-rs/canvas package).'] };
    throw error;
  }
}

function wordList(options: CommandContext['options'], name: string): string[] | undefined {
  const text = stringOption(options, name);
  if (text === undefined) return undefined;
  const words = text.split(',').map((word) => word.trim()).filter(Boolean);
  if (words.length === 0) throw usage(`--${name} needs at least one word.`);
  return words;
}

function patternsFrom(options: CommandContext['options']): Partial<BookPatterns> | undefined {
  const chapterWords = wordList(options, 'chapter-words');
  const practiceWords = wordList(options, 'practice-words');
  const answerWords = wordList(options, 'answer-words');
  const stopWords = wordList(options, 'stop-words');
  const itemWords = wordList(options, 'item-words');
  const backWords = wordList(options, 'back-words');
  const given = options['answer-marker'];
  const markers = Array.isArray(given) ? given.map(String) : typeof given === 'string' ? [given] : [];
  for (const source of markers) {
    try {
      const groups = (new RegExp(`${source}|`, 'u').exec('') as RegExpExecArray).length - 1;
      if (groups < 1) throw new Error('it has no group for the section label');
    } catch (error) {
      throw usage(`--answer-marker "${source}" is not usable: ${(error as Error).message}.`, 'It must be a regular expression with a group (group 1) for the label of the section, such as "^Section\\s+(\\d+\\.\\d+)".');
    }
  }
  if (!chapterWords && !practiceWords && !answerWords && !stopWords && !itemWords && !backWords && markers.length === 0) return undefined;
  return {
    ...(chapterWords ? { chapterWords } : {}),
    ...(practiceWords ? { practiceWords } : {}),
    ...(answerWords ? { answerWords } : {}),
    ...(stopWords ? { stopWords } : {}),
    ...(itemWords ? { itemWords } : {}),
    ...(backWords ? { backWords } : {}),
    ...(markers.length > 0 ? { answerMarkers: markers } : {}),
  };
}

function itemPatternsFrom(options: CommandContext['options']): ItemPattern[] | undefined {
  const given = options['item-pattern'];
  const sources = Array.isArray(given) ? given.map(String) : typeof given === 'string' ? [given] : [];
  if (sources.length === 0) return undefined;
  return sources.map((source, index) => {
    try {
      const regex = new RegExp(source, 'u');
      // How many capture groups the expression has: an empty alternative always matches and shows them.
      const groups = (new RegExp(`${source}|`, 'u').exec('') as RegExpExecArray).length - 1;
      if (groups < 1) throw new Error('it has no group for the label');
      return { name: `pattern ${index + 1}`, regex };
    } catch (error) {
      throw usage(`--item-pattern "${source}" is not usable: ${(error as Error).message}.`, 'It must be a regular expression with a group for the label (group 1) and, optionally, one for the text after it (group 2).');
    }
  });
}

interface Loaded {
  session: ProjectSession;
  pages: PageText[];
}

/** Every page with its lines (fonts known); the ink profile and the ink map only for the pages in `ink` (figures and answers that are drawn, edges between lines). */
async function load(context: CommandContext, ink: ReadonlySet<number> = new Set()): Promise<Loaded> {
  const session = await context.session();
  const pdf = await session.document();
  const pages = await pdf.allPageText({ fonts: true });
  for (const page of ink) {
    const current = pages[page];
    if (current) pages[page] = { ...current, ink: await pdf.inkProfile(page), inkMap: await pdf.inkMap(page) };
  }
  return { session, pages };
}

interface Sections {
  entries: BookEntry[];
  answerKey: AnswerKey | undefined;
  /** `project`: the outline stored in the project; `derived`: found now, from the printed contents and the headings. */
  source: 'project' | 'derived';
  notes: string[];
}

/** The sections that the text finds, or, when it finds none, the ones that counting the bookmarks of the PDF gives. */
async function deriveFor(session: ProjectSession, pages: PageText[], patterns?: Partial<BookPatterns>): Promise<ReturnType<typeof deriveSections>> {
  const derived = deriveSections(pages, patterns ? { patterns } : {});
  if (derived.sections > 0 && derived.generic !== true) return derived;
  const bookmarks = await (await session.document()).outline();
  const counted = bookmarks ? deriveSectionsFromBookmarks(pages, bookmarks, patterns ? { patterns } : {}) : undefined;
  return counted ?? derived;
}

async function sectionsFor(session: ProjectSession, pages: PageText[], patterns?: Partial<BookPatterns>): Promise<Sections> {
  const outline = session.project.outline?.entries ?? [];
  if (outline.some((entry) => entry.id !== undefined)) {
    const located = locateSections(pages, outline, patterns ? { patterns } : {});
    return { entries: located.entries, answerKey: located.answerKey, source: 'project', notes: located.notes };
  }
  const derived = await deriveFor(session, pages, patterns);
  return {
    entries: derived.entries,
    answerKey: derived.answerKey,
    source: 'derived',
    notes: ['The project has no outline with section ids yet: the sections were derived now. Store them with `outline derive --book --apply` so that frames can refer to them.', ...derived.notes],
  };
}

function inkPages(entries: readonly BookEntry[]): Set<number> {
  const pages = new Set<number>();
  for (const entry of entries) {
    const practice = entry.practice;
    if (!practice) continue;
    for (let page = practice.page; page <= Math.min(practice.end.page, practice.page + 40); page += 1) pages.add(page);
  }
  return pages;
}

/** The pages of exercises and answers that are printed inside the text ("1.2.3 Aufgabe:", "Lösung 1.2.3"): the page of each and the two after it. */
function labelledInk(pages: readonly PageText[], patterns: Partial<BookPatterns> | undefined, answers: boolean): Set<number> {
  const words: BookPatterns = { ...DEFAULT_BOOK_PATTERNS, ...patterns };
  const hits = answers ? findLabelledAnswers(pages, words) : findLabelledItems(pages, words);
  return new Set(hits.length >= MIN_LABELLED ? labelledPages(hits, pages.length) : []);
}

/** The pages of the answers: the key at the back, and the answers printed right after the sections. */
function answerPages(entries: readonly BookEntry[], answerKey: AnswerKey | undefined, pageCount: number): Set<number> {
  const pages = new Set<number>();
  if (answerKey) for (let page = answerKey.page; page <= Math.min(answerKey.end?.page ?? pageCount - 1, pageCount - 1); page += 1) pages.add(page);
  for (const entry of entries) {
    const answers = entry.answers;
    if (!answers) continue;
    for (let page = answers.page; page <= Math.min(answers.end.page, answers.page + 40, pageCount - 1); page += 1) pages.add(page);
  }
  return pages;
}

function chooseSections(entries: readonly BookEntry[], ids: readonly string[]): BookEntry[] {
  if (ids.length === 0) return [...entries];
  const sections = entries.filter((entry) => entry.kind === 'section');
  const known = new Set(sections.flatMap((entry) => [entry.id, ...(entry.label !== undefined ? [entry.label] : [])]));
  for (const id of ids) {
    if (!known.has(id)) throw usage(`There is no section "${id}". The sections are ${sections.slice(0, 12).map((entry) => entry.id).join(', ')}${sections.length > 12 ? ', ...' : ''}.`);
  }
  return sections.filter((entry) => ids.includes(entry.id) || (entry.label !== undefined && ids.includes(entry.label)));
}

const percent = (confidence: number): string => confidence.toFixed(2);

/** What of a proposal's result an apply adds to it: whether it was written, what was created and replaced, the book totals and the validation. */
function appliedResult(result: object, done: CommandOutput): object {
  const report = done.result as { applied: boolean; dryRun: boolean; created: string[]; replaced: string[]; removed: string[]; book: unknown; validation: unknown };
  return { ...result, applied: report.applied, dryRun: report.dryRun, created: report.created, replaced: report.replaced, removed: report.removed, book: report.book, validation: report.validation };
}

// ---------------------------------------------------------------------------------------------------------------------
// outline derive --book

export async function runBookDerive(context: CommandContext): Promise<CommandOutput> {
  const { session, pages } = await load(context);
  const patterns = patternsFrom(context.options);
  const structure = await deriveFor(session, pages, patterns);
  const rows = structure.entries.map((entry) => [
    entry.id,
    entry.label ?? '',
    String(entry.page),
    entry.top !== undefined ? String(Math.round(entry.top * 1000) / 1000) : '',
    percent(entry.confidence),
    `${'  '.repeat(entry.depth)}${entry.title}`,
    entry.practice ? `practice p${entry.practice.page}-${Math.max(entry.practice.page, entry.practice.end.page - (entry.practice.end.top < 0.2 ? 1 : 0))}` : entry.kind === 'section' ? 'no practice set' : '',
  ]);
  const others = structure.entries.length - structure.chapters - structure.sections;
  const head = `${plural(structure.chapters, 'chapter')} and ${plural(structure.sections, 'section')}${others > 0 ? ` and ${plural(others, 'other entry', 'other entries')}` : ''} found (body text ${structure.bodyFontSize} pt; ${structure.toc.pages.length > 0 ? `printed contents on page${structure.toc.pages.length === 1 ? '' : 's'} ${structure.toc.pages.join(', ')}` : 'no printed contents found'}${structure.toc.openers.length > 0 ? `, lists on ${plural(structure.toc.openers.length, 'chapter opener')}` : ''}${structure.numbering.offset !== undefined ? `, printed page = page + ${structure.numbering.offset}` : ''}${structure.answerKey ? `, answer key from page ${structure.answerKey.page}` : ''}).`;
  const differences = structure.entries.flatMap((entry) => entry.differences.filter((spelling) => spelling.source === 'table of contents' || spelling.source === 'chapter opener').map((spelling) => `${entry.id}: "${entry.title}" (chosen) differs from the ${spelling.source}: "${spelling.text}"`));
  const text = [
    head,
    table(rows, ['id', 'label', 'page', 'top', 'conf', 'title', 'practice set']),
    ...(structure.notes.length > 0 ? ['To look at:', ...structure.notes.map((note) => `  - ${note}`)] : []),
    ...(differences.length > 0 ? ['Spellings that differ:', ...differences.slice(0, 20).map((line) => `  - ${line}`), ...(differences.length > 20 ? [`  ... and ${differences.length - 20} more (in the JSON: entries[].differences)`] : [])] : []),
  ].join('\n');
  const result = {
    entries: structure.entries,
    chapters: structure.chapters,
    sections: structure.sections,
    numbering: structure.numbering,
    toc: structure.toc,
    answerKey: structure.answerKey ?? null,
    practiceAnchors: structure.practiceAnchors,
    bodyFontSize: structure.bodyFontSize,
    notes: structure.notes,
    applied: false,
  };
  if (flag(context.options, 'apply') && structure.entries.length > 0) {
    const entries = toOutlineEntries(structure);
    const had = session.project.outline?.entries ?? [];
    const replacing = had.length > 0 ? `\nThe outline the project had (${plural(had.length, 'entry', 'entries')}) is replaced; exercises keep their sections as long as the ids are still there.` : '';
    const done = await applyAndReport(context, [{ op: 'outline.set', source: 'derived', entries } as Operation], 'stored the sections as the outline of the project', reportFlags(context.options));
    return { ...done, result: appliedResult(result, done), text: `${text}${replacing}\n${done.text}`, notes: structure.notes };
  }
  return { result, text: `${text}\nNothing is stored unless you say --apply (the outline then carries ids and labels, which exercises refer to).`, notes: structure.notes };
}

// ---------------------------------------------------------------------------------------------------------------------
// exercises propose

function sectionRow(section: SectionExercises, withSolutions: BookSolutions | undefined): string[] {
  const solved = withSolutions?.sections.find((entry) => entry.section === section.section);
  return [
    section.section,
    String(section.proposals.length),
    section.first !== undefined ? `${section.first}..${section.last as string}` : '',
    section.pages[0] === section.pages[1] ? String(section.pages[0]) : `${section.pages[0]}-${section.pages[1]}`,
    String(section.instructions.length),
    ...(solved ? [String(solved.answers.length)] : []),
    section.title,
  ];
}

/** What the proposals mean for the book exercises the project already has: nothing is added twice, nothing a person fixed is overwritten. */
interface ExercisePlan {
  operations: Operation[];
  /** Exercises the project does not have yet. */
  added: number;
  /** In the project already, exactly as proposed. */
  unchanged: number;
  /** In the project already, and given the answer that was found now. */
  solutionsAdded: number;
  /** `SECTION:LABEL` of the exercises the project has that differ from the proposal (kept, unless `--replace`). */
  changed: string[];
  /** Of those, how many this run overwrites. */
  replaced: number;
  /** `SECTION:LABEL` of exercises the project has in the proposed sections that the proposal does not contain. */
  notProposed: string[];
  /** Proposals that cannot become operations (a label the data model does not allow), with the reason. */
  refused: string[];
}

function planExercises(frames: readonly Frame[], proposals: readonly ExerciseProposal[], sections: ReadonlySet<string>, solutions: ReadonlyMap<string, readonly Region[]>, replace: boolean): ExercisePlan {
  const existing = new Map<string, Frame>();
  for (const frame of frames) {
    const key = bookKeyOf(frame);
    if (key !== undefined) existing.set(key, frame);
  }
  const plan: ExercisePlan = { operations: [], added: 0, unchanged: 0, solutionsAdded: 0, changed: [], replaced: 0, notProposed: [], refused: [] };
  const seen = new Set<string>();
  for (const proposal of proposals) {
    const key = bookKey(proposal.section, proposal.label);
    const reference = bookReference(proposal.section, proposal.label);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!LIMITS.labelPattern.test(proposal.label)) {
      plan.refused.push(`${reference}: the number "${proposal.label}" is not a label the bundle allows (1 to ${LIMITS.labelMax} letters, digits, spaces and . _ - ( ) /, starting with a letter or digit)`);
      continue;
    }
    const answer = solutions.get(key);
    const solution = answer !== undefined && answer.length <= LIMITS.maxSolutionRegions ? answer : undefined;
    if (answer !== undefined && solution === undefined) plan.refused.push(`${reference}: its answer would need ${answer.length} regions, at most ${LIMITS.maxSolutionRegions} are allowed (the exercise is proposed without it)`);
    const frame = existing.get(key);
    if (!frame) {
      plan.operations.push(exerciseToOperation(proposal, solution ? { solution } : {}) as Operation);
      plan.added += 1;
      continue;
    }
    const state = compareWithProposal(frame, proposal, solution);
    if (state === 'unchanged') plan.unchanged += 1;
    else if (state === 'needs-solution') {
      plan.operations.push(solutionToOperation(reference, solution as readonly Region[]));
      plan.solutionsAdded += 1;
    } else {
      plan.changed.push(reference);
      if (replace) {
        plan.operations.push(exerciseToOperation(proposal, { ...(solution ? { solution } : {}), replace: true }) as Operation);
        plan.replaced += 1;
      }
    }
  }
  for (const [key, frame] of existing) {
    if (!seen.has(key) && frame.section !== undefined && sections.has(frame.section)) plan.notProposed.push(bookReference(frame.section, frame.label as string));
  }
  return plan;
}

const listed = (references: readonly string[], most = 12): string => (references.length > most ? `${references.slice(0, most).join(', ')}, ... (${references.length})` : references.join(', '));

export const exercisesPropose: CommandSpec = {
  name: 'exercises propose',
  summary: 'Find the numbered exercises of the practice sets of a book, with the instruction that governs each (offline heuristics, nothing is applied).',
  description:
    'For every section with a practice set (found from the outline of the project, or derived now): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its own text, the continuation lines, the second line of a fraction, the figure that stands beside it, the lines on the next page), the bold instruction printed above a group of exercises as its context (two regions when it crosses a page break), and the evidence. Numbers that are missing, printed twice or put aside are reported, not hidden: what the book prints is what is proposed, and a difference from what you expected is a finding to look at. Look at the crops (`render --page`/`crop`) of a sample before you apply. `--ops` writes the operations (add with authority "book", label, section, context) for `frames apply`. `--apply` applies them as one atomic batch and can be repeated: an exercise is identified by its section and label, so one the project already has the same way is skipped, one that only lacks its answer gets the answer found now, and one that differs (a person may have corrected the frame) is kept and listed under "changed" unless you say `--replace`, which overwrites it in place (it keeps its id). `--solutions` also reads the answer key and puts the solution regions into the same operations.',
  writes: true,
  options: [
    { name: 'section', type: 'string', value: '<0.1,0.2>', description: 'Only these sections (ids or labels); default all.' },
    { name: 'solutions', type: 'boolean', description: 'Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).' },
    { name: 'max-items', type: 'number', value: '<n>', description: 'At most this many exercises per section (the surplus is listed as excluded); default no limit.' },
    { name: 'instructions', type: 'string', value: 'bold|margin|auto|none', description: 'How instructions are recognised: bold (set in bold, at the margin), margin (at the margin, above an item), auto (bold when the pages carry font information, else margin; the default), none.' },
    ITEM_PATTERN_OPTION,
    ...BOOK_WORD_OPTIONS,
    KEEP_EDGES_OPTION,
    { name: 'ops', type: 'string', value: '<file>', description: 'Write the operations as a JSON batch (for `frames apply`).' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write everything (every proposal with its evidence, the instructions, the rejected numbers) as JSON.' },
    { name: 'apply', type: 'boolean', description: 'Apply the proposals to the project now (one atomic batch). Exercises the project already has are skipped (see --replace).' },
    { name: 'replace', type: 'boolean', description: 'With --apply (or --ops): overwrite the exercises of the project that differ from the proposal, in place (they keep their ids); without it they are kept and listed.' },
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep exercises propose', 'mcprep exercises propose --section 0.1,0.2 --ops batch.json', 'mcprep exercises propose --solutions --apply', 'mcprep exercises propose --section 1.7 --replace --apply'],
  output:
    '{ source: "project"|"derived", sections: [{ section, label, title, count, first, last, pages, gaps, duplicates, rejected, excluded, instructions: [{ text, governs }], notes, lowConfidence: [{ label, confidence, evidence }] }], counts: { sections, exercises, withSolution, added, unchanged, solutionsAdded, changed, replaced }, edges?: { moved, regions } (the edges moved out of printed ink, see --keep-edges), changed: string[] (SECTION:LABEL of exercises of the project that differ from the proposal), notProposed: string[], refused: string[], proposals?: [...] (all, when there are at most 300; else proposalsOmitted: n and the details file), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), notes, applied }; with --apply the result also has the fields of every command that changes the project (created, replaced, counts, book, validation)',
  async run(context) {
    const first = await load(context);
    const patterns = patternsFrom(context.options);
    const itemPatterns = itemPatternsFrom(context.options);
    const sections = await sectionsFor(first.session, first.pages, patterns);
    const chosen = chooseSections(sections.entries, (stringOption(context.options, 'section') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    const ink = new Set([...inkPages(chosen), ...labelledInk(first.pages, patterns, false)]);
    const { session, pages } = ink.size > 0 ? await withInk(first, ink) : first;
    const maxItems = numberOption(context.options, 'max-items');
    const instructionMode = stringOption(context.options, 'instructions');
    if (instructionMode !== undefined && !['bold', 'margin', 'auto', 'none'].includes(instructionMode)) throw usage('--instructions must be bold, margin, auto or none.');
    const exercises: BookExercises = proposeExercises(pages, chosen, {
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(itemPatterns ? { itemPatterns } : {}),
      ...(patterns ? { patterns } : {}),
      ...(instructionMode !== undefined ? { instructions: instructionMode as 'bold' | 'margin' | 'auto' | 'none' } : {}),
    });
    const wantSolutions = flag(context.options, 'solutions');
    let solutions: BookSolutions | undefined;
    const proposals = exercises.sections.flatMap((section) => section.proposals);
    if (wantSolutions) {
      const needInk = new Set<number>();
      for (const page of [...answerPages(sections.entries, sections.answerKey, pages.length), ...labelledInk(pages, patterns, true)]) needInk.add(page);
      const loaded = needInk.size > 0 ? await withInk({ session, pages }, needInk) : { session, pages };
      solutions = proposeSolutions(loaded.pages, sections.entries, proposals.map((proposal) => ({ section: proposal.section, label: proposal.label })), {
        ...(sections.answerKey ? { answerKey: sections.answerKey } : {}),
        ...(patterns ? { patterns } : {}),
        ...(itemPatterns ? { itemPatterns } : {}),
      });
    }
    const cleaning = await cleanEdges(context, session, pages, exercises, solutions);
    const solutionMap = new Map<string, readonly Region[]>();
    for (const answer of solutions?.sections.flatMap((section) => section.answers) ?? []) solutionMap.set(bookKey(answer.section, answer.label), answer.regions);
    const replace = flag(context.options, 'replace');
    const plan = planExercises(session.project.frames, proposals, new Set(exercises.sections.map((section) => section.section)), solutionMap, replace);
    const operations = plan.operations;
    const opsFile = stringOption(context.options, 'ops');
    if (opsFile !== undefined) await writeFile(resolve(context.io.cwd, opsFile), `${JSON.stringify({ operations }, null, 2)}\n`);
    const detailsFile = stringOption(context.options, 'details');
    const summaries = exercises.sections.map((section) => summarize(section, solutions));
    const withSolution = proposals.filter((proposal) => solutionMap.has(bookKey(proposal.section, proposal.label))).length;
    const counts = {
      sections: exercises.sections.length,
      exercises: proposals.length,
      withSolution,
      added: plan.added,
      unchanged: plan.unchanged,
      solutionsAdded: plan.solutionsAdded,
      changed: plan.changed.length,
      replaced: plan.replaced,
    };
    const notes = [...sections.notes, ...exercises.notes, ...(solutions?.notes ?? []), ...plan.refused, ...cleaning.notes];
    const result = {
      source: sections.source,
      sections: summaries,
      counts,
      ...(cleaning.cleaned ? { edges: { moved: cleaning.cleaned.edges, regions: cleaning.cleaned.regions } } : {}),
      changed: plan.changed,
      notProposed: plan.notProposed,
      refused: plan.refused,
      ...(proposals.length <= 300 ? { proposals } : { proposalsOmitted: proposals.length }),
      ...(operations.length <= 300 ? { operations } : { operationsOmitted: operations.length }),
      notes,
      applied: false,
    };
    if (detailsFile !== undefined) await writeFile(resolve(context.io.cwd, detailsFile), `${JSON.stringify({ ...result, proposals, solutions: solutions ?? null, sectionsDetail: exercises.sections }, null, 1)}\n`);
    const anomalies = exercises.sections.flatMap((section) => section.notes.map((note) => `${section.section}: ${note}`));
    const inProject = plan.unchanged + plan.solutionsAdded + plan.changed.length;
    const head = [
      `${plural(proposals.length, 'exercise')} proposed in ${plural(exercises.sections.length, 'section')}${wantSolutions ? `, ${withSolution} with a solution` : ''}.`,
      inProject > 0
        ? `The project has ${inProject} of them already: ${plan.unchanged} the same${plan.solutionsAdded > 0 ? `, ${plan.solutionsAdded} to get their solution` : ''}${plan.changed.length > 0 ? `, ${plan.changed.length} different (${replace ? 'to be replaced' : 'kept as they are; --replace overwrites them'})` : ''}; ${plan.added} are new.`
        : '',
      'Nothing is written unless you say --apply.',
    ]
      .filter(Boolean)
      .join(' ');
    const text = [
      head,
      table(exercises.sections.map((section) => sectionRow(section, solutions)), ['section', 'items', 'numbers', 'pages', 'instr', ...(solutions ? ['answers'] : []), 'title']),
      ...(anomalies.length > 0 ? ['To look at:', ...anomalies.slice(0, 40).map((line) => `  - ${line}`), ...(anomalies.length > 40 ? [`  ... and ${anomalies.length - 40} more (JSON: sections[].notes)`] : [])] : []),
      ...(plan.changed.length > 0 ? [`Different from the project's own frames${replace ? ' (replaced)' : ' (kept)'}: ${listed(plan.changed)}.`] : []),
      ...(plan.notProposed.length > 0 ? [`In the project but not in this proposal (left as they are): ${listed(plan.notProposed)}.`] : []),
      ...(plan.refused.length > 0 ? ['Left out:', ...plan.refused.slice(0, 12).map((line) => `  - ${line}`)] : []),
      ...(sections.notes.length > 0 ? sections.notes.map((note) => note) : []),
      ...cleaning.notes,
      ...(opsFile !== undefined ? [`Wrote ${plural(operations.length, 'operation')} to ${opsFile}; apply them with \`mcprep frames apply ${opsFile}\`.`] : []),
      ...(detailsFile !== undefined ? [`Wrote the details to ${detailsFile}.`] : []),
    ].join('\n');
    if (flag(context.options, 'apply')) {
      if (sections.source === 'derived') {
        throw new McPrepError('E_NO_SECTIONS', 'The exercises refer to sections by id, and the project has no outline with ids yet.', {
          hint: 'Store the sections first: `mcprep outline derive --book --apply` (look at them, edit if needed), then run this again.',
        });
      }
      if (operations.length === 0) return { result: { ...result, applied: false }, text: `${text}\nNothing to apply: the project has these exercises already.`, notes };
      const parts = [
        plan.added > 0 ? `added ${plural(plan.added, 'book exercise')}` : '',
        plan.solutionsAdded > 0 ? `gave ${plural(plan.solutionsAdded, 'exercise')} their solution` : '',
        plan.replaced > 0 ? `replaced ${plural(plan.replaced, 'book exercise')}` : '',
      ].filter(Boolean);
      const done = await applyAndReport(context, operations, parts.join(', '), reportFlags(context.options));
      return { ...done, result: appliedResult(result, done), text: `${text}\n${done.text}`, notes };
    }
    return { result, text, notes };
  },
};

async function withInk(loaded: Loaded, ink: ReadonlySet<number>): Promise<Loaded> {
  const pdf = await loaded.session.document();
  const pages = [...loaded.pages];
  for (const page of ink) {
    const current = pages[page];
    if (current && current.ink === undefined) pages[page] = { ...current, ink: await pdf.inkProfile(page), inkMap: await pdf.inkMap(page) };
  }
  return { session: loaded.session, pages };
}

function summarize(section: SectionExercises, solutions: BookSolutions | undefined): Record<string, unknown> {
  const solved = solutions?.sections.find((entry) => entry.section === section.section);
  return {
    section: section.section,
    ...(section.label !== undefined ? { label: section.label } : {}),
    title: section.title,
    count: section.proposals.length,
    first: section.first ?? null,
    last: section.last ?? null,
    pages: section.pages,
    gaps: section.gaps,
    duplicates: section.duplicates,
    rejected: section.rejected,
    excluded: section.excluded,
    instructions: section.instructions.map((instruction) => ({ text: instruction.text, governs: instruction.governs })),
    notes: section.notes,
    lowConfidence: section.proposals.filter((proposal) => proposal.confidence < 0.8).map((proposal: ExerciseProposal) => ({ label: proposal.label, confidence: proposal.confidence, evidence: proposal.evidence })),
    ...(solved ? { answers: solved.answers.length, withoutAnswer: solved.withoutAnswer, withoutExercise: solved.withoutExercise, ...(solved.selected === true ? { selected: true } : {}), ...(solved.coverage ? { coverage: solved.coverage } : {}) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// solutions propose

export const solutionsPropose: CommandSpec = {
  name: 'solutions propose',
  summary: 'Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.',
  description:
    'The answer key is cut into bands by the section markers and headers (a band runs across all columns and over page breaks); inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; exercises without an answer and answers without an exercise are reported. `--ops` writes `solution.set` operations (one per exercise, named SECTION:LABEL) for `frames apply`; `--apply` applies them as one atomic batch. It can be repeated: an exercise that already has this solution is skipped, and one whose solution differs (a person may have corrected it) is kept and listed under "changed" unless you say `--replace`. The solution is hidden: it is never shown with the exercise, never sent to a tutor, used only to grade.',
  writes: true,
  options: [
    { name: 'ops', type: 'string', value: '<file>', description: 'Write the operations as a JSON batch (for `frames apply`).' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write everything (every answer with its evidence, the sequences, the headers) as JSON.' },
    { name: 'apply', type: 'boolean', description: 'Apply the solutions to the project now (one atomic batch).' },
    { name: 'replace', type: 'boolean', description: 'Overwrite the solution of an exercise that has a different one; without it that exercise is kept and listed.' },
    ITEM_PATTERN_OPTION,
    ...BOOK_WORD_OPTIONS,
    KEEP_EDGES_OPTION,
    ...REPORT_OPTIONS,
  ],
  examples: ['mcprep solutions propose', 'mcprep solutions propose --ops solutions.json', 'mcprep solutions propose --apply', 'mcprep solutions propose --replace --apply'],
  output:
    '{ sections: [{ section, label, title, answers, first, last, gaps, duplicates, withoutAnswer, withoutExercise, headers, selected?, coverage?: { exercises, answered }, notes }], counts: { exercises, answers, matched, withoutAnswer, withoutExercise, added, unchanged, changed }, edges?: { moved, regions } (the edges moved out of printed ink, see --keep-edges), coverage?: { exercises, answered, sections, selectedSections } (for a key that answers selected exercises only), changed: string[] (SECTION:LABEL of exercises whose solution differs from the proposal), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), notes, applied }; with --apply the result also has dryRun, created, replaced, removed, book and validation',
  async run(context) {
    const first = await load(context);
    const patterns = patternsFrom(context.options);
    const itemPatterns = itemPatternsFrom(context.options);
    const sections = await sectionsFor(first.session, first.pages, patterns);
    const frames = first.session.project.frames.filter((frame): frame is Frame & { section: string; label: string } => frame.authority === 'book' && frame.section !== undefined && frame.label !== undefined);
    const needInk = new Set<number>();
    for (const page of [...answerPages(sections.entries, sections.answerKey, first.pages.length), ...labelledInk(first.pages, patterns, true)]) needInk.add(page);
    const { pages } = needInk.size > 0 ? await withInk(first, needInk) : first;
    const solutions = proposeSolutions(pages, sections.entries, frames.map((frame) => ({ section: frame.section, label: frame.label })), {
      ...(sections.answerKey ? { answerKey: sections.answerKey } : {}),
      ...(patterns ? { patterns } : {}),
      ...(itemPatterns ? { itemPatterns } : {}),
    });
    const cleaning = await cleanEdges(context, first.session, pages, undefined, solutions);
    const byKey = new Map(frames.map((frame) => [bookKey(frame.section, frame.label), frame]));
    const replace = flag(context.options, 'replace');
    const operations: Operation[] = [];
    const changed: string[] = [];
    const refused: string[] = [];
    let matched = 0;
    let added = 0;
    let unchanged = 0;
    for (const answer of solutions.sections.flatMap((section) => section.answers)) {
      const frame = byKey.get(bookKey(answer.section, answer.label));
      if (!frame) continue;
      matched += 1;
      const reference = bookReference(answer.section, answer.label);
      if (answer.regions.length > LIMITS.maxSolutionRegions) {
        refused.push(`${reference}: its answer would need ${answer.regions.length} regions, at most ${LIMITS.maxSolutionRegions} are allowed`);
        continue;
      }
      const state = compareSolution(frame, answer.regions);
      if (state === 'unchanged') unchanged += 1;
      else if (state === 'needs-solution') {
        operations.push(solutionToOperation(reference, answer.regions));
        added += 1;
      } else {
        changed.push(reference);
        if (replace) operations.push(solutionToOperation(reference, answer.regions));
      }
    }
    const opsFile = stringOption(context.options, 'ops');
    if (opsFile !== undefined) await writeFile(resolve(context.io.cwd, opsFile), `${JSON.stringify({ operations }, null, 2)}\n`);
    const detailsFile = stringOption(context.options, 'details');
    if (detailsFile !== undefined) await writeFile(resolve(context.io.cwd, detailsFile), `${JSON.stringify(solutions, null, 1)}\n`);
    const withoutAnswer = solutions.sections.reduce((sum, section) => sum + section.withoutAnswer.length, 0);
    const withoutExercise = solutions.sections.reduce((sum, section) => sum + section.withoutExercise.length, 0);
    const counts = { exercises: frames.length, answers: solutions.sections.reduce((sum, section) => sum + section.answers.length, 0), matched, withoutAnswer, withoutExercise, added, unchanged, changed: changed.length };
    const notes = [...(frames.length === 0 ? ['The project has no authoritative exercises yet: propose them first (`mcprep exercises propose --apply`), or use `exercises propose --solutions` to do both at once.'] : []), ...solutions.notes, ...refused, ...cleaning.notes];
    const result = {
      sections: solutions.sections.map((section) => ({
        section: section.section,
        ...(section.label !== undefined ? { label: section.label } : {}),
        title: section.title,
        answers: section.answers.length,
        first: section.first ?? null,
        last: section.last ?? null,
        gaps: section.gaps,
        duplicates: section.duplicates,
        withoutAnswer: section.withoutAnswer,
        withoutExercise: section.withoutExercise,
        headers: section.headers,
        ...(section.selected === true ? { selected: true } : {}),
        ...(section.coverage ? { coverage: section.coverage } : {}),
        notes: section.notes,
      })),
      counts,
      ...(cleaning.cleaned ? { edges: { moved: cleaning.cleaned.edges, regions: cleaning.cleaned.regions } } : {}),
      ...(solutions.coverage ? { coverage: solutions.coverage } : {}),
      changed,
      ...(operations.length <= 300 ? { operations } : { operationsOmitted: operations.length }),
      notes,
      applied: false,
    };
    // A key that answers selected exercises only is said once for the book (a note below), not for every section.
    const anomalies = solutions.sections.flatMap((section) => section.notes.filter((note) => !note.endsWith('(selected answers)')).map((note) => `${section.section}: ${note}`));
    const text = [
      `${plural(counts.answers, 'answer')} found in the answer key (pages ${solutions.key?.firstPage ?? '?'}-${solutions.key?.lastPage ?? '?'}); ${plural(matched, 'is', 'are')} matched to an exercise of the project (${added} to be added${unchanged > 0 ? `, ${unchanged} there already` : ''}${changed.length > 0 ? `, ${changed.length} different: ${replace ? 'to be replaced' : 'kept, --replace overwrites them'}` : ''}), ${plural(withoutAnswer, 'exercise')} without an answer, ${plural(withoutExercise, 'answer')} without an exercise. Nothing is written unless you say --apply.`,
      table(
        solutions.sections.map((section) => [section.section, String(section.answers.length), section.first !== undefined ? `${section.first}..${section.last as string}` : '', String(section.withoutAnswer.length), String(section.withoutExercise.length), section.title]),
        ['section', 'answers', 'numbers', 'no answer', 'no exercise', 'title'],
      ),
      ...(anomalies.length > 0 ? ['To look at:', ...anomalies.slice(0, 40).map((line) => `  - ${line}`), ...(anomalies.length > 40 ? [`  ... and ${anomalies.length - 40} more (JSON: sections[].notes)`] : [])] : []),
      ...(changed.length > 0 ? [`Solutions that differ from the project's${replace ? ' (replaced)' : ' (kept)'}: ${listed(changed)}.`] : []),
      ...notes.filter((note) => !solutions.notes.includes(note)).map((note) => note),
      ...solutions.notes,
      ...(opsFile !== undefined ? [`Wrote ${plural(operations.length, 'operation')} to ${opsFile}; apply them with \`mcprep frames apply ${opsFile}\`.`] : []),
    ].join('\n');
    if (flag(context.options, 'apply')) {
      if (operations.length === 0) return { result, text: `${text}\nNothing to apply.`, notes };
      const done = await applyAndReport(context, operations, `gave ${plural(operations.length, 'exercise')} their solution`, reportFlags(context.options));
      return { ...done, result: appliedResult(result, done), text: `${text}\n${done.text}`, notes };
    }
    return { result, text, notes };
  },
};
