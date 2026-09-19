import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { createMemoryPair } from '@bgf/protocol';
import { TableClient, TableServer, seededRng, verifySnapshot } from '@bgf/table';
import type {
  Action,
  Card,
  Command,
  Placement,
  Row,
  TableConfig,
  TableState,
} from '../src/index.js';
import {
  ROW_CAPACITY,
  ROWS,
  cardKey,
  ofcDefinition,
  redactOfcAction,
  turnRequirement,
  validateOfcCommand,
} from '../src/index.js';
import type { TableView } from '../src/index.js';

type Client = TableClient<TableState, Action, TableConfig, TableView>;

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const P = (id: string): PlayerProfile => ({ id, name: id.toUpperCase() });

function makeTable(config: Partial<TableConfig>, seats: number) {
  const server = new TableServer({
    def: ofcDefinition,
    code: 'OFC1',
    host: P('a'),
    seats,
    config,
    rng: seededRng(42),
    now: () => 1000,
  });
  const clients: Client[] = [
    new TableClient({ transport: server.connectLocal(), profile: P('a'), pingIntervalMs: 0 }),
  ];
  for (const id of ['b', 'c'].slice(0, seats - 1)) {
    const [serverEnd, clientEnd] = createMemoryPair('ofc');
    server.accept(serverEnd);
    clients.push(new TableClient({ transport: clientEnd, profile: P(id), pingIntervalMs: 0 }));
  }
  return { server, clients };
}

/** Naive but legal placement: fill bottom, then middle, then top; discard the rest. */
function naivePlace(state: TableState, seat: number): Command {
  const req = turnRequirement(state, seat);
  const s = state.hand!.seats[seat]!;
  const pending = s.pending.slice();
  const counts: Record<Row, number> = {
    top: s.rows.top.length,
    middle: s.rows.middle.length,
    bottom: s.rows.bottom.length,
  };
  const placements: Placement[] = [];
  const order: Row[] = ['bottom', 'middle', 'top'];
  for (const card of pending) {
    if (placements.length === req.place) break;
    const row = order.find((r) => counts[r] < ROW_CAPACITY[r])!;
    counts[row]++;
    placements.push({ card, row });
  }
  const used = new Set(placements.map((p) => cardKey(p.card)));
  const discards: Card[] = pending.filter((c) => !used.has(cardKey(c)));
  return { type: 'place', placements, discards };
}

async function playOut(server: ReturnType<typeof makeTable>['server'], clients: Client[]) {
  for (let guard = 0; guard < 80; guard++) {
    const state = server.getSnapshot().state;
    const hand = state.hand!;
    if (hand.phase !== 'setting') return;
    const fl = hand.seats.findIndex((s) => s.fantasyland && !s.done && s.pending.length > 0);
    const seat = hand.toAct ?? (fl >= 0 ? fl : null);
    if (seat === null) throw new Error('nobody to act');
    clients[seat]!.send(naivePlace(state, seat));
    await flush();
  }
  throw new Error('hand did not finish');
}

