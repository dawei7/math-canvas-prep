# Auditing a book as an authority

A textbook with a free licence can be audited **once**, on a computer, and then be offered to many learners: its exercises keep the
numbers the book prints (`1`, `5a`, `A.3`), they cannot be edited or renumbered on the tablet, the instruction printed for a group of
exercises is shown with each of them, and the answer key printed in the same PDF is hidden **solution context** that only the grader
sees. The bundle also carries the book's contents as sections. The contract is [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) (section 3,
"Authoritative exercises" and "Solution context", and section 4); the commands are listed in [CLI.md](CLI.md), the same tools for an agent in
[MCP.md](MCP.md); [AGENT_GUIDE.md](AGENT_GUIDE.md) explains how frames are drawn and checked.

The tool **proposes**, you **look**. What the book prints is what is proposed: a number that is printed twice, an answer that is
missing, a practice set with more exercises than the contents promise are findings for the owner of the audit, not something to hide.
Nothing leaves the machine; do not upload the PDF anywhere.

## What the tool finds

| Step | Command | Finds |
| --- | --- | --- |
| 1 | `outline derive --book` | Chapters (`c0`, label "Chapter 0") and sections (`0.1`, label `0.1`) from the printed contents, the lists on the chapter openers and the headings, with title, page, `top`, confidence, evidence, the differences between the spellings, and where each practice set lies. |
| 2 | `exercises propose` | The numbered exercises of every practice set: label as printed, section, frame, the instruction as context, optionally the solution regions. |
| 3 | `solutions propose` | The answers in the answer key, matched by (section, label); exercises without an answer and answers without an exercise. |

None of them writes anything without `--apply`; `--ops FILE` writes the operations (for `frames apply`) and `--details FILE` writes every
proposal with its evidence.

## The workflow for a person

```console
mcprep init book.pdf --title "Beginning Algebra" --folder "Books/Algebra"
mcprep outline derive --book                       # 1. read the table and the notes under it
mcprep outline derive --book --apply               #    store the sections (they carry ids; exercises refer to them)
mcprep exercises propose                           # 2. one line per section; read "To look at" first
mcprep exercises propose --solutions --ops audit.json --details audit-details.json
mcprep exercises propose --solutions --apply       #    exercises that are already in the project are skipped
mcprep solutions propose                           # 3. only when the answers are not part of step 2
mcprep validate && mcprep export --out book.mcbundle
mcprep import-check book.mcbundle
```

1. **Sections.** Check chapter and section counts against the printed contents, the titles (are typos repaired, is "&" read as "and"),
   the pages, and every line under "To look at". A title you want worded differently: `mcprep outline --json`, edit the entries,
   `mcprep outline set entries.json` (keep `id`, `label` and `top`). The bundle's contents are what the learner sees.
2. **Exercises.** Per section the table shows how many exercises were found and the first and last number. Compare with the book:
   a gap (`no line starts with the number 24`), a duplicate, a stray number put aside and a count that differs from what you expected
   are listed with the reason. Then look at a sample (below). `--max-items N` caps every section when the book prints more than the
   audit wants; `--section 1.7` proposes one section.
3. **Solutions.** The table shows answers per section. "No answer for the exercises ..." and "answers ... have no exercise" are findings:
   a book can print fewer answers than exercises. A damaged text layer can hide answers that are printed: look at the page.
4. **Look.** `mcprep crop x0_1-5` (the id is made from the section and the label) writes a PNG of the exercise, `--region context:0` of its
   instruction, `--region continues:0` of the part on the next page; `mcprep render 9 --frames --grid 0.1` shows a whole page with its frames. Look at:
   the first and the last exercise of every section; an exercise beside a figure and a graph answer; an exercise at the end of a page and one
   that goes on over the page break; an instruction that crosses a page break; a two-column row with fractions; a three-column row; a root;
   an answer of several lines; every item the commands marked with a confidence below 0.8.
5. **Fix** what is wrong with the usual operations (`update` for a rectangle, `context.set`, `delete`, `add` with `"authority": "book"`,
   `"label"` and `"section"`, `solution.add`), then look again.
