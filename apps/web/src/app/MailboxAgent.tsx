import { useEffect } from 'react';
import { useProfile } from '../session/ProfileProvider';
import { useSessionRegistry } from '../session/SessionRegistry';
import { isGameId } from '../games/ids';
import { connLog } from '../session/connLog';
import { withMailboxDevice } from '../mailbox/device';
import { processInbox } from '../mailbox/inbox';
import { pageInboxEnv } from '../mailbox/pageEnv';
import { CHECK_MAIL_EVENT } from '../mailbox/client';

/** Checked every 5 s for 30 s after there is reason to expect mail; never otherwise. */
export const FAST_MS = 5_000;
export const FAST_FOR_MS = 30_000;
/** Posted by the service worker when a push arrived while a page was open. */
export const MAIL_MESSAGE = 'bgf:mail';
export { CHECK_MAIL_EVENT };

/**
 * Collects this player's mail while the app is open: positions from tables played by mail, and
 * moves for tables this device hosts. Checked when a push arrives (the service worker says so),
 * and every 5 s for 30 s after the page opens, comes back into view, or a table goes on by mail.
 * Never on a timer beyond that: play while apart runs on pushes.
 */
export function MailboxAgent() {
  const { slug } = useProfile();
  const registry = useSessionRegistry();

  useEffect(() => {
    let stopped = false;
    let running = false;
    const run = async (why: string) => {
      if (stopped || running) return;
      running = true;
      try {
        const events =
          (await withMailboxDevice(slug, (device) =>
            processInbox(
              pageInboxEnv(slug, device, (game, id) =>
                isGameId(game) ? registry.get(slug, game, id) : undefined,
              ),
            ),
          )) ?? [];
        if (events.length)
          connLog('mailbox: collected', { why, events: events.map((e) => e.kind) });
      } catch (e) {
        connLog('mailbox: could not collect', {
          why,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        running = false;
      }
    };
    let fastUntil = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (stopped || Date.now() + FAST_MS > fastUntil) return;
      timer = setTimeout(() => {
        timer = null;
        const check = document.visibilityState === 'visible' ? run('timer') : Promise.resolve();
        void check.finally(schedule);
      }, FAST_MS);
    };
    /** Check now, then every 5 s for 30 s. */
    const burst = (why: string) => {
      fastUntil = Date.now() + FAST_FOR_MS;
      void run(why);
      schedule();
    };
    burst('opened');
    const onVisible = () => {
      if (document.visibilityState === 'visible') burst('visible');
    };
    const onWorker = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === MAIL_MESSAGE) void run('push');
    };
    // Anything in the page may ask for a check now (a table that just went on by mail; tests).
    const onAsk = () => burst('asked');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHECK_MAIL_EVENT, onAsk);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CHECK_MAIL_EVENT, onAsk);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
    };
    // The registry object changes on every session change; reading it through the closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  return null;
}
