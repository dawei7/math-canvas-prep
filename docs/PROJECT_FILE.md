# Project file (`*.mcprep.json`), version 1

A **project** is the work in progress on one PDF: which regions are marked and how. The command line, the MCP server and
the desktop app all read and write the same file, so a person and an agent can take turns on it. When the marking is done,
`export` turns the project into a [bundle](BUNDLE_FORMAT.md) for the Android app.

The project file never contains the PDF. It points to it by a path relative to the project file and records the PDF's
SHA-256, so that frames cannot silently end up on a different file. A JSON Schema is in
[`schemas/project.schema.json`](../schemas/project.schema.json).

## Shape

```json
{
  "format": "math-canvas-prep-project",
  "version": 1,
  "revision": 4,
  "createdAt": "2026-10-03T12:00:00Z",
  "updatedAt": "2026-10-03T12:20:41Z",
  "modifiedBy": "cli",
  "generator": { "name": "math-canvas-prep", "version": "0.1.0" },
  "pdf": {
    "path": "sheet.pdf",
    "sha256": "1f2d...64 lowercase hex characters",
    "bytes": 5446,
    "pageCount": 3
  },
  "meta": { "title": "Calculus Sheet 1", "folder": "Examples/Calculus" },
  "seq": 6,
  "frames": [
    { "id": "f1", "kind": "exercise", "page": 0, "rect": { "left": 0.109, "top": 0.2197, "right": 0.6996, "bottom": 0.2619 } }
  ],
  "outline": {
    "source": "derived",
    "entries": [ { "title": "1 Sets and maps", "page": 0, "depth": 0 } ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `math-canvas-prep-project` and `1`. A file with a larger `version` is refused with a message to update the tools. |
| `revision` | Whole number, +1 on every save. A program that holds the project in memory compares it with the file to notice that someone else changed it. |
| `createdAt`, `updatedAt` | UTC, seconds. |
| `modifiedBy` | Which tool saved last (`cli`, `mcp`, `desktop`). The desktop app shows "updated by an agent" when this is not itself. |
| `pdf.path` | Relative to the project file, forward slashes. The PDF may live in the same folder or elsewhere. |
| `pdf.sha256`, `pdf.bytes`, `pdf.pageCount` | What the PDF was when the project was made. Opening the project with another file is an error (`E_PDF_CHANGED`), unless you explicitly ignore it. |
| `meta.title` | The title the library shows (1 to 200 characters). Defaults to the file name. |
| `meta.folder` | Where the document is filed in the app's library: names separated by `/`, at most seven levels. |
| `seq` | Counter for generated ids. It only grows, so an id is never reused after a frame is deleted. |
| `frames` | The marked regions: **exactly the frame schema of [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md), section 3** (`id`, `kind`, `page`, `rect`, `continues`, `unit`, `context`). |
| `outline` | Optional. When present it becomes `outline.json` in the bundle and the app shows it instead of the PDF's own contents. `source` records where it came from (`pdf`, `derived` by heuristics, `manual`). When absent the bundle carries no outline and the app reads the PDF's. |

Fields the tools do not know are kept when the file is saved.

## Coordinates and ids

- `page` is **zero-based**. A `rect` is in **fractions of the page as displayed** (after the page's own `/Rotate`), origin
  at the top-left, `x` to the right and `y` downwards, all between 0 and 1. See the worked example in
  [AGENT_GUIDE.md](AGENT_GUIDE.md).
- Numbers shown to people (`E1`, `E4.2`, `Q1`, `B3`) are **never stored**: they are computed from position, exactly as
  the app does it (page by page, top before bottom, left before right; the parts of one unit count once at the position of
  the unit's first part).
- Generated ids look like `f1`, `f2`, ... for frames and `u3` for units. They are only names that relate frames to each
  other (a part to its unit); they do not match the printed numbers and they do not change when frames are inserted
  before them. An id you write yourself must match `[A-Za-z0-9_-]{1,40}`.
- The parts of one exercise share a `unit` and tile one area on every page (see BUNDLE_FORMAT.md, "Parts"). Put the context
  of an exercise with parts on its **first part**; the tools do that themselves.

## Reading is tolerant, writing is exact

The reader accepts what a person or an agent is likely to write by hand: a `rect` as `[left, top, right, bottom]` or as the
text `"left,top,right,bottom"`, a `null` unit, missing `meta`, `revision`, `seq` or `generator`. It keeps frames that are
wrong in substance (an unknown page, a too small rect) so that `validate` can name them and a command can fix them. It
refuses only what cannot be represented, and says where: for example
`Project file: frames[3] (f4).rect cannot be read: four numbers are needed.`

The writer always produces the same text for the same project: keys in a fixed order, frames in reading order, rects
rounded to five decimals and kept on one line, two-space indentation.

## Saving: atomic, with a lock and a revision

- A save writes a temporary file in the same folder, flushes it and renames it over the project file, so a reader never
  sees half a file and a crash never leaves one.
- Commands that change the project take a lock file next to it (`name.mcprep.lock`, removed afterwards; a lock older than
  30 seconds is taken over) and read the project fresh under the lock, so two programs working at the same time do not
  lose each other's changes.
- The desktop app watches the file. When it changes on disk it reloads it and shows what changed; if you have unsaved edits it
  asks which to keep. It saves only when the file's `revision` is still the one it loaded.

## Validation

`mcprep validate` runs every rule of the bundle format on the project and lists **errors** (the importer would reject
them), **repairs** (the importer fixes them silently; the writer fixes them too) and **warnings** (allowed, but probably
not what you want: overlapping frames, edges that cut a line of text, a running header inside a frame). Each issue names
the frame id and says how to fix it.
