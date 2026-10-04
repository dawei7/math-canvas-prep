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
  (`f3`), which does not change when other frames are added.
- **The project** is `--project <file>` (or a folder holding exactly one), else `$MCPREP_PROJECT`, else the only
  `*.mcprep.json` in the current folder.
- **Changes are atomic.** A command that writes the project reads it fresh under a lock, applies the change in memory,
  validates once and writes only if the change did not introduce validation errors (`--force` overrides, `--dry-run` previews).
- **Images** (`render`, `crop`) are written as PNG files, by default into `.mcprep-cache/` next to the project; the JSON
  result names the path. Open them with an image viewer: that is how a model checks its work.

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
| 4 | the request was understood but the data is not acceptable: validation errors (validate, export), a change that would introduce errors, a page or frame that does not exist, a rectangle that is not a valid region, a bundle the importer would reject (import-check) |

## Commands

- [`init`](#init): Create a project for a PDF.
- [`info`](#info): Show the project, the PDF (pages, sizes, text layer, outline) and the frames.
- [`lines`](#lines): List the text lines of a page with their coordinates.
- [`render`](#render): Render a page to a PNG, optionally with a coordinate grid and the frames drawn on it.
- [`crop`](#crop): Render one frame, or any rectangle of a page, to a PNG: the way to check a frame by looking at it.
- [`outline`](#outline): Show the contents the bundle will carry: the project's own outline, or the PDF's.
- [`outline pdf`](#outline-pdf): Read the PDF's own outline (its bookmarks).
- [`outline derive`](#outline-derive): Find headings by font size, bold, position and numbering, for a PDF without an outline.
- [`outline set`](#outline-set): Replace the project's outline with entries from a JSON file (or - for standard input).
- [`outline clear`](#outline-clear): Remove the project's own outline (the bundle then carries none and the app reads the PDF's).
- [`propose`](#propose): Suggest exercises, parts, context and bookmarks from the printed text (offline heuristics, nothing is applied).
- [`exercises propose`](#exercises-propose): Find the numbered exercises of the practice sets of a book, with the instruction that governs each (offline heuristics, nothing is applied).
- [`solutions propose`](#solutions-propose): Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.
- [`frames list`](#frames-list): List the frames in reading order with their positional labels (E1, E2.1, Q1, B1).
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
- [`meta`](#meta): Show or change the title and library folder of the project.
- [`relink`](#relink): Point the project at the PDF where it now is.
- [`validate`](#validate): Check the project against every rule of the bundle format; errors name the frame and the fix.
- [`export`](#export): Write the project as a .mcbundle: the PDF plus its frames and outline, ready for the Android app's library.
- [`inspect-bundle`](#inspect-bundle): Look inside a .mcbundle: manifest, entries, frames with their labels, outline, problems.
- [`import-check`](#import-check): Do exactly what the Android importer does with a bundle, step by step, and say whether it would accept it.
- [`schema`](#schema): Print a JSON Schema: bundle-manifest, frames, outline or project.
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

With `--json`, `result` is: `{ project: { path, title, folder?, revision, modifiedBy?, updatedAt }, pdf: { path, pageCount, bytes, sha256, pageSizes: [{ width, height, rotation, pages }], textLayer: { checked, withText, withoutText: number[] } }, outline: { pdf: number|null, project: number|null, source? }, frames: { exercises, questions, bookmarks, total, partsOfUnits, byPage } }`

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
- `--pdf <file>`: Work on this PDF directly, without a project (no frames, no numbering).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep render 3 --grid 0.1
$ mcprep render 3 --frames --grid 0.05 --out check/page3.png
```

With `--json`, `result` is: `{ page, path, width, height, scale, view: { left, top, right, bottom }, grid?, frames: number }`

## crop

Render one frame, or any rectangle of a page, to a PNG: the way to check a frame by looking at it.

```
mcprep crop [frame] [options]
```

Give a frame id, or --page and --rect. With a grid the labels are still page coordinates, so a crop can be read in page fractions. --all writes a crop of every frame (and its continuation and context regions) in one go.

Arguments:

- `frame` (optional): A frame id (omit it when you give --page and --rect, or --all).

Options:

- `--page <n>`: Zero-based page (with --rect).
- `--rect <l,t,r,b>`: The rectangle to crop, as page fractions.
- `--region main|continues:N|context:N`: Which region of the frame (default main).
- `--all`: Crop every frame of the project.
- `--padding <fraction>`: Page fraction to include around the rectangle (default 0.01).
- `--grid <step>`: Draw a labelled grid with a line every <step> of the page (0.1 or 0.05). The labels are page coordinates: read positions straight off the image.
- `--frames`: Draw the project's frames (with their labels E1, E2.1, Q1, B1), continuations and context.
- `--max-side <px>`: Longer side of the image in pixels (default 1600 for a page, 1400 for a crop).
- `--scale <px/pt>`: Pixels per point instead of --max-side.
- `-o, --out <file|folder>`: Where to write the PNG (default: .mcprep-cache next to the project).
- `--pdf <file>`: Work on this PDF directly, without a project (no frames, no numbering).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep crop f3
$ mcprep crop f3 --region context:0 --grid 0.05
$ mcprep crop --page 2 --rect 0.1,0.3,0.9,0.5 --grid 0.05
$ mcprep crop --all --out check/
```

With `--json`, `result` is: `{ crops: [{ frame?, region, page, rect, path, width, height, scale, view }] }`

## outline

Show the contents the bundle will carry: the project's own outline, or the PDF's.

```
mcprep outline [options]
```

The app shows the bundle's outline.json as the document's contents instead of reading titles from the PDF. When the project has no outline of its own the bundle carries none and the app reads the PDF's. Sub-commands: `outline pdf` (the PDF's own), `outline derive` (headings found by heuristics), `outline set` (write your own), `outline clear`.

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

With `--json`, `result` is: `{ source: "project"|"pdf"|"none", entries: [{ title, page, depth }], projectSource?: "pdf"|"derived"|"manual" }`

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

The JSON is a list of { "title", "page", "depth" } (pages zero-based, depth 0 to 8, a child one deeper than its parent) or an object with an "entries" list.

Arguments:

- `file`: A JSON file, or - for standard input.

Options:

- `--source manual|derived|pdf`: What to record as the origin (default manual).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep outline set outline.json
$ echo '[{"title":"1 Sets","page":0,"depth":0}]' | mcprep outline set -
```

With `--json`, `result` is: `The usual change report (frames, validation); the outline is in the project.`

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

For every section with a practice set (found from the outline of the project, or derived now): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its own text, the continuation lines, the second line of a fraction, the figure that stands beside it, the lines on the next page), the bold instruction printed above a group of exercises as its context (two regions when it crosses a page break), and the evidence. Numbers that are missing, printed twice or put aside are reported, not hidden: what the book prints is what is proposed, and a difference from what you expected is a finding to look at. Look at the crops (`render --page`/`crop`) of a sample before you apply. `--ops` writes the operations (add with authority "book", label, section, context) for `frames apply`; `--apply` applies them (exercises already in the project, found by their deterministic id, are skipped, so applying twice does not duplicate); `--solutions` also reads the answer key and puts the solution regions into the same operations.

Options:

- `--section <0.1,0.2>`: Only these sections (ids or labels); default all.
- `--solutions`: Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).
- `--max-items <n>`: At most this many exercises per section (the surplus is listed as excluded); default no limit.
- `--ops <file>`: Write the operations as a JSON batch (for `frames apply`).
- `--details <file>`: Write everything (every proposal with its evidence, the instructions, the rejected numbers) as JSON.
- `--apply`: Apply the proposals to the project now (one atomic batch).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep exercises propose
$ mcprep exercises propose --section 0.1,0.2 --ops batch.json
$ mcprep exercises propose --solutions --apply
```

With `--json`, `result` is: `{ source: "project"|"derived", sections: [{ section, label, title, count, first, last, pages, gaps, duplicates, rejected, excluded, instructions: [{ text, governs }], notes, lowConfidence: [{ label, confidence, evidence }] }], counts: { sections, exercises, withSolution }, proposals?: [...] (all, when there are at most 300; else proposalsOmitted: n and the details file), operations? (when there are at most 300; else operationsOmitted: n and the --ops file), skipped: string[], notes, applied }`

## solutions propose

Find the answers in the answer key at the back of the PDF and match them to the authoritative exercises of the project.

```
mcprep solutions propose [options]
```

The answer key is cut into bands by the section markers and headers (a band runs across all columns and over page breaks); inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; exercises without an answer and answers without an exercise are reported. `--ops` writes `solution.add` operations (one per region) for `frames apply`; `--apply` applies them. An exercise that already has a solution is left alone. The solution is hidden: it is never shown with the exercise, never sent to a tutor, used only to grade.

Options:

- `--ops <file>`: Write the operations as a JSON batch (for `frames apply`).
- `--details <file>`: Write everything (every answer with its evidence, the sequences, the headers) as JSON.
- `--apply`: Apply the solutions to the project now (one atomic batch).
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep solutions propose
$ mcprep solutions propose --ops solutions.json
$ mcprep solutions propose --apply
```

With `--json`, `result` is: `{ sections: [{ section, label, title, answers, first, last, gaps, duplicates, withoutAnswer, withoutExercise, headers, notes }], counts: { exercises, answers, matched, withoutAnswer, withoutExercise }, operations? (when there are at most 300; else operationsOmitted: n and the --ops file), skipped: string[], notes, applied }`

## frames list

List the frames in reading order with their positional labels (E1, E2.1, Q1, B1).

```
mcprep frames list [options]
```

Labels are computed from position, never stored: page by page, top before bottom, left before right; the parts of one exercise count once, at the position of its first part. Adding a frame earlier in the document renumbers the later ones; use the id to refer to a frame.

Options:

- `--page <n>`: Only this zero-based page.
- `--kind exercise|question|bookmark`: Only this kind.
- `-p, --project <file>`: The project file (or a folder holding exactly one). Default: $MCPREP_PROJECT, else the only *.mcprep.json in the current folder.
- `--json`: Print one JSON document (stable, documented in docs/CLI.md) instead of text.
- `--ignore-pdf-change`: Open the project even if the PDF is not the one it was made for (frames may then be misplaced).
- `-h, --help`: Show help for the command.

Examples:

```console
$ mcprep frames list
$ mcprep frames list --page 2 --json
```

With `--json`, `result` is: `{ frames: [{ id, label, kind, page, rect, unit?, part?, partCount?, continues?, context? }], counts: { exercise, question, bookmark } }`

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
```

With `--json`, `result` is: `The change report: { applied, dryRun, created, removed, frames: [...], counts, validation: { ok, errors, warnings, repairs } }`

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

The file holds { "operations": [ ... ] } (or just the list). Each operation has an "op": add, update, delete, move, split, merge, dividers, area, context.add, context.remove, context.set, continues.add, continues.remove, outline.set, outline.add, outline.clear, meta.set, with the same fields as the matching commands. An "add" may carry "ref": "a" and later operations may say "id": "@a" for the frame it created, so you need not guess generated ids. Any failure, or any new validation error, rejects the whole batch and nothing is written. This is how to mark a 60-page sheet in one call.

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

## meta

Show or change the title and library folder of the project.

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

Errors are what the importer would reject (exit code 4). Repairs are what it fixes silently (a value a hair outside the page, parts that miss tiling by under 0.002); the writer fixes them too. Warnings are allowed but suspicious: overlapping frames, a frame inside another, a frame thinner than a line, an edge that cuts through a line of text, a running header or footer inside a frame, a unit with one frame.

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

With `--json`, `result` is: `{ ok, errors: Issue[], warnings: Issue[], repairs: Issue[], counts: { exercise, question, bookmark }, numbers: [{ id, label, kind, number, part?, partCount? }] }; an Issue is { severity, code, message, frameId?, unit?, page?, fix? }`

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

With `--json`, `result` is: `{ path, bytes, sha256, manifest, counts: { frames, outlineEntries }, issues: Issue[] (repairs and warnings), validation: { errors, warnings, repairs }, importCheck?: { ok, steps } }`

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

With `--json`, `result` is: `{ ok, rejection?, errors, repairs, warnings, steps, archive: { bytes, entries }, manifest?, document?, frames?, numbers?, outline? } - the same report as import-check, with everything that was read`

## import-check

Do exactly what the Android importer does with a bundle, step by step, and say whether it would accept it.

```
mcprep import-check <file> [options]
```

The six steps of docs/BUNDLE_FORMAT.md section 5: open the archive and apply the limits; read bundle.json and check format and version; stream document.pdf and compare its SHA-256 and size; open the PDF and compare its page count; parse and validate frames.json and outline.json, repairing what may be repaired and naming the frame id of anything that is rejected; and what would be created in the library. Exit code 4 when the bundle would be rejected.

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

With `--json`, `result` is: `{ wouldImport: boolean, rejection?: Issue, steps: [{ step, name, status, detail }], errors, repairs, warnings, document?, frames?, numbers?, outline? }`

## schema

Print a JSON Schema: bundle-manifest, frames, outline or project.

```
mcprep schema [name] [options]
```

Arguments:

- `name` (optional): One of bundle-manifest, frames, outline, project. Without a name the available schemas are listed.

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
