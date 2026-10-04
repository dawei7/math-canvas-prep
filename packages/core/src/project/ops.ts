import { assignSectionIds, deriveSectionId } from '../book/sections.js';
import { snapDivider, snapRectToLines } from '../geometry/snap.js';
import { bookReference, isAuthoritative, normalizeLabel } from '../model/authority.js';
import { compareReadingOrder } from '../model/numbering.js';
import { enlargeToMinimum, isBelowMinimum, parseRect, rectsEqual, roundNumber, roundRect } from '../model/rect.js';
import { FRAME_KINDS, type Authority, type DocumentInfo, type Frame, type FrameKind, type OutlineEntry, type Rect, type Region, type TextLine } from '../model/types.js';
import { AUTHORING, LIMITS } from '../rules/constants.js';
import { checkTitle, folderFromInput } from '../rules/document.js';
import { checkDocumentInfo } from '../rules/info.js';
import { McPrepError } from '../rules/issues.js';
import { normalizeOutline } from '../rules/outline.js';
import { partsOnPage } from '../rules/units.js';
import { nextId, withSequenceBeyondIds, type OutlineSource, type Project } from './model.js';

/**
 * Editing operations on a project, as pure functions: they return a new project and never touch a file. The command
 * line, the MCP server and the desktop app all go through these, so a frame behaves the same wherever it was made.
 * A batch (`applyOperations`) is atomic: it is applied in memory, and the caller validates once at the end.
 */

export type RectInput = Rect | [number, number, number, number] | string;

export interface RegionInput {
  page: number;
  rect: RectInput;
}

/**
 * `id` of an operation is a frame id, or `SECTION:LABEL` for an authoritative exercise ("1.2:5a"), or `@name` for a frame
 * that an earlier `add` of the same batch created (`"ref": "name"`).
 */
export type Operation =
  | {
      op: 'add';
      id?: string;
      ref?: string;
      /** Required, except that an authoritative exercise (`authority`) is an exercise by definition. */
      kind?: FrameKind;
      page: number;
      rect: RectInput;
      snap?: boolean;
      enlarge?: boolean;
      unit?: string;
      context?: RegionInput[];
      continues?: RegionInput[];
      /** `book`: an authoritative exercise: it needs `label` and `section` and cannot have a `unit`. */
      authority?: Authority;
      label?: string;
      section?: string;
      /** Where the answer is printed (hidden from the learner). Exercises only. */
      solution?: RegionInput[];
      /**
       * Authoritative exercises are identified by (`section`, `label`). Adding one that exists is an error, so that applying
       * a batch twice does not duplicate anything; with `replace` it is overwritten in place instead and keeps its id: page,
       * rect and continues are replaced, context and solution are replaced when the operation lists them (an empty list
       * clears) and kept otherwise.
       */
      replace?: boolean;
    }
  | { op: 'update'; id: string; kind?: FrameKind; page?: number; rect?: RectInput; snap?: boolean; enlarge?: boolean }
  | { op: 'delete'; id?: string; unit?: string }
  | { op: 'move'; id: string; dx: number; dy: number }
  | { op: 'split'; id: string; at: number[]; first?: number; preamble?: 'keep' | 'context' | 'drop'; snap?: boolean }
  | { op: 'merge'; unit?: string; ids?: string[] }
  | { op: 'dividers'; id: string; at: number[]; page?: number; snap?: boolean }
  | { op: 'area'; id: string; rect: RectInput; snap?: boolean }
  | { op: 'context.add'; id: string; page: number; rect: RectInput; snap?: boolean }
  | { op: 'context.remove'; id: string; index?: number; all?: boolean }
  | { op: 'context.set'; id: string; regions: RegionInput[] }
  | { op: 'continues.add'; id: string; page: number; rect: RectInput; snap?: boolean }
  | { op: 'continues.remove'; id: string; index?: number; all?: boolean }
  | { op: 'authority.mark'; id: string; label: string; section: string }
  | { op: 'authority.unmark'; id: string }
  | { op: 'label.set'; id: string; label: string }
  | { op: 'section.set'; id: string; section: string }
  | { op: 'solution.add'; id: string; page: number; rect: RectInput; snap?: boolean }
  | { op: 'solution.remove'; id: string; index?: number; all?: boolean }
  | { op: 'solution.set'; id: string; regions: RegionInput[] }
  | { op: 'outline.set'; entries: OutlineEntry[]; source?: OutlineSource }
  | { op: 'outline.add'; title: string; page: number; depth?: number; id?: string; label?: string; top?: number; at?: number; autoId?: boolean }
  | { op: 'outline.update'; id?: string; index?: number; title?: string; page?: number; depth?: number; newId?: string | null; label?: string | null; top?: number | null }
  | { op: 'outline.delete'; id?: string; index?: number; subtree?: boolean }
  | { op: 'outline.ids' }
  | { op: 'outline.clear' }
  | {
      op: 'meta.set';
      title?: string;
      folder?: string | null;
      author?: string | null;
      series?: string | null;
      description?: string | null;
      notice?: string | null;
      sourceUrl?: string | null;
      license?: { name: string; url?: string | null } | null;
    };

export const OPERATION_NAMES = [
  'add',
  'update',
  'delete',
  'move',
  'split',
  'merge',
  'dividers',
  'area',
  'context.add',
  'context.remove',
  'context.set',
  'continues.add',
  'continues.remove',
  'authority.mark',
  'authority.unmark',
  'label.set',
  'section.set',
  'solution.add',
  'solution.remove',
  'solution.set',
  'outline.set',
  'outline.add',
  'outline.update',
  'outline.delete',
  'outline.ids',
  'outline.clear',
  'meta.set',
] as const;

export interface OpContext {
  pageCount: number;
  /** The text lines of a page, when known (for snapping). */
  linesFor?: (page: number) => readonly TextLine[] | undefined;
}

export interface OpResult {
  project: Project;
  /** Ids of frames created by the operation. */
  created: string[];
  removed: string[];
  notes: string[];
  /** Ids of authoritative exercises that an `add` with `replace` overwrote in place. */
  replaced?: string[];
  /** The frame an `add` created or replaced: what a `ref` of the batch stands for. */
  target?: string;
}

function fail(code: string, message: string, hint?: string, details?: Record<string, unknown>): never {
  throw new McPrepError(code, message, { ...(hint !== undefined ? { hint } : {}), ...(details !== undefined ? { details } : {}) });
}

const fmt = (value: number): string => roundNumber(value, 4).toString();

/**
 * The frame a reference names: its id, or `SECTION:LABEL` for an authoritative exercise ("1.2:5a"; neither a frame id nor a
 * label can contain a colon). Undefined when there is none.
 */
export function findFrame(project: Project, reference: string): Frame | undefined {
  const colon = reference.indexOf(':');
  if (colon > 0) {
    const section = reference.slice(0, colon);
    const label = reference.slice(colon + 1);
    return project.frames.find((frame) => isAuthoritative(frame) && frame.section === section && frame.label === label);
  }
  return project.frames.find((frame) => frame.id === reference);
}

function frameById(project: Project, id: string): Frame {
  const found = findFrame(project, id);
  if (!found) {
    if (id.includes(':')) {
      const section = id.slice(0, id.indexOf(':'));
      const label = id.slice(id.indexOf(':') + 1);
      const sameSection = project.frames.filter((frame) => isAuthoritative(frame) && frame.section === section).map((frame) => frame.label as string);
      fail(
        'E_NO_FRAME',
        `There is no book exercise "${label}" in section "${section}".`,
        sameSection.length > 0 ? `The section has ${sameSection.length} exercise${sameSection.length === 1 ? '' : 's'}: ${sameSection.slice(0, 20).join(', ')}${sameSection.length > 20 ? ', ...' : ''}. List them with \`mcprep exercises list --section ${section}\`.` : `No exercise is filed under "${section}". List them with \`mcprep exercises list\`.`,
      );
    }
    const known = project.frames.map((frame) => frame.id);
    fail('E_NO_FRAME', `There is no frame with the id "${id}".`, known.length > 0 ? `Known ids: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', ...' : ''}. List them with \`mcprep frames list\`.` : 'There are no frames yet.');
  }
  return found;
}

/** The sentence that explains why an authoritative exercise has no parts, for every refusal. */
const PARTS_CONVENTION =
  'An authoritative exercise is one exercise with one printed label. The parts of a printed exercise (5a, 5b) are separate exercises with separate labels, and what they share (the statement printed once above them) is attached to each of them as context (`context add`). Cutting into parts is for exercises you frame for yourself.';

function refuseAuthoritative(frame: Frame, what: string, hint: string = PARTS_CONVENTION): void {
  if (!isAuthoritative(frame)) return;
  fail('E_AUTHORITY', `${frame.id} is an authoritative exercise (${bookReference(frame.section ?? '?', frame.label ?? '?')}), so it cannot be ${what}.`, hint);
}

