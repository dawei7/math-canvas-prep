# MCP server

`packages/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over **stdio**. It gives an AI agent the same
operations as the [`mcprep` command line](CLI.md) as typed tools: create a project, look at pages (text lines with coordinates,
rendered images with a grid), propose exercises, add and edit frames, cut parts, attach context, apply a batch atomically, validate,
export the `.mcbundle`, check a bundle as the Android importer would. For a whole book audited as an authority there are tools for
the sections (`outline_add`, `outline_update`, `outline_delete`, `outline_ids`), for the exercises that keep the numbers the book
prints (`exercises_add`, `exercises_list`, `exercises_mark`, `exercises_unmark`, `exercises_label`, `exercises_section`), for the
hidden answers from the answer key (`solution_add`, `solution_list`, `solution_remove`) and for the book itself (`book_show`,
`book_meta`, `book_export`); `outline_derive_book`, `exercises_propose` and `solutions_propose` propose the sections, the exercises and
the answers of a whole book, `exercises_verify` checks the result against the text layer (no images) and `exercises_sample` names a
fixed sample to look at, the same for every agent (see [AUDIT_A_BOOK.md](AUDIT_A_BOOK.md)). Each tool runs the command line in process
and returns its JSON result (so the two can never disagree); the PNGs of `render_page` and `render_crop` come back as **image content**,
which is how the model looks at its own work.

How to mark a PDF well is in the [agent guide](AGENT_GUIDE.md). The server offers it as the resource `mcprep://guide`, as the tool
`get_guide` and as the prompt `mark_pdf`, and its `instructions` summarise the conventions (zero-based pages, fractions of the
displayed page with the origin at the top-left, positional labels that are never stored, the workflow, and how a book is audited:
two kinds of exercise, labels as printed, sections, context versus hidden solution regions).

Long lists in a result (`frames`, `steps`, `exercises`, `solutions`, `warnings`) are cut after 500 entries so that a book of thousands of
exercises does not flood a model's context; a field such as `framesOmitted` says how many were left out. Errors, the lists of created ids
and the counts are never cut, and the command line (`--json`) prints everything.

The server makes no network calls and sends nothing anywhere. It writes nothing but protocol messages to standard output.

## Run it

```console
npm install
npm run build
node packages/mcp/bin/mcprep-mcp.js            # waits for a client on stdin/stdout
node packages/mcp/bin/mcprep-mcp.js --project /path/to/book.mcprep.json   # optional default project
node packages/mcp/bin/mcprep-mcp.js --call-log /path/to/run-a.jsonl       # optional: log every tool call
```

Use **absolute paths** in the configurations below: clients start the server in a folder of their own choosing. Relative paths in
tool arguments (for example `create_project` with `pdf: "book.pdf"`) are resolved from the server's working directory; give absolute
paths unless you set `cwd`.

**The call log.** With `--call-log FILE` (or the environment variable `MCPREP_CALL_LOG`, which the option overrides) the server appends
one line of JSON to the file for every tool call, after the call has returned: `{"arguments":{...},"ok":true,"surface":"mcp","tool":"..."}`
with the keys of every object in sorted order, the arguments as given (never the contents of a PDF) and, for a call that failed with an
error, its code as `"error"`. Two logs, of two agents or of an agent and a person at the command line (which logs the same way when
`MCPREP_CALL_LOG` is set), are compared by `scripts/compare-calls.mjs`: see the agent guide, "Comparing two agent runs".

## Register it in a client

Replace `C:/path/to/math-canvas-prep` with where you cloned the repository.

### Claude Code

```console
claude mcp add math-canvas-prep -- node C:/path/to/math-canvas-prep/packages/mcp/bin/mcprep-mcp.js
```

Add `--scope user` to have it in every project, or `--scope project` to write a `.mcp.json` that you can commit. The file looks like
this, and you can also write it by hand:

```json
{
  "mcpServers": {
    "math-canvas-prep": {
      "command": "node",
      "args": ["C:/path/to/math-canvas-prep/packages/mcp/bin/mcprep-mcp.js"]
    }
  }
}
```

Then, in Claude Code, say: *"Mark the PDF C:/books/analysis.pdf for Math Canvas and file it under University/Analysis"* (the prompt
`mark_pdf` does the same). Check that the server is up with `/mcp`.

### Claude Desktop

Edit `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`, macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart the app:

```json
{
  "mcpServers": {
    "math-canvas-prep": {
      "command": "node",
      "args": ["C:/path/to/math-canvas-prep/packages/mcp/bin/mcprep-mcp.js"],
      "env": { "MCPREP_PROJECT": "C:/books/analysis.mcprep.json" }
    }
  }
}
```

`MCPREP_PROJECT` is optional: it sets the project that the tools work on until `create_project` or `open_project` says otherwise.

### Any other MCP client

Start a stdio server with the command `node` and the argument `C:/path/to/math-canvas-prep/packages/mcp/bin/mcprep-mcp.js` (some
clients call this "command" and "args", some "stdio transport"). There are no environment variables to set. To try the server by
hand, the MCP Inspector works: `npx @modelcontextprotocol/inspector node packages/mcp/bin/mcprep-mcp.js` (a separate tool, not a
dependency of this repository).

## Working with a person at the same time

The project file is shared with the desktop app. When an agent changes it through these tools, a desktop app that has the project
open reloads it and shows that an agent updated it; the agent's calls and the person's edits do not overwrite each other (every
write reads the file fresh under a lock; the desktop app asks which version to keep when it has unsaved edits).

## What a tool returns

- A **result** as JSON text and as `structuredContent` (the same object). For commands that change the project it is the change
  report: `applied`, `created`, `removed`, `frames` (with their labels), `counts`, `validation` (`errors`, `warnings`, `repairs`).
