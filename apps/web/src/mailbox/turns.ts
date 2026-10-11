import type { MatchState, Player } from '@bgf/engine';
import { playerToAct } from '@bgf/engine';

const COLORS: Player[] = ['white', 'black'];

/** Whether the backgammon seat (0 white, 1 black) has something to do: worth waking them for. */
export function backgammonTurn(match: MatchState, seat: number): boolean {
  const color = COLORS[seat];
  const game = match.game;
  if (!color || !game || match.winner !== null) return false;
  if (game.phase.kind === 'opening') return game.phase.rolls[color] === undefined;
  return playerToAct(game) === color;
}

/** Whether the OFC seat has cards waiting to be set. Works on the full state and on views. */
export function ofcTurn(state: unknown, seat: number): boolean {
  const hand = (state as { hand?: { phase?: string; seats?: unknown[] } } | null)?.hand;
  if (!hand || hand.phase !== 'setting') return false;
  const s = hand.seats?.[seat] as { done?: boolean; pending?: unknown[] } | undefined;
  return !!s && !s.done && (s.pending?.length ?? 0) > 0;
}
