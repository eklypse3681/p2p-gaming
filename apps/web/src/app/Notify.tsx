import { useCallback, useEffect, useState } from 'react';
import { useProfile } from '../session/ProfileProvider';
import { mailboxStatus } from '../mailbox/client';
import type { EnableResult } from '../mailbox/notifications';
import {
  disableNotifications,
  enableNotifications,
  notificationsOn,
  notifySupport,
} from '../mailbox/notifications';
import styles from './SavePlayerPrompt.module.css';

const OPEN_EVENT = 'bgf:notify-open';
const CHANGED_EVENT = 'bgf:notify-changed';

/** Open the "notify me" dialog from anywhere (a menu item, a banner). */
export function openNotifyDialog(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/**
 * Whether turn notifications are on for this player here, and whether they could be (the site
 * has a mailbox with push). `null` while checking.
 */
export function useNotifications(): { on: boolean | null; possible: boolean } {
  const { slug } = useProfile();
  const [on, setOn] = useState<boolean | null>(null);
  const [possible, setPossible] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => {
      void Promise.all([notificationsOn(slug), mailboxStatus()]).then(([o, s]) => {
        if (!live) return;
        setOn(o);
        setPossible(!!s.vapidKey && notifySupport() !== 'unsupported');
      });
    };
    check();
    window.addEventListener(CHANGED_EVENT, check);
    return () => {
      live = false;
      window.removeEventListener(CHANGED_EVENT, check);
    };
  }, [slug]);
  return { on, possible };
}

const MESSAGES: Record<Exclude<EnableResult, 'on'>, string> = {
  denied:
    'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.',
  unavailable: 'Notifications are not available here yet.',
  'needs-home-screen': '',
  failed: 'That did not work. Try again in a moment.',
};

/**
 * The dialog behind "Notify me when it's my turn". On an iPhone in Safari it explains the one
 * step iOS needs first (Add to Home Screen); everywhere else one tap asks for permission.
 */
export function NotifyDialog() {
  const { slug } = useProfile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = () => {
      setNote(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const enable = useCallback(() => {
    setBusy(true);
    void enableNotifications(slug)
      .then((r) => {
        if (r === 'on') {
          window.dispatchEvent(new Event(CHANGED_EVENT));
          setOpen(false);
        } else {
          setNote(MESSAGES[r]);
        }
      })
      .finally(() => setBusy(false));
  }, [slug]);
  if (!open) return null;
  const homeScreen = notifySupport() === 'needs-home-screen';
  return (
    <div className={styles.scrim} data-testid="notify-dialog">
      <div className={`card ${styles.card}`} role="dialog" aria-label="Turn notifications">
        <h2>Know when it’s your turn</h2>
        {homeScreen ? (
          <>
            <p>On iPhone, notifications come to Among Friends once it is on your Home Screen:</p>
            <ol style={{ textAlign: 'left', margin: 0 }}>
              <li>
                Tap <strong>Share</strong> (the square with an arrow).
              </li>
              <li>
                Choose <strong>Add to Home Screen</strong>.
              </li>
              <li>Open Among Friends from the new icon and turn notifications on there.</li>
            </ol>
            <button
              className="btn btn-primary"
              onClick={() => setOpen(false)}
              data-testid="notify-ok"
            >
              Got it
            </button>
          </>
        ) : (
          <>
            <p>Play at your own pace: we’ll let you know when someone has played.</p>
            <button
              className="btn btn-primary btn-lg"
              disabled={busy}
              onClick={enable}
              data-testid="notify-enable"
            >
              {busy ? 'Turning on…' : 'Turn on notifications'}
            </button>
            {note && (
              <p className="small" role="status" data-testid="notify-note">
                {note}
              </p>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The Settings row: on/off for this player on this device. */
export function NotifySetting() {
  const { slug } = useProfile();
  const { on, possible } = useNotifications();
  const [busy, setBusy] = useState(false);
  if (!possible) return null;
  return (
    <section className="card" style={{ display: 'grid', gap: 8 }} data-testid="notify-section">
      <h2>Turn notifications</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Get a notification on this device when it is your turn, even with the app closed.
      </p>
      <div>
        {on ? (
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void disableNotifications(slug)
                .then(() => window.dispatchEvent(new Event(CHANGED_EVENT)))
                .finally(() => setBusy(false));
            }}
            data-testid="notify-off"
          >
            Turn off
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={openNotifyDialog}
            data-testid="notify-on"
          >
            Turn on
          </button>
        )}
      </div>
    </section>
  );
}
