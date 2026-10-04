import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bookExercisesInOrder } from '../book/summary.js';
import { bookReference, isAuthoritative, normalizeLabel } from '../model/authority.js';
import type { Frame, Region } from '../model/types.js';
import { runGate, type GateRunOptions } from '../gate/run.js';
import type { GateFinding } from '../gate/types.js';
import type { Project } from '../project/model.js';
import { ProjectSession } from '../session.js';

/**
 * A proof that the audit harness has teeth: a project that is clean is damaged in a seeded, reproducible way (a region moved, shrunk or
 * grown so that it cuts a line or swallows a neighbour, a label changed, an exercise deleted or duplicated, solutions swapped or
 * pointed at another section, a context dropped or wrong, a continuation left out, a stray region added), and the gate must not pass
 * and must name the exercise. Used by the tests and by scripts/inject-defects.mjs. Everything here is pure except `evaluateDefects`.
 */

export interface DefectExpectation {
  /** The finding must be one of these codes ... */
  codes: readonly string[];
  /** ... and name one of these (the reference of the exercise, a section, a frame id). */
  refs: readonly string[];
}

export interface DefectCase {
  id: string;
  type: string;
  description: string;
  project: Project;
  expect: DefectExpectation;
}

export interface DefectType {
  type: string;
  /** What it does, for the report. */
  what: string;
  /** The project it is injected into. */
  on: 'workbook' | 'span';
}

export const DEFECT_TYPES: readonly DefectType[] = [
  { type: 'region-cut-top', on: 'workbook', what: 'the top edge moves down into the text of the exercise (its first line is cut)' },
  { type: 'region-cut-top-hair', on: 'workbook', what: 'the top edge moves down by 0.010 of the page, 8.4 points: it cuts the first line by a hair (the tops of the capitals and digits, about a point, are flattened)' },
  { type: 'region-cut-top-graze', on: 'workbook', what: 'the top edge moves down by 0.009 of the page, 7.6 points: it grazes the first line (a third of a point of the tallest glyphs is cut, under one pixel at 2 pixels per point)' },
  { type: 'region-cut-bottom', on: 'workbook', what: 'the bottom edge moves up so that the last lines are left out' },
  { type: 'region-grow', on: 'workbook', what: 'the region grows down over the next exercise' },
  { type: 'region-move', on: 'workbook', what: 'the region moves down by more than its height (onto the text of another exercise)' },
  { type: 'label-change', on: 'workbook', what: 'the label is not the number the book prints' },
  { type: 'exercise-delete', on: 'workbook', what: 'an exercise is missing' },
  { type: 'exercise-duplicate', on: 'workbook', what: 'an exercise is there twice' },
  { type: 'solutions-swapped', on: 'workbook', what: 'the answers of two exercises of a section are swapped' },
  { type: 'solution-other-section', on: 'workbook', what: 'an exercise points at the answer of another section' },
  { type: 'solution-deleted', on: 'workbook', what: 'the answer of an exercise is missing' },
  { type: 'context-dropped', on: 'workbook', what: 'an exercise in a group has lost the instruction its neighbours share' },
  { type: 'context-dropped-start', on: 'workbook', what: 'the first exercise of a group has lost the instruction printed right above it (an exercise put back without it)' },
  { type: 'context-dropped-end', on: 'workbook', what: 'the last exercise of a group has lost the instruction of the exercises before it' },
  { type: 'context-wrong', on: 'workbook', what: 'an exercise has the instruction of another group' },
  { type: 'continuation-left-out', on: 'workbook', what: 'an exercise that goes on over a page break has lost its continuation' },
  { type: 'stray-frame', on: 'workbook', what: 'a frame that no book exercise is' },
  { type: 'stray-exercise', on: 'workbook', what: 'an extra book exercise framed over the text of another' },
  { type: 'span-middle-deleted', on: 'span', what: 'the middle continuation of an exercise on three pages is deleted' },
  { type: 'span-swapped', on: 'span', what: 'two continuations of a span are swapped' },
  { type: 'span-shrunk', on: 'span', what: 'a continuation is shrunk so that it leaves text out' },
];

/** What the checks cannot see; the report says so (docs/AUDIT_A_BOOK.md, "The gate"). */
export const INVISIBLE_DEFECTS: readonly string[] = [
  'a continuation that holds no text (a figure) left out',
  'an instruction dropped from an exercise that is alone in its group (nothing else carries it, so only the unattached line shows, as text left behind)',
  'a region that is too large on blank paper (it holds nothing a learner would miss)',
  'an edge that cuts no glyph: between two words, or in the white a fraction of a point above the ink (a top edge moved down by 0.008 of the page leaves a third of a point and only touches the first line); the pixel check finds an edge that the ink goes across at 2 pixels or more',
  'two exercises swapped whose answers are swapped too',
];

