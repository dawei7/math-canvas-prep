# The desktop app

The desktop app is a visual editor for the same **project file** (`<name>.mcprep.json`, see
[PROJECT_FILE.md](PROJECT_FILE.md)) that the command line and the MCP server edit. It uses the same code for every
change and every check, so what it saves is what `mcprep validate` accepts, and what an agent saves shows up in the
window within a second or two.

It is for a person who wants to look at the page while marking it, to review what an agent proposed, or to **audit a whole
book once as an authority**: its exercises with the numbers the book prints, filed under the sections of the book, with the
answers of the answer key attached as hidden solutions. Nothing about it is required: an agent can do the whole job with
[the command line](CLI.md) or [the MCP server](MCP.md).

![The editor: an exercise with three parts selected, with its slicers and handles](img/desktop-editor.png)

## Start it

You need Node.js 20.19 or newer. From the repository:

```
npm ci
npm run build
npm run desktop                          # the welcome screen
npm run desktop -- C:\books\algebra.pdf  # opens the PDF; creates algebra.mcprep.json next to it if there is none
npm run desktop -- algebra.mcprep.json   # opens a project (a relative name is relative to the folder you typed it in)
```

You can also drop a PDF or a project file onto the window. Opening a PDF that already has a project next to it
(`<name>.mcprep.json`) opens that project.

Notes:

