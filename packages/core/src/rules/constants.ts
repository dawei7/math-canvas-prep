/** The numbers of docs/BUNDLE_FORMAT.md, in one place. */

export const FORMAT = {
  bundleFormat: 'math-canvas-bundle',
  bundleVersion: 1,
  projectFormat: 'math-canvas-prep-project',
  projectVersion: 1,
  generatorName: 'math-canvas-prep',
} as const;

export const LIMITS = {
  /** A region must be at least this wide and this tall (page fractions). */
  minWidth: 0.02,
  minHeight: 0.01,
  /** A reader clamps values outside 0..1 by up to this much and rejects anything further out. */
  clampTolerance: 0.005,
  /** Parts of a unit tile within this tolerance; a reader snaps deviations up to it and rejects larger ones. */
  tileTolerance: 0.002,
  /** At most this many `continues` regions, and this many `context` regions, per frame. */
  maxRegions: 8,
  idPattern: /^[A-Za-z0-9_-]{1,40}$/,
  titleMax: 200,
  folderLevels: 7,
  folderNameMax: 60,
  outlineTitleMax: 200,
  outlineDepthMax: 8,
  bundle: {
    maxEntries: 16,
    maxPdfBytes: 512 * 1024 * 1024,
    maxJsonBytes: 4 * 1024 * 1024,
    maxArchiveBytes: 600 * 1024 * 1024,
  },
} as const;

/**
 * Authoring conventions of this tool (not part of the format). They come from the behaviour of the Android app's
 * exercise splitter, which these tools mirror so that a bundle behaves like frames made on the tablet.
 */
export const AUTHORING = {
  /** The thinnest piece a frame can be cut into: a little under one line of text on an A4 page. */
  minPieceHeight: 0.01,
  /** A divider or an edge moves onto a text line when one is this close. */
  snapDistance: 0.03,
  /** How far above its line a divider or a top edge sits, so the line lies wholly inside the part it opens. */
  startPadding: 0.006,
  /** How far below its last line a bottom edge sits. */
  endPadding: 0.004,
  /** When a rect is enlarged to the minimum size it is made a little larger than the limit, not exactly on it. */
  enlargeWidth: 0.0205,
  enlargeHeight: 0.0105,
  /** Tolerance for float noise when comparing against the limits above. */
  epsilon: 1e-9,
  /** Decimal places of stored coordinates. */
  digits: 5,
  /** A default one-line frame is this much of the page wide when no text line is found. */
  defaultWidth: 0.8,
  defaultHeight: 0.04,
} as const;
