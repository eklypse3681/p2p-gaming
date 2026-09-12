import { getTransportName, DEFAULT_TRANSPORT } from './providers';
import type { GameId } from '../games/ids';
import { DEFAULT_GAME, isGameId } from '../games/ids';
import { encodeIdentityCode } from './transfer';

/**
 * Shareable join link: `#/<game>/join/<code>`. It carries no profile: the guest picks (or
 * creates) their player when they open it. A non-default transport is kept in the query so the
 * guest uses the same medium.
 */
export function joinLink(code: string, game: GameId = DEFAULT_GAME): string {
  const hash = `#/${game}/join/${code}`;
  if (typeof window === 'undefined') return hash;
  const { origin, pathname } = window.location;
  const transport = getTransportName();
  const query = transport === DEFAULT_TRANSPORT ? '' : `?transport=${transport}`;
  return `${origin}${pathname}${query}${hash}`;
}

/**
 * Hand-off link: a join link that also carries the player's identity (`?import=` inside the hash),
 * so scanning it on a phone continues the game *as the same player* — no picker, no form.
 * The two devices then share the seat and stay in sync until one of them leaves.
 */
export function handoffLink(
  code: string,
  profile: { id: string; name: string; avatar?: string },
  game: GameId = DEFAULT_GAME,
): string {
  return `${joinLink(code, game)}?import=${encodeIdentityCode(profile)}`;
}

/** The `import` identity code carried by a hand-off link, if any. */
export function identityFromSearch(search: string): string | null {
  const v = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('import');
  return v && v.trim() ? v.trim() : null;
}

const LINK_RE = /#\/(?:([a-z0-9-]+)\/)?(?:([a-z0-9-]+)\/)?join\/([A-Za-z0-9]+)/;

/**
 * Accepts a bare code or a full join link and returns the raw code text (not yet normalised).
 * Understands `#/join/CODE` (legacy), `#/<game>/join/CODE`, `#/<profile>/join/CODE` and
 * `#/<profile>/<game>/join/CODE`.
 */
export function extractCode(input: string): string {
  const m = input.trim().match(LINK_RE);
  return m ? m[3]! : input.trim();
}

/** The game a join link names; legacy links without one are backgammon. */
export function extractGame(input: string): GameId {
  const m = input.trim().match(LINK_RE);
  if (!m) return DEFAULT_GAME;
  const candidates = [m[2], m[1]];
  for (const c of candidates) if (isGameId(c)) return c;
  return DEFAULT_GAME;
}