/** A label as typed, made into what the book prints (notes say what was changed); fails when it cannot be a label. */
function checkLabel(raw: unknown, who: string, notes: string[]): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail('E_LABEL', `${who} needs a label: the number exactly as the book prints it.`, 'For example 5, 12, 5a, A.3.');
  }
  const { label, changes } = normalizeLabel(raw);
  for (const change of changes) notes.push(`${who}: ${change}.`);
  if (!LIMITS.labelPattern.test(label)) {
    fail(
      'E_LABEL',
      `The label ${JSON.stringify(label)} is not valid: it is 1 to ${LIMITS.labelMax} characters, starts with a letter or digit and continues with letters, digits, spaces and . _ - ( ) /`,
      'Write the number as the book prints it, without the closing "." or ")": 5, 5a, A.3, II-4.',
    );
  }
  return label;
}

function checkSectionId(raw: unknown, who: string): string {
  if (typeof raw !== 'string' || !LIMITS.sectionIdPattern.test(raw)) {
    fail(
      'E_SECTION',
      `${who} needs the id of a section (an outline entry): 1 to ${LIMITS.sectionIdMax} characters of A-Z a-z 0-9 . _ - starting with a letter or digit, not ${JSON.stringify(raw)}.`,
      'List the sections with `mcprep outline`; give an entry an id with `mcprep outline update` or `outline ids`.',
    );
  }
  return raw;
}

function replaceFrames(project: Project, frames: Frame[]): Project {
  return { ...project, frames };
}

function assertPage(page: unknown, ctx: OpContext, what = 'page'): number {
  if (typeof page !== 'number' || !Number.isInteger(page)) fail('E_PAGE', `The ${what} must be a whole number (zero-based), not ${JSON.stringify(page)}.`, 'Pages are zero-based: the first page is 0.');
  if (page < 0 || page >= ctx.pageCount) {
    fail('E_PAGE', `The ${what} ${page} does not exist: the document has ${ctx.pageCount} page${ctx.pageCount === 1 ? '' : 's'} (zero-based 0..${ctx.pageCount - 1}).`, 'Pages are zero-based: the first page is 0.');
  }
  return page;
}

