# Agent guide: marking a PDF for Math Canvas

This guide is for an AI agent that has to **mark a mathematics PDF** with Math Canvas Prep: find every exercise, cut exercises into
parts, attach the context they need, mark questions and bookmarks, check the result by looking at it, and export a bundle.
Read it once from top to bottom; the checklist at the end is for every PDF. (`mcprep guide` prints this text.)

## 1. What you produce, and who uses it

You produce a **project** (`name.mcprep.json`, the work in progress, see [PROJECT_FILE.md](PROJECT_FILE.md)) and, at the end, a
**bundle** (`name.mcbundle`: the PDF plus `frames.json`, optionally `outline.json`, see [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md)).

The bundle is imported by the Android app *Professor Euler: Math Canvas* into the learner's documents library. There the learner
opens the PDF and finds your marks as work items:

| Kind | What the learner does with it |
| --- | --- |
| **exercise** | Solves it by hand on a canvas; the app sends the framed region (and its context) to an AI for grading. |
| **exercise with parts** (a unit) | The same, once per part: (a), (b), (c) become 1.1, 1.2, 1.3, each with its own sheet and check. |
| **context** (attached to an exercise) | The instruction, question or background printed elsewhere. It is shown first when the exercise is shown and goes to the AI with every check. |
| **question** | A passage the learner wants to ask the AI tutor about. |
| **bookmark** | A place worth coming back to (a definition, a theorem, a worked example), with a sheet for the learner's own notes. Never graded. |

Quality of marking decides quality of grading: a frame that cuts an exercise in half, includes the next exercise, or omits the
instruction makes the AI grade the wrong thing. That is why this guide insists on *looking at the result*.

Privacy: the PDF and the project never leave the machine. The tools make no network calls and send nothing anywhere; do not
upload the PDF anywhere either.

## 2. Install and register

From a checkout of the repository (Node 20.19 or newer):

```console
npm install
npm run build
npx mcprep help                      # the command line
node packages/mcp/bin/mcprep-mcp.js  # the MCP server (stdio), see MCP.md for registering it in your client
```

Everything below uses the command line; the MCP tools have the same names and arguments (`docs/MCP.md`). Every command takes
`--json` (one JSON document on standard output, never a prompt) and returns an exit code: **0** success, **2** you used the command
wrongly, **3** a file cannot be used, **4** the request is understood but the data is not acceptable (the JSON error has a
`code` and a `hint`). The full reference is [CLI.md](CLI.md).

## 3. The coordinate system

> **Pages are zero-based. Positions are fractions of the page as displayed, origin at the top-left, y grows downwards.**

- `page: 0` is the first page. A 42-page PDF has pages 0 to 41. The printed page numbers in the book are something else again.
- A rectangle is `{ "left", "top", "right", "bottom" }`, each between 0 and 1, `left < right`, `top < bottom`. On the command line:
  `--rect left,top,right,bottom`.
- Fractions are of the page **as displayed**, that is after the page's own `/Rotate`. A page rotated by 90 degrees that shows as
  landscape has `x` along its long side. `mcprep info` prints the size and the rotation; images from `render` are displayed pages.
- Not percent, not PDF points. `10,20,90,30` is an error; `0.10,0.20,0.90,0.30` is right.
- A frame must be at least `0.02` wide and `0.01` tall. One line of text on a normal page is about `0.015` tall.

### A worked example

The synthetic sample page is A4: 595 x 842 points. `mcprep lines 0` lists the text lines:

```text
top-bottom     left-right     size  col  text
0.2257-0.2403  0.121-0.6876   11    0    Exercise 1. Compute the derivative of f(x) = x^3 - 2x + 5 and evaluate
0.2433-0.2579  0.121-0.5161   11    0    it at x = 2. Show every step of your computation.
0.2942-0.3088  0.121-0.6702   11    0    Exercise 2. Let g(x) = sin(x) + x^2 on the interval [0, pi]. Answer the
```

- The text of exercise 1 starts 72 pt from the left edge: `72 / 595 = 0.121`. Its first line spans from `190.0 pt` to
  `202.3 pt` from the top: `190.0 / 842 = 0.2257`, `202.3 / 842 = 0.2403`.
