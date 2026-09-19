import { describe, expect, it } from 'vitest';
import { formatChips, parseChips } from './money';

const chips = { code: 'chips', name: 'Chips', decimals: 0 };
const usd = { code: 'USDC', name: 'USD Coin', decimals: 2 };

describe('club money', () => {
  it('formats minor units with decimals and signs', () => {
    expect(formatChips(1250, chips)).toBe('1,250 chips');
    expect(formatChips(-5, chips)).toBe('−5 chips');
    expect(formatChips(12550, usd)).toBe('125.50 USDC');
    expect(formatChips(5, usd, { sign: true })).toBe('+0.05 USDC');
  });
  it('parses typed amounts', () => {
    expect(parseChips('100', chips)).toBe(100);
    expect(parseChips('12.5', usd)).toBe(1250);
    expect(parseChips('12,5', usd)).toBe(1250);
    expect(parseChips('abc', chips)).toBeNull();
    expect(parseChips('-3', chips)).toBeNull();
  });
});
