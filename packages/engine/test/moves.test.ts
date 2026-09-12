import { describe, expect, it } from 'vitest';
import {
  BAR,
  OFF,
  boardFrom,
  canLand,
  distinctPlays,
  findLegalPlay,
  hasLegalMove,
  legalPlays,
  playKey,
  singleDieMoves,
  startingBoard,
  subMoveKey,
} from '../src/index.js';
import { sig, sigs, sm, sortedSig } from './helpers.js';

describe('canLand / singleDieMoves', () => {
  it('a point with two or more opposing checkers is blocked', () => {
    // black 20 = white's 5-point
    const b = boardFrom({ 8: 1, 6: 14 }, { 20: 2, 24: 13 });
    expect(canLand(b, 'white', 5)).toBe(false);
    expect(canLand(b, 'white', 7)).toBe(true);
    expect(canLand(b, 'white', 0)).toBe(false);
    expect(canLand(b, 'white', 25)).toBe(false);
    const moves = singleDieMoves(b, 'white', 3);
    expect(moves.map(sig)).toEqual(['6/3']);
  });

  it('a single opposing checker is a blot and the move is flagged as a hit', () => {
    const b = boardFrom({ 8: 1, 6: 14 }, { 20: 1, 24: 14 });
    const moves = singleDieMoves(b, 'white', 3);
    expect(moves).toContainEqual(sm(8, 5, 3, true));
    expect(moves).toContainEqual(sm(6, 3, 3, false));
    const one = singleDieMoves(b, 'white', 1);
    expect(one).toContainEqual(sm(6, 5, 1, true));
    expect(one).toContainEqual(sm(8, 7, 1, false));
  });

  it('black hits white blots symmetrically', () => {
    // white 20 = black's 5-point
    const b = boardFrom({ 20: 1, 24: 14 }, { 8: 1, 6: 14 });
    expect(singleDieMoves(b, 'black', 3)).toContainEqual(sm(8, 5, 3, true));
  });

  it('with a checker on the bar, only entering moves exist', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 13: 15 });
    expect(singleDieMoves(b, 'white', 3)).toEqual([sm(BAR, 22, 3)]);
    expect(singleDieMoves(b, 'white', 6)).toEqual([sm(BAR, 19, 6)]);
  });

  it('a blocked entry point yields no move for that die', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 3: 2, 13: 13 }); // black 3 = white's 22
    expect(singleDieMoves(b, 'white', 3)).toEqual([]);
    expect(singleDieMoves(b, 'white', 4)).toEqual([sm(BAR, 21, 4)]);
  });

  it('subMoveKey / playKey are stable and order-sensitive', () => {
    expect(subMoveKey(sm(13, 7, 6))).toBe('13>7/6');
    expect(playKey([sm(13, 7, 6), sm(7, 6, 1)])).toBe('13>7/6 7>6/1');
    expect(playKey([sm(7, 6, 1), sm(13, 7, 6)])).not.toBe(playKey([sm(13, 7, 6), sm(7, 6, 1)]));
  });
});

