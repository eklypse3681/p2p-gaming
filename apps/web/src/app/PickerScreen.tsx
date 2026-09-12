import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import { createProfile, listProfiles, touchProfile, useProfilesIndex } from '../session/profiles';
import { profilePath } from '../session/ProfileProvider';
import { relativeTime } from '../session/time';
import { gamePath } from '../games/GameProvider';
import type { GameId } from '../games/ids';
import { DEFAULT_GAME } from '../games/ids';
import { getGame } from '../games/registry';
import styles from './PickerScreen.module.css';

/**
 * `#/` — who is playing in this tab? Every other route lives under the chosen player's slug.
 * With `#/<game>/join/:code` (an invite link) the chosen player goes straight to joining that
 * match; the profile-less legacy form `#/join/:code` means backgammon.
 */
export function PickerScreen({ game }: { game?: GameId } = {}) {
  const { code } = useParams();
  const navigate = useNavigate();
  const index = useProfilesIndex();
  const profiles = useMemo(() => listProfiles(), [index]); // eslint-disable-line react-hooks/exhaustive-deps
  const joining = code && isValidRoomCode(normalizeRoomCode(code)) ? normalizeRoomCode(code) : null;
  const gameId = game ?? DEFAULT_GAME;
  const gameName = getGame(gameId)?.name ?? gameId;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const choose = (slug: string) => {
    touchProfile(slug);
    navigate(joining ? gamePath(slug, gameId, `/join/${joining}`) : profilePath(slug, '/'));
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    try {
      const entry = createProfile(name);
      choose(entry.slug);
    } catch {
      setError('Could not create that player');
    }
  };

  const form = (
    <form className={`card ${styles.newCard}`} onSubmit={create} data-testid="new-profile-form">
      <div>
        <h2>{profiles.length ? 'New player' : 'Create your player'}</h2>
        <p className="muted small">
          Your name is what your opponent sees. It becomes part of the address, so the browser
          always knows who is playing in this tab.
        </p>
      </div>
      <div className={styles.newRow}>
        <input
          className="input"
          data-testid="new-profile-name"
          placeholder="Your name"
          value={name}
          maxLength={24}
          autoComplete="nickname"
          aria-label="New player name"
          aria-invalid={!!error}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <button className="btn btn-primary" type="submit" data-testid="new-profile-button">
          {joining ? 'Create and join' : 'Create'}
        </button>
      </div>
      {error && (
        <span className="error-text" role="alert" data-testid="new-profile-error">
          {error}
        </span>
      )}
    </form>
  );

  return (
    <div className="page page-narrow" data-testid="picker-screen">
      <div className="stack">
        <div className={styles.hero}>
          <div className="eyebrow">Peer-to-peer · no accounts · no servers</div>
          <h1>{joining ? "You're invited" : "Who's playing?"}</h1>
          {joining ? (
            <p className="muted" data-testid="picker-joining">
              Pick who you are and you'll join {gameName} match{' '}
              <code className="mono">{joining}</code>.
            </p>
          ) : (
            <p className="muted">
              Pick a player to continue. Open another player in a second tab to play both sides.
            </p>
          )}
        </div>

        {profiles.length === 0 && form}

        {profiles.length > 0 && (
          <div className={styles.list} data-testid="profile-list">
            {profiles.map((p) => (
              <button
                key={p.slug}
                type="button"
                className={`card ${styles.profile}`}
                onClick={() => choose(p.slug)}
                data-testid={`profile-${p.slug}`}
              >
                <span className={styles.avatar} aria-hidden="true">
                  {p.avatar}
                </span>
                <span className={styles.body}>
                  <span className={styles.name}>{p.name}</span>
                  <span className={styles.meta}>
                    <code>#/{p.slug}/</code> · {relativeTime(p.lastUsedAt)}
                  </span>
                </span>
                <span className={styles.go} aria-hidden="true">
                  {joining ? 'Join →' : 'Play →'}
                </span>
              </button>
            ))}
          </div>
        )}

        {profiles.length > 0 && form}
      </div>
    </div>
  );
}
