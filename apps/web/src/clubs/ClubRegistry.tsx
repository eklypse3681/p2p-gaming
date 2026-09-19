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
import type { ClubSession } from './session';

export interface ClubRegistry {
  readonly version: number;
  get(slug: string, clubId: string): ClubSession | undefined;
  /** Keeps a live session under the same key (the newcomer is disposed) — like tables. */
  add(slug: string, session: ClubSession): 'added' | 'kept';
  remove(slug: string, clubId: string, dispose?: boolean): void;
  all(): ClubSession[];
}

const Ctx = createContext<ClubRegistry | null>(null);
const keyOf = (slug: string, clubId: string) => `${slug}:${clubId}`;
const isLive = (s: ClubSession) => {
  const st = s.client.getState().status;
  return st === 'joined' || st === 'connecting';
};

/** Club connections outlive the lobby screen so sitting at a table keeps the club channel open. */
export function ClubRegistryProvider({
  children,
  initialSessions,
}: {
  children: ReactNode;
  initialSessions?: [string, ClubSession][];
}) {
  const map = useRef(
    new Map<string, ClubSession>(
      (initialSessions ?? []).map(([slug, s]) => [keyOf(slug, s.clubId), s]),
    ),
  );
  const [version, bump] = useState(0);
  const get = useCallback(
    (slug: string, clubId: string) => map.current.get(keyOf(slug, clubId)),
    [],
  );
  const add = useCallback((slug: string, s: ClubSession): 'added' | 'kept' => {
    const k = keyOf(slug, s.clubId);
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
  const remove = useCallback((slug: string, clubId: string, dispose = true) => {
    const k = keyOf(slug, clubId);
    const s = map.current.get(k);
    if (s && dispose) s.dispose();
    map.current.delete(k);
    bump((n) => n + 1);
  }, []);
  const all = useCallback(() => Array.from(map.current.values()), []);
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
  const value = useMemo<ClubRegistry>(
    () => ({ version, get, add, remove, all }),
    [version, get, add, remove, all],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useClubRegistry(): ClubRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useClubRegistry must be used inside ClubRegistryProvider');
  return ctx;
}

export function useClubSession(slug: string, clubId: string | undefined): ClubSession | undefined {
  const registry = useClubRegistry();
  // `version` is read so consumers re-render when the registry changes.
  void registry.version;
  return clubId ? registry.get(slug, clubId) : undefined;
}
