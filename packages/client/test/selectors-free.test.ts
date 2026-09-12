import { describe, expect, it } from 'vitest';
import { newGame, newMatch, startingBoard } from '@bgf/engine';
import type { GamePhase, MatchConfig } from '@bgf/engine';
import type { ClientState } from '../src/index.js';
import {
  canCommit,
  canDouble,
  canFreeRoll,
  canRecordResult,
  canResign,
  canRoll,
  canStartGame,
  canUndo,
  isFreeMode,
  lastFreeDice,
  myTurn,
  phaseSummary,
} from '../src/index.js';

function stateWith(
  phase: GamePhase | null,
  seat: 'white' | 'black' = 'white',
  config: Partial<MatchConfig> = { rules: 'free' },
  status: ClientState['status'] = 'joined',
): ClientState {
  const m = newMatch({ length: 5, ...config });
  const game = phase ? { ...newGame({ free: true }), phase } : null;
  return {
    status,
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
      match: { ...m, game },
      chat: [],
    },
    lastAction: null,
    opponentPreview: null,
    presence: { white: true, black: true },
    chat: [],
    latencyMs: null,
    error: null,
    draft: {
      played: [],
      board: game?.board ?? startingBoard(),
      next: [],
      remaining: [],
      complete: false,
      maxMoves: 0,
    },
  };
}

describe('free-board selectors', () => {
  it('isFreeMode reads the match config', () => {
    expect(isFreeMode(stateWith(null))).toBe(true);
    expect(isFreeMode(stateWith(null, 'white', { rules: 'enforced' }))).toBe(false);
    expect(isFreeMode(stateWith(null, 'white', {}))).toBe(false);
    expect(isFreeMode({ ...stateWith(null), snapshot: null })).toBe(false);
  });

  it('canFreeRoll / canRecordResult only while a free game is in play', () => {
    const free = stateWith({ kind: 'free', dice: null });
    expect(canFreeRoll(free)).toBe(true);
    expect(canRecordResult(free)).toBe(true);
    expect(canFreeRoll(stateWith(free.snapshot!.match.game!.phase, 'black'))).toBe(true);
    expect(canFreeRoll(stateWith(null))).toBe(false);
    expect(
      canFreeRoll(
        stateWith({
          kind: 'over',
          result: { winner: 'white', kind: 'single', how: 'recorded', cube: 1, points: 1 },
        }),
      ),
    ).toBe(false);
    expect(
      canFreeRoll(
        stateWith({
          kind: 'resign-offered',
          by: 'white',
          stakes: 'single',
          prior: { kind: 'free', dice: null },
        }),
      ),
    ).toBe(false);
    expect(
      canFreeRoll(
        stateWith({ kind: 'free', dice: null }, 'white', { rules: 'free' }, 'connecting'),
      ),
    ).toBe(false);
    expect(
      canFreeRoll(stateWith({ kind: 'to-roll', player: 'white' }, 'white', { rules: 'enforced' })),
    ).toBe(false);
  });

  it('lastFreeDice returns the most recent roll', () => {
    expect(lastFreeDice(stateWith({ kind: 'free', dice: null }))).toBeNull();
    expect(
      lastFreeDice(stateWith({ kind: 'free', dice: { player: 'black', dice: [2, 5] } })),
    ).toEqual({ player: 'black', dice: [2, 5] });
    expect(
      lastFreeDice(stateWith({ kind: 'to-roll', player: 'white' }, 'white', { rules: 'enforced' })),
    ).toBeNull();
  });

  it('turn gating on a free board: everyone may act, nothing is drafted', () => {
    const s = stateWith({ kind: 'free', dice: { player: 'white', dice: [1, 2] } }, 'black');
    expect(myTurn(s)).toBe(true);
    expect(myTurn(stateWith(s.snapshot!.match.game!.phase, 'white'))).toBe(true);
    expect(canRoll(s)).toBe(false);
    expect(canDouble(s)).toBe(false);
    expect(canCommit(s)).toBe(false);
    expect(canUndo(s)).toBe(false);
    expect(canResign(s)).toBe(true);
    expect(canStartGame(s)).toBe(false);
    expect(canStartGame(stateWith(null))).toBe(true);
  });

  it('phaseSummary describes the free board', () => {
    expect(phaseSummary(stateWith({ kind: 'free', dice: null }))).toEqual({
      text: 'Free board — drag any checker, roll whenever you like',
      waitingOn: null,
    });
    expect(
      phaseSummary(stateWith({ kind: 'free', dice: { player: 'white', dice: [6, 4] } }, 'white'))
        .text,
    ).toBe('Free board — You rolled 6-4');
    expect(
      phaseSummary(stateWith({ kind: 'free', dice: { player: 'white', dice: [6, 4] } }, 'black'))
        .text,
    ).toBe('Free board — Alice rolled 6-4');
    const pending = stateWith(
      {
        kind: 'resign-offered',
        by: 'black',
        stakes: 'gammon',
        prior: { kind: 'free', dice: null },
      },
      'white',
    );
    expect(phaseSummary(pending)).toEqual({
      text: 'Bob offers to resign a gammon — accept or decline?',
      waitingOn: 'white',
    });
  });
});
