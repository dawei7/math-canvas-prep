# Auditing a book as an authority

A textbook with a free licence can be audited **once**, on a computer, and then be offered to many learners: its exercises keep the
numbers the book prints (`1`, `5a`, `A.3`), they cannot be edited or renumbered on the tablet, the instruction printed for a group of
exercises is shown with each of them, and the answer key printed in the same PDF is hidden **solution context** that only the grader
sees. The bundle also carries the book's contents as sections. The contract is [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) (section 3,
"Authoritative exercises" and "Solution context", and section 4); the commands are listed in [CLI.md](CLI.md), the same tools for an agent in
[MCP.md](MCP.md); [AGENT_GUIDE.md](AGENT_GUIDE.md) explains how frames are drawn and checked (chapter 14 is the manual way to audit a
book exercise by exercise, section 6 how the proposals below work).

The tool **proposes**, you **look**. What the book prints is what is proposed: a number that is printed twice, an answer that is
missing, a practice set with more exercises than the contents promise are findings for the owner of the audit, not something to hide.
Nothing leaves the machine; do not upload the PDF anywhere.

## What the tool finds

| Step | Command | Finds |
| --- | --- | --- |
| 1 | `outline derive --book` | Chapters (`c0`, label "Chapter 0") and sections (`0.1`, label `0.1`) from the printed contents, the lists on the chapter openers and the headings, with title, page, `top`, confidence, evidence, the differences between the spellings, and where each practice set lies. |
| 2 | `exercises propose` | The numbered exercises of every practice set: label as printed, section, frame, the instruction as context, optionally the solution regions. |
| 3 | `solutions propose` | The answers in the answer key, matched by (section, label); exercises without an answer and answers without an exercise. |
| 4 | `exercises verify` | A text-only check of what the steps above stored: regions that do not start with their number, answer regions that hold another number, regions that lie on each other, numbers that are missing, repeated or out of order. The same list for every agent; see below. |
| 5 | `exercises sample` | A fixed sample of exercises and answers to look at, chosen by rules without randomness: the first and the last exercise of every section, every kind of layout the book has, a spread of the rest. The same for every agent; see below. |

The desktop app does the same three steps with a review before anything is applied (**Derive sections** in the Sections panel,
**Book exercises** and **Solutions** in the Propose panel): the same search, each proposal shown against what the project has, one
atomic and undoable batch, and it can be run again. See [DESKTOP.md](DESKTOP.md).

None of them writes anything without `--apply`; `--ops FILE` writes the operations (for `frames apply`) and `--details FILE` writes every
proposal with its evidence. What `--apply` writes is what every other command writes: one atomic batch of the project operations
(`add` with `"authority": "book"`, `label`, `section`, `context`, `solution`; `solution.set` named `SECTION:LABEL`), validated as a whole.

## The workflow for a person

```console
mcprep init book.pdf --title "Beginning Algebra" --folder "Books/Algebra"
mcprep book meta --author "A. Author" --license-name "CC BY 3.0" --license-url https://creativecommons.org/licenses/by/3.0/ \
  --source-url https://example.org/the-book --notice "Beginning Algebra by A. Author, licensed under CC BY 3.0. ..."
mcprep outline derive --book                       # 1. read the table and the notes under it
mcprep outline derive --book --apply               #    store the sections (they carry ids; exercises refer to them)
mcprep exercises propose                           # 2. one line per section; read "To look at" first
mcprep exercises propose --solutions --ops audit.json --details audit-details.json
mcprep exercises propose --solutions --apply       #    one atomic batch; it can be run again (see below)
mcprep solutions propose                           # 3. only for answers that step 2 did not match
mcprep exercises verify --details verify.json      # 4. a text-only check: fix every error, run it again
mcprep exercises sample --crops sample/            #    the fixed sample to look at, with its crops
mcprep validate && mcprep book show                #    zero errors; the counts per section next to the book's own
mcprep export --out book.mcbundle && mcprep import-check book.mcbundle
```

1. **Sections.** Check chapter and section counts against the printed contents, the titles (are typos repaired, is "&" read as "and"),
   the pages, and every line under "To look at". A title you want worded differently: `mcprep outline --json`, edit the entries,
   `mcprep outline set entries.json` (keep `id`, `label` and `top`). The bundle's contents are what the learner sees.
   `outline derive --book --apply` replaces the outline the project had; exercises keep their sections as long as the ids stay.
2. **Exercises.** Per section the table shows how many exercises were found and the first and last number. Compare with the book:
   a gap (`no line starts with the number 24`), a duplicate, a stray number put aside and a count that differs from what you expected
   are listed with the reason. Then look at a sample (below). `--max-items N` caps every section when the book prints more than the
   audit wants; `--section 1.7` proposes one section.
3. **Solutions.** The table shows answers per section. "No answer for the exercises ..." and "answers ... have no exercise" are findings:
   a book can print fewer answers than exercises. An exercise whose answer is printed but not found is worth a look at the page.
4. **Check, then look.** First `mcprep exercises verify` (below): it needs no images, and every error it lists is a defect to fix
   (`mcprep crop SECTION:LABEL` shows it) before anything else; read the warnings and be able to say why you keep each one. Then look
   at the fixed sample, `mcprep exercises sample` (below). `mcprep crop 0.1:5` writes a PNG of an exercise (named by section and
   label), `--region context:0` of its instruction, `--region continues:0` of the part on the next page, `--region solution:0` of its
   answer; `mcprep crop --all --section 0.1` does a whole section; `mcprep render 9 --frames --solutions --grid 0.1` shows a page with
   its frames. What to look at: the first and the last exercise of every section; an exercise beside a figure and a graph answer; an
   exercise at the end of a page and one that goes on over the page break; an instruction that crosses a page break; a two-column row
   with fractions; a three-column row; a root; an answer of several lines; the last answer before the next chapter's heading; every
   item the commands marked with a confidence below 0.8. The sample names most of these for you.
5. **Fix** what is wrong with the usual operations: `frames update 0.1:5 --rect l,t,r,b` for a rectangle, `context.set`,
   `solution.set` (the whole answer of an exercise), `frames delete`, `exercises add --replace` for an exercise that the proposal
   missed or framed badly. Then look again.
