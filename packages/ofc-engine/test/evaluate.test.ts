import { describe, expect, it } from 'vitest';
import {
  cards,
  compareHigh5,
  compareLow27,
  compareMiddleVsTop,
  compareTop3,
  describeHand,
  evaluateHigh5,
  evaluateTop3,
  isQualifiedLow,
  isWheel27,
} from '../src/index.js';

const h = (s: string) => cards(s);

describe('five-card high evaluation', () => {
  it('classifies every category', () => {
    expect(evaluateHigh5(h('As Ks Qs Js Ts'))).toMatchObject({
      category: 'straight-flush',
      royal: true,
      ranks: [14],
    });
    expect(evaluateHigh5(h('9s 8s 7s 6s 5s'))).toMatchObject({
      category: 'straight-flush',
      royal: false,
      ranks: [9],
    });
    expect(evaluateHigh5(h('As 2s 3s 4s 5s'))).toMatchObject({
      category: 'straight-flush',
      ranks: [5],
    });
    expect(evaluateHigh5(h('Kd Kc Kh Ks 2s'))).toMatchObject({ category: 'quads', ranks: [13, 2] });
    expect(evaluateHigh5(h('3d 3c 3h 9s 9d'))).toMatchObject({
      category: 'full-house',
      ranks: [3, 9],
    });
    expect(evaluateHigh5(h('Ad 9d 7d 4d 2d'))).toMatchObject({
      category: 'flush',
      ranks: [14, 9, 7, 4, 2],
    });
    expect(evaluateHigh5(h('Ts 9d 8c 7h 6s'))).toMatchObject({ category: 'straight', ranks: [10] });
    expect(evaluateHigh5(h('Ad 2c 3h 4s 5d'))).toMatchObject({ category: 'straight', ranks: [5] });
    expect(evaluateHigh5(h('7d 7c 7h Ks 2d'))).toMatchObject({
      category: 'trips',
      ranks: [7, 13, 2],
    });
    expect(evaluateHigh5(h('Jd Jc 4h 4s Ad'))).toMatchObject({
      category: 'two-pair',
      ranks: [11, 4, 14],
    });
    expect(evaluateHigh5(h('8d 8c Kh 5s 2d'))).toMatchObject({
      category: 'pair',
      ranks: [8, 13, 5, 2],
    });
    expect(evaluateHigh5(h('Kd 9c 7h 5s 2d'))).toMatchObject({
      category: 'high-card',
      ranks: [13, 9, 7, 5, 2],
    });
  });

  it('compares categories, then kickers', () => {
    expect(compareHigh5(h('2d 2c 2h 3s 3d'), h('Ad Kd Qd Jd 9d'))).toBeGreaterThan(0); // full house > flush
    expect(compareHigh5(h('8d 8c Kh 5s 2d'), h('8h 8s Kd 5c 3d'))).toBeLessThan(0); // kicker 2 < 3
    expect(compareHigh5(h('8d 8c Kh 5s 2d'), h('8h 8s Kd 5c 2c'))).toBe(0); // identical strength
    expect(compareHigh5(h('Ad 2c 3h 4s 5d'), h('2d 3c 4h 5s 6d'))).toBeLessThan(0); // wheel < six-high straight
    expect(compareHigh5(h('Kd Kc 3h 3s 2d'), h('Qd Qc Jh Js Ad'))).toBeGreaterThan(0); // high pair of two pair decides
  });
});