describe('legalPlays: bar', () => {
  it('must enter before anything else moves (one on bar)', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 13: 15 });
    const plays = legalPlays(b, 'white', [3, 4]);
    expect(plays.length).toBeGreaterThan(0);
    for (const p of plays) {
      expect(p).toHaveLength(2);
      expect(p[0]!.from).toBe(BAR);
    }
    // entering and then continuing with the same checker is allowed
    expect(sigs(plays)).toContain('25/22 22/18');
    expect(sigs(plays)).toContain('25/21 21/18');
    // and moving a different checker after entering
    expect(sigs(plays)).toContain('25/22 13/9');
  });

  it('with two on the bar both dice enter', () => {
    const b = boardFrom({ [BAR]: 2, 13: 13 }, { 13: 15 });
    const plays = legalPlays(b, 'white', [3, 4]);
    expect(sigs(plays)).toEqual(['25/21 25/22', '25/22 25/21']);
  });

  it('with two on the bar and one entry blocked, only one die may be played (the entering one)', () => {
    const b = boardFrom({ [BAR]: 2, 13: 13 }, { 3: 2, 13: 13 }); // white's 22 blocked
    const plays = legalPlays(b, 'white', [3, 4]);
    expect(plays.map(sig)).toEqual(['25/21']);
    expect(plays[0]![0]!.die).toBe(4);
  });

  it('with one on the bar and one entry blocked, the other die is played after entering', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 3: 2, 13: 13 });
    const plays = legalPlays(b, 'white', [3, 4]);
    expect(plays.every((p) => p.length === 2 && p[0]!.from === BAR && p[0]!.die === 4)).toBe(true);
    expect(sigs(plays)).toContain('25/21 21/18');
    expect(sigs(plays)).toContain('25/21 13/10');
  });

  it('doubles with two on the bar: enter both, then two more moves', () => {
    const b = boardFrom({ [BAR]: 2, 13: 13 }, { 13: 15 });
    const plays = legalPlays(b, 'white', [3, 3]);
    expect(plays.every((p) => p.length === 4)).toBe(true);
    expect(plays.every((p) => p[0]!.from === BAR && p[1]!.from === BAR)).toBe(true);
    expect(sigs(plays)).toContain('25/22 25/22 22/19 22/19');
    expect(sigs(plays)).toContain('25/22 25/22 13/10 13/10');
  });

  it('fully closed board: no entry, no play', () => {
    const b = boardFrom({ [BAR]: 1, 13: 14 }, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 3 });
    expect(legalPlays(b, 'white', [3, 4])).toEqual([]);
    expect(legalPlays(b, 'white', [6, 6])).toEqual([]);
    expect(hasLegalMove(b, 'white', [1, 2])).toBe(false);
  });
});

describe('legalPlays: use both dice', () => {
  // White: 8, 13, and 13 on the 6-point. Black blocks white's 5, 12 and 1 and leaves a blot on white's 2.
  // Playing 8/2* with the 6 looks tempting but strands the 1; 13/7 keeps the 1 playable.
  const tempting = boardFrom({ 8: 1, 13: 1, 6: 13 }, { 23: 1, 13: 5, 20: 2, 24: 2, 6: 5 });

  it('a play that strands the second die is illegal when another play uses both', () => {
    const plays = legalPlays(tempting, 'white', [6, 1]);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((p) => p.length === 2)).toBe(true);
    expect(plays.some((p) => p.some((m) => m.from === 8 && m.to === 2))).toBe(false);
    expect(sigs(plays)).toEqual(['13/7 7/6', '13/7 8/7', '8/7 13/7']);
  });

  it('distinctPlays collapses orderings that reach the same position', () => {
    const d = distinctPlays(tempting, 'white', [6, 1]);
    expect(d).toHaveLength(2);
    const keys = d.map(sortedSig).sort();
    expect(keys).toEqual(['13/7 7/6', '13/7 8/7']);
  });

  it('includes both die orderings from the starting position', () => {
    const plays = legalPlays(startingBoard(), 'white', [3, 1]);
    expect(sigs(plays)).toContain('8/5 6/5');
    expect(sigs(plays)).toContain('6/5 8/5');
    expect(plays.every((p) => p.length === 2)).toBe(true);
    // 13/12 is blocked by black's 5 on their 13 (white's 12)
    expect(plays.some((p) => p.some((m) => m.from === 13 && m.to === 12))).toBe(false);
  });

  it('when only one die can be used and both are individually playable, the higher is required', () => {
    // White 8 + 14 on 6. Black holds white's 1 and 5. 8/2 (6) or 8/7 (1) each strand the other.
    const b = boardFrom({ 8: 1, 6: 14 }, { 24: 2, 20: 2, 6: 5, 13: 5, 8: 1 });
    expect(singleDieMoves(b, 'white', 1)).toEqual([sm(8, 7, 1)]);
    expect(singleDieMoves(b, 'white', 6)).toEqual([sm(8, 2, 6)]);
    const plays = legalPlays(b, 'white', [1, 6]);
    expect(plays.map(sig)).toEqual(['8/2']);
    expect(plays[0]![0]!.die).toBe(6);
    // same answer regardless of dice order
    expect(legalPlays(b, 'white', [6, 1]).map(sig)).toEqual(['8/2']);
  });

  it('when the higher die cannot be played at all, the lower one is', () => {
    // 6s: 13/7 blocked (black 18), 8/2 blocked (black 23); 1s: 13/12 blocked, 8/7 blocked, 6/5 open.
    const b = boardFrom({ 13: 1, 8: 1, 6: 13 }, { 21: 2, 22: 2, 23: 2, 24: 2, 13: 5, 18: 2 });
    expect(singleDieMoves(b, 'white', 6)).toEqual([]);
    const plays = legalPlays(b, 'white', [6, 1]);
    expect(plays.map(sig)).toEqual(['6/5']);
    expect(plays[0]![0]!.die).toBe(1);
  });

  it('returns [] when neither die can be played', () => {
    const b = boardFrom({ 13: 1, 6: 14 }, { 18: 2, 13: 5, 20: 2, 6: 6 });
    expect(legalPlays(b, 'white', [6, 1])).toEqual([]);
    expect(distinctPlays(b, 'white', [6, 1])).toEqual([]);
    expect(hasLegalMove(b, 'white', [6, 1])).toBe(false);
    expect(hasLegalMove(b, 'white', [2, 3])).toBe(true);
  });
});