- `npm ci` installs Electron, whose install script downloads its program file (about 100 MB) from GitHub's release
  servers. That is the only network access of the whole toolset, and it happens at install time. Set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` if you only want the command line and the MCP server.
- Some terminals (for example the one inside Visual Studio Code) set `ELECTRON_RUN_AS_NODE`, which makes Electron
  behave as plain Node so that the window never opens. `npm run desktop` removes the variable for you; if you start
  Electron yourself, remove it first.
- A second start hands its file to the window that is already open (one window, one document at a time).

## Working in the window

Top bar: **Open PDF**, **Open project**, **Save**, **Export**, **Document info**, undo and redo, the page pager, zoom (`Fit` fits
the page to the width of the window), **Snap**, **Autosave** and the theme (system, dark, light). Left: the tools. Next to them:
thumbnails with the number of frames on each page. Right: the card of the selected frame and the panels. Bottom: the title, the
counts, the save state and the project file.

Every tool has a small **i** next to it that says in one sentence what it does. A line above the page says what the tool in use
will do and, for the tools that attach something to an exercise, which exercise that is.

| Tool (key) | What it does |
| --- | --- |
| Select (V) | Click a frame to select it. Drag it to move it, drag a handle to resize it. The handles sit outside the outline. |
| Exercise (E) | Drag around one exercise you frame for yourself. A click on a line makes a one-line frame across the text block that line belongs to. |
| Book exercise (A) | Drag around one exercise as the book prints it, then give its printed number and its section (see below). |
| Parts (P) | Drag around an exercise with parts. It is cut where the markers `(a)`, `(b)`, `1.`, ... are found, else once in the middle. A click on an existing frame cuts it. Not for book exercises. |
| Context (C) | Select an exercise (of either kind), then drag around its instruction or shared statement, on any page. |
| Solution (L) | Select an exercise, go to the answer key (any page of the same PDF), then drag around its answer. Hidden from the learner. |
| Continue (N) | Select a frame, then drag where it goes on (the next column or page). |
| Question (Q) | Drag around what you want to ask the tutor about. |
| Bookmark (B) | Drag around a definition or theorem to keep. |
| Delete (Delete) | Deletes the selected frame. An exercise with parts goes as a whole. |

An **exercise with parts** is one object: you move and resize it as one. Its parts are cut by dashed **slicers**: drag a
slicer (or the part label at the right) to move the cut, press **+** below the exercise to cut another part, or **−**
at a slicer to join the two parts. The parts always tile the exercise exactly, so the checks cannot fail on a gap.

**Snap** makes the edges you draw or drag go to the nearest line of printed text (the same snapping as `--snap` on the
command line), so that a frame never cuts a line. It does not apply to scanned pages that have no text; there you place
the edges by eye.

The labels on the frames of exercises you framed yourself (E1, E2.1, B1, ...) are the numbers the Math Canvas app will show:
they are computed from the position on the page (never stored) and renumber themselves when you add or remove a frame.

Keys: `V E A P C L N Q B` choose a tool, `S` toggles snap, `Delete` removes the selected frame, `Esc` closes a dialog or a
form, leaves a tool, or deselects. `←` `→` (or `PageUp` `PageDown`) change the page, `+` `−` `0` zoom, `Ctrl+Z` undo, `Ctrl+Y` or
`Ctrl+Shift+Z` redo, `Ctrl+S` save, `Ctrl+E` export, `Ctrl+O` and `Ctrl+Shift+O` open a PDF or a project.

### Two kinds of exercise

- An **ordinary exercise** (tool Exercise, label `E1`, `E2.1`, ...) is one a person frames for themselves: free, positional
  numbers, it can be cut into parts.
- A **book exercise** (tool Book exercise, amber, a label with square corners) was audited from a book: it carries **the number
  the book prints** (`5`, `5a`, `A.3`) and the **section** it is printed in, it is a single exercise, and it never has a
  positional number. Both kinds can live in one project.

After you draw a book exercise a small form asks for its **printed number** and its **section**. The section offered is the one
at that place of the page (the deepest section of the outline that has an id and contains the position); the number offered is
the next one in that section: the previous one plus 1, or `5b` after `5a`. So auditing a section is: draw, press Enter, draw,
press Enter. The form says in plain words what is wrong (an empty or impossible number, a number the section already has, no
section here) and `Esc` throws the drawing away. Nothing is added to the project until the form is confirmed.

The **card** at the top of the side panel is the menu of the selected frame:

- the printed number and the section of a book exercise, editable (one undoable step each);
- **Make it a book exercise...** (the same form) and **Make it an ordinary exercise**, with the rules of the core: an exercise
  with parts has to be joined first (the card has **Join the parts**), a number a section already has is refused;
- its **context**, its hidden **solution** and its continuations: what is printed under each region, a button to show it on its
  page (it is marked for a moment) and a button to remove it;
- **Parts**: **Cut into parts** or **Join the parts** for an ordinary exercise; for a book exercise the button is off, with an
  **i** that says why (the parts `5a` and `5b` of a printed exercise are two exercises with two labels; what they share, the
  statement printed once, is context on each). The Parts tool says the same when you click a book exercise, and the core
  refuses `split`, `dividers`, `area` and `merge` for it anyway.

The core's messages are written for the command line; the window shows the rule in plain words (never a command to type).

### Solutions

A **solution** is a region of the same PDF, usually in the answer key at the back, that only the grader gets. Select the
exercise, choose the Solution tool, go to the answer key (the exercise stays selected while the page changes) and drag around its
answer. Solution regions are drawn **green and dashed with an `S` marker** and the number of the exercise, faintly for all
exercises and strongly for the selected one, whose regions have a button to remove them right there. Clicking a region selects its
exercise. The card lists them under "hidden from the learner" with what is printed under each; clicking one goes there. An exercise
may have up to eight regions of each kind. A solution is never shown with the exercise, never sent to a tutor chat, and used only
to grade (see [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md)).

### The panels

- **Frames** lists every frame with its label, its first words, its page and icons for its context (📄), solution (🔑) and
  continuation (↪). Book exercises are **grouped by section** in the order of the book with the number the book prints, each group
  in the order a book counts (2 before 10, `5a` before `5b`); what you framed yourself follows in reading order. A filter picks
  **All**, **Book exercises** or **Framed by you**; the search finds a number (`5a`, `1.2:5a`) or a frame id; a click on a section
  folds it, `↗` goes to its heading, and a click on a row shows the frame on its page and scrolls it into view (also the other way:
  a frame chosen on the page is shown in the list). The list draws only the rows in view.
- **Sections** is the table of contents that goes into the bundle: the project's own, which are the sections book exercises are filed
  under. Each row shows the printed number, the title, the page, the id, the number of book exercises (own, and with everything
  below in brackets) and how many of them have a solution. A click goes to the heading; folding hides a subtree; a filter shows the
  sections still **without exercises**, with **exercises without a solution**, or **with problems**; the search finds a title, number
  or id. **Add a section** (after the selected one, or **a subsection**), and for the selected section: title, printed number, id,
  the page it starts on and where its heading is (type it, or **Pick the heading on the page** and click the line; the headings
  are marked on the page while the panel is open), **Outdent/Indent** and **Move up/down** (always with everything below it) and
  **Delete...** (the book exercises filed under it are moved to another section you choose first). Renaming an id takes the
  exercises along. The list warns about ids used twice, sections without an id (with **Give ids**), and book exercises filed under
  a section that does not exist. **Use the PDF's bookmarks** makes the PDF's own bookmarks the sections (with ids), **Find
  headings** looks for headings in the printed text (offline), and **Use the PDF's contents** removes the project's own contents.
- **Checks** runs the same validation as `mcprep validate`. A click on a message goes to the frame it is about. The rules about
  books say what to do on the screen (not a command). A change that would add a new error is refused with a message that says why,
  like on the command line.
- **Propose** reads the printed text of the whole PDF **offline, without any AI**, and suggests exercises, parts, context and
  bookmarks. They appear as dashed ghost frames with a confidence; the **i** next to each says what the suggestion is based on.
  Accept or reject one by one, or all at once. Nothing is changed until you accept. Accepted exercises with a shared statement get
  it as context of their parts, which is the recommended convention. Proposals are exercises you frame yourself; turn one into a
  book exercise from the card.

![A book exercise selected: the card with its context and hidden solution, the list by section, the printed numbers on the page](img/desktop-book.png)

![The Sections: the outline as a tree with the book exercises and solutions under each section, the heading marked on its page](img/desktop-sections.png)

![Proposals as ghost frames, with the list of what was found and why](img/desktop-propose.png)

### Document information

**Document info** sets what the bundle says about the work: the title and folder the library shows, the author, series,
description, **licence** (name and address), the **source address** and the **notice** a licence asks to be shown with the work.
The limits of the format are said next to each field (a licence address needs its name, an address starts with `http://` or
`https://`); copy the licence and the notice from the book itself, do not make them up. It is one undoable step.

