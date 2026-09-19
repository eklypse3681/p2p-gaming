import { describe, expect, it } from 'vitest';
import { cardKey, newDeck, replay } from '../src/index.js';
import type { TableState, Variant } from '../src/index.js';
import { playHand, randomFit, rng, table } from './helpers.js';

function conservation(s: TableState): void {
  const hand = s.hand!;
  const all = [
    ...hand.deck,
    ...hand.seats.flatMap((x) => [
      ...x.rows.top,
      ...x.rows.middle,
      ...x.rows.bottom,
      ...x.pending,
      ...x.discards,
    ]),
  ];
  expect(all).toHaveLength(52);
  expect(new Set(all.map(cardKey)).size).toBe(52);
  expect(new Set(all.map(cardKey))).toEqual(new Set(newDeck().map(cardKey)));
}

describe('replay and properties', () => {
  it('a table rebuilt from its action log equals the live one', () => {
    const t = table({ variant: 'pineapple', seats: 3 });
    const r1 = rng(21);
    const log = playHand(t, r1, (st, seat) => randomFit(st, seat, r1));
    const r2 = rng(22);
    const second = playHand(log.state, r2, (st, seat) => randomFit(st, seat, r2), log.actions);
    const rebuilt = replay(t.config, second.actions);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(second.state));
  });

  const variants: Variant[] = ['ofc', 'pineapple', 'pineapple27'];
  for (const variant of variants) {
    for (const seats of [2, 3] as const) {
      it(`random play-outs keep every card accounted for and scores zero-sum (${variant}, ${seats} seats)`, () => {
        let s = table({ variant, seats });
        for (let hand = 0; hand < 6; hand++) {
          const r = rng(1000 + hand * 7 + seats);
          s = playHand(s, r, (st, seat) => randomFit(st, seat, r)).state;
          conservation(s);
          expect(s.scores.reduce((a, b) => a + b, 0)).toBe(0);
          expect(s.hand!.result!.seats.every((x) => x.rows.top.cards.length === 3)).toBe(true);
          // Fantasyland owed next hand is consistent with the result
          expect(s.fantasyland).toEqual(s.hand!.result!.seats.map((x) => x.fantasylandNext));
        }
      });
    }
  }
});
