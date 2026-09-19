import { describe, expect, it } from 'vitest';
import { formatReport, parseArgs, runSoak } from '../src/index.js';

describe('runSoak (inline dealer over the memory transport)', () => {
  for (const variant of ['ofc', 'pineapple', 'pineapple27'] as const) {
    it(`plays 30 hands of ${variant} with three bots and every invariant holds`, async () => {
      const report = await runSoak({ game: 'ofc', variant, seats: 3, hands: 30, seed: 42 });
      expect(report.completed).toBe(30);
      expect(report.ok, formatReport(report)).toBe(true);
      expect(report.zeroSum).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.perSeat).toHaveLength(3);
    }, 60_000);
  }

  it('plays two-player pineapple and reports per-seat statistics', async () => {
    const report = await runSoak({
      game: 'ofc',
      variant: 'pineapple',
      seats: 2,
      hands: 10,
      seed: 1,
    });
    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.perSeat.map((s) => s.name)).toEqual(['Ada', 'Bob']);
    expect(report.perSeat.reduce((a, s) => a + s.commands, 0)).toBeGreaterThan(0);
  });

  it('plays 5 games of money-play backgammon with two bots', async () => {
    const report = await runSoak({ game: 'backgammon', games: 5, seed: 3 });
    expect(report.completed).toBe(5);
    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.backgammon?.games).toBe(5);
    expect(report.errors).toEqual([]);
  });

  it('renders a readable table', async () => {
    const report = await runSoak({ game: 'ofc', variant: 'ofc', seats: 2, hands: 3, seed: 8 });
    const text = formatReport(report);
    expect(text).toContain('3/3 hands');
    expect(text).toContain('✓ every hand is zero-sum');
  });
});

describe('parseArgs', () => {
  it('parses a typical OFC invocation', () => {
    const p = parseArgs([
      '--game',
      'ofc',
      '--variant',
      'pineapple27',
      '--seats',
      '3',
      '--hands',
      '200',
      '--json',
    ]);
    expect(p.options).toMatchObject({ game: 'ofc', variant: 'pineapple27', seats: 3, hands: 200 });
    expect(p.json).toBe(true);
  });

  it('rejects bad values', () => {
    expect(() => parseArgs(['--game', 'chess'])).toThrow(/ofc or backgammon/);
    expect(() => parseArgs(['--game', 'ofc', '--hands', '-1'])).toThrow(/positive/);
    expect(() => parseArgs(['--game', 'ofc', '--dealer', 'runtime'])).toThrow(/--code/);
    expect(() => parseArgs(['--game', 'backgammon', '--seats', '3'])).toThrow(/two seats/);
  });
});
