import { numberFrames } from './numbering.js';
import type { Frame, FrameKind, Rect } from './types.js';

/** Colours per kind, shared by the rendered overlays and the desktop app. */
export const KIND_COLORS: Record<FrameKind | 'context', string> = {
  exercise: '#4f46e5',
  question: '#0d9488',
  bookmark: '#7c3aed',
  context: '#64748b',
};

export interface OverlayBox {
  /** Positional label (`E2.1`, `Q1`, `B3`), `E4 cont.` for a continuation, `ctx E3` for context. */
  label: string;
  kind: FrameKind | 'context';
  rect: Rect;
  dashed: boolean;
  frameId: string;
}

/** What to draw on a page for these frames: main regions, continuation regions and context regions. */
export function overlayBoxes(frames: readonly Frame[], page: number): OverlayBox[] {
  const labels = numberFrames(frames);
  const boxes: OverlayBox[] = [];
  const contextDrawn = new Set<string>();
  for (const frame of frames) {
    const info = labels.get(frame.id);
    const label = info?.label ?? frame.id;
    if (frame.page === page) boxes.push({ label, kind: frame.kind, rect: frame.rect, dashed: false, frameId: frame.id });
    frame.continues?.forEach((region) => {
      if (region.page === page) boxes.push({ label: `${label} cont.`, kind: frame.kind, rect: region.rect, dashed: true, frameId: frame.id });
    });
    if (frame.context) {
      // The context of a unit is drawn once, labelled with the exercise number.
      const owner = frame.unit !== undefined ? `unit:${frame.unit}` : frame.id;
      const base = info ? `E${info.number}` : frame.id;
      frame.context.forEach((region, index) => {
        const key = `${owner}:${index}:${region.page}:${region.rect.top}`;
        if (region.page !== page || contextDrawn.has(key)) return;
        contextDrawn.add(key);
        boxes.push({ label: `ctx ${base}`, kind: 'context', rect: region.rect, dashed: true, frameId: frame.id });
      });
    }
  }
  return boxes;
}