/** A rectangle as given, put inside the page; far outside is an error (percent or points instead of fractions). */
function cleanRect(input: RectInput, label = 'rect'): Rect {
  const rect = parseRect(input);
  const values = [rect.left, rect.top, rect.right, rect.bottom];
  if (values.some((value) => value < -0.01 || value > 1.01)) {
    fail('E_RECT_RANGE', `The ${label} ${JSON.stringify(rect)} is outside the page: every value must be a fraction between 0 and 1.`, 'Coordinates are fractions of the displayed page, not percent or points. Divide by the page width (x) or height (y).');
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const out = { left: clamp(rect.left), top: clamp(rect.top), right: clamp(rect.right), bottom: clamp(rect.bottom) };
  if (out.right <= out.left || out.bottom <= out.top) {
    fail('E_RECT_ORDER', `The ${label} ${JSON.stringify(rect)} is empty or inverted: right must be greater than left and bottom greater than top.`, 'The origin is the top-left corner; x grows to the right and y downwards.');
  }
  return out;
}

function fitRect(rect: Rect, page: number, options: { snap?: boolean | undefined; enlarge?: boolean | undefined }, ctx: OpContext, notes: string[], label: string): Rect {
  let out = rect;
  if (options.snap === true) {
    const lines = ctx.linesFor?.(page);
    if (!lines || lines.length === 0) {
      notes.push(`${label}: page ${page} has no text lines, so the edges were not snapped.`);
    } else {
      const snapped = snapRectToLines(out, lines);
      for (const change of snapped.changes) {
        notes.push(`${label}: ${change.edge} edge ${fmt(change.from)} -> ${fmt(change.to)} (${change.how === 'whole' ? 'took' : 'left out'} the line "${change.line.slice(0, 40)}").`);
      }
      out = snapped.rect;
    }
  }
  if (isBelowMinimum(out)) {
    if (options.enlarge === false) {
      fail('E_RECT_SMALL', `The ${label} is smaller than the minimum (${LIMITS.minWidth} wide, ${LIMITS.minHeight} tall).`, 'Make it larger, or allow enlarging.');
    }
    const enlarged = enlargeToMinimum(out);
    notes.push(`${label}: enlarged to the minimum size (${fmt(enlarged.right - enlarged.left)} x ${fmt(enlarged.bottom - enlarged.top)}).`);
    out = enlarged;
  }
  return roundRect(out);
}

function regionOf(input: RegionInput, ctx: OpContext, notes: string[], label: string, snap?: boolean): Region {
  const page = assertPage(input.page, ctx, `${label} page`);
  const rect = fitRect(cleanRect(input.rect, `${label} rect`), page, { snap, enlarge: true }, ctx, notes, label);
  return { page, rect };
}

function checkKind(kind: unknown): FrameKind {
  if (typeof kind !== 'string' || !(FRAME_KINDS as readonly string[]).includes(kind)) {
    fail('E_KIND', `The kind must be one of ${FRAME_KINDS.join(', ')}, not ${JSON.stringify(kind)}.`);
  }
  return kind as FrameKind;
}

function checkNewId(project: Project, id: string): void {
  if (!LIMITS.idPattern.test(id)) fail('E_ID', `The id "${id}" is not valid: use 1 to 40 characters of A-Z a-z 0-9 _ -.`);
  if (project.frames.some((frame) => frame.id === id || frame.unit === id)) fail('E_ID_TAKEN', `The id "${id}" is already used.`, 'Leave the id out to get a generated one.');
}

/** An id the caller chose (`f12`, `u3`) keeps the counter of generated ids above it, so that no generated id can equal it. */
function reserveId(project: Project, id: string): Project {
  const match = /^[fu](\d+)$/.exec(id);
  if (!match) return project;
  const number = Number(match[1]);
  return number > project.seq ? { ...project, seq: number } : project;
}

function freshFrameId(project: Project): { id: string; project: Project } {
  return nextId(project, 'f');
}

const sortedParts = (parts: readonly Frame[]): Frame[] => [...parts].sort(compareReadingOrder);

function unionRegions(parts: readonly Frame[]): Region[] {
  const union: Region[] = [];
  for (const part of sortedParts(parts)) {
    for (const region of part.context ?? []) {
      if (!union.some((known) => known.page === region.page && rectsEqual(known.rect, region.rect, 1e-6))) union.push(region);
    }
  }
  return union;
}

/**
 * Puts the unit's context on its first part only (the convention of the bundle writer). `union` is the context to keep;
 * by default the union of what the parts carry now.
 */
function consolidateUnitContext(frames: Frame[], unit: string, keep?: Region[]): Frame[] {
  const members = frames.filter((frame) => frame.unit === unit);
  if (members.length === 0) return frames;
  const first = sortedParts(members)[0] as Frame;
  const union = keep ?? unionRegions(members);
  return frames.map((frame) => {
    if (frame.unit !== unit) return frame;
    const copy: Frame = { ...frame };
    if (frame.id === first.id && union.length > 0) copy.context = union;
    else delete copy.context;
    return copy;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Pieces

/** Checks dividers strictly: inside the rect, each at least one minimum piece away from its neighbours and the ends. */
export function checkDividers(rect: Rect, dividers: readonly number[], what: string): number[] {
  const sorted = [...dividers].sort((a, b) => a - b);
  const min = AUTHORING.minPieceHeight;
  let previous = rect.top;
  for (const y of sorted) {
    if (!Number.isFinite(y)) fail('E_SPLIT', `A divider position is not a number (${String(y)}).`);
    if (y - previous < min - 1e-9) {
      fail('E_SPLIT', `The divider at ${fmt(y)} is ${fmt(y - previous)} from ${previous === rect.top ? `the top of ${what}` : 'the divider before it'} (${fmt(previous)}); each piece must be at least ${min} tall.`, `Choose a divider between ${fmt(previous + min)} and ${fmt(rect.bottom - min)}.`);
    }
    previous = y;
  }
  if (sorted.length > 0 && rect.bottom - previous < min - 1e-9) {
    fail('E_SPLIT', `The divider at ${fmt(previous)} is ${fmt(rect.bottom - previous)} from the bottom of ${what} (${fmt(rect.bottom)}); each piece must be at least ${min} tall.`, `Choose a divider between ${fmt(rect.top + min)} and ${fmt(rect.bottom - min)}.`);
  }
  return sorted;
}

function piecesOf(rect: Rect, dividers: readonly number[]): Rect[] {
  const edges = [rect.top, ...dividers, rect.bottom];
  const pieces: Rect[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    pieces.push({ left: rect.left, top: edges[i] as number, right: rect.right, bottom: edges[i + 1] as number });
  }
  return pieces;
}

function snapDividers(dividers: readonly number[], page: number, snap: boolean | undefined, ctx: OpContext, notes: string[]): number[] {
  if (snap !== true) return [...dividers];
  const lines = ctx.linesFor?.(page);
  if (!lines || lines.length === 0) {
    notes.push(`Page ${page} has no text lines, so the dividers were not snapped.`);
    return [...dividers];
  }
  return dividers.map((y) => {
    const snapped = roundNumber(snapDivider(y, lines), 5);
    if (snapped !== y) notes.push(`Divider ${fmt(y)} snapped to ${fmt(snapped)}.`);
    return snapped;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations

/** Overwrites an authoritative exercise in place (`add` with `replace`): the id stays, the geometry is the operation's. */
function replaceExercise(project: Project, existing: Frame, op: Extract<Operation, { op: 'add' }>, page: number, ctx: OpContext, notes: string[]): OpResult {
  if (op.id !== undefined && op.id !== existing.id) notes.push(`${existing.id} keeps its id; the id "${op.id}" was not used.`);
  const id = existing.id;
  const rect = fitRect(cleanRect(op.rect), page, { snap: op.snap, enlarge: op.enlarge }, ctx, notes, id);
  const next: Frame = { ...existing, page, rect };
  delete next.continues;
  if (op.continues && op.continues.length > 0) next.continues = op.continues.map((region, index) => regionOf(region, ctx, notes, `${id} continues[${index}]`, op.snap));
  if (op.context !== undefined) {
    if (op.context.length > 0) next.context = op.context.map((region, index) => regionOf(region, ctx, notes, `${id} context[${index}]`, op.snap));
    else delete next.context;
  }
  if (op.solution !== undefined) {
    if (op.solution.length > 0) next.solution = op.solution.map((region, index) => regionOf(region, ctx, notes, `${id} solution[${index}]`, op.snap));
    else delete next.solution;
  }
  notes.push(`Replaced the exercise ${bookReference(existing.section as string, existing.label as string)} in place (${id}).`);
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === id ? next : item))), created: [], removed: [], notes, replaced: [id], target: id };
}

function opAdd(project: Project, op: Extract<Operation, { op: 'add' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const authoritative = op.authority !== undefined;
  const kind = op.kind === undefined && authoritative ? 'exercise' : checkKind(op.kind);
  const page = assertPage(op.page, ctx);
  let label: string | undefined;
  let section: string | undefined;
  if (authoritative) {
    if (op.authority !== 'book') fail('E_AUTHORITY', `The authority must be "book", not ${JSON.stringify(op.authority)}.`, 'Leave authority out for an ordinary exercise.');
    if (kind !== 'exercise') fail('E_AUTHORITY', `Only exercises can be authoritative; this frame is a ${kind}.`, 'Questions and bookmarks are what a learner marks for themselves.');
    if (op.unit !== undefined) fail('E_AUTHORITY_UNIT', `An authoritative exercise is a single exercise and cannot be a part of the unit "${op.unit}".`, PARTS_CONVENTION);
    label = checkLabel(op.label, 'An authoritative exercise', notes);
    section = checkSectionId(op.section, 'An authoritative exercise');
  } else {
    if (op.label !== undefined || op.section !== undefined) {
      fail('E_AUTHORITY', 'label and section belong to authoritative exercises, and this frame has no authority.', 'Add "authority": "book" (or use `exercises add`) to make an authoritative exercise, or remove label and section.');
    }
    if (op.replace === true) fail('E_AUTHORITY', '"replace" only applies to authoritative exercises, which are identified by their section and label.', 'Add "authority": "book", "label" and "section", or leave "replace" out.');
  }
  if (op.solution && op.solution.length > 0 && kind !== 'exercise') fail('E_SOLUTION', `Only exercises can have a solution; this frame is a ${kind}.`);
  if (authoritative) {
    const existing = project.frames.find((frame) => isAuthoritative(frame) && frame.section === section && frame.label === label);
    if (existing) {
      if (op.replace !== true) {
        fail(
          'E_DUPLICATE_EXERCISE',
          `There is already an exercise "${label as string}" in section "${section as string}" (${existing.id}).`,
          'An exercise is identified by its section and label, so applying a batch twice adds nothing twice. Add "replace": true (--replace) to overwrite it in place, or choose another label.',
        );
      }
      return replaceExercise(project, existing, op, page, ctx, notes);
    }
  }

  let current = project;
  let id: string;
  if (op.id !== undefined) {
    checkNewId(current, op.id);
    id = op.id;
    current = reserveId(current, id);
  } else {
    const generated = freshFrameId(current);
    id = generated.id;
    current = generated.project;
  }
  const rect = fitRect(cleanRect(op.rect), page, { snap: op.snap, enlarge: op.enlarge }, ctx, notes, id);
  const frame: Frame = { id, kind, page, rect };
  if (op.unit !== undefined) {
    if (kind !== 'exercise') fail('E_UNIT', `Only exercises can be parts of a unit; ${id} is a ${kind}.`);
    if (!LIMITS.idPattern.test(op.unit)) fail('E_ID', `The unit id "${op.unit}" is not valid: use 1 to 40 characters of A-Z a-z 0-9 _ -.`);
    frame.unit = op.unit;
    current = reserveId(current, op.unit);
  }
  if (op.continues && op.continues.length > 0) {
    if (frame.unit !== undefined) fail('E_UNIT', `${id} is a part of a unit and cannot have "continues".`, 'Use a separate part (same unit) on the next page instead.');
    frame.continues = op.continues.map((region, index) => regionOf(region, ctx, notes, `${id} continues[${index}]`, op.snap));
  }
  if (op.context && op.context.length > 0) {
    if (kind !== 'exercise') fail('E_CONTEXT', `Only exercises can have context; ${id} is a ${kind}.`);
    frame.context = op.context.map((region, index) => regionOf(region, ctx, notes, `${id} context[${index}]`, op.snap));
  }
  if (authoritative) {
    frame.authority = 'book';
    frame.label = label as string;
    frame.section = section as string;
  }
  if (op.solution && op.solution.length > 0) frame.solution = op.solution.map((region, index) => regionOf(region, ctx, notes, `${id} solution[${index}]`, op.snap));
  let frames = [...current.frames, frame];
  if (frame.unit !== undefined) frames = consolidateUnitContext(frames, frame.unit);
  return { project: replaceFrames(current, frames), created: [id], removed: [], notes, target: id };
}

function opUpdate(project: Project, op: Extract<Operation, { op: 'update' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const frame = frameById(project, op.id);
  if (frame.unit !== undefined && (op.rect !== undefined || op.page !== undefined || op.kind !== undefined)) {
    fail('E_UNIT_PART', `${op.id} is a part of unit "${frame.unit}"; its position and kind cannot be changed on its own.`, `Use "area" to move or resize the whole exercise, "dividers" to move the cuts between its parts, or "merge" to turn it back into one frame.`);
  }
  const next: Frame = { ...frame };
  if (op.kind !== undefined) {
    next.kind = checkKind(op.kind);
    if (next.kind !== 'exercise') {
      if (isAuthoritative(frame)) {
        fail('E_AUTHORITY', `${frame.id} is an authoritative exercise (${bookReference(frame.section ?? '?', frame.label ?? '?')}), so it cannot become a ${next.kind}.`, 'Make it an ordinary exercise first (`exercises unmark`), or delete it and add the question yourself.');
      }
      if (next.context) {
        delete next.context;
        notes.push(`${frame.id}: context removed, because only exercises can have context.`);
      }
      if (next.solution) {
        delete next.solution;
        notes.push(`${frame.id}: solution removed, because only exercises can have a solution.`);
      }
    }
  }
  if (op.page !== undefined) next.page = assertPage(op.page, ctx);
  if (op.rect !== undefined || op.snap === true) {
    const base = op.rect !== undefined ? cleanRect(op.rect) : frame.rect;
    next.rect = fitRect(base, next.page, { snap: op.snap, enlarge: op.enlarge }, ctx, notes, frame.id);
  }
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === frame.id ? next : item))), created: [], removed: [], notes };
}

/** An exercise left with one part is an ordinary exercise again: the unit goes. */
function dropSingleUnit(frames: Frame[], unit: string): Frame[] {
  if (frames.filter((frame) => frame.unit === unit).length !== 1) return frames;
  return frames.map((frame) => {
    if (frame.unit !== unit) return frame;
    const copy = { ...frame };
    delete copy.unit;
    return copy;
  });
}

/**
 * Removes frames. An exercise left with one part is an ordinary exercise again, and the context of a removed part
 * stays with the exercise (the first remaining part takes it).
 */
function removeFrames(project: Project, ids: Set<string>): Project {
  const units = new Set(project.frames.filter((frame) => ids.has(frame.id) && frame.unit !== undefined).map((frame) => frame.unit as string));
  const unions = new Map<string, Region[]>();
  for (const unit of units) unions.set(unit, unionRegions(project.frames.filter((frame) => frame.unit === unit)));
  let frames = project.frames.filter((frame) => !ids.has(frame.id));
  for (const unit of units) {
    const left = frames.filter((frame) => frame.unit === unit);
    if (left.length === 0) continue;
    frames = dropSingleUnit(consolidateUnitContext(frames, unit, unions.get(unit)), unit);
  }
  return replaceFrames(project, frames);
}

function opDelete(project: Project, op: Extract<Operation, { op: 'delete' }>): OpResult {
  const notes: string[] = [];
  if (op.unit !== undefined) {
    const members = project.frames.filter((frame) => frame.unit === op.unit);
    if (members.length === 0) fail('E_NO_UNIT', `There is no unit "${op.unit}".`);
    const ids = new Set(members.map((frame) => frame.id));
    return { project: removeFrames(project, ids), created: [], removed: [...ids], notes };
  }
  if (op.id === undefined) fail('E_OP', 'delete needs an "id" (or a "unit").');
  const frame = frameById(project, op.id);
  let current = project;
  if (frame.unit !== undefined) {
    // As in the app: a part taken out of the middle leaves no gap, the part above takes over its area.
    const parts = partsOnPage(project.frames, frame.unit, frame.page);
    const at = parts.findIndex((part) => part.id === frame.id);
    const upper = parts[at - 1];
    if (upper && parts[at + 1]) {
      current = replaceFrames(project, project.frames.map((item) => (item.id === upper.id ? { ...item, rect: { ...item.rect, bottom: frame.rect.bottom } } : item)));
      notes.push(`${upper.id} now reaches down to ${fmt(frame.rect.bottom)}, so the parts still tile.`);
    }
  }
  return { project: removeFrames(current, new Set([frame.id])), created: [], removed: [frame.id], notes };
}

function opMove(project: Project, op: Extract<Operation, { op: 'move' }>): OpResult {
  const frame = frameById(project, op.id);
  const members = frame.unit !== undefined ? partsOnPage(project.frames, frame.unit, frame.page) : [frame];
  const ids = new Set(members.map((item) => item.id));
  const dx = Math.min(Math.max(op.dx, -Math.min(...members.map((item) => item.rect.left))), 1 - Math.max(...members.map((item) => item.rect.right)));
  const dy = Math.min(Math.max(op.dy, -Math.min(...members.map((item) => item.rect.top))), 1 - Math.max(...members.map((item) => item.rect.bottom)));
  const shift = (rect: Rect): Rect => roundRect({ left: rect.left + dx, top: rect.top + dy, right: rect.right + dx, bottom: rect.bottom + dy });
  const frames = project.frames.map((item) => (ids.has(item.id) ? { ...item, rect: shift(item.rect) } : item));
  return { project: replaceFrames(project, frames), created: [], removed: [], notes: [`Moved ${members.length === 1 ? frame.id : `${members.length} parts`} by (${fmt(dx)}, ${fmt(dy)}).`] };
}

function opSplit(project: Project, op: Extract<Operation, { op: 'split' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const frame = frameById(project, op.id);
  refuseAuthoritative(frame, 'cut into parts');
  if (frame.kind !== 'exercise') fail('E_SPLIT', `Only exercises can be cut into parts; ${op.id} is a ${frame.kind}.`);
  if (frame.continues && frame.continues.length > 0) fail('E_SPLIT', `${op.id} continues on another region, so it cannot be cut into parts.`, 'Frames with "continues" cannot be units. Cut each page of the exercise separately: delete this frame and add one frame per page, then split the parts you need.');
  if (!Array.isArray(op.at) || op.at.length === 0) fail('E_SPLIT', 'split needs at least one divider position ("at").', 'Give the y positions (fractions of the page) where the next parts start.');
  const preamble = op.preamble ?? (op.first !== undefined ? 'context' : 'keep');
  if ((op.first !== undefined || preamble !== 'keep') && frame.unit !== undefined) {
    fail('E_SPLIT', `${op.id} is already a part; "first" and "preamble" only apply when an exercise is cut into parts for the first time.`);
  }
  if (preamble !== 'keep' && op.first === undefined) fail('E_SPLIT', `preamble "${preamble}" needs "first": the y where the first part starts.`);

  let area = frame.rect;
  let current = project;
  let contextAdd: Region | undefined;
  if (op.first !== undefined) {
    const first = snapDividers([op.first], frame.page, op.snap, ctx, notes)[0] as number;
    if (first < frame.rect.top - 1e-9) fail('E_SPLIT', `"first" (${fmt(first)}) is above the top of the frame (${fmt(frame.rect.top)}).`, 'The first part starts inside the frame.');
    if (first - frame.rect.top < AUTHORING.minPieceHeight) {
      if (preamble === 'context') fail('E_SPLIT', `"first" (${fmt(first)}) leaves no room for context above it (the frame starts at ${fmt(frame.rect.top)}).`, 'Use preamble "keep" when the first part starts at the top of the frame.');
    } else if (preamble === 'context') {
      contextAdd = { page: frame.page, rect: roundRect({ left: frame.rect.left, top: frame.rect.top, right: frame.rect.right, bottom: first }) };
    }
    if (first >= frame.rect.bottom - AUTHORING.minPieceHeight) fail('E_SPLIT', `"first" (${fmt(first)}) is too close to the bottom of the frame (${fmt(frame.rect.bottom)}).`);
    area = { ...frame.rect, top: first };
  }
  const dividers = checkDividers(area, snapDividers(op.at, frame.page, op.snap, ctx, notes).map((y) => roundNumber(y, 5)), op.id);
  const pieces = piecesOf(area, dividers);

  let unit = frame.unit;
  if (unit === undefined) {
    const generated = nextId(current, 'u');
    unit = generated.id;
    current = generated.project;
  }
  const created: string[] = [];
  const newFrames: Frame[] = [];
  pieces.forEach((rect, index) => {
    if (index === 0) {
      const first: Frame = { ...frame, rect: roundRect(rect), unit: unit as string };
      newFrames.push(first);
      return;
    }
    const generated = freshFrameId(current);
    current = generated.project;
    created.push(generated.id);
    newFrames.push({ id: generated.id, kind: 'exercise', page: frame.page, rect: roundRect(rect), unit: unit as string });
  });
  const firstPiece = newFrames[0] as Frame;
  if (contextAdd) firstPiece.context = [...(firstPiece.context ?? []), contextAdd];
  let frames = current.frames.flatMap((item) => (item.id === frame.id ? newFrames : [item]));
  // A part that is cut again keeps its place: the new pieces follow it.
  frames = consolidateUnitContext(frames, unit);
  notes.push(`Cut ${op.id} into ${pieces.length} parts of unit "${unit}" (${[op.id, ...created].join(', ')}).`);
  if (contextAdd) notes.push(`The text above the first part (${fmt(contextAdd.rect.top)}..${fmt(contextAdd.rect.bottom)}) became context of the exercise.`);
  return { project: replaceFrames(current, frames), created, removed: [], notes };
}

function opMerge(project: Project, op: Extract<Operation, { op: 'merge' }>): OpResult {
  const notes: string[] = [];
  if (op.unit !== undefined) {
    const members = project.frames.filter((frame) => frame.unit === op.unit);
    if (members.length === 0) fail('E_NO_UNIT', `There is no unit "${op.unit}".`);
    let frames = [...project.frames];
    const removed: string[] = [];
    const pages = [...new Set(members.map((frame) => frame.page))];
    for (const page of pages) {
      const parts = partsOnPage(frames, op.unit, page);
      const first = parts[0] as Frame;
      const last = parts[parts.length - 1] as Frame;
      for (const part of parts.slice(1)) removed.push(part.id);
      frames = frames
        .filter((frame) => !parts.slice(1).some((part) => part.id === frame.id))
        .map((frame) => (frame.id === first.id ? { ...frame, rect: { ...frame.rect, bottom: last.rect.bottom } } : frame));
    }
    const left = frames.filter((frame) => frame.unit === op.unit);
    if (left.length === 1) {
      frames = frames.map((frame) => {
        if (frame.unit !== op.unit) return frame;
        const copy = { ...frame };
        delete copy.unit;
        return copy;
      });
    } else {
      notes.push(`Unit "${op.unit}" spans ${left.length} pages, so it keeps one part per page.`);
      frames = consolidateUnitContext(frames, op.unit);
    }
    notes.push(`Merged the parts of unit "${op.unit}" into ${left.length} frame${left.length === 1 ? '' : 's'}.`);
    return { project: replaceFrames(project, frames), created: [], removed, notes };
  }
  const ids = op.ids ?? [];
  if (ids.length < 2) fail('E_MERGE', 'merge needs a "unit", or at least two part ids in "ids".');
  const parts = ids.map((id) => frameById(project, id));
  for (const part of parts) refuseAuthoritative(part, 'merged: it has no parts');
  const unit = parts[0]?.unit;
  if (unit === undefined || parts.some((part) => part.unit !== unit || part.page !== (parts[0] as Frame).page)) {
    fail('E_MERGE', 'Only parts of one exercise on the same page can be merged.', 'Independent frames cannot be merged; delete one and resize the other.');
  }
  const ordered = partsOnPage(project.frames, unit, (parts[0] as Frame).page);
  const positions = parts.map((part) => ordered.findIndex((item) => item.id === part.id)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i += 1) {
    if ((positions[i] as number) !== (positions[i - 1] as number) + 1) fail('E_MERGE', 'The parts to merge must be next to each other.');
  }
  const first = ordered[positions[0] as number] as Frame;
  const last = ordered[positions[positions.length - 1] as number] as Frame;
  const drop = new Set(ordered.slice((positions[0] as number) + 1, (positions[positions.length - 1] as number) + 1).map((part) => part.id));
  const grown = replaceFrames(
    project,
    project.frames.map((frame) => (frame.id === first.id ? { ...frame, rect: { ...frame.rect, bottom: last.rect.bottom } } : frame)),
  );
  notes.push(`Merged ${ids.join(', ')} into ${first.id}.`);
  return { project: removeFrames(grown, drop), created: [], removed: [...drop], notes };
}

function opDividers(project: Project, op: Extract<Operation, { op: 'dividers' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const frame = frameById(project, op.id);
  refuseAuthoritative(frame, 'given dividers: it has no parts');
  if (frame.unit === undefined) fail('E_UNIT_PART', `${op.id} is not part of an exercise with parts.`, 'Use "split" to cut a frame into parts first.');
  const page = op.page ?? frame.page;
  const parts = partsOnPage(project.frames, frame.unit, page);
  if (parts.length === 0) fail('E_NO_PARTS', `Unit "${frame.unit}" has no parts on page ${page}.`);
  const area: Rect = {
    left: (parts[0] as Frame).rect.left,
    top: (parts[0] as Frame).rect.top,
    right: (parts[0] as Frame).rect.right,
    bottom: (parts[parts.length - 1] as Frame).rect.bottom,
  };
  const dividers = checkDividers(area, snapDividers(op.at, page, op.snap, ctx, notes).map((y) => roundNumber(y, 5)), `the area of unit "${frame.unit}"`);
  const pieces = piecesOf(area, dividers);
  let current = project;
  const created: string[] = [];
  const removed: string[] = [];
  const pieceFrames: Frame[] = pieces.map((rect, index) => {
    const existing = parts[index];
    if (existing) return { ...existing, rect: roundRect(rect) };
    const generated = freshFrameId(current);
    current = generated.project;
    created.push(generated.id);
    return { id: generated.id, kind: 'exercise', page, rect: roundRect(rect), unit: frame.unit as string };
  });
  for (const part of parts.slice(pieces.length)) removed.push(part.id);
  const unit = frame.unit;
  const context = unionRegions(current.frames.filter((item) => item.unit === unit));
  const ids = new Set(parts.map((part) => part.id));
  const frames = dropSingleUnit(consolidateUnitContext([...current.frames.filter((item) => !ids.has(item.id)), ...pieceFrames], unit, context), unit);
  notes.push(`Unit "${unit}" on page ${page} now has ${pieces.length} part${pieces.length === 1 ? '' : 's'}.`);
  return { project: replaceFrames(current, frames), created, removed, notes };
}

function opArea(project: Project, op: Extract<Operation, { op: 'area' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const frame = frameById(project, op.id);
  refuseAuthoritative(frame, 'resized as an exercise with parts', `${PARTS_CONVENTION} To move or resize a single exercise, authoritative ones included, use "update" (\`mcprep frames update ${frame.id} --rect l,t,r,b\`).`);
  if (frame.unit === undefined) {
    return opUpdate(project, { op: 'update', id: op.id, rect: op.rect, ...(op.snap !== undefined ? { snap: op.snap } : {}) }, ctx);
  }
  const parts = partsOnPage(project.frames, frame.unit, frame.page);
  const rect = fitRect(cleanRect(op.rect), frame.page, { snap: op.snap, enlarge: true }, ctx, notes, `area of ${frame.unit}`);
  // As in the app: left and right apply to every part, the top edge to the first part, the bottom edge to the last;
  // the cuts between parts stay where they are.
  const min = AUTHORING.minPieceHeight;
  const cuts = parts.slice(1).map((part) => part.rect.top);
  const firstCut = cuts[0];
  const lastCut = cuts[cuts.length - 1];
  if (firstCut !== undefined && rect.top > firstCut - min) fail('E_AREA', `The new top ${fmt(rect.top)} is below the first cut (${fmt(firstCut)}).`, 'Use "dividers" to move the cuts first.');
  if (lastCut !== undefined && rect.bottom < lastCut + min) fail('E_AREA', `The new bottom ${fmt(rect.bottom)} is above the last cut (${fmt(lastCut)}).`, 'Use "dividers" to move the cuts first.');
  const ids = new Set(parts.map((part) => part.id));
  const frames = project.frames.map((item) => {
    if (!ids.has(item.id)) return item;
    const index = parts.findIndex((part) => part.id === item.id);
    return {
      ...item,
      rect: roundRect({
        left: rect.left,
        right: rect.right,
        top: index === 0 ? rect.top : item.rect.top,
        bottom: index === parts.length - 1 ? rect.bottom : item.rect.bottom,
      }),
    };
  });
  return { project: replaceFrames(project, frames), created: [], removed: [], notes };
}

function contextOwner(project: Project, id: string): Frame {
  const frame = frameById(project, id);
  if (frame.kind !== 'exercise') fail('E_CONTEXT', `Only exercises can have context; ${id} is a ${frame.kind}.`);
  if (frame.unit === undefined) return frame;
  return sortedParts(project.frames.filter((item) => item.unit === frame.unit))[0] as Frame;
}

function opContextAdd(project: Project, op: Extract<Operation, { op: 'context.add' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const owner = contextOwner(project, op.id);
  const region = regionOf({ page: op.page, rect: op.rect }, ctx, notes, `context of ${op.id}`, op.snap);
  const next = [...(owner.context ?? []), region];
  if (next.length > LIMITS.maxRegions) fail('E_CONTEXT', `${owner.id} would have ${next.length} context regions; at most ${LIMITS.maxRegions} are allowed.`, 'Merge regions that are next to each other.');
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === owner.id ? { ...item, context: next } : item))), created: [], removed: [], notes };
}

function opContextRemove(project: Project, op: Extract<Operation, { op: 'context.remove' }>): OpResult {
  const owner = contextOwner(project, op.id);
  const regions = owner.context ?? [];
  if (regions.length === 0) fail('E_CONTEXT', `${op.id} has no context to remove.`);
  let next: Region[];
  if (op.all === true) next = [];
  else if (op.index !== undefined) {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index >= regions.length) fail('E_CONTEXT', `${op.id} has ${regions.length} context region${regions.length === 1 ? '' : 's'}; index ${op.index} does not exist.`);
    next = regions.filter((_, index) => index !== op.index);
  } else if (regions.length === 1) next = [];
  else fail('E_CONTEXT', `${op.id} has ${regions.length} context regions: say which with "index" (0..${regions.length - 1}) or remove all with "all".`);
  return {
    project: replaceFrames(project, project.frames.map((item) => {
      if (item.id !== owner.id) return item;
      const copy = { ...item };
      if (next.length > 0) copy.context = next;
      else delete copy.context;
      return copy;
    })),
    created: [],
    removed: [],
    notes: [],
  };
}

