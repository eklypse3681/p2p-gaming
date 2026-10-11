import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Command, Row, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { defaultConfig } from '@bgf/ofc-engine';
import type { PlayerProfile, TableSnapshot } from '@bgf/protocol';
import { memoryProvider, signerFor } from '@bgf/protocol';
import type { TableClient } from '@bgf/table';
import { createIdbKeyvalMock } from '../test/idbKeyvalMock';
import * as current from '../runtime';
import { createProfile, ensureKeys, getSecrets, resetProfilesForTests } from '../session/profiles';
import { getSnapshotStore, setMatchStoreForTests } from '../session/matchStore';
import type { TableSessionDeps } from '../session/tableSession';
import { hostTable, joinTable, resumeTable } from '../session/tableSession';
import { setMailboxFetchForTests } from './client';
import { ensureMailboxDevice, withMailboxDevice } from './device';
import type { Db } from './service';
import { handleMailbox } from './http';
import type { MailboxAction } from './http';
import { processInbox } from './inbox';
import { MailRelay } from './offline';
import { pageInboxEnv } from './pageEnv';

vi.mock('idb-keyval', () => createIdbKeyvalMock());

type Deps = TableSessionDeps<TableState, Action, Command, TableView, TableConfig>;
type Client = TableClient<TableState, Action, TableConfig, TableView>;
const ofc = current.definitions.ofc;

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** D1's API over Node's SQLite (as in service.test.ts). */
function sqliteDb(): Db {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) },
    }),
  });
  return {
    prepare: (sql) => stmt(sql),
    exec: async (sql) => {
      db.exec(sql);
    },
  };
}

async function player(
  name: string,
): Promise<{ slug: string; profile: PlayerProfile; signer: ReturnType<typeof signerFor> }> {
  createProfile(name);
  const slug = name.toLowerCase();
  const keyed = (await ensureKeys(slug))!;
  return {
    slug,
    profile: { id: keyed.id, name, publicKey: keyed.publicKey },
    signer: signerFor(getSecrets(slug)!.privateKey!),
  };
}

function viewOf(c: Client): TableView {
  return c.getState().snapshot!.state as unknown as TableView;
}

/** Set this seat's pending cards (bottom, middle, top; discard the rest). False if not its turn. */
function place(c: Client, seat: number): boolean {
  const hand = viewOf(c).hand;
  if (!hand || hand.phase !== 'setting') return false;
  const s = hand.seats[seat]!;
  if (s.done || s.pending.length === 0 || !(s.fantasyland || hand.toAct === seat)) return false;
  const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
  const n = s.fantasyland ? 13 - set : set === 0 ? s.pending.length : Math.min(2, 13 - set);
  const rows = {
    bottom: s.rows.bottom.length,
    middle: s.rows.middle.length,
    top: s.rows.top.length,
  };
  const placements = s.pending.slice(0, n).map((card) => {
    const row: Row = rows.bottom < 5 ? 'bottom' : rows.middle < 5 ? 'middle' : 'top';
    rows[row]++;
    return { card, row };
  });
  c.send({ type: 'place', placements, discards: s.pending.slice(n) });
  return true;
}

const placedBy = (s: TableSnapshot, seat: number) => {
  const st = s.state as { hand?: { seats: { rows: Record<Row, unknown[]> }[] } };
  const rows = st.hand!.seats[seat]!.rows;
  return rows.top.length + rows.middle.length + rows.bottom.length;
};

beforeEach(() => {
  localStorage.clear();
  resetProfilesForTests();
  setMatchStoreForTests();
  const db = sqliteDb();
  setMailboxFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://amongfriends.gg');
    const action = url.pathname.split('/').pop() as MailboxAction;
    return handleMailbox(action, new Request(url, init), { MAILBOX: db });
  }) as typeof fetch);
});
afterEach(() => setMailboxFetchForTests(null));

