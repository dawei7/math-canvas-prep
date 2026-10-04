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
  "generator": { "name": "math-canvas-prep", "version": "0.2.0" },
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

A project that audits a book as an authority also carries the book's own information, the sections (outline entries with ids)
and authoritative exercises that name them (see "Two kinds of exercise" below):

```json
{
  "meta": {
    "title": "Pre-Algebra",
    "folder": "Books/Algebra",
    "author": "A. Author",
    "series": "Prerequisites",
    "description": "What the book is about, in a few sentences.",
    "license": { "name": "CC BY 3.0", "url": "https://creativecommons.org/licenses/by/3.0/" },
    "sourceUrl": "https://example.org/the-book",
    "notice": "Attribution: A. Author. Changes: marked for study."
  },
  "frames": [
    {
      "id": "f31", "kind": "exercise", "page": 17, "rect": { "left": 0.09, "top": 0.412, "right": 0.91, "bottom": 0.478 },
      "authority": "book", "label": "5a", "section": "1.2",
      "context": [ { "page": 17, "rect": { "left": 0.09, "top": 0.36, "right": 0.91, "bottom": 0.41 } } ],
      "solution": [ { "page": 211, "rect": { "left": 0.1, "top": 0.527, "right": 0.5, "bottom": 0.543 } } ]
    }
  ],
  "outline": {
    "source": "manual",
    "entries": [
      { "title": "Chapter 1 Integers", "page": 5, "depth": 0, "id": "c1", "label": "Chapter 1" },
      { "title": "1.2 Subtracting integers", "page": 17, "depth": 1, "id": "1.2", "label": "1.2", "top": 0.0998 }
    ]
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
| `meta.author`, `meta.series` | Who wrote the work and which series it belongs to (each up to 200 characters). Optional. |
| `meta.description`, `meta.notice` | What the book is about; the text its licence asks to be shown with it (attribution, what was changed). Up to 4000 characters each. Optional. |
| `meta.license` | `{ "name": "CC BY 3.0", "url": "https://..." }`: `name` up to 100 characters, `url` optional. |
| `meta.sourceUrl` | Where the work comes from. `http` or `https`, up to 500 characters. All of these go into the bundle's manifest (`document`), see [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md), section 2. |
| `seq` | Counter for generated ids. It only grows, so an id is never reused after a frame is deleted. |
| `frames` | The marked regions: **exactly the frame schema of [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md), section 3** (`id`, `kind`, `page`, `rect`, `continues`, `unit`, `context`, and for audited exercises `authority`, `label`, `section`, `solution`). |
| `outline` | Optional. When present it becomes `outline.json` in the bundle and the app shows it instead of the PDF's own contents. `source` records where it came from (`pdf`, `derived` by heuristics, `manual`). Its entries may carry `id`, `label` and `top` (section 4 of the format): they are the **sections** that authoritative exercises name. When absent the bundle carries no outline and the app reads the PDF's. |

Fields the tools do not know are kept when the file is saved.

## Coordinates and ids

- `page` is **zero-based**. A `rect` is in **fractions of the page as displayed** (after the page's own `/Rotate`), origin
  at the top-left, `x` to the right and `y` downwards, all between 0 and 1. See the worked example in
  [AGENT_GUIDE.md](AGENT_GUIDE.md).
- Numbers shown to people (`E1`, `E4.2`, `Q1`, `B3`) are **never stored**: they are computed from position, exactly as
  the app does it (page by page, top before bottom, left before right; the parts of one unit count once at the position of
  the unit's first part). Authoritative exercises have no such number: they are named by the number the book prints.
- Generated ids look like `f1`, `f2`, ... for frames and `u3` for units. They are only names that relate frames to each
  other (a part to its unit); they do not match the printed numbers and they do not change when frames are inserted
  before them. An id you write yourself must match `[A-Za-z0-9_-]{1,40}`.
- The parts of one exercise share a `unit` and tile one area on every page (see BUNDLE_FORMAT.md, "Parts"). Put the context
  of an exercise with parts on its **first part**; the tools do that themselves.

## Two kinds of exercise

- **Ordinary exercises** are the ones a person (or an agent for a person) frames for themselves: free, positional numbers
  (`E1`, `E2.1`), and they can be cut into parts (`unit`).
- **Authoritative exercises** (`"authority": "book"`) are audited from a book once and carry **the number the book prints**
  (`label`: `5`, `5a`, `A.3`) inside the **section** of the book they belong to (`section`: the `id` of an outline entry).
  They are single exercises: no `unit`, no parts. The parts of a printed exercise (`5a`, `5b`) are two exercises with two
  labels, and what they share (the statement printed once above them) is `context` on each. The pair (`section`, `label`) is
  unique; applying an `add` for an exercise that exists is an error unless it says `replace`. A tool can name an
  authoritative exercise as `SECTION:LABEL` (`1.2:5a`) wherever it takes a frame id.
- `solution` (at most 8 regions of the same PDF, for example the answer key at the back) is hidden from the learner and used
  only to grade; `context` is the instruction the learner sees and the AI receives. Both are only for exercises.

## The book summary (`book show --json`, `book export`)

`mcprep book show --json` prints, and `mcprep book export --out FILE` writes, one plain JSON document that says what a
book is and how it is divided: the information about the work, every outline entry as a section with the number of
authoritative exercises (and solutions) in it, and the totals. It is camelCase, pages are zero-based, and it is described by
[`schemas/book-summary.schema.json`](../schemas/book-summary.schema.json) (`mcprep schema book-summary`). The same summary comes
out of a bundle that was read back (`inspect-bundle --json`, field `summary`).

```json
{
  "format": "math-canvas-book-summary",
  "version": 1,
  "generator": { "name": "math-canvas-prep", "version": "0.2.0" },
  "document": {
    "title": "Pre-Algebra Workbook", "pageCount": 4, "folder": "Books/Algebra", "author": "A. Author",
    "license": { "name": "CC BY 3.0", "url": "https://creativecommons.org/licenses/by/3.0/" },
    "sourceUrl": "https://example.org/the-workbook", "notice": "Attribution: A. Author ...", "sha256": "5235...", "bytes": 5553
  },
  "sections": [
    { "index": 0, "id": "1", "title": "Chapter 1 Integers", "page": 0, "depth": 0, "parent": null,
      "exercises": 0, "exercisesTotal": 8, "withSolution": 0, "withSolutionTotal": 8 },
    { "index": 1, "id": "1.1", "label": "1.1", "title": "1.1 Adding integers", "page": 0, "top": 0.2577, "depth": 1, "parent": 0,
      "exercises": 4, "exercisesTotal": 4, "withSolution": 4, "withSolutionTotal": 4, "firstLabel": "1", "lastLabel": "3b" }
  ],
  "totals": { "sections": 6, "sectionsWithId": 6, "exercises": 10, "withSolution": 10, "withoutSolution": 0, "unfiled": 0,
              "ordinary": { "exercises": 0, "questions": 0, "bookmarks": 0 } }
}
```

| Field | Meaning |
| --- | --- |
| `document` | `title`, `pageCount`, `folder`, and when set `author`, `series`, `description`, `license`, `sourceUrl`, `notice`, as in the manifest; `sha256` and `bytes` of the PDF the summary was made for (a project knows them). |
| `sections` | **Every** entry of the outline in reading order: `index` (its position), `id`, `label`, `title`, `page`, `top`, `depth`, `parent` (the `index` of the entry above, `null` for a top-level one). |
| `exercises`, `withSolution` | Authoritative exercises filed under the entry itself, and how many of them have at least one solution region. |
| `exercisesTotal`, `withSolutionTotal` | The same for the entry and everything below it (its chapter, for example). |
| `firstLabel`, `lastLabel` | The labels of the first and the last of the entry's own exercises in reading order. |
| `items` | Only with `--exercises`: the entry's own exercises `{ id, label, page, solutionRegions }` in reading order. |
| `totals` | Numbers of entries, entries with an id, authoritative exercises with and without a solution, exercises filed under a section the outline does not have (`unfiled`, an error that `validate` reports), and what a person framed for themselves in the same document (`ordinary`). |

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

The rules about books have stable codes:

| Code | Severity | Meaning |
| --- | --- | --- |
| `bad-authority`, `authority-not-exercise`, `authority-unit` | error | The authority is not `book`; it is on a question or bookmark; the frame also has a `unit`. |
| `label-missing`, `section-missing`, `label-without-authority`, `section-without-authority` | error | An authoritative exercise needs both a label and a section; neither is allowed without the authority. |
| `bad-label`, `bad-section` | error | The label is not 1 to 24 allowed characters; the section is not a well-formed id. |
| `duplicate-exercise` | error | Two frames are the same (`section`, `label`). |
| `section-unknown` | error | The section is not the `id` of an outline entry (or the project has no outline with ids). |
| `solution-not-exercise`, `too-many-regions`, `bad-region`, `page-out-of-range`, ... | error | Solution regions are only for exercises, at most 8, valid and on pages of the document. |
| `outline-bad-id`, `outline-duplicate-id`, `outline-bad-label`, `outline-bad-top` | error | An outline entry's id, label or top is not valid, or an id is used twice. |
| `info-bad-type`, `info-too-long`, `info-bad-url`, `info-bad-license` | error | The author, series, description, notice, licence or source address in `meta` cannot go into a bundle as it is. |
| `label-style` | warning | The label ends with the `.` or `)` the book prints after the number. |
| `section-mismatch` | warning | The exercise is printed in another section than the one it is filed under. |
| `solution-overlaps-frame`, `solution-is-exercise` | warning | A solution region lies on the exercise itself, or is the region of another exercise. |
