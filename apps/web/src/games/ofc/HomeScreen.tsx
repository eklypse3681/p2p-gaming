import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { useSavedSnapshots } from '../../session/matchStore';
import { extractCode } from '../../session/links';
import { relativeTime } from '../../session/time';
import type { OfcSnapshot } from './history';
import { summarizeTable } from './history';
import { variantName } from './rules/describe';
import styles from '../backgammon/HomeScreen.module.css';

export function HomeScreen() {
  const navigate = useNavigate();
  const { profile, slug } = useProfile();
  const { path, id: gameId } = useGame();
  const { matches, loading, remove } = useSavedSnapshots<OfcSnapshot>(gameId);
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const rows = useMemo(
    () => matches.map((m) => summarizeTable(m, profile.id)).filter((r) => r !== null),
    [matches, profile.id],
  );
  const inProgress = rows.filter((r) => r.status !== 'over');
  const finished = rows.filter((r) => r.status === 'over').slice(0, 8);

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
        <h1>Open Face Chinese Poker, dealt between browsers.</h1>
        <p className={styles.tagline}>
          OFC, Pineapple or Pineapple 2-7 for two or three players. Set every rule yourself, keep a
          ledger, settle up whenever you like.
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
              <span aria-hidden="true">🃏</span> Host a table
            </h2>
            <p className="muted">
              Your browser deals. Pick the variant and every rule, then share the code.
            </p>
            <div>
              <button
                className="btn btn-primary btn-lg"
                onClick={() => navigate(path('/host'))}
                data-testid="host-button"
              >
                Host a new table
              </button>
            </div>
          </section>
          <section className={`card ${styles.actionCard}`}>
            <h2>
              <span aria-hidden="true">🔗</span> Join a table
            </h2>
            <p className="muted">Paste the code or the invite link the host sent you.</p>
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
            <div className={styles.empty}>Loading saved tables…</div>
          ) : inProgress.length === 0 ? (
            <div className={styles.empty} data-testid="no-saved">
              No tables in progress. Host one or join a friend's.
            </div>
          ) : (
            <div className={styles.savedList}>
              {inProgress.map((r) => (
                <div key={r.id} className={styles.saved} data-testid={`saved-game-${r.id}`}>
                  <div
                    className={styles.savedScore}
                    style={{
                      color:
                        r.myNet > 0
                          ? 'var(--ui-success)'
                          : r.myNet < 0
                            ? 'var(--ui-danger)'
                            : undefined,
                    }}
                  >
                    {r.myNet > 0 ? `+${r.myNet}` : r.myNet}
                  </div>
                  <div className={styles.savedBody}>
                    <span className={styles.savedTitle}>
                      {r.opponents.length
                        ? `with ${r.opponents.map((o) => o.name).join(', ')}`
                        : 'Waiting for players'}
                      <span className="badge badge-outline-accent" style={{ marginLeft: 8 }}>
                        {variantName(r.config.variant)}
                      </span>
                    </span>
                    <span className={styles.savedMeta}>
                      {r.hands} hand{r.hands === 1 ? '' : 's'} · code {r.code} ·{' '}
                      {relativeTime(r.updatedAt)}
                      {r.snapshot.view ? ' · hosted elsewhere' : ''}
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
                      aria-label="Delete table"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Delete this table from your browser? This cannot be undone.',
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
              <h2>Recent tables</h2>
              <Link to={path('/history')} className="small">
                Full history →
              </Link>
            </div>
            <div className={styles.results}>
              {finished.map((r) => (
                <Link
                  key={r.id}
                  to={path(`/history?match=${r.id}`)}
                  className={`${styles.result} ${r.myNet >= 0 ? styles.resultWon : styles.resultLost}`}
                >
                  <span className="small muted">
                    with {r.opponents.map((o) => o.name).join(', ')}
                  </span>
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {r.myNet > 0 ? `+${r.myNet}` : r.myNet} pts
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