/** A small seeded generator (mulberry32): the same seed always damages the same things. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const height = (frame: Frame): number => frame.rect.bottom - frame.rect.top;
const refOf = (frame: Frame): string => bookReference(frame.section as string, normalizeLabel(frame.label as string).label);
const contextKey = (frame: Frame): string => JSON.stringify((frame.context ?? []).map((region) => [region.page, region.rect.top.toFixed(4), region.rect.left.toFixed(4)]));
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

interface Context {
  project: Project;
  ordered: Frame[];
  pick<T>(list: readonly T[]): T | undefined;
}

type Made = { description: string; expect: DefectExpectation };
type Generator = (frames: Map<string, Frame>, context: Context) => Made | undefined;

const bookFrames = (context: Context): Frame[] => context.ordered.filter((frame) => frame.unit === undefined);

/** The exercises of a book in a group that shares an instruction: a neighbour before and after share one context, and so does the exercise. */
function insideGroups(context: Context): Frame[] {
  const result: Frame[] = [];
  const list = context.ordered;
  for (let i = 1; i + 1 < list.length; i += 1) {
    const [before, here, after] = [list[i - 1] as Frame, list[i] as Frame, list[i + 1] as Frame];
    if (before.section !== here.section || after.section !== here.section) continue;
    const key = contextKey(here);
    if (key !== '[]' && contextKey(before) === key && contextKey(after) === key) result.push(here);
  }
  return result;
}

/** The exercises that start a group of three or more that share an instruction (the one before has another, or none), and those that end one. */
function groupEnds(context: Context, which: 'start' | 'end'): Frame[] {
  const result: Frame[] = [];
  const list = context.ordered;
  for (let i = 0; i < list.length; i += 1) {
    const here = list[i] as Frame;
    const key = contextKey(here);
    if (key === '[]') continue;
    const before = list[i - 1];
    const after = list[i + 1];
    const sameBefore = before !== undefined && before.section === here.section && contextKey(before) === key;
    const sameAfter = after !== undefined && after.section === here.section && contextKey(after) === key;
    const further = list[i + (which === 'start' ? 2 : -2)];
    const group = which === 'start' ? !sameBefore && sameAfter && further !== undefined && contextKey(further) === key : sameBefore && !sameAfter && further !== undefined && contextKey(further) === key;
    if (group) result.push(here);
  }
  return result;
}