describe('ofcDefinition on the table core', () => {
  it('deals a three-seat pineapple hand, hides the deck and others cards from guests, and replays', async () => {
    const { server, clients } = makeTable({ variant: 'pineapple' }, 3);
    await flush();
    expect(clients.map((c) => c.getState().seat)).toEqual([0, 1, 2]);
    clients[1]!.send({ type: 'start' });
    await flush();

    const host = clients[0]!.getState().snapshot!;
    const guest = clients[1]!.getState().snapshot!;
    expect(host.view).toBeUndefined();
    expect((host.state as unknown as TableState).hand!.deck.length).toBe(52 - 15);
    expect(guest.view).toBe(true);
    const gv = guest.state as unknown as TableView;
    expect(gv.viewer).toBe(1);
    expect(gv.hand!.deckCount).toBe(37);
    expect(gv.hand!.seats[1]!.pending).toHaveLength(5);
    expect(gv.hand!.seats[0]!.pending).toEqual([]);
    expect(gv.hand!.seats[0]!.pendingCount).toBe(5);
    expect(JSON.stringify(guest)).not.toContain('"deck"');
    // The deal in the guest's log names only its own cards.
    const dealt = guest.actions[0] as unknown as {
      deals: { seat: number; cards: Card[]; count?: number }[];
    };
    expect(dealt.deals.find((d) => d.seat === 1)!.cards).toHaveLength(5);
    expect(dealt.deals.find((d) => d.seat === 0)!.cards).toEqual([]);
    expect(dealt.deals.find((d) => d.seat === 0)!.count).toBe(5);

    await playOut(server, clients);
    const after = server.getSnapshot();
    expect(after.state.hand!.phase).toBe('showdown');
    expect(after.state.history).toHaveLength(1);
    // Every seat converged on the same public facts.
    for (const c of clients) {
      const v = c.getState().snapshot!.state as unknown as TableView;
      expect(v.hand!.phase).toBe('showdown');
      expect(v.scores).toEqual(after.state.scores);
      for (const s of v.hand!.seats) expect(s.rows.bottom).toHaveLength(5);
    }
    const scoreSum = after.state.scores.reduce((a, b) => a + b, 0);
    expect(scoreSum).toBe(0);
    // The host copy replays from its log.
    const verified = verifySnapshot(ofcDefinition, after);
    expect(verified.state).toEqual(after.state);
    server.close();
  });

  it('refuses an out-of-turn placement with an error to the sender only', async () => {
    const { server, clients } = makeTable({ variant: 'ofc' }, 2);
    await flush();
    clients[0]!.send({ type: 'start' });
    await flush();
    const state = server.getSnapshot().state;
    const toAct = state.hand!.toAct!;
    const other = toAct === 0 ? 1 : 0;
    const seqBefore = server.getSnapshot().seq;
    clients[other]!.send(naivePlace(state, other));
    await flush();
    expect(clients[other]!.getState().error?.code).toBe('not-your-turn');
    expect(clients[toAct]!.getState().error).toBeNull();
    expect(server.getSnapshot().seq).toBe(seqBefore);
    // A malformed command is refused before the rules see it.
    clients[toAct]!.send({ type: 'place', placements: 'nope' });
    await flush();
    expect(clients[toAct]!.getState().error?.code).toBe('bad-message');
    server.close();
  });

  it('validates command shapes', () => {
    expect(validateOfcCommand({ type: 'start' })).toEqual({ type: 'start' });
    expect(validateOfcCommand({ type: 'settle' })).toEqual({ type: 'settle' });
    expect(validateOfcCommand({ type: 'adjust', seat: 1, points: -3, note: 'oops' })).toEqual({
      type: 'adjust',
      seat: 1,
      points: -3,
      note: 'oops',
    });
    expect(validateOfcCommand({ type: 'adjust', seat: 1.5, points: 1 })).toBeNull();
    expect(
      validateOfcCommand({
        type: 'place',
        placements: [{ card: { rank: 14, suit: 's' }, row: 'top' }],
        discards: [{ rank: 2, suit: 'c' }],
      }),
    ).toEqual({
      type: 'place',
      placements: [{ card: { rank: 14, suit: 's' }, row: 'top' }],
      discards: [{ rank: 2, suit: 'c' }],
    });
    expect(
      validateOfcCommand({
        type: 'place',
        placements: [{ card: { rank: 1, suit: 'x' }, row: 'top' }],
      }),
    ).toBeNull();
    expect(
      validateOfcCommand({
        type: 'place',
        placements: [{ card: { rank: 5, suit: 'h' }, row: 'side' }],
      }),
    ).toBeNull();
    expect(validateOfcCommand({ type: 'nope' })).toBeNull();
    expect(validateOfcCommand(null)).toBeNull();
  });

  it('redacts other seats cards from actions without leaking counts of nothing', () => {
    const deal: Action = {
      type: 'start-hand',
      button: 0,
      deals: [
        { seat: 0, cards: [{ rank: 2, suit: 'c' }] },
        { seat: 1, cards: [{ rank: 3, suit: 'c' }] },
      ],
    };
    const r = redactOfcAction(deal, 1) as typeof deal & { deals: { count?: number }[] };
    expect(r.deals[1]!.cards).toHaveLength(1);
    expect(r.deals[0]!.cards).toEqual([]);
    expect(r.deals[0]!.count).toBe(1);
    const place: Action = {
      type: 'place',
      seat: 0,
      placements: [{ card: { rank: 2, suit: 'c' }, row: 'top' }],
      discards: [{ rank: 9, suit: 'd' }],
    };
    const rp = redactOfcAction(place, 1) as typeof place & { count?: number };
    expect(rp.placements).toEqual([]);
    expect(rp.discards).toEqual([]);
    expect(rp.count).toBe(2);
    expect(redactOfcAction(place, 0)).toBe(place);
    expect(ROWS).toHaveLength(3);
  });
});
