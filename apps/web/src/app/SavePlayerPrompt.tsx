import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useProfile } from '../session/ProfileProvider';
import { canPairDevices } from '../session/pairing';
import { backupsAvailable, passkeysLikelyWork, saveWithPasskey } from '../session/passkey';
import { describePasskeyError } from './SafetySection';
import styles from './SavePlayerPrompt.module.css';

const laterKey = (slug: string) => `bgf:save-prompt-later:${slug}`;
const offKey = (slug: string) => `bgf:save-prompt-off:${slug}`;

function flag(store: () => Storage, key: string): boolean {
  try {
    return store().getItem(key) === '1';
  } catch {
    return false;
  }
}
function setFlag(store: () => Storage, key: string): void {
  try {
    store().setItem(key, '1');
  } catch {
    // private mode: the prompt simply comes back
  }
}

const appleDevice = () => /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? '');

/**
 * Asks a player who has no passkey yet to save one. It leans toward yes: one big button, "Not now"
 * only until the app is next opened, and a quiet way out for test players. Never over a table.
 */
export function SavePlayerPrompt() {
  const { slug, record, path } = useProfile();
  const { pathname } = useLocation();
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(
    () => flag(() => sessionStorage, laterKey(slug)) || flag(() => localStorage, offKey(slug)),
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const needed = canPairDevices(slug) && !(record.passkeys ?? []).length;

  useEffect(() => {
    if (!needed || hidden) return;
    let live = true;
    void Promise.all([backupsAvailable(), passkeysLikelyWork()]).then(([b, p]) => {
      if (live) setReady(b && p);
    });
    return () => {
      live = false;
    };
  }, [needed, hidden]);

  if (!needed || hidden || !ready || pathname.includes('/game/')) return null;

  const save = () => {
    setBusy(true);
    setNote(null);
    saveWithPasskey(slug)
      .then(() => setHidden(true))
      .catch((e: unknown) => setNote(describePasskeyError(e)))
      .finally(() => setBusy(false));
  };
  const later = () => {
    setFlag(() => sessionStorage, laterKey(slug));
    setHidden(true);
  };
  const off = () => {
    setFlag(() => localStorage, offKey(slug));
    setHidden(true);
  };

  return (
    <div className={styles.scrim} data-testid="save-player-prompt">
      <div className={`card ${styles.card}`} role="dialog" aria-label={`Save ${record.name}`}>
        <h2>Save {record.name}</h2>
        <p>
          Keep {record.name} with your passkey, so a lost or new phone, or the Home Screen app,
          signs straight back in.
        </p>
        <button
          className="btn btn-primary btn-lg"
          disabled={busy}
          onClick={save}
          data-testid="save-player-now"
        >
          {busy ? 'Saving…' : appleDevice() ? 'Save with Face ID' : 'Save with a passkey'}
        </button>
        {note && (
          <p className="small" role="status" data-testid="save-player-note">
            {note}{' '}
            <Link to={path('/settings')} onClick={later}>
              Recovery words
            </Link>
          </p>
        )}
        <button className="btn btn-ghost btn-sm" onClick={later} data-testid="save-player-later">
          Not now
        </button>
        <button className={styles.quiet} onClick={off} data-testid="save-player-off">
          This is a test player — don’t ask
        </button>
      </div>
    </div>
  );
}
