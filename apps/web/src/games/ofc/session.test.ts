import { describe, expect, it } from 'vitest';
import type { Action, Command, Row, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { defaultConfig, ofcDefinition } from '@bgf/ofc-engine';
import type { PlayerProfile } from '@bgf/protocol';
import { memoryProvider } from '@bgf/protocol';
import type { TableClient } from '@bgf/table';
import type { TableSessionDeps } from '../../session/tableSession';
import { hostTable, joinTable, resumeTable } from '../../session/tableSession';
import { SessionError } from '../../session/session';

type Deps = TableSessionDeps<TableState, Action, Command, TableView, TableConfig>;
type Client = TableClient<TableState, Action, TableConfig, TableView>;

const ALICE: PlayerProfile = { id: 'a', name: 'Alice' };
const BOB: PlayerProfile = { id: 'b', name: 'Bob' };
const CAROL: PlayerProfile = { id: 'c', name: 'Carol' };

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A store that remembers every snapshot per client (the app uses IndexedDB). */
function memStore() {
  const map = new Map<string, unknown>();
  return {
    map,
    async put(s: { id: string }) {
      map.set(s.id, s);
    },
    async get(id: string) {
      return map.get(id) as never;
    },
    async findByCode(code: string) {
      return Array.from(map.values()).find((s) => (s as { code: string }).code === code) as never;
    },
  };
}

function viewOf(client: Client): TableView {
  return client.getState().snapshot!.state as unknown as TableView;
}

/** Place this seat's pending cards: bottom, then middle, then top; discard the rest. */
function placeFor(client: Client, seat: number): boolean {
  const v = viewOf(client);
  const hand = v.hand;
  if (!hand || hand.phase !== 'setting') return false;
  const s = hand.seats[seat]!;
  if (s.done || s.pending.length === 0 || !(s.fantasyland || hand.toAct === seat)) return false;
  const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
  const place = s.fantasyland ? 13 - set : set === 0 ? s.pending.length : Math.min(2, 13 - set);
  const rows = {
    bottom: s.rows.bottom.length,
    middle: s.rows.middle.length,
    top: s.rows.top.length,
  };
  const placements = s.pending.slice(0, place).map((card) => {
    const row: Row = rows.bottom < 5 ? 'bottom' : rows.middle < 5 ? 'middle' : 'top';
    rows[row]++;
    return { card, row };
  });
  client.send({ type: 'place', placements, discards: s.pending.slice(place) });
  return true;
}

async function playHand(clients: Client[]): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    await flush();
    const v = viewOf(clients[0]!);
    if (!v.hand || v.hand.phase !== 'setting') return;
    let acted = false;
    clients.forEach((c, seat) => {
      if (!acted) acted = placeFor(c, seat);
    });
    if (!acted) await flush();
  }
  throw new Error('hand did not finish');
}

