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
(the counts) and `sections` (for each section: how many exercises, the first and the last label, how many have a solution, the numbers
that are missing, the labels that are repeated). `--section ID` (repeatable) checks only those sections; `--item-pattern REGEX` is the
same option as for `exercises propose` and is for a book that prints its numbers some other way (`Problem 12.`).

| code | severity | what it means | what to do |
| --- | --- | --- | --- |
| `label-not-first` | error | The first text at the left margin of the exercise's own region is not its label: a closing `.` or `)` and parentheses are ignored, a label glued to the text counts, and `5a` may also start with its part marker `(a)` or `a)`. Or the left edge of the region cuts through the number (the text starts to the right of the region's edge). Evidence: the first 40 characters found. | `mcprep crop SECTION:LABEL`. Move the top edge down below the previous exercise (`frames update`), or correct the label (`exercises label`), or the section. |
| `no-text` | warning | The region holds no text: a picture (a figure, a scan), a frame that is not on its text, or a page without a text layer. | Look at the crop; an exercise that really is a picture is fine, a frame that is off is not (`frames update`). |
| `solution-label-missing` | error | A solution region whose text does not hold the exercise's label as the start of an item: the first text at its left margin starts with the label, or an item starts with it later in the first row (`1. 115 3. A = 52 5. 45`), or a range or a list in front of the answer contains it (`1-7.`, `1, 3, 5.`). The answer of `5a` may also stand under the number of its exercise (`5. (a) 4 (b) 7`) or start from `(a)`. A region that several exercises share (one block of answers) may hold the label on any row. Evidence: the first 40 characters found. | `mcprep crop SECTION:LABEL --region solution:0`. The region is on another answer: `solution add`/`solution.set` with the right region. |
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
- A picture has no text: `no-text` and `solution-no-text` are the only things the check can say about it.
- An indented line of the previous exercise at the top of a region is not at the margin: `overlap` sees it when the regions touch.

## A fixed sample to look at: `exercises sample`

Looking at crops cannot cover a book of thousands of exercises, so a **sample** is looked at, and it must be the same for everyone: two
agents (or an agent and a person) that audit one book look at exactly the same exercises and answers. `mcprep exercises sample` (MCP
tool `exercises_sample`) chooses them by the rules below. There is no randomness, and the order of the frames in the file does not
matter, so you can apply the rules by hand and get the same list.

```console
mcprep exercises sample                          # the list: ref, why, page, region
mcprep exercises sample --crops sample/          # also the PNG of every region, "1.2_5-exercise.png", "1.2_5-solution.png"
mcprep exercises sample --exercises 60 --solutions 30 --out sample.json   # the format math-canvas-sample (`mcprep schema sample`)
```

**The order of the book** is the order of the sections as the outline lists them and, within a section, reading order (page, then top,
then left; the frame id decides a tie). Heights and areas are compared to five decimals.

1. **Every section that has exercises: its first and its last exercise** (`first-in-section`, `last-in-section`; one exercise if the
   section has only one).
2. **One exercise of every layout kind that the book has: the first exercise of that kind in the order of the book.**

   | `reason` | the exercise ... |
   | --- | --- |
   | `has-continuation` | has a continuation region (it goes on in the next column or on the next page). |
   | `context-on-another-page` | has an instruction region (`context`) on another page than its own. |
   | `two-in-a-row` | stands in a row of exactly two exercises: the same section and page, regions that share at least half of the smaller one's height, left edges at least 0.05 apart. |
   | `three-in-a-row` | the same for a row of three or more. |
   | `longest` | has the region of the greatest height (the first in the order of the book wins a tie). |
   | `smallest` | has the region of the least area. |
   | `beside-a-figure` | has a region at least 2.5 times as tall as the median height of the exercises of its section, and at least 0.06 tall (sections of three exercises or more). |

   A kind that no exercise has is not sampled; `notes` says so, so that nobody looks for it.
3. **Fill up to `--exercises N`** (default 40): take the exercises that are not in the sample yet, in the order of the book, `M` of them,
   and `count` = N minus the size of the sample so far; with `count` of at least `M` take all of them, else the exercises at index
   floor(k * M / count) for k = 0, 1, ..., count - 1 (`stride`).
4. **The answers** (`--solutions N`, default 20), for the exercises that have a solution region: (a) the answers of the exercises
   above (`of-first-in-section`, `of-last-in-section` for those of rule 1, `of-sampled-exercise` for the others); (b) the answer with the
   most lines of text (`most-lines`; the text lines of the page in its solution regions, a joined line counted once; at least two; the
   first in the order of the book wins a tie); (c) the first answer in the book that holds no text at all (`picture-only`, a graph);
   (d) the first answer of every chapter's key (`first-of-chapter-key`: for each chapter, a top-level outline entry, the exercise whose
   first solution region comes first on the pages); (e) then an even stride over the remaining answers, as in rule 3, up to N (`stride`).

