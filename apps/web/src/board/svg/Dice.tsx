import { motion } from 'motion/react';
import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import { dicePositions, openingDiePosition } from '../geometry';
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
  used?: boolean;
  board: BoardSet;
  testId?: string;
  reducedMotion?: boolean;
  /** Changing this key replays the roll animation. */
  rollKey?: string | number;
}

export function Die({ value, x, y, size, used, board, testId, reducedMotion, rollKey }: DieProps) {
  const half = size / 2;
  const pipR = size * 0.085;
  const spread = size * 0.26;
  const pips = PIPS[value] ?? [];
  return (
    <motion.g
      key={rollKey}
      data-testid={testId}
      data-value={value}
      data-used={used ? 'true' : undefined}
      initial={reducedMotion ? false : { x, y, rotate: -40, scale: 0.55, opacity: 0 }}
      animate={
        reducedMotion
          ? { x, y, rotate: 0, scale: 1, opacity: 1 }
          : { x, y, rotate: [-40, 18, -8, 0], scale: [0.55, 1.08, 0.97, 1], opacity: 1 }
      }
      transition={reducedMotion ? { duration: 0 } : { duration: 0.5, ease: 'easeOut' }}
      style={{ opacity: used ? 0.38 : 1, pointerEvents: 'none' }}
    >
      <rect
        x={-half}
        y={-half + 5}
        width={size}
        height={size}
        rx={size * 0.2}
        fill="rgba(0,0,0,0.35)"
      />
      <rect
        x={-half}
        y={-half}
        width={size}
        height={size}
        rx={size * 0.2}
        fill={board.diceFace}
        stroke="rgba(0,0,0,0.25)"
        strokeWidth={2}
      />
      <rect
        x={-half + 4}
        y={-half + 4}
        width={size - 8}
        height={size * 0.42}
        rx={size * 0.16}
        fill="#fff"
        opacity={0.28}
      />
      {pips.map(([px, py], i) => (
        <circle key={i} cx={px * spread} cy={py * spread} r={pipR} fill={board.dicePip} />
      ))}
    </motion.g>
  );
}

export interface DiceGroupProps {
  dice: DiceVM;
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
  reducedMotion?: boolean;
}

/** The mover's dice; doubles show four dice so each consumed move is visible. */
export function DiceGroup({ dice, perspective, homeSide, board, reducedMotion }: DiceGroupProps) {
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
          board={board}
          testId={`die-${i}`}
          reducedMotion={reducedMotion}
        />
      ))}
    </g>
  );
}

export interface OpeningDiceProps {
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
}: OpeningDiceProps) {
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
