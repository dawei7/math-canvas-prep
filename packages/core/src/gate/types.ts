/**
 * The gate: the end of an audit. It runs every check that can be run without looking (validation, the text checks of
 * `exercises verify`, the ink check, the comparison with a reference list of the book, the last exported bundle, the contact
 * sheets that were to be looked at) and says what is **open**: neither repaired nor acknowledged. It passes only when nothing is
 * open. What the book itself prints (a number printed twice, an answer missing from the key, a practice set with more exercises
 * than the reference lists) is acknowledged with a reason; a defect of ours never is.
 */

export const GATE_FORMAT = 'math-canvas-audit-gate';
export const GATE_VERSION = 1;
export const NOTES_FORMAT = 'math-canvas-audit-notes';
export const NOTES_VERSION = 1;

/** Where a finding of the gate comes from. */
export type GateSource = 'validate' | 'verify' | 'reference' | 'bundle' | 'sheets' | 'visual';

/** What a finding is, whatever check made it. */
export interface GateFinding {
  source: GateSource;
  /** The code of the finding (the codes of `exercises verify`; `reference-count`, `reference-missing`, `reference-extra`, `reference-title`; `bundle-rejected`, `bundle-stale`; `sheets-...`). */
  code: string;
  severity: 'error' | 'warning';
  /** `SECTION:LABEL`, a section id, or what the finding is about. */
  ref: string;
  page: number | null;
  message: string;
  evidence: string;
  /** False for what can never be what the book prints: a project that fails validation, a bundle the importer rejects, sheets not looked at. */
  acknowledgeable: boolean;
}

/** One acknowledgement: this finding is what the book prints. */
export interface Acknowledgement {
  code: string;
  /** The exercise (`SECTION:LABEL`) or the section the finding is about. */
  ref: string;
  /** Why the finding is not a defect: what the book prints, and where. */
  reason: string;
  evidence: { page?: number; quote?: string };
  /** Who looked. */
  by: string;
  /** How many findings it covers; if the findings change, it no longer matches. Required for a section. */
  count?: number;
  /** A second reviewer, someone other than `by`, has looked at it and says it is what the book prints (`audit confirm`). */
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface AuditNotes {
  format: typeof NOTES_FORMAT;
  version: typeof NOTES_VERSION;
  /** The patterns of `--item-pattern` the audit used, so that the gate reads the book the way the audit did (optional). */
  itemPatterns?: string[];
  acknowledgements: Acknowledgement[];
}

export interface AcknowledgedFinding {
  finding: GateFinding;
  acknowledgement: Acknowledgement;
}

export interface StaleAcknowledgement {
  acknowledgement: Acknowledgement;
  /** Why it does not apply any more (or why it is not allowed). */
  why: string;
}

export interface GateReport {
  format: typeof GATE_FORMAT;
  version: typeof GATE_VERSION;
  createdAt: string;
  /** True only when `open` is empty. */
  passed: boolean;
  /** What the project was when the gate ran: a later change makes this certificate stale. */
  project: { name: string; frames: string; outline: string; hash: string };
  counts: { sections: number; exercises: number; solutions: number; errors: number; warnings: number; infos: number; open: number; acknowledged: number };
  /** Acknowledgements that apply and that no second reviewer has confirmed yet (`audit confirm`): the gate passes, but the book is not perfect until this is 0. */
  unconfirmed: number;
  /** Whether the pixel check of the edges of the regions (`edge-on-ink`) ran. It is part of the gate and runs by default; `--no-ink` skips it for a quick loop. */
  ink: boolean;
  /** Nothing is open, the visual record covers every exercise, no acknowledgement is unconfirmed and the pixel check ran: the book is finished. */
  perfect: boolean;
  checks: {
    validate: { errors: number; warnings: number };
    verify: { errors: number; warnings: number; infos: number; ink: boolean };
    reference: { file: string; differences: number } | null;
    bundle: { path: string; ok: boolean; frames: number | null } | null;
    sheets: { file: string; sheets: number; seen: number; missing: number[]; exhaustive: boolean; current: boolean } | null;
    visual: { file: string; entries: number; exercises: number; missing: number; mismatches: number; defects: number; exhaustive: boolean } | null;
  };
  itemPatterns: string[];
  /** Neither repaired nor acknowledged. */
  open: GateFinding[];
  acknowledged: AcknowledgedFinding[];
  /** Acknowledgements whose findings changed (their count differs): the findings are open again. */
  staleAcknowledgements: StaleAcknowledgement[];
  /** Acknowledgements for findings that no longer exist (the problem was repaired): they can be removed. */
  unusedAcknowledgements: Acknowledgement[];
  /** Acknowledgements that are not allowed (a defect of the audit, a blanket note): they apply to nothing and the findings stay open. */
  refusedAcknowledgements: StaleAcknowledgement[];
}

/** Whether the certificate on disk is for the project as it is now. */
export interface GateStatus {
  status: 'none' | 'stale' | 'failed' | 'passed';
  /** The certificate's hash and the project's, when there is a certificate. */
  certificate?: string;
  current?: string;
  createdAt?: string;
  open?: number;
  /** Acknowledgements of the certificate that no second reviewer has confirmed (in the notes as they are now). */
  unconfirmed?: number;
  /** The visual record covered every exercise when the gate ran. */
  exhaustive?: boolean;
  /** The certificate says the book is perfect (and is current). */
  perfect?: boolean;
  /** The pixel check of the edges ran when the gate ran. */
  ink?: boolean;
}
