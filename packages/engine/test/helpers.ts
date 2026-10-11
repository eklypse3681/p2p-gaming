import type { Board, Die, DiceRoll, GameState, Play, Player, SubMove } from '../src/index.js';
import { boardFrom, legalPlays, newGame, game } from '../src/index.js';

/** Shorthand sub-move (hit defaults to false; findLegalPlay ignores it anyway). */
export function sm(from: number, to: number, die: number, hit = false): SubMove {
  return { from, to, die: die as Die, hit };
}

/** "13/7 7/6" style signature, order-preserving. Accepts a play or a single sub-move. */
export function sig(play: readonly SubMove[] | SubMove): string {
  const list = Array.isArray(play) ? play : [play as SubMove];
  return list.map((m) => `${m.from}/${m.to}`).join(' ');
}

/** Order-insensitive signature. */
export function sortedSig(play: readonly SubMove[]): string {
  return play
    .map((m) => `${m.from}/${m.to}`)
    .sort()
    .join(' ');
}

export function sigs(plays: readonly Play[]): string[] {
  return plays.map(sig).sort();
}

/**
 * Bring a fresh game on `board` into the `moving` phase for `player` with `dice` by playing the
 * opening roll with the right winner (dice[0] must differ from dice[1] here).
 */
export function movingGame(
  board: Board,
  player: Player,
  dice: DiceRoll,
  opts: { crawford?: boolean } = {},
): GameState {
  if (dice[0] === dice[1]) throw new Error('use rollTo for doubles');
  let s = newGame({ board, crawford: opts.crawford });
  const other = player === 'white' ? 'black' : 'white';
  s = game.openingRoll(s, player, dice[0] > dice[1] ? dice[0] : dice[1]);
  s = game.openingRoll(s, other, dice[0] > dice[1] ? dice[1] : dice[0]);
  // openingRoll orders dice as [winnerDie, loserDie]; caller asked for `dice` in some order.
  return s;
}

/** Get a state where `player` is `to-roll` on `board` (opponent won the opening and moved). */
export function toRollGame(board: Board, player: Player, opts: { crawford?: boolean } = {}): GameState {
  // Cheat: construct the state directly; the engine treats phase as plain data.
  const s = newGame({ board, crawford: opts.crawford });
  return { ...s, phase: { kind: 'to-roll', player } };
}

/** A tiny deterministic PRNG for property tests (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomDie(rnd: () => number): Die {
  return (Math.floor(rnd() * 6) + 1) as Die;
}

/**
 * Random legal-looking position: 15 checkers per side over points/bar/off, never sharing a
 * point between colours.
 */
export function randomBoard(rnd: () => number): Board {
  const white: Record<number, number> = {};
  const black: Record<number, number> = {};
  const occupied = new Map<number, Player>(); // abs index -> owner
  const place = (player: Player, spec: Record<number, number>) => {
    for (let i = 0; i < 15; i++) {
      const r = rnd();
      if (r < 0.08) {
        spec[25] = (spec[25] ?? 0) + 1;
        continue;
      }
      if (r < 0.2) {
        spec[0] = (spec[0] ?? 0) + 1;
        continue;
      }
      for (;;) {
        const rel = Math.floor(rnd() * 24) + 1;
        const abs = player === 'white' ? rel - 1 : 24 - rel;
        const owner = occupied.get(abs);
        if (owner && owner !== player) continue;
        occupied.set(abs, player);
        spec[rel] = (spec[rel] ?? 0) + 1;
        break;
      }
    }
  };
  place('white', white);
  place('black', black);
  return boardFrom(white, black);
}

export function firstPlay(board: Board, player: Player, dice: DiceRoll): Play {
  return legalPlays(board, player, dice)[0] ?? [];
}
