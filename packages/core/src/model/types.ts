/**
 * The data model. The frame schema is exactly the one of docs/BUNDLE_FORMAT.md, section 3: the project file stores the
 * same frames, and the bundle writer copies them (after validation) into frames.json.
 */

export const FRAME_KINDS = ['exercise', 'question', 'bookmark'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** A rectangle in fractions of the page as displayed (after /Rotate), origin top-left, y downwards. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle on a zero-based page. */
export interface Region {
  page: number;
  rect: Rect;
}

export interface Frame {
  /** Unique within the file, [A-Za-z0-9_-]{1,40}. Only relates frames to each other; numbers are computed from position. */
  id: string;
  kind: FrameKind;
  /** Zero-based page of the main region. */
  page: number;
  rect: Rect;
  /** Further regions of the same task after the main region (not allowed together with `unit`). */
  continues?: Region[];
  /** Frames sharing a unit are the parts of one exercise. */
  unit?: string;
  /** The instruction, question or background that belongs to this exercise, wherever it is printed. */
  context?: Region[];
  /**
   * `book`: an authoritative exercise, audited from the book and named by its printed `label` instead of a positional
   * number. Only exercises. Absent: an ordinary exercise framed by a person for themselves.
   */
  authority?: Authority;
  /** The number as the book prints it ("5", "5a", "A.3"), without the closing "." or ")". Required with `authority`. */
  label?: string;
  /** The `id` of the outline entry (the section) the authoritative exercise belongs to. Required with `authority`. */
  section?: string;
  /** Where the solution or answer is printed, in the same document. Hidden from the learner; used only to grade. */
  solution?: Region[];
}

export const AUTHORITIES = ['book'] as const;
export type Authority = (typeof AUTHORITIES)[number];

export interface OutlineEntry {
  title: string;
  /** Zero-based page. */
  page: number;
  depth: number;
  /** Unique among the entries: the key by which a frame's `section` finds its entry. */
  id?: string;
  /** The number printed with the heading ("1.1", "Chapter 3"). */
  label?: string;
  /** Where the heading starts on its page, 0 (top) to 1. */
  top?: number;
}

/** frames.json of a bundle. */
export interface FramesFile {
  version: 1;
  frames: Frame[];
}

/** outline.json of a bundle. */
export interface OutlineFile {
  version: 1;
  entries: OutlineEntry[];
}

/** What a writer may say about the work itself; all optional. */
export interface DocumentInfo {
  author?: string;
  series?: string;
  description?: string;
  license?: { name: string; url?: string };
  sourceUrl?: string;
  /** The text a licence asks to be shown with the work (attribution, what was changed). */
  notice?: string;
}

export const BUNDLE_FEATURES = ['sections', 'authority', 'solution'] as const;
export type BundleFeature = (typeof BUNDLE_FEATURES)[number];

export interface BundleManifest {
  format: 'math-canvas-bundle';
  version: 1;
  createdAt: string;
  generator: { name: string; version: string; targets?: string };
  /** Which optional parts of the format the writer used; informational. */
  features?: BundleFeature[];
  document: DocumentInfo & {
    title: string;
    fileName: string;
    pdf: 'document.pdf';
    sha256: string;
    bytes: number;
    pageCount: number;
    folder?: string;
  };
  frames: 'frames.json';
  outline?: 'outline.json';
}

/** One text line of a page, in page fractions. */
export interface TextLine {
  text: string;
  rect: Rect;
  /** Largest font size on the line, in points of the displayed page. */
  fontSize: number;
  /** Zero-based column of a multi-column page; 0 on a single-column page. */
  column: number;
  /** Number of visible characters. */
  chars: number;
  /** Set only when font information was requested: most of the line is set in a bold face. */
  bold?: boolean;
  /** True for a running header or footer (same text, ignoring digits, in the top or bottom band of several pages). */
  headerFooter?: boolean;
  /**
   * Set only for a line that the extraction joined from pieces standing side by side (the rows of a fraction, or the rows
   * of two columns whose heights overlap): the box of each piece, so that a reader can tell where each one lies. `rect` is
   * the union of them.
   */
  parts?: Rect[];
}

export interface PageSize {
  /** Displayed width and height in points (after /Rotate). */
  width: number;
  height: number;
  /** The page's own /Rotate value (0, 90, 180, 270). */
  rotation: number;
}

export interface PageText {
  page: number;
  size: PageSize;
  /** In reading order: columns left to right, each top to bottom. */
  lines: TextLine[];
  /** Number of columns detected (1 for a normal page). */
  columns: number;
  /** False when the page has no text layer (a scan or an image-only page). */
  hasText: boolean;
  /**
   * Set only when requested: for each of INK_BANDS horizontal bands of the page (top to bottom), the share of the page
   * width that is dark. Lets proposals include figures that have no text and leave blank answer space out.
   */
  ink?: number[];
}

/** Number of horizontal bands of an ink profile. */
export const INK_BANDS = 400;
