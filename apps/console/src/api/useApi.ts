import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client';

/**
 * Fetch-on-mount with refresh. `key` identifies the resource (e.g. a table id): when it changes
 * the resource reloads. Unauthorized errors bubble to the token gate through a window event.
 */
export function useResource<T>(load: () => Promise<T>, key = '') {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const refresh = useCallback(async () => {
    try {
      const value = await loader.current();
      if (!alive.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.unauthorized)
        window.dispatchEvent(new Event('console:unauthorized'));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh, key]);
  return { data, error, loading, refresh, setData };
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
