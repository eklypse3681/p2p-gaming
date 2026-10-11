import { useSyncExternalStore } from 'react';
import type { MailRelay } from '../../mailbox/offline';
import { openNotifyDialog, useNotifications } from '../../app/Notify';
import styles from './GameScreen.module.css';

/** On a table played by mail: the host is away, where moves go, and the offer to be notified. */
export function ByMailBanner({ relay }: { relay: MailRelay }) {
  const pending = useSyncExternalStore(
    (l) => relay.subscribe(l),
    () => relay.pending,
  );
  const notify = useNotifications();
  return (
    <div className={styles.banner} role="status" data-testid="by-mail-banner">
      <span>
        {pending > 0 ? (
          <>
            Sent to <strong>{relay.hostName}</strong>. Their device will deal the next cards.
          </>
        ) : (
          <>
            <strong>{relay.hostName}</strong> is away: your moves go to them by mail.
          </>
        )}
      </span>
      {notify.possible && notify.on === false && (
        <button
          className="btn btn-primary btn-sm"
          onClick={openNotifyDialog}
          data-testid="by-mail-notify"
        >
          Notify me
        </button>
      )}
    </div>
  );
}
