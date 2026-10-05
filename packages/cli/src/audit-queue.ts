import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { checkDocumentInfo, checkTitle, cleanFolder, folderFromInput, titleFromFileName, type DocumentInfo } from '@mcprep/core';

/**
 * Auditing several books in one go (`scripts/audit-books.mjs`): which books there are and what is known about each (a
 * folder of PDFs with an optional `<name>.meta.json` beside each, or a queue file), the arguments that
 * `scripts/acceptance-book.mjs` is run with for each, and the `INDEX.md` that sums the results up. The scripts are thin;
 * what can be wrong with a sidecar, and what the index says, is decided here and tested.
 *
 * Nothing here reads a licence, an author or a notice out of a book: they are what the person wrote into the sidecar.
 * They are optional: a book without them is processed like any other, and the index mentions it in one line.
 */

export interface BookOptions {
  chapterWords?: string[];
  practiceWords?: string[];
  answerWords?: string[];
  stopWords?: string[];
  itemWords?: string[];
  backWords?: string[];
  /** Regular expressions (group 1: the section label) for the lines of an answer key that mark where the answers of a section start. */
  answerMarkers?: string[];
  itemPattern?: string[];
  instructions?: 'bold' | 'margin' | 'auto' | 'none';
}

/** What is known about a book besides its pages. */
export interface BookFacts {
  title: string;
  /** The folder of the library the document is filed in. */
  folder: string;
  /** Author, series, description, licence, source address and notice: only what the sidecar says. */
  info: DocumentInfo;
  options: BookOptions;
  maxItems?: number;
  /** Absolute path of a list of the book's sections and exercise counts to compare with. */
  reference?: string;
  referenceChapterOffset?: number;
}

export interface QueuedBook extends BookFacts {
  name: string;
  /** Absolute path of the PDF. */
  pdf: string;
}

export interface QueueProblem {
  name: string;
  message: string;
}

export interface Queue {
  source: string;
  mode: 'folder' | 'queue';
  books: QueuedBook[];
  /** Books that cannot be processed as they are written (they are listed in the index as not run). */
  problems: QueueProblem[];
  /** Things worth knowing that do not stop a book (a sidecar without a PDF). */
  warnings: string[];
}

export const DEFAULT_LIBRARY_FOLDER = 'Books';

const FACT_KEYS = ['title', 'author', 'series', 'description', 'license', 'sourceUrl', 'notice', 'folder', 'options', 'maxItems', 'reference', 'referenceChapterOffset'] as const;
const QUEUE_KEYS = [...FACT_KEYS, 'pdf', 'name'] as const;
const OPTION_KEYS = ['chapterWords', 'practiceWords', 'answerWords', 'stopWords', 'itemWords', 'backWords', 'answerMarkers', 'itemPattern', 'instructions'] as const;
const INSTRUCTION_MODES = ['bold', 'margin', 'auto', 'none'] as const;

