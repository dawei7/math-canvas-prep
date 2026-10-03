/**
 * The browser-safe part of the core: the model, every rule, numbering, snapping, proposals from text lines, the project
 * operations and the project file format. No Node API is used here, so the desktop app's renderer can import it
 * (`@mcprep/core/pure`) and edit with exactly the code the command line uses.
 */
export * from './model/types.js';
export * from './model/rect.js';
export * from './model/numbering.js';
export * from './model/overlay.js';
export * from './rules/constants.js';
export * from './rules/issues.js';
export * from './rules/frames.js';
export * from './rules/units.js';
export * from './rules/lint.js';
export * from './rules/outline.js';
export * from './rules/document.js';
export * from './geometry/snap.js';
export * from './pdf/lines.js';
export * from './propose/index.js';
export * from './project/model.js';
export * from './project/serialize.js';
export * from './project/ops.js';
export * from './project/validate.js';
export * from './version.js';
