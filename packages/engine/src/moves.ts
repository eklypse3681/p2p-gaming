import type { Board, Die, DiceRoll, Play, Player, RelPoint, SubMove } from './types.js';
import {
  BAR,
  OFF,
  allInHome,
  applySubMove,
  boardKey,
  opponentCountAt,
  countAt,
  undoSubMove,
} from './board.js';

/** A landing point is open if it holds at most one opposing checker. */
export function canLand(board: Board, player: Player, to: RelPoint): boolean {
  if (to < 1 || to > 24) return false;
  return opponentCountAt(board, player, to) <= 1;
}

function isHit(board: Board, player: Player, to: RelPoint): boolean {
  return to >= 1 && to <= 24 && opponentCountAt(board, player, to) === 1;
}

/**
 * All sub-moves `player` may make with a single die from `board`, ignoring the
 * "must use both dice" constraint (which is enforced by `legalPlays`).
 */
export function singleDieMoves(board: Board, player: Player, die: Die): SubMove[] {
  const out: SubMove[] = [];
  if (board.bar[player] > 0) {
    const to = BAR - die;
    if (canLand(board, player, to)) out.push({ from: BAR, to, die, hit: isHit(board, player, to) });
    return out;
  }
  const home = allInHome(board, player);
  let highest = 0;
  for (let rel = 24; rel >= 1; rel--) {
    if (countAt(board, player, rel) === 0) continue;
    if (highest === 0) highest = rel;
    const to = rel - die;
    if (to >= 1) {
      if (canLand(board, player, to)) out.push({ from: rel, to, die, hit: isHit(board, player, to) });
    } else if (home) {
      // Exact bear-off, or a larger die from the highest occupied point.
      if (to === 0 || rel === highest) out.push({ from: rel, to: OFF, die, hit: false });
    }
  }
  return out;
}

function enumerate(
  board: Board,
  player: Player,
  dice: readonly Die[],
  path: SubMove[],
  out: Play[],
): void {
  if (dice.length === 0) {
    out.push(path.slice());
    return;
  }
  const die = dice[0]!;
  const moves = singleDieMoves(board, player, die);
  if (moves.length === 0) {
    out.push(path.slice());
    return;
  }
  const rest = dice.slice(1);
  for (const m of moves) {
    path.push(m);
    enumerate(applySubMove(board, player, m), player, rest, path, out);
    path.pop();
  }
}

export function subMoveKey(m: SubMove): string {
  return `${m.from}>${m.to}/${m.die}`;
}

export function playKey(play: readonly SubMove[]): string {
  return play.map(subMoveKey).join(' ');
}

/**
 * Every legal full play for `player` rolling `dice` from `board`, as ordered sequences.
 * Enforces: use as many dice as possible; if only one die can be used, prefer the higher one;
 * checkers on the bar enter first; bear-off rules. Returns [] when there is no legal move.
 * Both die orders are included so that any interactive ordering is a prefix of some play.
 */
export function legalPlays(board: Board, player: Player, dice: DiceRoll): Play[] {
  const [a, b] = dice;
  const orders: Die[][] = a === b ? [[a, a, a, a]] : [[a, b], [b, a]];
  const raw: Play[] = [];
  for (const order of orders) enumerate(board, player, order, [], raw);
  let max = 0;
  for (const p of raw) if (p.length > max) max = p.length;
  if (max === 0) return [];
  let plays = raw.filter((p) => p.length === max);
  if (max === 1 && a !== b) {
    const hi = Math.max(a, b);
    const usingHi = plays.filter((p) => p[0]!.die === hi);
    if (usingHi.length > 0) plays = usingHi;
  }
  const seen = new Set<string>();
  const unique: Play[] = [];
  for (const p of plays) {
    const k = playKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(p);
    }
  }
  return unique;
}