describe('three-card top evaluation', () => {
  it('knows only high card, pair and trips', () => {
    expect(evaluateTop3(h('Qd Qc Qs'))).toEqual({ category: 'trips', ranks: [12] });
    expect(evaluateTop3(h('Qd Qc 2s'))).toEqual({ category: 'pair', ranks: [12, 2] });
    expect(evaluateTop3(h('Ad Kd Qd'))).toEqual({ category: 'high-card', ranks: [14, 13, 12] }); // no flush
    expect(evaluateTop3(h('5d 4c 3s'))).toEqual({ category: 'high-card', ranks: [5, 4, 3] }); // no straight
    expect(compareTop3(h('2d 2c 2s'), h('Ad Ac Ks'))).toBeGreaterThan(0);
    expect(compareTop3(h('Ad Ac 2s'), h('Ah As 3s'))).toBeLessThan(0);
  });

  it('compares a middle against a top for fouls, including kickers', () => {
    expect(compareMiddleVsTop(h('Kd Kc 5h 4s 2d'), h('Ad Ac 3s'))).toBeLessThan(0); // AA top > KK middle
    expect(compareMiddleVsTop(h('Ad Ac 5h 4s 2d'), h('Ah As Ks'))).toBeLessThan(0); // kicker K > 5
    expect(compareMiddleVsTop(h('Ad Ac Kh 4s 2d'), h('Ah As Ks'))).toBe(0); // equal so far: not a foul
    expect(compareMiddleVsTop(h('9d 8c 7h 6s 5d'), h('Ad Ac As'))).toBeGreaterThan(0); // straight > trips
    expect(compareMiddleVsTop(h('Ad Kc 9h 4s 2d'), h('2h 2s 3s'))).toBeLessThan(0); // pair beats ace high
  });
});

describe('2-7 lowball', () => {
  it('ranks 7-5-4-3-2 best and treats the ace as high', () => {
    expect(compareLow27(h('7d 5c 4h 3s 2d'), h('7d 6c 4h 3s 2d'))).toBeGreaterThan(0);
    expect(compareLow27(h('8d 5c 4h 3s 2d'), h('7d 6c 5h 4s 2d'))).toBeLessThan(0);
    expect(compareLow27(h('Ad 5c 4h 3s 2d'), h('Kd 9c 8h 7s 2d'))).toBeLessThan(0); // A-5 is ace high, not a straight, and loses to K-high
    expect(evaluateHigh5(h('Ad 5c 4h 3s 2d'), false).category).toBe('high-card');
    expect(compareLow27(h('6d 5c 4h 3s 2d'), h('Kd Qc Jh Ts 8d'))).toBeLessThan(0); // 6-high straight is bad
    expect(compareLow27(h('9d 7d 5d 3d 2d'), h('Kd Qc Jh Ts 8d'))).toBeLessThan(0); // flush is bad
    expect(compareLow27(h('2d 2c 4h 3s 5d'), h('Ad Kc Qh Js 9d'))).toBeLessThan(0); // pair is bad
    expect(compareLow27(h('7d 5c 4h 3s 2d'), h('7h 5s 4d 3c 2h'))).toBe(0);
  });

  it('qualifies ten-low or better', () => {
    expect(isQualifiedLow(h('Td 8c 5h 3s 2d'))).toBe(true);
    expect(isQualifiedLow(h('Jd 8c 5h 3s 2d'))).toBe(false);
    expect(isQualifiedLow(h('Td Tc 5h 3s 2d'))).toBe(false);
    expect(isQualifiedLow(h('6d 5c 4h 3s 2d'))).toBe(false);
    expect(isQualifiedLow(h('Td 8d 5d 3d 2d'))).toBe(false);
    expect(isQualifiedLow(h('Jd 8c 5h 3s 2d'), 11)).toBe(true);
    expect(isWheel27(h('7d 5c 4h 3s 2d'))).toBe(true);
    expect(isWheel27(h('7d 6c 4h 3s 2d'))).toBe(false);
  });

  it('describes hands for the UI', () => {
    expect(describeHand(h('3d 3c 3h 9s 9d'), 'high')).toBe('Full house, threes over nines');
    expect(describeHand(h('As Ks Qs Js Ts'), 'high')).toBe('Royal flush');
    expect(describeHand(h('6d 6c 2h'), 'top')).toBe('Pair of sixes');
    expect(describeHand(h('Kd 9c 2h'), 'top')).toBe('King high');
    expect(describeHand(h('9d 7c 5h 3s 2d'), 'low27')).toBe('Nine-low');
    expect(describeHand(h('7d 5c 4h 3s 2d'), 'low27')).toBe('Seven-five, number one');
    expect(describeHand(h('9d 9c 5h 3s 2d'), 'low27')).toBe('Pair of nines (no low)');
  });
});