### Saving and exporting

**Save** writes the project file atomically (a temporary file, then a rename) and checks the revision it read: if another
program saved in the meantime, nothing is overwritten (see below). **Autosave** saves a moment after each change; it is off
until you turn it on. A failed save stays visible in the status bar and in a message. Closing the window with unsaved
changes asks first.

**Export** (`Ctrl+E`) says what is about to be written before it is: the **optional parts of the format the bundle uses**
(Sections, Book exercises, Hidden solutions; an app that does not know one ignores it), what it contains (the exercises, questions
and bookmarks you framed, the book exercises per section and how many have a solution), the validation and its warnings. It lets
you choose which contents go into the bundle (the project's own, the PDF's bookmarks, or none; a project with book exercises
keeps its own, because they are filed under it), saves the project if needed, writes the `.mcbundle`, and runs the importer check
on the result before it says it worked, with the result of each of the importer's steps. Afterwards **Show in folder** opens
the folder and **Copy to a folder...** copies the bundle, for example into the folder the tablet imports from. **Export book summary
(JSON)...** next to **Export bundle...** writes the plain JSON summary of the book (the sections with the number of book exercises
and solutions in each, and each section's exercises) that `mcprep book export --exercises` writes, for other programs.

![The export dialog of a book: the parts of the format it uses, what it holds per section](img/desktop-book-export.png)

![The export dialog: the importer would accept this project](img/desktop-export.png)

## Together with an agent

The window watches the project file. When a program such as `mcprep` or an MCP client saves a new version:

- without unsaved edits in the window: the page updates, a short message says what changed ("Updated by cli: 1 added"),
  and a small marker in the status bar fades over twenty seconds. The page and the zoom stay as they are, and so does the
  selection if its frame still exists; the undo history starts over, because it belonged to the old version;
- with unsaved edits: a dialog asks whether to **keep mine** (the next save replaces the other version) or **take theirs**.
  Nothing is merged silently.

An agent that edits the file while the window is open therefore needs no special care: it can work through the command
line as usual, and the person sees the result and can correct it by hand. The window compares the content as well as the
revision, so a change made with a text editor that did not raise the revision is noticed too. A book exercise that has been drawn
but not yet confirmed in its form is not in the file; it is dropped when the page changes.

![The dark theme: the instruction shared by Exercises 3 and 4 is context, shown dashed](img/desktop-dark.png)

## A big book

A book can have thousands of exercises (two-column practice pages carry 44 small frames on one page) and hundreds of sections. The
window keeps what it computes per version of the project (the lookups of the frames, the sections with their counts, the checks)
instead of per keystroke, draws only the frames of the page that shows, makes the labels as tall as their frames allow and puts
each in the free space beside its frame (hovering a frame, or selecting it, enlarges its label), and keeps the lists to the rows in
view. The text of the pages is read in the background and checked once, not after every few pages. The selected frame's handles
sit under its neighbours, so that a click on a neighbour selects the neighbour.

`apps/desktop/test/helpers/big-book.ts` builds a synthetic workbook of 5,000 book exercises, 100 sections and an answer key of
5,000 regions. On the Windows machine it was developed on, the built window shows it about a second after the program starts, has
read the text of all 135 pages a second or two later, and then takes a fraction of a second for each of: choosing a frame in the
list, drawing a book exercise and confirming its form, saving, and taking over a change the command line made. While the list was
scrolled five times, a frame chosen in it and thirty pages turned, the window was never busy for more than about a tenth of a second.
The tests assert generous limits (a slow or busy machine), not these numbers.

## What the window can and cannot do

The window is built so that opening a document you did not write is safe, and so that nothing leaves the computer:

- The page code has **no Node access** (sandbox, context isolation, no integration). The only bridge to the rest of the
  system is a fixed list of 19 functions (open, read the PDF of the open project, read the text of a page, propose,
  save, export the bundle, export the book summary, ...); the test suite checks the list.
- It is served from the application folder under its own `mcprep-app://` address with a strict content policy
  (`default-src 'none'`, no inline script, no network). Every request to `http`, `https`, `ws`, `wss` or `ftp` is cancelled.
  Permission requests are denied. Navigation and new windows are blocked. The developer tools exist only in a checkout,
  not in the packaged application.
- There is no telemetry, no update check, no account, no AI call. The PDF is read from where it is; the only copies that are ever
  made are the one inside a bundle you export (and the one you copy to a folder yourself) and the summary file you ask for.
- It stores a list of the twelve most recent projects (title and path; one that no longer exists is not offered) in the
  operating system's user-data folder for the application, and the preferences (theme, snap, autosave) in the window's local
  storage. Nothing else.

## Package it

```
npm run build
npm run pack --workspace @mcprep/desktop   # apps/desktop/release/win-unpacked: a folder to try without installing
npm run dist                               # builds, then also the installer: apps/desktop/release/Math Canvas Prep Setup 0.2.0.exe
```

The output is about 450 MB unpacked and a 133 MB installer, because it contains the Chromium of Electron; it is
git-ignored. electron-builder downloads Electron's runtime from GitHub the first time (it keeps a cache). The configuration is
[`apps/desktop/electron-builder.yml`](../apps/desktop/electron-builder.yml). The build is **unsigned** (this repository has
no certificate), has Electron's default icon, and publishes nothing. Windows will warn about an unknown publisher.
macOS and Linux targets are written down in the configuration but have not been built or tested.

## Tests

- `apps/desktop/test/*.test.ts` (102 tests, no window needed, they run with `npm test`): `logic.test.ts` the editor's state,
  geometry, undo, saving, conflicts, proposals; `book.test.ts` printed numbers, the form's suggestions, the two kinds of exercise,
  solutions and the plain words of the core's refusals, labels on a crowded page; `sections.test.ts` the rows of the Sections list
  and every change of the outline; `info.test.ts` the document information and what the export dialog says; `perf.test.ts` the
  synthetic big book (5,000 exercises, 100 sections): the work of the lists, the page and the store, and that it grows in step with
  the book.
- `apps/desktop/test/app.e2e.test.ts` (17 tests), `book.e2e.test.ts` (25) and `big.e2e.test.ts` (10): the built application driven
  by Playwright like a person (real mouse and keyboard): drawing with snapping, moving, resizing, slicers, saving, an agent
  editing the file, the conflict dialog, export and import check, proposals, the lock-down; the audit of a synthetic workbook
  (book exercises with their forms, mark and unmark, context and solutions, the Sections list, the document information, the export
  dialog and the summary, all read back by the command line); and the big book (opening, scrolling, choosing, drawing, saving,
  live reload, readable labels). They need a display and the built bundle, so they are not part of the continuous integration:
  `npm run build && npm run test:e2e`.
- `npm run screenshots --workspace @mcprep/desktop` takes the pictures on this page from the synthetic samples.

## Known gaps

- Mouse and keyboard first. Touch and pen input are not tuned, and the window is not meant for a small screen.
- One window and one document at a time; no copy and paste of frames; no selecting several frames at once (so turning many
  exercises into book exercises, or giving many the same context or section, is one at a time).
- **Derive sections** (finding the chapters and sections of a book from its printed text, with ids and heading positions), and
  proposals of book exercises and of solutions from the answer key, are not in the window yet. The command line and the MCP
  server have them (`outline derive --book`, `exercises propose`, `solutions propose`; see [AUDIT_A_BOOK.md](AUDIT_A_BOOK.md)); in
  the window **Find headings** and **Propose** suggest ordinary headings and exercises only, and a person files them under
  sections. The Sections panel and the editor logic have a reserved place for them.
- The number offered for a book exercise is the previous one plus 1 (or `5b` after `5a`); it does not know a book's jumps or
  other ways of counting, so it is edited where the book differs.
- A solution region is drawn one at a time for one exercise; there is no "this answer, then the next line for the next exercise".
- The tree of sections is changed with buttons (deeper, shallower, up, down); there is no drag and drop.
- A frame lies on one page; something that continues is marked with a continuation, as in the format.
- The installer does not register `.pdf` or `.mcprep.json` with the system, and has no icon of its own.
- Scanned pages have no text to snap to or to propose from; frames are placed by hand (see the
  [agent guide](AGENT_GUIDE.md) for how an agent reads scans).
- Only Windows was packaged and run. The editor itself has no Windows-only code, but it was not tried elsewhere.
