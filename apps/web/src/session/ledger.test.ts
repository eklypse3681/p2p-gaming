import { describe, expect, it } from 'vitest';
import type { LedgerLine } from './ledger';
import {
  buildLedger,
  formatMoney,
  formatPoints,
  ledgerCsv,
  planFromBalances,
  unsettledFromLines,
} from './ledger';

const hand = (label: string, deltas: number[]): LedgerLine => ({
  kind: 'hand',
  label,
  at: null,
  deltas,
});

describe('ledger model', () => {
  it('sums lines since the last settlement', () => {
    const lines: LedgerLine[] = [
      hand('Hand 1', [6, -6, 0]),
      hand('Hand 2', [-2, -2, 4]),
      { kind: 'settlement', label: 'Settled', at: 1, deltas: [-4, 8, -4] },
      hand('Hand 3', [1, 0, -1]),
    ];
    expect(unsettledFromLines(lines, 3)).toEqual([1, 0, -1]);
    expect(unsettledFromLines(lines.slice(0, 2), 3)).toEqual([4, -8, 4]);
  });

  it('plans minimal transfers and prices them with the multiplier', () => {
    expect(planFromBalances([4, -8, 4], 0.5)).toEqual([
      { from: 1, to: 0, points: 4, amount: 2 },
      { from: 1, to: 2, points: 4, amount: 2 },
    ]);
    expect(planFromBalances([0, 0], 1)).toEqual([]);
  });

  it('builds balances from a baseline (buy-in) and formats money and points', () => {
    const m = buildLedger({
      seats: 2,
      names: ['A', 'B'],
      multiplier: 0.25,
      baseline: 100,
      lines: [hand('Hand 1', [6, -6])],
    });
    expect(m.balances).toEqual([106, 94]);
    expect(m.plan).toEqual([{ from: 1, to: 0, points: 6, amount: 1.5 }]);
    expect(formatMoney(1.5)).toBe('$1.50');
    expect(formatMoney(-0.5)).toBe('−$0.50');
    expect(formatPoints(3)).toBe('+3');
    expect(formatPoints(-3)).toBe('−3');
    expect(formatPoints(0)).toBe('0');
  });

  it('exports CSV with a header, one row per line and a totals row', () => {
    const m = buildLedger({
      seats: 2,
      names: ['Al, Jr', 'B'],
      multiplier: 2,
      lines: [
        hand('Hand 1', [3, -3]),
        { kind: 'adjust', label: 'Adjustment', at: 5, deltas: [-1, 0], note: 'oops' },
      ],
    });
    const csv = ledgerCsv(m);
    const rows = csv.split('\n');
    expect(rows[0]).toBe(
      'line,kind,at,"Al, Jr (points)",B (points),"Al, Jr (amount)",B (amount),note',
    );
    expect(rows[1]).toBe('Hand 1,hand,,3,-3,6.00,-6.00,');
    expect(rows[2]).toContain('Adjustment,adjust,1970-01-01T00:00:00.005Z,-1,0,-2.00,0.00,oops');
    expect(rows[3]).toBe('Balance,,,2,-3,4.00,-6.00,multiplier 2');
  });
});
