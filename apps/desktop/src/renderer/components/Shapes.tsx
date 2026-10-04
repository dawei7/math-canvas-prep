import type { Rect } from '@mcprep/core/pure';
import { toScreen, type PageBox } from '../logic/geometry.js';
import type { Chip } from '../logic/labels.js';

/** The small pieces the page view draws in its SVG: a label next to a frame, and a dashed region with its marker. */

export function ChipShape({
  chip,
  label,
  color,
  square = false,
  title,
  onDown,
  cursor = 'pointer',
  interactive = true,
}: {
  chip: Chip;
  label: string;
  color: string;
  /** Book exercises have square-ish labels, so that they are told apart from the pills of ordinary frames. */
  square?: boolean;
  title?: string;
  onDown?: (event: PointerEvent) => void;
  cursor?: string;
  /** False: the label lets clicks through to the page (a drawing tool is in use). */
  interactive?: boolean;
}): preact.JSX.Element {
  return (
    <g class={`chip chip-${chip.side}`} onPointerDown={onDown} style={{ cursor, pointerEvents: interactive ? 'all' : 'none' }}>
      {title !== undefined ? <title>{title}</title> : null}
      <rect x={chip.x} y={chip.y} width={chip.w} height={chip.h} rx={square ? 4 : chip.h / 2} fill={color} />
      <text x={chip.x + chip.w / 2} y={chip.y + chip.h / 2 + 0.5} text-anchor="middle" dominant-baseline="middle" style={{ fontSize: `${chip.fontSize}px` }}>
        {label}
      </text>
    </g>
  );
}

/** A dashed region of the page that belongs to a frame: where it continues, its instruction (context) or its hidden solution. */
export function RegionBox({
  rect,
  box,
  color,
  own,
  kind,
  clickable,
  onSelect,
  remove,
}: {
  rect: Rect;
  box: PageBox;
  color: string;
  /** The region belongs to the selected exercise: it is drawn strongly. */
  own: boolean;
  kind: 'continues' | 'context' | 'solution';
  clickable: boolean;
  onSelect?: () => void;
  /** The selected exercise's own regions can be removed right here. */
  remove?: () => void;
}): preact.JSX.Element {
  const s = toScreen(rect, box);
  return (
    <g class={`region region-${kind} ${own ? 'own' : ''}`} data-kind={kind}>
      <rect
        class="region-body"
        x={s.x}
        y={s.y}
        width={s.w}
        height={s.h}
        fill={color}
        fill-opacity={own ? 0.13 : 0.05}
        stroke={color}
        stroke-width={own ? 2.2 : 1.2}
        stroke-dasharray={kind === 'solution' ? '7 4' : '6 5'}
        style={{ pointerEvents: clickable ? 'all' : 'none', cursor: clickable ? 'pointer' : 'default' }}
        onPointerDown={(event) => {
          if (!onSelect) return;
          event.stopPropagation();
          onSelect();
        }}
      />
      {remove ? (
        <g class="round-button region-remove" onPointerDown={(event) => event.stopPropagation()} onClick={remove} style={{ cursor: 'pointer' }}>
          <title>Remove this {kind === 'solution' ? 'solution' : kind === 'context' ? 'context' : 'continuation'} region</title>
          <circle cx={s.x + s.w + 52} cy={s.y + Math.min(s.h / 2, 12)} r={9} fill="#fff" stroke={color} />
          <text x={s.x + s.w + 52} y={s.y + Math.min(s.h / 2, 12) + 0.5} text-anchor="middle" dominant-baseline="middle" style={{ fill: color }}>
            ×
          </text>
        </g>
      ) : null}
    </g>
  );
}
