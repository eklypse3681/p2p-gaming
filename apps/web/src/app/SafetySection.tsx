import { useEffect, useState } from 'react';
import { useProfile } from '../session/ProfileProvider';
import { canPairDevices } from '../session/pairing';
import {
  PasskeyError,
  backupsAvailable,
  passkeysLikelyWork,
  saveWithPasskey,
} from '../session/passkey';
import { phraseFor } from '../session/recovery';
import { relativeTime } from '../session/time';
import styles from './SettingsScreen.module.css';

export function describePasskeyError(e: unknown): string {
  if (!(e instanceof PasskeyError)) return 'Something went wrong. Try again.';
  switch (e.code) {
    case 'cancelled':
      return 'Cancelled.';
    case 'no-prf':
    case 'unsupported':
      return 'This browser or passkey can’t protect a backup. Write down your recovery words instead.';
    case 'network':
      return 'Could not reach amongfriends.gg. Check the connection and try again.';
    case 'no-backup':
      return 'No player is saved with that passkey.';
    case 'damaged':
      return 'That backup could not be opened.';
    case 'not-yours':
      return 'Save from the device that holds this player’s own key.';
  }
}

/**
 * "Don't lose this player": a passkey backup (Face ID, a fingerprint) and, for players whose id
 * comes from their seed, the recovery words. Shown only where this device holds the player's own
 * key; a paired device has nothing to back up.
 */
export function SafetySection() {
  const { slug, record } = useProfile();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showWords, setShowWords] = useState(false);
  const [passkeysOk, setPasskeysOk] = useState(true);
  const [backups, setBackups] = useState(false);
  useEffect(() => {
    void passkeysLikelyWork().then(setPasskeysOk);
    void backupsAvailable().then(setBackups);
  }, []);
  if (!canPairDevices(slug)) return null;
  const words = phraseFor(slug);
  const saved = (record.passkeys ?? []).at(-1);

  const save = () => {
    setBusy(true);
    setNote(null);
    saveWithPasskey(slug)
      .then(() => setNote(`${record.name} is saved. Sign in with this passkey on any device.`))
      .catch((e: unknown) => setNote(describePasskeyError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={`card ${styles.section}`} data-testid="safety-section">
      <h2>Don’t lose {record.name}</h2>
      {backups && (
        <>
          <div className={styles.rowField}>
            <div className={styles.rowText}>
              Save with a passkey
              <small>
                {saved
                  ? `Saved ${relativeTime(saved.createdAt)}. On a new device, choose “Restore a player” and use the same passkey.`
                  : 'Face ID, a fingerprint or your computer’s sign-in. Your passkey is kept by Apple, Google or your password manager, so a lost device loses nothing.'}
              </small>
            </div>
            <button
              className={`btn btn-sm ${saved ? 'btn-ghost' : 'btn-primary'}`}
              disabled={busy || !passkeysOk}
              onClick={save}
              data-testid="save-passkey"
            >
              {busy ? 'Saving…' : saved ? 'Save again' : 'Save with a passkey'}
            </button>
          </div>
          {!passkeysOk && (
            <p className="muted small">
              This browser can’t use passkeys for this; use the words below.
            </p>
          )}
          {note && (
            <p className="small" role="status" data-testid="passkey-note">
              {note}
            </p>
          )}
        </>
      )}
      {words && (
        <div className="stack">
          <div className={styles.rowField}>
            <div className={styles.rowText}>
              Recovery words
              <small>
                24 words that are {record.name}. Write them on paper and keep them somewhere safe;
                anyone who has them can play as you.
              </small>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowWords((v) => !v)}
              data-testid="toggle-words"
            >
              {showWords ? 'Hide' : 'Show words'}
            </button>
          </div>
          {showWords && (
            <ol className={styles.words} data-testid="recovery-words">
              {words.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
