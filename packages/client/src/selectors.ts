import type { DiceRoll, Player, ResultKind } from '@bgf/engine';
import {
  canDouble as engineCanDouble,
  isFreeMode as configIsFree,
  opponent,
  pipCount,
} from '@bgf/engine';
import type { HomeSide } from '@bgf/protocol';
import { DEFAULT_HOME_SIDE, sideForSeat } from '@bgf/protocol';
import type { ClientState } from './types.js';

/** Pure helpers over `ClientState` for UIs and tests. */

export function opponentSeat(state: ClientState): Player | null {
  return state.seat ? opponent(state.seat) : null;
}

export function playerName(state: ClientState, seat: Player): string {
  return state.snapshot?.players[seat]?.name ?? (seat === 'white' ? 'White' : 'Black');
}

export function pips(state: ClientState): Record<Player, number> {
  const board = state.draft.board;
  return { white: pipCount(board, 'white'), black: pipCount(board, 'black') };
}

function game(state: ClientState) {
  return state.status === 'joined' ? (state.snapshot?.match.game ?? null) : null;
}

/** True when the match is played on a free board (no rule enforcement). */
export function isFreeMode(state: ClientState): boolean {
  return !!state.snapshot && configIsFree(state.snapshot.match.config);
}

/** Free board: either player may roll at any time while a game is in play. */
export function canFreeRoll(state: ClientState): boolean {
  const g = game(state);
  return !!g && !!state.seat && g.phase.kind === 'free';
}

/** Free board: either player may record the result of the game in play. */
export function canRecordResult(state: ClientState): boolean {
  return canFreeRoll(state);
}

/** The most recent roll on a free board, or null. */
export function lastFreeDice(state: ClientState): { player: Player; dice: DiceRoll } | null {
  const g = game(state);
  if (!g || g.phase.kind !== 'free') return null;
  return g.phase.dice;
}

export function canStartGame(state: ClientState): boolean {
  if (state.status !== 'joined' || !state.snapshot) return false;
  const m = state.snapshot.match;
  if (m.winner) return false;
  return m.game === null || m.game.phase.kind === 'over';
}

export function canOpeningRoll(state: ClientState): boolean {
  const g = game(state);
  const seat = state.seat;
  return !!g && !!seat && g.phase.kind === 'opening' && g.phase.rolls[seat] === undefined;
}

export function canRoll(state: ClientState): boolean {
  const g = game(state);
  return !!g && g.phase.kind === 'to-roll' && g.phase.player === state.seat;
}

export function canDouble(state: ClientState): boolean {
  const g = game(state);
  return !!g && !!state.seat && engineCanDouble(g, state.seat);
}

export function canRespondToDouble(state: ClientState): boolean {
  const g = game(state);
  return !!g && g.phase.kind === 'double-offered' && g.phase.by !== state.seat;
}

export function isMoving(state: ClientState): boolean {
  const g = game(state);
  return !!g && g.phase.kind === 'moving' && g.phase.player === state.seat;
}

export function canCommit(state: ClientState): boolean {
  return isMoving(state) && state.draft.complete && !state.draft.pending;
}

export function canUndo(state: ClientState): boolean {
  return isMoving(state) && state.draft.played.length > 0 && !state.draft.pending;
}

export function canResign(state: ClientState): boolean {
  const g = game(state);
  return (
    !!g &&
    g.phase.kind !== 'over' &&
    g.phase.kind !== 'opening' &&
    g.phase.kind !== 'resign-offered'
  );
}

export interface PendingResign {
  by: Player;
  stakes: ResultKind;
  /** True when the local player made the offer. */
  mine: boolean;
}

export function pendingResign(state: ClientState): PendingResign | null {
  const g = game(state);
  if (!g || g.phase.kind !== 'resign-offered') return null;
  return { by: g.phase.by, stakes: g.phase.stakes, mine: g.phase.by === state.seat };
}

/** True when the local player has to act (roll, move, respond to a cube or a resignation). */
export function myTurn(state: ClientState): boolean {
  const g = game(state);
  const seat = state.seat;
  if (!g || !seat) return false;
  switch (g.phase.kind) {
    case 'opening':
      return g.phase.rolls[seat] === undefined;
    case 'to-roll':
    case 'moving':
      return g.phase.player === seat;
    case 'double-offered':
    case 'resign-offered':
      return g.phase.by !== seat;
    case 'free':
      return true;
    case 'over':
      return false;
  }
}

