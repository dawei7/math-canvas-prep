# Bundle format (`.mcbundle`), version 1

A **bundle** is one file that carries a PDF together with its prework (the marked exercises, questions, bookmarks, the
context that belongs to them, and optionally a table of contents whose entries are the *sections* of the book). A book
that was audited once on a computer can also carry **authoritative exercises** (they keep the numbers the book prints) and
the **solutions** to grade them with (hidden from the learner). *Professor Euler: Math Canvas* (the Android app)
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
  JSON entry at most 16 MiB, the whole archive at most 600 MiB.
- A JSON entry is UTF-8 text (a leading byte order mark is ignored) whose objects and lists nest at most 32 levels deep; a
  reader rejects bytes that are not UTF-8 and deeper nesting.

## 2. `bundle.json`

```json
{
  "format": "math-canvas-bundle",
  "version": 1,
  "createdAt": "2026-10-03T17:00:00Z",
  "generator": { "name": "math-canvas-prep", "version": "0.2.0" },
  "features": ["sections", "authority", "solution"],
  "document": {
    "title": "Analysis 1: Exercise sheets",
    "fileName": "analysis1.pdf",
    "pdf": "document.pdf",
    "sha256": "<64 lowercase hex characters of document.pdf>",
    "bytes": 1234567,
    "pageCount": 42,
    "folder": "University/Analysis/Sheets",
    "author": "A. Author",
    "series": "Prerequisites",
    "description": "What the book is about, in a few sentences.",
    "license": { "name": "CC BY 3.0", "url": "https://creativecommons.org/licenses/by/3.0/" },
    "sourceUrl": "https://example.org/the-book",
    "notice": "The text the licence asks to be shown with the work, for example the attribution and what was changed."
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
  on a mismatch (a damaged or tampered file). `sha256` is written in lowercase hex (a reader rejects upper case, since it
  compares the text as written), `bytes` is a whole number of at least 1 and `pageCount` a whole number from 1 to 2147483647.
- `document.folder` is optional: where the document is filed in the library, as names separated by `/`, at most seven
  levels. A reader cleans every name (no control characters or `/`, trimmed, at most 60 characters) and drops levels beyond
  the seventh. It is text: a reader rejects a folder of any other kind.
- `outline` is omitted when there is no `outline.json`.
- The entry names of section 1 are fixed. Where the manifest gives them, `document.pdf` is `"document.pdf"`, `frames` is
  `"frames.json"` and `outline` is `"outline.json"`; a reader rejects a manifest that names any other entry, and one that
  names `outline.json` when the archive has none. A JSON `null` counts as left out. An `outline.json` that the manifest does
  not name is read all the same.
- `document.author`, `series` (each at most 200 characters), `description`, `notice` (each at most 4000), `license.name` (at most
  100), `license.url` and `sourceUrl` (http or https, at most 500) describe the work itself and are all optional. A reader
  shows author, licence and notice where it shows the document's details: a licence that asks for attribution travels with the file.
  A reader is lenient about them, as it is about `folder`: a text that is too long is cut to its limit, a value of the wrong
  kind is ignored, and so is a web address that is not http or https (a licence without a usable `name` is ignored as a
  whole); none of this rejects the bundle. A writer is strict and treats the same problems as errors.
- `features` is optional and informational: which of `sections` (outline entries with ids), `authority` (authoritative
  exercises) and `solution` (hidden solution context) the writer used. A reader that does not implement one of them still reads
  the bundle: it shows authoritative exercises as ordinary exercises and never shows or sends `solution` regions.

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
| `authority` | no | `"book"`: an **authoritative exercise**, audited from the book and numbered the way the book numbers it (see "Authoritative exercises"). Only `exercise` frames. Absent: an ordinary exercise, framed by a person for themselves. |
| `label` | with `authority` | The exercise's number exactly as the book prints it, without the closing `.` or `)`: `5`, `12`, `5a`, `A.3`, `II-4`. 1 to 24 characters: a letter or digit first, then letters, digits, spaces and the characters `. _ - ( ) /` (regular expression `^[\p{L}\p{N}][\p{L}\p{N} ._\-()/]{0,23}$`). Tools warn about a label that ends in `.` or `)` (apart from a closed `(a)`). A reader drops such a closing `.` or `)` before it checks the label (`5.` becomes `5`) and keeps the label so; it drops one character, and the spaces before it, and changes nothing else (`5..` becomes `5.`). |
| `section` | with `authority` | The `id` of the outline entry (section 4) the exercise belongs to. |
| `solution` | no | At most 8 regions **of the same document** where the solution or answer of this exercise is printed (for example the answer key at the back of the same PDF). **Hidden**: never shown with the exercise, never sent to a tutor chat, used only to grade. Only `exercise` frames. |

### Parts (units)

- All frames with the same `unit` are `exercise` frames with no `continues`, none of them authoritative.
- **On every page they occupy, the parts tile one area**: sorted from top to bottom, each part's `top` equals the previous
  part's `bottom` (within `0.002`), and all parts there have the same `left` and `right` (within `0.002`). Parts never
  overlap and leave no gap. A reader snaps deviations up to `0.002` and rejects larger ones.
- `context` on any one part applies to the whole unit; a reader takes the union of all parts' contexts and gives it to every part.

### Authoritative exercises (`authority: "book"`)

A book can be audited once, on a computer, and then be offered to many learners as an authority: its exercises carry the
numbers the book prints and cannot be edited, split or renumbered on the tablet. Exercises that a learner frames for
themselves stay **ordinary** (free, positional numbers). The two kinds can live in one document.

- An authoritative frame is a **single exercise**: no `unit`. The parts of an exercise (`5a`, `5b`) are two exercises with
  two labels; what they share is `context`. It may have `continues`, `context` and `solution`.
- `label` and `section` are required together with `authority` and are not allowed without it.
- The pair (`section`, `label`) is unique in the file, the label being the one a reader keeps (`5` and `5.` are the same
  label). A section is the unit in which the book numbers its exercises: a book that starts again at 1 in every practice set
  needs one section for each set.
- `section` names an outline entry by `id` (section 4), so a bundle with authoritative exercises carries `outline.json`
  with those ids.
- Authoritative exercises do **not** take part in the positional numbering below and are not counted by it. A reader names one
  by its label and its section.
- A reader that does not know `authority` shows the frame as an ordinary exercise; nothing else changes.

An authoritative exercise with its shared statement as context and its answer in the key at the back of the same PDF:

```json
{
  "id": "f31",
  "kind": "exercise",
  "page": 17,
  "rect": { "left": 0.09, "top": 0.412, "right": 0.91, "bottom": 0.478 },
  "authority": "book",
  "label": "5a",
  "section": "1.2",
  "context": [ { "page": 17, "rect": { "left": 0.09, "top": 0.36, "right": 0.91, "bottom": 0.41 } } ],
  "solution": [ { "page": 211, "rect": { "left": 0.1, "top": 0.527, "right": 0.5, "bottom": 0.543 } } ]
}
```

### Solution context (`solution`)

`context` is what the learner is shown (the instruction) and what the grader receives. `solution` is the other side: what
**only the grader** receives, as the answer key to compare the learner's work with.

- A frame has at most 8 solution regions, each a region like those of `continues` and `context` (a valid rect, on a page of
  the document). Solution regions only on `exercise` frames, authoritative or not.
- Only regions of the same PDF count; a solution printed elsewhere (another file, a web page) is outside the format.
- Typically the answer key sits at the back of the same PDF: one small region for each exercise (the line "22) 0"), or a
  block that answers several.
- A reader never draws it on a page, never shows it with the exercise, never puts it into an export for the learner and
  never sends it to a tutor chat. It may add it to a grading request, labelled as the answer key.
- It is not a security boundary: the PDF still contains those pages and the learner can open them.

### Numbering is not stored

The app numbers frames by position, never from the file: separately for exercises, questions and bookmarks, page by
page, top before bottom, left before right; the parts of one unit count once, at the position of the unit's first part
(so a unit of three parts at exercise position 4 becomes 4.1, 4.2, 4.3). Authoritative exercises are left out of it: they
are named by their label. The order of `frames` in the file does not matter. Tools should show numbers computed the same way
(`E4.2`, `Q1`, `B3`).

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

A book prepared as an authority names its sections with `id`, `label` and `top`:

```json
{
  "version": 1,
  "entries": [
    { "title": "Pre-Algebra", "page": 5, "depth": 0, "id": "c0", "label": "Chapter 0" },
    { "title": "Integers", "page": 6, "depth": 1, "id": "0.1", "label": "0.1", "top": 0.0998 },
    { "title": "Fractions", "page": 11, "depth": 1, "id": "0.2", "label": "0.2", "top": 0.0998 }
  ]
}
```

- `entries` are in reading order (not necessarily sorted by page). `title`: 1 to 200 characters. `page`: zero-based, within the
  document. `depth`: 0 to 8; a child follows its parent and is one deeper (a reader tolerates jumps by clamping).
- When present, the app uses it as the document's contents instead of reading titles from the PDF itself.
- `id` (optional): `[A-Za-z0-9][A-Za-z0-9._-]{0,59}`, unique among the entries; the key by which a frame's `section` finds
  its entry. Writers give an id to every entry that exercises refer to.
- `label` (optional, at most 24 characters; an empty one is the same as none): the number printed with the heading ("1.1",
  "Chapter 3").
- `top` (optional, 0 to 1): where the heading starts on its `page`, measured from the top. With it a reader can tell, on a
  page where one section ends and the next begins, which part belongs to which. An entry without `top` starts at the top of
  its page.
- A reader rejects an `id` that does not match the pattern or is used by two entries, a `label` longer than 24 characters and
  a `top` outside 0 to 1, and names the entry.
- A **section** is an outline entry that exercises refer to. Its extent runs from its page (and `top`) to the next entry of
  the same or a lower depth, so a reader can count the exercises of a section and of everything below it.

## 5. Importing: what a reader does

1. Open the archive, apply the limits, find the four entry names; ignore the rest.
2. Parse `bundle.json`, check `format`, `version`, the document block and the entry names it gives (section 2).
3. Stream `document.pdf` once while computing SHA-256 and compare with the manifest; check `bytes`.
4. Open the PDF; its page count must equal `pageCount` (a password-protected PDF may not be openable: then `pageCount` is trusted).
5. Parse and validate `frames.json` (section 3, including the rules of authoritative exercises and solution regions) and
   `outline.json` (section 4: ids unique, every `section` of a frame found); repair what is allowed to be repaired,
   otherwise reject with a message that names the frame `id`.
6. Create the library document (a PDF that is already in the library, by SHA-256, is not duplicated: the reader offers to
   add the bundle's frames to the existing document instead), file it under `document.folder`, and store frames and outline.
   Adding frames to a document that is already there never touches the learner's frames: an authoritative frame whose
   (`section`, `label`) the document already has is skipped, the others are added.

## 6. Versioning

`version` changes only when an old reader would misread a new file. Additions of optional fields do not change it.
Version 1 readers reject version 2 and later; writers say which readers they target in `generator`.

Added in generator 0.2, all optional: the manifest's `features` and `document.author`, `series`, `description`, `license`,
`sourceUrl`, `notice`; the frame fields `authority`, `label`, `section`, `solution`; the outline entry fields `id`, `label`,
`top`; and the limit for one JSON entry rose from 4 to 16 MiB. An older reader reads such a bundle as before: authoritative
exercises become ordinary ones, `solution` regions are ignored (so nothing is revealed), and the outline keeps working.
