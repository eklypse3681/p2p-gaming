import { describe, expect, it } from 'vitest';
import { BAR, OFF, boardFrom, distinctPlays, legalPlays, singleDieMoves } from '../src/index.js';
import { sig, sigs, sm, sortedSig } from './helpers.js';

const noBlack = { 13: 15 };

describe('bearing off: eligibility', () => {
  it('is not allowed while a checker is on the bar', () => {
    const b = boardFrom({ [BAR]: 1, 1: 14 }, noBlack);
    const plays = legalPlays(b, 'white', [1, 2]);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((p) => p.every((m) => m.to !== OFF))).toBe(true);
  });

  it('is not allowed while a checker is outside the home board', () => {
    const b = boardFrom({ 7: 1, 6: 14 }, noBlack);
    expect(singleDieMoves(b, 'white', 6)).toEqual([sm(7, 1, 6)]);
    expect(singleDieMoves(b, 'white', 6).some((m) => m.to === OFF)).toBe(false);
  });

  it('a checker brought home this turn may be borne off with the second die', () => {
    const b = boardFrom({ 7: 1, 6: 14 }, noBlack);
    const plays = legalPlays(b, 'white', [1, 6]);
    expect(sigs(plays)).toContain('7/6 6/0');
    expect(sigs(plays)).toContain('7/1 1/0'); // 6 first: 7/1, then all home, 1 bears off from the 1-point
    expect(plays.every((p) => p.length === 2)).toBe(true);
    // the 1 may not bear off before the outside checker is in
    expect(plays.every((p) => !(p[0]!.to === OFF))).toBe(true);
  });

  it('black bears off from its own home board (absolute indices 18..23)', () => {
    const b = boardFrom({ 13: 15 }, { 3: 2, 1: 13 });
    const plays = distinctPlays(b, 'black', [6, 5]);
    expect(plays).toHaveLength(1);
    expect(plays[0]!.every((m) => m.to === OFF && m.from === 3)).toBe(true);
    expect(b.points[21]).toBe(-2); // black 3 = index 21
  });
});

describe('bearing off: which die', () => {
  it('exact bear-off is always allowed', () => {
    const b = boardFrom({ 6: 2, 1: 13 }, noBlack);
    const plays = legalPlays(b, 'white', [6, 6]);
    expect(plays.every((p) => p.length === 4 && p.every((m) => m.to === OFF))).toBe(true);
    expect(plays.map(sig)).toEqual(['6/0 6/0 1/0 1/0']);
  });

  it('a larger die may only bear off from the highest occupied point', () => {
    const b = boardFrom({ 5: 1, 3: 1, 1: 13 }, noBlack);
    expect(singleDieMoves(b, 'white', 6)).toEqual([sm(5, OFF, 6)]);
    // 4: 5/1 is a normal move; 3 is not the highest point so it may not bear off with a 4.
    expect(singleDieMoves(b, 'white', 4)).toEqual([sm(5, 1, 4)]);
    // 2: 5/3, 3/1 normal moves; exact bear-off impossible; 1-point may not use a 2 (5 is higher)
    expect(sigs([singleDieMoves(b, 'white', 2)])).toEqual(['5/3 3/1']);
  });

  it('6-5 with checkers only on the 3-point bears off two checkers', () => {
    const b = boardFrom({ 3: 2, 1: 13 }, noBlack);
    const d = distinctPlays(b, 'white', [6, 5]);
    expect(d).toHaveLength(1);
    expect(d[0]!.map((m) => m.to)).toEqual([OFF, OFF]);
    expect(d[0]!.map((m) => m.from)).toEqual([3, 3]);
  });

  it('the lower die must be used inside the home board when it cannot bear off', () => {
    const b = boardFrom({ 6: 1, 3: 1, 1: 13 }, noBlack);
    const plays = legalPlays(b, 'white', [5, 2]);
    expect(plays.every((p) => p.length === 2)).toBe(true);
    // the 5 cannot bear off the 6-point checker (not exact, and a 5 < 6)
    expect(plays.some((p) => p.some((m) => m.from === 6 && m.to === OFF))).toBe(false);
    // 5 then 2: 6/1 3/1 (either order). 2 then 5: 6/4 and then the 4-point is the highest, so 4/0.
    expect(new Set(plays.map(sortedSig))).toEqual(new Set(['3/1 6/1', '4/0 6/4']));
  });

  it('must use both dice while bearing off when possible (6-5 with checkers on 6 and 5)', () => {
    const b = boardFrom({ 6: 1, 5: 1, 1: 13 }, noBlack);
    const plays = legalPlays(b, 'white', [6, 5]);
    expect(plays.every((p) => p.length === 2)).toBe(true);
    expect(sigs(plays)).toContain('6/0 5/0');
    expect(sigs(plays)).toContain('5/0 6/0');
    // 6/1 with the 5 then 5/0 with the 6 (5 is now the highest point) is also legal
    expect(sigs(plays)).toContain('6/1 5/0');
  });

  it('after bearing off the highest checker, the next highest becomes eligible for a larger die', () => {
    const b = boardFrom({ 4: 1, 2: 1, 1: 13 }, noBlack);
    const plays = legalPlays(b, 'white', [6, 5]);
    expect(sigs(plays)).toContain('4/0 2/0');
    // with the 5 first: 4/0 (highest), then 6: 2/0 (highest)
    expect(plays.some((p) => p[0]!.die === 5 && p[0]!.from === 4 && p[1]!.from === 2)).toBe(true);
  });

  it('bearing off from a point while an opponent checker sits in your home board is fine', () => {
    // black anchor on white's 5-point (black's 20); white all home otherwise
    const b = boardFrom({ 6: 2, 4: 3, 1: 10 }, { 20: 2, 13: 13 });
    const plays = legalPlays(b, 'white', [6, 4]);
    expect(sigs(plays)).toContain('6/0 4/0');
    // a 4 from the 6-point would land on black's anchor: not allowed
    expect(plays.some((p) => p.some((m) => m.from === 6 && m.to === 2))).toBe(true);
    expect(plays.some((p) => p.some((m) => m.from === 6 && m.to === 5))).toBe(false);
  });

  it('a hit inside the home board on the way to bearing off', () => {
    const b = boardFrom({ 6: 1, 1: 14 }, { 22: 1, 13: 14 }); // black blot on white's 3-point
    const plays = legalPlays(b, 'white', [3, 3]);
    expect(plays.length).toBeGreaterThan(0);
    const hitPlay = plays.find((p) => p[0]!.from === 6 && p[0]!.to === 3);
    expect(hitPlay).toBeDefined();
    expect(hitPlay![0]!.hit).toBe(true);
  });
});
