import { describe, expect, it } from 'vitest';
import type { Action, MatchState, TurnRecord } from '../src/index.js';
import {
  BAR,
  FREE_MOVE_HISTORY_CAP,
  OFF,
  RuleError,
  applyAction,
  boardFrom,
  countAt,
  game,
  isFreeBoard,
  isFreeMode,
  newGame,
  newMatch,
  pipCount,
  replay,
  rulesMode,
  startingBoard,
  totalCheckers,
} from '../src/index.js';

function freeMatch(config: Parameters<typeof newMatch>[0] = {}): MatchState {
  return applyAction(newMatch({ length: 5, rules: 'free', ...config }), { type: 'start-game' });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  return 'no-error';
}

describe('free board: mode and game start', () => {
  it('rulesMode defaults to enforced for configs without the field', () => {
    expect(rulesMode({ length: 5, crawford: true, jacoby: true })).toBe('enforced');
    expect(rulesMode({ length: 5, crawford: true, jacoby: true, rules: 'free' })).toBe('free');
    expect(isFreeMode(newMatch().config)).toBe(false);
    expect(newMatch().config.rules).toBe('enforced');
  });

  it('start-game on a free match skips the opening roll', () => {
    const m = freeMatch();
    expect(m.game!.phase).toEqual({ kind: 'free', dice: null });
    expect(m.game!.cube).toEqual({ value: 1, owner: 'center' });
    expect(m.game!.board).toEqual(startingBoard());
    expect(isFreeBoard(m.game!)).toBe(true);
    expect(game.playerToAct(m.game!)).toBeNull();
    expect(game.canDouble(m.game!, 'white')).toBe(false);
  });

  it('newGame({ free: true }) starts in the free phase', () => {
    expect(newGame({ free: true }).phase.kind).toBe('free');
    expect(newGame().phase.kind).toBe('opening');
  });

  it('rejects dice/cube actions on a free board with wrong-phase', () => {
    const m = freeMatch();
    const bad: Action[] = [
      { type: 'opening-roll', player: 'white', die: 3 },
      { type: 'roll', player: 'white', dice: [3, 1] },
      { type: 'play', player: 'white', play: [] },
      { type: 'double', player: 'white' },
      { type: 'take', player: 'black' },
      { type: 'drop', player: 'black' },
    ];
    for (const a of bad) expect(code(() => applyAction(m, a))).toBe('wrong-phase');
  });

  it('rejects free actions on an enforced board with free-mode', () => {
    let m = newMatch({ length: 5 });
    m = applyAction(m, { type: 'start-game' });
    const bad: Action[] = [
      { type: 'free-roll', player: 'white', dice: [3, 1] },
      { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 20 },
      { type: 'free-cube', player: 'white', value: 2, owner: 'black' },
      { type: 'free-reset', player: 'white' },
      { type: 'free-result', player: 'white', winner: 'white', kind: 'single' },
    ];
    for (const a of bad) expect(code(() => applyAction(m, a))).toBe('free-mode');
    // Also directly on a game state that happens to be enforced (phase is not 'free').
    expect(code(() => game.freeRoll(m.game!, 'white', [1, 2]))).toBe('wrong-phase');
  });
});

describe('free board: rolling', () => {
  it('either player may roll at any time; the last roll is kept', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-roll', player: 'black', dice: [6, 6] });
    expect(m.game!.phase).toEqual({ kind: 'free', dice: { player: 'black', dice: [6, 6] } });
    m = applyAction(m, { type: 'free-roll', player: 'black', dice: [2, 1] });
    m = applyAction(m, { type: 'free-roll', player: 'white', dice: [4, 5] });
    expect(m.game!.phase).toEqual({ kind: 'free', dice: { player: 'white', dice: [4, 5] } });
    expect(m.game!.turnCount).toBe(3);
    expect(m.game!.history).toEqual([
      { type: 'free-roll', player: 'black', dice: [6, 6] },
      { type: 'free-roll', player: 'black', dice: [2, 1] },
      { type: 'free-roll', player: 'white', dice: [4, 5] },
    ]);
  });
});

