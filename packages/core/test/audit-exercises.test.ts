import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument } from '../src/pdf/document.js';
import type { PageText, Rect } from '../src/model/types.js';
import { deriveSections, type BookStructure } from '../src/audit/sections.js';
import { exerciseId, proposeExercises, type BookExercises, type ExerciseProposal } from '../src/audit/exercises.js';
import { buildSyntheticBook, type BookAnchor, type BookTruthItem, type SyntheticBook } from '../src/testing/book.js';

const inside = (rect: Rect, anchor: BookAnchor): boolean => anchor.x >= rect.left && anchor.x <= rect.right && anchor.y >= rect.top && anchor.y <= rect.bottom;

function regionsOf(proposal: ExerciseProposal): { page: number; rect: Rect }[] {
  return [{ page: proposal.page, rect: proposal.rect }, ...(proposal.continues ?? [])];
}

/** Whether the proposal's regions hold the anchor. */
const holds = (proposal: ExerciseProposal, anchor: BookAnchor): boolean => regionsOf(proposal).some((region) => region.page === anchor.page && inside(region.rect, anchor));

describe('exercises of the synthetic book', () => {
  let book: SyntheticBook;
  let doc: PdfDocument;
  let pages: PageText[];
  let structure: BookStructure;
  let result: BookExercises;
  const proposals = (): ExerciseProposal[] => result.sections.flatMap((section) => section.proposals);
  const proposalFor = (item: BookTruthItem): ExerciseProposal | undefined => proposals().find((proposal) => proposal.section === item.section && proposal.label === item.label);
  beforeAll(async () => {
    book = buildSyntheticBook();
    doc = await PdfDocument.fromBytes(book.pdf);
    pages = await doc.allPageText({ fonts: true, ink: true });
    structure = deriveSections(pages);
    result = proposeExercises(pages, structure.entries);
  });
  afterAll(async () => {
    await doc.close();
  });

  it('finds every numbered item of every practice set, nothing else, with no gaps', () => {
    expect(result.sections.map((section) => section.section)).toEqual(['0.1', '0.2', '1.1', '1.2']);
    for (const section of result.sections) {
      const expected = book.truth.items.filter((item) => item.section === section.section).map((item) => item.label);
      expect(section.proposals.map((proposal) => proposal.label), section.section).toEqual(expected);
      expect(section.gaps, section.section).toEqual([]);
      expect(section.duplicates, section.section).toEqual([]);
      expect(section.rejected, section.section).toEqual([]);
    }
    expect(proposals().length).toBe(book.truth.items.length);
  });

  it('reports a section with its first and last label and no notes when everything is in order', () => {
    const first = result.sections[0];
    expect([first?.first, first?.last]).toEqual(['1', '70']);
    for (const section of result.sections) expect(section.notes, section.section).toEqual([]);
  });

  it('keeps the text of an item inside its frame and the text of every other item outside', () => {
    for (const item of book.truth.items) {
      const proposal = proposalFor(item);
      expect(proposal, `${item.section} ${item.label}`).toBeDefined();
      if (!proposal) continue;
      for (const anchor of item.anchors) expect(holds(proposal, anchor), `${item.section} ${item.label} should hold ${JSON.stringify(anchor)} in ${JSON.stringify(proposal.rect)}`).toBe(true);
      for (const other of book.truth.items) {
        if (other === item || other.section !== item.section) continue;
        for (const anchor of other.anchors) {
          if (anchor.page !== proposal.page && !(proposal.continues ?? []).some((region) => region.page === anchor.page)) continue;
          expect(holds(proposal, anchor), `${item.section} ${item.label} must not hold ${other.label} at ${JSON.stringify(anchor)} (${JSON.stringify(proposal.rect)})`).toBe(false);
        }
      }
    }
  });

  it('never holds an instruction line or an answer-key line inside an item frame', () => {
    for (const proposal of proposals()) {
      for (const instruction of book.truth.instructions) {
        for (const anchor of instruction.anchors) expect(holds(proposal, anchor), `${proposal.section} ${proposal.label} holds an instruction line`).toBe(false);
      }
    }
  });

  it('keeps every frame in the page, below the header and above the footer', () => {
    for (const proposal of proposals()) {
      for (const region of regionsOf(proposal)) {
        expect(region.rect.left).toBeGreaterThanOrEqual(0);
        expect(region.rect.right).toBeLessThanOrEqual(1);
        expect(region.rect.top).toBeGreaterThan(0.07);
        expect(region.rect.bottom).toBeLessThan(0.93);
        expect(region.rect.bottom - region.rect.top).toBeGreaterThan(0.012);
      }
    }
  });

  it('gives the instruction that governs an item as its context, also when it crosses a page break', () => {
    for (const item of book.truth.items) {
      const proposal = proposalFor(item) as ExerciseProposal;
      const instruction = book.truth.instructions[item.instruction];
      expect(instruction, `${item.section} ${item.label}`).toBeDefined();
      for (const anchor of instruction?.anchors ?? []) {
        expect(
          proposal.context.some((region) => region.page === anchor.page && inside(region.rect, anchor)),
          `${item.section} ${item.label} should have the instruction line at ${JSON.stringify(anchor)} as context`,
        ).toBe(true);
      }
      const pagesOfInstruction = new Set(instruction?.anchors.map((anchor) => anchor.page));
      expect(proposal.context.length, `${item.section} ${item.label}`).toBe(pagesOfInstruction.size);
    }
  });

  it('reads the two-column rows along the rows, the alternation included (the left column holds even numbers after an odd group)', () => {
    const left = proposals().filter((proposal) => proposal.section === '0.1' && proposal.rect.left < 0.3 && proposal.page === 6 && Number(proposal.label) >= 48);
    expect(left.map((proposal) => proposal.label)).toEqual(['48', '50', '52', '54', '56', '58', '60', '62', '64', '66', '68', '70']);
  });

  it('puts the two parts of a word problem that crosses a page break into one proposal with a continuation', () => {
    const eleven = proposals().find((proposal) => proposal.section === '0.2' && proposal.label === '11') as ExerciseProposal;
    expect(eleven.continues?.length).toBe(1);
    expect(eleven.continues?.[0]?.page).toBe(eleven.page + 1);
    expect(eleven.continues?.[0]?.rect.top).toBeLessThan(0.2);
    expect(eleven.evidence.join(' ')).toContain('continues on page');
  });

  it('includes the figure of an item whose number stands alone and leaves the blank space below it out', () => {
    const one = proposals().find((proposal) => proposal.section === '1.1' && proposal.label === '1') as ExerciseProposal;
    expect(one.layout).toBe('figure');
    expect(one.rect.bottom - one.rect.top).toBeGreaterThan(0.1);
    // The next instruction ("Plot each point.") starts 28 points (0.03) below the figure: the frame stops above it.
    const next = book.truth.instructions.find((instruction) => instruction.section === '1.1' && instruction.text.startsWith('Plot'));
    expect(one.rect.bottom).toBeLessThan((next?.anchors[0]?.y ?? 1) - 0.01);
    expect(one.rect.top).toBeGreaterThan((book.truth.instructions.find((instruction) => instruction.section === '1.1')?.anchors[0]?.y ?? 0) + 0.005);
  });

  it('reads figure items side by side and keeps their frames apart', () => {
    for (const label of ['7', '9', '11', '13', '15']) {
      const left = proposals().find((proposal) => proposal.section === '1.2' && proposal.label === label) as ExerciseProposal;
      const right = proposals().find((proposal) => proposal.section === '1.2' && proposal.label === String(Number(label) + 1)) as ExerciseProposal;
      expect(left.layout).toBe('figure');
      expect(left.rect.right).toBeLessThanOrEqual(right.rect.left + 1e-6);
      expect(left.rect.bottom - left.rect.top).toBeGreaterThan(0.1);
    }
  });

  it('has a deterministic frame id for each proposal and gives every proposal evidence', () => {
    const ids = proposals().map((proposal) => proposal.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(exerciseId('0.1', '5')).toBe('x0_1-5');
    for (const proposal of proposals()) {
      expect(proposal.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      expect(proposal.evidence.length).toBeGreaterThan(2);
      expect(proposal.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('stops a practice set where the next section starts and does not take its lesson', () => {
    const lastOfFirst = proposals().filter((proposal) => proposal.section === '0.1');
    for (const proposal of lastOfFirst) expect(proposal.page).toBeLessThanOrEqual(book.truth.sections[0]?.practiceLastPage ?? 0);
    const lessonPages = new Set(book.truth.sections.map((section) => section.lessonPage));
    for (const proposal of proposals()) {
      expect(lessonPages.has(proposal.page), `${proposal.section} ${proposal.label} is on a lesson page`).toBe(false);
    }
  });

  it('can be limited to a few sections and capped', () => {
    const only = proposeExercises(pages, structure.entries.filter((entry) => entry.id === '0.2'));
    expect(only.sections.map((section) => section.section)).toEqual(['0.2']);
    const capped = proposeExercises(pages, structure.entries, { caps: { '0.1': 20 }, maxItems: 100 });
    expect(capped.sections[0]?.proposals.length).toBe(20);
    expect(capped.sections[0]?.excluded.length).toBe(50);
    expect(capped.sections[0]?.notes.join(' ')).toContain('cap of 20');
    expect(capped.sections[1]?.proposals.length).toBe(14);
  });
});
