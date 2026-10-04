import { dropClosingPunctuation } from '../model/authority.js';
import { isBelowMinimum, rectHeight, rectWidth } from '../model/rect.js';
import { AUTHORITIES, FRAME_KINDS, type Authority, type Frame, type FrameKind, type Rect, type Region } from '../model/types.js';
import { AUTHORING, LIMITS } from './constants.js';
import { issue, type Issue } from './issues.js';
import { checkUnits } from './units.js';

/**
 * What the importer does with frames (docs/BUNDLE_FORMAT.md sections 3 and 5): accept what is valid, repair what the
 * format lets a reader repair (a value slightly outside the page is clamped, a unit that tiles within 0.002 is snapped)
 * and reject everything else naming the frame id. These functions are the reference for the writer, `validate` and
 * `import-check`.
 */
export interface CheckOptions {
  /** Number of pages of the PDF. */
  pageCount: number;
  /**
   * True when reading a file written by someone else (a bundle): shapes must be exactly those of the format.
   * False for a project file, which also accepts a rect written as an array or as "l,t,r,b".
   */
  strictShapes?: boolean;
}

export interface CheckResult {
  /** The frames after repairs. Only meaningful when no issue is an error. */
  frames: Frame[];
  /**
   * Errors and repairs, in the order they were found, and one kind of warning that needs the frame as it was written: a
   * label that ends with the punctuation the book prints (`label-style`; the importer drops it and the frame holds the label
   * without it).
   */
  issues: Issue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KINDS: readonly string[] = FRAME_KINDS;

interface ReadState {
  options: CheckOptions;
  issues: Issue[];
  seen: Set<string>;
  /** Units that have a member which could not be read: their tiling cannot be judged. */
  brokenUnits: Set<string>;
}

/** Reads and checks the contents of frames.json (or the `frames` of a project) from parsed JSON. */
export function parseFrames(raw: unknown, options: CheckOptions): CheckResult {
  if (!Array.isArray(raw)) {
    return {
      frames: [],
      issues: [issue('error', 'frames-not-array', 'The frames must be a list.', { fix: 'Write "frames": [ ... ].' })],
    };
  }
  const state: ReadState = { options, issues: [], seen: new Set(), brokenUnits: new Set() };
  const frames: Frame[] = [];
  raw.forEach((item, index) => {
    const frame = readFrame(item, index, state);
    if (frame) frames.push(frame);
  });
  const units = checkUnits(frames, state.brokenUnits);
  state.issues.push(...units.issues);
  return { frames: units.frames, issues: state.issues };
}

/** Checks frames that are already typed (a project in memory); the same rules as {@link parseFrames}. */
export function checkFrames(frames: readonly Frame[], options: CheckOptions): CheckResult {
  return parseFrames(frames, options);
}

function nameOf(index: number, id: unknown): string {
  return typeof id === 'string' && id.length > 0 ? id : `frames[${index}]`;
}

function readFrame(item: unknown, index: number, state: ReadState): Frame | undefined {
  const { options, issues } = state;
  if (!isRecord(item)) {
    issues.push(
      issue('error', 'frame-not-object', `frames[${index}] is not an object.`, {
        fix: 'Each frame is an object with id, kind, page and rect.',
      }),
    );
    return undefined;
  }
  const before = issues.length;
  const rawId = item['id'];
  const name = nameOf(index, rawId);
  const base = { frameId: name };

  let id = '';
  if (typeof rawId !== 'string' || !LIMITS.idPattern.test(rawId)) {
    issues.push(
      issue('error', 'bad-id', `frames[${index}] has an id that is missing or not 1 to 40 characters of A-Z a-z 0-9 _ -.`, {
        ...base,
        fix: 'Give the frame an id such as "f1".',
      }),
    );
  } else {
    id = rawId;
    if (state.seen.has(id)) {
      issues.push(
        issue('error', 'duplicate-id', `The id "${id}" is used by more than one frame.`, { ...base, fix: 'Make every id unique.' }),
      );
    }
    state.seen.add(id);
  }

  const kind = item['kind'];
  const kindOk = typeof kind === 'string' && KINDS.includes(kind);
  if (!kindOk) {
    issues.push(
      issue('error', 'bad-kind', `The kind of ${name} must be "exercise", "question" or "bookmark", not ${JSON.stringify(kind)}.`, {
        ...base,
        fix: 'Use one of exercise, question, bookmark.',
      }),
    );
  }

  const main = readRegion({ page: item['page'], rect: item['rect'] }, name, 'the frame', state);
  const continues = readRegionList(item['continues'], name, 'continues', state);
  const context = readRegionList(item['context'], name, 'context', state);
  const solution = readRegionList(item['solution'], name, 'solution', state);

  let authority: Authority | undefined;
  const rawAuthority = item['authority'];
  if (rawAuthority !== undefined && !(rawAuthority === null && options.strictShapes !== true)) {
    if (typeof rawAuthority !== 'string' || !(AUTHORITIES as readonly string[]).includes(rawAuthority)) {
      issues.push(
        issue('error', 'bad-authority', `The authority of ${name} must be "book" (or left out), not ${JSON.stringify(rawAuthority)}.`, {
          ...base,
          fix: 'Write "authority": "book" for an exercise audited from the book, or remove the field for an ordinary exercise.',
        }),
      );
    } else {
      authority = rawAuthority as Authority;
    }
  }
  const readText = (field: 'label' | 'section'): string | undefined => {
    const raw = item[field];
    if (raw === undefined || (raw === null && options.strictShapes !== true)) return undefined;
    if (typeof raw !== 'string') {
      issues.push(issue('error', `bad-${field}`, `The ${field} of ${name} must be a text, not ${JSON.stringify(raw)}.`, { ...base, fix: `Write the ${field} as a text.` }));
      return undefined;
    }
    return raw;
  };
  const written = readText('label');
  /** The label as the importer keeps it (see below); only an authoritative exercise has one. */
  let label: string | undefined;
  const section = readText('section');

  let unit: string | undefined;
  const rawUnit = item['unit'];
  if (rawUnit !== undefined && !(rawUnit === null && options.strictShapes !== true)) {
    if (typeof rawUnit !== 'string' || !LIMITS.idPattern.test(rawUnit)) {
      issues.push(
        issue('error', 'bad-unit', `The unit of ${name} must be 1 to 40 characters of A-Z a-z 0-9 _ -.`, {
          ...base,
          fix: 'Use a unit id such as "u1".',
        }),
      );
    } else {
      unit = rawUnit;
    }
  }

  if (kindOk) {
    if (unit !== undefined && kind !== 'exercise') {
      issues.push(
        issue('error', 'unit-not-exercise', `${name} is a ${String(kind)} but has a unit; only exercises can be parts.`, {
          ...base,
          unit,
          fix: 'Remove the unit or make the frame an exercise.',
        }),
      );
    }
    if (context && context.length > 0 && kind !== 'exercise') {
      issues.push(
        issue('error', 'context-not-exercise', `${name} is a ${String(kind)} but has context; only exercises can have context.`, {
          ...base,
          fix: 'Remove the context or make the frame an exercise.',
        }),
      );
    }
    if (authority !== undefined && kind !== 'exercise') {
      issues.push(
        issue('error', 'authority-not-exercise', `${name} is a ${String(kind)} but has an authority; only exercises can be authoritative.`, {
          ...base,
          fix: 'Remove authority, label and section, or make the frame an exercise.',
        }),
      );
    }
    if (solution && solution.length > 0 && kind !== 'exercise') {
      issues.push(
        issue('error', 'solution-not-exercise', `${name} is a ${String(kind)} but has solution regions; only exercises can have a solution.`, {
          ...base,
          fix: 'Remove the solution or make the frame an exercise.',
        }),
      );
    }
  }
  if (authority !== undefined) {
    if (unit !== undefined) {
      issues.push(
        issue('error', 'authority-unit', `${name} is an authoritative exercise but also a part of unit "${unit}"; an authoritative exercise is a single exercise and has no parts.`, {
          ...base,
          unit,
          fix: 'Remove the unit. The parts of a printed exercise (5a, 5b) are separate exercises with separate labels; what they share, the statement printed once above them, is attached to each as context.',
        }),
      );
    }
    if (written === undefined) {
      issues.push(issue('error', 'label-missing', `${name} is an authoritative exercise but has no label.`, { ...base, fix: 'Give it the number the book prints, for example --label 5a.' }));
    } else {
      // The importer drops the "." or ")" the book prints after a number before it checks and keeps the label, so a label
      // is judged, and its (section, label) pair compared, in that form. It is named in a message as it was written.
      label = dropClosingPunctuation(written);
      if (!LIMITS.labelPattern.test(label)) {
        issues.push(
          issue('error', 'bad-label', `The label of ${name} (${JSON.stringify(written)}) must be 1 to ${LIMITS.labelMax} characters: it starts with a letter or digit and continues with letters, digits, spaces and . _ - ( ) /`, {
            ...base,
            fix: 'Write the number exactly as the book prints it, without the closing "." or ")": 5, 5a, A.3.',
          }),
        );
      } else if (label !== written) {
        issues.push(
          issue('warning', 'label-style', `The label of ${name} (${JSON.stringify(written)}) ends with a "${written.endsWith('.') ? '.' : ')'}", the punctuation the book prints after the number and not part of the label; the importer drops it and keeps ${JSON.stringify(label)}.`, {
            ...base,
            fix: `Write it as the bare number: \`mcprep exercises label ${name} ${JSON.stringify(label)}\`.`,
          }),
        );
      }
    }
    if (section === undefined) {
      issues.push(issue('error', 'section-missing', `${name} is an authoritative exercise but has no section.`, { ...base, fix: 'Give it the id of the outline entry (the section) it belongs to, for example --section 1.2.' }));
    } else if (!LIMITS.sectionIdPattern.test(section)) {
      issues.push(
        issue('error', 'bad-section', `The section of ${name} (${JSON.stringify(section)}) must be the id of an outline entry: 1 to ${LIMITS.sectionIdMax} characters of A-Z a-z 0-9 . _ - starting with a letter or digit.`, {
          ...base,
          fix: 'Use the id as `mcprep outline` lists it.',
        }),
      );
    }
  } else {
    if (written !== undefined) {
      issues.push(issue('error', 'label-without-authority', `${name} has a label but no authority; only authoritative exercises have one.`, { ...base, fix: 'Add "authority": "book" (and a section), or remove the label.' }));
    }
    if (section !== undefined) {
      issues.push(issue('error', 'section-without-authority', `${name} has a section but no authority; only authoritative exercises have one.`, { ...base, fix: 'Add "authority": "book" (and a label), or remove the section.' }));
    }
  }
  if (unit !== undefined && continues && continues.length > 0) {
    issues.push(
      issue('error', 'unit-continues', `${name} is a part of unit "${unit}" and also has "continues"; parts cannot continue elsewhere.`, {
        ...base,
        unit,
        fix: 'Put each page of the exercise in its own part (same unit) instead of using "continues".',
      }),
    );
  }

  const failed = issues.slice(before).some((entry) => entry.severity === 'error');
  if (failed) {
    if (unit !== undefined) state.brokenUnits.add(unit);
    return undefined;
  }
  if (!main || !kindOk) return undefined;

  const frame: Frame = { id, kind: kind as FrameKind, page: main.page, rect: main.rect };
  if (continues && continues.length > 0) frame.continues = continues;
  if (unit !== undefined) frame.unit = unit;
  if (context && context.length > 0) frame.context = context;
  if (authority !== undefined) frame.authority = authority;
  if (label !== undefined) frame.label = label;
  if (section !== undefined) frame.section = section;
  if (solution && solution.length > 0) frame.solution = solution;
  return frame;
}

function readRegionList(
  raw: unknown,
  name: string,
  field: 'continues' | 'context' | 'solution',
  state: ReadState,
): Region[] | undefined {
  if (raw === undefined || (raw === null && state.options.strictShapes !== true)) return undefined;
  if (!Array.isArray(raw)) {
    state.issues.push(
      issue('error', 'bad-regions', `"${field}" of ${name} must be a list of {page, rect} regions.`, { frameId: name }),
    );
    return undefined;
  }
  const most = field === 'solution' ? LIMITS.maxSolutionRegions : LIMITS.maxRegions;
  if (raw.length > most) {
    state.issues.push(
      issue('error', 'too-many-regions', `${name} has ${raw.length} "${field}" regions; at most ${most} are allowed.`, {
        frameId: name,
        fix: `Merge regions that are next to each other so at most ${most} remain.`,
      }),
    );
    return undefined;
  }
  const regions: Region[] = [];
  raw.forEach((entry, index) => {
    const region = readRegion(entry, name, `${field}[${index}]`, state);
    if (region) regions.push(region);
  });
  return regions;
}

function readRegion(raw: unknown, name: string, where: string, state: ReadState): Region | undefined {
  const { issues, options } = state;
  const base = { frameId: name };
  if (!isRecord(raw)) {
    issues.push(issue('error', 'bad-region', `${where} of ${name} must be an object with page and rect.`, base));
    return undefined;
  }
  const page = raw['page'];
  let pageOk = true;
  if (typeof page !== 'number' || !Number.isInteger(page)) {
    issues.push(
      issue('error', 'bad-page', `The page of ${where} of ${name} must be a whole number (zero-based).`, {
        ...base,
        fix: 'Pages are zero-based: the first page is 0.',
      }),
    );
    pageOk = false;
  } else if (page < 0 || page >= options.pageCount) {
    const last = Math.max(0, options.pageCount - 1);
    issues.push(
      issue(
        'error',
        'page-out-of-range',
        `The page ${page} of ${where} of ${name} does not exist: the document has ${options.pageCount} page${options.pageCount === 1 ? '' : 's'} (zero-based 0..${last}).`,
        { ...base, page, fix: `Use a page between 0 and ${last}. Pages are zero-based.` },
      ),
    );
    pageOk = false;
  }
  const rect = readRect(raw['rect'], name, where, state);
  if (!pageOk || !rect) return undefined;
  return { page: page as number, rect };
}

function readRect(raw: unknown, name: string, where: string, state: ReadState): Rect | undefined {
  const { issues, options } = state;
  const base = { frameId: name };
  let values: number[] | undefined;
  if (isRecord(raw)) {
    const list = [raw['left'], raw['top'], raw['right'], raw['bottom']];
    if (list.every((value) => typeof value === 'number' && Number.isFinite(value))) values = list as number[];
  } else if (options.strictShapes !== true) {
    // The project file is more tolerant than the bundle: [l,t,r,b] and "l,t,r,b" are understood.
    const list = Array.isArray(raw)
      ? (raw as unknown[])
      : typeof raw === 'string'
        ? raw.split(/[\s,;]+/).filter(Boolean)
        : undefined;
    if (list && list.length === 4) {
      const numbers = list.map((value) => (typeof value === 'string' ? Number(value) : value));
      if (numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) values = numbers as number[];
    }
  }
  if (!values) {
    issues.push(
      issue('error', 'bad-rect', `The rect of ${where} of ${name} must be {"left":..,"top":..,"right":..,"bottom":..} with four numbers.`, {
        ...base,
        fix: 'Give left, top, right and bottom as fractions of the page between 0 and 1.',
      }),
    );
    return undefined;
  }
  const names = ['left', 'top', 'right', 'bottom'] as const;
  const fixed = [...values];
  let valid = true;
  fixed.forEach((value, i) => {
    if (value >= 0 - AUTHORING.epsilon && value <= 1 + AUTHORING.epsilon) return;
    const over = value < 0 ? -value : value - 1;
    if (over <= LIMITS.clampTolerance + AUTHORING.epsilon) {
      const clamped = value < 0 ? 0 : 1;
      issues.push(
        issue('repair', 'rect-clamped', `${names[i]} of ${where} of ${name} is ${value}, slightly outside the page; it is clamped to ${clamped}.`, {
          ...base,
          fix: `Keep values between 0 and 1 (set ${names[i]} to ${clamped}).`,
        }),
      );
      fixed[i] = clamped;
    } else {
      issues.push(
        issue('error', 'rect-off-page', `${names[i]} of ${where} of ${name} is ${value}, outside the page by more than ${LIMITS.clampTolerance}.`, {
          ...base,
          fix: 'Rectangles are fractions of the page: every value must be between 0 and 1.',
        }),
      );
      valid = false;
    }
  });
  if (!valid) return undefined;
  const rect: Rect = {
    left: fixed[0] as number,
    top: fixed[1] as number,
    right: fixed[2] as number,
    bottom: fixed[3] as number,
  };
  if (rect.right <= rect.left || rect.bottom <= rect.top) {
    issues.push(
      issue('error', 'rect-inverted', `The rect of ${where} of ${name} is empty or inverted (right must be greater than left, bottom greater than top).`, {
        ...base,
        fix: 'Give left < right and top < bottom; the origin is the top-left corner and y grows downwards.',
      }),
    );
    return undefined;
  }
  if (isBelowMinimum(rect)) {
    issues.push(
      issue(
        'error',
        'rect-too-small',
        `The rect of ${where} of ${name} is ${rectWidth(rect).toFixed(4)} wide and ${rectHeight(rect).toFixed(4)} tall; the minimum is ${LIMITS.minWidth} wide and ${LIMITS.minHeight} tall.`,
        {
          ...base,
          fix: `Make it at least ${LIMITS.minWidth} wide and ${LIMITS.minHeight} tall (one text line is about 0.015 on a normal page).`,
        },
      ),
    );
    return undefined;
  }
  return rect;
}
