/**
 * `mcprep exercises verify`: the report of a text-only quality check of an audited book, in the format
 * `math-canvas-verify` version 1 (schemas/verify.schema.json). Everything here is plain data: the report is the same for
 * every agent that runs the check on the same project, whatever model it is and whether it can look at images.
 */

export const VERIFY_FORMAT = 'math-canvas-verify';
export const VERIFY_VERSION = 1;

export type FindingSeverity = 'error' | 'warning' | 'info';

/** The order in which findings of different severities are listed. */
export const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Every code a finding can carry, in the order they are documented (docs/AUDIT_A_BOOK.md) and the order in which findings
 * of one severity are listed. `severities` says what a code can be: `no-solution` is an info for a section without any
 * answer and a warning for one that has too few.
 */
export const VERIFY_CODES = [
  { code: 'label-not-first', severities: ['error'] },
  { code: 'no-text', severities: ['warning'] },
  { code: 'solution-label-missing', severities: ['error'] },
  { code: 'solution-no-text', severities: ['info'] },
  { code: 'overlap', severities: ['error'] },
  { code: 'context-overlaps-frame', severities: ['warning'] },
  { code: 'duplicate-region', severities: ['error'] },
  { code: 'region-size', severities: ['warning'] },
  { code: 'section-unknown', severities: ['error'] },
  { code: 'section-page', severities: ['error'] },
  { code: 'gap', severities: ['warning'] },
  { code: 'duplicate', severities: ['error'] },
  { code: 'non-numeric-label', severities: ['info'] },
  { code: 'order', severities: ['warning'] },
  { code: 'no-solution', severities: ['info', 'warning'] },
  { code: 'label-outlier', severities: ['warning'] },
] as const;

export type VerifyCode = (typeof VERIFY_CODES)[number]['code'];

/** The thresholds of the checks (page fractions unless said otherwise). They are documented in docs/AUDIT_A_BOOK.md. */
export const VERIFY_LIMITS = {
  /** `overlap`: the common part of two regions of different exercises is more than this share of the smaller region ... */
  overlapShare: 0.05,
  /** ... and at least this tall (a quarter of a line of text: below it two regions only touch). */
  overlapMinHeight: 0.004,
  /** `context-overlaps-frame`: the same two measures as validate's warning of that name. */
  contextOverlapShare: 0.1,
  /** `duplicate-region`: every edge of the two regions is within this distance. */
  sameRegionTolerance: 0.001,
  /** `region-size`: a region taller than this, narrower than `minWidth` or smaller in area than `minArea`. */
  maxHeight: 0.45,
  minWidth: 0.05,
  minArea: 0.002,
  /** `no-solution`: a section with some answers is a warning when fewer than this share of its exercises have one. */
  coverageShare: 0.8,
  /** `label-outlier`: a number more than this many times the median of its section. */
  outlierFactor: 3,
  /** Characters of the text found that a finding quotes as its evidence. */
  evidenceLength: 40,
} as const;

export interface VerifyFinding {
  code: VerifyCode;
  severity: FindingSeverity;
  /** `SECTION:LABEL` of the exercise, the section id for a finding about a whole section, a frame id for an ordinary frame. */
  ref: string;
  /** The zero-based page to look at, or null when the finding has none. */
  page: number | null;
  /** A sentence for a person. */
  message: string;
  /** The facts the finding rests on (the text that was found, the numbers that were measured). */
  evidence: string;
}

export interface VerifySection {
  /** The id exercises name; the section's outline entry has it unless the id is unknown (a `section-unknown` finding). */
  id: string;
  /** The number printed with the section's heading, when the outline entry has one. */
  label: string | null;
  exercises: number;
  /** The labels of the first and the last exercise of the section in reading order. */
  firstLabel: string | null;
  lastLabel: string | null;
  /** How many of the section's exercises have a solution region. */
  withSolution: number;
  /** The numbers between the first and the last that no exercise has (labels that start with an integer; outliers left out). */
  gaps: string[];
  /** Labels that two or more exercises of the section have. */
  duplicates: string[];
}

export interface VerifySummary {
  /** Exercise frames checked: the authoritative ones and, without a section filter, the ordinary ones. */
  exercises: number;
  authoritative: number;
  /** Sections that hold exercises (the length of `sections`). */
  sections: number;
  /** Authoritative exercises with a solution region. */
  solutions: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface VerifyReport {
  format: typeof VERIFY_FORMAT;
  version: typeof VERIFY_VERSION;
  summary: VerifySummary;
  /** In a fixed order: errors, warnings, infos; within a severity by code (the order of VERIFY_CODES), then by the order of the book. */
  findings: VerifyFinding[];
  sections: VerifySection[];
}

export interface VerifyOptions {
  /** Only the exercises filed under these sections (ids of outline entries); default all. Ordinary exercises are then left out. */
  sections?: readonly string[];
  /**
   * How the number of an exercise or an answer starts a line, when the book does not print `5.`, `5)` or `(5)`: regular
   * expressions with the label as printed in group 1 (the same patterns `exercises propose --item-pattern` takes).
   */
  itemPatterns?: readonly RegExp[];
}
