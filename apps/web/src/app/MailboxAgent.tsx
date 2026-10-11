import { useEffect } from 'react';
import { useProfile } from '../session/ProfileProvider';
import { useSessionRegistry } from '../session/SessionRegistry';
import { isGameId } from '../games/ids';
import { connLog } from '../session/connLog';
import { ensureMailboxDevice } from '../mailbox/device';
import { processInbox } from '../mailbox/inbox';
import { pageInboxEnv } from '../mailbox/pageEnv';

const EVERY_MS = 30_000;
/** Posted by the service worker when a push arrived while a page was open. */
export const MAIL_MESSAGE = 'bgf:mail';

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
        const device = await ensureMailboxDevice(slug);
        if (!device || stopped) return;
        const events = await processInbox(
          pageInboxEnv(slug, device, (game, id) =>
            isGameId(game) ? registry.get(slug, game, id) : undefined,
          ),
        );
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
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
    };
    // The registry object changes on every session change; reading it through the closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  return null;
}
