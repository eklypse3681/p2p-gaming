import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { DEALER_SEAT, createMemoryPair } from '@bgf/protocol';
import { TableClient, TableServer, verifySegment, segmentRngFor } from '@bgf/table';
import type { Action, Card, TableConfig, TableState, TableView } from '../src/index.js';
import { newDeck, ofcDefinition, cardKey } from '../src/index.js';
import { firstFit } from './helpers.js';

type Client = TableClient<TableState, Action, TableConfig, TableView>;
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const P = (id: string): PlayerProfile => ({ id, name: id.toUpperCase() });

async function dealerTable(
  config: Partial<TableConfig>,
  opts: { seeded?: boolean; autopilot?: boolean } = {},
) {
  // These tests drive the dealer by hand; unattended play has its own suite below.
  const server = await TableServer.create({
    def: ofcDefinition,
    code: 'DLR1',
    host: P('dealer'),
    hostSeat: null,
    seats: 3,
    config,
    options: {
      autopilot: opts.autopilot ?? false,
      ...(opts.seeded ? { randomness: { mode: 'seeded' } } : {}),
    },
    now: () => 500,
    matchId: 'ofc-dealer',
  });
  const dealer: Client = new TableClient({
    transport: server.connectLocal(),
    profile: P('dealer'),
    pingIntervalMs: 0,
  });
  const seats: Client[] = [];
  for (const id of ['a', 'b', 'c']) {
    const [serverEnd, clientEnd] = createMemoryPair('ofc');
    server.accept(serverEnd);
    seats.push(new TableClient({ transport: clientEnd, profile: P(id), pingIntervalMs: 0 }));
  }
  await flush();
  return { server, dealer, seats };
}

/** Everyone sets their cards in turn until the showdown. Placements come from the full state. */
async function playHand(
  server: Awaited<ReturnType<typeof dealerTable>>['server'],
  seats: Client[],
) {
  for (let guard = 0; guard < 80; guard++) {
    const state = server.getSnapshot().state;
    const hand = state.hand!;
    if (hand.phase !== 'setting') return;
    const fl = hand.seats.findIndex((s) => s.fantasyland && !s.done && s.pending.length > 0);
    const seat = hand.toAct ?? (fl >= 0 ? fl : null);
    if (seat === null) throw new Error('nobody to act');
    seats[seat]!.send(firstFit(state, seat));
    await flush();
  }
  throw new Error('hand did not finish');
}

describe('OFC with a non-playing dealer', () => {
  it('the dealer starts hands and settles; it never places cards; seats play a full hand', async () => {
    const { server, dealer, seats } = await dealerTable({ variant: 'pineapple' });
    expect(server.dealerMode).toBe(true);
    expect(dealer.getState()).toMatchObject({ role: 'dealer', seat: null, status: 'joined' });
    expect(seats.map((s) => s.getState().seat)).toEqual([0, 1, 2]);
    expect(server.getSnapshot().state.config.seats).toBe(3);

    dealer.send({ type: 'start' });
    await flush();
    expect(server.getSnapshot().actions[0]).toMatchObject({ type: 'start-hand' });
    expect(dealer.getState().lastAction).toMatchObject({ by: DEALER_SEAT });
    // The dealer holds the deck; every seat sees only its own cards.
    const full = dealer.getState().snapshot!.state as unknown as TableState;
    expect(full.hand!.deck.length).toBe(52 - 15);
    const v1 = seats[1]!.getState().snapshot!.state as unknown as TableView;
    expect(v1.hand!.seats[1]!.pending).toHaveLength(5);
    expect(v1.hand!.seats[0]!.pending).toEqual([]);
    expect(JSON.stringify(seats[1]!.getState().snapshot)).not.toContain('"deck"');

    // The dealer may not place, even with a legal-looking command.
    dealer.send(firstFit(full, full.hand!.toAct!));
    await flush();
    expect(dealer.getState().error).toMatchObject({ code: 'not-seated' });
    expect(server.getSnapshot().actions).toHaveLength(1);

    await playHand(server, seats);
    const after = server.getSnapshot().state;
    expect(after.hand!.phase).toBe('showdown');
    expect(after.scores.reduce((a, b) => a + b, 0)).toBe(0);
    // Card conservation: 13 set per seat + discards + deck = 52.
    const set = after.hand!.seats.reduce(
      (n, s) =>
        n + s.rows.top.length + s.rows.middle.length + s.rows.bottom.length + s.discards.length,
      0,
    );
    expect(set + after.hand!.deck.length).toBe(52);
    expect(new Set(newDeck().map(cardKey)).size).toBe(52);

    dealer.send({ type: 'adjust', seat: 0, points: 2, note: 'tip' });
    dealer.send({ type: 'settle' });
    await flush();
    const ledger = server.getSnapshot().state.ledger;
    expect(ledger.map((e) => e.type)).toEqual(['hand', 'adjust', 'settlement']);
    // Seats cannot settle for the table? They can (any seat may), but a seat cannot start twice:
    seats[0]!.send({ type: 'start' });
    await flush();
    expect(server.getSnapshot().actions.at(-1)).toMatchObject({ type: 'start-hand' });
    server.close();
  });

  it('seeded: each hand commits a seed on start and reveals it at showdown; the deal re-derives', async () => {
    const { server, dealer, seats } = await dealerTable({ variant: 'ofc' }, { seeded: true });
    expect(server.getSnapshot().options.randomness).toEqual({ mode: 'seeded', provider: 'crypto' });
    dealer.send({ type: 'start' });
    await flush();
    let snap = server.getSnapshot();
    const segment = snap.entropyAudit!.segments!.at(-1)!;
    expect(segment.seed).toBeUndefined();
    expect(snap.actionMeta![0]!.entropy).toMatchObject({
      label: 'start',
      segment: segment.index,
      drawIndex: 0,
    });
    // Guests hold the commitment but not the seed while the hand is on.
    expect(seats[2]!.getState().snapshot!.entropyAudit!.segments!.at(-1)!.seed).toBeUndefined();

    await playHand(server, seats);
    snap = server.getSnapshot();
    const revealed = snap.entropyAudit!.segments!.find((s) => s.index === segment.index)!;
    expect(revealed.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySegment(snap, segment.index).ok).toBe(true);
    expect(verifySegment(seats[0]!.getState().snapshot!, segment.index).ok).toBe(true);

    // Re-derive the opening deal from the revealed seed exactly as the engine drew it: it draws
    // five cards per seat from a fresh deck by index.
    const rng = segmentRngFor(snap, 0)!;
    const dealt = snap.actions[0] as Extract<Action, { type: 'start-hand' }>;
    let deck: Card[] = newDeck();
    for (const d of dealt.deals) {
      const cards: Card[] = [];
      for (let i = 0; i < d.cards.length; i++) {
        const idx = rng.int(deck.length);
        cards.push(deck[idx]!);
        deck = deck.filter((_, j) => j !== idx);
      }
      expect(cards.map(cardKey)).toEqual(d.cards.map(cardKey));
    }
    server.close();
  });
});

