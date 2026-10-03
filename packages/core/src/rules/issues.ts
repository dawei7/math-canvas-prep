/**
 * What validation reports. An `error` is something the importer rejects, a `repair` something it silently fixes
 * (the writer fixes it too), a `warning` something that is allowed but probably not what you want.
 */
export type Severity = 'error' | 'warning' | 'repair';

export interface Issue {
  severity: Severity;
  /** A stable machine-readable code, e.g. `unit-gap`. */
  code: string;
  message: string;
  /** The frame the issue is about, when there is one. */
  frameId?: string;
  unit?: string;
  page?: number;
  /** What to do about it, as an instruction (a command or a plain sentence). */
  fix?: string;
  data?: Record<string, unknown>;
}

export interface ValidationResult {
  /** True when there are no errors (warnings and repairs do not block anything). */
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  repairs: Issue[];
}

export function summarize(issues: Issue[]): ValidationResult {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const repairs = issues.filter((issue) => issue.severity === 'repair');
  return { ok: errors.length === 0, errors, warnings, repairs };
}

export function issue(severity: Severity, code: string, message: string, extra: Partial<Issue> = {}): Issue {
  return { severity, code, message, ...extra };
}

/** One line for a person: `error [unit-gap] f3: message (fix: ...)`. */
export function formatIssue(item: Issue): string {
  const where = item.frameId ? ` ${item.frameId}:` : '';
  const fix = item.fix ? ` (fix: ${item.fix})` : '';
  return `${item.severity} [${item.code}]${where} ${item.message}${fix}`;
}

/** An error that carries its issues, thrown where a caller cannot continue. */
export class McPrepError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly issues: Issue[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { hint?: string; issues?: Issue[]; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McPrepError';
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    this.issues = options.issues ?? [];
    if (options.details !== undefined) this.details = options.details;
  }
}
