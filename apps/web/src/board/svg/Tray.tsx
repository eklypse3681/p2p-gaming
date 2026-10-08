import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import type { HomeSide } from '../contract';
import type { Geometry } from '../geometry';
import { DEFAULT_GEOMETRY } from '../geometry';

export interface TrayProps {
  /** Board layout; the classic 3:2 board when omitted. */
  geo?: Geometry;
  board: BoardSet;
  perspective: Player;
  homeSide: HomeSide;
  pips: Record<Player, number>;
  names: Record<Player, string>;
}

/** Bear-off trays (one half per player) with pip counts near the middle. */
export function Tray({
  board,
  perspective,
  homeSide,
  pips,
  names,
  geo = DEFAULT_GEOMETRY,
}: TrayProps) {
  const { FELT_BOTTOM, FELT_TOP, MID_Y, boardLayout, halfFor, trayX } = geo;
  const x = trayX(homeSide);
  const { divider, tray } = boardLayout(homeSide);
  const height = FELT_BOTTOM - FELT_TOP;
  return (
    <g data-testid="tray" data-home-side={homeSide}>
      <rect x={divider.x} y={FELT_TOP} width={divider.width} height={height} fill={board.frame} />
      <rect
        x={divider.x}
        y={FELT_TOP}
        width={divider.width}
        height={height}
        fill="url(#wood-grain)"
        opacity={0.5}
      />
      <rect x={tray.x} y={FELT_TOP} width={tray.width} height={height} fill={board.tray} />
      <rect x={tray.x} y={FELT_TOP} width={tray.width} height={height} fill="url(#tray-shade)" />
      <rect x={tray.x} y={MID_Y - 2} width={tray.width} height={4} fill="rgba(0,0,0,0.35)" />
      {(['white', 'black'] as const).map((player) => {
        const half = halfFor(player, perspective, 'off');
        const y = half === 'top' ? MID_Y - 26 : MID_Y + 26;
        return (
          <g key={player} data-testid={`pips-label-${player}`}>
            <text
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={26}
              fontWeight={700}
              fill={board.label}
              opacity={0.9}
              style={{ fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)' }}
            >
              {pips[player]}
            </text>
            <text
              x={x}
              y={half === 'top' ? y - 24 : y + 24}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fill={board.label}
              opacity={0.6}
              style={{
                fontFamily: 'var(--ui-font, system-ui, sans-serif)',
                letterSpacing: 2,
                textTransform: 'uppercase',
              }}
            >
              {names[player].slice(0, 9)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