function opContextSet(project: Project, op: Extract<Operation, { op: 'context.set' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const owner = contextOwner(project, op.id);
  const regions = op.regions.map((region, index) => regionOf(region, ctx, notes, `context[${index}] of ${op.id}`));
  if (regions.length > LIMITS.maxRegions) fail('E_CONTEXT', `At most ${LIMITS.maxRegions} context regions are allowed.`);
  return {
    project: replaceFrames(project, project.frames.map((item) => {
      if (item.id !== owner.id) return item;
      const copy = { ...item };
      if (regions.length > 0) copy.context = regions;
      else delete copy.context;
      return copy;
    })),
    created: [],
    removed: [],
    notes,
  };
}

function continuesOwner(project: Project, id: string): Frame {
  const frame = frameById(project, id);
  if (frame.unit !== undefined) fail('E_UNIT', `${id} is a part of unit "${frame.unit}" and cannot have "continues".`, 'Add a part (same unit) on the next page instead.');
  return frame;
}

function opContinuesAdd(project: Project, op: Extract<Operation, { op: 'continues.add' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const owner = continuesOwner(project, op.id);
  const region = regionOf({ page: op.page, rect: op.rect }, ctx, notes, `continuation of ${op.id}`, op.snap);
  const next = [...(owner.continues ?? []), region];
  if (next.length > LIMITS.maxRegions) fail('E_CONTINUES', `${owner.id} would have ${next.length} continuation regions; at most ${LIMITS.maxRegions} are allowed.`);
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === owner.id ? { ...item, continues: next } : item))), created: [], removed: [], notes };
}

