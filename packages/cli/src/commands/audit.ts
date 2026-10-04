import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  McPrepError,
  deriveSections,
  exercisesToOperations,
  locateSections,
  proposeExercises,
  proposeSolutions,
  toOutlineEntries,
  type BookEntry,
  type BookExercises,
  type BookPatterns,
  type BookSolutions,
  type ExerciseProposal,
  type Frame,
  type ItemPattern,
  type Operation,
  type PageText,
  type PlaceOnPage,
  type ProjectSession,
  type Region,
  type SectionExercises,
} from '@mcprep/core';
import { flag, numberOption, stringOption, usage } from '../args.js';
import { plural, table } from '../format.js';
import type { CommandContext, CommandOutput, CommandSpec, OptionSpec } from '../types.js';
import { GLOBAL_OPTIONS, applyAndReport } from './common.js';

/**
 * The commands that audit a book: `outline derive --book` (chapters and sections from the printed contents and the
 * headings), `exercises propose` (the numbered exercises of the practice sets, with the instruction as context) and
 * `solutions propose` (the answers of the answer key at the back of the same PDF). They propose; nothing is written
 * unless `--apply` is given, and then it goes through the same operations, validation and atomic write as everything else.
 */

const box = (rect: { left: number; top: number; right: number; bottom: number }): [number, number, number, number] => [rect.left, rect.top, rect.right, rect.bottom];

/** The words that make a heading of a book recognisable; the defaults are English, German, French, Spanish and Italian. */
export const BOOK_WORD_OPTIONS: OptionSpec[] = [
  { name: 'chapter-words', type: 'string', value: '<chapter,part,...>', description: 'Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults (chapter, part, unit, kapitel, chapitre, capítulo, ...).' },
  { name: 'practice-words', type: 'string', value: '<practice,exercises,...>', description: 'Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, übungen, aufgaben, ...).' },
  { name: 'answer-words', type: 'string', value: '<answers,solutions,...>', description: 'Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults (answers, answer key, solutions, lösungen, ...).' },
];

export const ITEM_PATTERN_OPTION: OptionSpec = {
  name: 'item-pattern',
  type: 'string',
  multiple: true,
  value: '<regex>',
  description:
    'How the number of an exercise (or of an answer) starts a line, as a regular expression: group 1 is the label as printed (without the closing mark), group 2 the text after it. Replaces the defaults, which read "5)", "5.", "(5)" and "5a)"; give the option more than once for several. Example: --item-pattern "^([A-Z]\\.\\d+)\\s+(.*)$" for labels like "A.3".',
};

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
  if (!chapterWords && !practiceWords && !answerWords) return undefined;
  return { ...(chapterWords ? { chapterWords } : {}), ...(practiceWords ? { practiceWords } : {}), ...(answerWords ? { answerWords } : {}) };
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

/** Every page with its lines (fonts known); the ink profile only for the pages in `ink` (figures and answers that are drawn). */
async function load(context: CommandContext, ink: ReadonlySet<number> = new Set()): Promise<Loaded> {
  const session = await context.session();
  const pdf = await session.document();
  const pages = await pdf.allPageText({ fonts: true });
  for (const page of ink) {
    const current = pages[page];
    if (current) pages[page] = { ...current, ink: await pdf.inkProfile(page) };
  }
  return { session, pages };
}

interface Sections {
  entries: BookEntry[];
  answerKey: PlaceOnPage | undefined;
  /** `project`: the outline stored in the project; `derived`: found now, from the printed contents and the headings. */
  source: 'project' | 'derived';
  notes: string[];
}

function sectionsFor(session: ProjectSession, pages: PageText[], patterns?: Partial<BookPatterns>): Sections {
  const outline = session.project.outline?.entries ?? [];
  if (outline.some((entry) => entry.id !== undefined)) {
    const located = locateSections(pages, outline, patterns ? { patterns } : {});
    return { entries: located.entries, answerKey: located.answerKey, source: 'project', notes: located.notes };
  }
  const derived = deriveSections(pages, patterns ? { patterns } : {});
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

// ---------------------------------------------------------------------------------------------------------------------
// outline derive --book

export async function runBookDerive(context: CommandContext): Promise<CommandOutput> {
  const { pages } = await load(context);
  const patterns = patternsFrom(context.options);
  const structure = deriveSections(pages, patterns ? { patterns } : {});
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
    bodyFontSize: structure.bodyFontSize,
    notes: structure.notes,
    applied: false,
  };
  if (flag(context.options, 'apply') && structure.entries.length > 0) {
    const entries = toOutlineEntries(structure);
    const done = await applyAndReport(context, [{ op: 'outline.set', source: 'derived', entries } as Operation], 'stored the sections as the outline of the project');
    return { ...done, result: { ...result, applied: true, ...(done.result as object) }, text: `${text}\n${done.text}`, notes: structure.notes };
  }
  return { result, text: `${text}\nNothing is stored unless you say --apply (the outline then carries ids and labels, which exercises refer to).`, notes: structure.notes };
}

