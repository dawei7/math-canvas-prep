# Math Canvas Prep

Prepare a PDF once, on the desktop, and hand it to *Professor Euler: Math Canvas* ready to study: every exercise,
question and bookmark marked, the context that belongs to an exercise attached, and a table of contents. A person can
do it in a desktop app; an AI agent can do it through a command line or an MCP server. The result is a single
**bundle** file (`.mcbundle`: the PDF plus its metadata) that the Android app imports straight into its library.

> **Status: work in progress.** The bundle format ([docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md)) is written down first;
> the tools are being built against it.

## Two ways to mark a PDF

1. **On the fly, in the Android app.** Reading a PDF on the tablet, the learner can frame an exercise, cut it into parts,
   attach its context or bookmark a page at any moment. That stays a full feature of the app.
2. **In advance, here.** When a whole book or an exam collection should be prepared efficiently, by hand or by an agent,
   this repository's tools do it on a computer and write a bundle. Copy the bundle to the tablet and open it in the library.

## What is in this repository

| Part | What it is |
| --- | --- |
| `packages/core` | The model, validation, numbering, text-line analysis, exercise proposals and bundle reader/writer. No UI. |
| `packages/cli` | `mcprep`, a command line for scripts and agents: inspect a PDF, add and edit frames, validate, render, export. |
| `packages/mcp` | An MCP server exposing the same operations as tools to AI agents. |
| `apps/desktop` | The Electron app: a visual editor over the same project file, which also updates live when an agent edits it. |
| `docs/` | The bundle format, the project file, the CLI, the MCP tools and the **agent guide**. |

## For AI agents

Read [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md). It explains the coordinate system, how to find where an exercise starts
and ends, how to cut an exercise into parts, how to attach context, how to check the result by looking at rendered crops,
and how to export.

## Privacy

PDFs and projects stay on your computer. The tools make no network calls and send nothing anywhere. This repository
contains no real textbooks or exams; its examples are synthetic.

## Licence

No licence has been chosen yet; until one is, all rights are reserved.
