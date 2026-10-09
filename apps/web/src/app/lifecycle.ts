import { connLog } from '../session/connLog';

/**
 * Page lifecycle into the connection log, so a dropped table can be lined up with what the phone
 * did (backgrounded, frozen, restored, offline), and a clean reload when a deploy has replaced the
 * app's files under an open page.
 */
export function watchLifecycle(): void {
  if (typeof window === 'undefined') return;
  document.addEventListener('visibilitychange', () => connLog(`page ${document.visibilityState}`));
  window.addEventListener('pagehide', (e) => connLog('page hide', { persisted: e.persisted }));
  window.addEventListener('pageshow', (e) => connLog('page show', { persisted: e.persisted }));
  document.addEventListener('freeze', () => connLog('page frozen'));
  document.addEventListener('resume', () => connLog('page resumed'));
  window.addEventListener('online', () => connLog('network online'));
  window.addEventListener('offline', () => connLog('network offline'));

  // A deploy replaced the app's files while this page stayed open: a chunk it loads on demand
  // (the network code, for one) is gone. Reload onto the new version instead of failing; once per
  // minute at most, so a real outage cannot loop.
  window.addEventListener('vite:preloadError', (event) => {
    connLog('app files replaced by a deploy: reloading', {
      message: (event as Event & { payload?: Error }).payload?.message ?? '',
    });
    const KEY = 'bgf:reloaded-for-deploy';
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY) ?? 0);
    } catch {
      /* storage blocked: still reload, the guard just will not hold */
    }
    if (Date.now() - last < 60_000) return;
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    event.preventDefault();
    window.location.reload();
  });
}