/** Spellings that people write and that would otherwise be dropped without a word. */
const HINTS: Record<string, string> = {
  licence: 'license',
  licenses: 'license',
  licensename: 'license',
  licencename: 'license',
  licenseurl: 'license',
  source: 'sourceUrl',
  sourceurl: 'sourceUrl',
  source_url: 'sourceUrl',
  url: 'sourceUrl',
  itempattern: 'options.itemPattern',
  itempatterns: 'options.itemPattern',
  chapterwords: 'options.chapterWords',
  practicewords: 'options.practiceWords',
  answerwords: 'options.answerWords',
  stopwords: 'options.stopWords',
  itemwords: 'options.itemWords',
  backwords: 'options.backWords',
  answermarkers: 'options.answerMarkers',
  answermarker: 'options.answerMarkers',
  instructions: 'options.instructions',
  maxitems: 'maxItems',
  max_items: 'maxItems',
  referencechapteroffset: 'referenceChapterOffset',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function unknownKey(key: string, allowed: readonly string[], where: string): string {
  const folded = key.toLowerCase();
  const exact = allowed.find((candidate) => candidate.toLowerCase() === folded);
  const hint = exact ?? HINTS[folded];
  return `${where}: unknown field "${key}"${hint !== undefined ? ` (did you mean "${hint}"?)` : ''}; the fields are ${allowed.join(', ')}.`;
}

/** A list of words written as an array or as one comma separated text. */
function words(raw: unknown, where: string, problems: string[]): string[] | undefined {
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : undefined;
  if (list === undefined || list.some((entry) => typeof entry !== 'string')) {
    problems.push(`${where} must be a list of words (or one text with commas).`);
    return undefined;
  }
  const cleaned = (list as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (cleaned.length === 0) {
    problems.push(`${where} needs at least one word.`);
    return undefined;
  }
  return cleaned;
}

/** Whether a text is a regular expression with a group for the label (group 1), as `--item-pattern` needs. */
export function itemPatternProblem(source: string): string | undefined {
  try {
    new RegExp(source, 'u');
    // How many capture groups the expression has: an empty alternative always matches and shows them.
    const groups = (new RegExp(`${source}|`, 'u').exec('') as RegExpExecArray).length - 1;
    return groups < 1 ? 'it has no group for the label' : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function parseOptions(raw: unknown, where: string, problems: string[]): BookOptions {
  const options: BookOptions = {};
  if (raw === undefined || raw === null) return options;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object.`);
    return options;
  }
  for (const key of Object.keys(raw)) if (!(OPTION_KEYS as readonly string[]).includes(key)) problems.push(unknownKey(key, OPTION_KEYS, where));
  for (const key of ['chapterWords', 'practiceWords', 'answerWords', 'stopWords', 'itemWords', 'backWords'] as const) {
    if (raw[key] === undefined) continue;
    const list = words(raw[key], `${where}.${key}`, problems);
    if (list) options[key] = list;
  }
  if (raw['answerMarkers'] !== undefined) {
    const list = words(typeof raw['answerMarkers'] === 'string' ? [raw['answerMarkers']] : raw['answerMarkers'], `${where}.answerMarkers`, problems);
    if (list) {
      const bad = list.map((source) => ({ source, problem: itemPatternProblem(source) })).filter((entry) => entry.problem !== undefined);
      for (const entry of bad) problems.push(`${where}.answerMarkers "${entry.source}" is not usable: ${entry.problem as string}. It must be a regular expression with a group for the label of the section (group 1).`);
      if (bad.length === 0) options.answerMarkers = list;
    }
  }
  if (raw['itemPattern'] !== undefined) {
    const list = words(typeof raw['itemPattern'] === 'string' ? [raw['itemPattern']] : raw['itemPattern'], `${where}.itemPattern`, problems);
    if (list) {
      const bad = list.map((source) => ({ source, problem: itemPatternProblem(source) })).filter((entry) => entry.problem !== undefined);
      for (const entry of bad) problems.push(`${where}.itemPattern "${entry.source}" is not usable: ${entry.problem as string}. It must be a regular expression with a group for the label (group 1).`);
      if (bad.length === 0) options.itemPattern = list;
    }
  }
  if (raw['instructions'] !== undefined) {
    const mode = raw['instructions'];
    if (typeof mode === 'string' && (INSTRUCTION_MODES as readonly string[]).includes(mode)) options.instructions = mode as BookOptions['instructions'];
    else problems.push(`${where}.instructions must be one of ${INSTRUCTION_MODES.join(', ')}.`);
  }
  return options;
}

function whole(raw: unknown, where: string, min: number, max: number, problems: string[]): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    problems.push(`${where} must be a whole number from ${min} to ${max}.`);
    return undefined;
  }
  return raw;
}

/** The names of books become folder and file names: no path separators or characters that Windows refuses. */
export function nameProblem(name: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > 80 || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..' || name !== name.trim() || name.endsWith('.')) {
    return `"${name.slice(0, 40)}" cannot be used as the name of a book: 1 to 80 characters, no / \\ : * ? " < > |, no space or dot at the end.`;
  }
  return undefined;
}

export interface ParseContext {
  /** The name of the book (the stem of the PDF, or the name a queue gives). */
  name: string;
  /** The folder paths in the entry are relative to. */
  baseDir: string;
  /** Where the facts were written, for messages. */
  where: string;
  /** Fields of a queue entry (`pdf`, `name`) are allowed too. */
  queue?: boolean;
}

/** The facts of a sidecar or of a queue entry, checked: what the document may say about itself is what `book meta` accepts. */
export function parseFacts(raw: unknown, context: ParseContext): { facts?: BookFacts; problems: string[] } {
  const problems: string[] = [];
  const where = context.where;
  if (raw === undefined) raw = {};
  if (!isRecord(raw)) return { problems: [`${where} must be a JSON object.`] };
  const allowed: readonly string[] = context.queue ? QUEUE_KEYS : FACT_KEYS;
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) problems.push(unknownKey(key, allowed, where));

  let title = titleFromFileName(context.name);
  if (raw['title'] !== undefined) {
    const checked = typeof raw['title'] === 'string' ? checkTitle(raw['title']) : { problem: 'The title must be a text.' };
    if (checked.title !== undefined) title = checked.title;
    else problems.push(`${where}.title: ${checked.problem ?? 'cannot be used.'}`);
  }

  let folder = DEFAULT_LIBRARY_FOLDER;
  if (raw['folder'] !== undefined) {
    if (typeof raw['folder'] !== 'string') problems.push(`${where}.folder must be a text such as "Books/Algebra".`);
    else {
      const cleaned = cleanFolder(folderFromInput(raw['folder']));
      if (cleaned.folder === undefined) problems.push(`${where}.folder is empty: leave it out for "${DEFAULT_LIBRARY_FOLDER}".`);
      else folder = cleaned.folder;
    }
  }

  const infoRaw: Record<string, unknown> = {};
  for (const key of ['author', 'series', 'description', 'notice', 'sourceUrl', 'license'] as const) if (raw[key] !== undefined) infoRaw[key] = raw[key];
  const checked = checkDocumentInfo(infoRaw, { strict: true, where });
  for (const entry of checked.issues) if (entry.severity === 'error') problems.push(entry.message);

  const options = parseOptions(raw['options'], `${where}.options`, problems);
  const maxItems = whole(raw['maxItems'], `${where}.maxItems`, 1, 100_000, problems);
  const offset = whole(raw['referenceChapterOffset'], `${where}.referenceChapterOffset`, -50, 50, problems);
  let reference: string | undefined;
  if (raw['reference'] !== undefined) {
    if (typeof raw['reference'] !== 'string' || raw['reference'].trim() === '') problems.push(`${where}.reference must be the path of a JSON file.`);
    else reference = isAbsolute(raw['reference']) ? raw['reference'] : resolve(context.baseDir, raw['reference']);
  }
  if (offset !== undefined && reference === undefined) problems.push(`${where}.referenceChapterOffset needs a reference.`);
  if (problems.length > 0) return { problems };
  return {
    facts: {
      title,
      folder,
      info: checked.info,
      options,
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(reference !== undefined ? { reference } : {}),
      ...(offset !== undefined ? { referenceChapterOffset: offset } : {}),
    },
    problems,
  };
}

/** Whether the sidecar names a licence. It is optional: this only decides what the licence column of the index shows. */
export const licenseStated = (facts: Pick<BookFacts, 'info'>): boolean => (facts.info.license?.name ?? '').trim().length > 0;

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );
}

