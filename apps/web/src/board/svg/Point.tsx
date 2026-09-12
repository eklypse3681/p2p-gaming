import type { BoardSet } from '../../themes/theme';
import type { PointSlot } from '../geometry';
import { pointPath } from '../geometry';

export interface PointProps {
  slot: PointSlot;
  board: BoardSet;
  /** Visual emphasis states. */
  source?: boolean;
  selected?: boolean;
}

/** The triangle only; hit-testing lives in the interaction layer. */
export function Point({ slot, board, source, selected }: PointProps) {
  const fill = slot.abs % 2 === 1 ? board.pointA : board.pointB;
  return (
    <g data-testid={`point-shape-${slot.abs}`} data-point={slot.abs} data-rel={slot.display}>
      <path d={pointPath(slot)} fill={fill} />
      <path d={pointPath(slot)} fill="url(#point-shade)" opacity={0.5} />
      <path
        d={pointPath(slot, 5)}
        fill="none"
        stroke={board.pointEdge}
        strokeWidth={2}
        opacity={0.6}
      />
      {(source || selected) && (
        <path
          d={pointPath(slot, -3)}
          fill="none"
          stroke={selected ? board.highlightSelected : board.highlightSource}
          strokeWidth={selected ? 6 : 3}
          strokeLinejoin="round"
          opacity={selected ? 0.95 : 0.7}
        />
      )}
    </g>
  );
}
