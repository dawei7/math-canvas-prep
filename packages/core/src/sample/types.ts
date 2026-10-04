/**
 * `mcprep exercises sample`: a review sample of an audited book that is the same for everyone. It is chosen by rules (no
 * randomness, no dependence on the order of the frames in the file), so that two agents, or an agent and a person with the
 * rules at hand, look at exactly the same exercises and answers. The format is `math-canvas-sample` version 1
 * (schemas/sample.schema.json).
 */

export const SAMPLE_FORMAT = 'math-canvas-sample';
export const SAMPLE_VERSION = 1;

/** The defaults of `--exercises` and `--solutions`: the sample is filled up to this many entries. */
export const SAMPLE_DEFAULTS = { exercises: 40, solutions: 20 } as const;

/** Why an exercise is in the sample, in the order of the rules (docs/AUDIT_A_BOOK.md). */
export const EXERCISE_REASONS = [
  'first-in-section',
  'last-in-section',
  'has-continuation',
  'context-on-another-page',
  'two-in-a-row',
  'three-in-a-row',
  'longest',
  'smallest',
  'beside-a-figure',
  'stride',
] as const;
export type ExerciseReason = (typeof EXERCISE_REASONS)[number];

/** Why an answer is in the sample, in the order of the rules. */
export const SOLUTION_REASONS = ['of-first-in-section', 'of-last-in-section', 'of-sampled-exercise', 'most-lines', 'picture-only', 'first-of-chapter-key', 'stride'] as const;
export type SolutionReason = (typeof SOLUTION_REASONS)[number];

export interface SampleEntry {
  /** `SECTION:LABEL` of the exercise (an answer is named by its exercise). */
  ref: string;
  /** The first rule that picked it. */
  reason: ExerciseReason | SolutionReason;
  /** Every rule that picked it, the first one first. */
  reasons: (ExerciseReason | SolutionReason)[];
  /** The zero-based page of the region to look at. */
  page: number;
  /** What to look at: the exercise or its answer. */
  kind: 'exercise' | 'solution';
  /** The region, as `crop --region` and `render_crop` name it: `main` for an exercise, `solution:0` for an answer. */
  region: string;
}

export interface SampleReport {
  format: typeof SAMPLE_FORMAT;
  version: typeof SAMPLE_VERSION;
  options: { exercises: number; solutions: number };
  summary: {
    /** Sections that have exercises. */
    sections: number;
    /** Authoritative exercises in the project, and how many of them have a solution. */
    exercises: number;
    withSolution: number;
    /** What the sample holds. */
    sampledExercises: number;
    sampledSolutions: number;
  };
  /** In the order of the book. */
  exercises: SampleEntry[];
  /** In the order of the book (by the exercise they answer). */
  solutions: SampleEntry[];
  /** What the book does not have (a layout that no exercise shows), so that nobody looks for it. */
  notes: string[];
}

export interface SampleOptions {
  /** Fill the sample of exercises up to this many (default 40; 0 leaves the exercises out). The rules always add what they name. */
  exercises?: number;
  /** The same for the answers (default 20; 0 leaves the answers out). */
  solutions?: number;
}

/** The numbers the layout rules use (page fractions). */
export const SAMPLE_LIMITS = {
  /** `two-in-a-row`, `three-in-a-row`: two regions are in one row when they share this much of the smaller one's height ... */
  rowOverlap: 0.5,
  /** ... and in different columns when their left edges are this far apart. */
  columnGap: 0.05,
  /** `beside-a-figure`: a region at least this many times as tall as the median of its section, and at least this tall. */
  figureFactor: 2.5,
  figureHeight: 0.06,
  /** The median needs this many exercises in the section. */
  figureMinSection: 3,
} as const;
