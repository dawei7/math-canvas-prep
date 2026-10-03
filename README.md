# Math Canvas Prep

Prepare a PDF once, on the desktop, and hand it to *Professor Euler: Math Canvas* ready to study: every exercise, part,
question and bookmark marked, the context that belongs to an exercise attached, and a table of contents. An AI agent does it
through a command line or an MCP server; a person will do it in a desktop app (see Status). The result is a single **bundle** file
(`.mcbundle`: the PDF plus its metadata) that the Android app imports straight into its library.

## Status

| Part | State |
| --- | --- |
| `packages/core` | Works. Model, rules, numbering, PDF reading and rendering, proposals, project file, bundle writer and importer check. 266 tests. |
| `packages/cli` (`mcprep`) | Works. The whole workflow, `--json` everywhere. 43 tests. |
| `packages/mcp` | Works. 33 tools over stdio. 8 tests, plus end-to-end tests of the built server. |
| `apps/desktop` | Not finished: see `docs/DESKTOP.md` for what exists. |
| Docs | [Agent guide](docs/AGENT_GUIDE.md), [CLI](docs/CLI.md), [MCP](docs/MCP.md), [project file](docs/PROJECT_FILE.md), [bundle format](docs/BUNDLE_FORMAT.md), [dependencies](docs/DEPENDENCIES.md). |

The bundle format ([docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md)) is the contract with the Android app; the writer and the
importer check implement every rule of it.

## Quick start

You need Node 20.19 or newer.

```console
git clone https://github.com/dawei7/math-canvas-prep.git
cd math-canvas-prep
npm install
npm run build
```

### For an AI agent

Give the agent [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) (`npx mcprep guide` prints it) and either the command line or the MCP
server.

```console
npx mcprep init analysis.pdf --title "Analysis 1: Sheets" --folder "University/Analysis"
npx mcprep info
npx mcprep propose --ops batch.json      # offline heuristics, with their evidence; nothing is applied
npx mcprep frames apply batch.json       # one atomic batch, one validation
npx mcprep crop --all                    # PNGs of every frame: look at them
npx mcprep validate
npx mcprep export                        # analysis.mcbundle, checked as the Android importer would
```

Every command takes `--json`, never prompts and never uses the network. To register the MCP server in Claude Code, Claude
Desktop or another client see [docs/MCP.md](docs/MCP.md). A real session with every output is in
[examples/agent-session.md](examples/agent-session.md).

### For a person

Until the desktop app is finished, use the command line the same way, or let an agent do the marking and look at the result in
the rendered images (`npx mcprep render 3 --frames --grid 0.1`). Copy the `.mcbundle` to the tablet and open it in the Math
Canvas library.

## What is in this repository

| Part | What it is |
| --- | --- |
| `packages/core` | The model, validation, numbering, text-line analysis, proposals, PDF reading and rendering, the project file and the bundle reader and writer. No UI. |
| `packages/cli` | `mcprep`, a command line for scripts and agents: inspect a PDF, add and edit frames, validate, render, export. |
| `packages/mcp` | An MCP server exposing the same operations as tools. |
| `apps/desktop` | The Electron app (a visual editor over the same project file). |
| `schemas/` | JSON Schemas of the manifest, frames, outline and project file. |
| `examples/` | A synthetic sample sheet, its project, its bundle and a transcript of marking it; `build-examples.mjs` rebuilds them. |
| `docs/` | The bundle format, the project file, the CLI, the MCP tools and the agent guide. |

## Two ways to mark a PDF

1. **On the fly, in the Android app.** Reading a PDF on the tablet, the learner can frame an exercise, cut it into parts, attach its
   context or bookmark a page at any moment. That stays a full feature of the app.
2. **In advance, here.** When a whole book or an exam collection should be prepared efficiently, by hand or by an agent, these tools
   do it on a computer and write a bundle. Copy the bundle to the tablet and open it in the library.

## Privacy

PDFs and projects stay on your computer. The tools make no network calls and send nothing anywhere. This repository contains no
real textbooks or exams; its examples and test fixtures are generated.

## Development

```console
npm run build        # TypeScript for the packages, the desktop app's bundles
npm test             # unit tests (Vitest, against the sources)
npm run lint
npm run test:e2e     # the built binary and the MCP server over stdio (build first)
npm run docs         # regenerate docs/CLI.md and the tool reference of docs/MCP.md
node examples/build-examples.mjs   # rebuild the examples after a build
```

## Licence

No licence has been chosen yet; until one is, all rights are reserved.