async function readJson(path: string): Promise<{ value?: unknown; problem?: string }> {
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (error) {
    return { problem: `${basename(path)} cannot be read: ${(error as Error).message}` };
  }
}

/** Checks the paths a book points at (its PDF and its reference), after its facts were accepted. */
async function withFiles(book: QueuedBook): Promise<string[]> {
  const problems: string[] = [];
  if (!(await fileExists(book.pdf))) problems.push(`The PDF ${book.pdf} does not exist.`);
  else if (extname(book.pdf).toLowerCase() !== '.pdf') problems.push(`${book.pdf} is not a PDF (its name should end with .pdf).`);
  if (book.reference !== undefined && !(await fileExists(book.reference))) problems.push(`The reference ${book.reference} does not exist.`);
  return problems;
}

function addBook(queue: Queue, seen: Map<string, string>, book: QueuedBook, problems: string[]): void {
  const folded = book.name.toLowerCase();
  const earlier = seen.get(folded);
  if (earlier !== undefined) problems.push(`The name "${book.name}" is already used by ${earlier}: names must differ (also in upper and lower case) because each book gets a folder of its own.`);
  if (problems.length > 0) {
    queue.problems.push({ name: book.name, message: problems.join(' ') });
    return;
  }
  seen.set(folded, book.pdf);
  queue.books.push(book);
}

