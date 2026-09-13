import { useState } from 'react';
import type { FormEvent } from 'react';
import { unlockProfile } from './profiles';

/**
 * Password prompt for a locked player. Used in place of a locked profile's routes and inline in
 * the picker. Calls `onUnlocked` once the password opens the secrets for this tab.
 */
export function UnlockPrompt({
  slug,
  name,
  avatar,
  onUnlocked,
  onCancel,
}: {
  slug: string;
  name: string;
  avatar?: string;
  onUnlocked: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter the password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await unlockProfile(slug, password);
      if (ok) onUnlocked();
      else setError('Wrong password');
    } catch {
      setError('Could not unlock this player');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit} data-testid="unlock-prompt">
      <div>
        <div className="eyebrow">Locked player</div>
        <h2>
          {avatar ? <span aria-hidden="true">{avatar} </span> : null}
          {name}
        </h2>
        <p className="muted small">
          This player is protected by a password on this browser. Enter it to play as {name} in this
          tab.
        </p>
      </div>
      <label className="field">
        <span className="label">Password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="unlock-password"
          autoFocus
        />
      </label>
      <div className="row">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy}
          data-testid="unlock-button"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {onCancel && (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={onCancel}
            data-testid="unlock-cancel"
          >
            Cancel
          </button>
        )}
      </div>
      {error && (
        <span className="error-text" role="alert" data-testid="unlock-error">
          {error}
        </span>
      )}
    </form>
  );
}