- **Images** as `image/png` content next to the JSON (`render_page`, `render_crop`); the file path is in the JSON too.
- A **failure** has `isError: true` and `{ ok: false, exitCode, error: { code, message, hint?, issues? } }`. The codes are those of the
  command line (`E_PAGE`, `E_RECT_RANGE`, `E_REJECTED`, `E_VALIDATION`, `E_PDF_CHANGED`, `E_NO_PROJECT`, ...); the `hint` says what to do.
- `validate` and `import_check` report errors in their *result* (`ok: false`, `wouldImport: false`), not as a failure.
- Arguments that do not fit the schema (a rectangle with three numbers) are rejected by the protocol layer before the tool runs.

<!-- generated by scripts/generate-mcp-docs.mjs: do not edit below this line -->

## Tool reference

58 tools. Arguments marked * are required. Every tool that works on a project also takes an optional `project` (the path of the project file; default: the project created or opened earlier in the session).

### `create_project`

Starts work on a PDF: reads it once (page count, SHA-256) and writes name.mcprep.json next to it (or at "project"). The PDF is never modified; the project refers to it by a relative path. The new project becomes the default project of this session. Use "folder" for where the document is filed in the app library (names separated by "/", at most seven levels).

Arguments:

- `pdf`* (string): Path of the PDF to mark.
- `title` (string): The title the library shows (1 to 200 characters; default: the file name).
- `folder` (string): Library folder, for example "University/Analysis/Sheets".
- `force` (boolean): Overwrite an existing project file.

### `open_project` (read-only)

Makes an existing project (name.mcprep.json) the default project of this session and returns its summary (see project_info). Use it to continue work, or after a person or another agent changed the file.

### `project_info` (read-only)

Pages (count, sizes, /Rotate), whether the pages have a text layer (a page without one is a scan and must be marked by eye), the PDF's own outline, the project's title and folder, and how many frames there are. Call it first.

Arguments:

- `full_text` (boolean): Check the text layer of every page instead of a sample of 12.

### `set_metadata`

Changes the title the app library shows and the folder it files the document in. Without title and folder it only returns the current values. The author, series, description, licence, source address and notice of a book are set with book_meta.

Arguments:

- `title` (string)
- `folder` (string): Names separated by "/", at most seven levels; "" removes it.

### `get_page_lines` (read-only)

The text lines of one page in reading order (columns left to right, each top to bottom), each with its box as page fractions (origin top-left), font size, column, and whether it is a running header or footer (and bold, with fonts=true). Use it to find where exercises start and end. An empty list means the page has no text layer: it is a scan; use render_page with a grid instead.

Arguments:

- `page`* (integer): Zero-based page: the first page is 0.
- `region` (any[] | { left, top, right, bottom }): Only the lines inside this rectangle.
- `fonts` (boolean): Also tell which lines are bold (slower).

### `render_page` (read-only)

Renders a page to a PNG and returns it as an image (the file path is in the result too). grid=0.1 draws a labelled grid: the labels are page coordinates (origin top-left), so you can read positions off the image. frames=true draws the project's frames with their labels (E1, E2.1, Q1, B1; dashed = continuation or context). LOOK at the image: it is how you read the layout and check your marking.

Arguments:

- `page`* (integer): Zero-based page: the first page is 0.
- `grid` (number): Grid step as a fraction of the page, for example 0.1 or 0.05.
- `frames` (boolean): Draw the frames of the project on the page.
- `solutions` (boolean): With frames: also draw the hidden solution regions (dashed, "sol 5a"): use it on the answer-key pages to check where the answers were attached.
- `max_side` (integer): Longer side in pixels (default 1200 here).

### `render_crop` (read-only)

Renders one frame (its main region, or a continuation, context or solution region), or any rectangle of a page, to a PNG and returns it as an image. This is how you CHECK a frame: the exercise number and first words must be at the top, nothing of the next exercise at the bottom, no line cut in half, no header or footer, the figure inside; and for a book exercise region "solution:0" shows the answer that was attached to it. With grid the labels are still page coordinates. Give "frame" (an id, or SECTION:LABEL for a book exercise), or "page" and "rect".

Arguments:

