import { useEffect, useState } from 'react';
import { backupsAvailable, restoreWithPasskey } from '../session/passkey';
import { restoreFromPhrase } from '../session/recovery';
import { WalletError } from '@bgf/wallet';
import { describePasskeyError } from './SafetySection';

/** "Restore a player": sign in with the passkey they were saved with, or type their 24 words. */
export function RestorePanel({ onRestored }: { onRestored: (slug: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState(false);
  useEffect(() => {
    void backupsAvailable().then(setBackups);
  }, []);

  const run = (restore: () => Promise<string>, describe: (e: unknown) => string) => {
    setBusy(true);
    setError(null);
    restore()
      .then(onRestored)
      .catch((e: unknown) => setError(describe(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card stack" data-testid="restore-panel">
      <h2>Restore a player</h2>
      {backups && (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => restoreWithPasskey(), describePasskeyError)}
          data-testid="restore-passkey"
        >
          Use a passkey
        </button>
      )}
      <div className="field">
        <label className="label" htmlFor="restore-words">
          {backups ? 'Or type' : 'Type'} the 24 recovery words
        </label>
        <textarea
          id="restore-words"
          className="textarea"
          rows={3}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          data-testid="restore-words"
        />
      </div>
      <button
        className="btn btn-secondary"
        disabled={busy || words.trim().split(/\s+/).length < 24}
        onClick={() =>
          run(
            () => restoreFromPhrase(words),
            (e) => (e instanceof WalletError ? e.message : 'Those words did not restore a player.'),
          )
        }
        data-testid="restore-words-button"
      >
        Restore from words
      </button>
      {error && (
        <p className="error-text" role="alert" data-testid="restore-error">
          {error}
        </p>
      )}
    </section>
  );
}
