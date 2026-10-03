# Agent guide for working on this repository

This file is for an AI agent that **develops** Math Canvas Prep. (An agent that **uses** the tool to mark a PDF should read
[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) instead.)

- The contract with the Android app is [docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md). Change it only deliberately: a change
  that an existing reader would misread needs a new `version`. Keep the code, the schema and the document in step.
- Structure: `packages/core` has no UI and no Electron dependency and holds the model and every rule; `packages/cli` and
  `packages/mcp` are thin; `apps/desktop` is a visual editor over the same project file. Put logic in `core` and test it there.
- No network calls anywhere in the tools. No telemetry. No real textbooks, exams, personal data or keys in the repository:
  examples and test fixtures are generated and synthetic.
- Numbers (`E4.2`, `Q1`, `B3`) are never stored: they are computed from position, exactly as the Android app does.
- TypeScript in strict mode; every rule has a unit test; run the full test suite and the linter before committing.
- Keep documentation compact and factual. Do not describe planned work as done.
- No licence has been chosen; do not add one, and do not claim one in any file.
- Commits: short imperative subject, a plain-sentence body, and no secrets.