describe('free board: moving checkers', () => {
  it('moves a checker of either colour any distance in any direction', () => {
    let m = freeMatch();
    // Black moves a white checker backwards (24 -> 3 is "forward"; try 6 -> 20 backwards).
    m = applyAction(m, { type: 'free-move', player: 'black', checker: 'white', from: 6, to: 20 });
    expect(countAt(m.game!.board, 'white', 6)).toBe(4);
    expect(countAt(m.game!.board, 'white', 20)).toBe(1);
    // White moves a black checker forward 5 pips, with no dice rolled at all.
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'black', from: 13, to: 8 });
    expect(countAt(m.game!.board, 'black', 13)).toBe(4);
    expect(countAt(m.game!.board, 'black', 8)).toBe(4);
    expect(totalCheckers(m.game!.board, 'white')).toBe(15);
    expect(totalCheckers(m.game!.board, 'black')).toBe(15);
    expect(m.game!.history.at(-1)).toEqual({
      type: 'free-move',
      player: 'white',
      checker: 'black',
      from: 13,
      to: 8,
      hit: false,
    });
    // Free moves do not count as turns.
    expect(m.game!.turnCount).toBe(0);
  });

  it('hits a lone opposing checker, sending it to the bar', () => {
    let m = freeMatch();
    // Put a lone white checker on white's 20-point (black's 5-point).
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 20 });
    m = applyAction(m, { type: 'free-move', player: 'black', checker: 'black', from: 8, to: 5 });
    const b = m.game!.board;
    expect(countAt(b, 'white', 20)).toBe(0);
    expect(b.bar.white).toBe(1);
    expect(countAt(b, 'black', 5)).toBe(1);
    expect(m.game!.history.at(-1)).toMatchObject({ type: 'free-move', hit: true });
    expect(totalCheckers(b, 'white')).toBe(15);
  });

  it('is blocked by two or more opposing checkers', () => {
    const m = freeMatch();
    // White's 19-point is black's 6-point, which holds 5 black checkers.
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 19 }),
      ),
    ).toBe('blocked');
    // A point with exactly two is blocked as well.
    const two = { ...m, game: { ...m.game!, board: boardFrom({ 24: 15 }, { 5: 2, 13: 13 }) } };
    expect(
      code(() =>
        applyAction(two, {
          type: 'free-move',
          player: 'white',
          checker: 'white',
          from: 24,
          to: 20,
        }),
      ),
    ).toBe('blocked');
  });

  it('moves to and from the bar and off', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 6, to: BAR });
    expect(m.game!.board.bar.white).toBe(1);
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: BAR, to: 22 });
    expect(m.game!.board.bar.white).toBe(0);
    expect(countAt(m.game!.board, 'white', 22)).toBe(1);
    m = applyAction(m, { type: 'free-move', player: 'black', checker: 'black', from: 6, to: OFF });
    expect(m.game!.board.off.black).toBe(1);
    // ...and back on the board from off (black's 2-point is white's empty 23-point).
    m = applyAction(m, { type: 'free-move', player: 'black', checker: 'black', from: OFF, to: 2 });
    expect(m.game!.board.off.black).toBe(0);
    expect(countAt(m.game!.board, 'black', 2)).toBe(1);
    expect(totalCheckers(m.game!.board, 'white')).toBe(15);
    expect(totalCheckers(m.game!.board, 'black')).toBe(15);
    // Bearing everything off does NOT end the game by itself; results are recorded manually.
    let n = freeMatch();
    n = { ...n, game: { ...n.game!, board: boardFrom({ 1: 1, 0: 14 }, { 13: 15 }) } };
    n = applyAction(n, { type: 'free-move', player: 'white', checker: 'white', from: 1, to: OFF });
    expect(n.game!.phase.kind).toBe('free');
    expect(n.game!.board.off.white).toBe(15);
  });

  it('rejects same-location, empty sources and bad locations', () => {
    const m = freeMatch();
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 6, to: 6 }),
      ),
    ).toBe('same-location');
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 5, to: 4 }),
      ),
    ).toBe('empty-source');
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: BAR, to: 4 }),
      ),
    ).toBe('empty-source');
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 26, to: 4 }),
      ),
    ).toBe('bad-location');
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 6, to: -1 }),
      ),
    ).toBe('bad-location');
    expect(
      code(() =>
        applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 6.5, to: 4 }),
      ),
    ).toBe('bad-location');
    expect(
      code(() =>
        applyAction(m, {
          type: 'free-move',
          player: 'white',
          checker: 'red' as never,
          from: 6,
          to: 4,
        }),
      ),
    ).toBe('bad-checker');
  });

  it('pip counts follow free moves', () => {
    let m = freeMatch();
    expect(pipCount(m.game!.board, 'white')).toBe(167);
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 4 });
    expect(pipCount(m.game!.board, 'white')).toBe(147);
  });
});

