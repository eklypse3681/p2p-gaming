import { describe, expect, it } from 'vitest';
import {
  BAR,
  OFF,
  CHECKERS_PER_PLAYER,
  absIndex,
  absPointNumber,
  allInHome,
  applyPlay,
  applySubMove,
  assertValidBoard,
  boardFrom,
  boardKey,
  boardsEqual,
  cloneBoard,
  countAt,
  emptyBoard,
  opponent,
  opponentCountAt,
  ownerAt,
  pipCount,
  relPoint,
  sign,
  startingBoard,
  totalCheckers,
  undoSubMove,
} from '../src/index.js';
import { sm } from './helpers.js';

describe('coordinates', () => {
  it('abs/rel conversions round-trip for both players', () => {
    for (const p of ['white', 'black'] as const) {
      for (let rel = 1; rel <= 24; rel++) {
        const idx = absIndex(p, rel);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(23);
        expect(relPoint(p, idx)).toBe(rel);
      }
      for (let idx = 0; idx <= 23; idx++) expect(absIndex(p, relPoint(p, idx))).toBe(idx);
    }
  });

  it('white and black numbering are mirror images (rel + rel = 25 on the same index)', () => {
    for (let idx = 0; idx <= 23; idx++) {
      expect(relPoint('white', idx) + relPoint('black', idx)).toBe(25);
    }
    expect(absIndex('white', 1)).toBe(0);
    expect(absIndex('black', 1)).toBe(23);
    expect(absIndex('white', 24)).toBe(23);
    expect(absIndex('black', 24)).toBe(0);
    expect(absPointNumber(0)).toBe(1);
    expect(absPointNumber(23)).toBe(24);
  });

  it('rejects out-of-range points', () => {
    expect(() => absIndex('white', 0)).toThrow(RangeError);
    expect(() => absIndex('white', 25)).toThrow(RangeError);
    expect(() => relPoint('black', -1)).toThrow(RangeError);
    expect(() => relPoint('black', 24)).toThrow(RangeError);
  });

  it('opponent and sign', () => {
    expect(opponent('white')).toBe('black');
    expect(opponent('black')).toBe('white');
    expect(sign('white')).toBe(1);
    expect(sign('black')).toBe(-1);
  });
});

describe('boardFrom / counts', () => {
  it('places checkers in each player\'s numbering', () => {
    const b = boardFrom({ 6: 5, 13: 3, [BAR]: 2, [OFF]: 5 }, { 6: 4, 24: 2, [BAR]: 1, [OFF]: 8 });
    expect(b.points[5]).toBe(5); // white 6
    expect(b.points[12]).toBe(3); // white 13
    expect(b.points[18]).toBe(-4); // black 6 = index 18
    expect(b.points[0]).toBe(-2); // black 24 = index 0
    expect(b.bar).toEqual({ white: 2, black: 1 });
    expect(b.off).toEqual({ white: 5, black: 8 });
    expect(countAt(b, 'white', 6)).toBe(5);
    expect(countAt(b, 'black', 6)).toBe(4);
    expect(countAt(b, 'white', BAR)).toBe(2);
    expect(countAt(b, 'black', OFF)).toBe(8);
    // white looking at its own 19-point sees black's 6-point checkers
    expect(opponentCountAt(b, 'white', 19)).toBe(4);
    expect(opponentCountAt(b, 'black', 19)).toBe(5);
    expect(opponentCountAt(b, 'white', 1)).toBe(2);
    expect(opponentCountAt(b, 'white', 6)).toBe(0);
    expect(countAt(b, 'white', 19)).toBe(0);
    expect(totalCheckers(b, 'white')).toBe(15);
    expect(totalCheckers(b, 'black')).toBe(15);
  });

  it('refuses to put both colours on one point', () => {
    // white rel 6 (index 5) collides with black rel 19 (index 5)
    expect(() => boardFrom({ 6: 1 }, { 19: 1 })).toThrow(/occupied/);
  });

  it('ownerAt reports the colour on an absolute index', () => {
    const b = boardFrom({ 1: 2 }, { 1: 3 });
    expect(ownerAt(b, 0)).toBe('white');
    expect(ownerAt(b, 23)).toBe('black');
    expect(ownerAt(b, 10)).toBeNull();
  });

  it('emptyBoard and cloneBoard are independent copies', () => {
    const b = startingBoard();
    const c = cloneBoard(b);
    expect(boardsEqual(b, c)).toBe(true);
    c.points[0] = 9;
    c.bar.white = 1;
    c.off.black = 2;
    expect(b.points[0]).toBe(-2);
    expect(b.bar.white).toBe(0);
    expect(b.off.black).toBe(0);
    expect(boardsEqual(b, c)).toBe(false);
    const e = emptyBoard();
    expect(e.points.every((v) => v === 0)).toBe(true);
    expect(totalCheckers(e, 'white')).toBe(0);
  });
});

describe('starting position', () => {
  it('is valid and symmetric', () => {
    const b = startingBoard();
    assertValidBoard(b);
    for (const p of ['white', 'black'] as const) {
      expect(countAt(b, p, 24)).toBe(2);
      expect(countAt(b, p, 13)).toBe(5);
      expect(countAt(b, p, 8)).toBe(3);
      expect(countAt(b, p, 6)).toBe(5);
      expect(totalCheckers(b, p)).toBe(CHECKERS_PER_PLAYER);
    }
    expect(b.points).toEqual([
      -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2,
    ]);
  });

  it('assertValidBoard rejects wrong counts and sizes', () => {
    expect(() => assertValidBoard(boardFrom({ 1: 14 }, { 1: 15 }))).toThrow(/white/);
    expect(() => assertValidBoard(boardFrom({ 1: 15 }, { 1: 16 }))).toThrow(/black/);
    const short = { ...startingBoard(), points: [1, 2, 3] };
    expect(() => assertValidBoard(short)).toThrow(/24/);
  });
});

