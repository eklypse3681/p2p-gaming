import { useEffect, useState } from 'react';
import { connLog } from '../session/connLog';

/** This page's build, or null where there is none to compare (dev server, tests). */
const RUNNING: string | null =
  typeof __APP_VERSION__ !== 'undefined' && import.meta.env.PROD ? __APP_VERSION__ : null;

const CHECK_EVERY_MS = 60_000;

/** The version the site serves now, or null when it cannot be read (offline, blocked). */
async function servedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Offers a reload once the site has a newer version than this page: checked every minute and
 * whenever the page comes back into view. Reloading is safe mid-game: the table reopens and
 * reconnects by itself, as after any reload.
 */
export function UpdateNotice() {
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    if (!RUNNING) return;
    let stopped = false;
    const check = async () => {
      const v = await servedVersion();
      if (stopped || !v || v === RUNNING) return;
      setNewer((cur) => {
        if (cur !== v) connLog('new version available', { running: RUNNING, served: v });
        return v;
      });
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  if (!newer) return null;
  return (
    <button
      type="button"
      className="update-notice"
      data-testid="update-notice"
      onClick={() => {
        connLog('reloading for the new version', { served: newer });
        window.location.reload();
      }}
    >
      New version · <strong>Reload</strong>
    </button>
  );
}