**N fills the sample up; it never cuts it.** The rules always add what they name, so a book of many sections has more than 40
exercises: a book of 60 sections has at least 120. `--exercises 0` or `--solutions 0` leaves that half of the sample out. An exercise
that several rules pick is listed once, with every reason in `reasons` and the first rule's in `reason`.

Each entry is `{ ref, reason, reasons, page, kind, region }`: `ref` is `SECTION:LABEL`, `kind` is `exercise` or `solution`, `region` is `main`
or `solution:0`. **Look at exactly these**: `mcprep crop <ref> --region <region>` (the MCP tool `render_crop` with `frame` = `ref` and
`region`), or take the files of `--crops`. For an exercise picked for `has-continuation` the crop of its first continuation is written too
(`...-continues0.png`), and for `context-on-another-page` the crop of the instruction (`...-context0.png`). Look first for what `verify`
cannot see: the right end of every line, text that a region holds below its last line, a figure that is cut, an answer that is not the
answer to this exercise.

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

Paste this into the agent's task; it assumes the `mcprep` MCP server (or the command line). It is made for any model: steps 5 and 6 give
every agent the same checks and the same sample, and step 6 says what to do when the agent cannot look at images.

```text
Audit the textbook PDF <path> for Math Canvas as an authority, entirely on this machine (do not upload the PDF or any page of it).
First read the resource mcprep://guide (or call get_guide), then docs/AUDIT_A_BOOK.md if you have the repository.

1. create_project (title = the book's title, folder = where it belongs in the library), then book_meta with the author, the licence
   (name and address), the source address and the notice, copied from the book's own front matter.
2. outline_derive_book. Read "notes" and every entry with confidence below 0.9. Check the number of chapters and sections against the printed
   contents (render_page of the contents pages), the titles, the pages. If the proposal is right, outline_derive_book with apply=true;
   if a title or a page is wrong, apply_operations with one outline.set operation that holds your corrected entries (keep id, label and top).
3. exercises_propose with solutions=true and details_file set, without apply. Read the result: per section the count, first and last
   number, gaps, duplicates, rejected numbers, notes. For every difference from what the book promises (a count, a missing number,
   a number printed twice) collect the page evidence and decide: it is what the book prints, so keep it and report it, unless the tool
   misread the page (then fix the frames).
4. exercises_propose with solutions=true and apply=true (it can be run again: what is there is skipped, what you corrected is kept and
   listed under "changed", replace=true overwrites it; use sections=[...] to leave out what you framed by hand). Then solutions_propose
   for answers that were not matched.
5. Check without looking: exercises_verify with details_file set. Read "summary", then the findings in the order given (errors first).
   For every error render_crop the ref (frame = ref) to see the defect and correct it (update_frame, exercises_label, exercises_section,
   solution_add, or apply_operations in one atomic batch), then call exercises_verify again, until it has no errors. Read every warning
   and info; keep one only if you can say why (the book prints no answers for that section, a number the book itself skips).
6. Look at the fixed sample: exercises_sample. Do not choose a sample of your own: the list is the same for every agent. For every entry
   call render_crop with frame = ref and region = region (or set crops_dir and open the files) and check that the exercise crop starts
   with its number, that no line is cut, that nothing of the next exercise is in it, that a figure is inside and that the instruction is
   the right one (the entries for has-continuation and context-on-another-page also have a region continues:0 and context:N); and that
   the answer crop shows the answer to THIS exercise. Fix what is wrong, then call exercises_verify and look again. If you cannot look
   at images, say so in your report: exercises_verify and the list of the sample are then all you can report on, and you must not
   write that you looked at a crop you did not see.
7. validate (no errors), book_show (the counts per section next to the book's own), export_bundle, import_check (wouldImport must be true).
8. Report: where the bundle is; chapters, sections, exercises, solutions; every difference from the book's own contents or from the
   expected counts, with the page evidence; every exercise without a solution and every solution without an exercise; the last
   exercises_verify summary and every warning you kept, with the reason; the entries of the sample you looked at (all of them); what you
   framed by hand; what you were unsure about.

Never invent an exercise, a number or an answer that the book does not print; never change the numbering to what you think it should be.
```

## Checklist

- [ ] Chapter and section counts, labels, titles and pages match the printed contents; the notes were read.
- [ ] Per section: the count and the first and last number match the book; every gap, duplicate and stray number is explained.
- [ ] `exercises verify` has no errors, and every warning and info that remains is explained.
- [ ] The fixed sample (`exercises sample`: every section's first and last exercise, every kind of layout, the answers) looked at, all of it; no frame cuts a line, holds a neighbour or leaves a figure out; the context is the right instruction; an answer region shows the answer to its own exercise.
- [ ] Exercises without an answer and answers without an exercise explained.
- [ ] `validate` has no errors, `export` done, `import-check` says the bundle would import; the licence's attribution travels with the bundle (author, licence and notice of the manifest, see BUNDLE_FORMAT.md).
- [ ] The decisions and the differences from the book are recorded.
