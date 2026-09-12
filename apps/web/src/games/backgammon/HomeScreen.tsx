import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { useSavedMatches } from '../../session/matchStore';
import { summarizeMatch, describeLength } from '../../session/history';
import { extractCode } from '../../session/links';
import { relativeTime } from '../../session/time';
import styles from './HomeScreen.module.css';

export function HomeScreen() {
  const navigate = useNavigate();
  const { profile, slug } = useProfile();
  const { path, id: gameId } = useGame();
  const { matches, loading, remove } = useSavedMatches(gameId);
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const rows = useMemo(
    () => matches.map((m) => summarizeMatch(m, profile.id)).filter((r) => r !== null),
    [matches, profile.id],
  );
  const inProgress = rows.filter((r) => r.outcome === 'in-progress');
  const finished = rows.filter((r) => r.outcome !== 'in-progress').slice(0, 8);

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeRoomCode(extractCode(joinInput));
    if (!isValidRoomCode(code)) {
      setJoinError('Enter the 6-character room code or paste the invite link');
      return;
    }
    setJoinError(null);
    navigate(path(`/join/${code}`));
  };

  return (
    <div className="page" data-testid="home-screen" data-profile={slug} data-game={gameId}>
      <section className={`${styles.hero} fade-up`}>
        <div className="eyebrow">Peer-to-peer · no accounts · no servers</div>
        <h1>Backgammon, straight from your browser to theirs.</h1>
        <p className={styles.tagline}>
          Host a match, share a six-letter code, and play. Games save themselves on both sides so
          you can pause and pick up days later.
        </p>
        <p className={styles.playingAs} data-testid="playing-as">
          Playing as <span aria-hidden="true">{profile.avatar}</span>{' '}
          <strong>{profile.name}</strong>{' '}
          <span className="muted small">
            (<code>#/{slug}/</code>) · <Link to={`/${slug}/`}>all games</Link> ·{' '}
            <Link to="/">switch player</Link>
          </span>
        </p>
      </section>

      <div className="stack">
        <div className={styles.actions}>
          <section className={`card ${styles.actionCard}`}>
            <h2>
              <span aria-hidden="true">🎲</span> Host a match
            </h2>
            <p className="muted">
              Your browser runs the table. Choose the match length and share the code.
            </p>
            <div>
              <button
                className="btn btn-primary btn-lg"
                onClick={() => navigate(path('/host'))}
                data-testid="host-button"
              >
                Host a new match
              </button>
            </div>
          </section>
          <section className={`card ${styles.actionCard}`}>
            <h2>
              <span aria-hidden="true">🔗</span> Join a match
            </h2>
            <p className="muted">Paste the code or the invite link your opponent sent you.</p>
            <form className={styles.joinForm} onSubmit={onJoin}>
              <input
                className={`input ${styles.joinInput}`}
                data-testid="join-code-input"
                placeholder="ABC123"
                value={joinInput}
                onChange={(e) => {
                  setJoinInput(e.target.value);
                  setJoinError(null);
                }}
                aria-label="Room code or invite link"
                aria-invalid={!!joinError}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="btn btn-primary" type="submit" data-testid="join-button">
                Join
              </button>
            </form>
            {joinError && (
              <span className="error-text" data-testid="join-error">
                {joinError}
              </span>
            )}
          </section>
        </div>

        <section className={styles.section} data-testid="continue-section">
          <div className="card-title">
            <h2>Continue</h2>
            {inProgress.length > 0 && (
              <span className="badge">{inProgress.length} in progress</span>
            )}
          </div>
          {loading ? (
            <div className={styles.empty}>Loading saved matches…</div>
          ) : inProgress.length === 0 ? (
            <div className={styles.empty} data-testid="no-saved">
              No matches in progress. Host one or join a friend's.
            </div>
          ) : (
            <div className={styles.savedList}>
              {inProgress.map((r) => (
                <div key={r.id} className={styles.saved} data-testid={`saved-game-${r.id}`}>
                  <div className={styles.savedScore}>
                    {r.myScore}–{r.theirScore}
                  </div>
                  <div className={styles.savedBody}>
                    <span className={styles.savedTitle}>
                      vs {r.opponentName}
                      {r.rules === 'free' && (
                        <span
                          className="badge badge-outline-accent"
                          style={{ marginLeft: 8 }}
                          data-testid="saved-rules-free"
                        >
                          Free
                        </span>
                      )}
                    </span>
                    <span className={styles.savedMeta}>
                      {describeLength(r.length)} · code {r.code} · {relativeTime(r.updatedAt)}
                    </span>
                  </div>
                  <div className={styles.savedActions}>
                    <button
                      className="btn btn-primary btn-sm"
                      data-testid={`resume-${r.id}`}
                      onClick={() => navigate(path(`/game/${r.id}`))}
                    >
                      Resume
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      data-testid={`delete-${r.id}`}
                      aria-label={`Delete match vs ${r.opponentName}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete the match against ${r.opponentName}? This cannot be undone.`,
                          )
                        ) {
                          void remove(r.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {finished.length > 0 && (
          <section className={styles.section} data-testid="recent-results">
            <div className="card-title">
              <h2>Recent results</h2>
              <Link to={path('/history')} className="small">
                Full history →
              </Link>
            </div>
            <div className={styles.results}>
              {finished.map((r) => (
                <Link
                  key={r.id}
                  to={path(`/history?match=${r.id}`)}
                  className={`${styles.result} ${r.outcome === 'won' ? styles.resultWon : styles.resultLost}`}
                >
                  <span className="small muted">vs {r.opponentName}</span>
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {r.myScore}–{r.theirScore}{' '}
                    <span
                      className={r.outcome === 'won' ? 'badge badge-success' : 'badge badge-danger'}
                    >
                      {r.outcome}
                    </span>
                  </span>
                  <span className="small muted">{relativeTime(r.updatedAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