6. **Validate and export.** `validate` must be clean; `export` verifies the bundle with the importer's own checks and `import-check` shows what
   the app would do with it.

Record the decisions you take (a cap, a number you accepted, an exercise you framed by hand) next to the bundle.

## Limits of the heuristics

- A stray glyph with a wrong font size (some fonts give one for a "not equal" sign) can turn several lines around it into one unreadable
  line. What was inside is not found, and the tool says so (gaps, "no answer for ..."); frame it by hand.
- Parts ((a), (b)) stay inside the exercise that carries the number; they are not split into exercises of their own.
- A book without numbered sections is read with the generic heading detection (ids `s1`, `s2`, ...) and has no practice sets to read.
- A figure is framed with the ink profile of the page, which cannot tell to which column a drawing belongs.
- Pages without a text layer (scans) cannot be read: frame them by eye (AGENT_GUIDE section 8).
- The answer key is found from a heading like "Answers - Chapter 1" or from the contents; an answer that is only a picture is framed only
  when its number stands in the text layer.

## Instruction block for an AI agent

Paste this into the agent's task; it assumes the `mcprep` MCP server (or the command line) and that the agent can look at images.

```text
Audit the textbook PDF <path> for Math Canvas as an authority, entirely on this machine (do not upload the PDF or any page of it).
First read the resource mcprep://guide (or call get_guide), then docs/AUDIT_A_BOOK.md if you have the repository.

1. create_project (title = the book's title, folder = where it belongs in the library).
2. outline_derive_book. Read "notes" and every entry with confidence below 0.9. Check the number of chapters and sections against the printed
   contents (render_page of the contents pages), the titles, the pages. If the proposal is right, outline_derive_book with apply=true;
   if a title or a page is wrong, apply_operations with one outline.set operation that holds your corrected entries (keep id, label and top).
3. exercises_propose with solutions=true and details_file set, without apply. Read the result: per section the count, first and last
   number, gaps, duplicates, rejected numbers, notes. For every difference from what the book promises (a count, a missing number,
   a number printed twice) collect the page evidence and decide: it is what the book prints, so keep it and report it, unless the tool
   misread the page (then fix the frames).
4. Look. With render_crop look at, per section, the first and the last exercise, plus: an exercise beside a figure, a graph answer, an
   exercise at the end of a page, an exercise that continues on the next page (region continues:0), an instruction that crosses a page
   break (region context:1), a row with fractions, a three-column row, an answer of several lines. At least 30 exercises and 15
   solution regions in all, covering every kind of layout the book has. Fix systematic errors by changing the proposals' arguments or
   by operations; apply_operations in one atomic batch, then look again.
5. exercises_propose with solutions=true and apply=true (skip sections you fixed by hand: use sections=[...]). Then solutions_propose
   for answers that were not matched, and look at their regions.
6. validate (it must be clean), export_bundle, import_check (wouldImport must be true).
7. Report: where the bundle is; chapters, sections, exercises, solutions; every difference from the book's own contents or from the
   expected counts, with the page evidence; every exercise without a solution and every solution without an exercise; what you framed by
   hand; what you were unsure about.

Never invent an exercise, a number or an answer that the book does not print; never change the numbering to what you think it should be.
```

## Checklist

- [ ] Chapter and section counts, labels, titles and pages match the printed contents; the notes were read.
- [ ] Per section: the count and the first and last number match the book; every gap, duplicate and stray number is explained.
- [ ] A sample of crops (every kind of layout) looked at; no frame cuts a line, holds a neighbour or leaves a figure out; the context is the right instruction.
- [ ] Solution regions looked at (graphs, several lines, fractions); exercises without an answer and answers without an exercise explained.
- [ ] `validate` clean, `export` done, `import-check` says the bundle would import; the licence's attribution travels with the bundle (author, licence and notice of the manifest, see BUNDLE_FORMAT.md).
- [ ] The decisions and the differences from the book are recorded.
