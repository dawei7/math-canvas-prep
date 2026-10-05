# Agent runbook: audit a book until it is perfect

For any AI agent that has the `mcprep` command line (a shell) or the `mcprep` MCP server and can look at images. There are two kinds of
rules here. **What the book prints is YOUR work** (Phase S, section 1A): you look at the book page by page, decide yourself what is an
exercise, count it, and frame it; the tools show, measure, record and check, they never decide for you, and the automatic proposals are
drafts that you check. **Everything else is fixed** (the geometry of a region, the gate, the visual record, the survey record, the report, what
you never do): there follow it literally. Where it gives a command, a formula or a STOP code, use it exactly.

A bundle contains the whole book. Keep it private: make your own from your own copy of a book. Nothing in this runbook sends a page,
a crop or a word of the book anywhere except to you, the agent that reads it and looks at the pictures the tools write; you must not send any of it anywhere
else either (no web search, no online converter or OCR, no upload).

## 0. What "perfect" means, and how you will know

Perfect is what the **book prints**. The audit is perfect when:

1. every exercise the book prints in its practice sets (or inline in its text) is in the project exactly once, with the label the book
   prints, in the section it is printed in, and no exercise the book does not print is there;
2. each exercise region holds exactly that exercise: it starts with its label, holds the whole statement (parts, figure, the
   continuation on the next column or page), holds nothing of a neighbour, cuts no line, holds no running header or footer;
3. each exercise has the instruction the book prints for its group, and no other;
4. every answer the book prints in the same PDF is attached to its exercise (a range such as "1-7." to every exercise it names); an
   exercise whose answer the book does not print has none;
5. the sections are the contents the book prints (labels, titles, pages);
6. the numbers of a reference list, if there is one, are met, or every difference is explained by the book with its page;
7. nothing is silent: **`audit gate --final` exits with 0**: nothing is open, every page of the book has an entry in the survey record and every exercise has an entry in the visual
   record, both fitting the project, and every acknowledgement was confirmed by somebody else.

The tools propose; the harness checks everything that can be checked without looking; you repair what it finds and look at what it
cannot see. The gate is the definition of done.

## 1. Before you start

Write these down once and never change them:

