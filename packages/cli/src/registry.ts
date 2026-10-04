import { bookExport, bookMeta, bookShow } from './commands/book.js';
import { exportBundle, importCheck, inspectBundle } from './commands/bundle.js';
import { contextAdd, contextRemove, continuesAdd, continuesRemove } from './commands/context.js';
import { guide, schema } from './commands/docs.js';
import { exercisesAdd, exercisesLabel, exercisesList, exercisesMark, exercisesSection, exercisesUnmark } from './commands/exercises.js';
import { framesAdd, framesApply, framesArea, framesDelete, framesDividers, framesList, framesMerge, framesMove, framesSplit, framesUpdate } from './commands/frames.js';
import { outline, outlineClear, outlineDerive, outlinePdf, outlineSet } from './commands/outline.js';
import { outlineAdd, outlineDelete, outlineIds, outlineUpdate } from './commands/outline-edit.js';
import { crop, lines, render } from './commands/pages.js';
import { info, init, meta, relink } from './commands/project.js';
import { propose } from './commands/propose.js';
import { solutionAdd, solutionClear, solutionList, solutionRemove } from './commands/solution.js';
import { validate } from './commands/validate.js';
import type { CommandSpec } from './types.js';

/** Every command, in the order the help lists them (the order of a typical session). */
export const COMMANDS: CommandSpec[] = [
  init,
  info,
  lines,
  render,
  crop,
  outline,
  outlinePdf,
  outlineDerive,
  outlineSet,
  outlineAdd,
  outlineUpdate,
  outlineDelete,
  outlineIds,
  outlineClear,
  propose,
  framesList,
  framesAdd,
  framesUpdate,
  framesDelete,
  framesMove,
  framesSplit,
  framesMerge,
  framesDividers,
  framesArea,
  framesApply,
  contextAdd,
  contextRemove,
  continuesAdd,
  continuesRemove,
  exercisesList,
  exercisesAdd,
  exercisesMark,
  exercisesUnmark,
  exercisesLabel,
  exercisesSection,
  solutionAdd,
  solutionList,
  solutionRemove,
  solutionClear,
  bookShow,
  bookMeta,
  bookExport,
  meta,
  relink,
  validate,
  exportBundle,
  inspectBundle,
  importCheck,
  schema,
  guide,
];
