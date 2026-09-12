import { describe, expect, it } from 'vitest';
import type { Action, GameState, MatchState, Player, ResultKind } from '../src/index.js';
import {
  BAR,
  DEFAULT_MATCH_CONFIG,
  OFF,
  RuleError,
  applyAction,
  boardFrom,
  isMoneyPlay,
  newGame,
  newMatch,
  pointsAway,
  scoreResult,
  startGame,
} from '../src/index.js';
import { sm } from './helpers.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  throw new Error('expected a RuleError');
}

/**
 * Replace the current game with a custom one where `winner` is one 6-roll away from bearing off
 * its last checker, then play it out. `kind` shapes the loser's position; `cube` sets the cube.
 */
function playOut(
  match: MatchState,
  winner: Player,
  kind: ResultKind,
  cube: { value: number; owner: Player | 'center' } = { value: 1, owner: 'center' },
): MatchState {
  const loser: Player = winner === 'white' ? 'black' : 'white';
  const loserSpec =
    kind === 'single' ? { [OFF]: 1, 13: 14 } : kind === 'gammon' ? { 13: 15 } : { [BAR]: 1, 13: 14 };
  const winnerSpec = { 1: 1, [OFF]: 14 };
  const board =
    winner === 'white' ? boardFrom(winnerSpec, loserSpec) : boardFrom(loserSpec, winnerSpec);
  const crawford = match.game?.crawford ?? false;
  const g: GameState = { ...newGame({ board, crawford }), cube };
  let m: MatchState = { ...match, game: g };
  m = applyAction(m, { type: 'opening-roll', player: winner, die: 6 });
  m = applyAction(m, { type: 'opening-roll', player: loser, die: 1 });
  m = applyAction(m, { type: 'play', player: winner, play: [sm(1, OFF, 6)] });
  return m;
}

describe('newMatch / startGame', () => {
  it('defaults and initial state', () => {
    const m = newMatch();
    expect(m.config).toEqual(DEFAULT_MATCH_CONFIG);
    expect(m.score).toEqual({ white: 0, black: 0 });
    expect(m.gameNumber).toBe(1);
    expect(m.game).toBeNull();
    expect(m.games).toEqual([]);
    expect(m.winner).toBeNull();
    expect(m.crawfordDone).toBe(false);
    expect(newMatch({ length: 0 }).config.length).toBe(0);
    expect(isMoneyPlay(newMatch({ length: 0 }).config)).toBe(true);
    expect(isMoneyPlay(newMatch({ length: 7 }).config)).toBe(false);
  });

  it('startGame creates a game and refuses while one is in progress', () => {
    const m = applyAction(newMatch(), { type: 'start-game' });
    expect(m.game?.phase.kind).toBe('opening');
    expect(m.game?.crawford).toBe(false);
    expect(code(() => startGame(m))).toBe('game-in-progress');
    expect(code(() => applyAction(m, { type: 'start-game' }))).toBe('game-in-progress');
  });

  it('actions without a game fail with no-game', () => {
    expect(code(() => applyAction(newMatch(), { type: 'roll', player: 'white', dice: [1, 2] }))).toBe(
      'no-game',
    );
  });

  it('pointsAway', () => {
    const m = newMatch({ length: 5 });
    expect(pointsAway(m, 'white')).toBe(5);
    expect(pointsAway({ ...m, score: { white: 3, black: 6 } }, 'white')).toBe(2);
    expect(pointsAway({ ...m, score: { white: 3, black: 6 } }, 'black')).toBe(0);
    expect(pointsAway(newMatch({ length: 0 }), 'white')).toBe(Infinity);
  });
});

