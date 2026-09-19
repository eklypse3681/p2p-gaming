import type { Board, MatchState, Play, Player, SubMove } from '@bgf/engine';
import { OFF, applyPlay, canDouble, countAt, legalPlays, opponent, pipCount } from '@bgf/engine';
import type { BackgammonCommand } from '@bgf/server';

export interface BackgammonBotOptions {
  rng?: { int(n: number): number };
  /** Offer a double when ahead by at least this share of the opponent's pip count. */
  doubleLead?: number;
  /** Take a double unless behind by more than this share. */
  takeBehind?: number;
}

function blots(board: Board, player: Player): number {
  let n = 0;
  for (let rel = 1; rel <= 24; rel++) if (countAt(board, player, rel) === 1) n++;
  return n;
}

function madePoints(board: Board, player: Player): number {
  let n = 0;
  for (let rel = 1; rel <= 24; rel++) if (countAt(board, player, rel) >= 2) n++;
  return n;
}

/** A fast static score of a play: hits, points made, bear-offs, and exposure. */
export function scorePlay(board: Board, player: Player, play: Play): number {
  const after = applyPlay(board, player, play);
  const opp = opponent(player);
  let v = 0;
  for (const m of play) {
    if (m.hit) v += 30;
    if (m.to === OFF) v += 8;
  }
  v += (madePoints(after, player) - madePoints(board, player)) * 12;
  v -= (blots(after, player) - blots(board, player)) * 6;
  v += (pipCount(board, player) - pipCount(after, player)) * 0.5;
  v += (pipCount(after, opp) - pipCount(board, opp)) * 0.8;
  return v;
}

function bestPlay(
  board: Board,
  player: Player,
  plays: Play[],
  rng?: BackgammonBotOptions['rng'],
): SubMove[] {
  let bestValue = -Infinity;
  let top: Play[] = [];
  for (const p of plays) {
    const v = scorePlay(board, player, p);
    if (v > bestValue) {
      bestValue = v;
      top = [p];
    } else if (v === bestValue) top.push(p);
  }
  return top[rng ? rng.int(top.length) : 0] ?? [];
}

/**
 * What `player` should do now, or null when it is not their move (or the match is over).
 * Legal by construction: plays come from `legalPlays`, cube actions from `canDouble`/phase.
 */
export function backgammonBot(
  match: MatchState,
  player: Player,
  opts: BackgammonBotOptions = {},
): BackgammonCommand | null {
  if (match.winner !== null) return null;
  const game = match.game;
  if (!game) return { type: 'start-game' };
  const ph = game.phase;
  switch (ph.kind) {
    case 'opening':
      return ph.rolls[player] === undefined ? { type: 'opening-roll' } : null;
    case 'to-roll': {
      if (ph.player !== player) return null;
      const lead = pipCount(game.board, opponent(player)) - pipCount(game.board, player);
      const threshold =
        (opts.doubleLead ?? 0.1) * Math.max(1, pipCount(game.board, opponent(player)));
      if (canDouble(game, player) && lead >= threshold) return { type: 'double' };
      return { type: 'roll' };
    }
    case 'double-offered': {
      if (ph.by === player) return null;
      const behind = pipCount(game.board, player) - pipCount(game.board, opponent(player));
      const limit = (opts.takeBehind ?? 0.3) * Math.max(1, pipCount(game.board, opponent(player)));
      return behind > limit ? { type: 'drop' } : { type: 'take' };
    }
    case 'moving': {
      if (ph.player !== player) return null;
      const plays = legalPlays(game.board, player, ph.dice);
      if (plays.length === 0) return null; // the engine auto-skips; nothing to send
      return { type: 'play', play: bestPlay(game.board, player, plays, opts.rng) };
    }
    case 'resign-offered':
      return ph.by === player ? null : { type: 'decline-resign' };
    case 'free':
    case 'over':
      return null;
  }
}