- `frame` (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `region` (string): With frame: main (default), continues:N, context:N or solution:N (N from 0).
- `page` (integer): Zero-based page: the first page is 0.
- `rect` (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `grid` (number): Grid step as a fraction of the page, for example 0.05 or 0.02.
- `max_side` (integer): Longer side in pixels (default 1000 here).

### `get_outline` (read-only)

The project's own outline if it has one (that goes into the bundle), else the PDF's own bookmarks (the bundle then carries none and the app reads the PDF's). Entries are { index, title, page (zero-based), depth, id?, label?, top? }: the entries are the SECTIONS of the book. With the project's own outline each entry also says how many authoritative book exercises are filed under it (exercises) and under it with everything below it (exercisesTotal), and how many of those have a solution (withSolution).

### `adopt_pdf_outline`

Copies the PDF's bookmarks into the project so that they are exported and can be edited.

### `derive_outline`

Heuristics: a line is a heading when it is set larger than the body text, in bold, numbered like "2.1" or starts with a chapter word; depth from numbering or font size. Returns entries with confidence and evidence. With apply=true they are stored in the project (check them first).

Arguments:

- `apply` (boolean)
- `min_confidence` (number)

### `set_outline`

Replaces the project's outline. Entries are { title (1 to 200 characters), page (zero-based), depth (0 to 8; a child is one deeper than its parent), id?, label?, top? } in reading order. The id is what exercises name as their section (unique; letters, digits, . _ -, starting with a letter or digit), the label is the number printed with the heading ("1.1", "Chapter 3"), the top is where the heading starts on its page (0 to 1, from the top). auto_ids gives the entries without an id one. A change that leaves book exercises filed under an id the new outline no longer has is refused. An empty list stores an empty outline; use clear_outline to remove the project's outline altogether. outline_add, outline_update and outline_delete change single entries.

Arguments:

- `entries`* ({ title, page, depth, id, label, top }[])
- `auto_ids` (boolean): Give every entry that has no id one (from its label, else the number in its title).

### `clear_outline`

The bundle then carries no outline and the app reads the PDF's own.

### `propose`

Offline heuristics (no AI) over the printed text: lines that start an exercise ("Exercise 3", "Aufgabe 3", "3.", "3)"), where each ends (before the next start, a heading or a definition; over a figure; onto the next page when the text goes on), part markers (a) (b) (c) inside an exercise, instructions printed for several exercises ("Exercises 3 and 4") and definitions, theorems and remarks as bookmarks. Every proposal has a confidence and its evidence, and the result includes "operations" that create them (give them to apply_operations, after editing if you like). Nothing is applied unless apply=true. It is a starting point: check the crops.

Arguments:

- `pages` (string): Zero-based pages to look at, like "0,2,5-7" (default all). Try ten pages first on a big book.
- `min_confidence` (number): Default 0.5.
- `bookmarks` (boolean): Propose definitions, theorems, remarks as bookmarks (default true).
- `graphics` (boolean): Render pages to find figures so that frames reach over them (default true; slower).
- `parts` ("context" | "keep" | "none"): What to do with the statement above (a): context (default, recommended: it becomes context of the exercise and the first part starts at (a)), keep (leave it in the first part, as the app's own splitter does), none (no parts).
- `ids` (string[]): With apply: only these proposal ids (p1, p3).
- `apply` (boolean): Apply the proposals to the project now, as one atomic batch.

### `list_frames` (read-only)

All frames in reading order with id, label, kind, authority, page, rect, unit, part, and the number of context, continuation and solution regions. Two kinds of exercise: those a person framed for themselves have a positional label (E2.1, Q1, B3: computed, never stored; authority "user"); authoritative book exercises (authority "book") are named by the number the book prints and the section they belong to (reference "1.2:5a"). counts are the positional ones; book says how many book exercises there are.

Arguments:

- `page` (integer): Zero-based page: the first page is 0.
- `kind` ("exercise" | "question" | "bookmark"): exercise: to solve and be checked; question: to ask the AI tutor about; bookmark: a place worth coming back to (definition, theorem, worked example).
- `authority` ("book" | "user"): Only authoritative book exercises (book), or only what a person framed for themselves (user).
- `section` (string): Only the book exercises filed under this section (an outline entry id).

### `add_frame`

Adds an exercise, a question or a bookmark. An exercise contains its number and statement and everything up to but not including the next exercise's number, without page headers or footers. A rect below the minimum (0.02 wide, 0.01 tall) is enlarged around its centre. With snap the edges move off lines of text. Returns the change report (created ids, labels, validation). Use split_frame afterwards to cut an exercise into parts, add_context for an instruction printed elsewhere. For many frames use apply_operations.

Arguments:

- `kind`* ("exercise" | "question" | "bookmark"): exercise: to solve and be checked; question: to ask the AI tutor about; bookmark: a place worth coming back to (definition, theorem, worked example).
- `page`* (integer): Zero-based page: the first page is 0.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `id` (string): Your own id ([A-Za-z0-9_-], up to 40 characters); default generated (f1, f2, ...).
- `context` ({ page, rect }[]): Context regions (instruction or background printed elsewhere). Exercises only.
- `continues` ({ page, rect }[]): Further regions of the same task, in reading order. Not for parts.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `update_frame`

Changes the page, rectangle or kind of a frame (context is dropped when it stops being an exercise). A part of an exercise cannot be changed on its own: use set_area, set_dividers or merge_frames.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `kind` ("exercise" | "question" | "bookmark"): exercise: to solve and be checked; question: to ask the AI tutor about; bookmark: a place worth coming back to (definition, theorem, worked example).
- `page` (integer): Zero-based page: the first page is 0.
- `rect` (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `delete_frame` (destructive)

Deletes a frame; with unit=true the id is a unit id and every part of that exercise goes. A part taken out of the middle leaves no gap (the part above takes over); an exercise left with one part is an ordinary exercise again.

Arguments:

- `id`* (string): The frame id, or the unit id with unit=true.
- `unit` (boolean)
- `dry_run` (boolean): Compute and validate but do not write the project.

### `move_frame`

Moves a frame by dx, dy (fractions of the page; negative = left/up). An exercise with parts moves as a whole. Stops at the page edges.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `dx` (number)
- `dy` (number)
- `dry_run` (boolean): Compute and validate but do not write the project.

### `split_frame`

Cuts an exercise into parts (a), (b), (c) = 1.1, 1.2, 1.3 that tile one area. "at" gives the y positions where the parts after the first start, each at its marker line (snap moves a divider onto the nearest line). By default the first part starts at the top of the frame, so the statement before (a) stays inside it (the Android app's own splitter). RECOMMENDED: pass "first", the y where the first part starts (the top of the (a) line); the text above becomes context of the exercise, which every check then receives. The original frame keeps its id as the first part. Can also cut an existing part again.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `at`* (number[]): y positions (page fractions, top to bottom) where parts 2, 3, ... start.
- `first` (number): Where the first part starts (default: the top of the frame).
- `preamble` ("keep" | "context" | "drop"): What becomes of the text above "first": context (default when first is given) or drop.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `merge_frames`

Merges all parts of a unit (unit="u3") or two or more neighbouring part ids (ids) into one frame.

Arguments:

- `unit` (string)
- `ids` (string[])
- `dry_run` (boolean): Compute and validate but do not write the project.

### `set_dividers`

Sets the cuts between the parts of an exercise on a page: moves them, adds parts (more cuts) or removes the last parts (fewer). The area of the parts stays. No cuts turns it back into one frame.

Arguments:

- `id`* (string): Any part of the exercise.
- `at`* (number[]): The new cuts (y, top to bottom); empty for none.
- `page` (integer): Zero-based page: the first page is 0.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.

### `set_area`

Sets the area of the parts: left and right apply to every part, top to the first part, bottom to the last; the cuts between parts stay where they are.

Arguments:

- `id`* (string): Any part of the exercise.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.

### `add_context`

Attaches a region of context (the instruction, question or background printed elsewhere) to an exercise. It is shown first when the exercise is shown and goes to the AI with every check. Use it for an instruction printed once above several exercises (add it to each), or text on another page. For an exercise with parts it is kept on the first part and applies to all of them. Up to 8 regions; exercises only.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `page`* (integer): Zero-based page: the first page is 0.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.

### `remove_context` (destructive)

Removes one context region of an exercise (index from 0; needed when there are several) or all of them.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `index` (integer)
- `all` (boolean)
- `dry_run` (boolean): Compute and validate but do not write the project.

### `add_continuation`

Adds a further region of the same task after the main region (for example where an exercise goes on in the next column or on the next page); up to 8, in reading order. Not allowed for the parts of an exercise (give each page its own parts instead).

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `page`* (integer): Zero-based page: the first page is 0.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.

### `remove_continuation` (destructive)

Removes one continuation region (index from 0; needed when there are several) or all.

Arguments:

- `id`* (string): The frame id (for example f3), as listed by list_frames. Not the label E3. A book exercise can also be named SECTION:LABEL (1.2:5a).
- `index` (integer)
- `all` (boolean)
- `dry_run` (boolean): Compute and validate but do not write the project.

### `apply_operations`

Applies a list of operations in one atomic batch with ONE validation at the end: any failure, or any new validation error, rejects the whole batch and writes nothing. This is how to mark a 60-page sheet in one call. Each operation has "op": add, update, delete, move, split, merge, dividers, area, context.add, context.remove, context.set, continues.add, continues.remove, authority.mark, authority.unmark, label.set, section.set, solution.add, solution.remove, solution.set, outline.set, outline.add, outline.update, outline.delete, outline.ids, outline.clear, meta.set, with the fields of the matching tools (rect as [l,t,r,b] or an object; page zero-based). An "add" may carry "ref": "a"; later operations may use "id": "@a" for the frame it created (or replaced), so you need not guess generated ids; a book exercise can also be named "SECTION:LABEL" ("1.2:5a"). An "add" with "authority": "book", "label" and "section" makes an authoritative book exercise (no "kind" needed; it cannot have a "unit"; "solution" lists regions of the answer key); applying the same batch twice does not duplicate it, the second time is an error naming the exercise, unless the "add" says "replace": true. The "operations" returned by propose can be passed as they are.

Arguments:

- `operations`* ({ op }[]): The operations, applied in order.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `validate` (read-only)

Checks the project against every rule of the bundle format. Errors (what the importer would reject; each names the frame id and the fix), repairs (what the importer fixes silently) and warnings (allowed but suspicious: overlaps, an edge cutting a line of text, a header inside a frame, ...). For a book also: a label and a section with every book exercise, (section, label) unique, every section the id of an outline entry, solution regions only on exercises, valid outline ids; warnings for a label written with the "." or ")" the book prints, an exercise printed in another section than the one it is filed under, a solution region lying on the exercise or on another exercise. ok=false means errors. A failed validation is a result, not a tool failure.

Arguments:

- `text` (boolean): Also run the checks that read the printed lines (default true).

### `export_bundle`

Validates, then writes the bundle (the PDF byte for byte plus frames and outline, and for a book the sections, the book exercises, their hidden solution regions and the author, licence and notice from book_meta) atomically and reads it back with the importer's own checks; a bundle that fails them is removed. Errors in the project stop the export. A project with book exercises must be exported with its own outline (the default). Default path: name.mcbundle next to the project. Tell the user where it is: it goes to the tablet and is opened in the Math Canvas library.

Arguments:

- `out` (string): Where to write the bundle (name.mcbundle).
- `title` (string)
- `folder` (string)
- `outline` ("project" | "pdf" | "none"): Which contents to carry: the project's own outline (default), the PDF's bookmarks, or none.

### `inspect_bundle` (read-only)

Reads a .mcbundle: manifest (features, author, licence, notice), entries, frames with their labels (a book exercise by SECTION:LABEL), the sections with the number of exercises in each (summary), and every problem the importer would find.

Arguments:

- `file`* (string): Path of the .mcbundle.

### `import_check` (read-only)

Does exactly what the importer does, in its six steps (archive and limits, manifest, PDF hash, PDF page count, frames and outline with repairs, what would be created), and says whether it would accept the bundle. wouldImport=false is a result, not a tool failure.

Arguments:

- `file`* (string): Path of the .mcbundle.

### `get_guide` (read-only)

The guide for agents that mark a PDF: coordinate system with a worked example, workflow, rules for exercises, parts, context, questions, bookmarks, continuations, columns, scans, how to check by looking, what not to do, a checklist. Read it before you start.

### `get_schema` (read-only)

The JSON Schema of bundle-manifest, frames, outline or project files, of the book summary (book_show, book_export), of the report of exercises_verify, of the sample of exercises_sample, of the gate certificate and the audit notes (gate, notes), of book_compare (compare) and of the contact sheets (sheets).

Arguments:

- `name`* ("bundle-manifest" | "frames" | "outline" | "project" | "book-summary" | "verify" | "sample" | "gate" | "notes" | "compare" | "sheets")

### `exercises_list` (read-only)

The authoritative exercises by section (in the order of the outline) and, within a section, in reading order: id, label (the number the book prints), section, reference (SECTION:LABEL, how to name it), page, rect, and the number of context, continuation and solution regions. totals say how many there are in the whole project and how many have a solution. Use without_solution to see which still have no answer attached.

Arguments:

- `section` (string): Only the exercises filed under this section.
- `subtree` (boolean): With section: also the sections below it.
- `page` (integer): Only exercises that start on this page.
- `with_solution` (boolean)
- `without_solution` (boolean)

### `exercises_add`

Adds ONE printed exercise of the book with the label the book prints, in its section. It contains its number and statement and everything up to but not including the next exercise's number, without page headers or footers. It is a single exercise: it has no parts. The parts of a printed exercise (5a, 5b) are two exercises with two labels; the statement printed once above them is attached to each as context. Adding an exercise that exists (same section and label) is an error, so that applying the same calls twice does no harm; replace=true overwrites it in place instead (page, rect and continuation are replaced, context and solution when given). A rect below the minimum is enlarged; with snap the edges move off lines of text. Returns the change report. For many exercises use apply_operations with "authority": "book".

Arguments:

- `section`* (string): The id of the outline entry (the section) the exercise belongs to; get_outline lists them.
- `label`* (string): The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters: letters, digits, spaces and . _ - ( ) /).
- `page`* (integer): Zero-based page: the first page is 0.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `id` (string): Your own frame id ([A-Za-z0-9_-], up to 40 characters); default generated (f1, f2, ...).
- `context` ({ page, rect }[]): The instruction or statement the learner sees and the AI receives with every check (printed once above 5a and 5b, say).
- `continues` ({ page, rect }[]): Further regions of the same exercise, in reading order (the next page, the next column).
- `solution` ({ page, rect }[]): Where the answer is printed in this PDF (the answer key at the back): hidden from the learner, used only to grade.
- `replace` (boolean): Overwrite the exercise in place if it exists (same section and label).
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_mark`

Gives an exercise that a person framed the label the book prints and its section: it keeps its place, context and solution, loses its positional number (E3) and is named by label and section from now on. It cannot be part of a unit (merge_frames first).

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `label`* (string): The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters: letters, digits, spaces and . _ - ( ) /).
- `section`* (string): The id of the outline entry (the section) the exercise belongs to; get_outline lists them.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_unmark`

The exercise loses its label and section, gets a positional number again and can be cut into parts. Its context and solution regions stay.

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_label`

Changes the printed number of an authoritative exercise. A label that is already taken in the section is refused, naming both exercises.

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `label`* (string): The number exactly as the book prints it, without the closing "." or ")": 5, 12, 5a, A.3, II-4 (1 to 24 characters: letters, digits, spaces and . _ - ( ) /).
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_section`

Files an authoritative exercise under another section (an outline entry id).

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `section`* (string): The id of the outline entry (the section) the exercise belongs to; get_outline lists them.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `solution_add`

Attaches a region of the SAME PDF where the answer is printed (usually the answer key at the back) to an exercise. It is hidden and used only to grade: the learner never sees it with the exercise and it is never sent to a tutor chat. Typically one small region per exercise (the line "22) 0") or one block that answers several exercises (give the same region to each). Up to 8 per exercise. Then LOOK at it: render_crop with region "solution:0". The instruction that the learner does see is context (add_context), not this.

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `page`* (integer): Zero-based page: the first page is 0.
- `rect`* (any[] | { left, top, right, bottom }): A rectangle in fractions of the page as displayed (0..1, origin top-left, y downwards): [left, top, right, bottom] or { left, top, right, bottom }. Not percent, not points.
- `snap` (boolean): Snap to the printed lines: an edge that cuts a line of text moves off it (a line mostly inside is taken whole, mostly outside is left out); a divider moves onto the start of the nearest line.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `solution_list` (read-only)

The solution regions of one exercise, or of every exercise that has some (frame, label, reference, regions with index, page and rect). With missing=true instead the book exercises that have no solution region yet.

Arguments:

- `id` (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `missing` (boolean)

### `solution_remove` (destructive)

Removes one solution region of an exercise (index from 0, as solution_list shows; needed when there are several) or all of them (all=true).

Arguments:

- `id`* (string): The exercise: its frame id (f12) or SECTION:LABEL (1.2:5a).
- `index` (integer)
- `all` (boolean)
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `book_show` (read-only)

The summary of the book: its information (title, author, licence, ...), every outline entry as a section (index, id, label, title, page, top, depth, parent) with the number of book exercises filed under it (exercises), under it and everything below it (exercisesTotal), how many of them have a solution, and the first and last label; and the totals (sections, book exercises, with and without solution, exercises filed under a section the outline does not have, and what a person framed for themselves). Compare the counts with the book. With exercises=true each section also lists its own exercises. The format is described by get_schema("book-summary").

Arguments:

- `used` (boolean): Only the sections that hold exercises, and the entries above them (text rendering only).
- `exercises` (boolean): Also list the own exercises of each section.

### `book_meta`

The title and library folder, and the author, series, description, licence (name and address), source address and notice that go into the bundle. The licence travels with the file: a licence that asks for attribution needs its notice shown wherever the book is shown, so give notice the text the licence asks for (who wrote it, under which licence, what was changed). An empty text removes a field; web addresses are http or https. Without arguments it returns the current values.

Arguments:

- `title` (string)
- `folder` (string): Library folder, names separated by "/", at most seven levels; "" removes it.
- `author` (string)
- `series` (string)
- `description` (string)
- `license_name` (string): For example "CC BY 3.0". A new name replaces the whole licence (give license_url again).
- `license_url` (string): Where the licence is (http or https); "" removes it.
- `no_license` (boolean): Remove the licence.
- `source_url` (string): Where the work comes from (http or https).
- `notice` (string): The text the licence asks to be shown with the work.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `book_export`

Writes the summary of book_show as a plain, documented JSON file (camelCase, zero-based pages; get_schema("book-summary")): the sections with their exercise and solution counts, the totals and the information about the book. Default path: name.book.json next to the project.

Arguments:

- `out` (string): Where to write it.
- `exercises` (boolean): Also list the own exercises of each section.

### `outline_add`

Adds an entry to the outline (the sections of the book), at the end or at position "at" (from 0). It gets an id unless you give one or say no_id; the id is what exercises name as their section. depth 0 is a chapter, 1 a section in it, and so on; a child follows its parent and is one level deeper.

Arguments:

- `title`* (string)
- `page`* (integer): Zero-based page: the first page is 0.
- `depth` (integer)
- `id` (string): The id (letters, digits, . _ -, starting with a letter or digit, up to 60 characters). Default: made from the label or the title.
- `no_id` (boolean)
- `label` (string): The number printed with the heading ("1.1", "Chapter 3").
- `top` (number): Where the heading starts on its page, from the top (0 to 1).
- `at` (integer): Insert at this position of the outline instead of at the end.

### `outline_update`

Changes one outline entry, named by its id (or by index, its position from 0, when it has none): title, page, depth, label ("" removes it), top (null removes it) or id (new_id; the exercises filed under the old id follow). Changing the depth moves only this entry.

Arguments:

- `id` (string): The id of the entry.
- `index` (integer): The position of the entry in the outline, for an entry that has no id.
- `title` (string)
- `page` (integer): Zero-based page: the first page is 0.
- `depth` (integer)
- `new_id` (string)
- `label` (string)
- `top` (number | null)

### `outline_delete` (destructive)

Deletes an outline entry, named by id (or index). The entries below it move up one level, or are deleted with it (subtree=true). A section that book exercises are filed under cannot be deleted: move them first (exercises_section).

Arguments:

- `id` (string)
- `index` (integer)
- `subtree` (boolean)

### `outline_ids`

Gives every outline entry that has no id one (from its printed label, else the number at the start of its title, else a short form of the title), so that exercises can name it. Entries that have an id keep it. Use it after adopt_pdf_outline or derive_outline.

### `outline_derive_book`

For a book that prints numbered chapters and sections (a table of contents with page numbers, chapter openers, headings like "3.2 Practice - Title"): reads the printed contents (also lines that the text extraction merged), the lists on the chapter openers and the headings on the pages, cross-checks them and proposes chapters (id c0, label "Chapter 0") and sections (id and label "0.1") with title, zero-based page, top, confidence and evidence. Titles are normalised ("&" and a slash read as "and", typos of the contents repaired when the headings agree) and every difference is reported. Each section also says where its practice set starts and ends (the start of whatever comes next). With apply=true the entries (with id, label and top) are stored as the outline of the project: do that before exercises_propose, because exercises refer to sections by id. Look at the result: gaps, sections without a practice set and spellings that differ are listed in "notes".

Arguments:

- `apply` (boolean): Store the proposal as the outline of the project (with ids, labels and tops); it replaces the outline the project has.
- `chapter_words` (string): Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults.
- `practice_words` (string): Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, ...).
- `answer_words` (string): Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults.
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_propose`

Offline heuristics (no AI) over the printed text of every practice set (or of the sections you name): the lines that start with a printed number ("5)", "5.", "(5)", "5a)") that form a sequence and align like the others, a frame for each exercise (its text, continuation lines, the second line of a fraction, a figure beside it, lines on the next page), the bold instruction printed above a group as its context (two regions when it crosses a page break), the printed label as the exercise's name and the section. Numbers that are missing, printed twice or put aside are reported in "sections[].gaps/duplicates/rejected/notes": what the book prints is what is proposed. The result carries "operations" (add with authority "book", label, section, context; with solutions=true also the solution regions) that you can pass to apply_operations, or apply=true applies them as one atomic batch. Applying again is safe: an exercise is identified by its section and label, so one the project already has the same way is skipped, one that only lacks its answer gets the answer found now, and one that differs from the proposal (you may have corrected the frame) is kept and listed in "changed" unless replace=true overwrites it in place. Needs the outline from outline_derive_book (apply=true) in the project. Look at render_crop images of a sample (the first and last of each section, the figures, an item at a page end, an instruction that crosses a page break) before you apply, and fix what is wrong with update_frame.

Arguments:

- `sections` (string[]): Only these sections, by id or label ("0.1"); default all.
- `solutions` (boolean): Also read the answer key and give each exercise its solution regions (hidden from the learner, used to grade).
- `max_items` (integer): At most this many exercises per section; the surplus is listed as excluded (use when the book prints more than the audit wants).
- `ops_file` (string): Write the operations as a JSON batch to this file (for apply_operations or `mcprep frames apply`).
- `details_file` (string): Write every proposal with its evidence, the instructions and the rejected numbers as JSON to this file.
- `instructions` ("bold" | "margin" | "auto" | "none"): How instructions are recognised: bold (set in bold, at the margin), margin (at the margin, above an item), auto (bold when the pages carry font information; the default), none.
- `item_patterns` (string[]): How the number of an exercise or answer starts a line, as regular expressions: group 1 is the label as printed, group 2 the text after it. Replaces the defaults ("5)", "5.", "(5)", "5a)"). Example: "^([A-Z]\.\d+)\s+(.*)$" for labels like A.3.
- `chapter_words` (string): Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults.
- `practice_words` (string): Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, ...).
- `answer_words` (string): Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults.
- `apply` (boolean): Apply the proposals to the project now, as one atomic batch. Exercises the project already has are skipped (see replace).
- `replace` (boolean): Overwrite the exercises of the project that differ from the proposal, in place (they keep their ids); without it they are kept and listed in "changed".
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `solutions_propose`

Reads the answer key at the back of the same PDF: it is cut into bands by the small section markers ("2.3") and the headers ("Answers - Slope-Intercept") that run across all columns and over page breaks; inside a band the answers are the lines that start with a printed number, framed with their continuation lines, the second line of a fraction or the graph that stands where the answer is. Each answer is matched by (section, label) to an authoritative exercise of the project; "sections[].withoutAnswer" lists exercises without an answer and "withoutExercise" answers without an exercise. The result carries "operations" (solution.set, one per exercise, named SECTION:LABEL); apply=true applies them as one atomic batch. Applying again is safe: an exercise that already has this solution is skipped, and one whose solution differs (you may have corrected it) is kept and listed in "changed" unless replace=true. The solution is hidden from the learner and used only to grade. Look at render_crop images of a sample of the answer regions, especially graphs and answers of several lines.

Arguments:

- `ops_file` (string): Write the operations as a JSON batch to this file.
- `details_file` (string): Write every answer with its evidence and the sequences as JSON to this file.
- `item_patterns` (string[]): How the number of an exercise or answer starts a line, as regular expressions: group 1 is the label as printed, group 2 the text after it. Replaces the defaults ("5)", "5.", "(5)", "5a)"). Example: "^([A-Z]\.\d+)\s+(.*)$" for labels like A.3.
- `chapter_words` (string): Words that open a chapter heading ("Chapter 3"), comma separated, replacing the defaults.
- `practice_words` (string): Words that name a practice set in a heading ("3.2 Practice - Title"), comma separated, replacing the defaults (practice, exercises, problems, ...).
- `answer_words` (string): Words that open the answer key and the header of a section in it ("Answers - Title"), comma separated, replacing the defaults.
- `apply` (boolean): Apply the solutions to the project now, as one atomic batch.
- `replace` (boolean): Overwrite the solution of an exercise that has a different one; without it that exercise is kept and listed in "changed".
- `dry_run` (boolean): Compute and validate but do not write the project.
- `force` (boolean): Write even if the change introduces validation errors (almost never what you want).

### `exercises_verify` (read-only)

A text-only quality check of an audited book, the same list for every agent (no images, no network): reads the exercises stored in the project and the text layer of the PDF and reports what a person would find by looking at the crops. Findings come in a fixed order (errors, warnings, infos; by code; by the order of the book), each as { code, severity, ref (SECTION:LABEL), page (zero-based), message, evidence }. Codes: label-not-first (the region does not start with its number, read at the left margin; or its left edge cuts the number), no-text, solution-label-missing (the answer region does not hold the label as the start of an item), solution-no-text, overlap (regions of two exercises lie on each other), context-overlaps-frame, duplicate-region, region-size (taller than 0.45, narrower than 0.05 or smaller than 0.002 in area), section-unknown, section-page, gap (numbers missing in a section), duplicate, non-numeric-label, order (a label out of order in its column), no-solution (a section with no or few answers), label-outlier, and the checks of whole pages and of the layout: text-left-behind (a line in no region), numbered-text-left-behind (a missed exercise or part), answer-left-behind and answer-clipped (in the answers), span-gap, continuation-order and continuation-limit (exercises that go on over page breaks), context-range, context-missing and context-not-nearest (the instruction of an exercise), solution-section-mismatch and solution-order (the answer key by section), region-open-end and region-holds-item (the end of a region in a section whose exercises stand inline), inline-section (information) and, with ink=true, edge-on-ink (an edge of a region runs through printed ink). The result also has summary (counts) and sections (per section: exercises, first and last label, withSolution, gaps, duplicates). Fix every error (crop the exercise with render_crop, then update_frame, exercises_label, exercises_section, solution_add), look at the warnings, and call it again until there are no errors. It changes nothing. details_file writes the whole report; the result carries the first 300 findings and findingsOmitted says how many it left out. The exit code of the command is 4 when fail_on is met, which is a result here, not a failure.

Arguments:

- `sections` (string[]): Only the exercises filed under these sections (outline entry ids, "1.2"); default all. Ordinary exercises are then left out.
- `details_file` (string): Write the whole report (every finding) as JSON to this file (format math-canvas-verify).
- `ink` (boolean): Also render the pages (each page that has a region once) and report every region edge that runs through printed ink (edge-on-ink). Slower. Default off.
- `fail_on` ("error" | "warning" | "none"): The severity from which the command line would exit with code 4 (default error). The result is the same.
- `item_patterns` (string[]): For a book that does not print "5.", "5)" or "(5)": regular expressions with the label as printed in group 1 (as for exercises_propose); they add to what is read by default.

### `exercises_sample` (read-only)

The review sample of an audited book, bounded and chosen by rules without randomness, so that every agent looks at exactly the same exercises and answers (whatever its model, and independent of the order of the frames in the file). At most "exercises" exercises (default 40) and "solutions" answers (default 20). The rules are applied in order, each adds its exercises that are not in the sample yet until the cap is reached, and a rule that does not fit is thinned by an even stride, never cut off at the end. Exercises: (1) one exercise of each layout kind the book has (the first in the order of the book): it has a continuation, its instruction is on another page, it stands in a row with one other exercise, in a row with two others, the longest region, the smallest region, a region much taller than the median of its section (beside a figure); (2) the first and the last exercise of every chapter; (3) the first and the last exercise of every section, or of an even stride of sections that keeps the first and the last when less than twice as many exercises as sections are left in the cap; (4) an even stride over the rest. Answers: those of the exercises of rule 1, the answer with the most lines, an answer that is only a picture, the first answer of every chapter's key, those of the other sampled exercises, then an even stride over the rest. per_section=true is the thorough review: the first and the last exercise of EVERY section (and the answers of every sampled exercise) are taken beyond the caps. Each entry is { ref (SECTION:LABEL), reason, reasons, page, kind (exercise or solution), region (main or solution:0) }: look at each with render_crop (frame = ref, region = region), or set crops_dir to have the PNG of every region written (named by reference and kind) and read them. "notes" lists the layouts the book does not have and the rules that were thinned. It changes nothing.

Arguments:

- `exercises` (integer): The most exercises the sample has (default 40); 0 leaves the exercises out.
- `solutions` (integer): The most answers the sample has (default 20); 0 leaves the answers out.
- `per_section` (boolean): The thorough review: take the first and the last exercise of every section (and the answers of every sampled exercise) beyond the caps; the sample may then be larger than "exercises" and "solutions". Default off.
- `out_file` (string): Write the sample as JSON to this file (format math-canvas-sample).
- `crops_dir` (string): Also write the PNG crop of every region of the sample into this folder, named by reference and kind ("1.2_5-exercise.png", "1.2_5-solution.png").

### `book_compare` (read-only)

Compares the audited sections and their exercise counts with a reference list of the book (the owner's own count of the exercises of each section), section by section, matching sections by the label the book prints. The reference is a JSON file of one of two forms: { "chapters": [{ "number": 1, "title": "...", "sections": [{ "number": 1, "title": "...", "exercise_count": 40 }] }] } (section 1 of chapter 1 is "1.1"; chapter_offset is added to the chapter numbers) or { "sections": [{ "label": "1.1", "title": "...", "exercise_count": 40 }] }. The result lists per section the reference count against the audited count, the first and last label, the pages of the first and the last exercise, the difference and whether the titles differ; the sections on one side only; the totals; a table per chapter; and under differences everything that differs (kind count, missing, extra or title). The exit code of the command is 4 when there is a difference, which is a result here, not a failure: look at the pages of every differing section and decide (what the book prints is acknowledged with audit_ack, anything else is a defect to repair). No network; nothing is changed. details_file writes the whole report (format math-canvas-compare).

Arguments:

- `reference`* (string): Path of the reference JSON file.
- `chapter_offset` (integer): Added to the chapter numbers of a reference with chapters (the reference counts from 1 and the book prints 0: -1).
- `details_file` (string): Write the whole report as JSON to this file.

### `exercises_sheets` (read-only)

Makes contact sheets (PNG files) for an exhaustive visual pass: the exercises in the order of the book (all of them, those of sections, or the fixed sample of exercises_sample), per_sheet (default 12) to a sheet, two cells wide, each cell of a fixed width and captioned SECTION:LABEL and the zero-based pages of its regions ("p. 12, 13-14"). A cell shows one region under the other: the instruction (blue frame), the exercise (red), its continuations (orange) and, with solutions=true, its answer (green). Files: sheet-0001.png, ... and sheets.json in out_dir, which lists the references and pages of every sheet and a hash of what it shows. Nothing is uploaded; the same project gives the same sheets. sheet draws only that sheet, from_sheet the sheets from that one on (sheets.json is always the whole list): use them to look again after a repair. Look at every sheet, repair what is wrong, then list the sheets you looked at in a file for audit_gate (sheets_seen).

Arguments:

- `out_dir`* (string): The folder for the sheets and sheets.json.
- `sections` (string[]): Only the exercises of these sections (outline entry ids).
- `sample` (boolean): Only the exercises of the fixed sample.
- `per_sheet` (integer): Cells on a sheet (default 12).
- `solutions` (boolean): Also draw the answer of each exercise (green).
- `sheet` (integer): Draw only this sheet (1 is the first).
- `from_sheet` (integer): Draw only the sheets from this one on.

### `audit_gate` (read-only)

The end of an audit. Runs validate (0 errors), exercises_verify with every check of whole pages, instructions, spans and the answer key (every error and warning must be repaired or acknowledged; ink=true adds the pixel check of the edges), the comparison with a reference list of the book when reference is given (every difference acknowledged), the import check of the bundle exported last when there is one (it must import and have the frames of the project) and, with sheets_seen, that every contact sheet of exercises_sheets (scope all) shows the exercises as they are now and is listed as looked at. The result has open (neither repaired nor acknowledged), acknowledged (with the reason), passed and the counts; the command exits with code 4 unless nothing is open, which is a result here, not a failure. It writes the certificate <name>.audit-gate.json next to the project (the SHA-256 of the frames and the outline): any later change to them makes it stale. status=true only says whether the certificate is current and passed. Acknowledgements (<name>.audit-notes.json, added with audit_ack) are ONLY for what the BOOK prints (a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists), NEVER for a defect of ours: repair those.

Arguments:

- `reference` (string): Also compare with this reference list of the book (see book_compare).
- `chapter_offset` (integer): Added to the chapter numbers of a reference with chapters.
- `ink` (boolean): Also render the pages and check the edges of the regions (edge-on-ink). Slower.
- `item_patterns` (string[]): How the number of an exercise or an answer starts a line, as for exercises_verify (regular expressions with the label in group 1).
- `sheets_seen` (string): The list of the contact sheets that were looked at (JSON {"seen": [1, 2]} or text such as 1-12, 14), next to the sheets.json of exercises_sheets with scope all.
- `status` (boolean): Only say whether the certificate on disk is for the project as it is now and whether it passed; run no check.

### `audit_ack`

Appends one acknowledgement to <name>.audit-notes.json after checking that the finding exists now. code is the code of the finding (duplicate, no-solution, gap, reference-count, ...), ref the exercise (SECTION:LABEL) or the section, page the page of the finding, quote a piece of its text (at most 60 characters), count how many findings the note covers (required for a section: the note applies only while exactly that many match), reason what the book prints and where (a sentence). Acknowledge ONLY what the BOOK itself prints: a number printed twice, an answer missing from the key, a practice set with more exercises than the reference lists, a remark between two exercises. A region that cuts a line, an exercise or an answer that was missed, an answer on the wrong exercise are defects of ours: repair them. A blanket acknowledgement (no code, no exercise, a wildcard) is refused. Give the same reference, ink and item_patterns as for audit_gate when the finding comes from them.

Arguments:

- `reference` (string): Also compare with this reference list of the book (see book_compare).
- `chapter_offset` (integer): Added to the chapter numbers of a reference with chapters.
- `ink` (boolean): Also render the pages and check the edges of the regions (edge-on-ink). Slower.
- `item_patterns` (string[]): How the number of an exercise or an answer starts a line, as for exercises_verify (regular expressions with the label in group 1).
- `code`* (string): The code of the finding.
- `ref`* (string): The exercise (SECTION:LABEL) or the section the finding is about, as the finding names it.
- `reason`* (string): Why it is not a defect: what the book prints and where.
- `page` (integer): The zero-based page of the finding.
- `quote` (string): A piece of the evidence or the message of the finding (at most 60 characters).
- `count` (integer): How many findings the note covers (required for a section).
- `by` (string): Who looked (default "agent").