// ---------------------------------------------------------------------------------------------------------------------
// exercises propose

/** The frames of a dry run say whether this build of the tool keeps the fields of authoritative exercises. */
async function assertAuthoritySupported(session: ProjectSession, operations: readonly Operation[]): Promise<void> {
  const probe = operations[0] as { id?: string } | undefined;
  if (!probe?.id) return;
  const outcome = await session.apply([probe as Operation], { modifiedBy: 'cli', dryRun: true, force: true });
  const made = outcome.project.frames.find((frame) => frame.id === probe.id);
  if (made && made.authority !== 'book') {
    throw new McPrepError('E_UNSUPPORTED', 'This build of Math Canvas Prep cannot write authoritative exercises (the add operation drops authority, label and section).', {
      hint: 'Use a build that has the authoritative exercise fields, or write the operations with --ops and apply them later.',
    });
  }
}

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

export const exercisesPropose: CommandSpec = {
  name: 'exercises propose',
  summary: 'Find the numbered exercises of the practice sets of a book, with the instruction that governs each (offline heuristics, nothing is applied).',
  description:
    'For every section with a practice set (found from the outline of the project, or derived now): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its own text, the continuation lines, the second line of a fraction, the figure that stands beside it, the lines on the next page), the bold instruction printed above a group of exercises as its context (two regions when it crosses a page break), and the evidence. Numbers that are missing, printed twice or put aside are reported, not hidden: what the book prints is what is proposed, and a difference from what you expected is a finding to look at. Look at the crops (`render --page`/`crop`) of a sample before you apply. `--ops` writes the operations (add with authority "book", label, section, context) for `frames apply`; `--apply` applies them (exercises already in the project, found by their deterministic id, are skipped, so applying twice does not duplicate); `--solutions` also reads the answer key and puts the solution regions into the same operations.',
  writes: true,
  options: [
    { name: 'section', type: 'string', value: '<0.1,0.2>', description: 'Only these sections (ids or labels); default all.' },
    { name: 'solutions', type: 'boolean', description: 'Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).' },
    { name: 'max-items', type: 'number', value: '<n>', description: 'At most this many exercises per section (the surplus is listed as excluded); default no limit.' },
    { name: 'instructions', type: 'string', value: 'bold|margin|auto|none', description: 'How instructions are recognised: bold (set in bold, at the margin), margin (at the margin, above an item), auto (bold when the pages carry font information, else margin; the default), none.' },
    ITEM_PATTERN_OPTION,
    ...BOOK_WORD_OPTIONS,
    { name: 'ops', type: 'string', value: '<file>', description: 'Write the operations as a JSON batch (for `frames apply`).' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write everything (every proposal with its evidence, the instructions, the rejected numbers) as JSON.' },
    { name: 'apply', type: 'boolean', description: 'Apply the proposals to the project now (one atomic batch).' },
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep exercises propose', 'mcprep exercises propose --section 0.1,0.2 --ops batch.json', 'mcprep exercises propose --solutions --apply'],
  output:
    '{ source: "project"|"derived", sections: [{ section, label, title, count, first, last, pages, gaps, duplicates, rejected, excluded, instructions: [{ text, governs }], notes, lowConfidence: [{ label, confidence, evidence }] }], counts: { sections, exercises, withSolution }, proposals?: [...] (all, when there are at most 300; else proposalsOmitted: n and the details file), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), skipped: string[], notes, applied }',
  async run(context) {
    const first = await load(context);
    const patterns = patternsFrom(context.options);
    const itemPatterns = itemPatternsFrom(context.options);
    const sections = sectionsFor(first.session, first.pages, patterns);
    const chosen = chooseSections(sections.entries, (stringOption(context.options, 'section') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    const ink = inkPages(chosen);
    const { session, pages } = ink.size > 0 ? await withInk(first, ink) : first;
    const maxItems = numberOption(context.options, 'max-items');
    const instructionMode = stringOption(context.options, 'instructions');
    if (instructionMode !== undefined && !['bold', 'margin', 'auto', 'none'].includes(instructionMode)) throw usage('--instructions must be bold, margin, auto or none.');
    const exercises: BookExercises = proposeExercises(pages, chosen, {
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(itemPatterns ? { itemPatterns } : {}),
      ...(instructionMode !== undefined ? { instructions: instructionMode as 'bold' | 'margin' | 'auto' | 'none' } : {}),
    });
    const wantSolutions = flag(context.options, 'solutions');
    let solutions: BookSolutions | undefined;
    const proposals = exercises.sections.flatMap((section) => section.proposals);
    if (wantSolutions) {
      const needInk = new Set<number>();
      if (sections.answerKey) for (let page = sections.answerKey.page; page < pages.length; page += 1) needInk.add(page);
      const loaded = needInk.size > 0 ? await withInk({ session, pages }, needInk) : { session, pages };
      solutions = proposeSolutions(loaded.pages, sections.entries, proposals.map((proposal) => ({ section: proposal.section, label: proposal.label })), {
        ...(sections.answerKey ? { answerKey: sections.answerKey } : {}),
        ...(patterns ? { patterns } : {}),
        ...(itemPatterns ? { itemPatterns } : {}),
      });
    }
    const solutionMap = new Map<string, readonly Region[]>();
    for (const answer of solutions?.sections.flatMap((section) => section.answers) ?? []) solutionMap.set(answer.exercise, answer.regions);
    const existing = new Set(session.project.frames.map((frame) => frame.id));
    const fresh = proposals.filter((proposal) => !existing.has(proposal.id));
    const skipped = proposals.filter((proposal) => existing.has(proposal.id)).map((proposal) => proposal.id);
    const operations = exercisesToOperations(fresh, solutionMap);
    const opsFile = stringOption(context.options, 'ops');
    if (opsFile !== undefined) await writeFile(resolve(context.io.cwd, opsFile), `${JSON.stringify({ operations }, null, 2)}\n`);
    const detailsFile = stringOption(context.options, 'details');
    const summaries = exercises.sections.map((section) => summarize(section, solutions));
    const counts = { sections: exercises.sections.length, exercises: proposals.length, withSolution: solutionMap.size };
    const notes = [...sections.notes, ...exercises.notes, ...(solutions?.notes ?? [])];
    const result = {
      source: sections.source,
      sections: summaries,
      counts,
      ...(proposals.length <= 300 ? { proposals } : { proposalsOmitted: proposals.length }),
      ...(operations.length <= 300 ? { operations } : { operationsOmitted: operations.length }),
      skipped,
      notes,
      applied: false,
    };
    if (detailsFile !== undefined) await writeFile(resolve(context.io.cwd, detailsFile), `${JSON.stringify({ ...result, proposals, solutions: solutions ?? null, sectionsDetail: exercises.sections }, null, 1)}\n`);
    const anomalies = exercises.sections.flatMap((section) => section.notes.map((note) => `${section.section}: ${note}`));
    const head = `${plural(proposals.length, 'exercise')} proposed in ${plural(exercises.sections.length, 'section')}${wantSolutions ? `, ${plural(solutionMap.size, 'with a solution', 'with a solution')}` : ''}${skipped.length > 0 ? `; ${plural(skipped.length, 'is', 'are')} already in the project and left out` : ''}. Nothing is written unless you say --apply.`;
    const text = [
      head,
      table(exercises.sections.map((section) => sectionRow(section, solutions)), ['section', 'items', 'numbers', 'pages', 'instr', ...(solutions ? ['answers'] : []), 'title']),
      ...(anomalies.length > 0 ? ['To look at:', ...anomalies.slice(0, 40).map((line) => `  - ${line}`), ...(anomalies.length > 40 ? [`  ... and ${anomalies.length - 40} more (JSON: sections[].notes)`] : [])] : []),
      ...(sections.notes.length > 0 ? sections.notes.map((note) => note) : []),
      ...(opsFile !== undefined ? [`Wrote ${plural(operations.length, 'operation')} to ${opsFile}; apply them with \`mcprep frames apply ${opsFile}\`.`] : []),
      ...(detailsFile !== undefined ? [`Wrote the details to ${detailsFile}.`] : []),
    ].join('\n');
    if (flag(context.options, 'apply')) {
      if (sections.source === 'derived') {
        throw new McPrepError('E_NO_SECTIONS', 'The exercises refer to sections by id, and the project has no outline with ids yet.', {
          hint: 'Store the sections first: `mcprep outline derive --book --apply` (look at them, edit if needed), then run this again.',
        });
      }
      if (operations.length === 0) return { result: { ...result, applied: false }, text: `${text}\nNothing to apply.`, notes };
      await assertAuthoritySupported(session, operations as Operation[]);
      const done = await applyAndReport(context, operations as Operation[], `applied ${plural(operations.length, 'exercise')}`);
      return { ...done, result: { ...result, applied: true, ...(done.result as object) }, text: `${text}\n${done.text}`, notes };
    }
    return { result, text, notes };
  },
};

async function withInk(loaded: Loaded, ink: ReadonlySet<number>): Promise<Loaded> {
  const pdf = await loaded.session.document();
  const pages = [...loaded.pages];
  for (const page of ink) {
    const current = pages[page];
    if (current && current.ink === undefined) pages[page] = { ...current, ink: await pdf.inkProfile(page) };
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
    ...(solved ? { answers: solved.answers.length, withoutAnswer: solved.withoutAnswer, withoutExercise: solved.withoutExercise } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// solutions propose

export const solutionsPropose: CommandSpec = {
  name: 'solutions propose',
  summary: 'Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.',
  description:
    'The answer key is cut into bands by the section markers and headers (a band runs across all columns and over page breaks); inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; exercises without an answer and answers without an exercise are reported. `--ops` writes `solution.add` operations (one per region) for `frames apply`; `--apply` applies them. An exercise that already has a solution is left alone. The solution is hidden: it is never shown with the exercise, never sent to a tutor, used only to grade.',
  writes: true,
  options: [
    { name: 'ops', type: 'string', value: '<file>', description: 'Write the operations as a JSON batch (for `frames apply`).' },
    { name: 'details', type: 'string', value: '<file>', description: 'Write everything (every answer with its evidence, the sequences, the headers) as JSON.' },
    { name: 'apply', type: 'boolean', description: 'Apply the solutions to the project now (one atomic batch).' },
    ITEM_PATTERN_OPTION,
    ...BOOK_WORD_OPTIONS,
    ...GLOBAL_OPTIONS,
  ],
  examples: ['mcprep solutions propose', 'mcprep solutions propose --ops solutions.json', 'mcprep solutions propose --apply'],
  output:
    '{ sections: [{ section, label, title, answers, first, last, gaps, duplicates, withoutAnswer, withoutExercise, headers, notes }], counts: { exercises, answers, matched, withoutAnswer, withoutExercise }, operations? (when there are at most 300; else operationsOmitted: n and the --ops file), skipped: string[], notes, applied }',
  async run(context) {
    const first = await load(context);
    const patterns = patternsFrom(context.options);
    const itemPatterns = itemPatternsFrom(context.options);
    const sections = sectionsFor(first.session, first.pages, patterns);
    const frames = first.session.project.frames.filter((frame): frame is Frame & { section: string; label: string } => frame.authority === 'book' && frame.section !== undefined && frame.label !== undefined);
    const needInk = new Set<number>();
    if (sections.answerKey) for (let page = sections.answerKey.page; page < first.pages.length; page += 1) needInk.add(page);
    const { session, pages } = needInk.size > 0 ? await withInk(first, needInk) : first;
    const solutions = proposeSolutions(pages, sections.entries, frames.map((frame) => ({ section: frame.section, label: frame.label })), {
      ...(sections.answerKey ? { answerKey: sections.answerKey } : {}),
      ...(patterns ? { patterns } : {}),
      ...(itemPatterns ? { itemPatterns } : {}),
    });
    const byKey = new Map(frames.map((frame) => [`${frame.section}\u0000${frame.label}`, frame]));
    const operations: Operation[] = [];
    const skipped: string[] = [];
    let matched = 0;
    for (const answer of solutions.sections.flatMap((section) => section.answers)) {
      const frame = byKey.get(`${answer.section}\u0000${answer.label}`);
      if (!frame) continue;
      matched += 1;
      if (frame.solution && frame.solution.length > 0) {
        skipped.push(frame.id);
        continue;
      }
      for (const region of answer.regions) operations.push({ op: 'solution.add', id: frame.id, page: region.page, rect: box(region.rect) } as unknown as Operation);
    }
    const opsFile = stringOption(context.options, 'ops');
    if (opsFile !== undefined) await writeFile(resolve(context.io.cwd, opsFile), `${JSON.stringify({ operations }, null, 2)}\n`);
    const detailsFile = stringOption(context.options, 'details');
    if (detailsFile !== undefined) await writeFile(resolve(context.io.cwd, detailsFile), `${JSON.stringify(solutions, null, 1)}\n`);
    const withoutAnswer = solutions.sections.reduce((sum, section) => sum + section.withoutAnswer.length, 0);
    const withoutExercise = solutions.sections.reduce((sum, section) => sum + section.withoutExercise.length, 0);
    const counts = { exercises: frames.length, answers: solutions.sections.reduce((sum, section) => sum + section.answers.length, 0), matched, withoutAnswer, withoutExercise };
    const notes = [...(frames.length === 0 ? ['The project has no authoritative exercises yet: propose them first (`mcprep exercises propose --apply`), or use `exercises propose --solutions` to do both at once.'] : []), ...solutions.notes];
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
        notes: section.notes,
      })),
      counts,
      ...(operations.length <= 300 ? { operations } : { operationsOmitted: operations.length }),
      skipped,
      notes,
      applied: false,
    };
    const anomalies = solutions.sections.flatMap((section) => section.notes.map((note) => `${section.section}: ${note}`));
    const text = [
      `${plural(counts.answers, 'answer')} found in the answer key (pages ${solutions.key?.firstPage ?? '?'}-${solutions.key?.lastPage ?? '?'}); ${plural(matched, 'is', 'are')} matched to an exercise of the project, ${plural(withoutAnswer, 'exercise')} without an answer, ${plural(withoutExercise, 'answer')} without an exercise${skipped.length > 0 ? `, ${plural(skipped.length, 'exercise')} already ${skipped.length === 1 ? 'has' : 'have'} a solution` : ''}. Nothing is written unless you say --apply.`,
      table(
        solutions.sections.map((section) => [section.section, String(section.answers.length), section.first !== undefined ? `${section.first}..${section.last as string}` : '', String(section.withoutAnswer.length), String(section.withoutExercise.length), section.title]),
        ['section', 'answers', 'numbers', 'no answer', 'no exercise', 'title'],
      ),
      ...(anomalies.length > 0 ? ['To look at:', ...anomalies.slice(0, 40).map((line) => `  - ${line}`), ...(anomalies.length > 40 ? [`  ... and ${anomalies.length - 40} more (JSON: sections[].notes)`] : [])] : []),
      ...notes.filter((note) => !solutions.notes.includes(note)).map((note) => note),
      ...solutions.notes,
      ...(opsFile !== undefined ? [`Wrote ${plural(operations.length, 'operation')} to ${opsFile}; apply them with \`mcprep frames apply ${opsFile}\`.`] : []),
    ].join('\n');
    if (flag(context.options, 'apply')) {
      if (operations.length === 0) return { result, text: `${text}\nNothing to apply.`, notes };
      const probe = operations[0] as unknown as { id: string };
      const outcome = await session.apply([probe as unknown as Operation], { modifiedBy: 'cli', dryRun: true, force: true });
      const target = outcome.project.frames.find((frame) => frame.id === probe.id);
      if (!target || (target.solution?.length ?? 0) === 0) {
        throw new McPrepError('E_UNSUPPORTED', 'This build of Math Canvas Prep cannot write solution regions (no solution.add operation).', { hint: 'Use a build with solution context, or write the operations with --ops and apply them later.' });
      }
      const done = await applyAndReport(context, operations, `applied ${plural(operations.length, 'solution region')}`);
      return { ...done, result: { ...result, applied: true, ...(done.result as object) }, text: `${text}\n${done.text}`, notes };
    }
    return { result, text, notes };
  },
};