/** Every `*.pdf` of a folder (not the folders in it) is a book; `<name>.meta.json` beside it says what is known about it. */
export async function loadFolderQueue(folder: string): Promise<Queue> {
  const dir = resolve(folder);
  const queue: Queue = { source: dir, mode: 'folder', books: [], problems: [], warnings: [] };
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name);
  const pdfs = entries.filter((name) => extname(name).toLowerCase() === '.pdf').sort((a, b) => a.localeCompare(b));
  const stems = new Set(pdfs.map((name) => basename(name, extname(name)).toLowerCase()));
  for (const entry of entries) {
    const match = /^(.*)\.meta\.json$/i.exec(entry);
    if (match && !stems.has((match[1] as string).toLowerCase())) queue.warnings.push(`${entry} has no PDF beside it (${match[1] as string}.pdf): it is not used.`);
  }
  const seen = new Map<string, string>();
  for (const file of pdfs) {
    const name = basename(file, extname(file));
    const problems: string[] = [];
    const bad = nameProblem(name);
    if (bad) problems.push(bad);
    const sidecarName = entries.find((entry) => entry.toLowerCase() === `${name.toLowerCase()}.meta.json`);
    let raw: unknown;
    if (sidecarName !== undefined) {
      const read = await readJson(join(dir, sidecarName));
      if (read.problem) problems.push(read.problem);
      else raw = read.value;
    }
    const parsed = bad || (sidecarName !== undefined && raw === undefined) ? { problems: [] as string[] } : parseFacts(raw, { name, baseDir: dir, where: sidecarName ?? 'the book' });
    problems.push(...parsed.problems);
    const book: QueuedBook = { name, pdf: join(dir, file), ...(parsed.facts ?? { title: titleFromFileName(name), folder: DEFAULT_LIBRARY_FOLDER, info: {}, options: {} }) };
    if (parsed.facts) problems.push(...(await withFiles(book)));
    addBook(queue, seen, book, problems);
  }
  if (pdfs.length === 0) queue.warnings.push(`There is no PDF in ${dir}.`);
  return queue;
}

/** A queue file: `{ "books": [ { "pdf": "relative/or/absolute.pdf", "name"?: ..., the fields of a sidecar } ] }`. */
export async function loadQueueFile(file: string): Promise<Queue> {
  const path = resolve(file);
  const dir = dirname(path);
  const queue: Queue = { source: path, mode: 'queue', books: [], problems: [], warnings: [] };
  const read = await readJson(path);
  if (read.problem) {
    queue.problems.push({ name: basename(path), message: read.problem });
    return queue;
  }
  const list = isRecord(read.value) ? read.value['books'] : undefined;
  if (!Array.isArray(list)) {
    queue.problems.push({ name: basename(path), message: 'A queue is a JSON object with a list of books: { "books": [ { "pdf": "book.pdf" } ] }.' });
    return queue;
  }
  if (isRecord(read.value)) for (const key of Object.keys(read.value)) if (key !== 'books') queue.warnings.push(`The field "${key}" of the queue is not used.`);
  const seen = new Map<string, string>();
  for (const [index, entry] of list.entries()) {
    const where = `books[${index}]`;
    if (!isRecord(entry) || typeof entry['pdf'] !== 'string' || entry['pdf'].trim() === '') {
      queue.problems.push({ name: where, message: `${where} needs a "pdf": the path of the PDF, relative to the queue file or absolute.` });
      continue;
    }
    const pdf = isAbsolute(entry['pdf']) ? entry['pdf'] : resolve(dir, entry['pdf']);
    const name = typeof entry['name'] === 'string' ? entry['name'] : basename(pdf, extname(pdf));
    const problems: string[] = [];
    const bad = nameProblem(name);
    if (bad) problems.push(bad);
    const parsed = bad ? { problems: [] as string[] } : parseFacts(entry, { name, baseDir: dir, where: `${where} (${name})`, queue: true });
    problems.push(...parsed.problems);
    const book: QueuedBook = { name, pdf, ...(parsed.facts ?? { title: titleFromFileName(name), folder: DEFAULT_LIBRARY_FOLDER, info: {}, options: {} }) };
    if (parsed.facts) problems.push(...(await withFiles(book)));
    addBook(queue, seen, book, problems);
  }
  if (list.length === 0) queue.warnings.push('The queue has no books.');
  return queue;
}

/** A folder of PDFs, or a queue file. */
export async function loadQueue(path: string): Promise<Queue> {
  const target = resolve(path);
  const entry = await stat(target).catch(() => undefined);
  if (!entry) return { source: target, mode: 'folder', books: [], problems: [{ name: basename(target), message: `${target} does not exist.` }], warnings: [] };
  return entry.isDirectory() ? loadFolderQueue(target) : loadQueueFile(target);
}

export interface AcceptanceRun {
  /** The folder the results of this book go to. */
  outDir: string;
  /** Contact sheet and crop sample sizes (`--sample`), when the person asked for fewer or more. */
  sample?: number;
}

