# Command line reference: `mcprep`

`mcprep` marks exercises, parts, context, questions and bookmarks in a PDF and writes a bundle for the Android app. It is made
for scripts and AI agents as much as for people: no prompts, no network, every command can print one JSON document, and the
exit code says what happened. (This file is generated from the command definitions by `npm run docs:cli`; do not edit it.)

Run it from the repository as `npx mcprep <command>` or `node packages/cli/bin/mcprep.js <command>` after `npm install` and
`npm run build`. `mcprep help` lists the commands, `mcprep help <command>` explains one, `mcprep guide` prints the
[agent guide](AGENT_GUIDE.md).

## Conventions

- **Pages are zero-based**: the first page is `0`. Every `--page`, every page argument and every `page` in JSON.
- **Coordinates** are fractions of the page *as displayed* (after the page's own `/Rotate`), origin at the **top-left**, `x` to
  the right, `y` downwards, all between 0 and 1. A rectangle is written `left,top,right,bottom` on the command line and
  `{ "left": .., "top": .., "right": .., "bottom": .. }` in JSON (an array `[l,t,r,b]` is accepted as input).
- **Labels** such as `E4.2`, `Q1`, `B3` are computed from position and never stored. Refer to a frame by its **id**
  (`f3`), which does not change when other frames are added. An authoritative **book exercise** (audited from a book,
  `authority: "book"`) has no such label: it is named by the number the book prints and its section, `SECTION:LABEL`
  (`1.2:5a`), which every command that takes a frame accepts, and it is never cut into parts.
- **Sections** are the entries of the outline; an entry that exercises are filed under has an `id`. `mcprep book show` lists them with
  the number of exercises in each. See chapter 14 of the [agent guide](AGENT_GUIDE.md).
- **The project** is `--project <file>` (or a folder holding exactly one), else `$MCPREP_PROJECT`, else the only
  `*.mcprep.json` in the current folder.
- **Changes are atomic.** A command that writes the project reads it fresh under a lock, applies the change in memory,
  validates once and writes only if the change did not introduce validation errors (`--force` overrides, `--dry-run` previews).
- **Images** (`render`, `crop`) are written as PNG files, by default into `.mcprep-cache/` next to the project; the JSON
  result names the path. Open them with an image viewer: that is how a model checks its work.
- **The call log.** With the environment variable `MCPREP_CALL_LOG=<file>` every command (not `help` or `--version`) appends one
  line of JSON to the file after it has run: `{"arguments":{...},"exitCode":0,"ok":true,"surface":"cli","tool":"exercises propose"}`,
  keys sorted, `arguments` the options as parsed and the positional arguments under `_`. `scripts/compare-calls.mjs` compares two logs
  (see the [agent guide](AGENT_GUIDE.md), "Comparing two agent runs").

## JSON output

With `--json` the only thing written to standard output is one document:

```json
{ "ok": true, "command": "frames add", "result": { }, "warnings": [ ], "notes": [ ] }
```

- `ok` is `true` exactly when the exit code is 0. `result` holds the data of the command (described under each command below).
- `warnings` lists validation warnings (when there are any) and `notes` short sentences about what happened (what snapping did,
  what was enlarged).
- On failure the document is `{ "ok": false, "command": "...", "error": { "code", "message", "hint"?, "issues"?, "details"? } }`
  and standard error stays empty. `error.code` is stable (`E_PAGE`, `E_RECT_RANGE`, `E_REJECTED`, `E_VALIDATION`, `E_PDF_CHANGED`,
  `E_USAGE`, ...); `hint` says what to do; `issues` are validation issues (each with `code`, `message`, `frameId?`, `fix?`).
- `validate` and `import-check` exit with 4 when they find errors, and then still put the details in `result`.
- Without `--json` the output is plain text for people (errors go to standard error).

A **validation issue** is `{ "severity": "error" | "repair" | "warning", "code", "message", "frameId"?, "unit"?, "page"?, "fix"? }`.
**Errors** are what the importer rejects, **repairs** what it fixes silently, **warnings** what is allowed but suspicious.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success (a validation with only warnings is still 0) |
| 1 | internal error (a bug: please report it) |
| 2 | usage error: unknown command or option, missing argument, a value that is not a number |
| 3 | a file cannot be used: project, PDF or bundle missing, unreadable or damaged; the PDF is not the one the project was made for; another program holds the lock |
| 4 | the request was understood but the data is not acceptable: validation errors (validate, export), a change that would introduce errors, a page or frame that does not exist, a rectangle that is not a valid region, a bundle the importer would reject (import-check), a finding that `exercises verify --fail-on` names (an error by default) |

## Commands

- [`init`](#init): Create a project for a PDF.
- [`info`](#info): Show the project, the PDF (pages, sizes, text layer, outline) and the frames.
- [`lines`](#lines): List the text lines of a page with their coordinates.
- [`render`](#render): Render a page to a PNG, optionally with a coordinate grid and the frames drawn on it.
- [`crop`](#crop): Render one frame, or any rectangle of a page, to a PNG: the way to check a frame by looking at it.
- [`outline`](#outline): Show the contents the bundle will carry (the sections of the book): the project's own outline with ids and exercise counts, or the PDF's.
- [`outline pdf`](#outline-pdf): Read the PDF's own outline (its bookmarks).
- [`outline derive`](#outline-derive): Find headings by font size, bold, position and numbering, for a PDF without an outline.
- [`outline set`](#outline-set): Replace the project's outline with entries from a JSON file (or - for standard input).
- [`outline add`](#outline-add): Add an entry (a section) to the outline.
- [`outline update`](#outline-update): Change an outline entry: its title, page, depth, label, top or id.
- [`outline delete`](#outline-delete): Delete an outline entry.
- [`outline ids`](#outline-ids): Give every outline entry that has no id one (from its printed label, else the number in its title), so that exercises can name it.
- [`outline clear`](#outline-clear): Remove the project's own outline (the bundle then carries none and the app reads the PDF's).
- [`propose`](#propose): Suggest exercises, parts, context and bookmarks from the printed text (offline heuristics, nothing is applied).
- [`exercises propose`](#exercises-propose): Find the numbered exercises of the practice sets of a book, with the instruction that governs each (offline heuristics, nothing is applied).
- [`solutions propose`](#solutions-propose): Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.
- [`exercises verify`](#exercises-verify): Check the audited exercises against the text layer of the PDF, without looking: the same list for every agent.
- [`exercises sample`](#exercises-sample): A fixed sample of exercises and answers to look at, chosen by rules (no randomness): the same for every agent.
- [`exercises sheets`](#exercises-sheets): Make contact sheets of every exercise (or of a section, or of the fixed sample) with its instruction, continuations and answer, to look at them all.
- [`frames list`](#frames-list): List the frames in reading order with their labels: positional (E1, E2.1, Q1, B1) or, for book exercises, the printed one.
- [`frames add`](#frames-add): Add a frame: an exercise, a question or a bookmark.
- [`frames update`](#frames-update): Change the page, rectangle or kind of a frame.
- [`frames delete`](#frames-delete): Delete a frame (or, with --unit, every part of an exercise).
- [`frames move`](#frames-move): Move a frame by a distance in page fractions (an exercise with parts moves as a whole).
- [`frames split`](#frames-split): Cut an exercise into parts: (a), (b), (c) become parts 1.1, 1.2, 1.3 of one exercise.
- [`frames merge`](#frames-merge): Merge parts back into one frame.
- [`frames dividers`](#frames-dividers): Set the cuts between the parts of an exercise (move, add or remove them).
- [`frames area`](#frames-area): Move or resize a whole exercise with parts (the cuts between the parts stay where they are).
- [`frames apply`](#frames-apply): Apply many operations at once, atomically, with one validation at the end.
- [`context add`](#context-add): Attach a region of context (the instruction, question or background printed elsewhere) to an exercise.
- [`context remove`](#context-remove): Remove a context region of an exercise.
- [`continues add`](#continues-add): Add a further region of the same task, for example where an exercise goes on in the next column or on the next page.
- [`continues remove`](#continues-remove): Remove a continuation region.
- [`exercises list`](#exercises-list): List the authoritative book exercises: label, section, page, and whether a solution is attached.
- [`exercises add`](#exercises-add): Add an authoritative exercise: one printed exercise, with its printed label, in its section.
- [`exercises mark`](#exercises-mark): Make an exercise you framed an authoritative book exercise: give it the printed label and its section.
- [`exercises unmark`](#exercises-unmark): Turn an authoritative exercise back into an ordinary one (positional number, can be cut into parts).
- [`exercises label`](#exercises-label): Change the label (the printed number) of an authoritative exercise.
- [`exercises section`](#exercises-section): Move an authoritative exercise to another section.
- [`solution add`](#solution-add): Attach a region where the answer is printed (usually the answer key at the back) to an exercise; hidden from the learner.
- [`solution list`](#solution-list): List the solution regions of an exercise, or of every exercise that has some.
- [`solution remove`](#solution-remove): Remove one solution region of an exercise (by index), or all of them.
- [`solution clear`](#solution-clear): Remove every solution region of an exercise.
- [`book show`](#book-show): Show the book: its information, its sections with the number of authoritative exercises in each, and the totals.
- [`book meta`](#book-meta): Show or change what the bundle says about the book: title, library folder, author, series, description, licence, source address and notice.
- [`book export`](#book-export): Write the book summary (sections with exercise counts, totals, document information) as a plain JSON file.
- [`book compare`](#book-compare): Compare the audited sections and their exercise counts with a reference list of the book; exit code 4 when anything differs.
- [`audit gate`](#audit-gate): The end of an audit: run every check without looking, say what is open, exit 0 only when nothing is; writes the certificate.
- [`audit ack`](#audit-ack): Acknowledge a finding as what the BOOK prints, with the reason; never for a defect of ours.
- [`meta`](#meta): Show or change the title and library folder of the project (author, licence and notice: `book meta`).
- [`relink`](#relink): Point the project at the PDF where it now is.
- [`validate`](#validate): Check the project against every rule of the bundle format; errors name the frame and the fix.
- [`export`](#export): Write the project as a .mcbundle: the PDF plus its frames and outline, ready for the Android app's library.
- [`inspect-bundle`](#inspect-bundle): Look inside a .mcbundle: manifest, entries, frames with their labels, outline, problems.
- [`import-check`](#import-check): Do exactly what the Android importer does with a bundle, step by step, and say whether it would accept it.
- [`schema`](#schema): Print a JSON Schema: bundle-manifest, frames, outline, project, book-summary, verify, sample, gate, notes, compare, sheets.
- [`guide`](#guide): Print the guide for AI agents that mark a PDF with this tool.

## init

Create a project for a PDF.

```
mcprep init <pdf> [options]
```

Reads the PDF once (page count, SHA-256) and writes <name>.mcprep.json next to it. The project holds the frames you mark; the PDF is only referenced by a relative path and its hash.

Arguments:

- `pdf`: The PDF to mark.

Options:

- `-o, --out <file>`: Where to write the project (default: next to the PDF).
- `--title <text>`: The title the app library shows (default: the file name).
- `--folder <A/B>`: Where the document is filed in the library, names separated by "/", at most seven levels.
- `--force`: Overwrite an existing project file.

Examples:

```console
$ mcprep init analysis.pdf --title "Analysis 1: Sheets" --folder "University/Analysis"
$ mcprep init book.pdf --out work/book.mcprep.json --force
```

With `--json`, `result` is: `{ project, pdf: { path, sha256, bytes, pageCount }, title, folder?, next: string[] }`

## info

Show the project, the PDF (pages, sizes, text layer, outline) and the frames.

```
mcprep info [options]
```

Page numbers are zero-based everywhere. The text layer is checked on a sample of up to 12 pages (all pages with --full-text); a page without a text layer is a scan and must be marked by eye (see `render --grid`).

Options:

- `--full-text`: Check the text layer of every page, not a sample.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep info
$ mcprep info --json
```

With `--json`, `result` is: `{ project: { path, title, folder?, revision, modifiedBy?, updatedAt }, pdf: { path, pageCount, bytes, sha256, pageSizes: [{ width, height, rotation, pages }], textLayer: { checked, withText, withoutText: number[] } }, outline: { pdf: number|null, project: number|null, source?, withId? }, frames: { exercises, questions, bookmarks, bookExercises, bookExercisesWithSolution, total, partsOfUnits, byPage } }`

## lines

List the text lines of a page with their coordinates.

```
mcprep lines <page> [options]
```

Lines come in reading order (columns left to right, each top to bottom) with their box as fractions of the displayed page (origin top-left), the font size and the column. Running headers and footers are marked. An empty list means the page has no text layer: it is a scan.

Arguments:

- `page`: Zero-based page.

Options:

- `--region <l,t,r,b>`: Only the lines inside this rectangle (page fractions).
- `--fonts`: Also tell which lines are set in bold (slower).
- `--pdf <file>`: Work on this PDF directly, without a project (no frames, no numbering).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep lines 2
$ mcprep lines 2 --region 0,0.3,1,0.6 --json
```

With `--json`, `result` is: `{ page, size: { width, height, rotation }, columns, hasText, lines: [{ text, rect, fontSize, column, chars, headerFooter?, bold? }] }`

## render

Render a page to a PNG, optionally with a coordinate grid and the frames drawn on it.

```
mcprep render <page> [options]
```

The image is what a model should look at to read coordinates (--grid) and to check the marking (--frames). The grid labels are page fractions with the origin at the top-left.

Arguments:

- `page`: Zero-based page.

Options:

- `--grid <step>`: Draw a labelled grid with a line every <step> of the page (0.1 or 0.05). The labels are page coordinates: read positions straight off the image.
- `--frames`: Draw the project's frames (with their labels E1, E2.1, Q1, B1), continuations and context.
- `--max-side <px>`: Longer side of the image in pixels (default 1600 for a page, 1400 for a crop).
- `--scale <px/pt>`: Pixels per point instead of --max-side.
- `-o, --out <file|folder>`: Where to write the PNG (default: .mcprep-cache next to the project).
- `--solutions`: With --frames: also draw the solution regions (dashed, "sol 5a"): look at the answer key to check them. They are hidden from the learner; this is for whoever audits the book.
- `--pdf <file>`: Work on this PDF directly, without a project (no frames, no numbering).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep render 3 --grid 0.1
$ mcprep render 3 --frames --grid 0.05 --out check/page3.png
$ mcprep render 211 --frames --solutions
```

With `--json`, `result` is: `{ page, path, width, height, scale, view: { left, top, right, bottom }, grid?, frames: number }`

## crop

Render one frame, or any rectangle of a page, to a PNG: the way to check a frame by looking at it.

```
mcprep crop [frame] [options]
```

Give a frame id (or SECTION:LABEL for a book exercise), or --page and --rect. With a grid the labels are still page coordinates, so a crop can be read in page fractions. --all writes a crop of every frame (and its continuation, context and solution regions) in one go; --section limits it to the book exercises of one section. Check the solution regions of a book exercise by looking at them: --region solution:0.

Arguments:

- `frame` (optional): A frame id, or SECTION:LABEL of a book exercise (omit it when you give --page and --rect, or --all).

Options:

- `--page <n>`: Zero-based page (with --rect).
- `--rect <l,t,r,b>`: The rectangle to crop, as page fractions.
- `--region main|continues:N|context:N|solution:N`: Which region of the frame (default main).
- `--all`: Crop every frame of the project.
- `--section <id>`: With --all: only the book exercises filed under this section.
- `--padding <fraction>`: Page fraction to include around the rectangle (default 0.01).
- `--grid <step>`: Draw a labelled grid with a line every <step> of the page (0.1 or 0.05). The labels are page coordinates: read positions straight off the image.
- `--frames`: Draw the project's frames (with their labels E1, E2.1, Q1, B1), continuations and context.
- `--max-side <px>`: Longer side of the image in pixels (default 1600 for a page, 1400 for a crop).
- `--scale <px/pt>`: Pixels per point instead of --max-side.
- `-o, --out <file|folder>`: Where to write the PNG (default: .mcprep-cache next to the project).
- `--solutions`: With --frames: also draw the solution regions (dashed, "sol 5a"): look at the answer key to check them. They are hidden from the learner; this is for whoever audits the book.
- `--pdf <file>`: Work on this PDF directly, without a project (no frames, no numbering).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep crop f3
$ mcprep crop f3 --region context:0 --grid 0.05
$ mcprep crop 1.2:5a --region solution:0
$ mcprep crop --page 2 --rect 0.1,0.3,0.9,0.5 --grid 0.05
$ mcprep crop --all --out check/
$ mcprep crop --all --section 1.2
```

With `--json`, `result` is: `{ crops: [{ frame?, region, page, rect, path, width, height, scale, view }] }`

## outline

Show the contents the bundle will carry (the sections of the book): the project's own outline with ids and exercise counts, or the PDF's.

```
mcprep outline [options]
```

The app shows the bundle's outline.json as the document's contents instead of reading titles from the PDF. When the project has no outline of its own the bundle carries none and the app reads the PDF's. The entries are the sections of the book: an entry that exercises are filed under has an id, may have the printed label and the top of its heading, and is listed with the number of book exercises under it. Sub-commands: `outline pdf` (the PDF's own), `outline derive` (headings found by heuristics), `outline set` (write your own), `outline add`, `outline update`, `outline delete`, `outline ids` (edit it), `outline clear`.

Options:

- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline
$ mcprep outline --json
```

With `--json`, `result` is: `{ source: "project"|"pdf"|"none", entries: [{ index, title, page, depth, id?, label?, top?, exercises?, exercisesTotal?, withSolution? }], projectSource?: "pdf"|"derived"|"manual", totals?: { entries, withId, exercises } }; exercises are the book exercises filed under the entry, exercisesTotal with everything below it`

## outline pdf

Read the PDF's own outline (its bookmarks).

```
mcprep outline pdf [options]
```

Options:

- `--adopt`: Store it as the project's outline (so that you can edit it and it goes into the bundle).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline pdf
$ mcprep outline pdf --adopt
```

With `--json`, `result` is: `{ entries: [{ title, page, depth }] | [], adopted?: boolean }`

## outline derive

Find headings by font size, bold, position and numbering, for a PDF without an outline.

```
mcprep outline derive [options]
```

Heuristics, with their evidence: a line is a heading when it is set larger than the body text, in bold, numbered like "2.1", or starts with a chapter word; the depth comes from the numbering or from the rank of the font size. Check the result (and edit it) before it goes into a bundle.

Options:

- `--book`: For a book that prints numbered chapters and sections: read the printed contents, the lists on the chapter openers and the headings, and propose chapters and sections with ids (c0, 0.1), labels, tops and where each practice set lies. Use it before `exercises propose`.
- `--apply`: Store the result as the project's outline.
- `--min-confidence <0..1>`: Keep headings at least this likely (default 0.55).
- `--chapter-words <chapter,part,...>`: Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults (chapter, part, unit, kapitel, chapitre, capítulo, ...).
- `--practice-words <practice,exercises,...>`: Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, übungen, aufgaben, ...).
- `--answer-words <answers,solutions,...>`: Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults (answers, answer key, solutions, lösungen, ...).
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline derive
$ mcprep outline derive --apply
$ mcprep outline derive --book
$ mcprep outline derive --book --apply
```

With `--json`, `result` is: `{ entries: [{ title, page, depth, confidence, evidence: string[] }], bodyFontSize, applied: boolean, notes: string[] }; with --book each entry also has id, label, top, kind, differences and practice, and the result has chapters, sections, numbering, toc and answerKey`

## outline set

Replace the project's outline with entries from a JSON file (or - for standard input).

```
mcprep outline set <file> [options]
```

The JSON is a list of { "title", "page", "depth", "id"?, "label"?, "top"? } (pages zero-based, depth 0 to 8, a child one deeper than its parent) or an object with an "entries" list. The id is what exercises name as their section, the label the number printed with the heading, the top where the heading starts on its page (0 to 1). --auto-ids gives the entries that have no id one. Exercises that name an id the new outline no longer has make the change an error, so nothing is orphaned.

Arguments:

- `file`: A JSON file, or - for standard input.

Options:

- `--source manual|derived|pdf`: What to record as the origin (default manual).
- `--auto-ids`: Give every entry that has no id one (as `outline ids` does).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline set outline.json
$ mcprep outline set outline.json --auto-ids
$ echo '[{"title":"1 Sets","page":0,"depth":0}]' | mcprep outline set -
```

With `--json`, `result` is: `The usual change report (frames, validation); the outline is in the project.`

## outline add

Add an entry (a section) to the outline.

```
mcprep outline add --title <text> --page <n> [options]
```

The entry goes at the end of the outline, or at position --at (from 0). It gets an id unless you give one or say --no-id; the id is what exercises name with --section. Entries are in reading order and a child follows its parent and is one level deeper (a jump is clamped).

Options:

- `--title <text>` (required): The title (1 to 200 characters).
- `--page <n>` (required): Zero-based page where the heading is.
- `--depth <0..8>`: Level: 0 for a chapter, 1 for a section in it, ... (default 0).
- `--id <id>`: Its id ([A-Za-z0-9][A-Za-z0-9._-], up to 60 characters). Default: made from the label or the title.
- `--no-id`: Do not give it an id (exercises cannot be filed under it).
- `--label <text>`: The number printed with the heading ("1.1", "Chapter 3"), at most 24 characters.
- `--top <0..1>`: Where the heading starts on its page, from the top (0 to 1), so that two sections on one page can be told apart.
- `--at <position>`: Insert at this position of the outline (from 0) instead of at the end.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline add --title "1.2 Subtracting integers" --page 17 --depth 1 --label 1.2 --top 0.1
$ mcprep outline add --title "Appendix" --page 210 --id appendix
```

With `--json`, `result` is: `The usual change report.`

## outline update

Change an outline entry: its title, page, depth, label, top or id.

```
mcprep outline update [id] [options]
```

Name the entry by its id, or by --index when it has none. A new id (--new-id) is taken over by the exercises filed under the old one. --label "" and --top none remove the label and the top. Changing the depth moves only this entry, not the ones below it.

Arguments:

- `id` (optional): The id of the entry (`mcprep outline` lists them).

Options:

- `--index <n>`: The position of the entry in the outline (from 0), for an entry that has no id.
- `--title <text>`: New title.
- `--page <n>`: New zero-based page.
- `--depth <0..8>`: New level.
- `--new-id <id>`: New id (the exercises filed under the old id follow).
- `--label <text>`: The number printed with the heading ("1.1", "Chapter 3"), at most 24 characters.
- `--top <0..1>`: Where the heading starts on its page, from the top (0 to 1), so that two sections on one page can be told apart.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline update 1.2 --top 0.12 --label 1.2
$ mcprep outline update 1.2 --new-id subtracting
$ mcprep outline update --index 7 --new-id appendix
```

With `--json`, `result` is: `The usual change report.`

## outline delete

Delete an outline entry.

```
mcprep outline delete [id] [options]
```

The entries below it move up one level, or are deleted with it with --subtree. A section that exercises are filed under cannot be deleted: move the exercises first (`exercises section`), or delete them.

Arguments:

- `id` (optional): The id of the entry (`mcprep outline` lists them).

Options:

- `--index <n>`: The position of the entry in the outline (from 0), for an entry that has no id.
- `--subtree`: Also delete everything below it.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline delete 1.2
$ mcprep outline delete c3 --subtree
$ mcprep outline delete --index 7
```

With `--json`, `result` is: `The usual change report.`

## outline ids

Give every outline entry that has no id one (from its printed label, else the number in its title), so that exercises can name it.

```
mcprep outline ids [options]
```

Exercises name their section by the id of an outline entry. `outline pdf --adopt`, `outline derive` and `outline set` without ids make entries that exercises cannot name yet; this gives each of them an id: the printed label ("1.2"), else the number at the start of the title ("2.3 Fractions"), else a short form of the title, else s<position>; made unique with a numeric suffix. Entries that already have an id keep it.

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline ids
```

With `--json`, `result` is: `The usual change report (the outline is in the project; `mcprep outline` shows the ids).`

## outline clear

Remove the project's own outline (the bundle then carries none and the app reads the PDF's).

```
mcprep outline clear [options]
```

Options:

- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline clear
```

With `--json`, `result` is: `The usual change report.`

## propose

Suggest exercises, parts, context and bookmarks from the printed text (offline heuristics, nothing is applied).

```
mcprep propose [options]
```

Finds lines that start an exercise ("Exercise 3", "Aufgabe 3", "3.", "3)"), where each ends (before the next start, a heading or a definition; over a figure; onto the next page when the text goes on), part markers (a) (b) (c) inside an exercise, instructions printed for several exercises ("Exercises 3 and 4"), and definitions, theorems and remarks as bookmarks. Every proposal carries its evidence and a confidence. It is a starting point: look at the crops before you trust it. `--ops` writes the proposals as a batch for `frames apply`; `--apply` applies them (only the ones you name with --ids, if given).

Options:

- `--pages <0,2,5-7>`: Only these zero-based pages (default all).
- `--min-confidence <0..1>`: Proposals below this go to "rejected" (default 0.5).
- `--no-bookmarks`: Do not propose definitions, theorems and remarks as bookmarks.
- `--no-graphics`: Do not render pages to find figures (faster; frames then end after the last line of text).
- `--parts context|keep|none`: What to do with the statement above (a): context (recommended: it becomes context of the exercise and the first part starts at (a)), keep (leave it inside the first part, as the app's own splitter does), none (do not cut into parts). Default context.
- `--ids <p1,p3>`: With --ops or --apply: only these proposals.
- `--ops <file>`: Write the operations that create these frames as a JSON batch (for `frames apply`).
- `--apply`: Apply the proposals to the project now (one atomic batch).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep propose
$ mcprep propose --pages 0-4 --ops batch.json
$ mcprep propose --apply --ids p1,p2,p3
```

With `--json`, `result` is: `{ pages, proposals: [{ id, kind, page, rect, continues?, title, number?, confidence, evidence, parts? }], contexts: [{ id, page, rect, text, numbers, appliesTo }], rejected, operations, bodyFontSize, notes, applied? }`

## exercises propose

Find the numbered exercises of the practice sets of a book, with the instruction that governs each (offline heuristics, nothing is applied).

```
mcprep exercises propose [options]
```

For every section with a practice set (found from the outline of the project, or derived now): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its own text, the continuation lines, the second line of a fraction, the figure that stands beside it, the lines on the next page), the bold instruction printed above a group of exercises as its context (two regions when it crosses a page break), and the evidence. Numbers that are missing, printed twice or put aside are reported, not hidden: what the book prints is what is proposed, and a difference from what you expected is a finding to look at. Look at the crops (`render --page`/`crop`) of a sample before you apply. `--ops` writes the operations (add with authority "book", label, section, context) for `frames apply`. `--apply` applies them as one atomic batch and can be repeated: an exercise is identified by its section and label, so one the project already has the same way is skipped, one that only lacks its answer gets the answer found now, and one that differs (a person may have corrected the frame) is kept and listed under "changed" unless you say `--replace`, which overwrites it in place (it keeps its id). `--solutions` also reads the answer key and puts the solution regions into the same operations.

Options:

- `--section <0.1,0.2>`: Only these sections (ids or labels); default all.
- `--solutions`: Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).
- `--max-items <n>`: At most this many exercises per section (the surplus is listed as excluded); default no limit.
- `--instructions bold|margin|auto|none`: How instructions are recognised: bold (set in bold, at the margin), margin (at the margin, above an item), auto (bold when the pages carry font information, else margin; the default), none.
- `--item-pattern <regex>`: How the number of an exercise (or of an answer) starts a line, as a regular expression: group 1 is the label as printed (without the closing mark), group 2 the text after it. Replaces the defaults, which read "5)", "5.", "(5)" and "5a)"; give the option more than once for several. Example: --item-pattern "^([A-Z]\.\d+)\s+(.*)$" for labels like "A.3".
- `--chapter-words <chapter,part,...>`: Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults (chapter, part, unit, kapitel, chapitre, capítulo, ...).
- `--practice-words <practice,exercises,...>`: Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, übungen, aufgaben, ...).
- `--answer-words <answers,solutions,...>`: Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults (answers, answer key, solutions, lösungen, ...).
- `--ops <file>`: Write the operations as a JSON batch (for `frames apply`).
- `--details <file>`: Write everything (every proposal with its evidence, the instructions, the rejected numbers) as JSON.
- `--apply`: Apply the proposals to the project now (one atomic batch). Exercises the project already has are skipped (see --replace).
- `--replace`: With --apply (or --ops): overwrite the exercises of the project that differ from the proposal, in place (they keep their ids); without it they are kept and listed.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises propose
$ mcprep exercises propose --section 0.1,0.2 --ops batch.json
$ mcprep exercises propose --solutions --apply
$ mcprep exercises propose --section 1.7 --replace --apply
```

With `--json`, `result` is: `{ source: "project"|"derived", sections: [{ section, label, title, count, first, last, pages, gaps, duplicates, rejected, excluded, instructions: [{ text, governs }], notes, lowConfidence: [{ label, confidence, evidence }] }], counts: { sections, exercises, withSolution, added, unchanged, solutionsAdded, changed, replaced }, changed: string[] (SECTION:LABEL of exercises of the project that differ from the proposal), notProposed: string[], refused: string[], proposals?: [...] (all, when there are at most 300; else proposalsOmitted: n and the details file), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), notes, applied }; with --apply the result also has the fields of every command that changes the project (created, replaced, counts, book, validation)`

## solutions propose

Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.

```
mcprep solutions propose [options]
```

The answer key is cut into bands by the section markers and headers (a band runs across all columns and over page breaks); inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; exercises without an answer and answers without an exercise are reported. `--ops` writes `solution.set` operations (one per exercise, named SECTION:LABEL) for `frames apply`; `--apply` applies them as one atomic batch. It can be repeated: an exercise that already has this solution is skipped, and one whose solution differs (a person may have corrected it) is kept and listed under "changed" unless you say `--replace`. The solution is hidden: it is never shown with the exercise, never sent to a tutor, used only to grade.

Options:

- `--ops <file>`: Write the operations as a JSON batch (for `frames apply`).
- `--details <file>`: Write everything (every answer with its evidence, the sequences, the headers) as JSON.
- `--apply`: Apply the solutions to the project now (one atomic batch).
- `--replace`: Overwrite the solution of an exercise that has a different one; without it that exercise is kept and listed.
- `--item-pattern <regex>`: How the number of an exercise (or of an answer) starts a line, as a regular expression: group 1 is the label as printed (without the closing mark), group 2 the text after it. Replaces the defaults, which read "5)", "5.", "(5)" and "5a)"; give the option more than once for several. Example: --item-pattern "^([A-Z]\.\d+)\s+(.*)$" for labels like "A.3".
- `--chapter-words <chapter,part,...>`: Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults (chapter, part, unit, kapitel, chapitre, capítulo, ...).
- `--practice-words <practice,exercises,...>`: Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, übungen, aufgaben, ...).
- `--answer-words <answers,solutions,...>`: Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults (answers, answer key, solutions, lösungen, ...).
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solutions propose
$ mcprep solutions propose --ops solutions.json
$ mcprep solutions propose --apply
$ mcprep solutions propose --replace --apply
```

With `--json`, `result` is: `{ sections: [{ section, label, title, answers, first, last, gaps, duplicates, withoutAnswer, withoutExercise, headers, notes }], counts: { exercises, answers, matched, withoutAnswer, withoutExercise, added, unchanged, changed }, changed: string[] (SECTION:LABEL of exercises whose solution differs from the proposal), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), notes, applied }; with --apply the result also has dryRun, created, replaced, removed, book and validation`

## exercises verify

Check the audited exercises against the text layer of the PDF, without looking: the same list for every agent.

```
mcprep exercises verify [options]
```

Reads the project on disk and the text layer of its PDF (no pixels, no network) and reports what a person would find by looking at the crops, in a fixed order (errors, warnings, infos; by code; by the order of the book): an exercise whose region does not start with its number (read at the left margin, so a numerator or a figure label above the number does not count), an answer region that holds another number, regions that lie on each other or are the same, a region that is too large, too narrow or too small, an unknown section or a page outside its section, numbers that are missing, repeated, out of order in their column or far above the rest of their section, and sections with few or no answers. It also asks whether any text is left in no region (a missed exercise or answer, the cut-off end of an exercise or of an answer), whether an exercise that goes on over a page break has all its regions in reading order and none of the text between them left out, whether the instruction of an exercise is the right one, whether the answers lie under the marker of their section, whether a section whose exercises stand inline between paragraphs has regions that end where their text ends, and, with --ink, whether an edge of a region runs through printed ink. Every finding has a code, a severity, the reference of the exercise (SECTION:LABEL), the page, a message and the evidence (the first 40 characters found, the numbers measured). The codes, their thresholds and what to do about each are in docs/AUDIT_A_BOOK.md. `--details FILE` writes the whole report (format math-canvas-verify, see `mcprep schema verify`); the JSON result carries the first 300 findings and says how many it left out. The exit code is 4 when there is a finding of the severity `--fail-on` names or a worse one (default: an error). Nothing is changed.

Options:

- `--section <id>`: Only the exercises filed under this section (an outline entry id); repeat the option, or separate the ids with commas. Ordinary exercises are then left out.
- `--details <file>`: Write the whole report as JSON (every finding, every section), in the format math-canvas-verify.
- `--ink`: Also render the pages (each page that has a region, once) and report every region whose top, bottom, left or right edge runs through printed ink (`edge-on-ink`, a warning, the worst first). Slower: it draws the pages.
- `--fail-on error|warning|none`: Exit with code 4 when there is a finding of this severity or a worse one: error (the default), warning, or none (always 0).
- `--item-pattern <regex>`: How the number of an exercise or an answer starts a line, for a book that does not print `5.`, `5)` or `(5)`: a regular expression with the label as printed in group 1 (the same option as `exercises propose`); repeatable. It adds to what is read by default. A pattern that applies to the answers too: "Lösung 1.1.2" is `^L(?:ö|oe)sung\s+(\d+(?:\.\d+)*)` (a letter outside ASCII may be written as an escape, \u00f6).
- `--item-pattern-file <file>`: The same patterns, one to a line in a UTF-8 file (for a shell that mangles letters such as o with a diaeresis); repeatable.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises verify
$ mcprep exercises verify --section 1.2 --section 1.3
$ mcprep exercises verify --details verify.json --fail-on warning
$ mcprep exercises verify --ink
$ mcprep exercises verify --item-pattern '^Lösung\s+(\d+(?:\.\d+)*)'
$ mcprep exercises verify --json
```

With `--json`, `result` is: `{ format: "math-canvas-verify", version: 1, summary: { exercises, authoritative, sections, solutions, errors, warnings, infos }, findings: [{ code, severity, ref, page, message, evidence }] (the first 300; findingsOmitted: n says how many more the --details file has), sections: [{ id, label, exercises, firstLabel, lastLabel, withSolution, gaps, duplicates }] }; the exit code is 4 when --fail-on is met`

## exercises sample

A fixed sample of exercises and answers to look at, chosen by rules (no randomness): the same for every agent.

```
mcprep exercises sample [options]
```

The sample has at most --exercises exercises (default 40) and --solutions answers (default 20): hard caps. The rules are applied in order, each adds its exercises that are not in the sample yet until the cap is reached, and a rule that does not fit what is left is thinned by an even stride (never cut off at the end; the notes say which). Exercises: (1) one exercise of each layout kind the book has, the first one in the order of the book: it continues on another region, its instruction is on another page, it stands in a row with one other exercise, in a row with two others, the longest region, the smallest region, a region much taller than the median of its section (beside a figure); (2) the first and the last exercise of every chapter (an outline entry of depth 0 that holds exercises, or the entries at the top of an outline without any); (3) the first and the last exercise of every section, or, when what is left of the cap is less than twice the number of sections, of an even stride of sections that keeps the first and the last; (4) an even stride over the rest of the exercises in the order of the book. Answers (of the exercises that have one): (1) those of the exercises of rule 1, then the answer with the most lines of text, an answer that is only a picture, the first answer of every chapter's key, then those of the other sampled exercises in the order they were picked, then an even stride over the rest. `--per-section` is the thorough review: rule 3 ignores the caps and takes the first and the last exercise of every section, and the answers of every sampled exercise are taken, so the sample may be larger than the caps. The order of the book is the order of the sections in the outline and, within one, reading order; the order of the frames in the file does not matter, and nothing is random. Every entry says why it is there (`reason`, and all `reasons`), its page and its region (`main` or `solution:0`, as `crop --region` takes it). `--crops DIR` also writes the PNG of every region, named by reference and kind (`1.2_5-exercise.png`, `1.2_5-solution.png`), as `crop` does; look at them, or call `crop` for each entry. `--out FILE` writes the sample as JSON (format math-canvas-sample, see `mcprep schema sample`). Nothing is changed.

Options:

- `--exercises <n>`: The most exercises the sample has (default 40); 0 leaves the exercises out. Only --per-section may go beyond it.
- `--solutions <n>`: The most answers the sample has (default 20); 0 leaves the answers out. Only --per-section may go beyond it.
- `--per-section`: The thorough review: take the first and the last exercise of EVERY section (and the answers of every sampled exercise), whatever the caps are; the sample may then be larger than --exercises and --solutions.
- `--out <file>`: Write the sample as JSON (format math-canvas-sample).
- `--crops <dir>`: Also write the PNG crop of every region of the sample into this folder, named by reference and kind (`1.2_5-exercise.png`, `1.2_5-solution.png`).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises sample
$ mcprep exercises sample --crops sample/ --out sample.json
$ mcprep exercises sample --exercises 60 --solutions 30 --json
$ mcprep exercises sample --per-section
```

With `--json`, `result` is: `{ format: "math-canvas-sample", version: 1, options: { exercises, solutions, perSection }, summary: { sections, exercises, withSolution, sampledExercises, sampledSolutions }, exercises: [{ ref, reason, reasons, page, kind, region }], solutions: [{ ref, reason, reasons, page, kind, region }], notes: string[] (layouts the book does not have, rules that were thinned), crops?: [{ ref, kind, region, path }] (with --crops) }`

## exercises sheets

Make contact sheets of every exercise (or of a section, or of the fixed sample) with its instruction, continuations and answer, to look at them all.

```
mcprep exercises sheets --out <folder> [options]
```

For the exhaustive visual pass that the gate asks for: the exercises in the order of the book (all of them, the ones of --section, or the fixed sample of `exercises sample`), `--per-sheet` (default 12) cells at most to a sheet, two cells wide, each cell of a fixed width (740 pixels), a sheet closed as soon as the next cell would make it taller than 2,600 pixels (so that the sheets stay readable, with the answers too; a cell taller than that has a sheet of its own, drawn smaller only above 6,000 pixels, and sheets.json says so) and captioned SECTION:LABEL and the zero-based pages of its regions ("p. 12, 13-14"). A cell shows, one region under the other: the instruction (blue frame), the exercise (red), its continuations (orange) and, with --solutions, its answer (green). Files: sheet-0001.png, sheet-0002.png, ... and sheets.json in --out, which lists the references and the pages of every sheet and a hash of what it shows; a repair that changes an exercise changes the hash of its sheet, which `audit gate --sheets-seen` finds. Nothing is uploaded; the result is the same for the same project. `--sheet N` draws only sheet N, `--from-sheet N` the sheets from N on (sheets.json is always the whole list): use them to look again after a repair. Look at every sheet, then list the numbers in a file for the gate (1-40, say).

Options:

- `-o, --out <folder>` (required): Where the sheets and sheets.json go.
- `--section <id>`: Only the exercises of this section (an outline entry id); repeat the option or separate the ids with commas.
- `--all`: Every exercise of the book (the default when neither --section nor --sample is given).
- `--sample`: Only the exercises of the fixed sample (`mcprep exercises sample`).
- `--per-sheet <n>`: Cells on a sheet, at most (default 12); a sheet taller than 2600 pixels is closed earlier.
- `--solutions`: Also draw the answer of each exercise (green).
- `--sheet <n>`: Draw only this sheet (1 is the first).
- `--from-sheet <n>`: Draw only the sheets from this one on.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises sheets --out sheets/
$ mcprep exercises sheets --out sheets/ --solutions --per-sheet 8
$ mcprep exercises sheets --out sheets/ --section 1.2
$ mcprep exercises sheets --out sheets/ --solutions --from-sheet 14
```

With `--json`, `result` is: `{ out, rendered: [sheet numbers drawn], manifest: { format: "math-canvas-sheets", version: 1, scope: "all"|"sample"|"section", sections?, perSheet, solutions, cellWidth, exercises, sheets: [{ number, file, refs, pages, hash }] } }`

## frames list

List the frames in reading order with their labels: positional (E1, E2.1, Q1, B1) or, for book exercises, the printed one.

```
mcprep frames list [options]
```

Two kinds of exercise: those you framed yourself have a positional label, computed from position, never stored (page by page, top before bottom, left before right; the parts of one exercise count once, at the position of its first part), and adding a frame earlier in the document renumbers the later ones; authoritative book exercises (authority "book") are listed by SECTION:LABEL, the number the book prints, which never changes, and are marked "book" in the notes. Use the id, or SECTION:LABEL, to refer to a frame.

Options:

- `--page <n>`: Only this zero-based page.
- `--kind exercise|question|bookmark`: Only this kind.
- `--authority book|user`: Only authoritative book exercises (book), or only what a person framed for themselves (user: ordinary exercises, questions and bookmarks).
- `--section <id>`: Only the book exercises filed under this section (an outline entry id).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames list
$ mcprep frames list --page 2 --json
$ mcprep frames list --authority book --section 1.2
```

With `--json`, `result` is: `{ frames: [{ id, label, kind, authority: "book"|"user", reference?, section?, page, rect, unit?, part?, partCount?, continues?, context?, solution? }], counts: { exercise, question, bookmark }, book: { exercises, withSolution } }; counts are the positional ones (book exercises are not in them)`

## frames add

Add a frame: an exercise, a question or a bookmark.

```
mcprep frames add --kind exercise|question|bookmark --page <n> --rect <l,t,r,b> [options]
```

A frame is a rectangle on a zero-based page, in fractions of the page as displayed (origin top-left). An exercise contains its number and statement and everything up to but not including the next exercise's number. A rect smaller than the minimum (0.02 wide, 0.01 tall) is enlarged around its centre; with --snap the edges also move off lines of text. Use `frames split` afterwards to cut an exercise into parts, `context add` to attach an instruction printed elsewhere.

Options:

- `--kind exercise|question|bookmark` (required): What the frame is for.
- `--page <n>` (required): Zero-based page of the main region.
- `--rect <l,t,r,b>` (required): Left, top, right, bottom as fractions of the page (0..1, origin top-left).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--id <id>`: Your own id ([A-Za-z0-9_-], up to 40 characters). Default: generated (f1, f2, ...).
- `--unit <unit>`: Make this frame a part of the exercise with this unit id (prefer `frames split`).
- `--context <page:l,t,r,b>`: A context region (instruction or background printed elsewhere); repeatable, up to 8. Exercises only.
- `--continues <page:l,t,r,b>`: A further region of the same task, e.g. on the next page; repeatable, up to 8. Not for parts.
- `--no-enlarge`: Refuse a rect below the minimum size instead of enlarging it.
- `--authority book`: Make it an authoritative exercise audited from a book (needs --label and --section; it cannot be a part). `mcprep exercises add` is the same without --kind.
- `--label <5a>`: With --authority book: the number exactly as the book prints it, without the closing "." or ")" (5, 12, 5a, A.3).
- `--section <id>`: With --authority book: the id of the outline entry (section) the exercise belongs to (`mcprep outline` lists them).
- `--solution <page:l,t,r,b>`: A region (of the same PDF) where the answer is printed, hidden from the learner and used only to grade; repeatable, up to 8. Exercises only.
- `--replace`: With --authority book: if the exercise (same section and label) already exists, overwrite it in place, keeping its id, instead of failing: page, rect and continuation are replaced; context and solution are replaced when you give them and kept otherwise.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames add --kind exercise --page 2 --rect 0.08,0.12,0.92,0.31 --snap
$ mcprep frames add --kind exercise --page 3 --rect 0.08,0.6,0.92,0.95 --continues 4:0.08,0.05,0.92,0.2
$ mcprep frames add --kind bookmark --page 5 --rect 0.1,0.4,0.9,0.52
$ mcprep frames add --kind exercise --authority book --label 5a --section 1.2 --page 17 --rect 0.09,0.41,0.91,0.48 --solution 211:0.1,0.52,0.5,0.54
```

With `--json`, `result` is: `The change report: { applied, dryRun, created, replaced, removed, frames: [...], counts, book, validation: { ok, errors, warnings, repairs } }`

## frames update

Change the page, rectangle or kind of a frame.

```
mcprep frames update <id> [options]
```

A part of an exercise cannot be moved on its own: use `frames area` (the whole exercise), `frames dividers` (the cuts between parts) or `frames move`.

Arguments:

- `id`: The frame id.

Options:

- `--kind exercise|question|bookmark`: New kind (context is dropped when it stops being an exercise).
- `--page <n>`: New zero-based page.
- `--rect <l,t,r,b>`: New rectangle (page fractions).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames update f3 --rect 0.08,0.12,0.92,0.34 --snap
$ mcprep frames update f3 --kind question
```

With `--json`, `result` is: `The change report.`

## frames delete

Delete a frame (or, with --unit, every part of an exercise).

```
mcprep frames delete <id> [options]
```

Deleting a part from the middle of an exercise leaves no gap: the part above takes over its area. An exercise left with one part is an ordinary exercise again. The context of a deleted first part stays with the exercise.

Arguments:

- `id`: The frame id (or the unit id with --unit).

Options:

- `--unit`: The argument is a unit id: delete all of its parts.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames delete f4
$ mcprep frames delete u3 --unit
```

With `--json`, `result` is: `The change report ("removed" lists the deleted ids).`

## frames move

Move a frame by a distance in page fractions (an exercise with parts moves as a whole).

```
mcprep frames move <id> [options]
```

Arguments:

- `id`: The frame id.

Options:

- `--dx <fraction>`: To the right (negative: to the left).
- `--dy <fraction>`: Down (negative: up).
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames move f2 --dy 0.02
$ mcprep frames move f2 --dx -0.01 --dy -0.03
```

With `--json`, `result` is: `The change report.`

## frames split

Cut an exercise into parts: (a), (b), (c) become parts 1.1, 1.2, 1.3 of one exercise.

```
mcprep frames split <id> --at <y1,y2,...> [options]
```

--at gives the y positions (page fractions) where the parts after the first start, each at its marker line (use `lines` or `propose` to find them; --snap moves a divider onto the nearest line). The parts always tile one area. By default the first part starts at the top of the frame, so the statement before (a) stays inside it (what the Android app's own splitter does). Recommended: give --first, the y where the first part starts (at its marker), and the text above becomes context of the exercise, which every check then receives. The original frame keeps its id as the first part.

Arguments:

- `id`: The exercise frame (or a part, to cut it again).

Options:

- `--at <y1,y2,...>` (required): Where the parts after the first start (page fractions, top to bottom).
- `--first <y>`: Where the first part starts (default: the top of the frame).
- `--preamble keep|context|drop`: What becomes of the text above --first: context (default when --first is given), or drop (leave it out). Without --first it stays in the first part (keep).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames split f1 --at 0.4,0.52 --snap
$ mcprep frames split f1 --first 0.32 --at 0.4,0.52 --preamble context --snap
```

With `--json`, `result` is: `The change report ("created" lists the new parts).`

## frames merge

Merge parts back into one frame.

```
mcprep frames merge [ids]... [options]
```

Give a unit id (--unit) to merge all its parts, or two or more neighbouring part ids to merge those.

Arguments:

- `ids...` (optional): Neighbouring part ids to merge.

Options:

- `--unit <unit>`: Merge all parts of this unit.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames merge --unit u3
$ mcprep frames merge f2 f5
```

With `--json`, `result` is: `The change report.`

## frames dividers

Set the cuts between the parts of an exercise (move, add or remove them).

```
mcprep frames dividers <id> --at <y1,y2,...> [options]
```

The area of the parts on the page stays; the cuts become exactly these. More cuts add parts (new ids), fewer remove the last ones. No cuts at all turns it back into one frame.

Arguments:

- `id`: Any part of the exercise.

Options:

- `--at <y1,y2,...>` (required): The new cuts (page fractions, top to bottom). Use "" for none.
- `--page <n>`: Which page of a unit that spans several (default: the page of the frame).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames dividers f3 --at 0.38,0.5 --snap
```

With `--json`, `result` is: `The change report.`

## frames area

Move or resize a whole exercise with parts (the cuts between the parts stay where they are).

```
mcprep frames area <id> --rect <l,t,r,b> [options]
```

Arguments:

- `id`: Any part of the exercise.

Options:

- `--rect <l,t,r,b>` (required): The new area: left and right apply to every part, top to the first part, bottom to the last.
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames area f3 --rect 0.08,0.3,0.92,0.7
```

With `--json`, `result` is: `The change report.`

## frames apply

Apply many operations at once, atomically, with one validation at the end.

```
mcprep frames apply <file> [options]
```

The file holds { "operations": [ ... ] } (or just the list). Each operation has an "op": add, update, delete, move, split, merge, dividers, area, context.add, context.remove, context.set, continues.add, continues.remove, authority.mark, authority.unmark, label.set, section.set, solution.add, solution.remove, solution.set, outline.set, outline.add, outline.update, outline.delete, outline.ids, outline.clear, meta.set, with the same fields as the matching commands. An "add" may carry "ref": "a" and later operations may say "id": "@a" for the frame it created (or replaced), so you need not guess generated ids; a book exercise can also be named "SECTION:LABEL" ("1.2:5a"). An "add" with "authority": "book", "label" and "section" makes an authoritative exercise; applying the same batch twice does not duplicate it (the second time is an error naming the exercise) unless the "add" says "replace": true. Any failure, or any new validation error, rejects the whole batch and nothing is written. This is how to mark a 60-page sheet in one call.

Arguments:

- `file`: A JSON file, or - for standard input.

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames apply batch.json
$ mcprep frames apply batch.json --dry-run
$ cat batch.json | mcprep frames apply -
```

With `--json`, `result` is: `The change report with "steps": [{ index, op, created, removed, notes }].`

## context add

Attach a region of context (the instruction, question or background printed elsewhere) to an exercise.

```
mcprep context add <id> --page <n> --rect <l,t,r,b> [options]
```

Context is shown first when the exercise is shown and goes to the AI tutor with every check. Use it for an instruction printed once above several tasks, or text on another page. For an exercise with parts it is kept on the first part and applies to all of them. Up to 8 regions per exercise; only exercises can have context.

Arguments:

- `id`: The exercise frame (any part of an exercise with parts).

Options:

- `--page <n>` (required): Zero-based page of the context.
- `--rect <l,t,r,b>` (required): The context region (page fractions).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep context add f3 --page 1 --rect 0.08,0.11,0.92,0.17 --snap
```

With `--json`, `result` is: `The change report.`

## context remove

Remove a context region of an exercise.

```
mcprep context remove <id> [options]
```

Arguments:

- `id`: The exercise frame.

Options:

- `--index <n>`: Which region (0 is the first); needed when there are several.
- `--all`: Remove all of them.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep context remove f3
$ mcprep context remove f3 --index 1
```

With `--json`, `result` is: `The change report.`

## continues add

Add a further region of the same task, for example where an exercise goes on in the next column or on the next page.

```
mcprep continues add <id> --page <n> --rect <l,t,r,b> [options]
```

Regions follow the main region in reading order; up to 8. An exercise with parts cannot continue: give each page its own parts (same unit) instead.

Arguments:

- `id`: The frame.

Options:

- `--page <n>` (required): Zero-based page of the continuation.
- `--rect <l,t,r,b>` (required): The continuation region (page fractions).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep continues add f4 --page 3 --rect 0.08,0.07,0.92,0.19 --snap
```

With `--json`, `result` is: `The change report.`

## continues remove

Remove a continuation region.

```
mcprep continues remove <id> [options]
```

Arguments:

- `id`: The frame.

Options:

- `--index <n>`: Which region (0 is the first); needed when there are several.
- `--all`: Remove all of them.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep continues remove f4
```

With `--json`, `result` is: `The change report.`

## exercises list

List the authoritative book exercises: label, section, page, and whether a solution is attached.

```
mcprep exercises list [options]
```

Authoritative exercises are named by the number the book prints (the label) inside the section of the book they belong to. They are listed by section (in the order of the outline) and, within a section, in reading order. Use --without-solution to see which ones still have no answer attached, and --section to look at one section.

Options:

- `--section <id>`: Only the exercises filed under this section (an outline entry id).
- `--subtree`: With --section: also the exercises of the sections below it.
- `--page <n>`: Only exercises that start on this zero-based page.
- `--with-solution`: Only exercises that have a solution region.
- `--without-solution`: Only exercises that have no solution region.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises list
$ mcprep exercises list --section 1.2 --json
$ mcprep exercises list --without-solution
```

With `--json`, `result` is: `{ exercises: [{ id, label, section, reference, page, rect, context, continues, solution }], count, totals: { exercises, withSolution } }; totals are for the whole project, count for the list`

## exercises add

Add an authoritative exercise: one printed exercise, with its printed label, in its section.

```
mcprep exercises add --section <id> --label <5a> --page <n> --rect <l,t,r,b> [options]
```

The same as `frames add --kind exercise --authority book`. An authoritative exercise is a single exercise: it has no parts. The parts of a printed exercise (5a, 5b) are two exercises with two labels, and the statement printed once above them is attached to each as --context. The exercise is identified by its section and label: adding one that exists is an error (so applying the same commands twice does no harm) unless you say --replace, which overwrites it in place and keeps its id. An exercise contains its number and statement and everything up to but not including the next exercise's number.

Options:

- `--section <id>` (required): The id of the outline entry (the section) the exercise belongs to; `mcprep outline` lists them.
- `--label <5a>` (required): The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters).
- `--page <n>` (required): Zero-based page of the main region.
- `--rect <l,t,r,b>` (required): Left, top, right, bottom as fractions of the page (0..1, origin top-left).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--id <id>`: Your own frame id ([A-Za-z0-9_-], up to 40 characters). Default: generated (f1, f2, ...).
- `--context <page:l,t,r,b>`: The instruction or statement the learner sees and the AI receives with every check (printed once above 5a and 5b, say); repeatable, up to 8.
- `--continues <page:l,t,r,b>`: A further region of the same exercise, e.g. on the next page; repeatable, up to 8.
- `--solution <page:l,t,r,b>`: Where the answer is printed in this PDF (the answer key at the back, say): hidden from the learner, used only to grade; repeatable, up to 8.
- `--no-enlarge`: Refuse a rect below the minimum size instead of enlarging it.
- `--replace`: If the exercise (same section and label) already exists, overwrite it in place instead of failing, keeping its id: page, rect and continuation are replaced (none given: none left); context and solution are replaced when you give them and kept otherwise (clear them with `context remove` and `solution clear`).
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises add --section 1.2 --label 5a --page 17 --rect 0.09,0.41,0.91,0.48 --snap --context 17:0.09,0.36,0.91,0.41
$ mcprep exercises add --section 1.2 --label 12 --page 18 --rect 0.09,0.1,0.91,0.2 --solution 211:0.1,0.52,0.5,0.54
```

With `--json`, `result` is: `The change report: { applied, dryRun, created, replaced, removed, frames: [{ id, label, reference, section, ... }], counts, book, validation }`

## exercises mark

Make an exercise you framed an authoritative book exercise: give it the printed label and its section.

```
mcprep exercises mark <frame> --label <5a> --section <id> [options]
```

The exercise keeps its place and its context and solution, loses its positional number (E3) and from now on is named by label and section. It cannot be part of a unit: merge the parts first (`frames merge --unit`).

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).

Options:

- `--label <5a>` (required): The number exactly as the book prints it (5, 5a, A.3).
- `--section <id>` (required): The id of the outline entry the exercise belongs to.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises mark f7 --label 5a --section 1.2
```

With `--json`, `result` is: `The change report.`

## exercises unmark

Turn an authoritative exercise back into an ordinary one (positional number, can be cut into parts).

```
mcprep exercises unmark <frame> [options]
```

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises unmark 1.2:5a
```

With `--json`, `result` is: `The change report.`

## exercises label

Change the label (the printed number) of an authoritative exercise.

```
mcprep exercises label <frame> <label> [options]
```

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).
- `label`: The number exactly as the book prints it, without the closing "." or ")".

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises label f12 5b
```

With `--json`, `result` is: `The change report.`

## exercises section

Move an authoritative exercise to another section.

```
mcprep exercises section <frame> <section> [options]
```

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).
- `section`: The id of the outline entry (`mcprep outline` lists them).

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises section f12 1.3
```

With `--json`, `result` is: `The change report.`

## solution add

Attach a region where the answer is printed (usually the answer key at the back) to an exercise; hidden from the learner.

```
mcprep solution add <frame> --page <n> --rect <l,t,r,b> [options]
```

Solution regions are of the same PDF as the exercise. They are used only to grade: the learner never sees them with the exercise and they are never sent to a tutor chat. Typically one small region per exercise in the answer key (the line "22) 0"), or one block that answers several exercises (give the same region to each). Up to 8 regions per exercise. Look at the crop afterwards: `mcprep crop <exercise> --region solution:0`.

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).

Options:

- `--page <n>` (required): Zero-based page of the solution.
- `--rect <l,t,r,b>` (required): The solution region (page fractions).
- `--snap`: Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solution add 1.2:5a --page 211 --rect 0.1,0.52,0.5,0.54 --snap
$ mcprep solution add f12 --page 211 --rect 0.1,0.52,0.5,0.54
```

With `--json`, `result` is: `The change report; the frame carries "solution": n.`

## solution list

List the solution regions of an exercise, or of every exercise that has some.

```
mcprep solution list [frame] [options]
```

Arguments:

- `frame` (optional): The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a). Without it: every exercise that has solution regions.

Options:

- `--missing`: Instead list the authoritative exercises that have no solution region yet.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solution list
$ mcprep solution list 1.2:5a
$ mcprep solution list --missing
```

With `--json`, `result` is: `{ solutions: [{ frame, label, reference?, authority, regions: [{ index, page, rect }] }], count, missing?: [{ frame, label, reference }] }`

## solution remove

Remove one solution region of an exercise (by index), or all of them.

```
mcprep solution remove <frame> [options]
```

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).

Options:

- `--index <n>`: Which region (0 is the first); needed when there are several. `solution list` shows the indexes.
- `--all`: Remove all of them.
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solution remove 1.2:5a --index 1
$ mcprep solution remove f12
```

With `--json`, `result` is: `The change report.`

## solution clear

Remove every solution region of an exercise.

```
mcprep solution clear <frame> [options]
```

Arguments:

- `frame`: The exercise: its frame id (f12), or SECTION:LABEL (1.2:5a).

Options:

- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solution clear 1.2:5a
```

With `--json`, `result` is: `The change report.`

## book show

Show the book: its information, its sections with the number of authoritative exercises in each, and the totals.

```
mcprep book show [options]
```

The sections are the entries of the outline. For each: its id (what exercises name), the printed label, the page, how many book exercises are filed under it (own), under it and everything below it (total), how many of them have a solution, and the first and last label. With --json the result is the machine summary documented in docs/PROJECT_FILE.md (and `mcprep schema book-summary`); `mcprep book export` writes the same JSON to a file.

Options:

- `--used`: Only the sections that hold exercises, and the entries above them.
- `--exercises`: In the JSON, also list each section's own exercises (id, label, page, number of solution regions).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep book show
$ mcprep book show --used
$ mcprep book show --json
```

With `--json`, `result` is: `The summary: { format: "math-canvas-book-summary", version: 1, generator, document: { title, folder?, pageCount, sha256?, bytes?, author?, series?, description?, license?, sourceUrl?, notice? }, sections: [{ index, id?, label?, title, page, top?, depth, parent, exercises, exercisesTotal, withSolution, withSolutionTotal, firstLabel?, lastLabel?, items? }], totals: { sections, sectionsWithId, exercises, withSolution, withoutSolution, unfiled, ordinary: { exercises, questions, bookmarks } } }`

## book meta

Show or change what the bundle says about the book: title, library folder, author, series, description, licence, source address and notice.

```
mcprep book meta [options]
```

The licence travels with the file: a licence that asks for attribution needs its notice shown wherever the book is shown, so give --notice the text the licence asks for (who wrote it, under which licence, what was changed). An empty text ("") removes a field. A text that starts with @ is read from that file (--notice @notice.txt); write @@ for a text that really starts with @. Without options the current values are shown.

Options:

- `--title <text>`: The title the library shows (1 to 200 characters).
- `--folder <A/B>`: Library folder, names separated by "/", at most seven levels.
- `--author <text>`: Who wrote the work (up to 200 characters).
- `--series <text>`: The series it belongs to (up to 200 characters).
- `--description <text>`: What the book is about, in a few sentences (up to 4000 characters).
- `--license-name <text>`: The licence, for example "CC BY 3.0" (up to 100 characters).
- `--license-url <url>`: Where the licence is (http or https).
- `--no-license`: Remove the licence.
- `--source-url <url>`: Where the work comes from (http or https, up to 500 characters).
- `--notice <text>`: The text the licence asks to be shown with the work (up to 4000 characters).
- `--dry-run`: Compute and validate the change, but do not write the project.
- `--force`: Write the change even if it introduces validation errors.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep book meta --title "Pre-Algebra" --author "A. Author" --license-name "CC BY 3.0" --license-url https://creativecommons.org/licenses/by/3.0/ --source-url https://example.org/the-book
$ mcprep book meta --notice @notice.txt
$ mcprep book meta
```

With `--json`, `result` is: `{ title, folder?, author?, series?, description?, license?: { name, url? }, sourceUrl?, notice? }, and with a change the usual change report`

## book export

Write the book summary (sections with exercise counts, totals, document information) as a plain JSON file.

```
mcprep book export [options]
```

The same JSON as `book show --json`, written atomically to a file: a documented, camelCase list of the sections with their exercise and solution counts, pages zero-based. It is made from the project, so it can be written before the bundle is exported; the bundle itself carries the same facts in its manifest, frames and outline.

Options:

- `-o, --out <file.json>`: Where to write it (default: <pdf name>.book.json next to the project).
- `--exercises`: Also list each section's own exercises (id, label, page, number of solution regions).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep book export --out build/pre-algebra.book.json
$ mcprep book export --exercises
```

With `--json`, `result` is: `{ path, bytes, summary: the summary of `book show` }`

## book compare

Compare the audited sections and their exercise counts with a reference list of the book; exit code 4 when anything differs.

```
mcprep book compare <reference> [options]
```

Reads a reference (JSON: the owner's own count of the exercises of each section, in one of two forms: { "chapters": [{ "number", "title", "sections": [{ "number", "title", "exercise_count" }] }] }, where section 2 of chapter 3 is "3.2" (--chapter-offset N adds N to the chapter numbers), or { "sections": [{ "label", "title", "exercise_count" }] }) and compares it with the project, section by section, matching sections by the label the book prints: per section the reference count against the audited count, the first and last label, the pages of the first and the last exercise, the difference and whether the titles differ after normalising; the sections on one side only; the totals and a table per chapter. Everything that differs is listed under `differences`; the exit code is 4 when there is any (a count, a section on one side only, a title), so that the one who audits must look at the pages and decide: what the book prints (a practice set with more exercises than the contents list) is acknowledged with `mcprep audit ack`, anything else is a defect to repair. No network, nothing is changed. `--details FILE` writes the whole report (format math-canvas-compare).

Arguments:

- `reference`: The reference JSON file.

Options:

- `--chapter-offset <n>`: Added to the chapter numbers of a reference with chapters (when the reference counts the first chapter as 1 and the book prints 0, use -1).
- `--details <file>`: Write the whole report as JSON (format math-canvas-compare).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep book compare reference.json
$ mcprep book compare reference.json --chapter-offset -1 --details compare.json
$ mcprep book compare reference.json --json
```

With `--json`, `result` is: `{ format: "math-canvas-compare", version: 1, reference: { sections, exercises }, audited: { sections, exercises }, totals: { referenceExercises, exercises, difference }, sections: [{ label, id, title, referenceTitle, count, referenceCount, difference, firstLabel, lastLabel, firstPage, lastPage, titleDiffers, status: "equal"|"count"|"missing"|"extra" }], chapters: [{ label, title, sections, referenceExercises, exercises, equal }], differences: [{ kind: "count"|"missing"|"extra"|"title", label, message }] }; the exit code is 4 when there is a difference`

## audit gate

The end of an audit: run every check without looking, say what is open, exit 0 only when nothing is; writes the certificate.

```
mcprep audit gate [options]
```

Runs `validate` (0 errors), `exercises verify` with every check of whole pages, instructions, spans and the answer key (every error and warning is repaired or acknowledged; `--ink` adds the pixel check of the edges), the comparison with a reference list of the book when `--reference` is given (every difference acknowledged), `import-check` of the bundle exported last when there is one (it must import and have the frames of the project), and, with `--sheets-seen FILE`, that every contact sheet of `exercises sheets --all` shows the exercises as they are now and is listed as looked at (FILE is JSON {"seen": [1, 2, 3]} or text such as 1-12, 14). It reports `open` (neither repaired nor acknowledged) and `acknowledged` (with the reason) and exits with code 4 unless `open` is empty. The certificate is written next to the project as <name>.audit-gate.json: the SHA-256 of the frames and of the outline, the counts, the acknowledgements and `passed`; any later change to the frames or the outline makes it stale (`--status` says whether it is current, `export` says so too). Acknowledgements are read from <name>.audit-notes.json and added with `mcprep audit ack`: ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours (a region that cuts a line, an exercise that was missed, an answer on the wrong exercise): repair those. A blanket "everything" is refused, a note for a section must say how many findings it covers, and a note whose findings changed no longer applies.

Options:

- `--reference <file>`: Also compare with this reference list of the book (see `mcprep book compare`): every difference must be repaired or acknowledged.
- `--chapter-offset <n>`: Added to the chapter numbers of a reference with chapters (as for `book compare`).
- `--ink`: Also render the pages and check the edges of the regions (`edge-on-ink`; slower).
- `--item-pattern <regex>`: How the number of an exercise or an answer starts a line, as for `exercises verify` (group 1 is the label); repeatable. The patterns of the notes file (itemPatterns) apply as well. The certificate lists them with every letter outside ASCII written as an escape.
- `--item-pattern-file <file>`: The same patterns, one to a line in a UTF-8 file (for a shell that mangles letters such as o with a diaeresis).
- `--sheets-seen <file>`: The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of `exercises sheets --all`.
- `--status`: Only say whether the certificate on disk is for the project as it is now and whether it passed (exit code 0 only when it is current and passed); run no check.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep audit gate
$ mcprep audit gate --reference reference.json --chapter-offset -1 --ink --sheets-seen sheets/seen.txt
$ mcprep audit gate --status
```

With `--json`, `result` is: `{ format: "math-canvas-audit-gate", version: 1, createdAt, passed, project: { name, frames, outline, hash }, counts: { sections, exercises, solutions, errors, warnings, infos, open, acknowledged }, checks: { validate, verify, reference, bundle, sheets }, itemPatterns, open: [{ source, code, severity, ref, page, message, evidence, acknowledgeable }] (the first 300; openOmitted says how many more), acknowledged: [{ finding, acknowledgement }], staleAcknowledgements, unusedAcknowledgements, certificate: path }; with --status { status: "none"|"stale"|"failed"|"passed", ... }; the exit code is 4 unless the gate passed`

## audit ack

Acknowledge a finding as what the BOOK prints, with the reason; never for a defect of ours.

```
mcprep audit ack --code <code> --ref <SECTION:LABEL|SECTION> --reason <sentence> [options]
```

Appends one acknowledgement to <name>.audit-notes.json after checking that the finding exists now: --code is the code of the finding (as `exercises verify` or `audit gate` name it: `duplicate`, `no-solution`, `gap`, `reference-count`, ...), --ref the exercise (SECTION:LABEL) or the section, --page the page of the finding and --quote a piece of the line (at most 60 characters; the first characters of the evidence are used when it is left out for an exercise). A note for a whole section (a ref without a label) must say how many findings it covers with --count, or quote the line: if the findings change, it no longer applies. --reason says what the book prints and where (a sentence). Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer on the wrong exercise are defects of ours: repair them. A blanket acknowledgement (no code, no exercise, a wildcard) is refused. Give the same --reference, --ink and --item-pattern as for the gate when the finding comes from them.

Options:

- `--code <code>` (required): The code of the finding.
- `--ref <SECTION:LABEL|SECTION>` (required): The exercise or the section the finding is about, as the finding names it.
- `--reason <sentence>` (required): Why it is not a defect: what the book prints and where (at least 10 characters).
- `--page <n>`: The zero-based page of the finding (narrows the note to it).
- `--quote <text>`: A piece of the evidence or of the message of the finding, at most 60 characters (narrows the note to it).
- `--count <n>`: How many findings the note covers; required for a section; the note applies only while exactly that many match.
- `--by <name>`: Who looked (default "agent").
- `--reference <file>`: Also compare with this reference list of the book (see `mcprep book compare`): every difference must be repaired or acknowledged.
- `--chapter-offset <n>`: Added to the chapter numbers of a reference with chapters (as for `book compare`).
- `--ink`: Also render the pages and check the edges of the regions (`edge-on-ink`; slower).
- `--item-pattern <regex>`: How the number of an exercise or an answer starts a line, as for `exercises verify` (group 1 is the label); repeatable. The patterns of the notes file (itemPatterns) apply as well. The certificate lists them with every letter outside ASCII written as an escape.
- `--item-pattern-file <file>`: The same patterns, one to a line in a UTF-8 file (for a shell that mangles letters such as o with a diaeresis).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --reason "The book prints the number 7 twice on page 120 (the second is a typo in the book)"
$ mcprep audit ack --code reference-count --ref 4.1 --count 1 --reason "The practice set of 4.1 prints 42 exercises; the reference lists 40"
```

With `--json`, `result` is: `{ path, acknowledgement: { code, ref, reason, evidence, by, count? }, covers: number of findings it covers now, replaced: boolean }`

## meta

Show or change the title and library folder of the project (author, licence and notice: `book meta`).

```
mcprep meta [options]
```

Options:

- `--title <text>`: The title the app library shows (1 to 200 characters).
- `--folder <A/B>`: Library folder, names separated by "/", at most seven levels. An empty text ("") removes it.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep meta --title "Analysis 1" --folder "University/Analysis/Sheets"
$ mcprep meta
```

With `--json`, `result` is: `{ title, folder? } (with the usual change report when something was changed)`

## relink

Point the project at the PDF where it now is.

```
mcprep relink <pdf> [options]
```

Use it when the PDF was moved or renamed. The new file must be the same PDF (same SHA-256); a different file is refused unless --accept-changed, because frames are positions on the pages of one exact file.

Arguments:

- `pdf`: The PDF at its new place.

Options:

- `--accept-changed`: Accept a PDF with a different hash (and update the page count). Check `validate` afterwards.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep relink "D:/books/analysis.pdf"
```

With `--json`, `result` is: `{ project, pdf: { path, sha256, bytes, pageCount }, changed: boolean }`

## validate

Check the project against every rule of the bundle format; errors name the frame and the fix.

```
mcprep validate [options]
```

Errors are what the importer would reject (exit code 4). Repairs are what it fixes silently (a value a hair outside the page, parts that miss tiling by under 0.002); the writer fixes them too. Warnings are allowed but suspicious: overlapping frames, a frame inside another, a frame thinner than a line, an edge that cuts through a line of text, a running header or footer inside a frame, a unit with one frame. For a book audited as an authority the rules are also: a label and a section with every authoritative exercise, the pair (section, label) unique, every section the id of an outline entry, solution regions only on exercises (at most 8, on pages of the document), valid outline ids, labels and tops; warnings for a label written with the "." or ")" the book prints, an exercise printed in another section than the one it is filed under, and a solution region that lies on the exercise or on another exercise.

Options:

- `--no-text`: Skip the checks that read the printed lines of the PDF (faster).
- `--strict`: Also fail (exit code 4) when there are warnings.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep validate
$ mcprep validate --strict --json
```

With `--json`, `result` is: `{ ok, errors: Issue[], warnings: Issue[], repairs: Issue[], counts: { exercise, question, bookmark }, book: { exercises, withSolution }, numbers: [{ id, label, kind, number, part?, partCount? }] }; an Issue is { severity, code, message, frameId?, unit?, page?, fix?, data? }; counts and numbers are the positional ones (authoritative book exercises are in book, named by their label)`

## export

Write the project as a .mcbundle: the PDF plus its frames and outline, ready for the Android app's library.

```
mcprep export [options]
```

Validates the project (errors stop the export), writes the bundle atomically (a temporary file, then a rename), and reads it back with the importer's own checks; a bundle that fails them is removed. The PDF inside is byte for byte the original. The output is deterministic: the same project and --created-at give the same bytes (also with SOURCE_DATE_EPOCH set).

Options:

- `-o, --out <file.mcbundle>`: Where to write the bundle (default: <pdf name>.mcbundle next to the project).
- `--title <text>`: Library title for this export (default: the project's).
- `--folder <A/B>`: Library folder for this export (default: the project's).
- `--outline project|pdf|none`: Which contents to put in the bundle: the project's own outline (default; none if it has none), the PDF's own bookmarks, or none.
- `--created-at <ISO time>`: The creation time written into the manifest (default: now, or SOURCE_DATE_EPOCH).
- `--no-verify`: Do not read the bundle back with the importer checks.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep export
$ mcprep export --out out/analysis1.mcbundle --folder "University/Analysis"
```

With `--json`, `result` is: `{ path, bytes, sha256, manifest (with features and the document info when there are any), counts: { frames, outlineEntries }, book: { exercises, withSolution }, issues: Issue[] (repairs and warnings), validation: { errors, warnings, repairs }, importCheck?: { ok, steps }, gate?: { status: "none"|"stale"|"failed"|"passed", ... } (for a book: whether the certificate of `audit gate` is for these frames and passed) }`

## inspect-bundle

Look inside a .mcbundle: manifest, entries, frames with their labels, outline, problems.

```
mcprep inspect-bundle <file> [options]
```

Arguments:

- `file`: The .mcbundle file.

Options:

- `--no-open-pdf`: Do not open the PDF to count its pages.
- `--json`: Print one JSON document.
- `-h, --help`: Show help.

Examples:

```console
$ mcprep inspect-bundle analysis1.mcbundle
```

With `--json`, `result` is: `{ ok, rejection?, errors, repairs, warnings, steps, archive: { bytes, entries }, manifest?, document? (with author, licence, ... when the manifest has them), features?, frames?, numbers? (positional numbers only: authoritative exercises have none), outline?, summary? } - the same report as import-check, with everything that was read; summary is the book summary of `book show` (sections with exercise counts)`

## import-check

Do exactly what the Android importer does with a bundle, step by step, and say whether it would accept it.

```
mcprep import-check <file> [options]
```

The six steps of docs/BUNDLE_FORMAT.md section 5: open the archive and apply the limits; read bundle.json and check format, version, the document block and the entry names it gives; stream document.pdf and compare its SHA-256 and size; open the PDF and compare its page count; parse and validate frames.json and outline.json, repairing what may be repaired and naming the frame id of anything that is rejected; and what would be created in the library. Exit code 4 when the bundle would be rejected.

Arguments:

- `file`: The .mcbundle file.

Options:

- `--no-open-pdf`: Do not open the PDF to count its pages (step 4 is then skipped).
- `--json`: Print one JSON document.
- `-h, --help`: Show help.

Examples:

```console
$ mcprep import-check analysis1.mcbundle
$ mcprep import-check analysis1.mcbundle --json
```

With `--json`, `result` is: `{ wouldImport: boolean, rejection?: Issue, steps: [{ step, name, status, detail }], errors, repairs, warnings, document?, features?, frames?, numbers?, outline? }`

## schema

Print a JSON Schema: bundle-manifest, frames, outline, project, book-summary, verify, sample, gate, notes, compare, sheets.

```
mcprep schema [name] [options]
```

Arguments:

- `name` (optional): One of bundle-manifest, frames, outline, project, book-summary, verify, sample, gate, notes, compare, sheets. Without a name the available schemas are listed.

Options:

- `--json`: Wrap the output in the usual JSON document.
- `-h, --help`: Show help.

Examples:

```console
$ mcprep schema frames
$ mcprep schema
```

With `--json`, `result` is: `{ name, schema } or { schemas: string[] }`

## guide

Print the guide for AI agents that mark a PDF with this tool.

```
mcprep guide [options]
```

The same text as docs/AGENT_GUIDE.md: the coordinate system, the workflow, the rules for deciding what to mark, and a checklist.

Options:

- `--json`: Wrap the text in the usual JSON document.
- `-h, --help`: Show help.

Examples:

```console
$ mcprep guide
```

With `--json`, `result` is: `{ markdown }`
