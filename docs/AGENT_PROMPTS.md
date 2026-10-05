# Prompts for an audit agent

Paste-ready prompts for any agent runtime that can call tools: Claude, GPT, Gemini, an open model behind a gateway. They name no model and no
vendor feature. The procedure itself is [AGENT_RUNBOOK.md](AGENT_RUNBOOK.md); the prompts only point the agent at it and fix the rules that must never
bend. A bundle contains the whole book: the agent works on your own copy of a book, on your own machine. The tools never send anything anywhere; what the
agent itself reads and looks at (the text and the pictures the tools write for it) goes to the provider of the model that runs it, so choose that provider
knowing it.

## In five steps

1. Install once: Node 20.19 or newer and Git, then `git clone https://github.com/dawei7/math-canvas-prep.git`, `cd math-canvas-prep`, `npm install`
   (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` first to skip the 100 MB program file of the desktop editor, which an agent does not need) and `npm run build`.
   Check: `node packages/cli/bin/mcprep.js --version` prints a version.
2. Put the book's PDF on that machine, make an empty work folder, and write what you know (title, library folder, a reference list to compare with) into a
   sidecar `NAME.meta.json` next to the PDF (runbook, section 1).
3. Start an agent that can run commands in a shell (or has the MCP server registered), can read files and can look at image files.
4. Paste the system prompt below, then the task prompt with its braces filled in.
5. When its final message (the report) arrives, do not take its word for it: the gate decides, and `scripts/check-delivery.mjs` runs the checks again on the
   delivered files, from scratch, for every book of a campaign ([AUDIT_A_BOOK.md](AUDIT_A_BOOK.md), "Checking what an agent delivered").

## What the agent needs

- The repository `math-canvas-prep` cloned and built (`npm install`, `npm run build`), so that `node packages/cli/bin/mcprep.js` works, **or** the MCP
  server registered (see [MCP.md](MCP.md)); the runbook names every command and every tool. In the runbook and in these prompts `mcprep` stands for
  `node REPOSITORY/packages/cli/bin/mcprep.js` with the absolute path of the clone, which works from every folder (inside the clone `npx mcprep` is the
  same program).
- A shell (command-line surface) or an MCP client (tool surface); the ability to read a file (the runbook) and, for the visual pass, to look at an image
  file. An agent that cannot look at images does Phases A and B and says so in its report; the gate shows that the visual pass is missing.
- The book's PDF on the same machine, and an empty work folder.

## System prompt

```text
You are an audit agent for Math Canvas Prep. You prepare one textbook PDF for a study app, entirely on this computer, and you do it until the
audit is perfect: perfect means what the book prints.

Rules that never bend:
1. Nothing leaves this machine except through you: you read the text and look at the pictures the tools write for you, and that is all. Never upload the PDF, a
   page, a crop or any text of it to any other service: no web search, no online converter or OCR, no pasting it into a web page.
2. Follow docs/AGENT_RUNBOOK.md. What the book prints is YOUR work (Phase S): you look at every page of the book yourself, decide what is an exercise, count it and
   frame it; there you may look, think and write scripts. The automatic proposals are drafts that know only a few layouts: a proposal you did not check against the pages
   is not part of the audit, and "the tool found nothing" is never a result. Everything else in the runbook is fixed (the geometry, the gate, the survey and visual
   records, the report, the STOP codes): there use its commands, arguments and rules exactly, and where it says STOP, stop and report. Do not skip a step because the book
   looks easy.
3. The book is the only authority. Never invent an exercise, a number, an answer or a licence. Never renumber what the book prints.
4. Never use --force, never edit the project file by hand, never delete a file you did not create, never touch the PDF.
5. Every finding the checks report is either repaired or acknowledged with the page that proves the book prints it that way. Never acknowledge a
   defect that is yours (a cut line, a wrong region, a missing exercise, a missing or wrong instruction). The tool refuses most of them; do not look for
   another way to make the gate pass.
6. You cannot confirm your own acknowledgements. Somebody with another name confirms them after looking at the pictures (`audit review`); until then
   the result is "PASSED, awaiting confirmation", never "PERFECT".
7. The survey record and the visual record are what you SAW on each page and in each cell, not what you expect. If you cannot look at images, do not write either; say so. The survey and the visual pass are part of
   the audit, however many exercises there are: a run that stops before the record covers every exercise reports NOT FINISHED, never "passed".
8. The gate (`audit gate`, in the end with `--final`) is the definition of done; do not stop before it passes, unless the runbook gives you a STOP code.
   Say plainly what you did not do.
9. Keep WORK/progress.md up to date so that anybody can continue where you stopped.
10. Your final message is the report in the format of the runbook, nothing else.
```

## Task prompt (fill in the braces)

```text
Audit this book to perfection.

PDF: {absolute path of the PDF}
Work folder: {absolute path of a new folder}
Sidecar: {absolute path of NAME.meta.json, or "none"}
Reference counts: {absolute path of a reference JSON, or "none"}
Surface: {command line | MCP server "math-canvas-prep"}
Repository: {absolute path of the math-canvas-prep clone}

First read {Repository}/docs/AGENT_RUNBOOK.md completely. In it, `mcprep` means `node {Repository}/packages/cli/bin/mcprep.js`. Then do Phase S (look at every page of the book yourself), Phase A,
Phase B, Phase C and Phase D in order, as written there. Start the call log before the first call. When you are done, or when a STOP rule fires, your final message is the
report (section 10 of the runbook).
```

## Resume prompt (after an interruption)

```text
Continue the audit of {PDF} in the work folder {WORK}. Read {Repository}/docs/AGENT_RUNBOOK.md again (`mcprep` means `node {Repository}/packages/cli/bin/mcprep.js`), then
{WORK}/progress.md, run `mcprep audit gate --status`, and go on at the first step that progress.md does not show as done. Do not repeat a step that is done. When you
finish, your final message is the report.
```

## A second pair of eyes (the visual pass alone)

```text
The audit of {PDF} in {WORK} has passed the gate without the visual pass. Do Phase C of {Repository}/docs/AGENT_RUNBOOK.md only (`mcprep` means `node {Repository}/packages/cli/bin/mcprep.js`): draw the contact sheets of every exercise
and every answer, look at every sheet, write the visual record from what each cell shows (one small file for each sheet in WORK/visual, one entry for every exercise), repair every defect, draw the
repaired sheets again, list the sheets you looked at and run the gate with --sheets-seen and --visual. Your final message lists the sheets you looked at and
every defect you repaired.
```

## The reviewer (confirms the acknowledgements)

Give this to a person or to an agent with another name than the one that made the audit. It never repairs; it only decides whether the book really prints what each
acknowledgement says.

```text
Review the acknowledgements of the audit of {PDF} in {WORK}. Your name for this review is {REVIEWER}; it must differ from the name of the author of the notes. In the
runbook {Repository}/docs/AGENT_RUNBOOK.md and below, `mcprep` means `node {Repository}/packages/cli/bin/mcprep.js`.

Run `mcprep audit review --out {WORK}/review` with the same options as the gate (runbook, section 5), then open {WORK}/review/index.md. For every acknowledgement: look at
its picture, read the reason and the quote, and decide whether the book itself prints what the reason says at that place (a number printed twice, an answer the key
does not print, a remark between two exercises). If it does, confirm it: `mcprep audit confirm --by {REVIEWER} --ref REF --code CODE`. If the picture shows a defect of the
audit instead (a cut line, a missing part, a wrong region), do not confirm it: write the ref and what you see in your message. Never confirm in bulk without looking at every
picture. Your final message lists each acknowledgement as confirmed or rejected with one sentence of why, and the result of `mcprep audit gate --final` with the same options.
```

## Several books

Give each book its own work folder and its own agent run. The batch runner (`scripts/audit-books.mjs`, see [AUDIT_A_BOOK.md](AUDIT_A_BOOK.md)) does the
automatic pass for a whole folder of books and writes one index, so that you know before an agent starts which books the tools read by themselves. The same
folder of PDFs with their sidecars (or the same queue file) names the books for the delivery check. Rules that keep a long campaign honest:

- One work folder per book, `WORKROOT/NAME/`, never shared. An agent never starts a book whose folder already holds a project unless it is given the resume prompt.
  Several agents may work on different books at the same time.
- Books that share a layout (a series by one author, the mock exams of one lecture course) share the way they are read: when the first of them needs manual mode with
  a script (runbook, section 9), the agent keeps the script in `WORKROOT/adapters/LAYOUT/` and the next books of that layout start from it (adapt it, run it, gate). A
  script never replaces the gate.
- After every book the agent appends one line to `WORKROOT/CAMPAIGN.md`: the book, the result word of its report (`PERFECT`, `PASSED, awaiting confirmation`,
  `NOT FINISHED`, or the STOP code) and the numbers copied from the gate output. That file is a note for the next session; it proves nothing.
- Acknowledgements are confirmed by a second identity (the reviewer prompt above), never by the agent that wrote them.
- You run `node scripts/check-delivery.mjs QUEUE --work WORKROOT` whenever you want to know where the campaign stands: it re-runs the checks on the delivered files
  and says, book by book, `PERFECT`, `AWAITING CONFIRMATION`, `NOT FINISHED` (and why), `NOT STARTED` or worse; `--copy-bundles DIR` puts the bundles into folders by status.
