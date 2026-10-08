import { motion } from 'motion/react';
import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import type { Geometry } from '../geometry';
import { DEFAULT_GEOMETRY } from '../geometry';
import type { DiceVM, HomeSide, OpeningDiceVM } from '../contract';

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

export interface DieProps {
  value: number;
  x: number;
  y: number;
  size: number;
  /** Already moved this turn: shrunk, faded, with a check mark. */
  used?: boolean;
  /** Cannot be played: greyed out. */
  blocked?: boolean;
  board: BoardSet;
  testId?: string;
  reducedMotion?: boolean;
  /** Changing this key replays the roll animation. */
  rollKey?: string | number;
}

const BLOCKED_FACE = '#7c7f87';
const BLOCKED_PIP = '#4a4c52';
const DONE_MARK = '#2f9e5b';

export function Die({
  value,
  x,
  y,
  size,
  used,
  blocked,
  board,
  testId,
  reducedMotion,
  rollKey,
}: DieProps) {
  const half = size / 2;
  const pipR = size * 0.085;
  const spread = size * 0.26;
  const pips = PIPS[value] ?? [];
  const face = blocked ? BLOCKED_FACE : board.diceFace;
  const pip = blocked ? BLOCKED_PIP : board.dicePip;
  // The treatment lives on an inner group so it never fights the roll animation's opacity.
  // Used: still its own colour, smaller and a little faded, with a check mark (done).
  // Blocked: grey all over, so it reads as "this one cannot be played".
  const look = used
    ? { opacity: 0.92, transform: 'scale(0.78)' }
    : blocked
      ? { opacity: 0.55, transform: 'scale(0.94)' }
      : { opacity: 1, transform: 'scale(1)' };
  return (
    <motion.g
      key={rollKey}
      data-testid={testId}
      data-value={value}
      data-used={used ? 'true' : undefined}
      data-blocked={blocked ? 'true' : undefined}
      initial={reducedMotion ? false : { x, y, rotate: -40, scale: 0.55, opacity: 0 }}
      animate={
        reducedMotion
          ? { x, y, rotate: 0, scale: 1, opacity: 1 }
          : { x, y, rotate: [-40, 18, -8, 0], scale: [0.55, 1.08, 0.97, 1], opacity: 1 }
      }
      transition={reducedMotion ? { duration: 0 } : { duration: 0.5, ease: 'easeOut' }}
      style={{ pointerEvents: 'none' }}
    >
      <g
        style={{
          ...look,
          transition: reducedMotion ? undefined : 'opacity 180ms ease, transform 180ms ease',
        }}
      >
        <rect
          x={-half}
          y={-half + 5}
          width={size}
          height={size}
          rx={size * 0.2}
          fill="rgba(0,0,0,0.35)"
          opacity={used || blocked ? 0.4 : 1}
        />
        <rect
          x={-half}
          y={-half}
          width={size}
          height={size}
          rx={size * 0.2}
          fill={face}
          stroke="rgba(0,0,0,0.25)"
          strokeWidth={2}
        />
        {!blocked && (
          <rect
            x={-half + 4}
            y={-half + 4}
            width={size - 8}
            height={size * 0.42}
            rx={size * 0.16}
            fill="#fff"
            opacity={0.28}
          />
        )}
        {pips.map(([px, py], i) => (
          <circle key={i} cx={px * spread} cy={py * spread} r={pipR} fill={pip} />
        ))}
      </g>
      {used && (
        <g data-testid={testId ? `${testId}-done` : undefined} aria-hidden="true">
          <circle
            cx={half * 0.62}
            cy={-half * 0.62}
            r={size * 0.2}
            fill={DONE_MARK}
            stroke="#fff"
            strokeWidth={size * 0.035}
          />
          <path
            d={`M ${half * 0.62 - size * 0.09} ${-half * 0.62} l ${size * 0.065} ${size * 0.065} l ${size * 0.115} ${-size * 0.12}`}
            fill="none"
            stroke="#fff"
            strokeWidth={size * 0.05}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
    </motion.g>
  );
}

export interface DiceGroupProps {
  /** Board layout; the classic 3:2 board when omitted. */
  geo?: Geometry;
  dice: DiceVM;
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
  reducedMotion?: boolean;
}

/** The mover's dice; doubles show four dice so each consumed move is visible. */
export function DiceGroup({
  dice,
  perspective,
  homeSide,
  board,
  reducedMotion,
  geo = DEFAULT_GEOMETRY,
}: DiceGroupProps) {
  const { dicePositions } = geo;
  const count = dice.used.length;
  const positions = dicePositions(dice.player, perspective, count, homeSide);
  return (
    <g data-testid="dice" data-player={dice.player}>
      {positions.map((p, i) => (
        <Die
          key={`${dice.rollToken}-${i}`}
          rollKey={`${dice.rollToken}-${i}`}
          value={count === 4 ? dice.values[0] : dice.values[i]!}
          x={p.x}
          y={p.y}
          size={p.size}
          used={dice.used[i]}
          blocked={dice.blocked[i]}
          board={board}
          testId={`die-${i}`}
          reducedMotion={reducedMotion}
        />
      ))}
    </g>
  );
}

export interface OpeningDiceProps {
  /** Board layout; the classic 3:2 board when omitted. */
  geo?: Geometry;
  opening: OpeningDiceVM;
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
  reducedMotion?: boolean;
}

/** Opening roll: one die on each player's side. */
export function OpeningDice({
  opening,
  perspective,
  homeSide,
  board,
  reducedMotion,
  geo = DEFAULT_GEOMETRY,
}: OpeningDiceProps) {
  const { openingDiePosition } = geo;
  return (
    <g data-testid="dice" data-opening="true">
      {(['white', 'black'] as const).map((player) => {
        const value = opening[player];
        if (value === undefined) return null;
        const p = openingDiePosition(player, perspective, homeSide);
        return (
          <Die
            key={`${player}-${opening.ties}-${value}`}
            rollKey={`${player}-${opening.ties}-${value}`}
            value={value}
            x={p.x}
            y={p.y}
            size={p.size}
            board={board}
            testId={`die-${player}`}
            reducedMotion={reducedMotion}
          />
        );
      })}
    </g>
  );
}
