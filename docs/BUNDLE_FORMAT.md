# Bundle format (`.mcbundle`), version 1

A **bundle** is one file that carries a PDF together with its prework (the marked exercises, questions, bookmarks, the
context that belongs to them, and optionally a table of contents). *Professor Euler: Math Canvas* (the Android app)
imports a bundle straight into its documents library; **Math Canvas Prep** (this repository) writes them.

The format is deliberately small and strict so that a person, a program and an AI agent can all produce it correctly.
This page is the contract. The reference implementation of reading, validating and writing is
`packages/core/src/bundle`; the Android importer follows this text.

## 1. The container

- A ZIP archive, extension `.mcbundle`, UTF-8 entry names, no encryption, no directories, deflate or stored.
- Exactly these entries (names are case-sensitive and fixed):

| Entry | Required | What it is |
| --- | --- | --- |
| `bundle.json` | yes | The manifest (section 2). |
| `document.pdf` | yes | The PDF, byte for byte what the learner should read. It is never modified. |
| `frames.json` | yes | The marked regions (section 3). May hold an empty list. |
| `outline.json` | no | A table of contents (section 4). |

- Any other entry is ignored and never extracted. A reader must not use entry names as file paths.
- Limits a reader enforces (reject the bundle when exceeded): at most 16 entries, `document.pdf` at most 512 MiB, each
  JSON entry at most 4 MiB, the whole archive at most 600 MiB.

## 2. `bundle.json`

```json
{
  "format": "math-canvas-bundle",
  "version": 1,
  "createdAt": "2026-10-03T17:00:00Z",
  "generator": { "name": "math-canvas-prep", "version": "0.1.0" },
  "document": {
    "title": "Analysis 1: Exercise sheets",
    "fileName": "analysis1.pdf",
    "pdf": "document.pdf",
    "sha256": "<64 lowercase hex characters of document.pdf>",
    "bytes": 1234567,
    "pageCount": 42,
    "folder": "University/Analysis/Sheets"
  },
  "frames": "frames.json",
  "outline": "outline.json"
}
```

- `format` must be `"math-canvas-bundle"`. `version` is an integer; a reader that knows only version 1 **rejects** a
  larger one with a clear message ("This bundle needs a newer app") instead of guessing. New optional fields may appear
  in version 1 files; readers ignore fields they do not know.
- `document.title` is what the library shows (1 to 200 characters after trimming). `fileName` is informational.
- `document.sha256`, `bytes` and `pageCount` must match `document.pdf`; a reader verifies the hash and rejects the bundle
  on a mismatch (a damaged or tampered file).
- `document.folder` is optional: where the document is filed in the library, as names separated by `/`, at most seven
  levels. A reader cleans every name (no control characters or `/`, trimmed, at most 60 characters) and drops levels beyond
  the seventh.
- `outline` is omitted when there is no `outline.json`.

## 3. `frames.json`

```json
{
  "version": 1,
  "frames": [
    {
      "id": "e1",
      "kind": "exercise",
      "page": 2,
      "rect": { "left": 0.08, "top": 0.12, "right": 0.92, "bottom": 0.31 }
    },
    {
      "id": "e2a",
      "kind": "exercise",
      "page": 2,
      "rect": { "left": 0.08, "top": 0.35, "right": 0.92, "bottom": 0.5 },
      "unit": "u2",
      "context": [ { "page": 2, "rect": { "left": 0.08, "top": 0.32, "right": 0.92, "bottom": 0.35 } } ]
    },
    {
      "id": "e2b",
      "kind": "exercise",
      "page": 2,
      "rect": { "left": 0.08, "top": 0.5, "right": 0.92, "bottom": 0.66 },
      "unit": "u2"
    },
    {
      "id": "q1",
      "kind": "question",
      "page": 3,
      "rect": { "left": 0.1, "top": 0.2, "right": 0.9, "bottom": 0.27 },
      "continues": [ { "page": 4, "rect": { "left": 0.1, "top": 0.05, "right": 0.9, "bottom": 0.14 } } ]
    }
  ]
}
```