describe('OFC by mail', () => {
  it('a guest plays while the host is away; the host’s device applies it and mails the new view back', async () => {
    const alice = await player('Alice');
    const bob = await player('Bob');
    const provider = memoryProvider();
    const store = (slug: string) => getSnapshotStore<TableSnapshot>(slug, 'ofc') as never;
    const bobDeps: Deps = {
      provider,
      store: store(bob.slug),
      byMail: async (snapshot, seat) => new MailRelay(bob.slug, 'ofc', snapshot as never, seat),
    };

    // Both at the table: the hand is dealt. Whoever acts first plays until it is Bob's turn.
    const host = await hostTable(
      ofc,
      {
        profile: alice.profile,
        signer: alice.signer,
        config: defaultConfig({ variant: 'ofc', seats: 2 }),
        seats: 2,
      },
      { provider, store: store(alice.slug) },
    );
    const guest = await joinTable(
      ofc,
      { code: host.code, profile: bob.profile, signer: bob.signer },
      bobDeps,
    );
    await flush();
    // Both devices get turn notifications: the game is played while apart.
    host.client.setPush(true);
    guest.client.setPush(true);
    await flush();
    for (let i = 0; i < 6 && !place(guest.client, 1); i++) {
      place(host.client, 0);
      await flush();
    }
    // That was Bob's first move, live.
    await flush();
    const matchId = host.matchId;
    expect(viewOf(host.client).hand?.phase).toBe('setting');

    // Make it Bob's turn again with Alice still here, then Alice leaves.
    for (let i = 0; i < 6; i++) {
      const hand = viewOf(host.client).hand!;
      if (hand.toAct === 1) break;
      place(host.client, 0);
      await flush();
    }
    expect(viewOf(host.client).hand!.toAct).toBe(1);
    host.dispose();
    guest.dispose();
    await flush();

    // Bob opens the table: the host is away, so he plays by mail.
    const bobCopy = (await getSnapshotStore<TableSnapshot>(bob.slug, 'ofc').get(matchId))!;
    expect(bobCopy.view).toBe(true);
    const byMail = await resumeTable(
      ofc,
      { snapshot: bobCopy as never, profile: bob.profile, signer: bob.signer },
      bobDeps,
    );
    expect(byMail.byMail).toBeTruthy();
    await flush();
    const before = placedBy(byMail.client.getState().snapshot! as never, 1);
    expect(place(byMail.client, 1)).toBe(true);
    await flush(20);
    expect(byMail.byMail!.pending).toBe(1);

    // Alice's device (a page that is not showing the table) collects the move and applies it.
    const aliceDevice = (await ensureMailboxDevice(alice.slug))!;
    const hostEvents = await processInbox(pageInboxEnv(alice.slug, aliceDevice, () => undefined));
    expect(hostEvents.map((e) => e.kind)).toEqual(['applied']);
    const aliceCopy = (await getSnapshotStore<TableSnapshot>(alice.slug, 'ofc').get(matchId))!;
    expect(placedBy(aliceCopy, 1)).toBeGreaterThan(before);
    // Alice's copy is still the full table; nothing was revealed by putting it away.
    expect(aliceCopy.view).toBeUndefined();

    // Bob's page collects the new view: the open table updates.
    const bobDevice = (await ensureMailboxDevice(bob.slug))!;
    const guestEvents = await processInbox(pageInboxEnv(bob.slug, bobDevice, () => undefined));
    expect(guestEvents[0]).toMatchObject({ kind: 'view', stored: true });
    await flush();
    expect(byMail.byMail!.pending).toBe(0);
    expect(byMail.client.getState().snapshot!.seq).toBe(aliceCopy.seq);
    expect(placedBy(byMail.client.getState().snapshot! as never, 1)).toBe(placedBy(aliceCopy, 1));
    // He never sees Alice's cards: the mailed view is redacted for his seat.
    expect(
      'deck' in ((byMail.client.getState().snapshot!.state as { hand?: object }).hand ?? {}),
    ).toBe(false);
    byMail.dispose();
  });
});

describe('backgammon by mail', () => {
  it('the host mails the whole match to an absent player, who can then host it', async () => {
    const { hostNewMatch, joinMatch } = await import('../session/session');
    const { startHostMail } = await import('./hosting');
    const { getMatchStore } = await import('../session/matchStore');
    const alice = await player('Alice');
    const bob = await player('Bob');
    const provider = memoryProvider();
    const host = await hostNewMatch(
      { profile: alice.profile, signer: alice.signer, config: { length: 3 } },
      { provider, store: getMatchStore(alice.slug, 'backgammon') },
    );
    const guest = await joinMatch(
      { code: host.code, profile: bob.profile, signer: bob.signer },
      { provider, store: getMatchStore(bob.slug, 'backgammon') },
    );
    await flush();
    host.client.setPush(true);
    guest.client.setPush(true);
    await flush();
    guest.dispose();
    await flush();
    const before = (await getMatchStore(bob.slug, 'backgammon').get(host.matchId))!.seq;

    // Alice's device hosts; Bob is away. A change happens (here: chat), and it is mailed.
    const stop = startHostMail(alice.slug, 'backgammon', host);
    host.client.sendChat('back tomorrow');
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    await flush(20);

    // Bob's device still holds a token from an earlier mailbox (as after a reset): it registers
    // again and collects.
    const events = await withMailboxDevice(bob.slug, (d) =>
      processInbox(pageInboxEnv(bob.slug, d, () => undefined)),
    );
    expect(events).toEqual([expect.objectContaining({ kind: 'view', stored: true })]);
    const bobCopy = (await getMatchStore(bob.slug, 'backgammon').get(host.matchId))!;
    expect(bobCopy.seq).toBe(before); // chat does not move the position on
    expect(bobCopy.chat.at(-1)?.text).toBe('back tomorrow');
    // The full match, not a view: Bob's device can host it from here.
    expect(bobCopy.mailboxKey).toBeTruthy();
    host.dispose();
  });
});

describe('only when everyone has turn notifications', () => {
  it('a game where one player has none is played together: nothing is mailed', async () => {
    const { hostNewMatch, joinMatch } = await import('../session/session');
    const { startHostMail } = await import('./hosting');
    const { getMatchStore } = await import('../session/matchStore');
    const alice = await player('Alice');
    const bob = await player('Bob');
    const provider = memoryProvider();
    const host = await hostNewMatch(
      { profile: alice.profile, signer: alice.signer, config: { length: 3 } },
      { provider, store: getMatchStore(alice.slug, 'backgammon') },
    );
    const guest = await joinMatch(
      { code: host.code, profile: bob.profile, signer: bob.signer },
      { provider, store: getMatchStore(bob.slug, 'backgammon') },
    );
    await flush();
    host.client.setPush(true); // only Alice
    await flush();
    guest.dispose();
    await flush();
    const stop = startHostMail(alice.slug, 'backgammon', host);
    host.client.sendChat('anyone there?');
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    await flush(20);
    const events = await withMailboxDevice(bob.slug, (d) =>
      processInbox(pageInboxEnv(bob.slug, d, () => undefined)),
    );
    expect(events).toEqual([]);
    host.dispose();
  });
});
