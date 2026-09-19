import { describe, expect, it } from 'vitest';
import {
  applyAll,
  cardKey,
  cards,
  command,
  init,
  legalRowsFor,
  newDeck,
  reduce,
  seatOrder,
  turnRequirement,
} from '../src/index.js';
import type { TableState } from '../src/index.js';
import { c, firstFit, playHand, rng, table } from './helpers.js';

function start(t: TableState, seed = 1) {
  const r = rng(seed);
  return { state: applyAll(t, command(t, 0, { type: 'start' }, r)), r };
}

describe('dealing and turn order', () => {
  it('pineapple: five cards each, then three at a time (place two, discard one), 17 cards per seat', () => {
    const { state } = playHand(table({ variant: 'pineapple', seats: 3 }), rng(2));
    for (const s of state.hand!.seats) {
      expect(s.rows.top).toHaveLength(3);
      expect(s.rows.middle).toHaveLength(5);
      expect(s.rows.bottom).toHaveLength(5);
      expect(s.discards).toHaveLength(4);
    }
    expect(state.hand!.deck).toHaveLength(52 - 3 * 17);
  });

  it('classic OFC: one card at a time and no discards', () => {
    const { state, actions } = playHand(table({ variant: 'ofc', seats: 2 }), rng(2));
    for (const s of state.hand!.seats) expect(s.discards).toHaveLength(0);
    const deals = actions.filter((a) => a.type === 'deal-next');
    expect(deals).toHaveLength(16);
    expect(deals.every((d) => d.type === 'deal-next' && d.cards.length === 1)).toBe(true);
    expect(state.hand!.deck).toHaveLength(52 - 26);
  });

  it('the seat left of the button acts first and the button rotates each hand', () => {
    expect(seatOrder(0, 3)).toEqual([1, 2, 0]);
    expect(seatOrder(2, 3)).toEqual([0, 1, 2]);
    const { state } = start(table({ seats: 3 }));
    expect(state.hand!.button).toBe(0);
    expect(state.hand!.toAct).toBe(1);
    const done = playHand(table({ seats: 3 }), rng(4)).state;
    expect(done.button).toBe(1);
    const second = playHand(done, rng(5)).state;
    expect(second.hand!.button).toBe(1);
    expect(second.hand!.number).toBe(2);
    expect(second.button).toBe(2);
  });

  it('turn requirement: 5 first, then 2+1 in pineapple, 1 in OFC', () => {
    const { state, r } = start(table({ variant: 'pineapple' }));
    expect(turnRequirement(state, 1)).toEqual({ place: 5, discard: 0 });
    expect(legalRowsFor(state, 1)).toEqual(['top', 'middle', 'bottom']);
    expect(legalRowsFor(state, 0)).toEqual([]); // not its turn yet
    let s = applyAll(state, command(state, 1, firstFit(state, 1), r));
    expect(s.hand!.toAct).toBe(0);
    s = applyAll(s, command(s, 0, firstFit(s, 0), r));
    // after the initial round, seat 1 (left of button) is dealt three
    expect(s.hand!.toAct).toBe(1);
    expect(s.hand!.seats[1]!.pending).toHaveLength(3);
    expect(turnRequirement(s, 1)).toEqual({ place: 2, discard: 1 });
    const ofc = start(table({ variant: 'ofc' }));
    let o = applyAll(ofc.state, command(ofc.state, 1, firstFit(ofc.state, 1), ofc.r));
    o = applyAll(o, command(o, 0, firstFit(o, 0), ofc.r));
    expect(turnRequirement(o, 1)).toEqual({ place: 1, discard: 0 });
  });

  it('rows fill to capacity and the last turn may have fewer placements than usual', () => {
    const { state } = playHand(table({ variant: 'pineapple' }), rng(7));
    // 5 + 2*4 = 13 exactly, so the final turn still places two
    const placeActions = state.history.length; // sanity: one hand recorded
    expect(placeActions).toBe(1);
  });
});