describe('free board: cube', () => {
  it('sets any power-of-two value with an owner', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-cube', player: 'white', value: 2, owner: 'black' });
    expect(m.game!.cube).toEqual({ value: 2, owner: 'black' });
    m = applyAction(m, { type: 'free-cube', player: 'black', value: 64, owner: 'white' });
    expect(m.game!.cube).toEqual({ value: 64, owner: 'white' });
    m = applyAction(m, { type: 'free-cube', player: 'black', value: 1, owner: 'center' });
    expect(m.game!.cube).toEqual({ value: 1, owner: 'center' });
    expect(m.game!.history.filter((r) => r.type === 'free-cube')).toHaveLength(3);
  });

  it('ignores the Crawford flag', () => {
    // Score 4-0 in a 5-point free match makes the next game the Crawford game.
    let m = freeMatch();
    m = applyAction(m, { type: 'free-cube', player: 'white', value: 4, owner: 'black' });
    m = applyAction(m, { type: 'free-result', player: 'white', winner: 'white', kind: 'single' });
    expect(m.score).toEqual({ white: 4, black: 0 });
    m = applyAction(m, { type: 'start-game' });
    expect(m.game!.crawford).toBe(true);
    m = applyAction(m, { type: 'free-cube', player: 'black', value: 2, owner: 'white' });
    expect(m.game!.cube).toEqual({ value: 2, owner: 'white' });
  });

  it('rejects bad values and owners', () => {
    const m = freeMatch();
    expect(
      code(() => applyAction(m, { type: 'free-cube', player: 'white', value: 3, owner: 'white' })),
    ).toBe('bad-cube');
    expect(
      code(() =>
        applyAction(m, { type: 'free-cube', player: 'white', value: 128, owner: 'white' }),
      ),
    ).toBe('bad-cube');
    expect(
      code(() => applyAction(m, { type: 'free-cube', player: 'white', value: 0, owner: 'center' })),
    ).toBe('bad-cube');
    expect(
      code(() => applyAction(m, { type: 'free-cube', player: 'white', value: 1, owner: 'white' })),
    ).toBe('bad-cube');
    expect(
      code(() =>
        applyAction(m, { type: 'free-cube', player: 'white', value: 2, owner: 'nobody' as never }),
      ),
    ).toBe('bad-cube');
  });
});