function opContinuesRemove(project: Project, op: Extract<Operation, { op: 'continues.remove' }>): OpResult {
  const owner = continuesOwner(project, op.id);
  const regions = owner.continues ?? [];
  if (regions.length === 0) fail('E_CONTINUES', `${op.id} has no continuation regions.`);
  let next: Region[];
  if (op.all === true || (op.index === undefined && regions.length === 1)) next = [];
  else if (op.index !== undefined && Number.isInteger(op.index) && op.index >= 0 && op.index < regions.length) next = regions.filter((_, index) => index !== op.index);
  else fail('E_CONTINUES', `${op.id} has ${regions.length} continuation regions: say which with "index" (0..${regions.length - 1}) or remove all with "all".`);
  return {
    project: replaceFrames(project, project.frames.map((item) => {
      if (item.id !== owner.id) return item;
      const copy = { ...item };
      if (next.length > 0) copy.continues = next;
      else delete copy.continues;
      return copy;
    })),
    created: [],
    removed: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Authority and solutions

function opAuthorityMark(project: Project, op: Extract<Operation, { op: 'authority.mark' }>): OpResult {
  const notes: string[] = [];
  const frame = frameById(project, op.id);
  if (isAuthoritative(frame)) {
    fail('E_AUTHORITY', `${frame.id} is already an authoritative exercise (${bookReference(frame.section ?? '?', frame.label ?? '?')}).`, 'Change its number with "label.set" and its section with "section.set".');
  }
  if (frame.kind !== 'exercise') fail('E_AUTHORITY', `Only exercises can be authoritative; ${frame.id} is a ${frame.kind}.`, `Make it an exercise first: \`mcprep frames update ${frame.id} --kind exercise\`.`);
  if (frame.unit !== undefined) {
    fail(
      'E_AUTHORITY_UNIT',
      `${frame.id} is a part of the unit "${frame.unit}", and an authoritative exercise is a single exercise.`,
      `Merge the parts first (\`mcprep frames merge --unit ${frame.unit}\`) and mark the merged exercise, or delete them and add one exercise per printed label. ${PARTS_CONVENTION}`,
    );
  }
  const label = checkLabel(op.label, frame.id, notes);
  const section = checkSectionId(op.section, frame.id);
  const next: Frame = { ...frame, authority: 'book', label, section };
  notes.push(`${frame.id} is now the exercise ${bookReference(section, label)}; it has no positional number any more.`);
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === frame.id ? next : item))), created: [], removed: [], notes, target: frame.id };
}