- On the rendered image `page-0.png` (1131 x 1600 pixels) the same corner is at pixel `(137, 361)`: `137 / 1131 = 0.121`,
  `361 / 1600 = 0.2256`. With `--grid 0.1` the lines of the grid are labelled with page coordinates, so you can read `0.2` and
  `0.3` off the picture and interpolate.
- In a **crop** the labels are still page coordinates. If the crop is `w` x `h` pixels and the result's `view` is
  `{ left, top, right, bottom }`, then a pixel `(px, py)` is the page position
  `(left + px / w * (right - left), top + py / h * (bottom - top))`.
- The frame for exercise 1 is `0.109,0.2197,0.6997,0.2619`: a little above its first line (`0.2257 - 0.006`), a little below its
  last line (`0.2579 + 0.004`), and as wide as the text block plus a margin of `0.012` on each side.

![The sample page with its grid and the marked frames](img/sample-page0.png)

## 4. The workflow

1. **Create the project.** `mcprep init book.pdf --title "Analysis 1: Sheets" --folder "University/Analysis"`. The folder is where
   the app files the document (names separated by `/`, at most seven levels). Everything else uses the project in the current
   folder; give `--project <file>` when there are several.
2. **Inspect.** `mcprep info`: page count, sizes, `/Rotate`, whether the pages have a text layer, the PDF's own outline. A page
   **without** a text layer is a scan: see section 8.
3. **Look at a few pages.** `mcprep render 3 --grid 0.1` writes a PNG; open it. Read the layout: one column or two, where the
   headers and footers are, how exercises are numbered, whether there are figures.
4. **Propose.** `mcprep propose` prints exercise starts with *evidence*, the part markers inside them, instructions printed for
   several exercises, and definitions as bookmarks. It is a heuristic starting point, not the truth. For a big PDF write the
   proposals as operations: `mcprep propose --ops batch.json`, read and edit `batch.json`.
5. **Apply in one batch.** `mcprep frames apply batch.json` applies all operations atomically with one validation at the end.
   If anything is wrong nothing is written and the error names the operation (`Operation 7 (split): ...`).
6. **Look at every frame.** `mcprep crop --all` writes one PNG per frame (and per context and continuation region). **Open them
   and look.** Section 7 says what to check. Fix with `frames update`, `frames split`, `frames dividers`, `context add`, ...
7. **Validate.** `mcprep validate`: errors must be zero; read the warnings (section 9).
8. **Contents.** If the PDF has bookmarks: `mcprep outline pdf --adopt` copies them into the project so that they are exported.
   If not: `mcprep outline derive` finds headings by size, bold and numbering; check them and `--apply`, or write your own with
   `mcprep outline set outline.json`.
9. **Export.** `mcprep export` writes `name.mcbundle` next to the project and reads it back with the importer's checks.
   `mcprep import-check name.mcbundle` repeats that check on any bundle.
10. **Tell the user** where the bundle is and what to know (section 10).

A real session on the sample, with every output, is in [`examples/agent-session.md`](../examples/agent-session.md).

### Working next to a person

The person may have the same project open in the desktop app ([DESKTOP.md](DESKTOP.md)). That changes nothing for you: keep
using the commands (or the MCP tools).

- Every command writes the project atomically under a lock, so the window never sees a half-written file. It shows what you
  changed within a second or two and marks it as "updated by an agent". The person can review page 3 while you work on page 30.
- If the person has unsaved edits when you save, the window asks them which version to keep: you cannot lose their edits and
  they cannot silently lose yours.
- Say what you changed (pages, counts, what you were unsure about): the window only says that something changed.
- Do not try to operate the window; everything it can do is a command. Do not edit `name.mcprep.json` by hand with a text tool
  unless you have to: the commands validate, lock and keep the file consistent.

## 5. Deciding what to mark

### Exercises

An **exercise frame** contains the exercise's number and statement and everything up to **but not including** the next exercise's
number. It does not contain page headers, footers or page numbers, and not a section heading that follows it.

- **Start** a little above the line that carries the number: `top = line.top - 0.006`, but never inside the line above (if that
  line is closer than `0.006`, start at its bottom). `--snap` does this for you when your rectangle cuts through lines.
