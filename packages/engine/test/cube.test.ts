import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/index.js';
import { MAX_CUBE, RuleError, canDouble, game, newGame, startingBoard } from '../src/index.js';
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

describe('canDouble', () => {
  it('only the player on roll, before rolling', () => {
    const s = toRollGame(startingBoard(), 'white');
    expect(canDouble(s, 'white')).toBe(true);
    expect(canDouble(s, 'black')).toBe(false);
    const rolled = game.roll(s, 'white', [3, 1]);
    expect(canDouble(rolled, 'white')).toBe(false);
    expect(canDouble(newGame(), 'white')).toBe(false);
  });

  it('the winner of the opening roll moves immediately and cannot double first', () => {
    let s = newGame();
    s = game.openingRoll(s, 'white', 4);
    s = game.openingRoll(s, 'black', 2);
    expect(s.phase.kind).toBe('moving');
    expect(canDouble(s, 'white')).toBe(false);
    expect(code(() => game.double(s, 'white'))).toBe('wrong-phase');
    s = game.play(s, 'white', [sm(24, 20, 4), sm(24, 22, 2)]);
    expect(canDouble(s, 'black')).toBe(true);
  });

  it('only the cube owner (or anyone when centred) may double', () => {
    const base = toRollGame(startingBoard(), 'white');
    expect(canDouble({ ...base, cube: { value: 2, owner: 'white' } }, 'white')).toBe(true);
    expect(canDouble({ ...base, cube: { value: 2, owner: 'black' } }, 'white')).toBe(false);
    expect(code(() => game.double({ ...base, cube: { value: 2, owner: 'black' } }, 'white'))).toBe(
      'cannot-double',
    );
  });

  it('never in the Crawford game', () => {
    const s = toRollGame(startingBoard(), 'white', { crawford: true });
    expect(canDouble(s, 'white')).toBe(false);
    expect(code(() => game.double(s, 'white'))).toBe('crawford');
  });

  it('is capped at MAX_CUBE', () => {
    const base = toRollGame(startingBoard(), 'white');
    expect(canDouble({ ...base, cube: { value: MAX_CUBE / 2, owner: 'white' } }, 'white')).toBe(true);
    expect(canDouble({ ...base, cube: { value: MAX_CUBE, owner: 'white' } }, 'white')).toBe(false);
    expect(code(() => game.double({ ...base, cube: { value: MAX_CUBE, owner: 'center' } }, 'white'))).toBe(
      'cannot-double',
    );
  });
});

describe('double / take / drop', () => {
  it('double → take doubles the cube, gives it to the taker and returns the roll to the doubler', () => {
    const s0 = toRollGame(startingBoard(), 'white');
    const s1 = game.double(s0, 'white');
    expect(s1.phase).toEqual({ kind: 'double-offered', by: 'white' });
    expect(s1.cube).toEqual({ value: 1, owner: 'center' }); // unchanged until taken
    expect(s1.history.at(-1)).toEqual({ type: 'double', player: 'white', value: 2 });
    expect(code(() => game.take(s1, 'white'))).toBe('not-your-turn');
    expect(code(() => game.drop(s1, 'white'))).toBe('not-your-turn');
    expect(code(() => game.roll(s1, 'white', [1, 2]))).toBe('wrong-phase');
    const s2 = game.take(s1, 'black');
    expect(s2.cube).toEqual({ value: 2, owner: 'black' });
    expect(s2.phase).toEqual({ kind: 'to-roll', player: 'white' });
    expect(s2.history.at(-1)).toEqual({ type: 'take', player: 'black' });
    // the doubler no longer owns the cube and cannot redouble
    expect(canDouble(s2, 'white')).toBe(false);
    expect(code(() => game.double(s2, 'white'))).toBe('cannot-double');
  });

  it('the taker may redouble on a later turn; ownership swaps again', () => {
    let s: GameState = toRollGame(startingBoard(), 'white');
    s = game.take(game.double(s, 'white'), 'black');
    s = game.roll(s, 'white', [3, 1]);
    s = game.play(s, 'white', [sm(8, 5, 3), sm(6, 5, 1)]);
    expect(s.phase).toEqual({ kind: 'to-roll', player: 'black' });
    expect(canDouble(s, 'black')).toBe(true);
    s = game.double(s, 'black');
    expect(s.history.at(-1)).toEqual({ type: 'double', player: 'black', value: 4 });
    s = game.take(s, 'white');
    expect(s.cube).toEqual({ value: 4, owner: 'white' });
    expect(s.phase).toEqual({ kind: 'to-roll', player: 'black' });
  });

  it('double → drop ends the game for the doubler at the pre-double value', () => {
    const s0: GameState = { ...toRollGame(startingBoard(), 'black'), cube: { value: 2, owner: 'black' } };
    const s1 = game.drop(game.double(s0, 'black'), 'white');
    expect(s1.phase).toEqual({
      kind: 'over',
      result: { winner: 'black', kind: 'single', how: 'drop', cube: 2, points: 0 },
    });
    expect(s1.cube).toEqual({ value: 2, owner: 'black' });
    expect(s1.history.map((h) => h.type)).toEqual(['double', 'drop']);
  });

  it('cannot double twice in a row or take/drop when nothing is offered', () => {
    const s0 = toRollGame(startingBoard(), 'white');
    const s1 = game.double(s0, 'white');
    expect(code(() => game.double(s1, 'white'))).toBe('wrong-phase');
    expect(code(() => game.take(s0, 'black'))).toBe('wrong-phase');
    expect(code(() => game.drop(s0, 'black'))).toBe('wrong-phase');
  });
});