/** Legal plays de-duplicated by resulting position (one representative per distinct outcome). */
export function distinctPlays(board: Board, player: Player, dice: DiceRoll): Play[] {
  const seen = new Set<string>();
  const out: Play[] = [];
  for (const p of legalPlays(board, player, dice)) {
    let b = board;
    for (const m of p) b = applySubMove(b, player, m);
    const k = boardKey(b);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

export function hasLegalMove(board: Board, player: Player, dice: DiceRoll): boolean {
  return legalPlays(board, player, dice).length > 0;
}

function sameStep(a: SubMove, b: SubMove): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die;
}

/**
 * True if `play` (compared by from/to/die) is one of the legal plays. Returns the canonical
 * play (with correct `hit` flags) on success, or null.
 */
export function findLegalPlay(
  board: Board,
  player: Player,
  dice: DiceRoll,
  play: readonly SubMove[],
): Play | null {
  for (const p of legalPlays(board, player, dice)) {
    if (p.length !== play.length) continue;
    if (p.every((m, i) => sameStep(m, play[i]!))) return p;
  }
  return null;
}

/**
 * Interactive turn construction. Given the board at the *start* of the turn, the dice and the
 * sub-moves played so far, computes what may happen next. Every method is pure; the UI keeps
 * `played` and calls these helpers.
 */
export interface TurnOptions {
  /** Sub-moves that can legally be played next (each extends `played` to a prefix of a legal play). */
  next: SubMove[];
  /** Dice not yet used, in the order they may still be used (multiset). */
  remaining: Die[];
  /** True when `played` is a complete legal play (turn may be ended). */
  complete: boolean;
  /** Maximum number of sub-moves in any legal play from the start of this turn. */
  maxMoves: number;
}

export function turnOptions(
  startBoard: Board,
  player: Player,
  dice: DiceRoll,
  played: readonly SubMove[],
): TurnOptions {
  const plays = legalPlays(startBoard, player, dice);
  const maxMoves = plays[0]?.length ?? 0;
  const nextKeys = new Set<string>();
  const next: SubMove[] = [];
  for (const p of plays) {
    if (p.length <= played.length) continue;
    let prefix = true;
    for (let i = 0; i < played.length; i++) {
      if (!sameStep(p[i]!, played[i]!)) {
        prefix = false;
        break;
      }
    }
    if (!prefix) continue;
    const m = p[played.length]!;
    const k = subMoveKey(m);
    if (!nextKeys.has(k)) {
      nextKeys.add(k);
      next.push(m);
    }
  }
  const remaining: Die[] =
    dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]];
  for (const m of played) {
    const i = remaining.indexOf(m.die);
    if (i >= 0) remaining.splice(i, 1);
  }
  return { next, remaining, complete: played.length === maxMoves, maxMoves };
}

/** Board at the start of a turn, reconstructed by undoing `played` from the current board. */
export function turnStartBoard(
  currentBoard: Board,
  player: Player,
  played: readonly SubMove[],
): Board {
  let b = currentBoard;
  for (let i = played.length - 1; i >= 0; i--) b = undoSubMove(b, player, played[i]!);
  return b;
}

/**
 * For the UI: destinations reachable from `from` given the current turn, including two-step
 * routes (both dice on one checker) when the intermediate point is legal.
 */
export interface Destination {
  to: RelPoint;
  /** The sub-moves to play (1 or more) to get there. */
  via: SubMove[];
}

export function destinationsFrom(
  startBoard: Board,
  player: Player,
  dice: DiceRoll,
  played: readonly SubMove[],
  from: RelPoint,
): Destination[] {
  const out = new Map<RelPoint, Destination>();
  const first = turnOptions(startBoard, player, dice, played);
  for (const m of first.next) {
    if (m.from !== from) continue;
    if (!out.has(m.to)) out.set(m.to, { to: m.to, via: [m] });
  }
  // Two-step (and for doubles, up to four-step) routes with the same checker.
  const explore = (chain: SubMove[], depth: number) => {
    if (depth >= 4) return;
    const last = chain[chain.length - 1]!;
    if (last.to === OFF) return;
    const opts = turnOptions(startBoard, player, dice, [...played, ...chain]);
    for (const m of opts.next) {
      if (m.from !== last.to) continue;
      const next = [...chain, m];
      if (!out.has(m.to)) out.set(m.to, { to: m.to, via: next });
      explore(next, depth + 1);
    }
  };
  for (const d of Array.from(out.values())) explore(d.via, 1);
  return Array.from(out.values()).sort((x, y) => y.to - x.to);
}