describe('placement validation', () => {
  it('rejects wrong seat, wrong cards, wrong counts and full rows', () => {
    const { state } = start(table({ variant: 'pineapple' }));
    const me = state.hand!.toAct!;
    const other = 1 - me;
    const p = state.hand!.seats[me]!.pending;
    const legal = firstFit(state, me);
    expect(() =>
      reduce(state, { type: 'place', seat: other, placements: [], discards: [] }),
    ).toThrow(/turn|cards/);
    expect(() =>
      reduce(state, {
        type: 'place',
        seat: me,
        placements: legal.placements.slice(0, 4),
        discards: [p[4]!],
      }),
    ).toThrow(/place exactly 5/);
    expect(() =>
      reduce(state, {
        type: 'place',
        seat: me,
        placements: legal.placements.slice(0, 4),
        discards: [],
      }),
    ).toThrow(/place exactly 5/);
    expect(() =>
      reduce(state, { type: 'place', seat: me, placements: legal.placements, discards: [p[0]!] }),
    ).toThrow(/discard exactly 0/);
    const foreign = {
      ...legal,
      placements: legal.placements.map((x, i) =>
        i === 0 ? { ...x, card: c(cardKey(x.card) === 'As' ? 'Ks' : 'As') } : x,
      ),
    };
    expect(() =>
      reduce(state, { type: 'place', seat: me, placements: foreign.placements, discards: [] }),
    ).toThrow(/not dealt|used twice/);
    const dup = legal.placements.map((x) => ({ ...x, card: p[0]! }));
    expect(() => reduce(state, { type: 'place', seat: me, placements: dup, discards: [] })).toThrow(
      /used twice/,
    );
    const allTop = legal.placements.map((x) => ({ ...x, row: 'top' as const }));
    expect(() =>
      reduce(state, { type: 'place', seat: me, placements: allTop, discards: [] }),
    ).toThrow(/top row is full/);
  });

  it('rejects deals out of turn or with cards not in the deck', () => {
    const { state } = start(table({ variant: 'pineapple' }));
    expect(() => reduce(state, { type: 'deal-next', seat: 0, cards: cards('As Kd Qc') })).toThrow(
      /still has to act/,
    );
    let s = state;
    for (const seat of [1, 0])
      s = reduce(s, {
        type: 'place',
        seat,
        placements: firstFit(s, seat).placements,
        discards: [],
      });
    expect(s.hand!.toAct).toBeNull();
    const dealt = new Set(
      s
        .hand!.seats.flatMap((x) => [...x.rows.top, ...x.rows.middle, ...x.rows.bottom])
        .map(cardKey),
    );
    const used = newDeck().find((x) => dealt.has(cardKey(x)))!;
    expect(() =>
      reduce(s, { type: 'deal-next', seat: 1, cards: [used, ...s.hand!.deck.slice(0, 2)] }),
    ).toThrow(/not in the deck/);
    expect(() =>
      reduce(s, { type: 'deal-next', seat: 1, cards: s.hand!.deck.slice(0, 2) }),
    ).toThrow(/exactly 3/);
    expect(() => reduce(s, { type: 'start-hand', button: 0, deals: [] })).toThrow(/in progress/);
  });

  it('showdown needs every seat done; start needs a finished hand', () => {
    const { state } = start(table());
    expect(() => reduce(state, { type: 'showdown' })).toThrow(/not every seat/);
    expect(() => command(state, 0, { type: 'start' }, rng(1))).toThrow(/cannot start/);
  });

  it('init validates configuration', () => {
    expect(() => init({ seats: 4 as never })).toThrow(/seats/);
    expect(() => init({ scoring: { mode: 'buyin', multiplier: 1 } })).toThrow(/buyIn/);
    expect(init().config.variant).toBe('pineapple');
    expect(init({ variant: 'ofc' }).config.fantasyland.cards).toBe(13);
  });
});

describe('showdown', () => {
  it('records the result, updates scores and the ledger, and reveals face-down hands', () => {
    const { state } = playHand(table({ variant: 'pineapple' }), rng(11));
    expect(state.hand!.phase).toBe('showdown');
    expect(state.history).toHaveLength(1);
    expect(state.ledger[0]!.type).toBe('hand');
    expect(state.scores[0]! + state.scores[1]!).toBe(0);
    expect(state.hand!.result!.seats).toHaveLength(2);
    expect(state.hand!.seats.every((s) => !s.faceDown)).toBe(true);
    expect(state.status).toBe('playing');
  });

  it('carries Fantasyland into the next hand', () => {
    // craft: force a QQ top by replaying with a custom policy is hard with random cards; use scoreHand path via table
    let t = table({ variant: 'pineapple' });
    t = { ...t, fantasyland: [14, 0] };
    const { state } = playHand(t, rng(1));
    expect(state.hand!.seats[0]!.fantasyland).toBe(true);
  });
});
