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

export interface SessionRegistry {
  /** Increments on every change so consumers re-render. */
  readonly version: number;
  get(slug: string, game: GameId, matchId: string): Session | undefined;
  add(slug: string, game: GameId, session: Session): void;
  remove(slug: string, game: GameId, matchId: string, dispose?: boolean): void;
  all(): Session[];
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
export function SessionRegistryProvider({ children }: { children: ReactNode }) {
  const map = useRef(new Map<string, Session>());
  const [version, bump] = useState(0);

  const get = useCallback(
    (slug: string, game: GameId, id: string) => map.current.get(keyOf(slug, game, id)),
    [],
  );
  const add = useCallback((slug: string, game: GameId, s: Session) => {
    const k = keyOf(slug, game, s.matchId);
    const prev = map.current.get(k);
    if (prev && prev !== s) prev.dispose();
    map.current.set(k, s);
    bump((n) => n + 1);
  }, []);
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
    () => ({ version, get, add, remove, all }),
    [version, get, add, remove, all],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessionRegistry(): SessionRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSessionRegistry must be used within SessionRegistryProvider');
  return ctx;
}

export function useSession(
  slug: string,
  game: GameId,
  matchId: string | undefined,
): Session | undefined {
  const reg = useSessionRegistry();
  return matchId ? reg.get(slug, game, matchId) : undefined;
}