export interface PhaseSummary {
  text: string;
  /** Seat whose action everyone is waiting on, or null. */
  waitingOn: Player | null;
}

const STAKES_LABEL: Record<ResultKind, string> = {
  single: 'single game',
  gammon: 'gammon',
  backgammon: 'backgammon',
};

export function phaseSummary(state: ClientState): PhaseSummary {
  if (state.status === 'connecting') return { text: 'Connecting…', waitingOn: null };
  if (state.status === 'rejected') return { text: 'Could not join this match', waitingOn: null };
  if (state.status === 'disconnected') return { text: 'Disconnected', waitingOn: null };
  const snapshot = state.snapshot;
  const seat = state.seat;
  if (!snapshot || !seat) return { text: 'Joining…', waitingOn: null };
  const me = seat;
  const them = opponent(seat);
  const theirName = playerName(state, them);
  const m = snapshot.match;
  if (m.winner) {
    return {
      text: m.winner === me ? 'You win the match!' : `${theirName} wins the match`,
      waitingOn: null,
    };
  }
  const g = m.game;
  if (!g) {
    return {
      text: snapshot.players[them] ? 'Ready to start' : `Waiting for an opponent to join`,
      waitingOn: null,
    };
  }
  const ph = g.phase;
  switch (ph.kind) {
    case 'opening':
      if (ph.rolls[me] === undefined) {
        return {
          text: ph.ties > 0 ? 'Tie! Roll again for the opening' : 'Roll for the opening',
          waitingOn: me,
        };
      }
      return { text: `Waiting for ${theirName} to roll`, waitingOn: them };
    case 'to-roll':
      if (ph.player === me) {
        return {
          text: engineCanDouble(g, me) ? 'Your turn: roll or double' : 'Your roll',
          waitingOn: me,
        };
      }
      return { text: `Waiting for ${theirName} to roll`, waitingOn: them };
    case 'double-offered':
      if (ph.by === me) {
        return { text: `Waiting for ${theirName} to respond to your double`, waitingOn: them };
      }
      return {
        text: `${theirName} offers a double to ${g.cube.value * 2} — take or drop?`,
        waitingOn: me,
      };
    case 'moving':
      if (ph.player === me) {
        const draft = state.draft;
        if (draft.pending) return { text: 'Sending your move…', waitingOn: me };
        if (draft.complete) return { text: 'Confirm your move', waitingOn: me };
        return { text: `Your move: ${ph.dice[0]}-${ph.dice[1]}`, waitingOn: me };
      }
      return { text: `Waiting for ${theirName} to move`, waitingOn: them };
    case 'free': {
      if (!ph.dice) {
        return { text: 'Free board — drag any checker, roll whenever you like', waitingOn: null };
      }
      const who = ph.dice.player === me ? 'You' : theirName;
      return {
        text: `Free board — ${who} rolled ${ph.dice.dice[0]}-${ph.dice.dice[1]}`,
        waitingOn: null,
      };
    }
    case 'resign-offered':
      if (ph.by === me) {
        return { text: `Waiting for ${theirName} to respond to your resignation`, waitingOn: them };
      }
      return {
        text: `${theirName} offers to resign a ${STAKES_LABEL[ph.stakes]} — accept or decline?`,
        waitingOn: me,
      };
    case 'over': {
      const r = ph.result;
      const pts = `${r.points} point${r.points === 1 ? '' : 's'}`;
      const kind = r.kind === 'single' ? '' : ` (${r.kind})`;
      return {
        text:
          r.winner === me
            ? `You win the game${kind} for ${pts}`
            : `${theirName} wins the game${kind} for ${pts}`,
        waitingOn: null,
      };
    }
  }
}

/**
 * Side of the home boards as seen from `seat` (default: this client's seat). The table has one
 * layout chosen by the host; the seat across the table sees the mirror image.
 */
export function homeSideFor(state: ClientState, seat: Player | null = state.seat): HomeSide {
  const snapshot = state.snapshot;
  if (!snapshot || !seat) return DEFAULT_HOME_SIDE;
  return sideForSeat(snapshot, seat);
}
