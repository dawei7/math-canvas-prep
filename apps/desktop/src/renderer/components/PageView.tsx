import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  AUTHORING,
  KIND_COLORS,
  detectParts,
  isAuthoritative,
  keptDividers,
  linesInRect,
  type Frame,
  type FrameKind,
  type Operation,
  type Rect,
} from '@mcprep/core/pure';
import { useStore } from '../hooks.js';
import { BOOK_COLOR, CONTEXT_COLOR, SOLUTION_COLOR, frameColor } from '../logic/colors.js';
import { NO_PARTS_REASON } from '../logic/errors.js';
import { HANDLES, frameAtTap, handlePositions, middleCut, partsOnPage, rectFromCorners, resizeRect, toScreen, unitArea, type HandleName, type PageBox } from '../logic/geometry.js';
import { placeChips } from '../logic/labels.js';
import { frameIndex, labelOf, pageContent } from '../logic/model.js';
import type { Store, Tool } from '../logic/store.js';
import { drawPage } from '../pdf.js';
import { BookForm } from './BookForm.js';
import { ChipShape, RegionBox } from './Shapes.js';
import { ToolHint } from './ToolHint.js';

type Drag =
  | { type: 'draw'; tool: Tool; x0: number; y0: number; x1: number; y1: number }
  | { type: 'move'; id: string; x0: number; y0: number; dx: number; dy: number }
  | { type: 'resize'; id: string; handle: HandleName; x0: number; y0: number; start: Rect; rect: Rect; unit: boolean }
  | { type: 'slicer'; part: Frame; cutIndex: number; y: number; lo: number; hi: number };

const DRAW_TOOLS: Tool[] = ['exercise', 'book', 'parts', 'context', 'continues', 'solution', 'question', 'bookmark'];
const KIND_OF: Partial<Record<Tool, FrameKind>> = { exercise: 'exercise', parts: 'exercise', question: 'question', bookmark: 'bookmark' };
const TAP_PIXELS = 4;
const FORM_WIDTH = 276;

function fitScale(available: number, pageWidth: number): number {
  return Math.max(0.2, (available - 56) / pageWidth);
}

