import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/index.js';
import {
  BAR,
  OFF,
  RuleError,
  boardFrom,
  game,
  isGameOver,
  newGame,
  playerToAct,
  resultKind,
  startingBoard,
} from '../src/index.js';
import { sm, toRollGame } from './helpers.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  throw new Error('expected a RuleError');
}

describe('newGame', () => {
  it('starts in the opening phase with a centred cube', () => {
    const s = newGame();
    expect(s.phase).toEqual({ kind: 'opening', rolls: {}, ties: 0 });
    expect(s.cube).toEqual({ value: 1, owner: 'center' });
    expect(s.crawford).toBe(false);
    expect(s.turnCount).toBe(0);
    expect(s.history).toEqual([]);
    expect(s.board).toEqual(startingBoard());
    expect(isGameOver(s)).toBe(false);
    expect(playerToAct(s)).toBeNull();
  });

  it('accepts a custom board and crawford flag', () => {
    const b = boardFrom({ 1: 15 }, { 1: 15 });
    const s = newGame({ board: b, crawford: true });
    expect(s.board).toBe(b);
    expect(s.crawford).toBe(true);
  });
});

describe('opening roll', () => {
  it('records partial rolls, a tie resets and counts, the winner moves with both dice', () => {
    let s = newGame();
    s = game.openingRoll(s, 'white', 3);
    expect(s.phase).toEqual({ kind: 'opening', rolls: { white: 3 }, ties: 0 });
    expect(code(() => game.openingRoll(s, 'white', 4))).toBe('already-rolled');
    s = game.openingRoll(s, 'black', 3);
    expect(s.phase).toEqual({ kind: 'opening', rolls: {}, ties: 1 });
    expect(s.history).toEqual([]);
    s = game.openingRoll(s, 'black', 2);
    s = game.openingRoll(s, 'white', 5);
    expect(s.phase).toEqual({ kind: 'moving', player: 'white', dice: [5, 2] });
    expect(s.history).toEqual([{ type: 'opening', white: 5, black: 2 }]);
    expect(playerToAct(s)).toBe('white');
  });

  it('black wins the opening and the dice are ordered [winner, loser]', () => {
    let s = newGame();
    s = game.openingRoll(s, 'white', 2);
    s = game.openingRoll(s, 'black', 6);
    expect(s.phase).toEqual({ kind: 'moving', player: 'black', dice: [6, 2] });
  });

  it('cannot roll the opening die in another phase', () => {
    const s = toRollGame(startingBoard(), 'white');
    expect(code(() => game.openingRoll(s, 'white', 1))).toBe('wrong-phase');
  });

  it('skips the winner\'s turn when the opening roll has no legal move', () => {
    const b = boardFrom({ 13: 1, 6: 14 }, { 18: 2, 13: 5, 20: 2, 6: 6 });
    let s = newGame({ board: b });
    s = game.openingRoll(s, 'white', 6);
    s = game.openingRoll(s, 'black', 1);
    expect(s.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(s.history).toEqual([
      { type: 'opening', white: 6, black: 1 },
      { type: 'move', player: 'white', dice: [6, 1], play: [] },
    ]);
    expect(s.turnCount).toBe(1);
  });
});

describe('roll', () => {
  it('moves to the moving phase for the player on roll', () => {
    const s = game.roll(toRollGame(startingBoard(), 'black'), 'black', [4, 2]);
    expect(s.phase).toEqual({ kind: 'moving', player: 'black', dice: [4, 2] });
  });

  it('rejects the wrong player and the wrong phase', () => {
    const s = toRollGame(startingBoard(), 'black');
    expect(code(() => game.roll(s, 'white', [4, 2]))).toBe('not-your-turn');
    expect(code(() => game.roll(newGame(), 'white', [4, 2]))).toBe('wrong-phase');
  });

  it('auto-passes when the roll has no legal move', () => {
    const b = boardFrom({ 13: 1, 6: 14 }, { 18: 2, 13: 5, 20: 2, 6: 6 });
    const s = game.roll(toRollGame(b, 'white'), 'white', [6, 1]);
    expect(s.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(s.history.at(-1)).toEqual({ type: 'move', player: 'white', dice: [6, 1], play: [] });
    expect(s.turnCount).toBe(1);
  });
});

describe('play', () => {
  const moving = (): GameState =>
    game.roll(toRollGame(startingBoard(), 'white'), 'white', [3, 1]);

  it('applies a legal play, records it and passes the turn', () => {
    const s = game.play(moving(), 'white', [sm(8, 5, 3), sm(6, 5, 1)]);
    expect(s.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(s.board.points[4]).toBe(2);
    expect(s.board.points[7]).toBe(2);
    expect(s.board.points[5]).toBe(4);
    expect(s.turnCount).toBe(1);
    expect(s.history.at(-1)).toMatchObject({ type: 'move', player: 'white', dice: [3, 1] });
    expect(playerToAct(s)).toBe('black');
  });

  it('rejects wrong player, illegal plays and wrong phase', () => {
    expect(code(() => game.play(moving(), 'black', [sm(8, 5, 3), sm(6, 5, 1)]))).toBe(
      'not-your-turn',
    );
    expect(code(() => game.play(moving(), 'white', [sm(8, 5, 3)]))).toBe('illegal-play');
    expect(code(() => game.play(moving(), 'white', [sm(13, 12, 1), sm(8, 5, 3)]))).toBe(
      'illegal-play',
    );
    expect(code(() => game.play(newGame(), 'white', []))).toBe('wrong-phase');
    expect(code(() => game.play(toRollGame(startingBoard(), 'white'), 'white', []))).toBe(
      'wrong-phase',
    );
  });

  it('records the hit flag canonically even if the client omitted it', () => {
    const b = boardFrom({ 8: 1, 6: 14 }, { 20: 1, 24: 14 });
    const s = game.play(game.roll(toRollGame(b, 'white'), 'white', [3, 1]), 'white', [
      sm(8, 5, 3, false),
      sm(6, 5, 1, false),
    ]);
    const rec = s.history.at(-1)!;
    expect(rec.type).toBe('move');
    if (rec.type === 'move') expect(rec.play[0]!.hit).toBe(true);
    expect(s.board.bar.black).toBe(1);
  });
});

describe('game over classification', () => {
  function finish(white: Record<number, number>, black: Record<number, number>): GameState {
    // white has one checker left on the 1-point; a 6-1 must bear it off with the 6
    const b = boardFrom({ 1: 1, [OFF]: 14, ...white }, black);
    const s = game.roll(toRollGame(b, 'white'), 'white', [6, 1]);
    return game.play(s, 'white', [sm(1, OFF, 6)]);
  }

  it('single when the loser has borne off at least one', () => {
    const s = finish({}, { [OFF]: 1, 13: 14 });
    expect(s.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'white', kind: 'single', how: 'bearoff', cube: 1, points: 0 },
    });
    expect(isGameOver(s)).toBe(true);
    expect(playerToAct(s)).toBeNull();
    expect(s.board.off.white).toBe(15);
  });

  it('gammon when the loser has borne off none', () => {
    const s = finish({}, { 13: 15 });
    expect(s.phase).toMatchObject({ kind: 'over', result: { kind: 'gammon' } });
  });

  it('backgammon when the loser still has a checker on the bar', () => {
    const s = finish({}, { [BAR]: 1, 13: 14 });
    expect(s.phase).toMatchObject({ kind: 'over', result: { kind: 'backgammon' } });
  });

  it('backgammon when the loser still has a checker in the winner\'s home board', () => {
    // black's 20-point is inside white's home board (white's 5-point)
    const s = finish({}, { 20: 1, 13: 14 });
    expect(s.phase).toMatchObject({ kind: 'over', result: { kind: 'backgammon' } });
    // black's 18-point is white's 7-point: outside the home board → gammon only
    const g = finish({}, { 18: 1, 13: 14 });
    expect(g.phase).toMatchObject({ kind: 'over', result: { kind: 'gammon' } });
  });

  it('resultKind works for black as the winner', () => {
    expect(resultKind(boardFrom({ 13: 15 }, { [OFF]: 15 }), 'black')).toBe('gammon');
    expect(resultKind(boardFrom({ [OFF]: 1, 13: 14 }, { [OFF]: 15 }), 'black')).toBe('single');
    expect(resultKind(boardFrom({ 24: 1, 13: 14 }, { [OFF]: 15 }), 'black')).toBe('backgammon');
    expect(resultKind(boardFrom({ [BAR]: 1, 13: 14 }, { [OFF]: 15 }), 'black')).toBe('backgammon');
  });

  it('a finished game rejects further actions', () => {
    const s = finish({}, { 13: 15 });
    expect(code(() => game.roll(s, 'black', [1, 1]))).toBe('wrong-phase');
    expect(code(() => game.double(s, 'black'))).toBe('wrong-phase');
    expect(code(() => game.offerResign(s, 'black', 'single'))).toBe('game-over');
  });
});

describe('resignation', () => {
  it('offer, decline restores the prior phase', () => {
    const s0 = toRollGame(startingBoard(), 'white');
    const s1 = game.offerResign(s0, 'black', 'single');
    expect(s1.phase).toEqual({
      kind: 'resign-offered',
      by: 'black',
      stakes: 'single',
      prior: { kind: 'to-roll', player: 'white' },
    });
    expect(playerToAct(s1)).toBe('white');
    expect(code(() => game.acceptResign(s1, 'black'))).toBe('not-your-turn');
    expect(code(() => game.declineResign(s1, 'black'))).toBe('not-your-turn');
    const s2 = game.declineResign(s1, 'white');
    expect(s2.phase).toEqual({ kind: 'to-roll', player: 'white' });
    expect(s2.history.map((h) => h.type)).toEqual(['resign-offer', 'resign-decline']);
  });

  it('accept ends the game at the offered stakes times the cube', () => {
    const s0: GameState = { ...toRollGame(startingBoard(), 'white'), cube: { value: 4, owner: 'black' } };
    const s1 = game.acceptResign(game.offerResign(s0, 'white', 'gammon'), 'black');
    expect(s1.phase).toMatchObject({
      kind: 'over',
      result: { winner: 'black', kind: 'gammon', how: 'resign', cube: 4, points: 0 },
    });
  });

  it('may be offered while moving or while a double is pending, but not during the opening', () => {
    const moving = game.roll(toRollGame(startingBoard(), 'white'), 'white', [3, 1]);
    const r = game.offerResign(moving, 'white', 'single');
    expect(r.phase).toMatchObject({ kind: 'resign-offered', prior: { kind: 'moving' } });
    expect(game.declineResign(r, 'black').phase).toEqual(moving.phase);

    const pending = game.double(toRollGame(startingBoard(), 'white'), 'white');
    const r2 = game.offerResign(pending, 'black', 'single');
    expect(r2.phase).toMatchObject({ kind: 'resign-offered', by: 'black', prior: { kind: 'double-offered' } });

    expect(code(() => game.offerResign(newGame(), 'white', 'single'))).toBe('wrong-phase');
    expect(code(() => game.offerResign(r, 'black', 'single'))).toBe('wrong-phase');
  });
});
