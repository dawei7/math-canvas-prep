import { KIND_COLORS, type Frame } from '@mcprep/core/pure';

/**
 * The colours of the editor. A book exercise has a colour of its own (amber), so that it is never taken for an exercise a
 * person framed for themselves (indigo); a solution region is green, as a hidden answer key.
 */
export const BOOK_COLOR = '#b45309';
export const SOLUTION_COLOR = '#15803d';
export const CONTEXT_COLOR = KIND_COLORS.context;

export const frameColor = (frame: Pick<Frame, 'kind' | 'authority'>): string => (frame.kind === 'exercise' && frame.authority === 'book' ? BOOK_COLOR : KIND_COLORS[frame.kind]);