6. **Validate and export.** `validate` must be clean of errors; `export` verifies the bundle with the importer's own checks and
   `import-check` shows what the app would do with it. The licence's attribution travels with the bundle (`book meta`).

Record the decisions you take (a cap, a number you accepted, an exercise you framed by hand) next to the bundle.

### Running it again

Exercises are identified by their section and label, so the commands can be run again and again, after a fix or with other words:

- an exercise the project already has **exactly as proposed** is skipped;
- one that has the same frame but **no answer yet** gets the answer found now (`exercises propose --solutions` after a run without it, or
  `solutions propose`);
- one that **differs** (you corrected the frame, or the proposal changed) is **kept** and listed under `changed`; `--replace`
  overwrites it in place and it keeps its id (the instruction is replaced even when there is none now, the answer only when one was found);
- an exercise the project has in a proposed section that the proposal does not contain is listed under `notProposed` and never deleted;
- `--dry-run` runs the whole batch and its validation and writes nothing; `--force` writes a batch even if it introduces validation
  errors (almost never what you want).

## Checking without looking: `exercises verify`

`mcprep exercises verify` (MCP tool `exercises_verify`) reads the project that is stored on disk and the text layer of its PDF (no
pixels, no network) and reports what a person would find by looking at the crops: an exercise whose region does not start with its
number, an answer region that holds another number, regions that lie on each other, numbers that are missing, printed twice or out
of order. It exists so that any agent, whatever model it is and whether or not it can look at images, gets the **same list** for the
same project and takes the same decisions from it.

```console
mcprep exercises verify                          # a table of the sections, then every finding
mcprep exercises verify --section 1.2 --section 1.3
mcprep exercises verify --details verify.json    # the whole report as JSON (format math-canvas-verify, `mcprep schema verify`)
mcprep exercises verify --fail-on warning        # exit code 4 for a warning or an error (default: error; none: always 0)
```

The findings come in a fixed order: errors, then warnings, then infos; within one severity by code, in the order of the table below;
then in the order of the book (the sections as the outline lists them, the exercises in reading order). The order of the frames in
the file does not matter. A finding is `{ code, severity, ref, page, message, evidence }`: `ref` is `SECTION:LABEL` (the section id alone
for a finding about a whole section, the frame id for an exercise a person framed), `page` is the zero-based page to look at,
`evidence` is what was found (the first 40 characters of the text, the numbers that were measured). The report also has `summary`
(the counts) and `sections` (for each section: how many exercises, the first and the last number as the book counts, that is in numeric
order and a stray number included, how many have a solution, the numbers that are missing, the labels that are repeated). The table the
command prints from it is what to hold next to the book's own count (`1..40`, 40 exercises, 40 answers). `--section ID` (repeatable)
checks only those sections; `--item-pattern REGEX` is the same option as for `exercises propose`, for a book that prints its numbers
some other way (`Problem 12.`).