export function PageView({ store, pdf }: { store: Store; pdf: PDFDocumentProxy | null }): preact.JSX.Element {
  const state = useStore(store);
  const scroller = useRef<HTMLDivElement>(null);
  const pageElement = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [available, setAvailable] = useState(900);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const moved = useRef(false);

  const size = state.doc?.pageSizes[state.page];
  const scale = state.zoom > 0 ? state.zoom : size ? fitScale(available, size.width) : 1;
  const box: PageBox = { width: (size?.width ?? 595) * scale, height: (size?.height ?? 842) * scale };

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current) return undefined;
    let cancelled = false;
    let drawing: ReturnType<typeof drawPage> | undefined;
    void pdf.getPage(state.page + 1).then((page) => {
      if (cancelled || !canvas.current) return;
      drawing = drawPage(page, canvas.current, scale);
      return drawing.done;
    });
    return () => {
      cancelled = true;
      drawing?.cancel();
    };
  }, [pdf, state.page, scale]);

  // A page opens at its top ...
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [state.page]);

  // ... unless a click in a list (frames, checks, proposals, sections) names a frame, a region or a place on it: that is
  // brought into view (the page is often taller than the window). This effect runs after the one above, so it wins.
  useEffect(() => {
    if (state.focus.tick === 0) return;
    const element = scroller.current;
    if (!element) return;
    const { region, y, ghost } = state.focus;
    if (region !== undefined || y !== undefined) {
      const at = region !== undefined ? (region.top + region.bottom) / 2 : (y ?? 0);
      element.scrollTop = Math.max(0, (pageElement.current?.offsetTop ?? 0) + at * box.height - element.clientHeight / 3);
      return;
    }
    const target = ghost !== null ? element.querySelector(`[data-ghost="${ghost}"] .body`) : element.querySelector('.frame.selected .body');
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [state.focus.tick]);

  const project = state.project;
  const frames = project?.frames ?? [];
  const index = frameIndex(frames);
  const content = pageContent(index, state.page);
  const selected = state.selection === null ? undefined : index.byId.get(state.selection);
  const selectedHere = selected !== undefined && selected.page === state.page;
  const ghosts = state.tab === 'propose' && state.proposals ? state.proposals.proposals.filter((proposal) => proposal.page === state.page && state.decided[proposal.id] === undefined) : [];
  const text = state.texts[state.page];
  const unitFrames = (frame: Frame): readonly Frame[] => (frame.unit === undefined ? [frame] : (index.units.get(frame.unit) ?? [frame]));
  const picking = state.picking !== null;

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number; px: number; py: number } => {
    const rectangle = (svg.current as SVGSVGElement).getBoundingClientRect();
    return { x: (event.clientX - rectangle.left) / rectangle.width, y: (event.clientY - rectangle.top) / rectangle.height, px: event.clientX, py: event.clientY };
  };

  const setDragState = (next: Drag | null): void => {
    dragRef.current = next;
    setDrag(next);
  };

  const begin = (event: PointerEvent, next: Drag): void => {
    event.stopPropagation();
    event.preventDefault();
    svg.current?.setPointerCapture(event.pointerId);
    moved.current = false;
    setDragState(next);
  };

  // ------------------------------------------------------------------------------------------------- committing

  const addFrame = (rect: Rect, tool: Tool): void => {
    if (tool === 'book') {
      store.startDraft(state.page, rect);
      return;
    }
    const kind = KIND_OF[tool];
    if (kind && tool !== 'parts') {
      store.apply([{ op: 'add', kind, page: state.page, rect, snap: state.snap }], { select: 'created' });
      return;
    }
    if (tool === 'parts') {
      const lines = text?.lines ?? [];
      const detection = detectParts(linesInRect(lines, rect).filter((line) => line.headerFooter !== true));
      const cuts = detection ? keptDividers(rect, detection.dividers) : [];
      const at = cuts.length > 0 ? cuts : middleCut(rect, text);
      const operations: Operation[] = [
        { op: 'add', ref: 'x', kind: 'exercise', page: state.page, rect, snap: state.snap },
        { op: 'split', id: '@x', at },
      ];
      store.apply(operations, { select: 'created' });
      return;
    }
    const owner = selected && selected.kind === 'exercise' ? selected : undefined;
    if (tool === 'context') {
      if (!owner) {
        store.notify('info', 'Select an exercise first (click it), then draw its context.');
        return;
      }
      store.addRegion('context', owner.id, state.page, rect);
      return;
    }
    if (tool === 'solution') {
      if (!owner) {
        store.notify('info', 'Select an exercise first (click it), go to the answer key, then draw its solution.');
        return;
      }
      store.addRegion('solution', owner.id, state.page, rect);
      return;
    }
    if (tool === 'continues') {
      if (!selected || selected.unit !== undefined) {
        store.notify('info', selected?.unit !== undefined ? 'An exercise with parts cannot continue: give each page its own parts.' : 'Select a frame first (click it), then draw where it goes on.');
        return;
      }
      store.addRegion('continues', selected.id, state.page, rect);
    }
  };

  const tapInExercise = (x: number, y: number): Frame | undefined =>
    content.frames.find((frame) => frame.kind === 'exercise' && x >= frame.rect.left && x <= frame.rect.right && y >= frame.rect.top && y <= frame.rect.bottom);

  const finish = (event: PointerEvent): void => {
    const current = dragRef.current;
    if (!current) return;
    svg.current?.releasePointerCapture(event.pointerId);
    setDragState(null);
    if (current.type === 'draw') {
      if (!moved.current) {
        if (current.tool === 'parts') {
          const frame = tapInExercise(current.x1, current.y1);
          if (frame) {
            if (isAuthoritative(frame)) {
              store.notify('info', NO_PARTS_REASON);
              return;
            }
            const lines = text?.lines ?? [];
            const parts = partsOnPage(unitFrames(frame), frame);
            const target = parts.find((part) => current.y1 >= part.rect.top && current.y1 <= part.rect.bottom) ?? frame;
            if (frame.unit === undefined) {
              const detection = detectParts(linesInRect(lines, frame.rect).filter((line) => line.headerFooter !== true));
              const cuts = detection ? keptDividers(frame.rect, detection.dividers) : [];
              store.apply([{ op: 'split', id: frame.id, at: cuts.length > 0 ? cuts : middleCut(frame.rect, text) }], { select: frame.id });
            } else {
              store.apply([{ op: 'split', id: target.id, at: [current.y1], snap: state.snap }], { select: frame.id });
            }
            return;
          }
        }
        addFrame(frameAtTap(text, current.x1, current.y1), current.tool);
        return;
      }
      addFrame(rectFromCorners(current.x0, current.y0, current.x1, current.y1), current.tool);
      return;
    }
    if (!moved.current) return;
    if (current.type === 'move') {
      store.apply([{ op: 'move', id: current.id, dx: current.dx, dy: current.dy }]);
    } else if (current.type === 'resize') {
      store.apply([current.unit ? { op: 'area', id: current.id, rect: current.rect, snap: state.snap } : { op: 'update', id: current.id, rect: current.rect, snap: state.snap }]);
    } else {
      const parts = partsOnPage(unitFrames(current.part), current.part);
      const cuts = parts.slice(1).map((part) => part.rect.top);
      cuts[current.cutIndex] = current.y;
      store.apply([{ op: 'dividers', id: current.part.id, at: cuts, snap: state.snap }]);
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (picking) setHoverY(point(event).y);
    const current = dragRef.current;
    if (!current) return;
    const p = point(event);
    if (current.type === 'draw') {
      if (Math.hypot((p.x - current.x0) * box.width, (p.y - current.y0) * box.height) > TAP_PIXELS) moved.current = true;
      setDragState({ ...current, x1: p.x, y1: p.y });
    } else if (current.type === 'move') {
      const dx = p.x - current.x0;
      const dy = p.y - current.y0;
      if (Math.hypot(dx * box.width, dy * box.height) > TAP_PIXELS) moved.current = true;
      setDragState({ ...current, dx, dy });
    } else if (current.type === 'resize') {
      moved.current = true;
      setDragState({ ...current, rect: resizeRect(current.start, current.handle, p.x - current.x0, p.y - current.y0) });
    } else {
      moved.current = true;
      setDragState({ ...current, y: Math.min(current.hi, Math.max(current.lo, p.y)) });
    }
  };

  /** Where a heading starts, for a click at height `y`: the top of the text line there, else the height itself. */
  const headingTop = (y: number): number => {
    const line = (text?.lines ?? []).find((entry) => y >= entry.rect.top - 0.006 && y <= entry.rect.bottom + 0.006 && entry.headerFooter !== true);
    return line ? Math.max(0, line.rect.top - AUTHORING.startPadding) : y;
  };

  const onBackgroundDown = (event: PointerEvent): void => {
    const p = point(event);
    if (picking) {
      store.pickHeadingAt(state.page, headingTop(p.y));
      setHoverY(null);
      return;
    }
    if (DRAW_TOOLS.includes(state.tool)) {
      begin(event, { type: 'draw', tool: state.tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else {
      store.select(null);
    }
  };

  const startResize = (event: PointerEvent, frame: Frame, handle: HandleName): void => {
    const p = point(event);
    const start = unitArea(unitFrames(frame), frame);
    begin(event, { type: 'resize', id: frame.id, handle, x0: p.x, y0: p.y, start, rect: start, unit: frame.unit !== undefined });
  };

  const startSlicer = (event: PointerEvent, part: Frame, cutIndex: number): void => {
    const parts = partsOnPage(unitFrames(part), part);
    const area = unitArea(unitFrames(part), part);
    const above = cutIndex === 0 ? area.top : (parts[cutIndex] as Frame).rect.top;
    const below = cutIndex + 2 >= parts.length ? area.bottom : (parts[cutIndex + 2] as Frame).rect.top;
    const y = (parts[cutIndex + 1] as Frame).rect.top;
    begin(event, { type: 'slicer', part, cutIndex, y, lo: above + AUTHORING.minPieceHeight, hi: below - AUTHORING.minPieceHeight });
  };

  const removeCut = (part: Frame, cutIndex: number): void => {
    const cuts = partsOnPage(unitFrames(part), part).slice(1).map((entry) => entry.rect.top);
    cuts.splice(cutIndex, 1);
    store.apply([{ op: 'dividers', id: part.id, at: cuts }], { select: part.id });
  };

  const addCut = (part: Frame): void => {
    const parts = partsOnPage(unitFrames(part), part);
    const thickest = [...parts].sort((a, b) => b.rect.bottom - b.rect.top - (a.rect.bottom - a.rect.top))[0] as Frame;
    const middle = (thickest.rect.top + thickest.rect.bottom) / 2;
    store.apply([{ op: 'split', id: thickest.id, at: [middle], snap: state.snap }], { select: part.id });
  };

  const deleteSelected = (): void => {
    if (!selected) return;
    store.apply([selected.unit !== undefined ? { op: 'delete', unit: selected.unit } : { op: 'delete', id: selected.id }], { select: null });
  };

  // ------------------------------------------------------------------------------------------------- drawing

  const preview = (frame: Frame, rect: Rect): Rect => {
    if (!drag) return rect;
    if (drag.type === 'move' && (drag.id === frame.id || (frame.unit !== undefined && selected?.unit === frame.unit && drag.id === selected.id))) {
      return { left: rect.left + drag.dx, right: rect.right + drag.dx, top: rect.top + drag.dy, bottom: rect.bottom + drag.dy };
    }
    return rect;
  };

  const liveRect = (frame: Frame): Rect => (drag?.type === 'resize' && drag.id === frame.id ? drag.rect : preview(frame, frame.rect));

  /** The label of an exercise with parts, a ghost or a part: a pill at a given height. */
  const chip = (x: number, y: number, label: string, color: string, onDown?: (event: PointerEvent) => void, cursor?: string): preact.JSX.Element => {
    const width = label.length * 6.6 + 12;
    return (
      <g class="chip" onPointerDown={onDown} style={{ cursor: cursor ?? 'pointer' }}>
        <rect x={x} y={y - 9} width={width} height={18} rx={9} fill={color} />
        <text x={x + width / 2} y={y + 0.5} text-anchor="middle" dominant-baseline="middle">
          {label}
        </text>
      </g>
    );
  };

  const standalone = content.frames.filter((frame) => frame.unit === undefined);
  const unitsOnPage = [...new Set(content.frames.filter((frame) => frame.unit !== undefined).map((frame) => frame.unit as string))];
  const chips = placeChips(
    standalone.map((frame) => ({ id: frame.id, label: labelOf(index, frame), rect: liveRect(frame) })),
    box,
  );
  const solutionChips = placeChips(
    content.solution.map((region) => ({ id: `${region.frame.id}#${region.index}`, label: `S ${labelOf(index, region.frame)}`, rect: region.rect })),
    box,
  );
  const drawing = drag?.type === 'draw' ? drag : undefined;
  const kindOfDraw = drawing ? (KIND_OF[drawing.tool] ?? 'exercise') : 'exercise';
  const drawColor = drawing
    ? drawing.tool === 'context' || drawing.tool === 'continues'
      ? KIND_COLORS.context
      : drawing.tool === 'book'
        ? BOOK_COLOR
        : drawing.tool === 'solution'
          ? SOLUTION_COLOR
          : KIND_COLORS[kindOfDraw]
    : '#000';

  const ownerSelected = (frame: Frame): boolean => selected !== undefined && (selected.id === frame.id || (selected.unit !== undefined && selected.unit === frame.unit));
  const regionClickable = state.tool === 'select' && !picking;

  const frameShape = (frame: Frame): preact.JSX.Element => {
    const rect = liveRect(frame);
    const s = toScreen(rect, box);
    const isSelected = state.selection === frame.id;
    const color = frameColor(frame);
    const book = isAuthoritative(frame);
    const label = labelOf(index, frame);
    const placed = chips.get(frame.id);
    return (
      <g key={frame.id} class={`frame ${book ? 'book' : ''} ${isSelected ? 'selected' : ''}`} data-id={frame.id} data-label={label}>
        <rect
          class="body"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill={color}
          fill-opacity={isSelected ? 0.14 : 0.07}
          stroke={color}
          stroke-width={isSelected ? 2.5 : 1.5}
          style={{ pointerEvents: state.tool === 'select' && !picking ? 'all' : 'none', cursor: state.tool === 'select' ? 'move' : 'default' }}
          onPointerDown={(event) => {
            store.select(frame.id);
            const p = point(event);
            if (state.tool === 'select') begin(event, { type: 'move', id: frame.id, x0: p.x, y0: p.y, dx: 0, dy: 0 });
          }}
        />
        {placed ? (
          <ChipShape
            chip={placed}
            label={label}
            color={color}
            square={book}
            title={book && frame.section !== undefined ? `${frame.section}:${label}` : undefined}
            onDown={(event) => {
              event.stopPropagation();
              store.select(frame.id);
            }}
          />
        ) : null}
      </g>
    );
  };

  const unitShape = (unit: string): preact.JSX.Element | null => {
    const parts = content.frames.filter((frame) => frame.unit === unit).sort((a, b) => a.rect.top - b.rect.top);
    const first = parts[0];
    if (!first) return null;
    const isSelected = selected?.unit === unit;
    const color = frameColor(first);
    let area = unitArea(unitFrames(first), first);
    if (drag?.type === 'resize' && selected?.unit === unit) area = drag.rect;
    else if (drag?.type === 'move' && selected?.unit === unit) area = preview(first, area);
    const s = toScreen(area, box);
    const number = index.numbers.get(first.id);
    const name = number ? `E${number.number}` : first.id;
    const cuts = parts.slice(1);
    const nameWidth = name.length * 6.6 + 12;
    const room = s.x > nameWidth + 8;
    const minusX = room ? s.x - nameWidth - 22 : s.x - 34;
    return (
      <g key={unit} class={`frame unit ${isSelected ? 'selected' : ''}`} data-id={first.id} data-label={name}>
        <rect
          class="body"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill={color}
          fill-opacity={isSelected ? 0.14 : 0.07}
          stroke={color}
          stroke-width={isSelected ? 2.5 : 1.5}
          style={{ pointerEvents: state.tool === 'select' && !picking ? 'all' : 'none', cursor: state.tool === 'select' ? 'move' : 'default' }}
          onPointerDown={(event) => {
            store.select(first.id);
            const p = point(event);
            if (state.tool === 'select') begin(event, { type: 'move', id: first.id, x0: p.x, y0: p.y, dx: 0, dy: 0 });
          }}
        />
        {cuts.map((part, cutIndex) => {
          const live = drag?.type === 'slicer' && drag.part.unit === unit && drag.cutIndex === cutIndex ? drag.y : part.rect.top;
          const y = toScreen({ left: area.left, top: live, right: area.right, bottom: live }, box).y + (drag?.type === 'move' && selected?.unit === unit ? drag.dy * box.height : 0);
          return (
            <g key={`cut-${part.id}`} class="slicer">
              <line x1={s.x} x2={s.x + s.w} y1={y} y2={y} stroke={color} stroke-width={2} stroke-dasharray="7 5" />
              <line
                x1={s.x}
                x2={s.x + s.w}
                y1={y}
                y2={y}
                stroke="transparent"
                stroke-width={14}
                style={{ cursor: 'ns-resize', pointerEvents: 'stroke' }}
                onPointerDown={(event) => {
                  store.select(first.id);
                  startSlicer(event, first, cutIndex);
                }}
              />
              {isSelected ? (
                <>
                  {/* The button sits left of the unit's name chip and the west handle, joined to its cut by a dotted line. */}
                  <line x1={minusX + 9} x2={s.x} y1={y} y2={y} stroke={color} stroke-width={1.5} stroke-dasharray="2 3" opacity={0.7} style={{ pointerEvents: 'none' }} />
                  <g class="round-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeCut(first, cutIndex)} style={{ cursor: 'pointer' }}>
                    <title>Join the two parts</title>
                    <circle cx={minusX} cy={y} r={9} fill="#fff" stroke={color} />
                    <text x={minusX} y={y + 0.5} text-anchor="middle" dominant-baseline="middle" style={{ fill: color }}>
                      −
                    </text>
                  </g>
                </>
              ) : null}
            </g>
          );
        })}
        {parts.map((part, partIndex) => {
          const top = partIndex === 0 ? area.top : drag?.type === 'slicer' && drag.part.unit === unit && drag.cutIndex === partIndex - 1 ? drag.y : part.rect.top;
          const bottomPart = parts[partIndex + 1];
          const bottom = bottomPart ? (drag?.type === 'slicer' && drag.part.unit === unit && drag.cutIndex === partIndex ? drag.y : bottomPart.rect.top) : area.bottom;
          const centre = toScreen({ left: area.left, top: (top + bottom) / 2, right: area.right, bottom: (top + bottom) / 2 }, box).y;
          const label = index.numbers.get(part.id)?.label ?? part.id;
          return chip(s.x + s.w + 10, centre, label, color, partIndex === 0 ? (event) => { event.stopPropagation(); store.select(first.id); } : (event) => {
            store.select(first.id);
            startSlicer(event, first, partIndex - 1);
          }, partIndex === 0 ? 'pointer' : 'ns-resize');
        })}
        {chip(room ? s.x - nameWidth - 6 : s.x, room ? s.y + 9 : s.y - 12, name, color, (event) => {
          event.stopPropagation();
          store.select(first.id);
        })}
        {isSelected ? (
          <g class="round-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => addCut(first)} style={{ cursor: 'pointer' }}>
            <title>Cut another part</title>
            <circle cx={s.x + s.w * 0.25} cy={s.y + s.h + 26} r={10} fill="#fff" stroke={color} />
            <text x={s.x + s.w * 0.25} y={s.y + s.h + 26.5} text-anchor="middle" dominant-baseline="middle" style={{ fill: color }}>
              +
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  /**
   * The handles of the selected frame sit outside its outline, so that on a crowded page they reach over its neighbours. They
   * are drawn below the frames (and their labels): a click on a neighbour selects the neighbour, and a handle works wherever
   * nothing else is.
   */
  const selectionHandles = (): preact.JSX.Element | null => {
    if (!selected || !selectedHere || state.tool !== 'select' || picking) return null;
    const live = drag?.type === 'resize' ? drag.rect : drag?.type === 'move' ? preview(selected, unitArea(unitFrames(selected), selected)) : unitArea(unitFrames(selected), selected);
    const positions = handlePositions(live, box);
    return (
      <g class="selection-tools">
        {HANDLES.map((handle) => {
          const at = positions[handle];
          return (
            <g key={handle} class={`handle handle-${handle}`} onPointerDown={(event) => startResize(event, selected, handle)} style={{ cursor: `${handle}-resize` }}>
              <rect x={at.x - 8} y={at.y - 8} width={16} height={16} fill="transparent" />
              <rect x={at.x - 5} y={at.y - 5} width={10} height={10} rx={2} fill="#fff" stroke={frameColor(selected)} stroke-width={2} style={{ pointerEvents: 'none' }} />
            </g>
          );
        })}
      </g>
    );
  };

  const deleteButton = (): preact.JSX.Element | null => {
    if (!selected || !selectedHere || state.tool !== 'select' || picking) return null;
    const live = drag?.type === 'resize' ? drag.rect : drag?.type === 'move' ? preview(selected, unitArea(unitFrames(selected), selected)) : unitArea(unitFrames(selected), selected);
    const s = toScreen(live, box);
    return (
      <g class="round-button delete" onPointerDown={(event) => event.stopPropagation()} onClick={deleteSelected} style={{ cursor: 'pointer' }} aria-label="Delete">
        <circle cx={s.x + s.w + 30} cy={s.y - 24} r={11} fill="#dc2626" />
        <text x={s.x + s.w + 30} y={s.y - 23.5} text-anchor="middle" dominant-baseline="middle" fill="#fff">
          ×
        </text>
      </g>
    );
  };

  const ghostShape = (proposal: (typeof ghosts)[number]): preact.JSX.Element => {
    const s = toScreen(proposal.rect, box);
    const color = KIND_COLORS[proposal.kind];
    // The buttons go beside the frame, in the margin, so that they do not cover the text; inside only when there is no margin.
    const outside = s.x + s.w + 58 <= box.width;
    const acceptX = outside ? s.x + s.w + 16 : s.x + s.w - 14;
    const rejectX = outside ? s.x + s.w + 42 : s.x + s.w - 40;
    return (
      <g key={proposal.id} class="ghost" data-ghost={proposal.id}>
        <rect class="body" x={s.x} y={s.y} width={s.w} height={s.h} fill={color} fill-opacity={0.1} stroke={color} stroke-width={2} stroke-dasharray="3 4" style={{ pointerEvents: 'none' }} />
        {chip(s.x, s.y - 12, `${proposal.id} ${Math.round(proposal.confidence * 100)}%`, color)}
        <g class="round-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => store.acceptProposal(proposal.id)} style={{ cursor: 'pointer' }}>
          <title>Accept</title>
          <circle cx={acceptX} cy={s.y + 14} r={10} fill="#16a34a" />
          <text x={acceptX} y={s.y + 14.5} text-anchor="middle" dominant-baseline="middle" fill="#fff">
            ✓
          </text>
        </g>
        <g class="round-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => store.rejectProposal(proposal.id)} style={{ cursor: 'pointer' }}>
          <title>Reject</title>
          <circle cx={rejectX} cy={s.y + 14} r={10} fill="#64748b" />
          <text x={rejectX} y={s.y + 14.5} text-anchor="middle" dominant-baseline="middle" fill="#fff">
            ✕
          </text>
        </g>
      </g>
    );
  };

  // The selected frame is drawn last: it is on top of its neighbours whatever the order of the file.
  const others = standalone.filter((frame) => frame.id !== state.selection);
  const chosen = standalone.filter((frame) => frame.id === state.selection);
  const draft = state.draft;
  const draftBox = draft && draft.page === state.page ? toScreen(draft.rect, box) : undefined;
  const mark = state.focus.tick > 0 && state.focus.page === state.page && Date.now() < (state.focus.until ?? 0) ? state.focus : undefined;

  const formPosition = (): { left: number; top: number } => {
    if (!draftBox) return { left: 0, top: 0 };
    const top = Math.max(0, Math.min(draftBox.y, box.height - 250));
    if (draftBox.x + draftBox.w + 14 + FORM_WIDTH <= box.width) return { left: draftBox.x + draftBox.w + 14, top };
    if (draftBox.x - 14 - FORM_WIDTH >= 0) return { left: draftBox.x - 14 - FORM_WIDTH, top };
    return { left: Math.max(0, Math.min(draftBox.x, box.width - FORM_WIDTH)), top: Math.min(draftBox.y + draftBox.h + 10, Math.max(0, box.height - 250)) };
  };

  return (
    <div class="page-scroll" ref={scroller}>
      <ToolHint store={store} />
      <div class="page" ref={pageElement} style={{ width: `${box.width}px`, height: `${box.height}px` }} data-page={state.page}>
        <canvas ref={canvas} />
        <svg
          ref={svg}
          class={`overlay tool-${state.tool} ${picking ? 'picking' : ''}`}
          width={box.width}
          height={box.height}
          viewBox={`0 0 ${box.width} ${box.height}`}
          onPointerDown={onBackgroundDown}
          onPointerMove={onMove}
          onPointerUp={finish}
          onPointerCancel={() => setDragState(null)}
        >
          {content.continues.map((region, i) => (
            <RegionBox key={`cont-${region.frame.id}-${i}`} kind="continues" rect={region.rect} box={box} color={frameColor(region.frame)} own={ownerSelected(region.frame)} clickable={false} />
          ))}
          {content.context.map((region, i) => {
            const own = ownerSelected(region.frame);
            return (
              <RegionBox
                key={`ctx-${region.frame.id}-${i}`}
                kind="context"
                rect={region.rect}
                box={box}
                color={CONTEXT_COLOR}
                own={own}
                clickable={regionClickable}
                onSelect={() => store.select(region.frame.id)}
                {...(own && state.tool === 'select' ? { remove: () => store.removeRegion('context', region.frame.id, region.index) } : {})}
              />
            );
          })}
          {content.solution.map((region) => {
            const own = ownerSelected(region.frame);
            const key = `${region.frame.id}#${region.index}`;
            const placed = solutionChips.get(key);
            return (
              <g key={`sol-${key}`} data-owner={region.frame.id}>
                <RegionBox
                  kind="solution"
                  rect={region.rect}
                  box={box}
                  color={SOLUTION_COLOR}
                  own={own}
                  clickable={regionClickable}
                  onSelect={() => store.select(region.frame.id)}
                  {...(own && state.tool === 'select' ? { remove: () => store.removeRegion('solution', region.frame.id, region.index) } : {})}
                />
                {placed ? <ChipShape chip={placed} label={`S ${labelOf(index, region.frame)}`} color={SOLUTION_COLOR} title="Solution: hidden from the learner" interactive={regionClickable} onDown={(event) => { event.stopPropagation(); store.select(region.frame.id); }} /> : null}
              </g>
            );
          })}
          {selectionHandles()}
          {others.map(frameShape)}
          {unitsOnPage.map(unitShape)}
          {chosen.map(frameShape)}
          {ghosts.map(ghostShape)}
          {deleteButton()}
          {draftBox ? (
            <g class="draft">
              <rect x={draftBox.x} y={draftBox.y} width={draftBox.w} height={draftBox.h} fill={BOOK_COLOR} fill-opacity={0.14} stroke={BOOK_COLOR} stroke-width={2.5} stroke-dasharray="6 4" style={{ pointerEvents: 'none' }} />
            </g>
          ) : null}
          {mark?.region !== undefined ? (
            <rect key={`mark-${mark.tick}`} class="pulse" x={toScreen(mark.region, box).x - 4} y={toScreen(mark.region, box).y - 4} width={toScreen(mark.region, box).w + 8} height={toScreen(mark.region, box).h + 8} rx={4} fill="none" stroke="#f59e0b" stroke-width={3} style={{ pointerEvents: 'none' }} />
          ) : null}
          {mark?.y !== undefined ? <line key={`line-${mark.tick}`} class="pulse" x1={0} x2={box.width} y1={mark.y * box.height} y2={mark.y * box.height} stroke="#f59e0b" stroke-width={3} style={{ pointerEvents: 'none' }} /> : null}
          {picking && hoverY !== null ? <line class="guide" x1={0} x2={box.width} y1={hoverY * box.height} y2={hoverY * box.height} stroke="#f59e0b" stroke-width={2} stroke-dasharray="6 4" style={{ pointerEvents: 'none' }} /> : null}
          {drawing && (drawing.x0 !== drawing.x1 || drawing.y0 !== drawing.y1) ? (
            (() => {
              const s = toScreen(rectFromCorners(drawing.x0, drawing.y0, drawing.x1, drawing.y1), box);
              return <rect x={s.x} y={s.y} width={s.w} height={s.h} fill={drawColor} fill-opacity={0.12} stroke={drawColor} stroke-width={2} stroke-dasharray="6 4" style={{ pointerEvents: 'none' }} />;
            })()
          ) : null}
        </svg>
        {draft && draftBox ? (
          <div class="draft-form" style={{ left: `${formPosition().left}px`, top: `${formPosition().top}px`, width: `${FORM_WIDTH}px` }}>
            <BookForm
              key={`${draft.page}:${draft.rect.left}:${draft.rect.top}`}
              store={store}
              heading="Book exercise"
              at={{ page: draft.page, top: draft.rect.top }}
              label={draft.label}
              section={draft.section}
              note={draft.note}
              error={draft.error}
              confirmText="Add"
              onConfirm={(label, section) => store.confirmDraft(label, section)}
              onCancel={() => store.cancelDraft()}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
