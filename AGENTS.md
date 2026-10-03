# Agent guide for working on this repository

This file is for an AI agent that **develops** Math Canvas Prep. (An agent that **uses** the tool to mark a PDF should read
[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) instead.)

## Rules

- The contract with the Android app is [docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md). Change it only deliberately: a change
  that an existing reader would misread needs a new `version`. Keep the code, the schemas and the document in step.
- `packages/core` has no UI and no Electron dependency and holds the model and every rule; `packages/cli` and `packages/mcp` are
  thin; `apps/desktop` is a visual editor over the same project file and uses the same operations and checks. Put logic in
  `core` and test it there. The browser-safe part of the core is `@mcprep/core/pure` (the editor's window imports only that).
- No network calls anywhere in the tools. No telemetry. No real textbooks, exams, personal data or keys in the repository:
  examples and test fixtures are generated in code (`@mcprep/core/testing`) and synthetic.
- Pages are zero-based; rectangles are fractions of the page as displayed (after `/Rotate`), origin top left. Numbers (`E4.2`,
  `Q1`, `B3`) are never stored: they are computed from position, exactly as the Android app does.
- A new dependency must be permissively licensed (MIT, Apache-2.0, BSD, ISC) and goes into
  [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) (`npm run docs:licenses -- --write` refreshes the tables).
- No licence has been chosen; do not add one, and do not claim one in any file.
- Keep documentation compact and factual. Do not describe planned work as done. When the number of tests changes, update the
  numbers in `README.md` and `docs/DESKTOP.md`.

## Commands

```console
npm run build         # tsc for the packages, then typecheck and bundle of the desktop app
npm test              # unit tests (Vitest, against the sources)
npm run lint          # ESLint over everything, with type information
npm run test:e2e      # needs a build: the CLI binary, the MCP server over stdio, and the desktop app (needs a display and Electron's file)
npm run docs          # regenerate docs/CLI.md and the tool reference in docs/MCP.md; commit the result
node examples/build-examples.mjs   # regenerate examples/ after changing the sample, the guide or the CLI output
npm run desktop       # start the editor from the checkout
```

Run build, lint, tests and, if you touched anything the examples or docs show, the two generators before committing.

## Things that have gone wrong before

- **Look at the window.** `npm run screenshots --workspace @mcprep/desktop` writes the pictures of `docs/DESKTOP.md` from the
  built application. Open them: two real defects (notices that collapsed to a 30 px pill because they shared a class name with
  the help buttons, and slicer buttons with white glyphs on white) passed every assertion and were found only by looking.
  Never name a CSS class `info`, `error` or `agent` on its own (they are styled for other things).
- **`ELECTRON_RUN_AS_NODE`.** Some terminals set it; Electron then runs as plain Node and the window never opens. `npm run desktop`,
  the screenshots script and the Playwright test remove it from the environment; do the same when you start Electron yourself.
- **Lockfile registry.** On some machines npm writes a mirror's address into `package-lock.json`. Run `node scripts/fix-lockfile.mjs`
  before committing it.
- **Shell quoting.** Heredocs in some shells turn `\n`, `\f` and `\a` in your text into control characters. Write files that
  contain backslashes (LaTeX, regular expressions, Windows paths) with an editor tool, not with `echo` or a heredoc.
- **Scratch files.** Keep scratch scripts, builds and screenshots outside the repository (`apps/desktop/release/`, `out/`, `dist/`
  are git-ignored build output; delete them when you are done).
- Commits: short imperative subject, a plain-sentence body, and no secrets.