describe('free board: reset and result', () => {
  it('reset restores the starting position and clears dice but keeps the cube', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-roll', player: 'white', dice: [3, 4] });
    m = applyAction(m, { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 4 });
    m = applyAction(m, { type: 'free-cube', player: 'white', value: 2, owner: 'black' });
    m = applyAction(m, { type: 'free-reset', player: 'black' });
    expect(m.game!.board).toEqual(startingBoard());
    expect(m.game!.phase).toEqual({ kind: 'free', dice: null });
    expect(m.game!.cube).toEqual({ value: 2, owner: 'black' });
    expect(m.game!.history.at(-1)).toEqual({ type: 'free-reset', player: 'black' });
    // The game is still in play.
    expect(m.games).toHaveLength(0);
  });

  it('a recorded result ends the game and scores kind x cube', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-cube', player: 'white', value: 2, owner: 'black' });
    m = applyAction(m, { type: 'free-result', player: 'black', winner: 'white', kind: 'gammon' });
    expect(m.game!.phase).toEqual({
      kind: 'over',
      result: { winner: 'white', kind: 'gammon', how: 'recorded', cube: 2, points: 4 },
    });
    expect(m.score).toEqual({ white: 4, black: 0 });
    expect(m.games).toHaveLength(1);
    expect(m.games[0]!.result.how).toBe('recorded');
    expect(m.gameNumber).toBe(2);
    expect(m.winner).toBeNull();
    // The next game continues on a free board.
    m = applyAction(m, { type: 'start-game' });
    expect(m.game!.phase).toEqual({ kind: 'free', dice: null });
    // And nothing may be moved on the finished game in between.
    const over = applyAction(freeMatch(), {
      type: 'free-result',
      player: 'white',
      winner: 'black',
      kind: 'single',
    });
    expect(
      code(() =>
        applyAction(over, {
          type: 'free-move',
          player: 'white',
          checker: 'white',
          from: 24,
          to: 20,
        }),
      ),
    ).toBe('wrong-phase');
    expect(
      code(() => applyAction(over, { type: 'free-roll', player: 'white', dice: [1, 2] })),
    ).toBe('wrong-phase');
  });

  it('a recorded backgammon can win the match', () => {
    let m = freeMatch({ length: 3 });
    m = applyAction(m, {
      type: 'free-result',
      player: 'white',
      winner: 'black',
      kind: 'backgammon',
    });
    expect(m.score).toEqual({ white: 0, black: 3 });
    expect(m.winner).toBe('black');
    expect(code(() => applyAction(m, { type: 'start-game' }))).toBe('match-over');
  });

  it('Jacoby applies to recorded gammons in money play', () => {
    let centred = freeMatch({ length: 0, jacoby: true });
    centred = applyAction(centred, {
      type: 'free-result',
      player: 'white',
      winner: 'white',
      kind: 'gammon',
    });
    expect(centred.score.white).toBe(1);
    let turned = freeMatch({ length: 0, jacoby: true });
    turned = applyAction(turned, { type: 'free-cube', player: 'white', value: 2, owner: 'black' });
    turned = applyAction(turned, {
      type: 'free-result',
      player: 'white',
      winner: 'white',
      kind: 'gammon',
    });
    expect(turned.score.white).toBe(4);
    let noJacoby = freeMatch({ length: 0, jacoby: false });
    noJacoby = applyAction(noJacoby, {
      type: 'free-result',
      player: 'white',
      winner: 'white',
      kind: 'gammon',
    });
    expect(noJacoby.score.white).toBe(2);
  });

  it('rejects bad results', () => {
    const m = freeMatch();
    expect(
      code(() =>
        applyAction(m, {
          type: 'free-result',
          player: 'white',
          winner: 'red' as never,
          kind: 'single',
        }),
      ),
    ).toBe('bad-result');
    expect(
      code(() =>
        applyAction(m, {
          type: 'free-result',
          player: 'white',
          winner: 'white',
          kind: 'huge' as never,
        }),
      ),
    ).toBe('bad-result');
  });
});

describe('free board: resignation', () => {
  it('offer, decline restores the free phase with its dice; accept scores', () => {
    let m = freeMatch();
    m = applyAction(m, { type: 'free-roll', player: 'white', dice: [5, 2] });
    m = applyAction(m, { type: 'offer-resign', player: 'black', stakes: 'single' });
    expect(m.game!.phase.kind).toBe('resign-offered');
    // No free actions while a resignation is pending.
    expect(code(() => applyAction(m, { type: 'free-roll', player: 'white', dice: [1, 1] }))).toBe(
      'wrong-phase',
    );
    const declined = applyAction(m, { type: 'decline-resign', player: 'white' });
    expect(declined.game!.phase).toEqual({ kind: 'free', dice: { player: 'white', dice: [5, 2] } });
    const accepted = applyAction(m, { type: 'accept-resign', player: 'white' });
    expect(accepted.game!.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'white', kind: 'single', how: 'resign', points: 1 },
    });
    expect(accepted.score.white).toBe(1);
  });
});