### Coordinates

- `page` is **zero-based**. A `rect` is given in **fractions of the page as it is displayed** (after the page's own
  `/Rotate` is applied), origin at the **top-left**, `x` to the right, `y` downwards, all values between 0 and 1.
- A region must be at least `0.02` wide and `0.01` tall (one line of text on a normal page is about `0.015`).
- A reader clamps values that are outside 0..1 by up to `0.005` and rejects anything further out.

### A frame

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique within the file, `[A-Za-z0-9_-]{1,40}`. Only used to relate frames to each other; the app makes its own ids. |
| `kind` | yes | `exercise` (to solve and be checked), `question` (to ask the AI tutor about), `bookmark` (a place with notes of the learner's own). |
| `page`, `rect` | yes | The frame's main region. |
| `continues` | no | At most 8 further regions of the **same task** that follow the main region (for example where an exercise continues on the next page), in reading order. Not allowed on a frame that has a `unit`. |
| `unit` | no | Frames that share a `unit` id are the **parts** of one exercise ((a), (b), (c) become 1.1, 1.2, 1.3). Only `exercise` frames can have one. |
| `context` | no | At most 8 regions holding the instruction, question or background that belongs to this exercise, wherever it is printed (it may be on another page). It is shown first when the exercise is shown and goes to the AI with every check. Only `exercise` frames can have context. |

### Parts (units)

- All frames with the same `unit` are `exercise` frames with no `continues`.
- **On every page they occupy, the parts tile one area**: sorted from top to bottom, each part's `top` equals the previous
  part's `bottom` (within `0.002`), and all parts there have the same `left` and `right` (within `0.002`). Parts never
  overlap and leave no gap. A reader snaps deviations up to `0.002` and rejects larger ones.
- `context` on any one part applies to the whole unit; a reader takes the union of all parts' contexts and gives it to every part.

### Numbering is not stored

The app numbers frames by position, never from the file: separately for exercises, questions and bookmarks, page by
page, top before bottom, left before right; the parts of one unit count once, at the position of the unit's first part
(so a unit of three parts at exercise position 4 becomes 4.1, 4.2, 4.3). The order of `frames` in the file does not matter.
Tools should show numbers computed the same way (`E4.2`, `Q1`, `B3`).

### What the file never contains

Grades, the learner's work, sheets, chats: a bundle is prework only. Importing never overwrites a learner's work.

## 4. `outline.json` (optional)

```json
{
  "version": 1,
  "entries": [
    { "title": "1 Sets and maps", "page": 0, "depth": 0 },
    { "title": "1.1 Sets", "page": 0, "depth": 1 },
    { "title": "2 Sequences", "page": 11, "depth": 0 }
  ]
}
```

- `entries` are in reading order (not necessarily sorted by page). `title`: 1 to 200 characters. `page`: zero-based, within the
  document. `depth`: 0 to 8; a child follows its parent and is one deeper (a reader tolerates jumps by clamping).
- When present, the app uses it as the document's contents instead of reading titles from the PDF itself.

## 5. Importing: what a reader does

1. Open the archive, apply the limits, find the four entry names; ignore the rest.
2. Parse `bundle.json`, check `format` and `version`.
3. Stream `document.pdf` once while computing SHA-256 and compare with the manifest; check `bytes`.
4. Open the PDF; its page count must equal `pageCount` (a password-protected PDF may not be openable: then `pageCount` is trusted).
5. Parse and validate `frames.json` (sections 3); repair what is allowed to be repaired, otherwise reject with a message
   that names the frame `id`.
6. Create the library document (a PDF that is already in the library, by SHA-256, is not duplicated: the reader offers to
   add the bundle's frames to the existing document instead), file it under `document.folder`, and store frames and outline.

## 6. Versioning

`version` changes only when an old reader would misread a new file. Additions of optional fields do not change it.
Version 1 readers reject version 2 and later; writers say which readers they target in `generator`.