describe('legalPlays: doubles', () => {
  it('from the start, 6-6 uses all four moves and includes 24/18(2) 13/7(2)', () => {
    const plays = legalPlays(startingBoard(), 'white', [6, 6]);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((p) => p.length === 4)).toBe(true);
    expect(plays.map(sortedSig)).toContain('13/7 13/7 24/18 24/18');
    // white's 2-point is open at the start (black's back checkers sit on white's 1-point), so 8/2 is legal too
    expect(plays.map(sortedSig)).toContain('13/7 13/7 8/2 8/2');
  });

  it('plays fewer than four when blocked', () => {
    // White's two back checkers can go 24/18 each but 18/12 is blocked; 6s from the 6-point can't bear off.
    const b = boardFrom({ 24: 2, 6: 13 }, { 13: 5, 6: 5, 8: 3, 24: 2 });
    const plays = legalPlays(b, 'white', [6, 6]);
    expect(plays.map(sig)).toEqual(['24/18 24/18']);
  });

  it('a single move only when that is all that is possible', () => {
    const b = boardFrom({ 24: 1, 6: 14 }, { 13: 5, 6: 5, 8: 3, 24: 2 });
    expect(legalPlays(b, 'white', [6, 6]).map(sig)).toEqual(['24/18']);
  });

  it('doubles can move one checker four times when the path is open', () => {
    const b = boardFrom({ 24: 1, 6: 14 }, { 6: 5, 8: 3, 24: 2, 2: 5 });
    const plays = legalPlays(b, 'white', [2, 2]);
    expect(sigs(plays)).toContain('24/22 22/20 20/18 18/16');
  });
});

describe('findLegalPlay', () => {
  it('accepts legal plays ignoring the hit flag and returns the canonical version', () => {
    const b = boardFrom({ 8: 1, 6: 14 }, { 20: 1, 24: 14 });
    const found = findLegalPlay(b, 'white', [3, 1], [sm(8, 5, 3, false), sm(6, 5, 1, false)]);
    expect(found).not.toBeNull();
    expect(found![0]!.hit).toBe(true);
    expect(found![1]!.hit).toBe(false);
  });

  it('rejects wrong length, wrong die and wrong destination', () => {
    const b = startingBoard();
    expect(findLegalPlay(b, 'white', [3, 1], [sm(8, 5, 3)])).toBeNull();
    expect(findLegalPlay(b, 'white', [3, 1], [sm(8, 5, 1), sm(6, 5, 3)])).toBeNull();
    expect(findLegalPlay(b, 'white', [3, 1], [sm(8, 4, 3), sm(6, 5, 1)])).toBeNull();
    expect(findLegalPlay(b, 'white', [3, 1], [sm(8, 5, 3), sm(6, 5, 1), sm(6, 5, 1)])).toBeNull();
    expect(findLegalPlay(b, 'white', [3, 1], [])).toBeNull();
  });

  it('rejects a play that leaves a die unused when both could be played', () => {
    const b = startingBoard();
    expect(findLegalPlay(b, 'white', [6, 6], [sm(24, 18, 6), sm(24, 18, 6)])).toBeNull();
  });

  it('bear-off with a die larger than needed is normalised to `to: 0`', () => {
    const b = boardFrom({ 3: 2, 1: 13 }, { 13: 15 });
    const found = findLegalPlay(b, 'white', [6, 5], [sm(3, OFF, 6), sm(3, OFF, 5)]);
    expect(found).not.toBeNull();
  });
});
