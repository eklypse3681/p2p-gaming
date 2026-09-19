import { describe, expect, it } from 'vitest';
import { defaultConfig, handSummary, scoreHand } from '../src/index.js';
import { rows } from './helpers.js';

const cfg = defaultConfig({ variant: 'pineapple', seats: 2 });
const cfg3 = defaultConfig({ variant: 'pineapple', seats: 3 });

// A: top pair of 6s (+1), middle trips (+2), bottom flush (+4)
const A = rows('6d 6c 2s', '7d 7c 7h Ks 3d', 'Ad 9d 5d 4d 2d');
// B: top king high, middle two pair, bottom straight (+2)
const B = rows('Kd 9c 2h', 'Jd Jc 4h 4s Ad', 'Ts 9d 8c 7h 6s');
// C: fouled (top beats middle)
const C = rows('Ad Ac 3s', 'Kd Kc 5h 4s 2d', '9d 8c 7h 6s 5d');
// D: no royalties; beats B's top (ace high) but loses middle and bottom
const D = rows('Ah 9s 2c', 'Td Tc 5h 3s 2d', 'Qd Qc 3h 4h 8d');

describe('1-6 scoring', () => {
  it('scores rows, scoop and royalties pairwise', () => {
    const r = scoreHand(1, [A, B], [false, false], cfg);
    const p = r.pairs[0]!;
    expect(p.rows).toEqual({ top: 1, middle: 1, bottom: 1 });
    expect(p.scoop).toBe(3);
    expect(r.seats[0]!.royalties).toBe(7);
    expect(r.seats[1]!.royalties).toBe(2);
    expect(p.royalties).toBe(5);
    expect(p.net).toBe(3 + 3 + 5);
    expect(r.seats[0]!.points).toBe(11);
    expect(r.seats[1]!.points).toBe(-11);
    expect(r.transfers).toEqual([{ from: 1, to: 0, points: 11 }]);
  });

  it('no scoop when rows split; ties score nothing', () => {
    const r = scoreHand(1, [B, D], [false, false], cfg);
    const p = r.pairs[0]!;
    expect(p.rows).toEqual({ top: -1, middle: 1, bottom: 1 });
    expect(p.scoop).toBe(0);
    expect(p.net).toBe(1 + 2); // 2 rows - 1 row + bottom straight royalty 2
    const tie = scoreHand(1, [B, { ...B, top: rows('Kh 9s 2c', '', '').top }], [false, false], cfg);
    expect(tie.pairs[0]!.net).toBe(0);
    expect(tie.transfers).toEqual([]);
  });

  it('a fouled hand loses six plus the opponent royalties and earns none', () => {
    const r = scoreHand(1, [A, C], [false, false], cfg);
    expect(r.seats[1]!.fouled).toBe(true);
    expect(r.seats[1]!.royalties).toBe(0);
    expect(r.pairs[0]!.net).toBe(6 + 7);
    expect(r.pairs[0]!.rows).toEqual({ top: 1, middle: 1, bottom: 1 });
    const r2 = scoreHand(1, [C, B], [false, false], cfg);
    expect(r2.pairs[0]!.net).toBe(-(6 + 2));
  });

  it('two fouled hands exchange nothing', () => {
    const r = scoreHand(1, [C, C], [false, false], cfg);
    expect(r.pairs[0]!.net).toBe(0);
    expect(r.transfers).toEqual([]);
  });

  it('three players settle every pair and sum to zero', () => {
    const r = scoreHand(1, [A, B, C], [false, false, false], cfg3);
    expect(r.pairs).toHaveLength(3);
    const ab = r.pairs.find((p) => p.a === 0 && p.b === 1)!;
    const ac = r.pairs.find((p) => p.a === 0 && p.b === 2)!;
    const bc = r.pairs.find((p) => p.a === 1 && p.b === 2)!;
    expect(ab.net).toBe(11);
    expect(ac.net).toBe(13);
    expect(bc.net).toBe(8); // B scoops the fouled C (+6) and collects its straight (+2)
    expect(r.seats.map((s) => s.points)).toEqual([24, -3, -21]);
    expect(r.seats.reduce((s, x) => s + x.points, 0)).toBe(0);
    expect(r.transfers).toEqual([
      { from: 1, to: 0, points: 11 },
      { from: 2, to: 0, points: 13 },
      { from: 2, to: 1, points: 8 },
    ]);
  });

  it('summarises a hand in words', () => {
    const r = scoreHand(4, [A, C], [false, false], cfg);
    const lines = handSummary(r, ['Alice', 'Bob']);
    expect(lines[0]).toBe(
      'Alice: top pair of sixes +1, middle three sevens +2, bottom flush, ace high +4, scoop; wins 13 from Bob',
    );
    expect(lines[1]).toBe('Bob: fouled');
  });
});
