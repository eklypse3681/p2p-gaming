import { useCallback, useEffect, useState } from 'react';

/**
 * Full screen for the table. Where the browser allows it (desktop, Android) the page goes truly
 * full screen; everywhere (iPhone Safari cannot) it also turns on an immersive mode that hides
 * the app bar, so the board gets the whole viewport. Leaving the screen, or the browser leaving
 * full screen (Back, Esc), turns immersive mode off again.
 */
export function useFullscreen(): { on: boolean; toggle: () => void; native: boolean } {
  const [on, setOn] = useState(false);
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const native = !!root && typeof root.requestFullscreen === 'function';

  useEffect(() => {
    if (!root) return;
    if (on) root.setAttribute('data-immersive', 'true');
    else root.removeAttribute('data-immersive');
  }, [on, root]);

  // The browser left full screen on its own (Esc, the Back gesture): follow it.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setOn(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Leaving the game screen ends it.
  useEffect(
    () => () => {
      root?.removeAttribute('data-immersive');
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        void document.exitFullscreen?.().catch(() => {});
      }
    },
    [root],
  );

  const toggle = useCallback(() => {
    if (on) {
      setOn(false);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      return;
    }
    setOn(true);
    if (native) {
      void root!.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
        /* refused (iframe, policy): immersive mode alone still helps */
      });
    }
  }, [on, native, root]);

  return { on, toggle, native };
}

export function FullscreenIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d={on ? 'M7 3v4H3M13 3v4h4M7 17v-4H3M13 17v-4h4' : 'M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
