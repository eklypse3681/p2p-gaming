import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { GameId } from './ids';
import { isGameId } from './ids';
import { useProfile } from '../session/ProfileProvider';

/** Routes of one game for one player, all absolute (`/steve/backgammon/host`). */
export interface GameRoutes {
  home: string;
  host: string;
  join: (code?: string) => string;
  game: (matchId: string) => string;
  history: string;
}

/** One saved match/table as a game describes it for lists (hub, home, history). */
export interface SavedSummary {
  id: string;
  code: string;
  /** e.g. "vs Bob" or "with Bob, Carol". */
  title: string;
  /** e.g. "5-point match · 2–1" or "Pineapple · hand 4 · +12". */
  meta: string;
  /** Short badge such as "Free" or "2-7". */
  badge?: string;
  inProgress: boolean;
  updatedAt: number;
}

/** What the router needs to mount a game. Add a game by registering one of these. */
export interface GameDefinition {
  id: GameId;
  name: string;
  tagline: string;
  /** Emoji used on the hub card and breadcrumb. */
  icon: string;
  /** Suffix of the PeerJS id namespace so room codes of different games never collide. */
  peerNamespace: string;
  routes: (profileSlug: string) => GameRoutes;
  screens: {
    Home: ComponentType;
    Host: ComponentType;
    Join: ComponentType;
    Game: ComponentType;
    History: ComponentType;
  };
  /** Optional profile-less playground mounted at `#/<id>/demo`. */
  Demo?: ComponentType;
  /**
   * Describe one of this game's saved snapshots for the player `myId` (null when they are not a
   * player in it). Lists that span games (the hub) call this instead of knowing every snapshot
   * shape.
   */
  describeSaved?: (snapshot: unknown, myId: string) => SavedSummary | null;
}

export interface GameContext {
  id: GameId;
  def: GameDefinition;
  routes: GameRoutes;
  /** Build a route inside this game for the current player: `path('/host')` → `/steve/backgammon/host`. */
  path: (sub?: string) => string;
}

const Ctx = createContext<GameContext | null>(null);

export function gamePath(slug: string, game: GameId, sub = '/'): string {
  const tail = sub === '/' || sub === '' ? '/' : sub.startsWith('/') ? sub : `/${sub}`;
  return `/${slug}/${game}${tail}`;
}

export function routesFor(slug: string, game: GameId): GameRoutes {
  return {
    home: gamePath(slug, game, '/'),
    host: gamePath(slug, game, '/host'),
    join: (code?: string) => gamePath(slug, game, code ? `/join/${code}` : '/join'),
    game: (matchId: string) => gamePath(slug, game, `/game/${matchId}`),
    history: gamePath(slug, game, '/history'),
  };
}

/** Provides the game named by the route segment under `#/:profile/:game/`. */
export function GameProvider({ def, children }: { def: GameDefinition; children: ReactNode }) {
  const { slug } = useProfile();
  const path = useCallback((sub?: string) => gamePath(slug, def.id, sub), [slug, def.id]);
  const value = useMemo<GameContext>(
    () => ({ id: def.id, def, routes: routesFor(slug, def.id), path }),
    [def, slug, path],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGame(): GameContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGame must be used inside a game route (GameProvider)');
  return ctx;
}

export function useOptionalGame(): GameContext | null {
  return useContext(Ctx);
}

/** The game id named by a `#/<profile>/<game>/…` pathname, if any. */
export function gameIdFromPathname(pathname: string): GameId | null {
  const [, , second] = pathname.split('/');
  return isGameId(second) ? second : null;
}

/**
 * The game in scope for the current address: the `GameProvider` context when inside one, else
 * the segment parsed from the URL (for chrome rendered above the game shell, like the app bar).
 */
export function useRouteGameId(): GameId | null {
  const ctx = useContext(Ctx);
  const { pathname } = useLocation();
  return ctx?.id ?? gameIdFromPathname(pathname);
}
