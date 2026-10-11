import { useEffect } from 'react';
import { useProfile } from '../session/ProfileProvider';
import { useSessionRegistry } from '../session/SessionRegistry';
import { isGameId } from '../games/ids';
import { connLog } from '../session/connLog';
import { withMailboxDevice } from '../mailbox/device';
import { processInbox } from '../mailbox/inbox';
import { pageInboxEnv } from '../mailbox/pageEnv';

const EVERY_MS = 30_000;
/** Posted by the service worker when a push arrived while a page was open. */
export const MAIL_MESSAGE = 'bgf:mail';
/** Dispatched on `window` to collect mail now. */
export const CHECK_MAIL_EVENT = 'bgf:mail-check';

/**
 * Collects this player's mail while the app is open: positions from tables played by mail, and
 * moves for tables this device hosts. Checked on opening, when the page comes back into view,
 * every half minute while it is in view, and whenever a push arrives.
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
    void run('opened');
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void run('timer');
    }, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run('visible');
    };
    const onWorker = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === MAIL_MESSAGE) void run('push');
    };
    // Anything in the page may ask for a check now (tests; a screen that expects mail).
    const onAsk = () => void run('asked');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHECK_MAIL_EVENT, onAsk);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CHECK_MAIL_EVENT, onAsk);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
    };
    // The registry object changes on every session change; reading it through the closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  return null;
}
