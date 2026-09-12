import type { PendingDbMigration } from './profiles';
import { PENDING_DB_MIGRATIONS_KEY, getProfilesIndex } from './profiles';
import {
  MATCH_STORE_NAME,
  copyLegacyMatches,
  getMatchStore,
  legacyMatchDbName,
  matchStoreBus,
} from './matchStore';
import { readJson, removeKey, writeJson } from './storage';
import { DEFAULT_GAME } from '../games/ids';

/** Marker that a player's pre-games database (`bgf-matches-<slug>`) has been copied. */
export function gameDbMigratedKey(slug: string): string {
  return `p2p:db-migrated:${slug}`;
}

/**
 * Finish the legacy → per-profile migration: copy saved matches from the old single database(s)
 * into each migrated profile's own (backgammon) database. Idempotent; safe to call on every app
 * start.
 */
export async function runPendingDbMigrations(): Promise<number> {
  const pending = readJson<PendingDbMigration[]>(PENDING_DB_MIGRATIONS_KEY);
  let total = 0;
  if (pending && Array.isArray(pending) && pending.length > 0) {
    removeKey(PENDING_DB_MIGRATIONS_KEY); // even if a copy fails we do not retry forever
    for (const { db, slug } of pending) {
      if (typeof db !== 'string' || typeof slug !== 'string') continue;
      total += await copyLegacyMatches(db, getMatchStore(slug, DEFAULT_GAME));
    }
  }
  total += await migrateProfileDbsToGames();
  if (total > 0) matchStoreBus.emit();
  return total;
}

/**
 * Games became a route segment after players did: every player's `bgf-matches-<slug>` database
 * (backgammon only) is copied once into `p2p-<slug>-backgammon`.
 */
export async function migrateProfileDbsToGames(): Promise<number> {
  let total = 0;
  for (const slug of Object.keys(getProfilesIndex())) {
    const key = gameDbMigratedKey(slug);
    if (readJson<number>(key)) continue;
    writeJson(key, 1);
    total += await copyLegacyMatches(
      legacyMatchDbName(slug),
      getMatchStore(slug, DEFAULT_GAME),
      MATCH_STORE_NAME,
    );
  }
  return total;
}
