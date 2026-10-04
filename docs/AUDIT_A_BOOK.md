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
mcprep validate && mcprep book show                # 4. zero errors; the counts per section next to the book's own
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
4. **Look.** `mcprep crop 0.1:5` writes a PNG of the exercise (named by section and label), `--region context:0` of its instruction,
   `--region continues:0` of the part on the next page, `--region solution:0` of its answer; `mcprep crop --all --section 0.1` does a
   whole section; `mcprep render 9 --frames --solutions --grid 0.1` shows a page with its frames. Look at: the first and the last
   exercise of every section; an exercise beside a figure and a graph answer; an exercise at the end of a page and one that goes on
   over the page break; an instruction that crosses a page break; a two-column row with fractions; a three-column row; a root; an
   answer of several lines; the last answer before the next chapter's heading; every item the commands marked with a confidence
   below 0.8.
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

Paste this into the agent's task; it assumes the `mcprep` MCP server (or the command line) and that the agent can look at images.

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
4. Look. With render_crop look at, per section, the first and the last exercise, plus: an exercise beside a figure, a graph answer, an
   exercise at the end of a page, an exercise that continues on the next page (region continues:0), an instruction that crosses a page
   break (region context:1), a row with fractions, a three-column row, an answer of several lines, the last answer before a chapter heading.
   At least 30 exercises and 15 solution regions in all, covering every kind of layout the book has. Fix systematic errors by changing
   the proposals' arguments or by operations; apply_operations in one atomic batch, then look again.
5. exercises_propose with solutions=true and apply=true (it can be run again: what is there is skipped, what you corrected is kept and
   listed under "changed", replace=true overwrites it; use sections=[...] to leave out what you framed by hand). Then solutions_propose
   for answers that were not matched, and look at their regions.
6. validate (no errors), book_show (the counts per section next to the book's own), export_bundle, import_check (wouldImport must be true).
7. Report: where the bundle is; chapters, sections, exercises, solutions; every difference from the book's own contents or from the
   expected counts, with the page evidence; every exercise without a solution and every solution without an exercise; what you framed by
   hand; what you were unsure about.

Never invent an exercise, a number or an answer that the book does not print; never change the numbering to what you think it should be.
```

## Checklist

- [ ] Chapter and section counts, labels, titles and pages match the printed contents; the notes were read.
- [ ] Per section: the count and the first and last number match the book; every gap, duplicate and stray number is explained.
- [ ] A sample of crops (every kind of layout) looked at; no frame cuts a line, holds a neighbour or leaves a figure out; the context is the right instruction.
- [ ] Solution regions looked at (graphs, several lines, fractions, the last answer of a chapter); exercises without an answer and answers without an exercise explained.
- [ ] `validate` has no errors, `export` done, `import-check` says the bundle would import; the licence's attribution travels with the bundle (author, licence and notice of the manifest, see BUNDLE_FORMAT.md).
- [ ] The decisions and the differences from the book are recorded.
