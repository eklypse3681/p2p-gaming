import { describe, expect, it } from 'vitest';
import { newMatch } from '@bgf/engine';
import type { Player } from '@bgf/engine';
import type { HomeSide } from '@bgf/protocol';
import type { ClientState } from '../src/index.js';
import { homeSideFor } from '../src/index.js';

function state(seat: Player | null, hostSeat: Player, homeSide?: HomeSide): ClientState {
  const m = newMatch({ length: 5 });
  return {
    status: 'joined',
    rejectReason: null,
    seat,
    snapshot: {
      id: 'm',
      code: 'C',
      seq: 0,
      createdAt: 0,
      updatedAt: 0,
      config: m.config,
      players: { white: { id: 'a', name: 'Alice' }, black: { id: 'b', name: 'Bob' } },
      hostSeat,
      ...(homeSide ? { homeSide } : {}),
      actions: [],
      match: m,
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
      board: m.game?.board ?? {
        points: [],
        bar: { white: 0, black: 0 },
        off: { white: 0, black: 0 },
      },
      next: [],
      remaining: [],
      complete: false,
      maxMoves: 0,
    },
  };
}

describe('homeSideFor', () => {
  it('the host sees the table as laid out', () => {
    expect(homeSideFor(state('white', 'white', 'left'))).toBe('left');
    expect(homeSideFor(state('white', 'white', 'right'))).toBe('right');
  });

  it('the seat across the table sees the mirror image', () => {
    expect(homeSideFor(state('black', 'white', 'left'))).toBe('right');
    expect(homeSideFor(state('black', 'white', 'right'))).toBe('left');
  });

  it('works when the host took the black seat', () => {
    expect(homeSideFor(state('black', 'black', 'left'))).toBe('left');
    expect(homeSideFor(state('white', 'black', 'left'))).toBe('right');
  });

  it('treats a missing field as left and defaults without a snapshot or seat', () => {
    expect(homeSideFor(state('white', 'white'))).toBe('left');
    expect(homeSideFor(state('black', 'white'))).toBe('right');
    expect(homeSideFor(state(null, 'white', 'right'))).toBe('left');
    expect(homeSideFor({ ...state('white', 'white', 'right'), snapshot: null })).toBe('left');
  });

  it('can be asked about the other seat explicitly', () => {
    expect(homeSideFor(state('white', 'white', 'left'), 'black')).toBe('right');
  });
});