const GENERATORS: Record<string, Generator> = {
  'region-cut-top': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => height(frame) <= 0.03));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.rect = { ...mine.rect, top: mine.rect.top + 0.85 * height(target) };
    return { description: `${refOf(target)}: the top edge moves down into its text`, expect: { codes: ['label-not-first', 'no-text', 'numbered-text-left-behind', 'text-left-behind'], refs: [refOf(target), target.section as string] } };
  },
  // The synthetic workbook leaves 7.1 to 7.3 points (0.0084 to 0.0087 of the page) of white above the first ink of an exercise: a shift of 0.008
  // or less cuts nothing (0.004 leaves 3.8 points, 0.008 leaves a third of a point and only touches), 0.009 cuts a third of a point and 0.010
  // a point and a quarter. The text checks cannot see any of these; the pixel check of the edges can.
  'region-cut-top-hair': (frames, context) => {
    const target = context.pick(bookFrames(context));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.rect = { ...mine.rect, top: mine.rect.top + 0.01 };
    return { description: `${refOf(target)}: the top edge cuts its first line by a hair`, expect: { codes: ['edge-on-ink'], refs: [refOf(target)] } };
  },
  'region-cut-top-graze': (frames, context) => {
    const target = context.pick(bookFrames(context));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.rect = { ...mine.rect, top: mine.rect.top + 0.009 };
    return { description: `${refOf(target)}: the top edge grazes its first line`, expect: { codes: ['edge-on-ink'], refs: [refOf(target)] } };
  },
  'region-cut-bottom': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => height(frame) >= 0.045 && frame.continues === undefined));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.rect = { ...mine.rect, bottom: mine.rect.top + 0.45 * height(target) };
    return { description: `${refOf(target)}: the bottom edge moves up, the last lines are left out`, expect: { codes: ['text-left-behind', 'region-open-end', 'numbered-text-left-behind', 'label-not-first'], refs: [refOf(target), target.section as string] } };
  },
  'region-grow': (frames, context) => {
    const pairs: [Frame, Frame][] = [];
    context.ordered.forEach((frame, index) => {
      const next = context.ordered[index + 1];
      if (next && next.section === frame.section && next.page === frame.page && Math.abs(next.rect.left - frame.rect.left) < 0.05 && next.rect.top >= frame.rect.bottom - 0.001) pairs.push([frame, next]);
    });
    const chosen = context.pick(pairs);
    if (!chosen) return undefined;
    const [target, next] = chosen;
    const mine = frames.get(target.id) as Frame;
    mine.rect = { ...mine.rect, bottom: clamp(next.rect.top + 0.6 * height(next)) };
    return { description: `${refOf(target)}: the region grows down over ${refOf(next)}`, expect: { codes: ['overlap', 'region-holds-item', 'label-not-first'], refs: [refOf(target), refOf(next)] } };
  },
  'region-move': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => frame.rect.bottom + 1.4 * height(frame) < 0.95));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    const shift = 1.3 * height(target);
    mine.rect = { ...mine.rect, top: mine.rect.top + shift, bottom: mine.rect.bottom + shift };
    return { description: `${refOf(target)}: the region moves down by more than its height`, expect: { codes: ['label-not-first', 'no-text', 'overlap', 'numbered-text-left-behind', 'text-left-behind'], refs: [refOf(target), target.section as string] } };
  },
  'label-change': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => /^\d+$/.test(frame.label as string)));
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.label = String(Number(target.label) + 500);
    return { description: `${refOf(target)}: the label becomes ${mine.label}`, expect: { codes: ['label-not-first', 'label-outlier', 'gap'], refs: [`${target.section as string}:${mine.label}`, refOf(target), target.section as string] } };
  },
  'exercise-delete': (frames, context) => {
    const target = context.pick(bookFrames(context));
    if (!target) return undefined;
    frames.delete(target.id);
    return { description: `${refOf(target)}: deleted`, expect: { codes: ['numbered-text-left-behind', 'answer-left-behind', 'gap'], refs: [refOf(target), `key:${target.label as string}`, target.section as string] } };
  },
  'exercise-duplicate': (frames, context) => {
    const target = context.pick(bookFrames(context));
    if (!target) return undefined;
    const copy: Frame = { ...structuredClone(target), id: `${target.id}-copy` };
    frames.set(copy.id, copy);
    return { description: `${refOf(target)}: there twice (frame ${copy.id})`, expect: { codes: ['duplicate', 'duplicate-region', 'overlap', 'frame-duplicate', 'book-duplicate'], refs: [refOf(target), copy.id, target.id] } };
  },
  'solutions-swapped': (frames, context) => {
    const pairs: [Frame, Frame][] = [];
    context.ordered.forEach((frame, index) => {
      const next = context.ordered[index + 2];
      if (next && next.section === frame.section && frame.solution?.length && next.solution?.length) pairs.push([frame, next]);
    });
    const chosen = context.pick(pairs);
    if (!chosen) return undefined;
    const [a, b] = chosen;
    const [one, two] = [frames.get(a.id) as Frame, frames.get(b.id) as Frame];
    [one.solution, two.solution] = [two.solution, one.solution];
    return { description: `${refOf(a)} and ${refOf(b)}: the answers are swapped`, expect: { codes: ['solution-label-missing', 'solution-order', 'solution-section-mismatch'], refs: [refOf(a), refOf(b)] } };
  },
  'solution-other-section': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => frame.solution?.length));
    if (!target) return undefined;
    const other = context.pick(bookFrames(context).filter((frame) => frame.section !== target.section && frame.solution?.length));
    if (!other) return undefined;
    (frames.get(target.id) as Frame).solution = structuredClone(other.solution) as Region[];
    return { description: `${refOf(target)}: its answer is the one of ${refOf(other)}`, expect: { codes: ['solution-label-missing', 'solution-section-mismatch'], refs: [refOf(target)] } };
  },
  'solution-deleted': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => frame.solution?.length));
    if (!target) return undefined;
    delete (frames.get(target.id) as Frame).solution;
    return { description: `${refOf(target)}: its answer is missing`, expect: { codes: ['answer-left-behind', 'no-solution'], refs: [refOf(target), `key:${target.label as string}`, target.section as string] } };
  },
  'context-dropped': (frames, context) => {
    const target = context.pick(insideGroups(context));
    if (!target) return undefined;
    delete (frames.get(target.id) as Frame).context;
    return { description: `${refOf(target)}: its instruction is dropped`, expect: { codes: ['context-inconsistent'], refs: [refOf(target)] } };
  },
  'context-dropped-start': (frames, context) => {
    const target = context.pick(groupEnds(context, 'start'));
    if (!target) return undefined;
    delete (frames.get(target.id) as Frame).context;
    return { description: `${refOf(target)}: the first of its group, its instruction is dropped`, expect: { codes: ['context-inconsistent'], refs: [refOf(target)] } };
  },
  'context-dropped-end': (frames, context) => {
    const target = context.pick(groupEnds(context, 'end'));
    if (!target) return undefined;
    delete (frames.get(target.id) as Frame).context;
    return { description: `${refOf(target)}: the last of its group, its instruction is dropped`, expect: { codes: ['context-inconsistent'], refs: [refOf(target)] } };
  },
  'context-wrong': (frames, context) => {
    const target = context.pick(insideGroups(context));
    if (!target) return undefined;
    const other = context.pick(context.ordered.filter((frame) => frame.context?.length && contextKey(frame) !== contextKey(target)));
    if (!other) return undefined;
    (frames.get(target.id) as Frame).context = structuredClone(other.context) as Region[];
    return { description: `${refOf(target)}: it has the instruction of ${refOf(other)}`, expect: { codes: ['context-inconsistent', 'context-not-nearest', 'context-range'], refs: [refOf(target)] } };
  },
  'continuation-left-out': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => frame.continues?.length));
    if (!target) return undefined;
    delete (frames.get(target.id) as Frame).continues;
    return { description: `${refOf(target)}: its continuation is left out`, expect: { codes: ['text-left-behind', 'region-open-end', 'span-gap', 'numbered-text-left-behind'], refs: [refOf(target), target.section as string] } };
  },
  'stray-frame': (frames, context) => {
    const target = context.pick(bookFrames(context));
    if (!target) return undefined;
    const id = 'stray-1';
    frames.set(id, { id, kind: 'exercise', page: target.page, rect: { left: 0.2, top: 0.5, right: 0.6, bottom: 0.55 } });
    return { description: `a frame without a label on page ${target.page}`, expect: { codes: ['stray-frame'], refs: [id] } };
  },
  'stray-exercise': (frames, context) => {
    const target = context.pick(bookFrames(context).filter((frame) => frame.rect.bottom + height(frame) < 0.95));
    if (!target) return undefined;
    const id = 'stray-2';
    const shift = 0.5 * height(target);
    frames.set(id, { ...structuredClone(target), id, label: '999', rect: { ...target.rect, top: target.rect.top + shift, bottom: target.rect.bottom + shift }, solution: undefined } as Frame);
    delete (frames.get(id) as Frame).solution;
    return { description: `${target.section as string}:999 framed over the text of ${refOf(target)}`, expect: { codes: ['label-not-first', 'label-outlier', 'gap', 'overlap', 'no-text'], refs: [`${target.section as string}:999`, refOf(target)] } };
  },
  'span-middle-deleted': (frames, context) => {
    const target = bookFrames(context).find((frame) => (frame.continues?.length ?? 0) >= 2);
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.continues = (mine.continues as Region[]).filter((_region, index) => index !== 0);
    return { description: `${refOf(target)}: the middle continuation is deleted`, expect: { codes: ['span-gap'], refs: [refOf(target)] } };
  },
  'span-swapped': (frames, context) => {
    const target = bookFrames(context).find((frame) => (frame.continues?.length ?? 0) >= 2);
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    mine.continues = [...(mine.continues as Region[])].reverse();
    return { description: `${refOf(target)}: two continuations are swapped`, expect: { codes: ['continuation-order'], refs: [refOf(target)] } };
  },
  'span-shrunk': (frames, context) => {
    const target = bookFrames(context).find((frame) => (frame.continues?.length ?? 0) >= 2);
    if (!target) return undefined;
    const mine = frames.get(target.id) as Frame;
    const [first, ...rest] = mine.continues as Region[];
    mine.continues = [{ ...(first as Region), rect: { ...(first as Region).rect, bottom: (first as Region).rect.bottom - 0.07 } }, ...rest];
    return { description: `${refOf(target)}: a continuation is shrunk, text is left out`, expect: { codes: ['span-gap'], refs: [refOf(target)] } };
  },
};

