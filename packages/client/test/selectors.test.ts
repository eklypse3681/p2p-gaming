import { describe, expect, it } from 'vitest';
import { newGame, newMatch, startingBoard } from '@bgf/engine';
import type { GamePhase, GameState, MatchState } from '@bgf/engine';
import type { ClientState } from '../src/index.js';
import {
  canCommit,
  canDouble,
  canOpeningRoll,
  canResign,
  canRespondToDouble,
  canRoll,
  canStartGame,
  canUndo,
  myTurn,
  opponentSeat,
  pendingResign,
  phaseSummary,
  pips,
  playerName,
} from '../src/index.js';

function stateWith(phase: GamePhase | null, seat: 'white' | 'black' = 'white', patch: Partial<GameState> = {}, matchPatch: Partial<MatchState> = {}): ClientState {
  const m = newMatch({ length: 5 });
  const game = phase ? { ...newGame(), phase, ...patch } : null;
  return {
    status: 'joined',
    rejectReason: null,
    seat,
    snapshot: {
      id: 'm',
      code: 'C',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      config: m.config,
      players: { white: { id: 'a', name: 'Alice' }, black: { id: 'b', name: 'Bob' } },
      hostSeat: 'white',
      actions: [],
      match: { ...m, game, ...matchPatch },
      chat: [],
    },
    lastAction: null,
    opponentPreview: null,
    presence: { white: true, black: true },
    chat: [],
    latencyMs: null,
    error: null,
    draft: { played: [], board: game?.board ?? startingBoard(), next: [], remaining: [], complete: false, maxMoves: 0 },
  };
}

describe('selectors', () => {
  it('names, seats and pips', () => {
    const s = stateWith({ kind: 'to-roll', player: 'white' });
    expect(opponentSeat(s)).toBe('black');
    expect(playerName(s, 'black')).toBe('Bob');
    expect(pips(s)).toEqual({ white: 167, black: 167 });
  });

  it('start / opening / roll / double gating', () => {
    expect(canStartGame(stateWith(null))).toBe(true);
    expect(canStartGame(stateWith({ kind: 'to-roll', player: 'white' }))).toBe(false);
    expect(canStartGame(stateWith(null, 'white', {}, { winner: 'black' }))).toBe(false);
    const opening = stateWith({ kind: 'opening', rolls: { white: 3 }, ties: 0 });
    expect(canOpeningRoll(opening)).toBe(false);
    expect(canOpeningRoll({ ...opening, seat: 'black' })).toBe(true);
    expect(myTurn(opening)).toBe(false);
    expect(myTurn({ ...opening, seat: 'black' })).toBe(true);
    const toRoll = stateWith({ kind: 'to-roll', player: 'white' });
    expect(canRoll(toRoll)).toBe(true);
    expect(canDouble(toRoll)).toBe(true);
    expect(canRoll({ ...toRoll, seat: 'black' })).toBe(false);
    expect(canDouble(stateWith({ kind: 'to-roll', player: 'white' }, 'white', { crawford: true }))).toBe(false);
    expect(canDouble(stateWith({ kind: 'to-roll', player: 'white' }, 'white', { cube: { value: 2, owner: 'black' } }))).toBe(false);
    expect(canResign(toRoll)).toBe(true);
    expect(canResign(opening)).toBe(false);
  });

  it('cube response, commit/undo, resignation', () => {
    const offered = stateWith({ kind: 'double-offered', by: 'black' });
    expect(canRespondToDouble(offered)).toBe(true);
    expect(canRespondToDouble({ ...offered, seat: 'black' })).toBe(false);
    expect(myTurn(offered)).toBe(true);
    const moving = stateWith({ kind: 'moving', player: 'white', dice: [3, 1] });
    expect(canCommit(moving)).toBe(false);
    expect(canCommit({ ...moving, draft: { ...moving.draft, complete: true } })).toBe(true);
    expect(canCommit({ ...moving, draft: { ...moving.draft, complete: true, pending: true } })).toBe(false);
    expect(canUndo({ ...moving, draft: { ...moving.draft, played: [{ from: 8, to: 5, die: 3, hit: false }] } })).toBe(true);
    expect(canUndo(moving)).toBe(false);
    const resign = stateWith({ kind: 'resign-offered', by: 'black', stakes: 'gammon', prior: { kind: 'to-roll', player: 'white' } });
    expect(pendingResign(resign)).toEqual({ by: 'black', stakes: 'gammon', mine: false });
    expect(pendingResign({ ...resign, seat: 'black' })!.mine).toBe(true);
    expect(pendingResign(moving)).toBeNull();
  });

  it('phase summaries read naturally', () => {
    const t = (s: ClientState) => phaseSummary(s);
    expect(t({ ...stateWith(null), status: 'connecting' })).toEqual({ text: 'Connecting…', waitingOn: null });
    expect(t(stateWith(null)).text).toBe('Ready to start');
    expect(t(stateWith({ kind: 'opening', rolls: {}, ties: 1 }))).toEqual({ text: 'Tie! Roll again for the opening', waitingOn: 'white' });
    expect(t(stateWith({ kind: 'opening', rolls: { white: 2 }, ties: 0 }))).toEqual({ text: 'Waiting for Bob to roll', waitingOn: 'black' });
    expect(t(stateWith({ kind: 'to-roll', player: 'white' }))).toEqual({ text: 'Your turn: roll or double', waitingOn: 'white' });
    expect(t(stateWith({ kind: 'to-roll', player: 'white' }, 'white', { crawford: true })).text).toBe('Your roll');
    expect(t(stateWith({ kind: 'to-roll', player: 'black' }))).toEqual({ text: 'Waiting for Bob to roll', waitingOn: 'black' });
    expect(t(stateWith({ kind: 'double-offered', by: 'black' })).text).toBe('Bob offers a double to 2 — take or drop?');
    expect(t(stateWith({ kind: 'double-offered', by: 'white' })).text).toBe('Waiting for Bob to respond to your double');
    expect(t(stateWith({ kind: 'moving', player: 'white', dice: [6, 4] })).text).toBe('Your move: 6-4');
    expect(t(stateWith({ kind: 'moving', player: 'black', dice: [6, 4] })).text).toBe('Waiting for Bob to move');
    expect(t(stateWith({ kind: 'resign-offered', by: 'black', stakes: 'backgammon', prior: { kind: 'to-roll', player: 'white' } })).text).toBe(
      'Bob offers to resign a backgammon — accept or decline?',
    );
    const over = stateWith({ kind: 'over', result: { winner: 'black', kind: 'gammon', how: 'bearoff', cube: 2, points: 4 } });
    expect(t(over)).toEqual({ text: 'Bob wins the game (gammon) for 4 points', waitingOn: null });
    expect(t({ ...over, seat: 'black' }).text).toBe('You win the game (gammon) for 4 points');
    expect(t(stateWith(null, 'white', {}, { winner: 'white' })).text).toBe('You win the match!');
    const solo = stateWith(null);
    solo.snapshot!.players.black = null;
    expect(t(solo).text).toBe('Waiting for an opponent to join');
  });
});