describe('OFC unattended (autopilot on for the dealer)', () => {
  it('deals when the seats fill, deals again when everyone is ready, settles on consensus', async () => {
    const { server, dealer, seats } = await dealerTable(
      { variant: 'pineapple', scoring: { mode: 'up', multiplier: 2 } },
      { autopilot: true },
    );
    // Three guests sat down during set-up: the first hand was dealt without the dealer doing a thing.
    let state = server.getSnapshot().state;
    expect(state.handNumber).toBe(1);
    expect(state.hand!.phase).toBe('setting');
    expect(server.getSnapshot().actions[0]).toMatchObject({ type: 'start-hand' });
    expect(dealer.getState().lastAction?.by).toBe(DEALER_SEAT);

    await playHand(server, seats);
    state = server.getSnapshot().state;
    expect(state.hand!.phase).toBe('showdown');
    expect(server.autopilotStatus()).toEqual({ enabled: true });

    // Two of three ready: nothing; the third: next hand, readiness spent.
    seats[0]!.setReady(true);
    seats[1]!.setReady(true);
    await flush();
    expect(server.getSnapshot().state.handNumber).toBe(1);
    expect(seats[2]!.getState().ready).toEqual([true, true, false]);
    seats[2]!.setReady(true);
    await flush();
    state = server.getSnapshot().state;
    expect(state.handNumber).toBe(2);
    expect(state.hand!.phase).toBe('setting');
    expect(server.readiness()).toEqual([false, false, false]);

    // Settle requests are refused mid-hand and honoured between hands once everyone asks.
    seats[0]!.send({ type: 'settle-request' });
    await flush();
    expect(seats[0]!.getState().error?.code).toBe('hand-in-progress');
    await playHand(server, seats);
    seats[0]!.send({ type: 'settle-request' });
    seats[1]!.send({ type: 'settle-request', requested: true });
    await flush();
    expect(server.getSnapshot().state.settleRequests).toEqual([true, true, false]);
    expect(server.getSnapshot().state.ledger.some((e) => e.type === 'settlement')).toBe(false);
    seats[2]!.send({ type: 'settle-request' });
    await flush();
    state = server.getSnapshot().state;
    const settlement = state.ledger.filter((e) => e.type === 'settlement');
    expect(settlement).toHaveLength(1);
    expect(state.settleRequests).toEqual([false, false, false]);
    expect(seats[1]!.getState().snapshot!.state.settleRequests).toEqual([false, false, false]);
    server.close();
  });

  it('countdown mode deals the next hand by itself and pauses while a player is away', async () => {
    const { server, seats } = await dealerTable(
      { variant: 'pineapple', flow: { nextHand: 'countdown', nextHandDelayMs: 50 } as never },
      { autopilot: true },
    );
    await playHand(server, seats);
    expect(server.autopilotStatus().pending?.reason).toMatch(/next hand/);
    // Seat 2 leaves: the clock stops; back again: it restarts and the hand deals.
    seats[2]!.close();
    await flush();
    expect(server.autopilotStatus().pending).toBeUndefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(server.getSnapshot().state.handNumber).toBe(1);
    const [serverEnd, clientEnd] = createMemoryPair('ofc');
    server.accept(serverEnd);
    const back = new TableClient({ transport: clientEnd, profile: P('c'), pingIntervalMs: 0 });
    await flush();
    expect(back.getState().autopilot?.reason).toMatch(/next hand/);
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(server.getSnapshot().state.handNumber).toBe(2);
    server.close();
  });
});