function opAuthorityUnmark(project: Project, op: Extract<Operation, { op: 'authority.unmark' }>): OpResult {
  const frame = frameById(project, op.id);
  if (frame.authority === undefined && frame.label === undefined && frame.section === undefined) {
    fail('E_AUTHORITY', `${frame.id} is not an authoritative exercise.`, 'Only exercises with an authority, label and section can be unmarked.');
  }
  const next: Frame = { ...frame };
  delete next.authority;
  delete next.label;
  delete next.section;
  return {
    project: replaceFrames(project, project.frames.map((item) => (item.id === frame.id ? next : item))),
    created: [],
    removed: [],
    notes: [`${frame.id} is an ordinary exercise again: it gets a positional number and can be cut into parts.`],
    target: frame.id,
  };
}

function authoritativeFrame(project: Project, id: string, action: string): Frame {
  const frame = frameById(project, id);
  if (!isAuthoritative(frame)) {
    fail('E_AUTHORITY', `${frame.id} is not an authoritative exercise, so it has no ${action}.`, `Make it one first: \`mcprep exercises mark ${frame.id} --label <label> --section <id>\`.`);
  }
  return frame;
}

function opLabelSet(project: Project, op: Extract<Operation, { op: 'label.set' }>): OpResult {
  const notes: string[] = [];
  const frame = authoritativeFrame(project, op.id, 'label');
  const label = checkLabel(op.label, frame.id, notes);
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === frame.id ? { ...item, label } : item))), created: [], removed: [], notes, target: frame.id };
}

function opSectionSet(project: Project, op: Extract<Operation, { op: 'section.set' }>): OpResult {
  const frame = authoritativeFrame(project, op.id, 'section');
  const section = checkSectionId(op.section, frame.id);
  return { project: replaceFrames(project, project.frames.map((item) => (item.id === frame.id ? { ...item, section } : item))), created: [], removed: [], notes: [], target: frame.id };
}

function solutionOwner(project: Project, id: string): Frame {
  const frame = frameById(project, id);
  if (frame.kind !== 'exercise') fail('E_SOLUTION', `Only exercises can have a solution; ${frame.id} is a ${frame.kind}.`);
  return frame;
}

function withSolution(project: Project, frame: Frame, regions: Region[]): Project {
  return replaceFrames(
    project,
    project.frames.map((item) => {
      if (item.id !== frame.id) return item;
      const copy = { ...item };
      if (regions.length > 0) copy.solution = regions;
      else delete copy.solution;
      return copy;
    }),
  );
}

function opSolutionAdd(project: Project, op: Extract<Operation, { op: 'solution.add' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const owner = solutionOwner(project, op.id);
  const region = regionOf({ page: op.page, rect: op.rect }, ctx, notes, `solution of ${owner.id}`, op.snap);
  const next = [...(owner.solution ?? []), region];
  if (next.length > LIMITS.maxSolutionRegions) fail('E_SOLUTION', `${owner.id} would have ${next.length} solution regions; at most ${LIMITS.maxSolutionRegions} are allowed.`, 'Merge regions that are next to each other (one block of the answer key can answer several lines).');
  return { project: withSolution(project, owner, next), created: [], removed: [], notes, target: owner.id };
}

function opSolutionRemove(project: Project, op: Extract<Operation, { op: 'solution.remove' }>): OpResult {
  const owner = solutionOwner(project, op.id);
  const regions = owner.solution ?? [];
  if (regions.length === 0) fail('E_SOLUTION', `${owner.id} has no solution regions to remove.`);
  let next: Region[];
  if (op.all === true) next = [];
  else if (op.index !== undefined) {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index >= regions.length) fail('E_SOLUTION', `${owner.id} has ${regions.length} solution region${regions.length === 1 ? '' : 's'}; index ${op.index} does not exist.`, `Use an index from 0 to ${regions.length - 1}.`);
    next = regions.filter((_, index) => index !== op.index);
  } else if (regions.length === 1) next = [];
  else fail('E_SOLUTION', `${owner.id} has ${regions.length} solution regions: say which with "index" (0..${regions.length - 1}) or remove all with "all".`);
  return { project: withSolution(project, owner, next), created: [], removed: [], notes: [], target: owner.id };
}

function opSolutionSet(project: Project, op: Extract<Operation, { op: 'solution.set' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const owner = solutionOwner(project, op.id);
  if (!Array.isArray(op.regions)) fail('E_SOLUTION', 'solution.set needs a list of regions {page, rect}.');
  if (op.regions.length > LIMITS.maxSolutionRegions) fail('E_SOLUTION', `At most ${LIMITS.maxSolutionRegions} solution regions are allowed, not ${op.regions.length}.`, 'Merge regions that are next to each other.');
  const regions = op.regions.map((region, index) => regionOf(region, ctx, notes, `solution[${index}] of ${owner.id}`));
  return { project: withSolution(project, owner, regions), created: [], removed: [], notes, target: owner.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outline (the sections of a book) and the document's own information

const outlineEntriesOf = (project: Project): OutlineEntry[] => project.outline?.entries ?? [];

/** The project with these outline entries (cleaned); `source` records where the outline came from. */
function withOutline(project: Project, entries: OutlineEntry[], ctx: OpContext, source: OutlineSource): Project {
  return { ...project, outline: { source, entries: normalizeOutline(entries, ctx.pageCount) } };
}

/** Checks the optional fields of an outline entry an operation was given and returns them. */
function outlineFields(input: { id?: unknown; label?: unknown; top?: unknown }, where: string): Pick<OutlineEntry, 'id' | 'label' | 'top'> {
  const out: Pick<OutlineEntry, 'id' | 'label' | 'top'> = {};
  if (input.id !== undefined && input.id !== null) {
    if (typeof input.id !== 'string' || !LIMITS.sectionIdPattern.test(input.id)) {
      fail('E_OUTLINE', `The id of ${where} must be 1 to ${LIMITS.sectionIdMax} characters of A-Z a-z 0-9 . _ - starting with a letter or digit, not ${JSON.stringify(input.id)}.`, 'Use something like "1.2" or "c3".');
    }
    out.id = input.id;
  }
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== 'string' || input.label.trim().length > LIMITS.outlineLabelMax) {
      fail('E_OUTLINE', `The label of ${where} must be a text of at most ${LIMITS.outlineLabelMax} characters.`, 'The label is the number printed with the heading ("1.1", "Chapter 3").');
    }
    if (input.label.trim() !== '') out.label = input.label.trim();
  }
  if (input.top !== undefined && input.top !== null) {
    if (typeof input.top !== 'number' || !Number.isFinite(input.top) || input.top < 0 || input.top > 1) {
      fail('E_OUTLINE', `The top of ${where} must be a number from 0 to 1 (where the heading starts on its page, from the top), not ${JSON.stringify(input.top)}.`);
    }
    out.top = roundNumber(input.top);
  }
  return out;
}

function checkEntryList(entries: readonly OutlineEntry[], ctx: OpContext): OutlineEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.title !== 'string') fail('E_OUTLINE', `Outline entry ${index} needs a "title".`);
    assertPage(entry.page, ctx, `outline entry ${index} page`);
    const where = `outline entry ${index} ("${entry.title.trim().slice(0, 40)}")`;
    const fields = outlineFields(entry, where);
    if (fields.id !== undefined) {
      const first = seen.get(fields.id);
      if (first !== undefined) fail('E_OUTLINE', `The id "${fields.id}" is given to outline entries ${first} and ${index}.`, 'Every outline entry that exercises refer to needs an id of its own.');
      seen.set(fields.id, index);
    }
    return { title: entry.title, page: entry.page, depth: typeof entry.depth === 'number' ? entry.depth : 0, ...fields };
  });
}