| code | severity | what it means | what to do |
| --- | --- | --- | --- |
| `label-not-first` | error | The first text at the left margin of the exercise's own region is not its label: a closing `.` or `)` and parentheses are ignored, a label glued to the text counts, and `5a` may also start with its part marker `(a)` or `a)`. Or the left edge of the region cuts through the number (the text starts to the right of the region's edge). Evidence: the first 40 characters found. | `mcprep crop SECTION:LABEL`. Move the top edge down below the previous exercise (`frames update`), or correct the label (`exercises label`), or the section. |
| `no-text` | warning | The region holds no text: a picture (a figure, a scan), a frame that is not on its text, or a page without a text layer. | Look at the crop; an exercise that really is a picture is fine, a frame that is off is not (`frames update`). |
| `solution-label-missing` | error | A solution region whose text does not hold the exercise's label as the start of an item: the first text at its left margin starts with the label, or an item starts with it later in the first row (`1. 115 3. A = 52 5. 45`), or a range or a list in front of the answer contains it (`1-7.`, `1, 3, 5.`). The answer of `5a` may also stand under the number of its exercise (`5. (a) 4 (b) 7`) or start from `(a)`. A region that several exercises share (one block of answers) may hold the label on any row. Or the left edge of the region cuts through that number. Evidence: the first 40 characters found. | `mcprep crop SECTION:LABEL --region solution:0`. The region is on another answer: `solution add`/`solution.set` with the right region. |
| `solution-no-text` | info | The solution region holds no text: a picture, such as a graph. Its number cannot be checked. | Look at the crop. |
| `overlap` | error | The regions of two different exercises on a page (an exercise's own region or one of its continuations) share more than 5 percent of the smaller region and at least 0.004 of the page height (a quarter of a line: less than that and regions only touch). Instructions (`context`) are not compared here. Reported once for the two, under the first of them. | `crop` both; move an edge (`frames update`) so the two only touch. |
| `context-overlaps-frame` | warning | An instruction region (`context`, which several exercises share) lies on an exercise: at least a tenth of the smaller region and 0.004 of the page height, as in `validate`. One finding for each exercise and each region, however many exercises share it. | `crop --region context:0`; shorten the instruction's region (`context.set`) or the exercise's. |
| `duplicate-region` | error | Two exercises have the same main region (every edge within 0.001 on the same page): one is framed on the other's text. | Frame each printed exercise on its own text; delete the copy. |
| `region-size` | warning | The exercise's region is taller than 0.45 of the page, narrower than 0.05 or smaller than 0.002 in area (the parts of a unit are not measured): not the size of one printed exercise. | Look: a region that holds several exercises is split, a sliver that only holds the number is widened. |
| `section-unknown` | error | The exercise is filed under a section id that is not an entry of the outline (or the project has no outline). | `outline` shows the ids; `exercises section SECTION:LABEL <id>` or `outline update`. |
| `section-page` | error | The exercise is on a page before the page its section starts on, or after the page where the next entry of the same or a lower depth starts. (An exercise on the page of the next heading is not judged: only its position could tell, and `validate` warns `section-mismatch` for it.) | The exercise is in another section, or the heading's `page` is wrong: `exercises section`, or `outline update <id> --page ...`. |
| `gap` | warning | Numbers between the first and the last are missing from the section: labels that start with an integer, strays (`label-outlier`) left out. One finding for each run of missing numbers, under the exercise before it. | Look for them on the page: an exercise that the proposal missed is added (`exercises add`); a number the book itself skips stays skipped. |
| `duplicate` | error | Two or more exercises of a section have the same label (only a project written by hand or with `--force` can). | One printed exercise has one frame: delete the copy, or give it the number the book prints. |
| `non-numeric-label` | info | Labels of the section are not plain numbers (`5a`, `A.3`). One finding for the section. The sequence is checked for the labels that start with an integer (`5a` counts as 5), not for `A.3`. | Nothing, if the book prints them so. |
| `order` | warning | An exercise whose number does not fit its place: in its column (the regions that start at the same left edge, over all the pages of the section, from top to bottom) the labels do not run in numeric order. The columns of a page may alternate (1 left, 2 right, 3 left) or run one after the other (1 to 20 on the left, 21 to 40 on the right): both are in order, however the rows are staggered. Not checked in a section that has a duplicate. | Look at the exercise and its neighbours: a label that was mistyped (`exercises label`). |
| `no-solution` | info or warning | A section that has exercises but no solution at all (info), or in which fewer than 80 percent of the exercises have one (warning; the exercises without one are listed once, in the evidence). | The book may print no answers for the section; otherwise `solutions propose`, or `solution add`. |
| `label-outlier` | warning | A number more than 3 times the median of the numbers of its section, such as a number from the text taken for a label. It is left out of `gap` and `order`. | Look at the exercise; `exercises label` if the number is wrong. |
| `span-gap` | error | An exercise goes on in other regions (`continues`, in the order they are read), and text lies between two of them that no region holds: lines below the first region, whole pages in between, lines above the next region. The span skips part of the exercise. Evidence: the first 40 characters of that text. | `mcprep crop SECTION:LABEL --region continues:0`. Add the missing part (`continues add SECTION:LABEL --page P --rect l,t,r,b --snap`) or lengthen the region that ends early (`frames update`). |
| `continuation-order` | error | The continuations of an exercise (or the regions of an answer) are not in reading order: each must be on a later page, or on the same page in a column to the right or further down. A region that was deleted or swapped shows the text in the wrong order. | `continues remove` the region that is out of place and add the continuations again in the order of the text (`solution.set` for an answer). |
| `continuation-limit` | warning | The exercise already has the 8 continuation regions a frame can have, and text goes on after the last one. | The printed exercise is longer than a frame can hold: look at the page, and keep what fits only if the rest is no part of the exercise (then say so in the notes of the audit). |
| `numbered-text-left-behind` | error | In the exercises of a **practice-set** section (see below) a line starts like an item (`7.`, `7)`, `(7)`, `5a.`, a part marker `(a)`, a dotted number `1.1.7`, or what `--item-pattern` reads) and no region holds it: an exercise or a part that the proposal missed. Several such lines on a page that no region touches are one finding. Named by the number the line starts with. Evidence: the first 40 characters. | Look at the page (`mcprep render P --frames`). A missed exercise is added (`exercises add --section S --label L --page P --rect l,t,r,b --snap`), a part is a part of the exercise above (`frames update`); a numbered line that is no exercise at all (a list in the text) is what the book prints: acknowledge it with the reason. |
| `answer-left-behind` | error | In the answers (the key at the back, or the answers that follow a chapter) a line starts like an item and no solution region holds it: an answer that belongs to no exercise, or an exercise that was missed. Named by the section whose marker is above it in the key, when the key has markers. | As for `numbered-text-left-behind`, in the key: the exercise it answers is missing (`exercises add`) or its answer was not matched (`solution add SECTION:LABEL --page P --rect l,t,r,b --snap`). |
| `text-left-behind` | warning (info in the answers) | In a practice-set section a line of text is in no region of any frame: not an exercise, a continuation, an instruction or an answer, and neither furniture (a running header, a page number, a line of marks without words) nor a heading (the title of a section, a bold or larger line alone on its row that does not tell what to do). One finding for a block of lines. It is named by the exercise it goes on from when the block starts right under the region of one (the bottom edge may cut the exercise off) or when it stands at the top of a page and the exercise above ended on the page before (a continuation is missing); else by the section. In the answers the same is information. | Look at the page. The rest of an exercise belongs to it (`frames update` to lengthen the region, `continues add` for the next page); an instruction printed for a group belongs to each exercise of it as `context` (`context add`); a remark that the book prints between its exercises is acknowledged with the reason. |
| `answer-clipped` | warning | A line of text starts right under a solution region, in its column, and no region holds it: the answer goes on below the region's bottom edge. | `crop SECTION:LABEL --region solution:0`; lengthen the region (`solution.set`, or `solution remove` and `solution add --snap`). |
| `context-range` | error | The instruction that is the `context` of an exercise names numbers (`Exercises 5 - 10`, `For 10-13`, `Problems 3 and 4`) and the exercise's own number is not among them: it has the instruction of another group. Plain numbers only (a dotted label is not named by a range). | `crop SECTION:LABEL --region context:0`; give the exercise the instruction printed for it (`context remove`, `context add`). |
| `context-missing` | error | An instruction line of the section names this exercise's number (`Exercises 2 - 3`) and is not its context (nor inside its own region). | `context add SECTION:LABEL --page P --rect l,t,r,b --snap` with the instruction's region. |
| `context-not-nearest` | warning | An instruction (a bold line that tells what to do, or one that starts like an instruction) is printed between the instruction the exercise has and the exercise, and is neither inside the region of an exercise nor attached to this one. | Look at the page: the nearer instruction is probably the exercise's own (`context remove`, `context add`); a bold line that is no instruction (a heading of a part) is acknowledged. |
| `context-inconsistent` | warning | The instruction of an exercise (`context`, compared as the set of its regions: an instruction across a page break is two) is not the one of its group: (a) an instruction printed right above it, between the end of the previous exercise and its top, that other exercises have and it does not (the first exercise of a group, an exercise that was put back without it); (b) the exercises before and after it share an instruction that it does not have, and it has none or another one that is not printed above it; (c) it has none, the exercise before it has an instruction that two or more exercises share, and nothing is printed between them (the last exercise of a group). Not judged: an exercise with an instruction of its own printed above it, an exercise alone in its group, a section whose exercises stand inline. Can never be acknowledged. | `crop SECTION:LABEL --region context:0`; copy the regions of its neighbour: `exercises list --section S --regions`, then `context add SECTION:LABEL --page P --rect l,t,r,b` for each region (`context remove` for a wrong one). |
| `solution-section-mismatch` | error | The answer key is set in sections, with a marker (the section's number alone on a row, or a heading with its unique title), and the solution region of an exercise lies under the marker of another section. | `crop SECTION:LABEL --region solution:0`; point the exercise at its own answer (`solution remove`, `solution add`). |
| `solution-order` | warning | The answers of one section do not run in the order of their numbers within a column of the key (numbers are compared as numbers, a dotted label number by number). Answers that share one region are left out. | Look at the answer and its neighbours: a region that was put on the wrong exercise (`solution add`) or a label that was mistyped (`exercises label`). |
| `edge-on-ink` | warning | Only with `--ink` (MCP `ink: true`): the top, bottom, left or right edge of a region of an exercise, instruction, continuation or solution lies on dark pixels of the rendered page (more than 2 percent of the pixels along it in the three rows or columns around it): a printed glyph is cut. Worst first, with the side. Evidence: the side and the share. | `crop SECTION:LABEL` and move that edge into the white (`frames update`, `--snap` places an edge in the white between two lines). |
| `region-open-end` | warning | In a section whose exercises stand inline (see below): the line of text that follows the region of an exercise comes at the pitch of the lines inside it, in its column, is no item, no heading and in no region, and the region's last line reaches the right margin: the text goes on below the region's bottom edge. | Lengthen the region (`frames update`). |
| `region-holds-item` | error | In a section whose exercises stand inline: a region holds a line that starts another exercise of the same section (by its label): the region reaches into the next exercise. | `frames update SECTION:LABEL --rect l,t,r,b` so that the region ends before it. |
| `stray-frame` | warning | The project has book exercises and a frame that is not one (an exercise, question or bookmark framed for oneself, without a label): a stray region in an audited book. | `frames delete ID`, or, if it is an exercise of the book, `exercises mark ID --label L --section S`. |
| `inline-section` | info | The exercises of the section are not together in a block: fewer than three of them, or less than 60 percent of the lines from the first exercise to the end of the section are in a region. Text that no region holds is not checked there; the end of every region is (`region-open-end`, `region-holds-item`). One finding for the section, with the share. | Nothing, if the book sets its exercises between paragraphs. |

The thresholds (0.05, 0.004, 0.45, 0.05, 0.002, 80 percent, 3 times) are `VERIFY_LIMITS` in `packages/core/src/verify/types.ts`. They were
tuned on a real audit of a textbook of about 3,000 exercises, so that a book that was audited with care gives few findings, and each
finding that remains is something to look at.

What the check reads, so that you can do it by hand:

- **The text of a region** is the text lines of its page whose centre is between the region's left and right edge and that are at
  least half inside it from top to bottom. A line that the text layer joined from pieces standing side by side (the rows of two
  columns, a fraction) is read piece by piece. Running headers and footers are left out.
- **"First" is first at the left margin.** The margin is the left edge of the leftmost text of the region, with 0.012 of the page
  width of tolerance. A fraction's numerator, an exponent, the bars of an absolute value and the labels of a figure stand above the
  number and to the right of it: they do not come before it. A line of the previous exercise that starts at the margin does.
- **Compared as text:** compatibility forms are folded (NFKC), every kind of dash is a hyphen, white space is one space. The label is
  compared as a string; `5` and `5.` are the same label.

What it cannot see, and what to do about it:

- The text layer gives the box of a whole line, not of each character. A region that cuts the number off at the left is found from the
  number's share of the characters of its line (an estimate); a region that cuts the right end of a line, or that holds text that does
  not belong to the exercise below its last line, is not found: look at the crops of the sample (`exercises sample`).
- A text layer that joins two exercises of a row into one text run cannot be cut at the column. The check then asks only that the label
  starts an item of that line.
- A picture has no text: `no-text` and `solution-no-text` are the only things the check can say about it. A number that is set as a
  picture (no text) is reported as `label-not-first`: look at the crop.
- An indented line of the previous exercise at the top of a region is not at the margin: `overlap` sees it when the regions touch.

### No text left behind, and what it does not check

`exercises verify` also asks whether any text of the PDF is left out of every region. The rules are small, so that you can apply them by
hand:

- **The zone of a section** runs from the top of its first exercise region to where the section ends (the next outline entry of the
  same or a lower depth, or the first page of the answer key at the back of the book). The zone of a section is checked as a **practice
  set** only when it has at least three exercises and at least 60 percent of its lines (from the first exercise to the end of the
  section) are in a region: the exercises are together. Where they stand between paragraphs of ordinary text (a lesson with exercises
  inline) the lines between them are the lesson, not text left behind: the finding `inline-section` (information) says so, and the end
  of every exercise region is checked instead (`region-open-end`, `region-holds-item`).
- **Above the first exercise** a numbered line is looked at too, in the 8 percent of a page above it (never above the heading of the
  section): an exercise missed at the start of the set. Nothing else above it is judged, and neither is a dotted number (`1.1.1`), which
  counts examples and definitions as well.
- **A line is covered** when at least half of its box lies inside regions: the main region or a continuation of any frame, an instruction
  (`context`) or a solution. A line that the text layer joined from pieces standing side by side (two columns, a fraction) is judged
  piece by piece.
- **Left out of the check:** running headers and footers, a bare page number alone on its row at the top or bottom of the page, a line of
  marks without a letter or a digit (the box that ends a proof, a bracket, a bullet), and headings: a line that holds the title of an
  outline entry or is the label of one, and a bold line or one set larger than the usual font of its page, alone on its row, that does
  not tell what to do (an instruction is no heading: "Find each product." that no region holds is text left behind).
- **The answers** are checked where the solution regions are: on every page that has one, from the first to a little below the last
  (for a key at the back of the book, from the first answer to the end of its last page). A line that starts like an item there is an
  `answer-left-behind`, a line right under a solution region an `answer-clipped`, other lines are information.
- **Between the regions of one exercise** (its main region and its continuations in reading order, up to 8) no text may lie: that is
  `span-gap`. A span may reach into the next section's pages, and a continuation may be as tall as a page.
- A line **starts like an item** when it starts with a number and its closing mark (`7.`, `7)`, `(7)`, `5a.`; a `.` before a digit is a
  decimal point), with a part marker (`(a)`, `a)`), with a dotted number of three parts (`1.1.7 ...`) or as one of the patterns of
  `--item-pattern` says (group 1 is the label).

Books that print an answer under a keyword ("Lösung 1.1.2", "Answer 5.") need the pattern for it, or every solution region is a
`solution-label-missing`: `mcprep exercises verify --item-pattern '^L(?:ö|oe)sung\s+(\d+(?:\.\d+)*)'` (the same option as for
`exercises propose`; it applies to the exercises and to the solution regions). Dotted labels (`1.3.10`) are compared number by number
(`1.3.8` before `1.3.10`) for `order`, for the first and the last number of a section and for `solution-order`; their last number counts
examples and definitions too, so `gap` and `label-outlier` are not applied to them (`duplicate` is).

## A fixed sample to look at: `exercises sample`

Looking at crops cannot cover a book of thousands of exercises, so a **sample** is looked at, and it must be the same for everyone: two
agents (or an agent and a person) that audit one book look at exactly the same exercises and answers. `mcprep exercises sample` (MCP
tool `exercises_sample`) chooses them by the rules below. There is no randomness, and the order of the frames in the file does not
matter, so you can apply the rules by hand and get the same list. The sample is **bounded**: at most `--exercises N` exercises (default
40) and `--solutions N` answers (default 20), however large the book is.

```console
mcprep exercises sample                          # the list: ref, why, page, region (at most 40 exercises and 20 answers)
mcprep exercises sample --crops sample/          # also the PNG of every region, "1.2_5-exercise.png", "1.2_5-solution.png"
mcprep exercises sample --exercises 60 --solutions 30 --out sample.json   # other caps; the format math-canvas-sample (`mcprep schema sample`)
mcprep exercises sample --per-section            # the thorough review: the first and the last exercise of every section, beyond the caps
```

**The order of the book** is the order of the sections as the outline lists them and, within a section, reading order (page, then top,
then left; the frame id decides a tie). Heights and areas are compared to five decimals.

**The caps are hard.** The rules are applied in the order below. Each rule adds the exercises it names that are not in the sample yet, as
far as the cap allows; an exercise that is in the sample already costs nothing and only gains the reason. A rule that does not fit in
what is left of the cap is **thinned by an even stride, never cut off at the end**: of its `M` candidates, in the order of the book, it
takes `count` (what the cap leaves), the k-th at index floor(k * M / count) for k = 0, 1, ..., count - 2 and the last candidate as the
last one, so both ends of the rule stay (with a `count` of 1, the first candidate). `notes` says which rule was thinned and how far, for
example "The first and the last exercise of every chapter: 5 of 11 taken, thinned by an even stride to stay within 8 exercises", so
that nobody takes the sample for more than it is.

**The exercises** (`--exercises N`, default 40):

1. **One exercise of every layout kind that the book has: the first exercise of that kind in the order of the book.**
2. **The first and the last exercise of every chapter** (`first-in-section`, `last-in-section`; one exercise if the chapter has only
   one). A chapter is an outline entry of depth 0 that holds exercises directly or below it; an outline that has no entry of depth 0
   has its top-level entries as chapters.
3. **The first and the last exercise of every section** (the same two reasons). When what is left of the cap after rules 1 and 2
   (`left`) is less than twice the number `S` of sections that have exercises, the sections are thinned first: `m` = floor(left / 2)
   sections are taken, the j-th (j = 0, 1, ..., m - 2) being the section at index floor(j * S / m) in the order of the book and the
   last one being the last section, so the first and the last section of the book are always in (with `m` of 1 only the first).
   `--per-section` takes every section whatever the cap is.
4. **An even stride over the rest** (`stride`): the exercises that are not in the sample yet are `M`; with `count` = N minus the size of
   the sample so far, all of them when `count` is at least `M`, else the stride above.

| `reason` | rule | the exercise ... |
| --- | --- | --- |
| `has-continuation` | 1 | has a continuation region (it goes on in the next column or on the next page). |
| `spans-pages` | 1 | has continuation regions on two or more further pages (a statement that goes on over two page breaks). |
| `context-on-another-page` | 1 | has an instruction region (`context`) on another page than its own. |
| `two-in-a-row` | 1 | stands in a row of exactly two exercises: the same section and page, regions that share at least half of the smaller one's height, left edges at least 0.05 apart. |
| `three-in-a-row` | 1 | the same for a row of three or more. |
| `longest` | 1 | has the region of the greatest height (the first in the order of the book wins a tie). |
| `smallest` | 1 | has the region of the least area. |
| `beside-a-figure` | 1 | has a region at least 2.5 times as tall as the median height of the exercises of its section, and at least 0.06 tall (sections of three exercises or more). |
| `first-in-section` | 2, 3 | is the first exercise of a chapter (rule 2) or of a section (rule 3). |
| `last-in-section` | 2, 3 | is the last exercise of a chapter or of a section. |
| `stride` | 4 | is one of the even stride over the rest. |

A layout kind that no exercise has is not sampled; `notes` says so, so that nobody looks for it.

**The answers** (`--solutions N`, default 20), for the exercises that have a solution region:

1. the answers of the exercises of rule 1 above (`of-first-in-section`, `of-last-in-section` for an exercise that is the first or the
   last of a chapter or section, `of-sampled-exercise` for one that is in the sample for any other reason);
2. the answer with the most lines of text (`most-lines`; the text lines of the page in its solution regions, a joined line counted
   once; at least two; the first in the order of the book wins a tie);
3. the first answer in the book that holds no text at all (`picture-only`, a graph);
4. the first answer of every chapter's key (`first-of-chapter-key`: the chapters are those of rule 2 above; the answer is that of the
   exercise whose first solution region comes first on the pages);
5. the answers of the other sampled exercises, in the order the exercises were picked (with the same three reasons as in rule 1);
6. an even stride over the remaining answers (`stride`), up to N.

Rules 2 to 4 come before rule 5 on purpose: the sample has more exercises than answers fit in the default cap, and the answer with the
most lines, the picture and the first answer of a key are the ones nothing else would show. Rule 1 comes first because its exercises are
the layouts.

**`--per-section`** (MCP `per_section: true`) is the thorough review, section by section: rule 3 of the exercises and rule 5 of the
answers ignore the caps. The first and the last exercise of every section are in the sample, and the answer of every sampled exercise,
whatever `--exercises` and `--solutions` say, so the sample can be larger than N; `notes` says by how much. The other rules keep their
caps. `--exercises 0` or `--solutions 0` leaves that half of the sample out.

An exercise that several rules pick is listed once, with every reason in `reasons` (in the order of the rules, so a layout kind comes
before `first-in-section`) and the first rule's in `reason`.

Each entry is `{ ref, reason, reasons, page, kind, region }`: `ref` is `SECTION:LABEL`, `kind` is `exercise` or `solution`, `region` is `main`
or `solution:0`. **Look at exactly these**: `mcprep crop <ref> --region <region>` (the MCP tool `render_crop` with `frame` = `ref` and
`region`), or take the files of `--crops`. For an exercise picked for `has-continuation` the crop of its first continuation is written too
(`...-continues0.png`), and for `context-on-another-page` the crop of the instruction (`...-context0.png`). Look first for what `verify`
cannot see: the right end of every line, text that a region holds below its last line, a figure that is cut, an answer that is not the
answer to this exercise.

## The gate: proving that an audit is complete

Looking at a sample cannot show that every one of thousands of exercises is right. The **gate** is the end of an audit: it runs every
check that needs no looking, lists what is **open** (neither repaired nor acknowledged) and passes only when nothing is. Nothing is
silent: what the book itself prints is acknowledged with a reason that anybody can read and a second reviewer confirms, everything else is
repaired, and that every exercise was looked at is proved exercise by exercise.

```console
mcprep exercises verify --details verify.json       # 1. the text checks (about two seconds for a book of 3,000 exercises)
mcprep exercises verify --ink                       #    and the pixel check of the edges of every region (renders the pages once)
mcprep book compare reference.json --details c.json # 2. the sections and their counts against the book's own list
mcprep exercises sheets --out sheets/ --solutions   # 3. contact sheets of EVERY exercise: look at every one, write the visual record
mcprep audit gate --reference reference.json --ink --visual visual.json   # 4. the gate; exit code 0 only when nothing is open
mcprep audit ack --code duplicate --ref 3.2:7 --page 120 --quote "7. Find the" --reason "..."   # 5. only for what the book prints
mcprep audit review --out review/ && mcprep audit confirm --by REVIEWER --all  # 6. a second reviewer looks at each note
mcprep audit gate --reference reference.json --ink --visual visual.json --final   # 7. exit code 0 only when the book is perfect
mcprep export && mcprep import-check book.mcbundle  # 8. export says whether the gate is current
```

**What the gate runs.** `validate` (0 errors: never acknowledgeable); `exercises verify` with every check of the table above (every
error and warning must be repaired or acknowledged; information needs nothing); with `--ink` the edges of the regions; with
`--reference FILE` the comparison of `book compare` (a count that differs, a section on one side only, a title: each is a finding
`reference-count`, `reference-missing`, `reference-extra`, `reference-title`); the bundle exported last, when there is one (it must pass
the importer's checks and have the frames of the project: `bundle-rejected`, `bundle-stale`); with `--sheets-seen FILE` the contact
sheets (below); and with `--visual FILE` the visual record (below). It reports `open`, `acknowledged` (each with its reason) and exits with
code 4 unless `open` is empty. Give it the same `--item-pattern` as the audit (or put them in the notes file, as `itemPatterns`): the
certificate lists them.

**Perfect.** The report says `passed` (nothing is open), `unconfirmed` (how many acknowledgements no second reviewer confirmed) and
`perfect`: nothing is open, the visual record has an entry for every exercise and nothing is unconfirmed. `--final` makes the exit code 4
unless the book is perfect. A book is finished when `audit gate --final` exits with 0, the certificate is current, and `export` and
`import-check` were done after it.

**The contact sheets** (`exercises sheets`, MCP `exercises_sheets`) are for an exhaustive look: every exercise of the book in the
order of the book, each cell captioned `SECTION:LABEL` and the zero-based pages of its regions (`p. 12, 13-14`), the instruction in a
blue frame, the exercise in red, its continuations in orange and, with `--solutions`, its answer in green, one region under the other.
A cell is 740 pixels wide; at most `--per-sheet` (12) cells make a sheet, and a sheet is closed as soon as the next cell would make it
taller than 2,600 pixels, so that it stays readable; a cell taller than that has a sheet of its own (`tall`; drawn smaller only above
6,000 pixels, `scaled`). The files are `sheet-0001.png`, ... and `sheets.json`, which lists the references and the pages of each sheet and
a hash of what it shows. `--sheet N` and `--from-sheet N` draw again after a repair. When you have looked at a sheet, list its number in a
file (JSON `{"seen": [1, 2, 3]}` or text such as `1-40`) and give the file to the gate: it asks that the sheets cover every exercise
(`sheets-partial`, `sheets-incomplete`), that each shows its exercises as they are now (`sheets-stale`) and that each is listed
(`sheets-unseen`). None of these can be acknowledged. **A list of numbers proves nothing**: `exhaustive` in the certificate is true only
when the visual record covers every exercise.

**The visual record** (`audit gate --visual FILE`, `mcprep schema visual`) is the proof of looking: a JSON list with **one entry for
every exercise**, written by whoever looked at its cell on the sheets (an object `{"visual": [...]}` is accepted as well):

```json
[{ "ref": "1.2:5", "startsWith": "Find the value", "instruction": true, "answerStartsWith": "5", "ok": true },
 { "ref": "1.2:6", "startsWith": "Find the value", "instruction": true, "answerStartsWith": "6", "ok": false, "defect": "context-missing" }]
```

- `ref` is `SECTION:LABEL`; `startsWith` the first three words printed after the number, as you read them in the cell;
  `instruction` whether the cell shows a blue box; `answerStartsWith` the number at the start of the green box (`""` when there is none);
  `ok` false, with `defect` (a finding code or a word), when the cell shows anything wrong.
- The gate checks each entry against the project and the text layer: every exercise has an entry (`visual-missing`, one finding for the
  exercises of a section); `startsWith` (its first three words, case and spaces do not matter) is a piece of the text of the exercise's
  region; `instruction` is whether the exercise has an instruction (a `context` region); `answerStartsWith` is the number at the start of the
  text of its answer region (or `""` for an exercise without one). An entry that does not fit is open as `visual-mismatch`: it shows that
  the cell was not looked at, or that the exercise changed afterwards. An entry with `ok` false is open as `visual-defect`. An entry for
  something that is no exercise, a repeated entry and an entry that lacks a field are `visual-mismatch` too. None of these can be
  acknowledged: repair the exercise, look at its sheet again and change its entry.
- Write what the cell shows, not what the project says: a cell without a blue box is `"instruction": false`, and the gate (and
  `context-inconsistent`) then say what is missing.

**An acknowledgement** says that a finding is what **the book itself prints**: a number printed twice, an answer missing from the
key, a practice set with more exercises than the reference lists, a remark printed between two exercises. It is **never** for a defect
of ours: the findings `label-not-first`, `solution-label-missing`, `overlap`, `duplicate-region`, `section-unknown`, `section-page`,
`span-gap`, `continuation-order`, `context-range`, `context-missing`, `context-inconsistent`, `context-not-nearest`,
`solution-section-mismatch` and `region-holds-item` can **not be acknowledged at all**: `audit ack` refuses them with the command that
repairs each, and the gate takes no note for them from the file either (it lists the note under `refusedAcknowledgements`; the finding
stays open). `mcprep audit ack --code C --ref R --page N --quote "..." --reason "..." [--count N] [--by NAME]` appends one to
`<project>.audit-notes.json` after checking everything that can be checked. Every refusal says what is wrong and what to give instead, **everything that is wrong at once** (a numbered list, then one call that would do, with what is right kept in it), so that one more call is enough:

- `--code` must be the code of a finding that exists now for `--ref` (an exercise as `SECTION:LABEL`, a section as its id, exactly as the
  finding names it), and not one of the codes above;
- `--page` (zero-based) is required for a finding that has a page, and it picks the finding;
- `--quote`, 4 to 60 characters, must be a piece of the **text printed on that page** (case and spaces do not matter): copy it from
  `mcprep lines PAGE`. A piece of the finding's own message is not on the page and is refused. It shows the reviewer what the book prints;
- `--reason` says what the book prints and where, in your own words: at least 10 characters, and not the text of the finding;
- a note for a whole section (a ref without a label) must say how many findings it covers (`--count N`); a note with a count applies only
  while exactly that many findings match, then it is **stale** (the gate lists it and the findings are open again); a note for a finding
  that is gone (repaired) is **unused** and listed so that it can be removed;
- the notes file is plain JSON (`mcprep schema notes`); the gate lists every note with its reason, and the certificate keeps them.

**A second reviewer** confirms every acknowledgement. A new note is `confirmed: false`; `mcprep audit review --out DIR` writes, for every
note, the picture of what it is about (the exercise's region or the line on the page, without any grid), the reason, the quote (and whether
it is on the page) and an `index.md` (and `review.json`) so that a person or another agent can check each one quickly; the reviewer then
runs `mcprep audit confirm --by NAME --ref R --code C` (or `--all`) with a name that is **not** the name of the one who wrote the note.
A note that is changed or replaced is not confirmed again. The gate stays `passed` with unconfirmed notes but says `unconfirmed: N`, the
certificate records it, `export` prints "N acknowledgements are not yet confirmed by a second reviewer", and the book is not `perfect`.

**Repairing from a neighbour.** `mcprep exercises list --section S --regions` (MCP `exercises_list` with `regions`) prints for each
exercise its instruction (`context`), continuation and solution regions as `page:left,top,right,bottom` (JSON: the objects under
`regions`): to give an exercise the instruction of its neighbour, `mcprep context add REF --page P --rect l,t,r,b` for each region of it
(an instruction across a page break is two regions), or `exercises add ... --context P:l,t,r,b`.

**The certificate** `<project>.audit-gate.json` (`mcprep schema gate`) holds the SHA-256 of the frames and of the outline, the counts, the
open and the acknowledged findings, `unconfirmed`, `perfect`, the checks that ran and `passed`. Any later change to a frame or to the
outline changes the hash and makes the certificate **stale**: `mcprep audit gate --status` says whether it is current and passed (exit code
0 only then), and `export` says so in its last lines (`gate` in its JSON result). Run the gate again after every repair; it takes seconds.

### The proof that the gate has teeth

`node scripts/inject-defects.mjs` damages the audited synthetic workbook and the three-page span in a seeded, reproducible way, one
damaged project for each defect, and runs the gate on each; it must not pass and must name the exercise. Kinds of defect (every one is
stopped and named in 100 percent of the damaged projects, with 5 or 6 injected for each kind and `--ink` on, for the seed 20261004 and for
four other seeds):

| defect | what is done |
| --- | --- |
| `region-cut-top` | the top edge moves down into the text of the exercise |
| `region-cut-bottom` | the bottom edge moves up, the last lines are left out |
| `region-grow` | the region grows down over the next exercise |
| `region-move` | the region moves down by more than its height |
| `label-change` | the label is not the number the book prints |
| `exercise-delete` | an exercise is missing |
| `exercise-duplicate` | an exercise is there twice |
| `solutions-swapped` | the answers of two exercises of a section are swapped |
| `solution-other-section` | an exercise points at the answer of another section |
| `solution-deleted` | the answer of an exercise is missing |
| `context-dropped` | an exercise in the middle of a group has lost the instruction its neighbours share |
| `context-dropped-start` | the first exercise of a group has lost the instruction printed right above it (an exercise put back without it) |
| `context-dropped-end` | the last exercise of a group has lost the instruction of the exercises before it |
| `context-wrong` | an exercise has the instruction of another group |
| `continuation-left-out` | an exercise over a page break has lost its continuation (the workbook has one) |
| `stray-frame` | a frame that no book exercise is |
| `stray-exercise` | an extra book exercise framed over the text of another |
| `span-middle-deleted`, `span-swapped`, `span-shrunk` | the middle continuation of a span is deleted, two are swapped, one is shrunk so that it leaves text out |

The untouched projects pass. What the checks **cannot see** (they need a person looking at the sheets, and the visual record makes them
say so): a continuation that holds no text (a figure) that was left out; an instruction dropped from an exercise that is alone in its group
(nothing else carries it, so only the unattached line shows, as text left behind); a region that is too large on blank paper (it holds
nothing a learner would miss); an edge that cuts between two words and so no glyph (with `--ink` those that cut a glyph are found; a cut
that only touches the tops of the glyphs, under 2 percent of the edge, is not); two exercises swapped together with their answers. The test
`packages/cli/test/inject-defects.test.ts` runs the same injection in the test suite, and `packages/cli/test/gate-review.test.ts` the seven
defects of a cold-start test of the harness (a label cut, a region over the next exercise, an exercise deleted and put back without its
instruction, a wrong label, a wrong answer, an instruction removed, an answer cut in half).

## Other books: the words and patterns are options

Nothing is built for one book. The defaults read English headings and numbers like `5)`, `5.`, `(5)`, `5a)`; a book that words or numbers
differently is read with options (on `outline derive --book`, `exercises propose` and `solutions propose`; the MCP tools have the same
arguments):

| Option | What it changes | Default |
| --- | --- | --- |
| `--chapter-words chapter,kapitel` | Words that open a chapter heading ("Kapitel 3"). | chapter, part, unit, kapitel, chapitre, capítulo, ... |
| `--practice-words exercises,problems` | Words that name a practice set in a heading ("3.2 Exercises - Title"). | practice, exercises, problems, übungen, aufgaben, ... |
| `--answer-words answers,solutions` | Words that open the answer key and the header of a section in it. | answers, answer key, solutions, lösungen, ... |
| `--item-pattern "^([A-Z]\.\d+)\s+(.*)$"` | How the number of an exercise or an answer starts a line (group 1 is the label, group 2 the text after it; repeat for several). | `5)`, `5.`, `(5)`, `5a)` |
| `--instructions bold\|margin\|auto\|none` | How instructions are recognised. | auto: bold when the pages carry font information |

Sections whose numbers are not like `3.2` (a book that numbers its sections `1`, `2`, `3` through the chapters) are not read by
`outline derive --book`; write the outline by hand (`outline set`) with an `id` for every section, and `exercises propose` finds the
practice sets from it (by the `id` or `label`, or by an unlabelled "Practice" or "Exercises" heading inside the section).

## Checking the proposals against a real book

`scripts/acceptance-book.mjs` (in the repository, after `npm run build`) runs the whole audit on a PDF and writes what is needed to
judge it, without uploading anything:

```console
node scripts/acceptance-book.mjs book.pdf [reference.json] --out results --name book --title "Beginning Algebra" \
  --folder "Books/Algebra" --author "A. Author" --license-name "CC BY 3.0" --license-url https://creativecommons.org/licenses/by/3.0/ \
  --source-url https://example.org/the-book --notice "..." [--reference-chapter-offset -1] [--sample 60] [--solution-sample 30]
```

It creates the project next to the results, stores the sections, applies the exercises with their solutions, applies them a second time
(nothing may change), validates, exports and checks the bundle, compares the sections and the exercise counts with the reference (a JSON
with `chapters: [{ number, title, sections: [{ number, title, exercise_count }] }]` or `sections: [{ label, title, count }]`), and checks
**every stored region against the ink of its page**: a top or bottom edge whose pixel row is dark runs through a printed glyph. The
report (`acceptance-report.md`) has the counts per chapter and section, every difference with the pages it was read from, the answers
without an exercise and exercises without an answer, the validation warnings, the edges on ink and the timings; `crops/` and `sheets/`
hold a stratified sample of exercise and solution crops and contact sheets of them (red frame, orange continuation, blue instruction,
green solution) to look at.

## Limits of the heuristics

- A glyph that the PDF sets at an absurd size (some fonts report an unmapped "not equal" sign at 120 points) is read at the usual size
  of the page when its scales across and up differ so much; a line that is garbled in another way is not found, and the tool says so
  (gaps, "no answer for ..."): frame it by hand.
- Parts ((a), (b)) stay inside the exercise that carries the number; they are not split into exercises of their own.
- A book without numbered sections is read with the generic heading detection (ids made from the titles) and has no practice sets to read.
- A figure is framed with the ink profile of the page, which cannot tell to which column a drawing belongs; a figure beside other columns
  stops at the column to its right and above a heading.
- In rows of an answer key that are set very tight, the edge of a region can still touch the first line of the next answer (the edge
  moves into the white between the lines when there is some within reach of the own text); the ink check counts these.
- Pages without a text layer (scans) cannot be read: frame them by eye (AGENT_GUIDE section 8).
- The answer key is found from a heading like "Answers - Chapter 1" or from the contents; an answer that is only a picture is framed only
  when its number stands in the text layer.
- `validate` warns about edges that cut a line (`clips-line`) and about a running header inside a region (`includes-header-footer`)
  from the boxes of the text layer; where the layer joins the rows of two columns into one line or sees a small number above a line
  as a page number, the warning is not a defect: the ink check above is the exact measure.

## Instruction block for an AI agent

The procedure for an agent is [AGENT_RUNBOOK.md](AGENT_RUNBOOK.md): the phases, the exact calls, the decision rules, the formulas for a repair, the stop codes and the
report. [AGENT_PROMPTS.md](AGENT_PROMPTS.md) holds the prompts that point an agent at it (the audit, the visual pass alone, the reviewer who confirms the
acknowledgements, a resumed run). Use them instead of a list of steps of your own: two agents that follow the runbook make the same calls and reach the same
result, and [the gate](#the-gate-proving-that-an-audit-is-complete) is the proof that the audit is complete.

## Checklist

- [ ] Chapter and section counts, labels, titles and pages match the printed contents; the notes were read.
- [ ] Per section: the count and the first and last number match the book; every gap, duplicate and stray number is explained.
- [ ] `exercises verify` has no errors, and every warning and info that remains is explained.
- [ ] The fixed sample (`exercises sample`: every section's first and last exercise, every kind of layout, the answers) looked at, all of it; no frame cuts a line, holds a neighbour or leaves a figure out; the context is the right instruction; an answer region shows the answer to its own exercise.
- [ ] Exercises without an answer and answers without an exercise explained.
- [ ] `validate` has no errors, `export` done, `import-check` says the bundle would import; the licence's attribution travels with the bundle (author, licence and notice of the manifest, see BUNDLE_FORMAT.md).
- [ ] The decisions and the differences from the book are recorded.