/** The arguments `scripts/acceptance-book.mjs` is run with for a book (after the script's own path). */
export function acceptanceArguments(book: QueuedBook, run: AcceptanceRun): string[] {
  const args = [book.pdf, ...(book.reference !== undefined ? [book.reference] : []), '--out', run.outDir, '--name', book.name, '--title', book.title, '--folder', book.folder];
  const info = book.info;
  if (info.author !== undefined) args.push('--author', info.author);
  if (info.series !== undefined) args.push('--series', info.series);
  if (info.description !== undefined) args.push('--description', info.description);
  if (info.license !== undefined) args.push('--license-name', info.license.name, ...(info.license.url !== undefined ? ['--license-url', info.license.url] : []));
  if (info.sourceUrl !== undefined) args.push('--source-url', info.sourceUrl);
  if (info.notice !== undefined) args.push('--notice', info.notice);
  if (book.referenceChapterOffset !== undefined) args.push('--reference-chapter-offset', String(book.referenceChapterOffset));
  if (book.maxItems !== undefined) args.push('--max-items', String(book.maxItems));
  const options = book.options;
  if (options.chapterWords) args.push('--chapter-words', options.chapterWords.join(','));
  if (options.practiceWords) args.push('--practice-words', options.practiceWords.join(','));
  if (options.answerWords) args.push('--answer-words', options.answerWords.join(','));
  if (options.stopWords) args.push('--stop-words', options.stopWords.join(','));
  if (options.itemWords) args.push('--item-words', options.itemWords.join(','));
  if (options.backWords) args.push('--back-words', options.backWords.join(','));
  for (const marker of options.answerMarkers ?? []) args.push('--answer-marker', marker);
  for (const pattern of options.itemPattern ?? []) args.push('--item-pattern', pattern);
  if (options.instructions) args.push('--instructions', options.instructions);
  if (run.sample !== undefined) args.push('--sample', String(run.sample), '--solution-sample', String(Math.max(1, Math.ceil(run.sample / 2))));
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the acceptance script writes about a book (acceptance-summary.json), and the index of all the books

/** One suggestion for a fact, read from the front matter of the PDF. It is shown to a person and never written anywhere by itself. */
export interface FrontMatterSuggestion {
  field: 'license.name' | 'license.url' | 'author' | 'warning';
  value: string;
  page: number;
  evidence: string;
}

export interface AcceptanceSummary {
  name: string;
  title: string;
  pages: number;
  chapters: number;
  sections: number;
  exercises: number;
  withSolution: number;
  withoutAnswer: number;
  answersWithoutExercise: number;
  validation: { ok: boolean; errors: number; warnings: number };
  /**
   * The text check `exercises verify`: null when it did not run; absent in a summary written before it existed. The answers in the key of
   * the exercises that the cap (`maxItems`) left out are not counted (`answersBeyondTheCap` says how many they are).
   */
  verify?: { errors: number; warnings: number; infos: number; byCode: Record<string, number>; answersBeyondTheCap?: number } | null;
  /** Null when the bundle could not be written. */
  importCheck: { wouldImport: boolean } | null;
  /** True when applying the same proposals a second time changed nothing. */
  idempotent: boolean;
  license: { name: string; url?: string } | null;
  licenseStated: boolean;
  author: string | null;
  suggestions: FrontMatterSuggestion[];
  reference: {
    sections: number;
    found: number;
    missing: string[];
    extra: string[];
    equalCounts: number;
    countDifferences: { label: string; title: string; reference: number; found: number }[];
    titleDifferences: number;
    totalReference: number;
    totalFound: number;
  } | null;
  edgesOnInk: number;
  regions: number;
  toLookAt: string[];
  /** Paths relative to the folder of the results of the book. */
  files: { project: string; bundle: string | null; report: string; details: string; verify?: string | null; sheets: string; crops: string };
  seconds: number;
}

/** What `acceptance-summary.json` must hold at least; anything else is an error of the script that wrote it. */
export function parseSummary(raw: unknown): { summary?: AcceptanceSummary; problem?: string } {
  if (!isRecord(raw)) return { problem: 'The summary is not a JSON object.' };
  const numbers = ['pages', 'chapters', 'sections', 'exercises', 'withSolution', 'withoutAnswer', 'answersWithoutExercise', 'edgesOnInk', 'regions', 'seconds'];
  for (const key of numbers) if (typeof raw[key] !== 'number') return { problem: `The summary has no number "${key}".` };
  if (typeof raw['name'] !== 'string' || typeof raw['title'] !== 'string') return { problem: 'The summary has no name and title.' };
  if (!isRecord(raw['validation']) || !isRecord(raw['files'])) return { problem: 'The summary has no validation and no files.' };
  if (!Array.isArray(raw['toLookAt']) || !Array.isArray(raw['suggestions'])) return { problem: 'The summary has no toLookAt and suggestions lists.' };
  return { summary: raw as unknown as AcceptanceSummary };
}

/**
 * Findings of the form "1.2: no practice heading found" that are the same for many sections become one line that names the
 * sections ("no practice heading found (97 sections: 1.1, 1.2, ...)"): a book that the tool does not read the way it was
 * written would otherwise fill the index with one line per section. Everything else stays as it is, in its order.
 */
export function groupFindings(findings: readonly string[], minimum = 4): string[] {
  const groups = new Map<string, string[]>();
  for (const finding of findings) {
    const match = /^([\w.-]{1,24}): (.+)$/.exec(finding);
    if (!match) continue;
    const labels = groups.get(match[2] as string) ?? [];
    labels.push(match[1] as string);
    groups.set(match[2] as string, labels);
  }
  const out: string[] = [];
  const done = new Set<string>();
  for (const finding of findings) {
    const match = /^([\w.-]{1,24}): (.+)$/.exec(finding);
    const labels = match ? groups.get(match[2] as string) : undefined;
    if (!match || !labels || labels.length < minimum) {
      out.push(finding);
      continue;
    }
    if (done.has(match[2] as string)) continue;
    done.add(match[2] as string);
    out.push(`${match[2] as string} (${labels.length} sections: ${labels.slice(0, 6).join(', ')}${labels.length > 6 ? ', ...' : ''})`);
  }
  return out;
}

export interface IndexRow {
  name: string;
  /** `ok`: the book was audited; `failed`: the script stopped or its summary is missing; `not run`: the sidecar or the queue entry is wrong. */
  status: 'ok' | 'failed' | 'not run';
  reason?: string;
  summary?: AcceptanceSummary;
  /** Wall-clock seconds of the run (also of a failed one). */
  seconds: number;
  /** Relative paths of the log and of the folder of the results. */
  folder: string;
  /** What the book's facts said about the licence, for a book that has no summary; undefined when it is not known (not run). */
  licenseStated?: boolean;
}

export function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`;
}

/** A name as a person types it after `--only`: in quotes when it has a space. */
const quoted = (name: string): string => (/[\s"]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name);
const percent = (part: number, total: number): string => (total === 0 ? 'n/a' : `${Math.round((10000 * part) / total) / 100} %`);
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const link = (label: string, path: string | null, folder: string): string => (path === null ? '' : `[${label}](${`${folder}/${path}`.replace(/ /g, '%20')})`);

function referenceCell(summary: AcceptanceSummary): string {
  const reference = summary.reference;
  if (!reference) return 'no reference';
  const problems = [
    reference.missing.length > 0 ? `${reference.missing.length} section${reference.missing.length === 1 ? '' : 's'} missing` : '',
    reference.extra.length > 0 ? `${reference.extra.length} extra` : '',
    reference.countDifferences.length > 0 ? `${reference.countDifferences.length} count${reference.countDifferences.length === 1 ? ' differs' : 's differ'}` : '',
    reference.titleDifferences > 0 ? `${reference.titleDifferences} title${reference.titleDifferences === 1 ? ' differs' : 's differ'}` : '',
  ].filter(Boolean);
  const base = `${reference.equalCounts} of ${reference.sections} sections equal`;
  return problems.length === 0 ? `${base}; no differences` : `${base}; ${problems.join(', ')}`;
}

export interface IndexInput {
  generatedAt: Date;
  source: string;
  outDir: string;
  rows: IndexRow[];
  /** Warnings of the queue (a sidecar without a PDF). */
  warnings?: string[];
}

/** The `INDEX.md` of a batch: a table with one row per book, what to look at for each, and what to do next. */
export function indexMarkdown(input: IndexInput): string {
  const { rows } = input;
  const audited = rows.filter((row) => row.status === 'ok').length;
  const unlicensed = rows.filter((row) => row.status === 'ok' && row.licenseStated === false);
  const lines: string[] = [];
  lines.push('# Books audited', '');
  lines.push(
    `${input.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. ${rows.length} book${rows.length === 1 ? '' : 's'} from ${input.source}: ${audited} audited${rows.length - audited > 0 ? `, ${rows.length - audited} not` : ''}. ` +
      'Every row says what the tool found; the tool proposes and you look.',
    '',
  );
  lines.push(
    `Author, licence and notice are optional (the sidecar \`<name>.meta.json\` can say them${unlicensed.length > 0 ? `; none stated for ${unlicensed.map((row) => row.name).join(', ')}` : ''}). A bundle contains the whole book: keep it private. Nothing is uploaded.`,
    '',
  );
  for (const warning of input.warnings ?? []) lines.push(`- ${warning}`);
  if ((input.warnings ?? []).length > 0) lines.push('');
  lines.push('| book | pages | chapters | sections | exercises | with answer | validation | text check | importer | licence | against the reference | time | files |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const summary = row.summary;
    if (row.status !== 'ok' || !summary) {
      lines.push(`| ${cell(row.name)} |  |  |  |  |  |  |  |  | ${row.licenseStated === true ? 'stated' : ''} |  | ${formatSeconds(row.seconds)} | **${row.status === 'not run' ? 'NOT RUN' : 'FAILED'}**: ${cell(row.reason ?? 'see the log')} ${link('log', row.status === 'not run' ? null : 'run.log', row.folder)} |`);
      continue;
    }
    const validation = `${summary.validation.ok ? 'ok' : '**errors**'}: ${summary.validation.errors} error${summary.validation.errors === 1 ? '' : 's'}, ${summary.validation.warnings} warning${summary.validation.warnings === 1 ? '' : 's'}`;
    const check = summary.verify ? `${summary.verify.errors === 0 ? 'ok' : '**errors**'}: ${summary.verify.errors} error${summary.verify.errors === 1 ? '' : 's'}, ${summary.verify.warnings} warning${summary.verify.warnings === 1 ? '' : 's'}` : summary.verify === null ? 'did not run' : '';
    const importer = summary.importCheck === null ? '**no bundle**' : summary.importCheck.wouldImport ? 'accepts' : '**rejects**';
    const licence = summary.licenseStated ? cell(summary.license?.name ?? '') : '';
    lines.push(
      `| ${cell(summary.name)} | ${summary.pages} | ${summary.chapters} | ${summary.sections} | ${summary.exercises} | ${summary.withSolution} (${percent(summary.withSolution, summary.exercises)}) | ${validation} | ${check} | ${importer} | ${licence} | ${cell(referenceCell(summary))} | ${formatSeconds(row.seconds)} | ${[
        link('bundle', summary.files.bundle, row.folder),
        link('project', summary.files.project, row.folder),
        link('report', summary.files.report, row.folder),
        link('sheets', summary.files.sheets, row.folder),
      ]
        .filter(Boolean)
        .join(' ')} |`,
    );
  }
  lines.push('');
  for (const row of rows) {
    lines.push(`## ${row.name}`, '');
    const summary = row.summary;
    if (row.status !== 'ok' || !summary) {
      lines.push(`${row.status === 'not run' ? 'Not run' : 'Failed'}: ${row.reason ?? 'see the log'}`, '');
      continue;
    }
    if (summary.suggestions.length > 0) {
      lines.push(`Read from the front matter of the PDF, as guesses (put what is right into \`${summary.name}.meta.json\` and run it again with \`--only ${quoted(summary.name)}\`; nothing was written into the bundle):`, '');
      for (const suggestion of summary.suggestions) lines.push(`- ${suggestion.field}: ${suggestion.field === 'warning' ? cell(suggestion.value) : `\`${cell(suggestion.value)}\``} (page ${suggestion.page + 1}: "${cell(suggestion.evidence).slice(0, 140)}")`);
      lines.push('');
    }
    if (summary.toLookAt.length === 0) lines.push('Nothing to look at beyond the contact sheets.', '');
    // The paths in the findings are relative to the folder of the book; the index lies one folder up.
    else lines.push('To look at:', '', ...summary.toLookAt.map((item) => `- ${item.replace(/\bcrops\//g, `${row.folder}/crops/`)}`), '');
  }
  lines.push(
    '## Next',
    '',
    '1. **Look.** Open the contact sheets of each book (`<name>/sheets/*.png`: red frame, orange continuation, blue instruction, green solution) and the points above; the report of each book (`<name>/acceptance-report.md`) has every difference with its pages.',
    '2. **Decide.** Caps per section (`maxItems`), the title, the library folder and, if you want them, the author, licence and notice go into the sidecar `<name>.meta.json`; run again with `--only <name>`: what is right stays as it is.',
    '3. **Use.** Copy the `.mcbundle` of a book you are happy with to the tablet and open it in the Math Canvas library.',
    '',
  );
  return lines.join('\n');
}


// ---------------------------------------------------------------------------------------------------------------------
// Suggestions from the front matter

const CC_WORDS: [RegExp, string][] = [
  [/non[- ]?commercial/i, 'nc'],
  [/share[- ]?alike/i, 'sa'],
  [/no[- ]?deriv(?:ative)?s?/i, 'nd'],
];

/** `by-nc-sa` and `4.0` as the short name of a Creative Commons licence: `CC BY-NC-SA 4.0`. */
function ccLabel(kind: string, version: string | undefined): string {
  return `CC ${kind.toUpperCase()}${version !== undefined ? ` ${version}` : ''}`;
}

/** A name without the full stop that closes the sentence it stood in (the dot of an initial inside the name stays). */
const trimName = (name: string): string => name.replace(/[.,;:]+$/, '');

const NAME_WORD = "[A-Z][\\p{L}.'’-]*";
const AUTHOR_LINE = new RegExp(`^(?:written by|authors?:?|edited by|by)\\s+(${NAME_WORD}(?:\\s+(?:and\\s+|&\\s+)?${NAME_WORD}){1,5})$`, 'u');
const COPYRIGHT_LINE = new RegExp(`(?:[Cc]opyright|©)\\s*(?:\\(c\\)\\s*)?(?:\\d{4}(?:\\s*[-,–]\\s*\\d{4})?\\s*,?\\s*)?(?:by\\s+)?(${NAME_WORD}(?:\\s+${NAME_WORD}){1,3})\\s*[.,]?\\s*$`, 'u');

/**
 * Candidate values for the licence and the author, read from the first pages of a book, each with the line it comes
 * from. They are for a person to confirm: no licence is named that the text does not name, and nothing is decided.
 */
export function suggestFrontMatter(pages: readonly { page: number; lines: readonly string[] }[]): FrontMatterSuggestion[] {
  const found: FrontMatterSuggestion[] = [];
  const add = (suggestion: FrontMatterSuggestion): void => {
    if (!found.some((entry) => entry.field === suggestion.field && entry.value === suggestion.value)) found.push(suggestion);
  };
  for (const { page, lines } of pages) {
    for (const raw of lines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (line === '') continue;
      const url = /https?:\/\/(?:www\.)?creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i.exec(line);
      if (url) {
        const kind = (url[1] as string).toLowerCase();
        add({ field: 'license.url', value: `https://creativecommons.org/licenses/${kind}/${url[2] as string}/`, page, evidence: line });
        add({ field: 'license.name', value: ccLabel(kind, url[2]), page, evidence: line });
      }
      const short = /\bCC[ -]BY((?:[ -](?:SA|NC|ND)){0,2})(?:[ -](\d\.\d))?\b/i.exec(line);
      if (short) add({ field: 'license.name', value: ccLabel(`by${(short[1] ?? '').toLowerCase().replace(/ /g, '-')}`, short[2]), page, evidence: line });
      const long = short ? undefined : /Creative Commons\s+Attribution((?:[- ][A-Za-z]+){0,3})(?:\s+(\d\.\d))?(?=[\s.,;)]|$)/i.exec(line);
      if (long) {
        const codes = CC_WORDS.filter(([pattern]) => pattern.test(long[1] ?? '')).map(([, code]) => code);
        add({ field: 'license.name', value: ccLabel(['by', ...codes].join('-'), long[2]), page, evidence: line });
      }
      if (/all rights reserved/i.test(line) && !/some rights reserved/i.test(line)) add({ field: 'warning', value: 'all rights reserved', page, evidence: line });
      const by = AUTHOR_LINE.exec(line);
      if (by) add({ field: 'author', value: trimName(by[1] as string), page, evidence: line });
      const copyright = COPYRIGHT_LINE.exec(line);
      if (copyright && !/rights|reserved|creative|commons|licen[sc]e/i.test(copyright[1] ?? '')) add({ field: 'author', value: trimName(copyright[1] as string), page, evidence: line });
    }
  }
  return found.slice(0, 8);
}