describe('OFC on the table core', () => {
  it('hosts a 3-seat table, two guests join, a hand plays to showdown with redacted views', async () => {
    const provider = memoryProvider();
    const stores = [memStore(), memStore(), memStore()];
    const deps = (i: number): Deps => ({
      provider,
      store: stores[i] as never,
      joinTimeoutMs: 2000,
    });
    const config = defaultConfig({
      variant: 'pineapple',
      seats: 3,
      scoring: { mode: 'buyin', buyIn: 100, multiplier: 0.5 },
    });
    const host = await hostTable(ofcDefinition, { profile: ALICE, config, seats: 3 }, deps(0));
    expect(host.role).toBe('host');
    expect(host.client.getState().seat).toBe(0);
    const bob = await joinTable(ofcDefinition, { code: host.code, profile: BOB }, deps(1));
    const carol = await joinTable(ofcDefinition, { code: host.code, profile: CAROL }, deps(2));
    await flush();
    expect(bob.client.getState().seat).toBe(1);
    expect(carol.client.getState().seat).toBe(2);
    expect(host.client.getState().snapshot!.seats.map((s) => s?.name)).toEqual([
      'Alice',
      'Bob',
      'Carol',
    ]);
    // A fourth player is turned away.
    await expect(
      joinTable(ofcDefinition, { code: host.code, profile: { id: 'd', name: 'Dan' } }, deps(0)),
    ).rejects.toMatchObject({ code: 'rejected' });

    const clients = [host.client, bob.client, carol.client];
    // The table is unattended by default: the hand was dealt the moment the last seat filled.
    await flush();
    // Everyone sees a hand; guests see their own cards and only counts for others.
    const bobView = viewOf(bob.client);
    expect(bobView.hand!.phase).toBe('setting');
    expect(bobView.hand!.seats[1]!.pending.length).toBe(5);
    expect(bobView.hand!.seats[0]!.pending).toEqual([]);
    expect(bobView.hand!.seats[0]!.pendingCount).toBe(5);
    expect(bob.client.getState().snapshot!.view).toBe(true);
    expect('deck' in (bobView.hand as object)).toBe(false);
    expect(bobView.hand!.deckCount).toBeGreaterThan(0);
    // The host's copy is the full state (it re-hosts from it).
    const hostSnap = host.client.getState().snapshot!;
    expect(hostSnap.view).toBeUndefined();
    expect((hostSnap.state as unknown as TableState).hand!.deck.length).toBeGreaterThan(0);

    await playHand(clients);
    await flush();
    const v = viewOf(host.client);
    expect(v.hand!.phase).toBe('showdown');
    expect(v.history.length).toBe(1);
    expect(v.scores.reduce((a, b) => a + b, 0)).toBe(0);
    expect(v.ledger.length).toBe(1);
    expect(v.ledger[0]!.type).toBe('hand');
    // Every client converged on the same scores.
    for (const c of clients) expect(viewOf(c).scores).toEqual(v.scores);

    // Settle: balances return to the buy-in on every client.
    bob.client.send({ type: 'settle' });
    await flush();
    const after = viewOf(carol.client);
    expect(after.ledger[after.ledger.length - 1]!.type).toBe('settlement');
    const settlement = after.ledger[after.ledger.length - 1]!;
    if (settlement.type === 'settlement') {
      for (const t of settlement.transfers) expect(t.amount).toBe(t.points * 0.5);
    }

    // An illegal command errors only the sender and changes nothing.
    const seqBefore = host.client.getState().snapshot!.seq;
    carol.client.send({ type: 'place', placements: [], discards: [] });
    await flush();
    expect(carol.client.getState().error?.code).toBeTruthy();
    expect(host.client.getState().error).toBeNull();
    expect(host.client.getState().snapshot!.seq).toBe(seqBefore);

    bob.dispose();
    carol.dispose();
    host.dispose();
  });

  it('resume: the host re-hosts from its full copy; a guest view can only rejoin, and reports host-offline', async () => {
    const provider = memoryProvider();
    const hostStore = memStore();
    const guestStore = memStore();
    const config = defaultConfig({ variant: 'ofc', seats: 2 });
    const host = await hostTable(
      ofcDefinition,
      { profile: ALICE, config, seats: 2 },
      {
        provider,
        store: hostStore as never,
      },
    );
    const bob = await joinTable(
      ofcDefinition,
      { code: host.code, profile: BOB },
      {
        provider,
        store: guestStore as never,
      },
    );
    await flush();
    const id = host.matchId;
    host.dispose();
    bob.dispose();
    await flush();

    // Bob only has a view: with nobody hosting, resuming reports host-offline.
    const bobCopy = (await guestStore.get(id)) as never;
    await expect(
      resumeTable(
        ofcDefinition,
        { snapshot: bobCopy, profile: BOB },
        { provider, store: guestStore as never, joinTimeoutMs: 500, sleep: async () => {} },
        { maxTotalMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'host-offline' });

    // Alice's full copy re-hosts under the same code with the hand intact.
    const aliceCopy = (await hostStore.get(id)) as never;
    const again = await resumeTable(
      ofcDefinition,
      { snapshot: aliceCopy, profile: ALICE },
      { provider, store: hostStore as never },
    );
    expect(again.role).toBe('host');
    expect(again.code).toBe(host.code);
    expect(viewOf(again.client).hand!.number).toBe(1);
    // Now Bob's resume joins.
    const bobAgain = await resumeTable(
      ofcDefinition,
      { snapshot: bobCopy, profile: BOB },
      { provider, store: guestStore as never },
    );
    expect(bobAgain.role).toBe('guest');
    expect(bobAgain.client.getState().seat).toBe(1);
    bobAgain.dispose();
    again.dispose();
  });

  it('refuses to play without a name', async () => {
    const provider = memoryProvider();
    await expect(
      hostTable(
        ofcDefinition,
        { profile: { id: 'x', name: ' ' }, config: defaultConfig(), seats: 2 },
        { provider },
      ),
    ).rejects.toBeInstanceOf(SessionError);
  });
});
