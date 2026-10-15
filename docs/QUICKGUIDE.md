# Quick Guide: Auditing and Bundling Books

This guide explains how to prepare textbooks for **Professor Euler: Math Canvas** (the Android app),
whether processing a single book or running a batch of 20 books at once.

---

## 1. Directory Structure

A recommended workspace layout keeps input PDFs, working files, batch reports, and delivered bundles separated.
Paths can be relative to your project folder or set to any folder on your machine:

```
workspace/
  inbox/             incoming textbook PDFs to audit
  audit/             working files, internal project states, and review crops
  results/           batch acceptance outputs and INDEX.md
  bundles/           production-ready verified .mcbundle files for the tablet
  audit.config.json  workspace configuration defining your local paths
```

A template configuration is provided at [`audit.config.example.json`](../audit.config.example.json).

---

## 2. Zero-Friction Workflow (Auto-Mode)

An AI agent working with this repository can discover metadata directly from the PDF front matter.

1. **Place PDFs in `inbox/`**: Drop one or multiple textbooks (e.g., `calculus.pdf`, `linear_algebra.pdf`).
2. **Prompt the Agent**:
   > *"Please inspect the PDFs in inbox, derive their metadata sidecars and library folders, and audit them into bundles."*
3. **What the Agent Does**:
   * Scans pages 1–8 of each PDF using `suggestFrontMatter` to extract title, author, edition, license (e.g., Creative Commons, GFDL, Public Domain), and attribution notices.
   * Assigns the appropriate `libraryFolder` based on the book's subject (e.g. `Books/Calculus`, `Books/Linear Algebra`).
   * Derives chapter and section outlines (`mcprep outline derive --book`).
   * Proposes exercise regions and matches answers (`mcprep exercises propose --solutions`).
   * Refines region boundaries to pixel margins between ink rows (`--ink`).
   * Verifies against quality gates (`mcprep exercises verify`, `mcprep audit gate --final`).
   * Exports production `.mcbundle` files directly into `bundles/`.

---

## 3. Batch Auditing Multiple Books (CLI)

To audit an entire folder of books in one command:

```console
npm run build
node scripts/audit-books.mjs ./inbox --out ./results
```

* **One or more specific books:** Add `--only <name1>,<name2>`
* **Fault-tolerant:** If one book has unusual layout or prints fewer answers, the script records the finding in `results/INDEX.md` and continues processing all remaining books.
* **Review sheets:** Visual contact sheets (`sheets/*.png`) are written for every book in its results folder (red = exercise, orange = continuation, blue = instruction, green = solution).

---

## 4. What is `libraryFolder`?

In the Android app, `libraryFolder` (written as `document.folder` in `bundle.json`) organizes documents on the virtual bookshelf:

* **Format:** Up to 7 nested folder levels separated by `/` (e.g., `Books/Calculus`, `University/Physics/Year 1`).
* **Default:** If omitted, it defaults to `"Books"`.
* **Tablet import:** When an `.mcbundle` is opened on the tablet, the app automatically creates the folder structure in the document library and files the book inside.

---

## 5. Metadata Sidecar Format (`<name>.meta.json`)

To customize a book's metadata explicitly before running an audit, place `<name>.meta.json` next to `<name>.pdf`:

```json
{
  "title": "Beginning and Intermediate Algebra",
  "folder": "Books/Algebra",
  "author": "Tyler Wallace",
  "license": { "name": "CC BY 3.0", "url": "https://creativecommons.org/licenses/by/3.0/" },
  "sourceUrl": "https://wallace.ccfaculty.org/book/book.html",
  "notice": "Beginning and Intermediate Algebra by Tyler Wallace, licensed under CC BY 3.0. Original PDF unchanged."
}
```

---

## 6. Interactive Config & Metadata UI

An interactive configuration tool is included at [`docs/config-builder.html`](config-builder.html).
Open it in any modern browser to configure paths (portable relative or custom absolute paths), select category presets, and generate `.meta.json` files visually.

