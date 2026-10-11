import { useSyncExternalStore } from 'react';
import type { MailRelay } from '../../mailbox/offline';
import { openNotifyDialog, useNotifications } from '../../app/Notify';

/** Moves mailed to the absent host and not yet answered (0 without a relay). */
export function useMailPending(relay: MailRelay | undefined): number {
  return useSyncExternalStore(
    (l) => relay?.subscribe(l) ?? (() => {}),
    () => relay?.pending ?? 0,
  );
}

/** The status line at a table played by mail. */
export function byMailStatus(relay: MailRelay, pending: number, status: string): string {
  return pending > 0
    ? `Sent to ${relay.hostName} by mail`
    : `${relay.hostName} is away · ${status}`;
}

/** "Notify me", beside the status line while playing by mail with notifications off. */
export function ByMailNotify() {
  const notify = useNotifications();
  if (!notify.possible || notify.on !== false) return null;
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={openNotifyDialog}
      data-testid="by-mail-notify"
    >
      Notify me
    </button>
  );
}
