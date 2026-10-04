import type { Frame, OutlineEntry, Rect } from '../src/model/types.js';
import { newProject, type Project } from '../src/project/model.js';

/** A project on a PDF of `pageCount` pages with nothing in it. */
export const emptyProject = (pageCount = 6): Project => newProject({ pdf: { path: 'book.pdf', sha256: 'a'.repeat(64), bytes: 1, pageCount }, title: 'A Book' });

/** An outline of two chapters with sections, in the style of a textbook: ids, printed labels and heading positions. */
export const bookOutline = (): OutlineEntry[] => [
  { title: 'Chapter 1 Sets', page: 0, depth: 0, id: 'c1', label: 'Chapter 1' },
  { title: '1.1 Sets', page: 0, depth: 1, id: '1.1', label: '1.1', top: 0.3 },
  { title: '1.2 Maps', page: 1, depth: 1, id: '1.2', label: '1.2', top: 0.1 },
  { title: 'Chapter 2 Numbers', page: 3, depth: 0, id: 'c2', label: 'Chapter 2' },
  { title: '2.1 Integers', page: 3, depth: 1, id: '2.1', label: '2.1', top: 0.2 },
];

export const area = (top: number, bottom: number, left = 0.1, right = 0.9): Rect => ({ left, top, right, bottom });

/** An authoritative exercise of the book on `page` between `top` and `bottom`. */
export function bookFrame(id: string, section: string, label: string, page: number, top: number, bottom: number, extra: Partial<Frame> = {}): Frame {
  return { id, kind: 'exercise', page, rect: area(top, bottom), authority: 'book', label, section, ...extra };
}

export function ordinary(id: string, page: number, top: number, bottom: number, extra: Partial<Frame> = {}): Frame {
  return { id, kind: 'exercise', page, rect: area(top, bottom), ...extra };
}

/** A project with the textbook outline and the given frames. */
export function bookProject(frames: Frame[] = [], pageCount = 6): Project {
  return { ...emptyProject(pageCount), outline: { source: 'manual', entries: bookOutline() }, frames };
}