export interface DefectOptions {
  seed?: number;
  /** How many damaged projects of each type (a span has one place to damage, so one). */
  perType?: number;
  /** The kinds of the project: `workbook` is a book of practice sets and answers, `span` the three-page span. */
  on: 'workbook' | 'span';
}

/** The damaged projects: for every type of defect that fits the project, `perType` of them, each with what the gate must say. */
export function injectDefects(project: Project, options: DefectOptions): DefectCase[] {
  const rng = seeded(options.seed ?? 20261004);
  const perType = options.perType ?? 5;
  const ordered = bookExercisesInOrder(project.frames, project.outline?.entries).filter((frame) => frame.label !== undefined && frame.section !== undefined && isAuthoritative(frame));
  const cases: DefectCase[] = [];
  for (const kind of DEFECT_TYPES.filter((entry) => entry.on === options.on)) {
    const generate = GENERATORS[kind.type] as Generator;
    const used = new Set<string>();
    for (let n = 1; n <= (options.on === 'span' ? 1 : perType); n += 1) {
      const frames = new Map<string, Frame>(structuredClone(project.frames).map((frame) => [frame.id, frame]));
      const context: Context = { project, ordered, pick: (list) => (list.length === 0 ? undefined : list[Math.floor(rng() * list.length)]) };
      let made: Made | undefined;
      for (let attempt = 0; attempt < 20 && made === undefined; attempt += 1) {
        const candidate = generate(frames, context);
        if (candidate !== undefined && !used.has(candidate.description)) made = candidate;
        else if (candidate !== undefined) for (const [id, frame] of structuredClone(project.frames).map((entry) => [entry.id, entry] as const)) frames.set(id, frame);
        if (candidate === undefined) break;
      }
      if (made === undefined) break;
      used.add(made.description);
      cases.push({ id: `${kind.type}#${n}`, type: kind.type, description: made.description, project: { ...structuredClone(project), frames: [...frames.values()] }, expect: made.expect });
    }
  }
  return cases;
}

