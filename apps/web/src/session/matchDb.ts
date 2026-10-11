/**
 * Where saved matches live in IndexedDB. Kept apart from `matchStore.ts` (which brings React and
 * the profile code) so the service worker can open the same databases.
 */

/** IndexedDB database name for one player's saved matches of one game. */
export function matchDbName(slug: string, game: string): string {
  return `p2p-${slug}-${game}`;
}

export const MATCH_STORE_NAME = 'matches';
