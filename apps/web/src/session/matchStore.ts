import { useEffect, useState } from 'react';
import { createStore as createIdbStore, del, get, keys, set } from 'idb-keyval';
import type { UseStore } from 'idb-keyval';
import type { MatchSnapshot } from '@bgf/protocol';
import type { MatchStore } from '@bgf/client';
import { useProfile } from './ProfileProvider';
import type { GameId } from '../games/ids';
import { GAME_IDS } from '../games/ids';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Fires whenever any IdbMatchStore writes, so lists can refresh. */
export const matchStoreBus = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  emit() {
    for (const l of Array.from(listeners)) l();
  },
};

function isSnapshot(v: unknown): v is MatchSnapshot {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as MatchSnapshot).id === 'string' &&
    typeof (v as MatchSnapshot).code === 'string' &&
    typeof (v as MatchSnapshot).seq === 'number'
  );
}

/** IndexedDB database name for one player's saved matches of one game. */
export function matchDbName(slug: string, game: GameId): string {
  return `p2p-${slug}-${game}`;
}
/** Database name used before games became a route segment (backgammon only). */
export function legacyMatchDbName(slug: string): string {
  return `bgf-matches-${slug}`;
}
export const MATCH_STORE_NAME = 'matches';

export class IdbMatchStore implements MatchStore {
  private readonly store: UseStore;

  constructor(dbName: string, storeName: string = MATCH_STORE_NAME) {
    this.store = createIdbStore(dbName, storeName);
  }

  async list(): Promise<MatchSnapshot[]> {
    const ks = await keys(this.store);
    const out: MatchSnapshot[] = [];
    for (const k of ks) {
      const v = await get(k, this.store);
      if (isSnapshot(v)) out.push(v);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<MatchSnapshot | undefined> {
    const v = await get(id, this.store);
    return isSnapshot(v) ? v : undefined;
  }

  async put(snapshot: MatchSnapshot): Promise<void> {
    await set(snapshot.id, snapshot, this.store);
    matchStoreBus.emit();
  }

  async delete(id: string): Promise<void> {
    await del(id, this.store);
    matchStoreBus.emit();
  }

  /** Find a saved match by its room code (most recently updated wins). */
  async findByCode(code: string): Promise<MatchSnapshot | undefined> {
    const all = await this.list();
    return all.find((m) => m.code === code);
  }
}

const shared = new Map<string, IdbMatchStore>();

/** The saved-match store of one player for one game (memoised). */
export function getMatchStore(slug: string, game: GameId): IdbMatchStore {
  const key = `${slug}/${game}`;
  let s = shared.get(key);
  if (!s) {
    s = new IdbMatchStore(matchDbName(slug, game));
    shared.set(key, s);
  }
  return s;
}

/** For tests: replace the store of a slug+game (or clear all with no arguments). */
export function setMatchStoreForTests(slug?: string, game?: GameId, store?: IdbMatchStore): void {
  if (slug === undefined || game === undefined) shared.clear();
  else if (store) shared.set(`${slug}/${game}`, store);
  else shared.delete(`${slug}/${game}`);
}

/**
 * Copy every snapshot from a legacy database into `target` (skipping ids already present with
 * an equal or newer `seq`). Best effort: errors are swallowed.
 */
export async function copyLegacyMatches(
  legacyDbName: string,
  target: IdbMatchStore,
  legacyStoreName = 'bgf-matches',
): Promise<number> {
  let copied = 0;
  try {
    const legacy = createIdbStore(legacyDbName, legacyStoreName);
    for (const k of await keys(legacy)) {
      const v = await get(k, legacy);
      if (!isSnapshot(v)) continue;
      const existing = await target.get(v.id);
      if (existing && existing.seq >= v.seq) continue;
      await target.put(v);
      copied++;
    }
  } catch {
    /* legacy db unreadable: nothing to migrate */
  }
  return copied;
}

export interface SavedMatchesState {
  matches: MatchSnapshot[];
  loading: boolean;
  refresh: () => void;
  remove: (id: string) => Promise<void>;
}

/** Saved matches of the profile in scope for one game. */
export function useSavedMatches(game: GameId): SavedMatchesState {
  const { slug } = useProfile();
  const key = `${slug}/${game}`;
  const [data, setData] = useState<{ key: string; matches: MatchSnapshot[] } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMatchStore(slug, game)
      .list()
      .then((list) => {
        if (!cancelled) setData({ key, matches: list });
      })
      .catch(() => {
        if (!cancelled) setData({ key, matches: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [tick, slug, game, key]);

  useEffect(() => matchStoreBus.subscribe(() => setTick((t) => t + 1)), []);

  const loading = data?.key !== key;
  return {
    matches: loading ? [] : data!.matches,
    loading,
    refresh: () => setTick((t) => t + 1),
    remove: async (id: string) => {
      await getMatchStore(slug, game).delete(id);
    },
  };
}

export interface SavedMatchesByGame {
  game: GameId;
  matches: MatchSnapshot[];
}

/** Saved matches of the profile in scope across every game (for the games hub). */
export function useAllSavedMatches(): { byGame: SavedMatchesByGame[]; loading: boolean } {
  const { slug } = useProfile();
  const [data, setData] = useState<{ slug: string; byGame: SavedMatchesByGame[] } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      GAME_IDS.map(async (game) => ({
        game,
        matches: await getMatchStore(slug, game)
          .list()
          .catch(() => [] as MatchSnapshot[]),
      })),
    ).then((byGame) => {
      if (!cancelled) setData({ slug, byGame });
    });
    return () => {
      cancelled = true;
    };
  }, [tick, slug]);

  useEffect(() => matchStoreBus.subscribe(() => setTick((t) => t + 1)), []);

  const loading = data?.slug !== slug;
  return { byGame: loading ? [] : data!.byGame, loading };
}