| Name | Value |
| --- | --- |
| `MCPREP` | the command that runs the tool on the command line surface: `node REPOSITORY/packages/cli/bin/mcprep.js` with the absolute path of the clone the task names. Wherever this runbook writes `mcprep`, run `MCPREP` (inside the clone, `npx mcprep` is the same program) |
| `PDF` | the absolute path of the book |
| `NAME` | the file name of the PDF without `.pdf` |
| `WORK` | an absolute path of a new folder for everything you write (make it if it does not exist; never the PDF's own folder) |
| `P` | `WORK/NAME.mcprep.json` (the project) |
| `BUNDLE` | `WORK/NAME.mcbundle` |
| `SIDECAR` | `NAME.meta.json` next to the PDF, if it exists |
| `REF` | a reference list (JSON), if the task gives one |
| `PATTERNS` | the `--item-pattern` options the book needs (section 8); none unless the book needs them |
| `GATE` | the options every gate call carries: `PATTERNS`, `--survey "WORK/survey"` (the page-by-page survey record of Phase S, once it exists), and `--reference "REF"` (with `--chapter-offset N` when the sidecar gives `referenceChapterOffset`) when there is a reference list. Always the same, so that every call sees the same findings |
| `ME` | your name for the notes (`--by`), for example the model's name |

**One surface for the whole run**: the command line (`mcprep ...`, every command with `--project "P"`) or the MCP server (tool names in
section 12). Do not mix them.

**Start the call log before your first `mcprep` call**, so that two runs can be compared: CLI: set the environment variable `MCPREP_CALL_LOG` to
`WORK/calls.jsonl` (bash: `export MCPREP_CALL_LOG="WORK/calls.jsonl"`; PowerShell: `$env:MCPREP_CALL_LOG = "WORK/calls.jsonl"`; if your shell does not keep
environment variables from one call to the next, put the assignment in front of every `mcprep` command: `MCPREP_CALL_LOG="WORK/calls.jsonl" mcprep ...`); MCP:
start the server with `--call-log "WORK/calls.jsonl"`.

**Keep a progress file**: after every step append one line to `WORK/progress.md` (`A4 done: 11 chapters, 77 sections`). If you are
interrupted, whoever continues reads that file and goes on at the first step that is not there.

**Calls.** Anything that only reads (`lines`, `render`, `crop`, `info`, `pages sheets`, `exercises census`, `outline` without `--apply`, your own scripts over their output) is
allowed whenever you need it to find out what the book prints. The calls that CHANGE the project are the ones this runbook lists, among them the outline commands (`outline add`,
`outline update`, `outline delete`, `outline set`, `outline ids`: the outline must equal the contents the book prints, section 1A and A5), and the options of a gate call are always the same
(`GATE`), so that every call sees the same findings.

**Sidecar** (all keys optional): `title`, `folder`, `author`, `series`, `description`, `license {name, url}`, `sourceUrl`, `notice`,
`options {chapterWords, practiceWords, answerWords, itemPattern[], instructions}`, `maxItems`, `reference` (a path), `referenceChapterOffset`.
Licence, author and notice are optional facts: write what the book's front matter says in so many words, or nothing. Never guess; never a
blocker.

**Never**: upload the PDF, a page, a crop or text of the book to any service; edit the PDF; invent an exercise, a number, an answer or a licence; renumber what
the book prints; use `--force`; edit the project file by hand; acknowledge a defect of ours; confirm your own acknowledgement; delete a file you did not make.

## 1A. Phase S: look at the book yourself (always, before any automatic proposal)

**You are the auditor.** The finder behind `exercises propose` knows only the layouts it was taught. On any other layout it finds nothing, or a small part of the exercises, and says
nothing: a book of a thousand exercises can come back with "0 errors, 0 warnings". So the first thing you do with a book is to look at it, page by page, decide yourself what is an
exercise, and count what the book prints. Whatever the tools propose afterwards is a draft that you check against your own count and against the pages; a proposal you did not check is
not part of the audit, and "the tool found nothing" is never a result. The tools help you to see (pictures), to measure (exact text positions), to record (the project) and to check (the
gate); they never decide for you.

Start with two calls, then keep your notes in `WORK/survey/` as you go (small files; whoever continues after an interruption reads them).

**A1. Create the project.**
`mcprep init "PDF" --out "P" --title "TITLE" --folder "FOLDER"`
TITLE = the sidecar's `title`, else the text of the first line with the largest `fontSize` on the first page that has text (`mcprep lines PAGE --json
--pdf "PDF"`, pages from 0), else NAME. Leave `--folder` out when the sidecar has none. (The title is only what the library shows; a person can change it later with
`mcprep book meta --title`.)

**A2. Text layer.** `mcprep info --full-text --project "P"`. Let N be the pages and S the pages without a text layer.
S larger than 3 percent of N: STOP `SCAN` (these tools do not read scans; report the pages). Otherwise go on and list the S pages in the report.

**S1. The structure.** Read the contents: `mcprep outline pdf --project "P"` (the bookmarks of the PDF, if it has some) and `mcprep outline derive --book --project "P"` without
`--apply` (the sections the printed contents show, with their pages). When the two disagree or give little, read the printed contents pages themselves (`mcprep lines PAGE --json`,
and look at the picture). Write `WORK/survey/structure.md`: the chapters and sections with their first and last page, and which parts are front matter, back matter or appendices.

**S2. Every page, once.** `mcprep pages sheets --out "WORK/survey/pages" --per-sheet 8 --project "P"` draws overview pictures of 8 pages each (`overview-0001.png`, ... and
`overview.json`). Look at EVERY picture, in order, none skipped. They show structure, not small print: headings, boxes, numbered items, figures, two columns, answer keys; body text is at the
edge of readable, so NEVER take a label, a count or an answer from an overview picture (use `lines` and a close look for that); draw dense pages again larger (the answer key, tables:
`--scale 0.8 --per-sheet 6 --columns 3 --from N --to M`). For each
picture write ONE small file `WORK/survey/pages-0001.json` (its number) that says what each of its pages holds, as ranges of pages (zero-based, inclusive):
`[{"from": 16, "to": 17, "kind": "text"}, {"from": 18, "to": 19, "kind": "exercises", "note": "set 1.2, two columns"}]`.
`kind` is one of: `exercises` (the page holds an exercise or part of one: a set at the end of a section or chapter, or exercises inside the text), `answers` (answers or worked
solutions of exercises, and no exercise), `both` (exercises and answers on one page), `text` (exposition, worked examples, figures: no exercise of the book), `blank` (empty, a divider,
a picture only), `front` (title, copyright, preface, contents), `back` (index, bibliography, glossary, appendices that are neither exercises nor answers). Every page of the book gets
exactly one kind. `WORK/survey/` holds ONLY the survey record and your notes: every `.json` file in it is read as a survey record (the `note` of an entry is at most 120 characters, `mcprep schema survey`), so put line dumps, data files and scripts into `WORK/scratch/` and write your notes as `.md` files. An exercise is an item with a printed label (a number, a letter, `1.2`, `Exercise 3`) that the book asks the learner to solve, wherever it stands: at the end of a section,
in a chapter list, inside the text. An example the book works out for the reader is `text`; so is an item without a printed label (a "guided practice" or "try it" box): it is no exercise
of the bundle (the learner can frame it in the app), but write it into `layout.md` and the report. When a picture leaves you unsure about a page, look at that page at reading size (S3)
before you write it down. A book of 1,000 pages is 125 pictures: that is the work, do it.
The gate checks this record against your frames: a page you marked `exercises` that no exercise region touches stays open, and so does an exercise region on a page you marked `text`.

**S3. Close looks.** For each kind of exercise page you saw (the start of a set, the middle of a long set, two columns, parts a) b) c), a figure, an instruction printed above a group, a
boxed exercise, the first page of the answer key and a middle page of it, worked solutions in another chapter) draw one page at reading size and read its text:
`mcprep render PAGE --out "WORK/survey/look-PAGE.png" --project "P"` (look at the picture) and `mcprep lines PAGE --json --project "P"` (the exact text with its positions). Write
`WORK/survey/layout.md` in your own words: where the exercises stand (end of every section, end of a chapter, inside the text); how an exercise starts (its label exactly as printed:
`5.`, `5)`, `(5)`, `1.2`, `Exercise 1.2`, `Aufgabe 3`, a letter ...); how the numbers run (again in each set, on through a chapter, chapter-relative); what comes with an exercise (an
instruction printed once above a group and how far it reaches, parts, figures, tables, data notes, hints, marks of difficulty); where the answers are (in this PDF? for every exercise, only
the odd ones, selected ones, worked solutions elsewhere, none); two columns; exercises that run over a page; anything unusual. Numbered lines that are NOT exercises are the traps of a layout
(footnotes that a book collects at the end of a set and numbers on through the chapter, numbered steps of a method, references, the items of an answer key): name them in `layout.md`, so that
you never frame one. If some exercises carry no number, say how you will recognise them.

**S4. The census.** For every exercise set of the book write one line into `WORK/survey/census.md`: the section (its id), the pages, the first and the last label, how many exercises the
set has (count the labels the book prints; a gap in the numbering is yours to explain), and where its answers are. The sum is what the book prints. With a reference list, compare section by
section: a difference needs the page that explains it. Count with the help of `mcprep exercises census --details "WORK/survey/runs.json" --project "P"` (every run of numbered items the
text layer shows, whether the project covers it or not: a pointer for you, never the answer) and of a script of your own over `mcprep lines` of the pages you marked, when the layout is
regular. Check the census against your pages: every page you marked `exercises` or `answers` belongs to a set or to an answer key of the census, and every run the census command lists is a
set of yours or explained (a bibliography, the steps of a method, a list in the exposition).

**S5. The plan.** Write `WORK/survey/plan.md`: how you will produce the exercises. (a) A draft from `exercises propose`, which you may use only for the sets whose labels and counts it
reproduces exactly (check three of them against the pages); for many layouts it reads nothing, and (b) is then the normal way. (b) A script of your own that reads the lines of the pages and writes one batch file: the sensible way for a regular layout
(section 9). (c) By hand with `exercises add` for what is left. Whatever you choose, the census is the target: at the end of Phase A the project holds exactly the exercises of the census.

## 2. Phase A: the sections and the exercises (A3 to A9; A1 and A2 are in section 1A)

**A3. What the book says about itself.** One call, only the options you know, in this order: author, series, description, licence name,
licence address, source address, notice:
`mcprep book meta --author "..." --license-name "..." --license-url "..." --source-url "..." --notice "..." --project "P"`.
Take them from the sidecar. For a fact the sidecar does not give (it may hold only a title and a folder), and without a sidecar, read the text of the first four pages, always these four calls in this order and no others: `mcprep lines 0
--pdf "PDF"`, `mcprep lines 1 --pdf "PDF"`, `mcprep lines 2 --pdf "PDF"`, `mcprep lines 3 --pdf "PDF"`, and use only what they say in so many words (an author after
"by" or a copyright line, a Creative Commons or other licence line, a web address), never anything from memory. Nothing found: skip the `book meta` call.

**A4. Look at the sections.** `mcprep outline derive --book [OPTIONS] --project "P"` without `--apply`; OPTIONS are the sidecar's `options` as flags
(`--chapter-words`, `--practice-words`, `--answer-words`). Read the table (confidence, practice set) and the notes, not the count in the first line: it counts what the tool found, also when it fell back to
the generic heading detection (the note under the table says so), and that draft can hold title lines, author lines and the lines of the printed contents as "sections".
- Sections found = 0: the book prints no numbered sections. Try `mcprep outline pdf --adopt --project "P"` then `mcprep outline ids --project "P"`
  (the PDF's own bookmarks); if the PDF has none, `mcprep outline add --title "TITLE" --page 0 --depth 0 --id all --project "P"` (one section for the
  whole book). Say which you did in the report, and go on at A6.
- Otherwise every note and every entry with confidence below 0.9 goes into the report.

**A5. Store the sections.** The same call with `--apply`. Then compare the sections with your census: every exercise set of the census needs a section that its exercises can be filed under. When
the book heads a set with a heading the contents do not list (the contents print "Chapter review", the page heads its set "1.4 Exercises"), add that heading as a section yourself, with the number
the book prints: `mcprep outline add --title "Exercises" --label "1.4" --id 1.4 --page P --top T --depth 1 --at POSITION --project "P"` (`--top` is where the heading starts on its page, from
`mcprep lines`; `--at` keeps the outline in reading order: `mcprep outline` lists the positions). A section the book prints in its pages is a section; one the book does not print is not: delete what the draft stored and the book does not print (`mcprep outline delete ID`, or `mcprep outline delete --index N` for an entry that has no id), correct depth, title, page, label or id of the rest (`mcprep outline update ID --depth D --page P --label L --new-id ID2`; sibling headings need the same depth), and compare the outline with the printed contents and with your `structure.md` before you go on.

**A6. Frame the exercises, as your plan says (S5); the census is the target.**
- (a) A draft: `mcprep exercises propose --solutions [OPTIONS] --details "WORK/propose.json" --project "P"` without `--apply` (add `--max-items N` only when the sidecar says
  `maxItems`). Read the first line and the table. Use it only for the sets whose labels and counts equal your census. Where it finds nothing, or another count, the draft is wrong for
  that set and you frame that set yourself (b or c); the layout ladder (section 8) may help the draft to read more. Never conclude that a book has fewer exercises because the draft
  found fewer, and never report "the tool found nothing".
- (b) Your own script (section 9). (c) By hand, `exercises add` (section 9).

**A7. Store them.** A draft: the same call with `--apply`, then look at three of its sets in the crops (`mcprep crop SECTION:LABEL`). Read what it says about exercises it did not take
("rejected", "put aside", "gaps"): each is yours to decide, and they go into the report. A script: apply its batch file (section 9). Then count: the exercises of every set of the project must
equal the census. Write the comparison into `WORK/survey/census-check.md` (set, census, project) and repair every difference before you go on.

**A8. Validate.** `mcprep validate --project "P"`. Errors: STOP `VALIDATION` after reading each `fix` and repairing it (section 7), then validate again.

**A9. First look.** `mcprep exercises verify PATTERNS --details "WORK/verify.json" --project "P"`; note errors, warnings and infos in `progress.md`.

## 3. Phase B: the gate loop

**B1.** `mcprep audit gate PATTERNS --survey "WORK/survey" [--reference "REF" [--chapter-offset N]] --project "P"` (this is `GATE` of section 1; the pixel check of the edges, which finds a region that cuts a letter, a line of a figure or the border of a box, is part of every gate call: never add `--no-ink`). It lists what is **open** (neither repaired nor acknowledged), grouped by code, and exits 0 only
when nothing is open.

**B2.** Work through the open findings **by code, in the order of the table in section 7**. For each finding: look at it (`mcprep crop SECTION:LABEL
--out "WORK/look.png"` shows the exercise, `mcprep crop SECTION:LABEL --region solution:0` its answer, `mcprep lines PAGE --json` the text with
coordinates), apply the recipe of its code, then check: `mcprep exercises verify PATTERNS --section SECTION --project "P"` shows the finding gone and no
new one. Repair all findings of one code before the next code.

**B3. Acknowledging.** Only a finding that is a fact of the book may be acknowledged: a number printed twice, an answer missing from the key, a practice set
with more exercises than the reference lists, a remark printed between two exercises, a figure printed as an exercise. **Never a defect of ours.** These
findings cannot be acknowledged at all and `audit ack` refuses them: `label-not-first`, `solution-label-missing`, `overlap`, `duplicate-region`,
`section-unknown`, `section-page`, `span-gap`, `continuation-order`, `context-range`, `context-missing`, `context-inconsistent`, `context-not-nearest`,
`solution-section-mismatch`, `region-holds-item`, `survey-missing`, `survey-overlap`, `survey-range`, `survey-uncovered`, `survey-unmarked`; repair them. For the others:
`mcprep audit ack --code CODE --ref REF --page N --quote "TEXT" --reason "SENTENCE" --by "ME" PATTERNS --survey "WORK/survey" [--reference "REF" ...] --project "P"`, where `--page` is the zero-based page of the finding,
`--quote` (4 to 60 characters) is a piece of the text printed on that page (copy it from `mcprep lines N`; a piece of the finding's own message is refused), and
`--reason` says in your own words what the book prints and where (at least ten characters, not the text of the finding). A note for a whole section needs
`--count N`. You cannot confirm your own notes: they stay `confirmed: false` until somebody with another name runs `audit confirm` (Phase D).

**B4.** Run the gate again. Passed: Phase C. Open findings: repeat from B2. If two rounds in a row leave the number of open findings unchanged:
STOP `STUCK` and report the findings and what you tried.

## 4. Phase C: the exhaustive look, written down

The text checks cannot see everything; you do, and what you saw is recorded exercise by exercise so that it can be checked. **This phase is not optional and nothing may be
skipped, however many exercises there are**: the work is long on purpose, one sheet after the other. A run that stops before the visual record is complete is NOT FINISHED
(section 10), never "passed". If you cannot look at images, say so and stop here (below).

**C1. Draw.** `mcprep exercises sheets --out "WORK/sheets" --solutions --per-sheet 6 --project "P"` writes contact sheets of **every** exercise in book order,
each cell with its instruction (blue), its own region (red), its continuation (orange) and its answer (green), and `sheets.json`; a sheet is closed before it
gets too tall to read, so there may be more than the number of exercises divided by 6. A book of 2,400 exercises (about 400 sheets) takes about a minute and a half and 90 MB; a
gate call on the largest book takes about 20 seconds. If your shell stops commands sooner, run the call in the background or with a longer timeout.

**C2. Look and write the visual record, one sheet at a time.** Open the sheets one after the other, none skipped. For sheet N (the references of its cells are listed in
`WORK/sheets/sheets.json`): look at it, write ONE small file `WORK/visual/sheet-NNN.json` (three digits, `sheet-001.json`) that holds a JSON list with one entry for each cell of that
sheet, append `C2 sheet N done` to `WORK/progress.md`, and go on to the next sheet. A folder of small files keeps every write short and lets a run be resumed; the format is
`mcprep schema visual`. An entry:
`{"ref": "SECTION:LABEL", "startsWith": "<the first three words printed after the number, as you read them in the cell>", "instruction": true|false,
"answerStartsWith": "<the number at the start of the green box without brackets or dots (1 for [1] or 1.), or empty>", "ok": true|false, "defect": "<CODE or a word, only when ok is false>"}`.
Write **what the cell shows, not what you expect**: a cell without a blue box is `"instruction": false`. A cell is `ok` only when you can see the label at the top of the
exercise, the whole statement, no line cut in half, nothing of the next exercise, the right instruction, the whole continuation, and an answer that starts with the label
of its exercise, is whole and holds nothing of the next answer. Defect words: CUT-TOP, CUT-BOTTOM, SWALLOWS-NEXT, MISSING-PART, EXTRA-TEXT, WRONG-INSTRUCTION,
MISSING-INSTRUCTION, LABEL, ANSWER-CUT, ANSWER-WRONG, ANSWER-MISSING, ANSWER-EXTRA, OTHER.

**C3. Repair** every entry with `ok: false` with section 7, draw its sheet again (`mcprep exercises sheets --out "WORK/sheets" --solutions --per-sheet 6 --sheet N
--project "P"`), look at it, and change its entry (in the file of its sheet) to what the cell shows now.

**C4. The gate with the record.** List the sheets you looked at in `WORK/sheets/seen.txt` (for example `1-36`), then
`mcprep audit gate PATTERNS --survey "WORK/survey" [--reference "REF" ...] --sheets-seen "WORK/sheets/seen.txt" --visual "WORK/visual" --project "P"`. An exercise without an entry is `visual-missing` (it names the sheets whose exercises have none); an entry that does not fit the project is
`visual-mismatch` (the cell was not looked at, or the exercise changed): look again. A record with `ok: false` is `visual-defect`. Neither can be acknowledged.

An agent that cannot look at images does Phase B only, says so in the report ("no visual pass: the model cannot see images"), and the certificate shows that the
visual record is missing; a person or another agent then finishes Phase C with the "second pair of eyes" prompt.

## 5. Phase D: certificate, review, export, report

1. `mcprep audit gate PATTERNS --survey "WORK/survey" [--reference "REF" ...] --sheets-seen "WORK/sheets/seen.txt" --visual "WORK/visual" --final --project "P"`. Exit 0: the book is **perfect**. Exit 4 with only
   `unconfirmed` left: go on at 2. Anything else open (a missing survey or visual record included): back to Phase S, B or C. Without Phase S and Phase C the book is not finished: do not report it as passed.
2. Acknowledgements (if any): `mcprep audit review --out "WORK/review" PATTERNS --survey "WORK/survey" [--reference "REF" ...] --project "P"` writes a picture, the reason and the quote of each one and `index.md`. You stop
   here for them: **somebody with another name** looks at each and runs `mcprep audit confirm --by NAME --all` (or `--ref REF --code CODE`), then `--final` is run again.
3. `mcprep export --out "BUNDLE" --project "P"`; it says whether the certificate is current and how many acknowledgements are not yet confirmed. A later change makes the
   certificate stale: run the gate again.
4. `mcprep import-check "BUNDLE"` must say it would accept the bundle.
5. `mcprep book export --out "WORK/NAME.book.json" --project "P"`.
6. Write the report (section 10) as `WORK/report.md` and as your final message. Make no further call after the export, the import check and the book export.

## 6. The geometry you need for repairs

Coordinates are fractions of the page as displayed, origin top-left, `left,top,right,bottom`. Read the text of a page with `mcprep lines PAGE --json
--project "P"`: every line has its box. For the region of one exercise use exactly these formulas, then `--snap`:

- `left` = the smallest left of the lines of the exercise itself (not of a heading above it that stands further left) minus 0.01; `right` = the largest right plus 0.01;
- `top` = the top of its first line minus 0.004 (a tall letter, a box border or a bracket reaches above the box of the text line; the edge must lie in white, the gate says whether it does);
- `bottom` = the smaller of (the top of the next label, instruction or heading in the same column minus 0.004) and (the bottom of its own last line plus
  0.006); never below its own last line;
- a figure or a tall formula (a matrix, a fraction) that stands above or below the line: take the whole figure, then run `mcprep audit gate` (an edge must lie in white);
- a box drawn round the exercise: the pixel check accepts a region that holds the border whole or none of it, and cuts it in between. Take the box whole (every edge just outside its border, in white,
  as the gate names the position), and when text runs out of the box take the whole box and the overflow;
- the instruction printed once above a group: its lines the same way, attached with `--context`; the regions of a neighbour that already has it:
  `mcprep exercises list --section S --regions --project "P"` prints them as `page:left,top,right,bottom`: copy them (`mcprep context add REF --page P --rect l,t,r,b`
  for each region);
- a statement that goes on in the next column or on the next page: `--continues PAGE:l,t,r,b` for each further region, in reading order, at most 8; the
  regions of a page start under the running header and end above the next label.

## 7. Repair recipes (one row per finding code)

Order: errors first, in this order. `REF` is `SECTION:LABEL`. After each repair: `mcprep exercises verify PATTERNS --section SECTION`. "Acknowledge" means B3.

| Code | Severity | What it means | What to do |
| --- | --- | --- | --- |
| `label-not-first` | error | the region does not start with its number (the left edge may cut it) | Look at the crop. The region starts at the wrong line or its left edge cuts the number: `mcprep frames update REF --rect l,t,r,b --snap` with `top` = the top of the label line minus 0.004 and `left` as in section 6. |
| `solution-label-missing` | error | the answer region does not start with the label of its exercise | Look at `crop REF --region solution:0`. Wrong answer: `mcprep solution clear REF` then `mcprep solution add REF --page N --rect l,t,r,b --snap` for the answer that starts with the label (several regions for an answer over a break). A heading that stands before the label ("Solution 5") needs `--item-pattern` (section 8), not a repair. |
| `overlap`, `duplicate-region` | error | two exercises lie on each other, or are the same region | Shrink the one that swallows the other: `frames update` with `bottom` = the top of the next label minus 0.004. The same region twice: one of them is the wrong exercise: `frames delete` it and add the missing one with `exercises add`. |
| `section-unknown`, `section-page` | error | the section id does not exist, or the page lies outside the section | `mcprep exercises section REF NEWSECTION` (an outline id; `mcprep outline` lists them), or fix the outline entry (`outline update ID --page N`). |
| `duplicate` | error | two exercises of a section have the same label | Find both on the pages. A different item with the same printed number (a figure, a part): `mcprep exercises label REF NEWLABEL` with the printed label or `frames delete`. The book prints the number twice: acknowledge. |
| `span-gap`, `continuation-order` | error | a span skips text, or its regions are not in reading order | `mcprep continues remove REF --all`, then `continues add REF --page N --rect l,t,r,b` for each page in order. |
| `numbered-text-left-behind` | error | a numbered line lies outside every region: a missed exercise or part | Look at the page. A missed exercise: `mcprep exercises add --section S --label L --page N --rect l,t,r,b --snap --context P:l,t,r,b --solution P:l,t,r,b` (give the instruction of its neighbours: section 6; the answer: the line of the key that starts with the label). A part that the exercise above lacks: extend its region or `continues add`. A number that is not an item (a year, a figure number): acknowledge. |
| `answer-left-behind` | error | a numbered line of the answer key belongs to no exercise | The exercise is missing (add it) or the label was misread (`exercises label`) or the book prints an answer for an exercise it does not print: acknowledge. |
| `context-range`, `context-missing`, `context-inconsistent`, `context-not-nearest` | error or warning | an instruction names a range that an exercise lies outside of, or an exercise lacks the instruction its neighbours share, or has another one | Never acknowledge. Copy the instruction regions of the neighbour (`exercises list --section S --regions`), `mcprep context remove REF --all` if a wrong one is there, then `mcprep context add REF --page P --rect l,t,r,b` for each region. |
| `solution-section-mismatch` | error | the answer lies under the marker of another section | Remove and add the right answer (`solution clear`, `solution add`) from the key band of the exercise's section. |
| `region-holds-item` | error | a region contains the line that starts another exercise | Shrink it as for `overlap`. |
| `visual-mismatch`, `visual-missing`, `visual-defect`, `sheets-*` | error | the visual record does not fit the project or says a cell is wrong | Look at that cell again, repair what is wrong, draw its sheet again, write the entry as the cell shows now. Never acknowledged. |
| `survey-missing`, `survey-overlap`, `survey-range` | error | the survey record (`--survey`) leaves pages without an entry (one finding names the first ranges), gives a page two entries, or has an entry that is not in the format (from after to, outside the book, an unknown kind) | Never acknowledged. Correct the record, not the project: every page has exactly one entry `{"from": F, "to": T, "kind": K}` (zero-based, inclusive; kind is exercises, answers, both, text, blank, front or back). `survey-missing`: look at the pages named and write an entry for each range; `survey-overlap`: shorten one of the two entries named; `survey-range`: correct the entry named (`mcprep schema survey`). |
| `survey-uncovered` | error | the survey record marks a page as exercises or both (answers or both) and no exercise region (no solution region) touches it | Never acknowledged. Look at the page (`mcprep render PAGE`, `mcprep lines PAGE --json`). It holds exercises that were not framed: `mcprep exercises add ...` (answers: `mcprep solution add ...`). It holds none: correct the kind of its entry in the record. |
| `survey-unmarked` | error | an exercise region (a solution region) touches a page that the survey record marks as holding none (text, blank, front, back or answers; text, blank, front, back or exercises) | Never acknowledged. Look at the page (`mcprep render PAGE --frames --solutions`). It does hold exercises (answers): change the kind of its entry in the record. A frame (a solution region) lies on a page that holds none: `mcprep frames update` it onto its text or `mcprep frames delete` it (`mcprep solution remove`). |
| `no-text` | warning | the region holds no text (a picture or a scan) | Look at the crop. A figure-only exercise is what the book prints: acknowledge. Otherwise the region is in the wrong place: repair it. |
| `region-size` | warning | the region is very tall, narrow or small | Look at the crop. A short item is legal: acknowledge. An exercise that stands alone on its page and is tall because of a figure, a table or fields to fill in is legal too: acknowledge it, with the page and a quote of its label. A region that holds more than one exercise: shrink it. |
| `gap` | warning | numbers are missing between the first and the last | Search the pages for the missing label (`mcprep lines PAGE --json`). Printed but not framed: `exercises add`. Not printed: acknowledge, with the page where the numbers jump. |
| `order`, `label-outlier` | warning | a label is out of order in its column, or very large | A misread label: `exercises label REF NEWLABEL`. Otherwise acknowledge what the book prints. |
| `no-solution` | info or warning | a section has no answers at all, or too few | List the exercises without an answer (`mcprep exercises list --without-solution --section S`). For each: look for its answer in the key. Printed: `solution add`. Not printed (a key of selected answers): acknowledge with `--count`. |
| `text-left-behind` | warning | text of the exercise zone lies outside every region | Find the exercise above it: extend its region (`frames update`) or `continues add`; or the text is a heading or remark of the book: acknowledge. A running head that changes with the chapter (the tools know only the ones that repeat on many pages) or an imprint page is such a case: one note for each finding, the quote is the head itself. A set that stands in the middle of a chapter, with body text on the pages after it (the tool counts those pages to the zone of the set), is such a case too: one note for each page, reason "the chapter goes on after its set", the quote a piece of that body text. |
| `answer-clipped` | warning | an answer goes on below or beside its region | Extend the answer's region (`solution remove REF --index I` then `solution add`) or add a region for the rest. |
| `context-overlaps-frame` | warning | an instruction region touches an exercise | Move the instruction's region off the exercise (`context remove` and `context add` with the formulas of section 6); a context shared by several exercises is attached to each. |
| `continuation-limit` | warning | an exercise already holds 8 continuation regions and text follows | The book spans more than the format allows: acknowledge with the pages; do not cut the exercise. |
| `solution-order` | warning | answers of a section are not in the order of their labels | Usually a column layout: look at the crops; acknowledge when the key prints them that way. |
| `edge-on-ink` | warning | a region edge cuts printed ink | The message names the position: "Move it to y=0.5123 (4 pixels, 2 points up)" (`x=` for a left or right edge). `frames update REF --rect ...` with that edge changed; a `solution`, `context` or `continues` region (the message says `solution:1`) is removed and added again with the new rectangle. It names none when no position within 3 points keeps the text of the region and runs into no other exercise: then look at the crop (`crop REF`); a hint "the nearest clear position outwards is ..." says where the figure or formula ends: take the whole of it into the region when it belongs to this exercise. When no rectangle can keep it whole (the figure of the exercise above reaches the label of this one), acknowledge it with the reason (what the book prints, and where); a section with several such hangs takes ONE note for the section, `--ref SECTION --count N` (N = the number of `edge-on-ink` findings the gate lists for that section), with the page and a quote of the first one. Run `audit gate` again. |
| `region-open-end` | warning | text goes on directly below the region of an inline exercise | The exercise is longer than its region: extend `bottom` (or add a continuation) so that the region ends where its text ends. |
| `stray-frame` | warning | an ordinary frame lies in the audited book | Look at it; delete it (`frames delete ID`) unless the book needs it. |
| `numbered-run-uncovered` | warning | five or more items numbered one after the other lie outside every exercise, instruction and answer region (REF is the id of the run, `p32:8`): an exercise set, an answer key or another list that nobody framed | `mcprep exercises census --uncovered --project "P"` lists the runs; look at the first page of the run (`mcprep render PAGE`, `mcprep lines PAGE --json`). An exercise set: frame it (`mcprep exercises add ...` for each exercise or one batch file as in section 9; the outline needs a section for it); this is what a layout that the finder does not read leaves behind. An answer key: `mcprep solution add REF ...` for each answer. A numbered list that the book prints and that is neither (a bibliography, the steps of a method, worked examples, footnotes): acknowledge with the page and a quote of the list (`mcprep audit ack --code numbered-run-uncovered --ref RUN_ID --page N --quote "..." --reason "..."`). |
| `reference-count`, `reference-missing`, `reference-extra`, `reference-title` | warning | the audited sections or counts differ from the reference | `mcprep book compare REF --details "WORK/compare.json"`. For each: count the printed exercises on the pages. Missed: add. The book prints more or fewer than the reference lists: acknowledge with `--count 1` and the reason (the printed number and the page). |
| `non-numeric-label`, `inline-section`, `solution-no-text`, `edge-interlocked` | info | for your information (`edge-interlocked`: only tips of the next line touch the edge, no rectangle can do better; the certificate lists them) | Nothing. |

## 8. The layout ladder (helps the draft of A6 to read more)

Only for the draft. Try these in order, each time repeating A6 (without `--apply`), and stop at the first that reproduces your census for the sets you want it to read. Write the option
you used into `WORK/progress.md` and the report. When none reads a set exactly, that is not a result: frame the set yourself (section 9).

1. `--practice-words "WORD1,WORD2"` with the words the book prints in its practice headings (for example `exercises,problems`, `review questions`, `aufgaben`).
2. `--item-pattern "REGEX"` (group 1 is the label) for a label that is not `5.`, `5)`, `(5)`, `5a)`: for example `"^([A-Z]\.\d+)\s+(.*)$"`, or `"^(\d+\.\d+\.\d+)\s+Aufgabe"`
   for a three-level number followed by a keyword. For an answer heading with the keyword first (`Solution 1.2.3`) the pattern `"^Solution\s+(\d+(?:\.\d+)*)"`
   is also given to `verify` and `gate` (they take the same `--item-pattern`; write it into `PATTERNS`). A pattern with letters outside ASCII goes into a UTF-8 file:
   `--item-pattern-file FILE`.
3. `--answer-words "WORD,..."` for the words that open the answer key.
4. `--instructions margin` or `none` when the instructions are not set in bold.
5. A keyword in front of the number with no practice heading above it (`Aufgabe 1.3 (Title).`, `Exercise 4.2.`), for example in an exercise booklet that prints one
   exercise to a page: no option reads it. Manual mode (section 9).

## 9. Your own framing: a script or by hand (any layout)

This is the way that always works, and the one to use for every set that the draft does not reproduce exactly, whatever the layout. When the book repeats one
regular shape (one exercise to a page, a keyword in front of every number, a box with a margin heading), a short script is the sensible way: read each page with `mcprep lines PAGE --json`, apply
the formulas of section 6 (a figure or a table has no text lines: the region runs to the last ink of the page, and an edge must lie in a white row, which
the gate checks), write the ONE batch file below and apply it. Say in the report (heading Layout) which rule the script used. Small sets can be framed one by one with `exercises add`.

1. The pages of the set and its label scheme are in your census and your `layout.md`.
2. For each page: `mcprep lines PAGE --json --project "P"`. An exercise starts at a line whose text starts with the label pattern of the book.
3. Region of one exercise: section 6. Write all the exercises of a section as ONE batch file `WORK/batch-SECTION.json`: `{"operations": [{"op": "add",
   "authority": "book", "section": "S", "label": "5", "page": 12, "rect": {"left": .., "top": .., "right": .., "bottom": ..}, "snap": true, "context":
   [...], "continues": [...], "solution": [...]}, ...]}`, then `mcprep frames apply "WORK/batch-SECTION.json" --project "P"` (atomic: one failure writes nothing).
4. Answers: the line of the key that starts with the label, in the band of the same section (its marker or heading above it); the same region formulas.
5. `validate`, then Phase B: the gate checks what you made exactly as it checks the automatic result.

## 10. The report (always these headings, in this order)

1. **Book**: title, PDF path, SHA-256 (`mcprep import-check --json "BUNDLE"`, `document.sha256`), pages, text layer (pages without), licence/author/notice stated or not.
2. **Result**, exactly one of: `PERFECT` (`audit gate --final` exit 0); `PASSED, awaiting confirmation of N acknowledgements` (everything else done, only `unconfirmed` is left);
   `NOT FINISHED` followed by what is missing (for example the visual pass: say how many of the exercises have an entry); the STOP code. No other wording. Then: chapters,
   sections, exercises, exercises with an answer; the gate certificate path.
3. **Layout**: how the book prints exercises and answers in one or two sentences; the options used (section 8) or `defaults`; whether a script or hand framing was used, for which sets.
4. **Survey**: the overview pictures you looked at (`N of N`) and the pages you looked at at reading size (list them); the census (sets, exercises in all) against the reference; what the
   draft of A6 found and which sets of it you used, how you checked them and what it got wrong; any set you found that the draft did not read.
5. **Findings**: a table: code, number found, number repaired, number acknowledged; then each acknowledgement (ref, page, quote, reason) and the path of `WORK/review/index.md`.
6. **Visual pass**: the entries of the record (`N of N exercises`), how many were `ok: false` and repaired, or `not done` with the reason; the model that looked.
7. **Reference**: `book compare` totals, every difference and its explanation.
8. **What I did not do**: everything left open, every step skipped.
9. **Files**: the bundle, the project, the book summary, the report, the gate certificate, the survey record and notes, the visual record, the review folder.

## 11. Never (read this again before you finish)

Do not use `--force`. Do not acknowledge a defect of ours, and do not confirm your own acknowledgement. Do not invent an exercise, a number or an answer; do not renumber.
Do not edit the project file by hand. Do not hide a finding: every finding is repaired or acknowledged with a page. Do not write the visual record or the survey record from what you
expect: write what the picture shows. Do not trust a draft you did not check against the pages, and never report "the tool found nothing": a book with no exercise is a result only when your
survey record covers every page and you can name the pages that show it (a book of notes that prints no exercise). Do not stop early because the work is long: the gate is the definition of
done. Do not send anything of the book anywhere except to the model that runs you.

## 12. MCP tool names

| Step | CLI | MCP tool |
| --- | --- | --- |
| A1 | `init` | `create_project` |
| A2 | `info --full-text` | `project_info` (`full_text: true`) |
| S1 | `outline pdf`, `outline derive --book` (without `--apply`) | `get_outline` (the PDF's own bookmarks when the project has none), `outline_derive_book` |
| S2 | `pages sheets` | `pages_sheets` |
| S4 | `exercises census` | `exercises_census` |
| A3 | `book meta` | `book_meta` |
| A4, A5 | `outline derive --book [--apply]` | `outline_derive_book` |
| A6, A7 | `exercises propose --solutions [--apply]` | `exercises_propose` |
| A8 | `validate` | `validate` |
| A9, B2 | `exercises verify` | `exercises_verify` |
| census | `exercises census [--uncovered]` | `exercises_census` (`uncovered: true`) |
| B1, C4, D1 | `audit gate` | `audit_gate` |
| B3 | `audit ack` | `audit_ack` |
| D2 | `audit review`, `audit confirm` | `audit_review`, `audit_confirm` |
| reference | `book compare` | `book_compare` |
| C1 | `exercises sheets` | `exercises_sheets` |
| neighbours | `exercises list --regions` | `exercises_list` (`regions: true`) |
| look | `crop`, `lines`, `render` | `render_crop`, `get_page_lines`, `render_page` |
| repairs | `frames update`, `context add/remove`, `continues add/remove`, `solution add/remove/clear`, `exercises add/label/section`, `frames apply` | `update_frame`, `add_context`, `remove_context`, `add_continuation`, `remove_continuation`, `solution_add`, `solution_remove`, `exercises_add`, `exercises_label`, `exercises_section`, `apply_operations` |
| D3, D4, D5 | `export`, `import-check`, `book export` | `export_bundle`, `import_check`, `book_export` |