export interface DefectResult {
  id: string;
  type: string;
  description: string;
  /** The gate did not pass. */
  caught: boolean;
  /** An open finding has one of the expected codes and names the exercise. */
  named: boolean;
  open: number;
  /** The first open finding that names it (or the first open one). */
  finding: GateFinding | undefined;
}

export const namesDefect = (finding: GateFinding, expectation: DefectExpectation): boolean => expectation.codes.includes(finding.code) && expectation.refs.some((ref) => finding.ref === ref || finding.message.includes(ref));

/**
 * Runs the gate on every damaged project (and on the untouched one, id `clean`): the PDF is written next to the project in
 * `directory`, which is left to the caller to remove.
 */
export async function evaluateDefects(cases: readonly DefectCase[], clean: Project, pdf: Uint8Array, directory: string, options: GateRunOptions = {}): Promise<{ clean: DefectResult; results: DefectResult[] }> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, clean.pdf.path), pdf);
  const run = async (id: string, type: string, description: string, project: Project, expectation: DefectExpectation | undefined): Promise<DefectResult> => {
    const path = join(directory, 'defect.mcprep.json');
    await writeFile(path, `${JSON.stringify(project)}\n`);
    const session = await ProjectSession.open(path);
    try {
      const { report } = await runGate(session, { ...options });
      const finding = expectation === undefined ? report.open[0] : (report.open.find((entry) => namesDefect(entry, expectation)) ?? report.open[0]);
      return { id, type, description, caught: !report.passed, named: expectation === undefined ? report.passed : report.open.some((entry) => namesDefect(entry, expectation)), open: report.open.length, finding };
    } finally {
      await session.close();
    }
  };
  const cleanResult = await run('clean', 'clean', 'the project as it is', clean, undefined);
  const results: DefectResult[] = [];
  for (const entry of cases) results.push(await run(entry.id, entry.type, entry.description, entry.project, entry.expect));
  return { clean: cleanResult, results };
}

export interface DefectRate {
  type: string;
  injected: number;
  caught: number;
  named: number;
}

/** The rate per type of defect: how many were injected, how many stopped the gate, how many it named. */
export function defectRates(results: readonly DefectResult[]): DefectRate[] {
  const rates = new Map<string, DefectRate>();
  for (const result of results) {
    const held = rates.get(result.type) ?? { type: result.type, injected: 0, caught: 0, named: 0 };
    held.injected += 1;
    if (result.caught) held.caught += 1;
    if (result.named) held.named += 1;
    rates.set(result.type, held);
  }
  return [...rates.values()];
}