describe('scoring', () => {
  it('single, gammon and backgammon multiply the cube', () => {
    const m0 = applyAction(newMatch({ length: 25 }), { type: 'start-game' });
    const s = playOut(m0, 'white', 'single', { value: 2, owner: 'white' });
    expect(s.score).toEqual({ white: 2, black: 0 });
    expect(s.game?.phase).toMatchObject({ kind: 'over', result: { points: 2, cube: 2 } });
    const g = playOut(m0, 'black', 'gammon', { value: 4, owner: 'black' });
    expect(g.score).toEqual({ white: 0, black: 8 });
    const bg = playOut(m0, 'white', 'backgammon', { value: 2, owner: 'black' });
    expect(bg.score).toEqual({ white: 6, black: 0 });
  });

  it('records a summary, bumps the game number and keeps the finished game visible', () => {
    const m0 = applyAction(newMatch({ length: 25 }), { type: 'start-game' });
    const m1 = playOut(m0, 'white', 'gammon');
    expect(m1.gameNumber).toBe(2);
    expect(m1.games).toHaveLength(1);
    expect(m1.games[0]).toMatchObject({
      number: 1,
      crawford: false,
      scoreAfter: { white: 2, black: 0 },
      result: { winner: 'white', kind: 'gammon', points: 2 },
    });
    expect(m1.games[0]!.turns.map((t) => t.type)).toEqual(['opening', 'move']);
    expect(m1.game?.phase.kind).toBe('over');
    expect(m1.winner).toBeNull();
    // the next game starts fresh
    const m2 = applyAction(m1, { type: 'start-game' });
    expect(m2.game?.phase.kind).toBe('opening');
    expect(m2.game?.cube).toEqual({ value: 1, owner: 'center' });
    expect(m2.gameNumber).toBe(2);
  });

  it('a drop scores the pre-double cube value for the doubler', () => {
    let m = applyAction(newMatch({ length: 25 }), { type: 'start-game' });
    m = applyAction(m, { type: 'opening-roll', player: 'white', die: 3 });
    m = applyAction(m, { type: 'opening-roll', player: 'black', die: 1 });
    m = applyAction(m, { type: 'play', player: 'white', play: [sm(8, 5, 3), sm(6, 5, 1)] });
    m = applyAction(m, { type: 'double', player: 'black' });
    m = applyAction(m, { type: 'drop', player: 'white' });
    expect(m.score).toEqual({ white: 0, black: 1 });
    expect(m.games[0]!.result).toMatchObject({ how: 'drop', cube: 1, points: 1 });
  });

  it('an accepted resignation scores the offered stakes times the cube', () => {
    let m = applyAction(newMatch({ length: 25 }), { type: 'start-game' });
    m = applyAction(m, { type: 'opening-roll', player: 'white', die: 3 });
    m = applyAction(m, { type: 'opening-roll', player: 'black', die: 1 });
    m = applyAction(m, { type: 'play', player: 'white', play: [sm(8, 5, 3), sm(6, 5, 1)] });
    m = applyAction(m, { type: 'double', player: 'black' });
    m = applyAction(m, { type: 'take', player: 'white' });
    m = applyAction(m, { type: 'offer-resign', player: 'white', stakes: 'gammon' });
    const declined = applyAction(m, { type: 'decline-resign', player: 'black' });
    expect(declined.game?.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(declined.score).toEqual({ white: 0, black: 0 });
    m = applyAction(m, { type: 'accept-resign', player: 'black' });
    expect(m.score).toEqual({ white: 0, black: 4 });
    expect(m.games[0]!.result).toMatchObject({ how: 'resign', kind: 'gammon', cube: 2, points: 4 });
  });
});

describe('Jacoby rule (money play)', () => {
  it('a gammon with a centred cube counts as a single point', () => {
    const m0 = applyAction(newMatch({ length: 0, jacoby: true }), { type: 'start-game' });
    const m = playOut(m0, 'white', 'gammon');
    expect(m.score).toEqual({ white: 1, black: 0 });
    expect(m.games[0]!.result).toMatchObject({ kind: 'gammon', points: 1 });
    const bg = playOut(m0, 'black', 'backgammon');
    expect(bg.score).toEqual({ white: 0, black: 1 });
  });

  it('once the cube has been turned, gammons count in full', () => {
    const m0 = applyAction(newMatch({ length: 0, jacoby: true }), { type: 'start-game' });
    const m = playOut(m0, 'white', 'gammon', { value: 2, owner: 'black' });
    expect(m.score).toEqual({ white: 4, black: 0 });
  });

  it('is ignored when disabled or in match play', () => {
    const off = applyAction(newMatch({ length: 0, jacoby: false }), { type: 'start-game' });
    expect(playOut(off, 'white', 'gammon').score).toEqual({ white: 2, black: 0 });
    const match = applyAction(newMatch({ length: 25, jacoby: true }), { type: 'start-game' });
    expect(playOut(match, 'white', 'gammon').score).toEqual({ white: 2, black: 0 });
  });

  it('scoreResult exposes the same rule', () => {
    const m = newMatch({ length: 0, jacoby: true });
    const g = newGame();
    const result = { winner: 'white' as const, kind: 'gammon' as const, how: 'bearoff' as const, cube: 1, points: 0 };
    expect(scoreResult(m, g, result)).toBe(1);
    expect(scoreResult(m, { ...g, cube: { value: 2, owner: 'white' } }, { ...result, cube: 2 })).toBe(4);
  });

  it('money play never produces a match winner', () => {
    let m = applyAction(newMatch({ length: 0 }), { type: 'start-game' });
    for (let i = 0; i < 5; i++) {
      m = playOut(m, 'white', 'single', { value: 8, owner: 'white' });
      m = applyAction(m, { type: 'start-game' });
    }
    expect(m.score.white).toBe(40);
    expect(m.winner).toBeNull();
    expect(m.gameNumber).toBe(6);
  });
});

describe('Crawford rule', () => {
  it('the game after a player reaches match length - 1 is the Crawford game', () => {
    let m = applyAction(newMatch({ length: 3, crawford: true }), { type: 'start-game' });
    m = playOut(m, 'white', 'gammon'); // 2-0
    expect(m.score).toEqual({ white: 2, black: 0 });
    expect(m.crawfordDone).toBe(false);
    m = applyAction(m, { type: 'start-game' });
    expect(m.game?.crawford).toBe(true);
    expect(m.crawfordDone).toBe(true);
    expect(m.games[0]!.crawford).toBe(false);
    // doubling is refused during the Crawford game
    m = applyAction(m, { type: 'opening-roll', player: 'white', die: 3 });
    m = applyAction(m, { type: 'opening-roll', player: 'black', die: 1 });
    m = applyAction(m, { type: 'play', player: 'white', play: [sm(8, 5, 3), sm(6, 5, 1)] });
    expect(code(() => applyAction(m, { type: 'double', player: 'black' }))).toBe('crawford');
    // black wins the Crawford game (single): 2-1, then the post-Crawford game allows doubling again
    m = playOut(m, 'black', 'single');
    expect(m.score).toEqual({ white: 2, black: 1 });
    expect(m.games[1]!.crawford).toBe(true);
    expect(m.winner).toBeNull();
    m = applyAction(m, { type: 'start-game' });
    expect(m.game?.crawford).toBe(false);
    m = applyAction(m, { type: 'opening-roll', player: 'white', die: 3 });
    m = applyAction(m, { type: 'opening-roll', player: 'black', die: 1 });
    m = applyAction(m, { type: 'play', player: 'white', play: [sm(8, 5, 3), sm(6, 5, 1)] });
    m = applyAction(m, { type: 'double', player: 'black' });
    expect(m.game?.phase).toEqual({ kind: 'double-offered', by: 'black' });
  });

  it('is never applied twice, even when the other player later reaches length - 1', () => {
    let m = applyAction(newMatch({ length: 3, crawford: true }), { type: 'start-game' });
    m = playOut(m, 'white', 'gammon'); // 2-0
    m = applyAction(m, { type: 'start-game' }); // Crawford
    m = playOut(m, 'black', 'gammon'); // 2-2
    m = applyAction(m, { type: 'start-game' });
    expect(m.game?.crawford).toBe(false);
  });

  it('is not applied when disabled or in money play', () => {
    let m = applyAction(newMatch({ length: 3, crawford: false }), { type: 'start-game' });
    m = playOut(m, 'white', 'gammon');
    m = applyAction(m, { type: 'start-game' });
    expect(m.game?.crawford).toBe(false);
    let money = applyAction(newMatch({ length: 0, crawford: true }), { type: 'start-game' });
    money = playOut(money, 'white', 'single');
    money = applyAction(money, { type: 'start-game' });
    expect(money.game?.crawford).toBe(false);
  });
});

describe('match end', () => {
  it('declares a winner when the score reaches the match length and refuses further games', () => {
    let m = applyAction(newMatch({ length: 3 }), { type: 'start-game' });
    m = playOut(m, 'black', 'single'); // 0-1
    m = applyAction(m, { type: 'start-game' });
    m = playOut(m, 'black', 'gammon', { value: 2, owner: 'black' }); // 0-5 (overshoot allowed)
    expect(m.score).toEqual({ white: 0, black: 5 });
    expect(m.winner).toBe('black');
    expect(m.games).toHaveLength(2);
    expect(code(() => applyAction(m, { type: 'start-game' }))).toBe('match-over');
    expect(pointsAway(m, 'black')).toBe(0);
  });

  it('a 1-point match: both players start one point away, so the only game is the Crawford game', () => {
    let m = applyAction(newMatch({ length: 1 }), { type: 'start-game' });
    expect(m.game?.crawford).toBe(true);
    expect(m.crawfordDone).toBe(true);
    m = playOut(m, 'white', 'single');
    expect(m.winner).toBe('white');
  });

  it('applyAction is exhaustive over action types', () => {
    const types: Action['type'][] = [
      'start-game',
      'opening-roll',
      'roll',
      'play',
      'double',
      'take',
      'drop',
      'offer-resign',
      'accept-resign',
      'decline-resign',
    ];
    expect(types).toHaveLength(10);
  });
});