describe('pip count', () => {
  it('is 167 for both at the start', () => {
    const b = startingBoard();
    expect(pipCount(b, 'white')).toBe(167);
    expect(pipCount(b, 'black')).toBe(167);
  });

  it('matches hand-computed positions', () => {
    // 2 on the bar (25 each) + 13 on the 6 point
    expect(pipCount(boardFrom({ [BAR]: 2, 6: 13 }, {}), 'white')).toBe(2 * 25 + 13 * 6);
    // borne-off checkers count zero
    expect(pipCount(boardFrom({ [OFF]: 14, 1: 1 }, {}), 'white')).toBe(1);
    expect(pipCount(boardFrom({}, { 24: 2, 1: 13 }), 'black')).toBe(48 + 13);
    expect(pipCount(boardFrom({}, { 24: 2, 1: 13 }), 'white')).toBe(0);
  });
});

describe('allInHome', () => {
  it('requires no checkers on the bar or outside 1..6', () => {
    expect(allInHome(boardFrom({ 6: 5, 1: 10 }, {}), 'white')).toBe(true);
    expect(allInHome(boardFrom({ 6: 5, 1: 9, [OFF]: 1 }, {}), 'white')).toBe(true);
    expect(allInHome(boardFrom({ 7: 1, 1: 14 }, {}), 'white')).toBe(false);
    expect(allInHome(boardFrom({ [BAR]: 1, 1: 14 }, {}), 'white')).toBe(false);
    expect(allInHome(boardFrom({}, { 6: 15 }), 'black')).toBe(true);
    expect(allInHome(boardFrom({}, { 24: 1, 6: 14 }), 'black')).toBe(false);
    expect(allInHome(startingBoard(), 'white')).toBe(false);
  });
});

describe('applySubMove / undoSubMove', () => {
  it('moves a checker point to point and back', () => {
    const b = startingBoard();
    const m = sm(13, 7, 6);
    const after = applySubMove(b, 'white', m);
    expect(countAt(after, 'white', 13)).toBe(4);
    expect(countAt(after, 'white', 7)).toBe(1);
    expect(boardsEqual(undoSubMove(after, 'white', m), b)).toBe(true);
    expect(boardsEqual(b, after)).toBe(false);
  });

  it('black moves in the opposite direction on the absolute array', () => {
    const b = startingBoard();
    const after = applySubMove(b, 'black', sm(13, 7, 6));
    expect(after.points[11]).toBe(-4); // black 13 = index 11
    expect(after.points[17]).toBe(-1); // black 7 = index 17
    expect(boardsEqual(undoSubMove(after, 'black', sm(13, 7, 6)), b)).toBe(true);
  });

  it('hits send the opponent to the bar and undo restores the blot', () => {
    const b = boardFrom({ 8: 1, 6: 14 }, { 20: 1, 6: 14 }); // black 20 = white's 5-point
    const m = sm(8, 5, 3, true);
    const after = applySubMove(b, 'white', m);
    expect(countAt(after, 'white', 5)).toBe(1);
    expect(opponentCountAt(after, 'white', 5)).toBe(0);
    expect(after.bar.black).toBe(1);
    expect(totalCheckers(after, 'black')).toBe(15);
    const back = undoSubMove(after, 'white', m);
    expect(boardsEqual(back, b)).toBe(true);
    expect(back.bar.black).toBe(0);
    expect(countAt(back, 'black', 20)).toBe(1);
  });

  it('bar entry and bear-off round-trip', () => {
    const b = boardFrom({ [BAR]: 1, 3: 1, 1: 13 }, { 13: 15 });
    const enter = sm(BAR, 21, 4);
    const a1 = applySubMove(b, 'white', enter);
    expect(a1.bar.white).toBe(0);
    expect(countAt(a1, 'white', 21)).toBe(1);
    expect(boardsEqual(undoSubMove(a1, 'white', enter), b)).toBe(true);

    const home = boardFrom({ 3: 1, 1: 14 }, { 13: 15 });
    const off = sm(3, OFF, 5);
    const a2 = applySubMove(home, 'white', off);
    expect(a2.off.white).toBe(1);
    expect(countAt(a2, 'white', 3)).toBe(0);
    expect(boardsEqual(undoSubMove(a2, 'white', off), home)).toBe(true);
  });

  it('undo works in reverse order after two checkers land on a hit point', () => {
    const b = boardFrom({ 8: 1, 7: 1, 6: 13 }, { 20: 1, 6: 14 });
    const m1 = sm(8, 5, 3, true);
    const m2 = sm(7, 5, 2, false);
    const a = applyPlay(b, 'white', [m1, m2]);
    expect(countAt(a, 'white', 5)).toBe(2);
    expect(a.bar.black).toBe(1);
    const back = undoSubMove(undoSubMove(a, 'white', m2), 'white', m1);
    expect(boardsEqual(back, b)).toBe(true);
  });

  it('never changes the number of checkers per side', () => {
    const b = startingBoard();
    const a = applyPlay(b, 'white', [sm(24, 18, 6), sm(18, 13, 5)]);
    expect(totalCheckers(a, 'white')).toBe(15);
    expect(totalCheckers(a, 'black')).toBe(15);
    expect(boardKey(a)).not.toBe(boardKey(b));
  });
});