describe('free board: history and replay', () => {
  it('replays a free-board action log deterministically', () => {
    const actions: Action[] = [
      { type: 'start-game' },
      { type: 'free-roll', player: 'white', dice: [3, 1] },
      { type: 'free-move', player: 'white', checker: 'white', from: 8, to: 5 },
      { type: 'free-move', player: 'white', checker: 'white', from: 6, to: 5 },
      { type: 'free-roll', player: 'black', dice: [6, 5] },
      { type: 'free-move', player: 'black', checker: 'black', from: 24, to: 13 },
      { type: 'free-cube', player: 'white', value: 2, owner: 'black' },
      // A lone black checker on black's 4-point (white's 21-point)...
      { type: 'free-move', player: 'black', checker: 'black', from: 6, to: 4 },
      // ...is hit by white.
      { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 21 },
      { type: 'free-reset', player: 'white' },
      { type: 'free-move', player: 'white', checker: 'white', from: 24, to: 20 },
      { type: 'free-move', player: 'black', checker: 'black', from: 8, to: 5 },
      { type: 'free-result', player: 'black', winner: 'black', kind: 'gammon' },
      { type: 'start-game' },
      { type: 'free-roll', player: 'white', dice: [2, 2] },
    ];
    const config = { length: 7, rules: 'free' as const };
    const a = replay(config, actions);
    const b = actions.reduce(applyAction, newMatch(config));
    expect(a).toEqual(b);
    expect(a.score).toEqual({ white: 0, black: 4 });
    expect(a.games[0]!.turns.filter((t: TurnRecord) => t.type === 'free-move')).toHaveLength(7);
    expect(a.games[0]!.turns.some((t) => t.type === 'free-move' && t.hit)).toBe(true);
    expect(a.game!.phase).toEqual({ kind: 'free', dice: { player: 'white', dice: [2, 2] } });
    // A truncated log with a move that no longer has a source throws.
    const broken = [...actions.slice(0, 2), actions[3]!];
    expect(() => replay(config, broken)).not.toThrow(); // 6->5 still has a source at the start
    const reallyBroken = [
      actions[0]!,
      { type: 'free-move', player: 'white', checker: 'white', from: 5, to: 4 } as Action,
    ];
    expect(() => replay(config, reallyBroken)).toThrow(RuleError);
  });

  it('caps free-move records, dropping the oldest and keeping other records', () => {
    let g = newGame({ free: true });
    g = game.freeRoll(g, 'white', [1, 1]);
    g = game.freeCube(g, 'white', 2, 'black');
    // Shuttle one checker back and forth between two empty points (white's 4- and 5-points).
    let at = 6;
    for (let i = 0; i < FREE_MOVE_HISTORY_CAP + 5; i++) {
      const to = at === 6 ? 5 : at === 5 ? 4 : 5;
      g = game.freeMove(g, 'white', 'white', at, to);
      at = to;
    }
    const freeMoves = g.history.filter((r) => r.type === 'free-move');
    expect(freeMoves).toHaveLength(FREE_MOVE_HISTORY_CAP);
    expect(g.history[0]).toEqual({ type: 'free-roll', player: 'white', dice: [1, 1] });
    expect(g.history[1]).toEqual({ type: 'free-cube', player: 'white', value: 2, owner: 'black' });
    // The oldest 5 moves (6->5, 5->4, 4->5, 5->4, 4->5) were dropped: the first kept is the 6th move.
    expect(g.history[2]).toMatchObject({ type: 'free-move', from: 5, to: 4 });
    expect(g.history.length).toBe(FREE_MOVE_HISTORY_CAP + 2);
  });
});
