/**
 * Titles of sections as a person wants to read them in a contents list, and the comparison of the several spellings a
 * book prints for the same section (its table of contents, the list on the chapter opener, the lesson heading, the
 * practice heading). Pure functions, no PDF.
 */

/** Characters a PDF text layer gives for a glyph it could not map (control characters, the replacement character). */
function isUnmapped(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f || code === 0xfffd;
}

export interface TitleOptions {
  /**
   * What to read for a glyph the text layer could not map. The default reads the control character U+0002, which some
   * fonts give for the "not equal" sign, as "≠"; every repair is reported so that a person can check it in the book.
   */
  glyphRepairs?: Record<string, string>;
}

export const DEFAULT_GLYPH_REPAIRS: Record<string, string> = { '\u0002': '≠' };

export interface CleanedTitle {
  title: string;
  /** What was changed on the way, for the evidence. */
  repairs: string[];
}

/**
 * The title as it should read in the contents: leaders, a trailing page number and a leading number removed, "&" and
 * a "/" between two words read as "and", unmapped glyphs repaired or dropped, spaces collapsed.
 */
export function normalizeTitle(raw: string, options: TitleOptions = {}): CleanedTitle {
  const repairs: string[] = [];
  const glyphs = options.glyphRepairs ?? DEFAULT_GLYPH_REPAIRS;
  let text = raw;
  for (const [glyph, reading] of Object.entries(glyphs)) {
    if (text.includes(glyph)) {
      repairs.push(`the unmapped glyph U+${(glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} was read as "${reading}"`);
      text = text.split(glyph).join(` ${reading} `);
    }
  }
  if ([...text].some(isUnmapped)) {
    repairs.push('unmapped glyphs were dropped');
    text = [...text].map((char) => (isUnmapped(char) ? ' ' : char)).join('');
  }
  text = text
    .replace(/(?:\s*\.){3,}\s*\d*\s*$/, '')
    .replace(/^\s*(?:chapter|part|section|kapitel|abschnitt|teil)\s+(?:\d+|[IVXLC]+)\s*[:.\-–—]\s*/i, '')
    .replace(/^\s*\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+(?=\p{L})/u, '');
  const ampersand = text.replace(/\s*&\s*/g, ' and ');
  if (ampersand !== text) repairs.push('"&" is written "and"');
  text = ampersand;
  const slash = text.replace(/(?<=\p{L})\s*\/\s*(?=\p{L})/gu, ' and ');
  if (slash !== text) repairs.push('"/" between words is written "and"');
  text = slash.replace(/\s+/g, ' ').trim();
  return { title: text, repairs };
}

/** A key for comparing two spellings of a title: lower case letters and digits only, "&" read as "and", "≠" as "!=". */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/≠/g, '!=')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The number of single-character edits that turn one string into the other. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + cost));
    }
    previous = row;
  }
  return previous[b.length] as number;
}

export interface TitleCandidate {
  /** Where the spelling was read: `table of contents`, `chapter opener`, `lesson heading`, `practice heading`. */
  source: string;
  /** The title already normalised. */
  text: string;
}

export interface TitleChoice {
  title: string;
  source: string;
  evidence: string[];
  /** Spellings that differ from the chosen one (after comparing keys). */
  differences: TitleCandidate[];
}

/** Whether two spellings are the same title with a typo or two in one of them. */
function closeSpellings(a: string, b: string): boolean {
  const keyA = titleKey(a);
  const keyB = titleKey(b);
  if (keyA === keyB) return true;
  const limit = Math.max(2, Math.floor(Math.max(keyA.length, keyB.length) * 0.12));
  return editDistance(keyA, keyB) <= limit;
}

/**
 * Picks the title of a section from its spellings. The table of contents wins, unless it looks like a typo: some other
 * spelling is a few characters away and at least two other places agree with each other on it. Without a table of
 * contents the spelling most places agree on wins, then the chapter opener's list, the practice heading, the lesson
 * heading.
 */
export function chooseTitle(candidates: readonly TitleCandidate[]): TitleChoice | undefined {
  const usable = candidates.filter((candidate) => candidate.text.length > 0);
  const first = usable[0];
  if (!first) return undefined;
  const rank = ['table of contents', 'chapter opener', 'practice heading', 'lesson heading'];
  const groups = new Map<string, TitleCandidate[]>();
  for (const candidate of usable) {
    const key = titleKey(candidate.text);
    const list = groups.get(key);
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  }
  const toc = usable.find((candidate) => candidate.source === 'table of contents');
  let chosen: TitleCandidate;
  const evidence: string[] = [];
  const bySupport = [...groups.values()].sort((a, b) => b.length - a.length || (rank.indexOf((a[0] as TitleCandidate).source) - rank.indexOf((b[0] as TitleCandidate).source)));
  const strongest = bySupport[0] as TitleCandidate[];
  if (toc) {
    const tocGroup = groups.get(titleKey(toc.text)) as TitleCandidate[];
    if (strongest !== tocGroup && strongest.length >= 2 && tocGroup.length === 1 && closeSpellings(toc.text, (strongest[0] as TitleCandidate).text)) {
      const repaired = (strongest.find((candidate) => candidate.source === 'chapter opener') ?? strongest[0]) as TitleCandidate;
      chosen = repaired;
      evidence.push(`the table of contents prints "${toc.text}", which looks like a typo: ${strongest.map((candidate) => candidate.source).join(' and ')} read "${repaired.text}"`);
    } else chosen = toc;
  } else if (strongest.length >= 2) {
    chosen = (strongest.find((candidate) => candidate.source === 'chapter opener') ?? strongest[0]) as TitleCandidate;
  } else {
    chosen = [...usable].sort((a, b) => rank.indexOf(a.source) - rank.indexOf(b.source))[0] as TitleCandidate;
  }
  const chosenKey = titleKey(chosen.text);
  // The same words with a space the chosen spelling lacks ("wherea"): the spaced spelling is the better reading.
  const squash = (text: string): string => text.replace(/\s+/g, '');
  const spaces = (text: string): number => (text.match(/\s/g) ?? []).length;
  const spaced = usable.find((candidate) => squash(candidate.text) === squash(chosen.text) && spaces(candidate.text) > spaces(chosen.text));
  let title = chosen.text;
  if (spaced) {
    evidence.push(`a space is missing in the ${chosen.source} ("${chosen.text}"): the ${spaced.source} reads "${spaced.text}"`);
    title = spaced.text;
  }
  const differences = usable.filter((candidate) => titleKey(candidate.text) !== chosenKey);
  return { title, source: chosen.source, evidence, differences };
}

/**
 * The section title out of a lesson heading that carries the chapter title before it ("Pre-Algebra - Integers"): the
 * part after the first " - " when what stands before it is not the whole heading.
 */
export function stripChapterPrefix(heading: string): string {
  const match = /^(.{2,}?)\s+[-–—]\s+(.{2,})$/.exec(heading);
  return match ? (match[2] as string) : heading;
}
