import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createIdbKeyvalMock } from '../test/idbKeyvalMock';
import type { MatchSnapshot } from '@bgf/protocol';
import { newMatch } from '@bgf/engine';

vi.mock('idb-keyval', async () => {
  const { createIdbKeyvalMock } = await import('../test/idbKeyvalMock');
  return createIdbKeyvalMock();
});
import * as idbMocked from 'idb-keyval';
const mock = idbMocked as unknown as ReturnType<typeof createIdbKeyvalMock>;

import {
  IdbMatchStore,
  copyLegacyMatches,
  getMatchStore,
  matchDbName,
  matchStoreBus,
  setMatchStoreForTests,
} from './matchStore';
import { gameDbMigratedKey, runPendingDbMigrations } from './migrate';
import { PENDING_DB_MIGRATIONS_KEY, createProfile, resetProfilesForTests } from './profiles';

function snap(id: string, code: string, updatedAt: number, seq = 1): MatchSnapshot {
  const match = newMatch({ length: 3 });
  return {
    id,
    code,
    seq,
    createdAt: updatedAt - 1000,
    updatedAt,
    config: match.config,
    players: { white: { id: 'a', name: 'A' }, black: null },
    hostSeat: 'white',
    actions: [],
    match,
    chat: [],
  };
}

describe('IdbMatchStore', () => {
  beforeEach(() => {
    mock.dbs.clear();
    setMatchStoreForTests();
    localStorage.clear();
  });

  it('puts, gets, lists (newest first) and deletes', async () => {
    const store = new IdbMatchStore('test-db');
    await store.put(snap('m1', 'AAA111', 100));
    await store.put(snap('m2', 'BBB222', 300));
    await store.put(snap('m3', 'CCC333', 200));
    expect((await store.get('m1'))?.code).toBe('AAA111');
    expect((await store.list()).map((m) => m.id)).toEqual(['m2', 'm3', 'm1']);
    expect((await store.findByCode('CCC333'))?.id).toBe('m3');
    await store.delete('m2');
    expect((await store.list()).map((m) => m.id)).toEqual(['m3', 'm1']);
    expect(await store.get('m2')).toBeUndefined();
  });

  it('ignores junk values and notifies the bus on writes', async () => {
    const store = new IdbMatchStore('test-db2');
    await mock.set('junk', { hello: 'world' }, { name: 'test-db2/matches' });
    const spy = vi.fn();
    const off = matchStoreBus.subscribe(spy);
    await store.put(snap('m1', 'AAA111', 100));
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await store.list()).map((m) => m.id)).toEqual(['m1']);
    await store.delete('m1');
    expect(spy).toHaveBeenCalledTimes(2);
    off();
  });

  it('each player and game has its own database', async () => {
    expect(matchDbName('alice', 'backgammon')).toBe('p2p-alice-backgammon');
    const a = getMatchStore('alice', 'backgammon');
    const b = getMatchStore('bob', 'backgammon');
    expect(getMatchStore('alice', 'backgammon')).toBe(a);
    await a.put(snap('m1', 'AAA111', 100));
    expect((await a.list()).map((m) => m.id)).toEqual(['m1']);
    expect(await b.list()).toEqual([]);
    expect(mock.dbs.has('p2p-alice-backgammon/matches')).toBe(true);
  });

  it('copies legacy matches without overwriting newer copies', async () => {
    await mock.set('m1', snap('m1', 'AAA111', 100, 5), { name: 'bgf/bgf-matches' });
    await mock.set('m2', snap('m2', 'BBB222', 200, 1), { name: 'bgf/bgf-matches' });
    await mock.set('junk', 42, { name: 'bgf/bgf-matches' });
    const target = new IdbMatchStore('bgf-matches-steve');
    await target.put(snap('m2', 'BBB222', 150, 7));
    const copied = await copyLegacyMatches('bgf', target);
    expect(copied).toBe(1);
    expect((await target.get('m1'))?.seq).toBe(5);
    expect((await target.get('m2'))?.seq).toBe(7);
  });

  it('runPendingDbMigrations copies queued legacy databases once', async () => {
    await mock.set('m1', snap('m1', 'AAA111', 100), { name: 'bgf/bgf-matches' });
    await mock.set('m9', snap('m9', 'ZZZ999', 900), { name: 'bgf-guest/bgf-matches' });
    localStorage.setItem(
      PENDING_DB_MIGRATIONS_KEY,
      JSON.stringify([
        { db: 'bgf', slug: 'steve' },
        { db: 'bgf-guest', slug: 'bob' },
      ]),
    );
    expect(await runPendingDbMigrations()).toBe(2);
    expect((await getMatchStore('steve', 'backgammon').list()).map((m) => m.id)).toEqual(['m1']);
    expect((await getMatchStore('bob', 'backgammon').list()).map((m) => m.id)).toEqual(['m9']);
    expect(localStorage.getItem(PENDING_DB_MIGRATIONS_KEY)).toBeNull();
    expect(await runPendingDbMigrations()).toBe(0);
  });

  it("copies each known player's pre-games database into their backgammon store once", async () => {
    resetProfilesForTests();
    createProfile('Steve');
    await mock.set('m1', snap('m1', 'AAA111', 100, 3), { name: 'bgf-matches-steve/matches' });
    expect(await runPendingDbMigrations()).toBe(1);
    expect((await getMatchStore('steve', 'backgammon').list()).map((m) => m.id)).toEqual(['m1']);
    expect(localStorage.getItem(gameDbMigratedKey('steve'))).toBe('1');
    // A later, newer copy in the legacy db is not re-imported: the migration ran once.
    await mock.set('m2', snap('m2', 'BBB222', 200), { name: 'bgf-matches-steve/matches' });
    expect(await runPendingDbMigrations()).toBe(0);
    expect(await getMatchStore('steve', 'backgammon').get('m2')).toBeUndefined();
  });
});
