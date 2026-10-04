/**
 * `mcprep exercises verify`: the report of a text-only quality check of an audited book, in the format
 * `math-canvas-verify` version 1 (schemas/verify.schema.json). Everything here is plain data: the report is the same for
 * every agent that runs the check on the same project, whatever model it is and whether it can look at images.
 */

import type { Rect } from '../model/types.js';

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
  { code: 'span-gap', severities: ['error'] },
  { code: 'continuation-order', severities: ['error'] },
  { code: 'continuation-limit', severities: ['warning'] },
  { code: 'numbered-text-left-behind', severities: ['error'] },
  { code: 'answer-left-behind', severities: ['error'] },
  { code: 'text-left-behind', severities: ['warning', 'info'] },
  { code: 'answer-clipped', severities: ['warning'] },
  { code: 'context-range', severities: ['error'] },
  { code: 'context-missing', severities: ['error'] },
  { code: 'context-not-nearest', severities: ['warning'] },
  { code: 'context-inconsistent', severities: ['warning'] },
  { code: 'solution-section-mismatch', severities: ['error'] },
  { code: 'solution-order', severities: ['warning'] },
  { code: 'edge-on-ink', severities: ['warning'] },
  { code: 'region-open-end', severities: ['warning'] },
  { code: 'region-holds-item', severities: ['error'] },
  { code: 'inline-section', severities: ['info'] },
  { code: 'stray-frame', severities: ['warning'] },
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
  /** `text-left-behind` and its relatives: a piece of text is covered when at least this share of its box lies inside regions. */
  coveredShare: 0.5,
  /** Text left behind: lines closer than this many line heights make one block, and a line this close under a region goes on from it. */
  blockGap: 1.7,
  /** A section is a practice set (its text left behind is checked) when at least this share of the lines from its first exercise to its end are in regions. */
  practiceShare: 0.6,
  /** A practice set has at least this many exercises together. */
  practiceMinExercises: 3,
  /** `region-open-end`: a last line shorter than this share of the longest line of the region ends its paragraph. */
  openEndLength: 0.8,
  /** `region-open-end`: the line below a region goes on from it when its top is no further than this many line pitches below the region's last line. */
  openEndPitch: 1.2,
  /** `edge-on-ink`: an edge is on ink when more than this share of the pixels along it (in the three rows or columns around it) is dark ... */
  inkEdgeShare: 0.02,
  /**
   * ... or when the ink goes on across it at this many pixels or more: the pixels along the edge at which the row (or column) just inside
   * the region and the one just outside it are both dark (the page drawn at 2 pixels per point, dark = luminance below 150). Edges in white
   * paper give 0, and one pixel is a glyph tip that grazes the edge (a radical's point, a comma's tail), so two is the smallest number that
   * does not report those; a hairline of a figure that the edge cuts is 2 pixels wide at this resolution.
   */
  inkCrossPixels: 2,
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
  /** The first and the last number of the section as the book counts: labels that start with an integer in numeric order, else in reading order. */
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

/** The number of pixels along each edge of a region. */
export interface EdgeCount {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** How much of the pixels along each edge of a region is dark (0 to 1), and where the ink goes across it, measured on the rendered page. */
export interface EdgeInk {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /**
   * The pixels along each edge at which the ink goes on across it: the row (for the top and bottom edge) or the column (for the left and
   * right edge) just inside the region and the one just outside it are both dark at the same place. A glyph, a rule or the border of a
   * box that the edge cuts shows here; a clean edge in white paper has 0. Absent for a measure that did not take it.
   */
  cross?: EdgeCount;
  /** How many pixels the horizontal edges (top, bottom) and the vertical edges (left, right) are long. */
  length?: { horizontal: number; vertical: number };
}

/** The ink of the edges of a region, or undefined for a region that was not measured. */
export type InkLookup = (region: { page: number; rect: Rect }) => EdgeInk | undefined;

export interface VerifyOptions {
  /** Only the exercises filed under these sections (ids of outline entries); default all. Ordinary exercises are then left out. */
  sections?: readonly string[];
  /** The ink of the edges of the regions (`measureInk`): `edge-on-ink` is only checked when it is given. */
  ink?: InkLookup;
  /**
   * How the number of an exercise or an answer starts a line, when the book does not print `5.`, `5)` or `(5)`: regular
   * expressions with the label as printed in group 1 (the same patterns `exercises propose --item-pattern` takes).
   */
  itemPatterns?: readonly RegExp[];
}
