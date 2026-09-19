/**
 * Pure derivations over `ClientState` used by the HUD. Kept self-contained (engine-only) so the
 * HUD can be unit-tested with synthetic states; mirrors the selector set exposed by `@bgf/client`.
 */
import type { DiceRoll, GameState, MatchState, Player, ResultKind, RulesMode } from '@bgf/engine';
import { canDouble as engineCanDouble, opponent, pipCount, playerToAct } from '@bgf/engine';
import type { ClientState } from '@bgf/client';
import type { HomeSide } from '@bgf/protocol';
import { DEFAULT_HOME_SIDE, sideForSeat } from '@bgf/protocol';

export function currentGame(state: ClientState): GameState | null {
  return state.snapshot?.match.game ?? null;
}

export function currentMatch(state: ClientState): MatchState | null {
  return state.snapshot?.match ?? null;
}

export function opponentSeat(state: ClientState): Player | null {
  return state.seat ? opponent(state.seat) : null;
}

export function playerName(state: ClientState, seat: Player | null): string {
  if (!seat) return '—';
  const p = state.snapshot?.players[seat];
  if (p?.name) return p.name;
  return seat === 'white' ? 'White' : 'Black';
}

export function opponentName(state: ClientState): string {
  return playerName(state, opponentSeat(state));
}

export function opponentPresent(state: ClientState): boolean {
  const o = opponentSeat(state);
  return !!o && !!state.snapshot?.players[o];
}

export function opponentConnected(state: ClientState): boolean {
  const o = opponentSeat(state);
  return !!o && state.presence[o];
}

export function isJoined(state: ClientState): boolean {
  return state.status === 'joined' && !!state.snapshot && !!state.seat;
}

export function myTurn(state: ClientState): boolean {
  const g = currentGame(state);
  if (!g || !state.seat) return false;
  if (g.phase.kind === 'opening') return g.phase.rolls[state.seat] === undefined;
  return playerToAct(g) === state.seat;
}

export function canOpeningRoll(state: ClientState): boolean {
  const g = currentGame(state);
  return (
    isJoined(state) && !!g && g.phase.kind === 'opening' && g.phase.rolls[state.seat!] === undefined
  );
}

export function canRoll(state: ClientState): boolean {
  const g = currentGame(state);
  return isJoined(state) && !!g && g.phase.kind === 'to-roll' && g.phase.player === state.seat;
}

export function canDouble(state: ClientState): boolean {
  const g = currentGame(state);
  return isJoined(state) && !!g && engineCanDouble(g, state.seat!);
}

export function canRespondToDouble(state: ClientState): boolean {
  const g = currentGame(state);
  return isJoined(state) && !!g && g.phase.kind === 'double-offered' && g.phase.by !== state.seat;
}

/** Unattended table: games start by themselves; "Ready" is the way to the next one. */
export function isAutopilot(state: ClientState): boolean {
  const opt = state.snapshot?.autopilot;
  if (opt === true) return true;
  if (opt === false) return false;
  return !!state.snapshot?.dealer;
}

/** Readiness for the next game: mine, the opponent's, and whether both are set. */
export function readyState(state: ClientState): {
  mine: boolean;
  opponent: boolean;
  everyone: boolean;
} {
  const ready = state.ready ?? { white: false, black: false };
  const seat = state.seat;
  return {
    mine: seat ? ready[seat] : false,
    opponent: seat ? ready[opponent(seat)] : false,
    everyone: ready.white && ready.black,
  };
}

export function canStartGame(state: ClientState): boolean {
  const m = currentMatch(state);
  if (!isJoined(state) || !m || m.winner) return false;
  if (!opponentPresent(state)) return false;
  return !m.game || m.game.phase.kind === 'over';
}

export function isMoving(state: ClientState): boolean {
  const g = currentGame(state);
  return isJoined(state) && !!g && g.phase.kind === 'moving' && g.phase.player === state.seat;
}

export function canCommit(state: ClientState): boolean {
  return isMoving(state) && state.draft.complete && state.draft.maxMoves > 0;
}

export function canUndo(state: ClientState): boolean {
  return isMoving(state) && state.draft.played.length > 0;
}

export function pendingResign(state: ClientState): { by: Player; stakes: ResultKind } | null {
  const g = currentGame(state);
  if (!g || g.phase.kind !== 'resign-offered') return null;
  return { by: g.phase.by, stakes: g.phase.stakes };
}

export function canRespondToResign(state: ClientState): boolean {
  const r = pendingResign(state);
  return isJoined(state) && !!r && r.by !== state.seat;
}

export function canOfferResign(state: ClientState): boolean {
  const g = currentGame(state);
  if (!isJoined(state) || !g) return false;
  const k = g.phase.kind;
  return k !== 'over' && k !== 'opening' && k !== 'resign-offered';
}

// ---- free-board mode -----------------------------------------------------------------

export function rulesMode(state: ClientState): RulesMode {
  return state.snapshot?.match.config.rules ?? 'enforced';
}

/** The match was created as a free board (no rule enforcement). */
export function isFreeMode(state: ClientState): boolean {
  return rulesMode(state) === 'free';
}

/** A free-board game is in progress and this client may act on it. */
export function isFreeBoard(state: ClientState): boolean {
  const g = currentGame(state);
  return isJoined(state) && !!g && g.phase.kind === 'free';
}

export function canFreeRoll(state: ClientState): boolean {
  return isFreeBoard(state);
}

export function canRecordResult(state: ClientState): boolean {
  return isFreeBoard(state);
}

export function canSetCube(state: ClientState): boolean {
  return isFreeBoard(state);
}

export function canResetBoard(state: ClientState): boolean {
  return isFreeBoard(state);
}

