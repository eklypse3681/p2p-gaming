import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import type { HomeSide } from '../contract';
import { LABEL_BOTTOM_Y, LABEL_TOP_Y, allPointSlots } from '../geometry';

export interface LabelsProps {
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
}

/** Point numbers printed on the frame in the perspective player's numbering. */
export function Labels({ perspective, homeSide, board }: LabelsProps) {
  return (
    <g data-testid="point-labels" aria-hidden="true">
      {allPointSlots(perspective, homeSide).map((slot) => (
        <text
          key={slot.abs}
          data-testid={`point-label-${slot.abs}`}
          data-display={slot.display}
          x={slot.x}
          y={slot.row === 'top' ? LABEL_TOP_Y : LABEL_BOTTOM_Y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={24}
          fontWeight={600}
          fill={board.label}
          opacity={0.85}
          style={{ fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)', letterSpacing: 1 }}
        >
          {slot.display}
        </text>
      ))}
    </g>
  );
}
