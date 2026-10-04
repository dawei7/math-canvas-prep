# Reading a bundle in your own app

A `.mcbundle` is a ZIP with four files. This page is for the program that *uses* a bundle, for example an app that offers an audited book to
learners. The contract is [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md); this page says how to use it. A complete reader in about forty lines of Python
(standard library only) is [`examples/read-bundle.py`](../examples/read-bundle.py).

## What is inside

| File | What you take from it |
| --- | --- |
| `bundle.json` | The title, the author, the licence, the source address and the **notice** the licence asks you to show with the work; the PDF's SHA-256 and size; `features` (which of `sections`, `authority`, `solution` the writer used). |
| `document.pdf` | The book, byte for byte. Never modified; every position in the other files refers to it. |
| `outline.json` | The **sections**: chapters and sections as entries with `title`, `page`, `depth` and, for a book that was audited, an `id`, the printed `label` and the `top` of the heading on its page. |
| `frames.json` | The marked regions. For an audited book each exercise is a frame with `"authority": "book"`, the printed `label`, the `section` it belongs to, its instruction regions (`context`) and its answer regions (`solution`). |

Verify before you trust: the hash of `document.pdf`, the limits and the entry names (BUNDLE_FORMAT.md section 5, or just run `mcprep
import-check book.mcbundle`, which does what the Android importer does and says why it would refuse).

## Sections

The sections are the entries of `outline.json`. A chapter is an entry of depth 0, a section one of depth 1. An entry that exercises belong to has an
`id` (`0.1`, `c3`); the exercises name it in their `section`. A section runs from its page (and `top`) to the next entry of the same or a lower
depth. For an overview with the counts already worked out, `mcprep book export --out book.book.json` writes a plain JSON summary (format
`math-canvas-book-summary`, see `mcprep schema book-summary`): per section its id, label, title, page, the number of exercises (own and including
the sections below), how many have an answer, and the first and last label.

## Exercises: the address is (section, label)

An authoritative exercise is addressed by its section and the number the book prints: `0.1` and `5`, or `1.2` and `5a`. The label is a string
(`5`, `5a`, `A.3`, `II-4`), never a position: do not sort numerically and do not renumber. The pair is unique in the bundle. Exercises a learner
adds later in your app are ordinary and have no label; keep your own numbering for them.

An exercise has one **region**: `page` (zero-based) and `rect` (`left`, `top`, `right`, `bottom`, fractions of the page as displayed, origin at the
top left). To draw it, render the PDF page and cut out `rect`; with a page of `w x h` points at a scale `s`, the box is
`left*w*s, top*h*s, (right-left)*w*s, (bottom-top)*h*s`. It may have `continues` (more regions of the same task, on the next column or page).

Show, in this order, the `context` regions (the instruction printed for a group of exercises: "Evaluate each expression.") and then the exercise's own
regions.

## Solutions are for grading only

`solution` holds regions of the same PDF where the answer is printed (the answer key at the back of the book): usually one small region for each
exercise, the line "22) 0". They are **hidden**: do not show them with the exercise, do not put them into a tutor chat, do not export them for the
learner. Give them to whatever grades the learner's work (as image crops and, if you have it, the PDF text of those regions), labelled as the answer
key. They are not a security boundary: the PDF still contains the answer pages. If that matters to you, do not offer those pages to the learner (the
pages are the ones the `solution` regions lie on).

## Licence and attribution

`document.license`, `document.sourceUrl`, `document.author` and `document.notice` are there so that the attribution a licence such as CC BY asks for
travels with the work. Show them where you show details of the book.

## Coordinates and numbering in short

Pages are zero-based. Rectangles are fractions of the displayed page (after the page's own rotation). The numbers `E1`, `E2.1`, `Q1` that the tools and
the Android app show for **ordinary** frames are computed from position and never stored; authoritative frames are not part of that numbering.
