import { describe, expect, it } from 'vitest';
import {
  cardKey,
  cardToString,
  cards,
  cryptoRng,
  hasDuplicates,
  isCard,
  newDeck,
  parseCard,
  removeCards,
  seededRng,
} from '../src/index.js';

describe('cards', () => {
  it('builds a 52-card deck without duplicates', () => {
    const d = newDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map(cardKey)).size).toBe(52);
    expect(hasDuplicates(d)).toBe(false);
  });

  it('round-trips the compact string form', () => {
    for (const s of ['As', 'Td', '2c', 'Kh', '9s']) expect(cardToString(parseCard(s))).toBe(s);
    expect(parseCard('as')).toEqual({ rank: 14, suit: 's' });
    expect(() => parseCard('1s')).toThrow();
    expect(() => parseCard('Ax')).toThrow();
    expect(cards(' As  Kd ')).toEqual([parseCard('As'), parseCard('Kd')]);
  });

  it('validates card shapes', () => {
    expect(isCard({ rank: 14, suit: 's' })).toBe(true);
    expect(isCard({ rank: 15, suit: 's' })).toBe(false);
    expect(isCard({ rank: 2, suit: 'x' })).toBe(false);
    expect(isCard('As')).toBe(false);
  });

  it('removes cards by identity', () => {
    const rest = removeCards(newDeck(), cards('As Kd'));
    expect(rest).toHaveLength(50);
    expect(rest.some((x) => cardKey(x) === 'As')).toBe(false);
  });
});

describe('rng', () => {
  it('seeded rng is deterministic and shuffles into a permutation', () => {
    const a = seededRng(42).shuffle(newDeck());
    const b = seededRng(42).shuffle(newDeck());
    expect(a.map(cardKey)).toEqual(b.map(cardKey));
    expect(new Set(a.map(cardKey)).size).toBe(52);
    expect(a.map(cardKey)).not.toEqual(newDeck().map(cardKey));
    expect(seededRng(1).shuffle(newDeck()).map(cardKey)).not.toEqual(a.map(cardKey));
  });

  it('crypto rng stays in range', () => {
    const r = cryptoRng();
    for (let i = 0; i < 200; i++) {
      const v = r.int(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(r.int(1)).toBe(0);
    expect(() => r.int(0)).toThrow();
  });
});
