import type { Board, Player, RelPoint, SubMove } from './types.js';
import { RuleError } from './types.js';

export const BAR: RelPoint = 25;
export const OFF: RelPoint = 0;
export const CHECKERS_PER_PLAYER = 15;

export function opponent(p: Player): Player {
  return p === 'white' ? 'black' : 'white';
}

/** Absolute board index (0..23) of player-relative point `rel` (1..24). */
export function absIndex(player: Player, rel: RelPoint): number {
  if (rel < 1 || rel > 24) throw new RangeError(`rel point out of range: ${rel}`);
  return player === 'white' ? rel - 1 : 24 - rel;
}

/** Player-relative point (1..24) of absolute board index (0..23). */
export function relPoint(player: Player, index: number): RelPoint {
  if (index < 0 || index > 23) throw new RangeError(`index out of range: ${index}`);
  return player === 'white' ? index + 1 : 24 - index;
}

/** Absolute point number (1..24) of an absolute index, i.e. White's numbering. */
export function absPointNumber(index: number): number {
  return index + 1;
}

export function sign(player: Player): 1 | -1 {
  return player === 'white' ? 1 : -1;
}

/** Number of `player`'s checkers on their relative point `rel` (1..24), bar (25) or off (0). */
export function countAt(board: Board, player: Player, rel: RelPoint): number {
  if (rel === BAR) return board.bar[player];
  if (rel === OFF) return board.off[player];
  const v = board.points[absIndex(player, rel)] ?? 0;
  return player === 'white' ? Math.max(v, 0) : Math.max(-v, 0);
}

/** Number of the *opponent's* checkers sitting on `player`'s relative point `rel` (1..24). */
export function opponentCountAt(board: Board, player: Player, rel: RelPoint): number {
  const v = board.points[absIndex(player, rel)] ?? 0;
  return player === 'white' ? Math.max(-v, 0) : Math.max(v, 0);
}

/** Owner of the checkers at absolute index, or null if empty. */
export function ownerAt(board: Board, index: number): Player | null {
  const v = board.points[index] ?? 0;
  return v > 0 ? 'white' : v < 0 ? 'black' : null;
}

export function emptyBoard(): Board {
  return {
    points: new Array<number>(24).fill(0),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
  };
}

/** Standard starting position. */
export function startingBoard(): Board {
  const b = emptyBoard();
  const place = (player: Player, rel: number, n: number) => {
    b.points[absIndex(player, rel)] = sign(player) * n;
  };
  for (const p of ['white', 'black'] as const) {
    place(p, 24, 2);
    place(p, 13, 5);
    place(p, 8, 3);
    place(p, 6, 5);
  }
  return b;
}

export function cloneBoard(board: Board): Board {
  return {
    points: board.points.slice(),
    bar: { ...board.bar },
    off: { ...board.off },
  };
}

/**
 * Build a board from a compact description. Useful for tests.
 * Each entry maps a player-relative point (1..24, 25 = bar, 0 = off) to a checker count.
 */
export function boardFrom(
  white: Record<number, number>,
  black: Record<number, number>,
): Board {
  const b = emptyBoard();
  const put = (player: Player, spec: Record<number, number>) => {
    for (const [k, n] of Object.entries(spec)) {
      const rel = Number(k);
      if (rel === BAR) b.bar[player] += n;
      else if (rel === OFF) b.off[player] += n;
      else {
        const i = absIndex(player, rel);
        if ((b.points[i] ?? 0) !== 0) throw new Error(`point ${i} already occupied`);
        b.points[i] = sign(player) * n;
      }
    }
  };
  put('white', white);
  put('black', black);
  return b;
}

/** Total checkers (on board + bar + off) for a player. */
export function totalCheckers(board: Board, player: Player): number {
  let n = board.bar[player] + board.off[player];
  for (let i = 0; i < 24; i++) {
    const v = board.points[i] ?? 0;
    if (player === 'white' && v > 0) n += v;
    if (player === 'black' && v < 0) n -= v;
  }
  return n;
}

export function assertValidBoard(board: Board): void {
  if (board.points.length !== 24) throw new RuleError('bad-board', 'board must have 24 points');
  for (const p of ['white', 'black'] as const) {
    if (totalCheckers(board, p) !== CHECKERS_PER_PLAYER) {
      throw new RuleError('bad-board', `${p} must have ${CHECKERS_PER_PLAYER} checkers`);
    }
  }
}

/** True when all of `player`'s checkers not yet borne off are in their home board (rel 1..6). */
export function allInHome(board: Board, player: Player): boolean {
  if (board.bar[player] > 0) return false;
  for (let rel = 7; rel <= 24; rel++) {
    if (countAt(board, player, rel) > 0) return false;
  }
  return true;
}

/** Pip count: total distance the player's checkers must travel to bear off. */
export function pipCount(board: Board, player: Player): number {
  let pips = board.bar[player] * 25;
  for (let rel = 1; rel <= 24; rel++) pips += countAt(board, player, rel) * rel;
  return pips;
}

/** Apply a sub-move for `player` and return a new board. Does not validate legality. */
export function applySubMove(board: Board, player: Player, m: SubMove): Board {
  const b = cloneBoard(board);
  const s = sign(player);
  if (m.from === BAR) {
    b.bar[player] -= 1;
  } else {
    const i = absIndex(player, m.from);
    b.points[i] = (b.points[i] ?? 0) - s;
  }
  if (m.to === OFF) {
    b.off[player] += 1;
  } else {
    const i = absIndex(player, m.to);
    if (m.hit) {
      b.points[i] = 0;
      b.bar[opponent(player)] += 1;
    }
    b.points[i] = (b.points[i] ?? 0) + s;
  }
  return b;
}

/** Reverse a previously applied sub-move. */
export function undoSubMove(board: Board, player: Player, m: SubMove): Board {
  const b = cloneBoard(board);
  const s = sign(player);
  if (m.to === OFF) {
    b.off[player] -= 1;
  } else {
    const i = absIndex(player, m.to);
    b.points[i] = (b.points[i] ?? 0) - s;
    if (m.hit) {
      b.bar[opponent(player)] -= 1;
      b.points[i] = -s;
    }
  }
  if (m.from === BAR) {
    b.bar[player] += 1;
  } else {
    const i = absIndex(player, m.from);
    b.points[i] = (b.points[i] ?? 0) + s;
  }
  return b;
}

export function applyPlay(board: Board, player: Player, play: readonly SubMove[]): Board {
  let b = board;
  for (const m of play) b = applySubMove(b, player, m);
  return b;
}

export function boardKey(board: Board): string {
  return `${board.points.join(',')}|${board.bar.white},${board.bar.black}|${board.off.white},${board.off.black}`;
}

export function boardsEqual(a: Board, b: Board): boolean {
  return boardKey(a) === boardKey(b);
}