- **End** just above the next exercise's start, or, for the last one on a page, a little below its last line (`+ 0.004`). The
  exercise **includes its figure or table**, so extend the bottom over it; it may include a short answer space but need not.
- **Width**: the text block, with a margin of about `0.012`. Use the same `left` and `right` for all frames on a page: parts of one
  exercise must have the same left and right anyway.
- An exercise is the unit the learner solves. Do not mark a whole page or a whole section as one exercise, and do not mark a
  *heading* ("Chapter 3 Exercises") as one.
- Frames of independent exercises must not overlap each other. A frame inside another frame is a warning.

### Exercises with parts

When an exercise has parts (a), (b), (c) that the learner answers separately, mark it as **one exercise cut into parts**. The parts
share a `unit`, always **tile one area** (each part starts exactly where the one above ends, same left and right), and are numbered
by the app as `4.1`, `4.2`, `4.3`.

- **Each part starts at its marker line**: `(a)`, `a)`, `a.`, `(i)`, `1)`, `3.1` ... `mcprep propose` finds them; `mcprep lines` lets
  you check. Put the divider a little above the marker line (`line.top - 0.006`, or at the bottom of the line above it).
- **Where does the shared statement go?** The text before (a) ("Let f be ... Answer the following") is needed by *every* part.
  There are two conventions:
  - *The app's own splitter* (the "parts" button on the tablet) keeps it inside the **first** part: part 1 starts at the top of the
    frame. That works when a person frames on the tablet, but part 2 and 3 are then graded without the statement.
  - **Recommended for bundles: make it context.** The first part starts at the marker of (a), and the text above it (the exercise
    number and the shared statement) becomes **context of the exercise**, which the AI receives with *every* check:
    `mcprep frames split f1 --first 0.3265 --at 0.3441,0.3617 --preamble context --snap`, where `--first` is the top of the
    (a) line and `--at` the tops of (b) and (c). `mcprep propose` produces exactly this (`--parts context` is the default;
    `--parts keep` gives the app's convention).
- If an exercise has **no statement before (a)** (the marker is on the exercise's first line), the first part starts at the top of the
  frame and there is nothing to make context.
- Only one level of parts. If (a) has sub-items (i), (ii), keep them inside part (a).
- A part that is a single line is fine (the minimum piece is `0.01`).
- To change parts later: `frames dividers <part> --at y1,y2` (move/add/remove the cuts), `frames area <part> --rect l,t,r,b` (move
  or resize the whole exercise), `frames merge --unit <unit>` (back to one frame), `frames delete <unit> --unit`.
- A part cannot be moved or resized on its own (`frames update` refuses with `E_UNIT_PART`): the parts always tile.

### Context

**Context** is the instruction, question or background that belongs to an exercise but is printed elsewhere. Attach it with
`mcprep context add <exercise> --page <n> --rect l,t,r,b --snap`; at most 8 regions per exercise; only exercises have context. For an
exercise with parts it is kept on the first part and applies to all parts.

- An instruction printed once above several exercises ("Exercises 3 and 4: justify every answer") is context of **each** of them:
  add the same region to both. `mcprep propose` finds these ("applies to p3, p4").
- A statement, a definition of the function, or a figure on **another page** that the exercise refers to ("see Figure 2") is context
  too, with the page of that place.
- Do not put context inside the exercise's own frame (the warning `context-overlaps-frame` says the text would be shown twice).
- Do not use context for things the learner does not need to solve this exercise.

### Questions and bookmarks

- A **bookmark** marks a place worth keeping: a definition, a theorem with its statement, a worked example, a table of formulas.
  Frame the whole block (title and statement), not just the title line. `propose` suggests blocks that start with
  Definition, Theorem, Lemma, Proposition, Corollary, Remark, Example (and German/French/Spanish forms).
- A **question** marks a passage the learner wants to ask the AI tutor about. The learner decides that, so create questions
  when the user asked for them or told you what is confusing; do not invent them.
- Neither has parts or context. A question or bookmark may have `continues` regions.

### Tasks that continue on the next page or in the next column

If an exercise starts at the bottom of a page and goes on at the top of the next, make **one** frame for the part where it starts and
attach the rest as **continuation regions**: `mcprep continues add f4 --page 3 --rect l,t,r,b --snap` (up to 8, in reading order).
`propose` does this when the next page starts with text that is not a new exercise. The next page's own exercises are separate
frames; do not let the continuation region cover them.

An **exercise with parts cannot have continuation regions.** If its parts run over a page break, make each page's parts frames of the
same unit: parts (a) and (b) at the bottom of page 3, part (c) at the top of page 4 are three frames with the same `unit`; the
tiling rule applies per page.

### Layouts that need care

- **Two columns.** `mcprep lines` reports a `column` for every line; a frame covers one column. An exercise that flows from the
  bottom of the left column to the top of the right one is a frame plus a continuation region. Numbering is by page, then `top`,
  then `left`, exactly as the app does it, so in a two-column layout the numbers can differ from the printed order: the labels that
  `frames list` shows are the ones the app will show.
- **Figures.** Include a figure that belongs to the exercise inside its frame (extend the bottom edge). A figure printed at the top
  of the next page that the exercise refers to is context.
- **Rotated pages.** Nothing special: all coordinates are of the displayed page (`info` shows `/Rotate`).
- **Very short exercises.** A frame must be at least `0.02` wide and `0.01` tall; a smaller rectangle is enlarged around its centre
  (with a note), `--no-enlarge` refuses instead. One text line is about `0.0146` tall on A4; a one-line exercise frame with padding is
  about `0.02`.
- **Solutions and answer keys.** Do not mark solution pages as exercises unless the user wants them as bookmarks.

## 6. How to find where an exercise starts and ends

With a text layer, work from `mcprep lines <page>`:

1. Find the lines that begin an exercise: "Exercise 3", "Aufgabe 3", "Problem 3", "3.", "3)", "Task 3", ...
   (`propose` lists them with a confidence and its reasons; trust it where it says 0.9 and look hard where it says 0.5).
2. `top` = `line.top - 0.006`, or the bottom of the line above if that is closer.
3. `bottom` = the `top` of the next exercise's start (computed the same way), or for the last exercise on a page the bottom of its
   last text line plus `0.004`; over a figure if there is one (render the page and look).
4. `left` / `right` = the text block (smallest `left` and largest `right` of the body lines, minus/plus `0.012`).
5. Add it with `--snap` and read the notes; then look at the crop.

Without a text layer, see section 8.

## 7. Check by looking

`mcprep crop --all` (or `mcprep crop f3`, `mcprep crop --page 2 --rect l,t,r,b`) writes PNGs. Open each and check:

- [ ] The number and the first words of the exercise are at the **top**; the previous exercise's last line is not.
- [ ] The **last line** of the exercise is at the bottom, complete; nothing of the next exercise is below it.
- [ ] **No line of text is cut in half** at the top or bottom (a sliver of a line above or below means the edge is wrong: move it
      or use `--snap`).
- [ ] No **page header, footer or page number** is inside.
- [ ] The **figure** or table of the exercise is inside.
- [ ] For parts: each crop begins with its marker `(b)`; the statement is in the context crop (`crop f2 --region context:0`).
- [ ] A continuation crop (`--region continues:0`) starts where the text goes on and ends before the next exercise.
- [ ] A bookmark contains the whole block, title and statement.

`mcprep render 3 --frames --grid 0.05` draws all frames of the page with their labels (E1, E2.1, Q1, B1; dashed = continuation or
context) on the page: use it to see the whole page at once and to find overlaps and gaps. After a fix, look again.

## 8. Scanned PDFs, and pages without a text layer

`info` lists pages without a text layer; `lines` returns nothing for them; `propose` says there is nothing to propose and `--snap`
cannot do anything. You mark by eye:

1. `mcprep render <page> --grid 0.05` and open the image.
2. Read the positions of the top of the exercise number, the top of the next exercise and the margins off the labelled grid
   (interpolate between grid lines).
3. Put the edges in the white space between items, not inside text: a little (about `0.005`) above the first line, a little below
   the last.
4. `mcprep frames add --kind exercise --page <n> --rect l,t,r,b`, then `mcprep crop <id> --grid 0.02` and check as in section 7.
   Expect to correct once or twice. Use `frames update <id> --rect ...` with the corrected values.

Mixed documents are common (typeset pages and scanned pages): `propose` works on the pages that have text and tells you the rest.

## 9. Validation

`mcprep validate` applies every rule of the bundle format and says which frame is wrong and how to fix it:

- **Errors** are what the importer would reject; the bundle cannot be exported until they are gone. Typical: a page that does not
  exist (`page-out-of-range`), a rectangle too small or outside the page, parts of a unit with a gap or overlap (`unit-gap`,
  `unit-overlap`), parts that are not in one column (`unit-edges`), context on a question, more than 8 regions.
- **Repairs** are fixed silently by the importer (and by the exporter): a value a hair outside the page, parts that miss each other
  by less than `0.002`.
- **Warnings** are allowed but suspicious: `overlap` and `contained` (independent frames), `thin-frame`, `clips-line` (an edge cuts
  through a line of text), `includes-header-footer`, `context-overlaps-frame`, `unit-single`, `no-frames`. Fix them unless you
  have a reason.

A command that would introduce an error is refused (`E_REJECTED`, exit code 4) and writes nothing; `--force` writes anyway (do not,
unless you intend to fix it in the next command). `--dry-run` previews any change.

## 10. Export, and what to tell the user

```console
mcprep export                 # sheet.mcbundle next to the project; use --out to choose
mcprep import-check sheet.mcbundle
```

The exporter validates, writes atomically and reads the bundle back with the importer's own checks; a bundle that fails them is
removed. The result lists repairs and warnings. Then tell the user, briefly:

- the **path** of the bundle and the project, and that the bundle goes to the tablet and is opened in the Math Canvas library;
- how they can **review** your marking by eye: `npm run desktop -- name.mcprep.json` opens the project in the editor, where every
  frame can be moved or corrected by hand (then export again from there, or with `mcprep export`);
- the **counts**: exercises (parts counted once), parts, questions, bookmarks, contents entries;
- what you were **unsure** about (low-confidence proposals, ambiguous layouts), the pages **without a text layer**, anything left
  out on purpose, and any warnings you accepted;
- that the numbering shown by the tools (`E4.2`) is computed by position, as the app does.

## 11. What not to do

- Do not use one-based page numbers, percent or points.
- Do not guess the numbers the app will show: it numbers by position. Use ids (`f3`) to refer to frames and `frames list` to see labels.
- Do not let independent frames overlap, and do not cut a line of text in half.
- Do not include page headers, footers and page numbers; do not mark headings as exercises; do not mark a whole page.
- Do not put the shared statement of an exercise with parts into a *second* part, or leave it out of every part and context.
- Do not give an exercise with parts a `continues` region, and do not try to move one part alone.
- Do not trust `propose` blindly: look at the crops.
- Do not edit the PDF, and do not copy the PDF into other places than the bundle. Do not upload anything.
- Do not mark questions the user did not ask for.
- Do not export with errors by forcing: fix them.

## 12. Recipes

### A whole sheet in one batch

The operations are the same as the commands; `"ref"` names a frame you just made so that later operations can say `"@name"`
without guessing generated ids. This batch marks the second page of the sample: an instruction that is context of two exercises, an
exercise that continues on the next page and a definition as a bookmark.

<!-- test:batch -->
```json
{
  "operations": [
    { "op": "add", "ref": "ex3", "kind": "exercise", "page": 1, "rect": [0.109, 0.2435, 0.7187, 0.2857] },
    { "op": "add", "ref": "ex4", "kind": "exercise", "page": 1, "rect": [0.109, 0.7423, 0.7187, 0.8021],
      "continues": [ { "page": 2, "rect": [0.109, 0.0962, 0.7033, 0.1208] } ] },
    { "op": "context.add", "id": "@ex3", "page": 1, "rect": [0.109, 0.1128, 0.7187, 0.1727] },
    { "op": "context.add", "id": "@ex4", "page": 1, "rect": [0.109, 0.1128, 0.7187, 0.1727] },
    { "op": "add", "kind": "bookmark", "page": 2, "rect": [0.109, 0.196, 0.7033, 0.2558] }
  ]
}
```

Operations: `add`, `update`, `delete`, `move`, `split`, `merge`, `dividers`, `area`, `context.add`, `context.remove`, `context.set`,
`continues.add`, `continues.remove`, `outline.set`, `outline.add`, `outline.clear`, `meta.set`. Their fields are the options of the
matching commands (`mcprep help frames split`, ...). Apply with `mcprep frames apply batch.json` (or `-` for standard input);
`--dry-run` first if you like.

### An exercise with parts and the shared statement as context

```console
mcprep lines 0                       # find the tops of "(a)", "(b)", "(c)" lines
mcprep frames add --kind exercise --page 0 --rect 0.109,0.2882,0.6996,0.4010 --snap
mcprep frames split f1 --first 0.3265 --at 0.3441,0.3617 --preamble context
mcprep crop f1 --region context:0    # the number and the shared statement
mcprep crop f1                       # starts at (a)
```

### A textbook chapter of 40 pages

```console
mcprep init chapter.pdf --title "Analysis: Chapter 3" --folder "University/Analysis"
mcprep info
mcprep render 5 --grid 0.1                   # understand the layout first
mcprep propose --pages 0-9 --ops first.json  # try ten pages, read first.json, check the evidence
mcprep frames apply first.json
mcprep crop --all                            # look; fix what is wrong
mcprep propose --pages 10-39 --ops rest.json
mcprep frames apply rest.json
mcprep outline pdf --adopt                   # or: outline derive --apply
mcprep validate && mcprep export
```

Marking the first ten pages first shows how well the heuristics fit this book before you apply them to all of it.

### A scanned sheet

```console
mcprep info                                   # "text layer: MISSING on pages 0-3"
mcprep render 0 --grid 0.05
mcprep frames add --kind exercise --page 0 --rect 0.08,0.12,0.92,0.31
mcprep crop f1 --grid 0.02                    # look, then adjust:
mcprep frames update f1 --rect 0.08,0.115,0.92,0.305
```

### Errors you will meet

| You see | It means | Do |
| --- | --- | --- |
| `E_PAGE` | The page does not exist (or you used a one-based number). | Pages are zero-based: `info` says how many there are. |
| `E_RECT_RANGE` | Values outside 0..1: percent or points. | Divide by the page width (x) or height (y). |
| `E_RECT_ORDER` | `right <= left` or `bottom <= top`. | Origin is the top-left; y grows downwards. |
| `E_REJECTED` | The change would introduce validation errors. | Read the issues; fix; or `--dry-run` to see them. |
| `E_UNIT_PART` | You tried to move one part alone. | `frames area`, `frames dividers`, `frames merge`. |
| `E_SPLIT` | A divider leaves a piece thinner than `0.01`, or is outside. | Choose dividers inside the frame, at least `0.01` apart. |
| `E_PDF_CHANGED` | The PDF is not the one the project was made for. | Restore it, `relink`, or start a new project. |
| exit code 3 | A file is missing or damaged, or another program holds the lock. | Read `error.message` and `hint`. |

## 13. Checklist

- [ ] `info`: pages, rotation and text layer understood; pages without text noted.
- [ ] A few pages rendered with `--grid` and looked at.
- [ ] Every exercise marked once, starting at its number and ending before the next; headers and footers left out.
- [ ] Parts where the exercise has (a), (b), (c); the shared statement is context; parts start at their marker lines.
- [ ] Instructions printed once for several exercises attached as context to each; context from other pages attached.
- [ ] Tasks that continue have continuation regions (or parts per page for a unit).
- [ ] Definitions, theorems and worked examples worth keeping are bookmarks; questions only where asked.
- [ ] Every frame **looked at** in `crop --all`; nothing cut in half, nothing missing, nothing extra.
- [ ] `validate`: zero errors, warnings understood.
- [ ] Contents: PDF bookmarks adopted, or derived and checked, or written by hand.
- [ ] `export` done and `import-check` says it would be accepted.
- [ ] The user is told where the bundle is, the counts, the uncertainties and the pages that need a look.
