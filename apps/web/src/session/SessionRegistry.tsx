import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Session } from './session';
import type { GameId } from '../games/ids';

/**
 * What every live session looks like to the registry, whatever game runs on it: a backgammon
 * `Session` (GameClient) or a generic table session (TableClient) both qualify.
 */
export interface BaseSession {
  matchId: string;
  code: string;
  role: 'host' | 'guest';
  client: {
    getState(): { status: 'connecting' | 'joined' | 'rejected' | 'disconnected' };
    subscribe(listener: () => void): () => void;
  };
  dispose(): void;
}

export interface SessionRegistry {
  /** Increments on every change so consumers re-render. */
  readonly version: number;
  get(slug: string, game: GameId, matchId: string): BaseSession | undefined;
  /**
   * Register a session. A live session (`joined` or `connecting`) under the same key is never
   * replaced: the newcomer is disposed instead and `'kept'` is returned. A late-completing
   * resume attempt must not tear down the table the player is already playing on.
   */
  add(slug: string, game: GameId, session: BaseSession): 'added' | 'kept';
  remove(slug: string, game: GameId, matchId: string, dispose?: boolean): void;
  all(): BaseSession[];
  /** The live session (any player/game) currently hosting or joined under a room code. */
  liveByCode(code: string): BaseSession | undefined;
}

function isLive(s: BaseSession): boolean {
  const st = s.client.getState().status;
  return st === 'joined' || st === 'connecting';
}

const Ctx = createContext<SessionRegistry | null>(null);

function keyOf(slug: string, game: GameId, matchId: string): string {
  return `${slug}:${game}:${matchId}`;
}

/**
 * Keeps live sessions (client + optional server) alive across route changes. Sessions are keyed
 * by player, game *and* match, so switching player in the same tab never reuses another player's
 * connection.
 */
export function SessionRegistryProvider({
  children,
  initialSessions,
}: {
  children: ReactNode;
  /** Pre-seeded sessions (tests): `[slug, game, session]` triples. */
  initialSessions?: [string, GameId, BaseSession][];
}) {
  const map = useRef(
    new Map<string, BaseSession>(
      (initialSessions ?? []).map(([slug, game, s]) => [keyOf(slug, game, s.matchId), s]),
    ),
  );
  const [version, bump] = useState(0);

  const get = useCallback(
    (slug: string, game: GameId, id: string) => map.current.get(keyOf(slug, game, id)),
    [],
  );
  const add = useCallback((slug: string, game: GameId, s: BaseSession): 'added' | 'kept' => {
    const k = keyOf(slug, game, s.matchId);
    const prev = map.current.get(k);
    if (prev === s) return 'added';
    if (prev && isLive(prev)) {
      try {
        s.dispose();
      } catch {
        /* ignore */
      }
      return 'kept';
    }
    if (prev) prev.dispose();
    map.current.set(k, s);
    bump((n) => n + 1);
    return 'added';
  }, []);
  const liveByCode = useCallback(
    (code: string) => Array.from(map.current.values()).find((s) => s.code === code && isLive(s)),
    [],
  );
  const remove = useCallback((slug: string, game: GameId, id: string, dispose = true) => {
    const k = keyOf(slug, game, id);
    const s = map.current.get(k);
    if (s && dispose) s.dispose();
    map.current.delete(k);
    bump((n) => n + 1);
  }, []);
  const all = useCallback(() => Array.from(map.current.values()), []);

  // Closing the tab: say goodbye so the peer learns immediately instead of via a timeout.
  useEffect(() => {
    const onHide = () => {
      for (const s of map.current.values()) {
        try {
          s.dispose();
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const value = useMemo<SessionRegistry>(
    () => ({ version, get, add, remove, all, liveByCode }),
    [version, get, add, remove, all, liveByCode],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessionRegistry(): SessionRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSessionRegistry must be used within SessionRegistryProvider');
  return ctx;
}

/**
 * The live session for a match, typed for the game asking (backgammon's `Session` by default;
 * table games pass their `TableSession` type).
 */
export function useSession<T extends BaseSession = Session>(
  slug: string,
  game: GameId,
  matchId: string | undefined,
): T | undefined {
  const reg = useSessionRegistry();
  return matchId ? (reg.get(slug, game, matchId) as T | undefined) : undefined;
}
