import { bookExport, bookMeta, bookShow } from './commands/book.js';
import { exportBundle, importCheck, inspectBundle } from './commands/bundle.js';
import { exercisesPropose, solutionsPropose } from './commands/audit.js';
import { bookCompare } from './commands/compare.js';
import { auditAck, auditConfirm, auditGate, auditReview } from './commands/gate.js';
import { exercisesSheets } from './commands/sheets.js';
import { contextAdd, contextRemove, continuesAdd, continuesRemove } from './commands/context.js';
import { guide, schema } from './commands/docs.js';
import { exercisesAdd, exercisesLabel, exercisesList, exercisesMark, exercisesSection, exercisesUnmark } from './commands/exercises.js';
import { framesAdd, framesApply, framesArea, framesDelete, framesDividers, framesList, framesMerge, framesMove, framesSplit, framesUpdate } from './commands/frames.js';
import { outline, outlineClear, outlineDerive, outlinePdf, outlineSet } from './commands/outline.js';
import { outlineAdd, outlineDelete, outlineIds, outlineUpdate } from './commands/outline-edit.js';
import { crop, lines, render } from './commands/pages.js';
import { info, init, meta, relink } from './commands/project.js';
import { propose } from './commands/propose.js';
import { exercisesSample } from './commands/sample.js';
import { solutionAdd, solutionClear, solutionList, solutionRemove } from './commands/solution.js';
import { validate } from './commands/validate.js';
import { exercisesVerify } from './commands/verify.js';
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
  exercisesPropose,
  solutionsPropose,
  exercisesVerify,
  exercisesSample,
  exercisesSheets,
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
  bookCompare,
  auditGate,
  auditAck,
  auditConfirm,
  auditReview,
  meta,
  relink,
  validate,
  exportBundle,
  inspectBundle,
  importCheck,
  schema,
  guide,
];
