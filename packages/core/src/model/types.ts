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
}

export interface OutlineEntry {
  title: string;
  /** Zero-based page. */
  page: number;
  depth: number;
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

export interface BundleManifest {
  format: 'math-canvas-bundle';
  version: 1;
  createdAt: string;
  generator: { name: string; version: string; targets?: string };
  document: {
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