function opOutlineSet(project: Project, op: Extract<Operation, { op: 'outline.set' }>, ctx: OpContext): OpResult {
  if (!Array.isArray(op.entries)) fail('E_OUTLINE', 'outline.set needs a list of entries {title, page, depth}.');
  const entries = checkEntryList(op.entries, ctx);
  const normalized = normalizeOutline(entries, ctx.pageCount);
  const notes = normalized.length !== entries.length ? [`${entries.length - normalized.length} entries with an empty title were dropped.`] : [];
  return { project: { ...project, outline: { source: op.source ?? 'manual', entries: normalized } }, created: [], removed: [], notes };
}

/** The position of the entry an operation names, by `id` or by `index` (from 0). */
function entryPosition(project: Project, op: { id?: string | undefined; index?: number | undefined }): number {
  const entries = outlineEntriesOf(project);
  if (op.id === undefined && op.index === undefined) fail('E_OUTLINE', 'Name the outline entry by its "id" or its "index" (its position in the outline, from 0).', 'List the entries with `mcprep outline`.');
  if (op.id !== undefined) {
    const at = entries.findIndex((entry) => entry.id === op.id);
    if (at < 0) {
      const known = entries.filter((entry) => entry.id !== undefined).map((entry) => entry.id as string);
      fail('E_NO_SECTION', `There is no outline entry with the id "${op.id}".`, known.length > 0 ? `Known ids: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', ...' : ''}. List them with \`mcprep outline\`.` : 'No entry has an id yet: give them ids with `mcprep outline ids`.');
    }
    if (op.index !== undefined && op.index !== at) fail('E_OUTLINE', `The id "${op.id}" is outline entry ${at}, not ${op.index}.`);
    return at;
  }
  const index = op.index as number;
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) fail('E_NO_SECTION', `The outline has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; there is no entry ${index}.`, entries.length > 0 ? `Use an index from 0 to ${entries.length - 1}.` : 'The outline is empty.');
  return index;
}

function opOutlineAdd(project: Project, op: Extract<Operation, { op: 'outline.add' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  assertPage(op.page, ctx, 'outline page');
  if (typeof op.title !== 'string') fail('E_OUTLINE', 'outline.add needs a "title".');
  const existing = outlineEntriesOf(project);
  const fields = outlineFields(op, 'the new outline entry');
  if (fields.id !== undefined && existing.some((entry) => entry.id === fields.id)) {
    fail('E_OUTLINE_ID_TAKEN', `The id "${fields.id}" is already the id of another outline entry.`, 'Leave the id out to get a generated one, or use `outline update` to change the entry that has it.');
  }
  const at = op.at === undefined ? existing.length : op.at;
  if (!Number.isInteger(at) || at < 0 || at > existing.length) fail('E_OUTLINE', `"at" must be a position from 0 to ${existing.length}, not ${JSON.stringify(op.at)}.`);
  const entry: OutlineEntry = { title: op.title, page: op.page, depth: op.depth ?? 0, ...fields };
  if (fields.id === undefined && op.autoId === true) {
    const used = new Set(existing.map((item) => item.id).filter((id): id is string => id !== undefined));
    entry.id = deriveSectionId(entry, at, used);
    notes.push(`The new entry got the id "${entry.id}"; exercises name it with --section ${entry.id}.`);
  }
  const entries = [...existing.slice(0, at), entry, ...existing.slice(at)];
  return { project: withOutline(project, entries, ctx, 'manual'), created: [], removed: [], notes };
}

/** Frames of the project that name a section (authoritative exercises). */
const framesInSection = (project: Project, id: string): Frame[] => project.frames.filter((frame) => isAuthoritative(frame) && frame.section === id);

function opOutlineUpdate(project: Project, op: Extract<Operation, { op: 'outline.update' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const at = entryPosition(project, op);
  const entries = outlineEntriesOf(project).map((entry) => ({ ...entry }));
  const entry = entries[at] as OutlineEntry;
  const where = `outline entry ${at} ("${entry.title.slice(0, 40)}")`;
  if (op.title !== undefined) {
    if (typeof op.title !== 'string' || op.title.trim() === '') fail('E_OUTLINE', `The title of ${where} must not be empty.`);
    entry.title = op.title;
  }
  if (op.page !== undefined) entry.page = assertPage(op.page, ctx, 'outline page');
  if (op.depth !== undefined) {
    if (!Number.isInteger(op.depth) || op.depth < 0 || op.depth > LIMITS.outlineDepthMax) fail('E_OUTLINE', `The depth of ${where} must be a whole number from 0 to ${LIMITS.outlineDepthMax}.`);
    entry.depth = op.depth;
  }
  if (op.label !== undefined) {
    const fields = outlineFields({ label: op.label }, where);
    if (fields.label === undefined) delete entry.label;
    else entry.label = fields.label;
  }
  if (op.top !== undefined) {
    const fields = outlineFields({ top: op.top }, where);
    if (fields.top === undefined) delete entry.top;
    else entry.top = fields.top;
  }
  let frames = project.frames;
  if (op.newId !== undefined) {
    const old = entry.id;
    if (op.newId === null) {
      const using = old === undefined ? [] : framesInSection(project, old);
      if (using.length > 0) fail('E_SECTION_IN_USE', `${where} is the section of ${using.length} exercise${using.length === 1 ? '' : 's'} (${using.slice(0, 5).map((frame) => frame.id).join(', ')}${using.length > 5 ? ', ...' : ''}); it cannot lose its id.`, 'Rename it instead (--new-id), or move the exercises to another section first.');
      delete entry.id;
    } else {
      const fields = outlineFields({ id: op.newId }, where);
      const id = fields.id as string;
      if (entries.some((other, index) => index !== at && other.id === id)) fail('E_OUTLINE_ID_TAKEN', `The id "${id}" is already the id of another outline entry.`);
      entry.id = id;
      if (old !== undefined && old !== id) {
        let moved = 0;
        frames = frames.map((frame) => {
          if (!isAuthoritative(frame) || frame.section !== old) return frame;
          moved += 1;
          return { ...frame, section: id };
        });
        if (moved > 0) notes.push(`The ${moved} exercise${moved === 1 ? '' : 's'} of section "${old}" now name "${id}".`);
      }
    }
  }
  return { project: withOutline({ ...project, frames }, entries, ctx, 'manual'), created: [], removed: [], notes };
}

function opOutlineDelete(project: Project, op: Extract<Operation, { op: 'outline.delete' }>, ctx: OpContext): OpResult {
  const notes: string[] = [];
  const at = entryPosition(project, op);
  const entries = outlineEntriesOf(project);
  const entry = entries[at] as OutlineEntry;
  let end = at + 1;
  while (end < entries.length && (entries[end] as OutlineEntry).depth > entry.depth) end += 1;
  const removed = op.subtree === true ? entries.slice(at, end) : [entry];
  const ids = new Set(removed.map((item) => item.id).filter((id): id is string => id !== undefined));
  const using = project.frames.filter((frame) => isAuthoritative(frame) && frame.section !== undefined && ids.has(frame.section));
  if (using.length > 0) {
    fail(
      'E_SECTION_IN_USE',
      `${using.length} exercise${using.length === 1 ? ' is' : 's are'} filed under ${ids.size === 1 ? `the section "${[...ids][0] as string}"` : 'these sections'} (${using.slice(0, 5).map((frame) => frame.id).join(', ')}${using.length > 5 ? ', ...' : ''}); deleting ${op.subtree === true ? 'them' : 'it'} would leave them without a section.`,
      'Move them first (`mcprep exercises section <frame> <section>`), or delete them, then delete the section.',
    );
  }
  const next = op.subtree === true ? [...entries.slice(0, at), ...entries.slice(end)] : entries.map((item, index) => (index > at && index < end ? { ...item, depth: Math.max(0, item.depth - 1) } : item)).filter((_, index) => index !== at);
  if (op.subtree !== true && end > at + 1) notes.push(`The ${end - at - 1} entr${end - at - 1 === 1 ? 'y' : 'ies'} below it moved up one level.`);
  return { project: withOutline(project, next, ctx, 'manual'), created: [], removed: [], notes };
}

function opOutlineIds(project: Project, ctx: OpContext): OpResult {
  const entries = outlineEntriesOf(project);
  if (entries.length === 0) fail('E_OUTLINE', 'The project has no outline entries to give ids to.', 'Make the outline first (`outline pdf --adopt`, `outline derive` or `outline set`).');
  const assigned = assignSectionIds(entries);
  const notes =
    assigned.assigned.length === 0
      ? ['Every outline entry already has an id.']
      : [`Gave ${assigned.assigned.length} entr${assigned.assigned.length === 1 ? 'y' : 'ies'} an id (${assigned.assigned.slice(0, 8).map((item) => `${item.index}: ${item.id}`).join(', ')}${assigned.assigned.length > 8 ? ', ...' : ''}).`];
  return { project: withOutline(project, assigned.entries, ctx, project.outline?.source ?? 'manual'), created: [], removed: [], notes };
}

function opMetaSet(project: Project, op: Extract<Operation, { op: 'meta.set' }>): OpResult {
  const meta = { ...project.meta };
  if (op.title !== undefined) {
    const checked = checkTitle(op.title);
    if (checked.problem) fail('E_TITLE', checked.problem, 'A title is 1 to 200 characters.');
    meta.title = checked.title as string;
  }
  if (op.folder !== undefined) {
    if (op.folder === null || op.folder.trim() === '') delete meta.folder;
    else meta.folder = folderFromInput(op.folder);
  }
  // The document info: undefined leaves a field, null or an empty text removes it, a text sets it.
  const info: DocumentInfo = {};
  const texts = ['author', 'series', 'description', 'notice', 'sourceUrl'] as const;
  for (const key of texts) {
    const value = op[key];
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && value.trim() === '')) delete meta[key];
    else info[key] = value;
  }
  if (op.license !== undefined) {
    if (op.license === null) delete meta.license;
    else if (typeof op.license !== 'object' || typeof op.license.name !== 'string') fail('E_META', 'The license needs a name: { "name": "CC BY 3.0", "url": "https://..." }.');
    else info.license = op.license.url === undefined || op.license.url === null ? { name: op.license.name } : { name: op.license.name, url: op.license.url };
  }
  if (Object.keys(info).length > 0) {
    const checked = checkDocumentInfo(info, { strict: true, where: 'meta' });
    const first = checked.issues.find((item) => item.severity === 'error');
    if (first) fail('E_META', first.message, first.fix);
    Object.assign(meta, checked.info);
  }
  return { project: { ...project, meta }, created: [], removed: [], notes: [] };
}

