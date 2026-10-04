import { exportBundle, importCheck, inspectBundle } from './commands/bundle.js';
import { exercisesPropose, solutionsPropose } from './commands/audit.js';
import { contextAdd, contextRemove, continuesAdd, continuesRemove } from './commands/context.js';
import { guide, schema } from './commands/docs.js';
import { framesAdd, framesApply, framesArea, framesDelete, framesDividers, framesList, framesMerge, framesMove, framesSplit, framesUpdate } from './commands/frames.js';
import { outline, outlineClear, outlineDerive, outlinePdf, outlineSet } from './commands/outline.js';
import { crop, lines, render } from './commands/pages.js';
import { info, init, meta, relink } from './commands/project.js';
import { propose } from './commands/propose.js';
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
  outlineClear,
  propose,
  exercisesPropose,
  solutionsPropose,
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
  meta,
  relink,
  validate,
  exportBundle,
  inspectBundle,
  importCheck,
  schema,
  guide,
];
