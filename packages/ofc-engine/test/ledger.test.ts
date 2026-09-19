import { describe, expect, it } from 'vitest';
import {
  applyAll,
  balances,
  command,
  isBust,
  settlementPlan,
  unsettledBalances,
} from '../src/index.js';
import type { TableState } from '../src/index.js';
import { playHand, rng, table } from './helpers.js';

function playUntilNonZero(t: TableState, seed = 1): TableState {
  let s = t;
  for (let i = 0; i < 20; i++) {
    s = playHand(s, rng(seed + i)).state;
    if (s.scores.some((x) => x !== 0)) return s;
  }
  throw new Error('every hand tied');
}

describe('scoring modes and ledger', () => {
  it('counting up: balances are the net points and sum to zero', () => {
    const s = playUntilNonZero(table({ seats: 3 }));
    expect(balances(s)).toEqual(s.scores);
    expect(unsettledBalances(s).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('buy-in: balances start at the buy-in and the table ends on a bust when configured', () => {
    const s = playUntilNonZero(
      table({ seats: 2, scoring: { mode: 'buyin', buyIn: 100, multiplier: 1 } }),
    );
    const b = balances(s);
    expect(b[0]! + b[1]!).toBe(200);
    expect(isBust(s)).toBe(false);
    const tiny = playUntilNonZero(
      table({ seats: 2, scoring: { mode: 'buyin', buyIn: 1, multiplier: 1, bustEnds: true } }),
    );
    expect(tiny.status).toBe('over');
    expect(tiny.hand!.phase).toBe('complete');
    expect(() => command(tiny, 0, { type: 'start' }, rng(1))).toThrow(/cannot start/);
    const noEnd = playUntilNonZero(
      table({ seats: 2, scoring: { mode: 'buyin', buyIn: 1, multiplier: 1 } }),
    );
    expect(noEnd.status).toBe('playing');
  });

  it('settlement plan pays creditors from debtors times the multiplier, and settling zeroes the balances', () => {
    let s = playUntilNonZero(table({ seats: 3, scoring: { mode: 'up', multiplier: 0.25 } }), 7);
    const before = unsettledBalances(s);
    const plan = settlementPlan(s);
    const paid = new Array<number>(3).fill(0);
    for (const t of plan) {
      expect(t.amount).toBeCloseTo(t.points * 0.25);
      expect(t.points).toBeGreaterThan(0);
      paid[t.from]! -= t.points;
      paid[t.to]! += t.points;
    }
    expect(paid).toEqual(before);
    s = applyAll(
      s,
      command(s, 0, { type: 'settle' }, rng(1), () => 12345),
    );
    const entry = s.ledger[s.ledger.length - 1]!;
    expect(entry.type).toBe('settlement');
    if (entry.type === 'settlement') {
      expect(entry.at).toBe(12345);
      expect(entry.multiplier).toBe(0.25);
      expect(entry.transfers).toEqual(plan);
    }
    expect(unsettledBalances(s)).toEqual([0, 0, 0]);
    expect(s.scores).toEqual(before); // lifetime scores untouched
    expect(settlementPlan(s)).toEqual([]);
    // play on: new balances accumulate from zero
    const later = playUntilNonZero(s, 30);
    expect(unsettledBalances(later)).not.toEqual([0, 0, 0]);
    expect(unsettledBalances(later)).toEqual(later.scores.map((v, i) => v - before[i]!));
  });

  it('adjustments change a seat balance and are logged', () => {
    let s = table({ seats: 2 });
    s = applyAll(
      s,
      command(s, 0, { type: 'adjust', seat: 1, points: -3, note: 'late fee' }, rng(1), () => 5),
    );
    expect(s.scores).toEqual([0, -3]);
    expect(unsettledBalances(s)).toEqual([0, -3]);
    expect(s.ledger).toEqual([{ type: 'adjust', at: 5, seat: 1, points: -3, note: 'late fee' }]);
    expect(() =>
      command(s, 0, { type: 'adjust', seat: 1, points: 0, note: '' }, rng(1)),
    ).not.toThrow();
    expect(() => applyAll(s, [{ type: 'adjust', at: 1, seat: 1, points: 0, note: '' }])).toThrow(
      /non-zero/,
    );
    expect(settlementPlan(s)).toEqual([]); // nobody to pay: one-sided adjustment
  });
});
