import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import type { HomeSide } from '../contract';
import type { Geometry } from '../geometry';
import { DEFAULT_GEOMETRY } from '../geometry';

export interface LabelsProps {
  /** Board layout; the classic 3:2 board when omitted. */
  geo?: Geometry;
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
  /** Whose numbering to print (the viewer's by default); the other player's is 25 minus mine. */
  numbering?: Player;
}

/** Point numbers printed on the frame, in the perspective player's numbering or the other's. */
export function Labels({
  perspective,
  homeSide,
  board,
  numbering = perspective,
  geo = DEFAULT_GEOMETRY,
}: LabelsProps) {
  const { LABEL_BOTTOM_Y, LABEL_TOP_Y, LABEL_SIZE, allPointSlots } = geo;
  const theirs = numbering !== perspective;
  return (
    <g data-testid="point-labels" data-numbering={numbering} aria-hidden="true">
      {allPointSlots(perspective, homeSide).map((slot) => (
        <text
          key={slot.abs}
          data-testid={`point-label-${slot.abs}`}
          data-display={theirs ? 25 - slot.display : slot.display}
          x={slot.x}
          y={slot.row === 'top' ? LABEL_TOP_Y : LABEL_BOTTOM_Y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={LABEL_SIZE}
          fontWeight={600}
          fill={theirs ? board.highlightSelected : board.label}
          opacity={theirs ? 1 : 0.85}
          style={{ fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)', letterSpacing: 1 }}
        >
          {theirs ? 25 - slot.display : slot.display}
        </text>
      ))}
    </g>
  );
}