/** The most recent roll on a free board, if any. */
export function lastFreeDice(state: ClientState): { player: Player; dice: DiceRoll } | null {
  const g = currentGame(state);
  if (!g || g.phase.kind !== 'free') return null;
  return g.phase.dice;
}

export function pips(state: ClientState): Record<Player, number> {
  const g = currentGame(state);
  if (!g) return { white: 167, black: 167 };
  return { white: pipCount(g.board, 'white'), black: pipCount(g.board, 'black') };
}

export function gameOver(state: ClientState) {
  const g = currentGame(state);
  return g && g.phase.kind === 'over' ? g.phase.result : null;
}

export function kindLabel(kind: ResultKind): string {
  return kind === 'single' ? 'Single' : kind === 'gammon' ? 'Gammon' : 'Backgammon';
}

export interface PhaseSummary {
  text: string;
  waitingOn: Player | null;
  /** True when it's the local player's action. */
  mine: boolean;
}

export function phaseSummary(state: ClientState): PhaseSummary {
  if (state.status === 'connecting') return { text: 'Connecting…', waitingOn: null, mine: false };
  if (state.status === 'rejected')
    return { text: 'Connection rejected', waitingOn: null, mine: false };
  if (state.status === 'disconnected')
    return { text: 'Disconnected', waitingOn: null, mine: false };
  const snap = state.snapshot;
  const seat = state.seat;
  if (!snap || !seat) return { text: 'Connecting…', waitingOn: null, mine: false };
  const opp = opponent(seat);
  const oppName = playerName(state, opp);
  const m = snap.match;
  const g = m.game;
  if (!snap.players[opp]) {
    return { text: 'Waiting for an opponent to join', waitingOn: opp, mine: false };
  }
  if (m.winner) {
    return {
      text: m.winner === seat ? 'You won the match!' : `${oppName} won the match`,
      waitingOn: null,
      mine: false,
    };
  }
  if (!g) return { text: 'Ready when you are — start the first game', waitingOn: null, mine: true };
  const ph = g.phase;
  switch (ph.kind) {
    case 'opening': {
      const tie = ph.ties > 0 && ph.rolls.white === undefined && ph.rolls.black === undefined;
      if (ph.rolls[seat] === undefined) {
        return {
          text: tie ? 'Tie! Roll again for the opening' : 'Roll for the opening',
          waitingOn: seat,
          mine: true,
        };
      }
      return { text: `Waiting for ${oppName} to roll`, waitingOn: opp, mine: false };
    }
    case 'to-roll':
      if (ph.player === seat) {
        return {
          text: engineCanDouble(g, seat) ? 'Your roll — or offer a double' : 'Your roll',
          waitingOn: seat,
          mine: true,
        };
      }
      return { text: `Waiting for ${oppName} to roll`, waitingOn: opp, mine: false };
    case 'moving':
      if (ph.player === seat) {
        if (state.draft.maxMoves === 0)
          return { text: 'No legal moves', waitingOn: seat, mine: true };
        if (state.draft.complete)
          return { text: 'Tap Done to end your turn', waitingOn: seat, mine: true };
        return {
          text: `Your move: ${ph.dice[0]}–${ph.dice[1]}`,
          waitingOn: seat,
          mine: true,
        };
      }
      return {
        text: `${oppName} is moving ${ph.dice[0]}–${ph.dice[1]}`,
        waitingOn: opp,
        mine: false,
      };
    case 'double-offered':
      if (ph.by === seat) {
        return {
          text: `You offered ${g.cube.value * 2} — waiting for ${oppName}`,
          waitingOn: opp,
          mine: false,
        };
      }
      return {
        text: `${oppName} doubles to ${g.cube.value * 2} — take or drop?`,
        waitingOn: seat,
        mine: true,
      };
    case 'resign-offered':
      if (ph.by === seat) {
        return {
          text: `You offered to resign (${kindLabel(ph.stakes).toLowerCase()})`,
          waitingOn: opp,
          mine: false,
        };
      }
      return {
        text: `${oppName} offers to resign a ${kindLabel(ph.stakes).toLowerCase()} — accept?`,
        waitingOn: seat,
        mine: true,
      };
    case 'free': {
      if (!ph.dice) {
        return {
          text: 'Free board — move any checker, roll whenever you like',
          waitingOn: null,
          mine: true,
        };
      }
      const who = ph.dice.player === seat ? 'You' : playerName(state, ph.dice.player);
      const [a, b] = ph.dice.dice;
      return { text: `${who} rolled ${a}–${b} · free board`, waitingOn: null, mine: true };
    }
    case 'over': {
      const r = ph.result;
      const won = r.winner === seat;
      return {
        text: won
          ? `You won the game (${kindLabel(r.kind).toLowerCase()}, ${r.points} pt${r.points === 1 ? '' : 's'})`
          : `${oppName} won the game`,
        waitingOn: null,
        mine: false,
      };
    }
  }
}

export function describeConfig(m: MatchState): string {
  const free = m.config.rules === 'free' ? ' · Free board' : '';
  if (m.config.length <= 0) return (m.config.jacoby ? 'Unlimited · Jacoby' : 'Unlimited') + free;
  const crawford = m.config.crawford && m.config.rules !== 'free' ? ' · Crawford' : '';
  return `${m.config.length}-point match${crawford}${free}`;
}

/** Side of the home boards as seen from `seat`: the host's table layout, mirrored across the table. */
export function homeSideFor(state: ClientState, seat: Player | null = state.seat): HomeSide {
  if (!state.snapshot || !seat) return DEFAULT_HOME_SIDE;
  return sideForSeat(state.snapshot, seat);
}
