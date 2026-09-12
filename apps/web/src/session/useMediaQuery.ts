import { useCallback, useSyncExternalStore } from 'react';

/** Landscape phones: short viewport, wider than tall. */
export const LANDSCAPE_PHONE_QUERY = '(max-height: 480px) and (orientation: landscape)';

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** Reactive `window.matchMedia`; false where unsupported (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!supported()) return () => {};
      const m = window.matchMedia(query);
      m.addEventListener('change', listener);
      return () => m.removeEventListener('change', listener);
    },
    [query],
  );
  const get = useCallback(() => (supported() ? window.matchMedia(query).matches : false), [query]);
  return useSyncExternalStore(subscribe, get, () => false);
}
