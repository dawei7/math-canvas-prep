import { buildSectionTree, describeSection, findSection, isWithin, sectionOfFrame } from '../book/sections.js';
import { bookKeyOf, isAuthoritative, labelStyleProblem } from '../model/authority.js';
import { compareReadingOrder } from '../model/numbering.js';
import type { Frame, OutlineEntry } from '../model/types.js';
import { issue, type Issue } from './issues.js';

/**
 * The rules that look at more than one frame, or at the frames together with the outline (docs/BUNDLE_FORMAT.md,
 * "Authoritative exercises"): the pair (section, label) is unique, and every section names an outline entry. What is
 * wrong here the importer rejects (errors); `lintBook` adds the warnings.
 */

const authoritativeInReadingOrder = (frames: readonly Frame[]): Frame[] => frames.filter(isAuthoritative).sort(compareReadingOrder);

export function checkBook(frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined): Issue[] {
  const issues: Issue[] = [];
  const book = authoritativeInReadingOrder(frames);
  if (book.length === 0) return issues;

  const first = new Map<string, Frame>();
  for (const frame of book) {
    const key = bookKeyOf(frame);
    if (key === undefined) continue;
    const earlier = first.get(key);
    if (!earlier) {
      first.set(key, frame);
      continue;
    }
    issues.push(
      issue('error', 'duplicate-exercise', `${frame.id} and ${earlier.id} are both exercise "${frame.label as string}" of section "${frame.section as string}"; the pair (section, label) must be unique.`, {
        frameId: frame.id,
        page: frame.page,
        fix: `If ${frame.id} is another exercise, give it its own label (\`mcprep exercises label ${frame.id} <label>\`). If it is a copy (for example the same batch applied twice), delete it (\`mcprep frames delete ${frame.id}\`).`,
        data: { other: earlier.id, section: frame.section, label: frame.label },
      }),
    );
  }

  const ids = new Set<string>();
  for (const entry of outline ?? []) if (entry.id !== undefined) ids.add(entry.id);
  const known = [...ids];
  const shown = `${known.slice(0, 8).join(', ')}${known.length > 8 ? ', ...' : ''}`;
  for (const frame of book) {
    if (frame.section === undefined || ids.has(frame.section)) continue;
    const reason =
      ids.size === 0
        ? `the project has no outline entry with an id (the sections of a book are the entries of its outline)`
        : `no outline entry has that id (known: ${shown})`;
    issues.push(
      issue('error', 'section-unknown', `The section "${frame.section}" of ${frame.id} (exercise "${frame.label as string}") does not exist: ${reason}.`, {
        frameId: frame.id,
        page: frame.page,
        fix:
          ids.size === 0
            ? 'Give the book its sections first (`mcprep outline pdf --adopt`, `outline derive` or `outline set`, then `outline ids`), then use the ids with `exercises section`.'
            : `File it under an existing section (\`mcprep outline\` lists their ids): \`mcprep exercises section ${frame.id} <id>\`, or add the section: \`mcprep outline add --title "..." --page <n> --id ${frame.section}\`.`,
        data: { section: frame.section },
      }),
    );
  }
  return issues;
}

/** Warnings about authoritative exercises: labels written with the punctuation the book prints, and exercises filed under a section other than the one they are printed in. */
export function lintBook(frames: readonly Frame[], outline: readonly OutlineEntry[] | undefined, pageCount: number): Issue[] {
  const issues: Issue[] = [];
  const book = authoritativeInReadingOrder(frames);
  if (book.length === 0) return issues;
  const tree = buildSectionTree(outline ?? [], pageCount);
  for (const frame of book) {
    if (frame.label !== undefined) {
      const style = labelStyleProblem(frame.label);
      if (style !== undefined) {
        issues.push(
          issue('warning', 'label-style', `The label "${frame.label}" of ${frame.id} ${style}; a label is the number as the book prints it, without the closing "." or ")".`, {
            frameId: frame.id,
            page: frame.page,
            fix: `Write it as the bare number: \`mcprep exercises label ${frame.id} <label>\`.`,
          }),
        );
      }
    }
    if (frame.section === undefined) continue;
    const claimed = findSection(tree, frame.section);
    if (!claimed) continue;
    const located = sectionOfFrame(tree, frame);
    if (located && isWithin(tree, located, claimed)) continue;
    const nearest = sectionOfFrame(tree, frame, { withId: true });
    const where = located ? `in section "${describeSection(located.entry)}"${located.id === undefined ? '' : ` (${located.id})`}` : 'above the first outline entry';
    issues.push(
      issue('warning', 'section-mismatch', `${frame.id} (exercise "${frame.label ?? '?'}") is printed on page ${frame.page} ${where}, but it is filed under section "${describeSection(claimed.entry)}" (${frame.section}).`, {
        frameId: frame.id,
        page: frame.page,
        fix: nearest?.id !== undefined
          ? `If it belongs to ${nearest.id}: \`mcprep exercises section ${frame.id} ${nearest.id}\`. If the section "${frame.section}" really starts elsewhere, correct its page or top in the outline.`
          : 'Check the outline: the start page and top of the sections decide where each one runs.',
        data: { section: frame.section, printedIn: nearest?.id ?? null },
      }),
    );
  }
  return issues;
}