/** Applies one operation. Throws `McPrepError` (code E_...) with a hint when it cannot be applied. */
export function applyOperation(project: Project, op: Operation, ctx: OpContext): OpResult {
  return applyOne(withSequenceBeyondIds(project), op, ctx);
}

function applyOne(project: Project, op: Operation, ctx: OpContext): OpResult {
  switch (op.op) {
    case 'add':
      return opAdd(project, op, ctx);
    case 'update':
      return opUpdate(project, op, ctx);
    case 'delete':
      return opDelete(project, op);
    case 'move':
      return opMove(project, op);
    case 'split':
      return opSplit(project, op, ctx);
    case 'merge':
      return opMerge(project, op);
    case 'dividers':
      return opDividers(project, op, ctx);
    case 'area':
      return opArea(project, op, ctx);
    case 'context.add':
      return opContextAdd(project, op, ctx);
    case 'context.remove':
      return opContextRemove(project, op);
    case 'context.set':
      return opContextSet(project, op, ctx);
    case 'continues.add':
      return opContinuesAdd(project, op, ctx);
    case 'continues.remove':
      return opContinuesRemove(project, op);
    case 'authority.mark':
      return opAuthorityMark(project, op);
    case 'authority.unmark':
      return opAuthorityUnmark(project, op);
    case 'label.set':
      return opLabelSet(project, op);
    case 'section.set':
      return opSectionSet(project, op);
    case 'solution.add':
      return opSolutionAdd(project, op, ctx);
    case 'solution.remove':
      return opSolutionRemove(project, op);
    case 'solution.set':
      return opSolutionSet(project, op, ctx);
    case 'outline.set':
      return opOutlineSet(project, op, ctx);
    case 'outline.add':
      return opOutlineAdd(project, op, ctx);
    case 'outline.update':
      return opOutlineUpdate(project, op, ctx);
    case 'outline.delete':
      return opOutlineDelete(project, op, ctx);
    case 'outline.ids':
      return opOutlineIds(project, ctx);
    case 'outline.clear': {
      const next = { ...project };
      delete next.outline;
      return { project: next, created: [], removed: [], notes: [] };
    }
    case 'meta.set':
      return opMetaSet(project, op);
    default: {
      const name = (op as { op?: unknown }).op;
      return fail('E_OP', `Unknown operation ${JSON.stringify(name)}.`, `Known operations: ${OPERATION_NAMES.join(', ')}.`);
    }
  }
}

export interface BatchResult extends OpResult {
  /** Per operation: what it created, removed and noted (and which authoritative exercises it replaced in place). */
  steps: { index: number; op: string; created: string[]; removed: string[]; notes: string[]; replaced?: string[] }[];
}

/** `@name` in `id`, `ids` or `unit` stands for the frame that an earlier `add` with `"ref": "name"` created. */
function resolveReferences(op: Operation, aliases: ReadonlyMap<string, string>): Operation {
  const resolve = (value: string): string => {
    if (!value.startsWith('@')) return value;
    const found = aliases.get(value.slice(1));
    if (found === undefined) {
      fail('E_REF', `The reference ${value} is not defined.`, 'An earlier "add" operation must carry "ref": "' + value.slice(1) + '" in the same batch.');
    }
    return found;
  };
  const copy: Record<string, unknown> = { ...op };
  for (const field of ['id', 'unit'] as const) {
    const value = copy[field];
    if (typeof value === 'string') copy[field] = resolve(value);
  }
  if (Array.isArray(copy['ids'])) copy['ids'] = (copy['ids'] as unknown[]).map((value) => (typeof value === 'string' ? resolve(value) : value));
  return copy as unknown as Operation;
}

/** Applies the operations in order; the first failure aborts the whole batch (nothing is partly applied). */
export function applyOperations(project: Project, operations: readonly Operation[], ctx: OpContext): BatchResult {
  // Once, here: the counter of generated ids goes above every id the project holds, so each operation can rely on it.
  let current = withSequenceBeyondIds(project);
  const steps: BatchResult['steps'] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const replaced: string[] = [];
  const notes: string[] = [];
  const aliases = new Map<string, string>();
  operations.forEach((original, index) => {
    let op = original;
    try {
      if (typeof op !== 'object' || op === null) fail('E_OP', 'An operation must be an object with an "op" field.');
      op = resolveReferences(op, aliases);
      const result = applyOne(current, op, ctx);
      current = result.project;
      if (op.op === 'add' && op.ref !== undefined) {
        if (!LIMITS.idPattern.test(op.ref)) fail('E_REF', `The reference name "${op.ref}" is not valid: use 1 to 40 characters of A-Z a-z 0-9 _ -.`);
        if (aliases.has(op.ref)) fail('E_REF', `The reference "${op.ref}" is defined twice.`);
        aliases.set(op.ref, (result.target ?? result.created[0]) as string);
      }
      steps.push({ index, op: op.op, created: result.created, removed: result.removed, notes: result.notes, ...(result.replaced && result.replaced.length > 0 ? { replaced: result.replaced } : {}) });
      created.push(...result.created);
      removed.push(...result.removed);
      replaced.push(...(result.replaced ?? []));
      notes.push(...result.notes);
    } catch (error) {
      if (error instanceof McPrepError) {
        throw new McPrepError(error.code, `Operation ${index} (${String((op as { op?: unknown } | null)?.op)}): ${error.message}`, {
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          details: { ...(error.details ?? {}), operation: index, op },
        });
      }
      throw error;
    }
  });
  return { project: current, created, removed, notes, steps, ...(replaced.length > 0 ? { replaced } : {}) };
}
