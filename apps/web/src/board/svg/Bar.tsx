import type { BoardSet } from '../../themes/theme';
import type { HomeSide } from '../contract';
import { FELT_BOTTOM, FELT_TOP, boardLayout } from '../geometry';

export function Bar({ board, homeSide }: { board: BoardSet; homeSide: HomeSide }) {
  const { bar } = boardLayout(homeSide);
  return (
    <g data-testid="bar">
      <rect
        x={bar.x}
        y={FELT_TOP}
        width={bar.width}
        height={FELT_BOTTOM - FELT_TOP}
        fill={board.bar}
      />
      <rect
        x={bar.x}
        y={FELT_TOP}
        width={bar.width}
        height={FELT_BOTTOM - FELT_TOP}
        fill="url(#wood-grain)"
        opacity={0.5}
      />
      <rect
        x={bar.x}
        y={FELT_TOP}
        width={4}
        height={FELT_BOTTOM - FELT_TOP}
        fill="rgba(0,0,0,0.35)"
      />
      <rect
        x={bar.x + bar.width - 4}
        y={FELT_TOP}
        width={4}
        height={FELT_BOTTOM - FELT_TOP}
        fill="rgba(255,255,255,0.08)"
      />
    </g>
  );
}
