import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useProfile } from '../session/ProfileProvider';
import { useAllSavedMatches } from '../session/matchStore';
import { summarizeMatch, describeLength } from '../session/history';
import { relativeTime } from '../session/time';
import { GAMES, getGame } from '../games/registry';
import styles from './HubScreen.module.css';

/**
 * `#/<profile>/` — the games hub: one card per registered game, plus this player's in-progress
 * matches across all of them.
 */
export function HubScreen() {
  const navigate = useNavigate();
  const { profile, slug } = useProfile();
  const { byGame, loading } = useAllSavedMatches();

  const inProgress = useMemo(
    () =>
      byGame
        .flatMap(({ game, matches }) =>
          matches
            .map((m) => summarizeMatch(m, profile.id))
            .filter((r) => r !== null && r.outcome === 'in-progress')
            .map((r) => ({ game, row: r! })),
        )
        .sort((a, b) => b.row.updatedAt - a.row.updatedAt),
    [byGame, profile.id],
  );

  return (
    <div className="page" data-testid="games-hub" data-profile={slug}>
      <section className={`${styles.hero} fade-up`}>
        <div className="eyebrow">Peer-to-peer · no accounts · no servers</div>
        <h1>What are we playing?</h1>
        <p className={styles.playingAs} data-testid="playing-as">
          Playing as <span aria-hidden="true">{profile.avatar}</span>{' '}
          <strong>{profile.name}</strong>{' '}
          <span className="muted small">
            (<code>#/{slug}/</code>) · <Link to="/">switch player</Link>
          </span>
        </p>
      </section>

      <div className="stack">
        <div className={styles.grid}>
          {GAMES.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`card ${styles.gameCard}`}
              onClick={() => navigate(g.routes(slug).home)}
              data-testid={`game-card-${g.id}`}
            >
              <span className={styles.icon} aria-hidden="true">
                {g.icon}
              </span>
              <span className={styles.body}>
                <span className={styles.name}>{g.name}</span>
                <span className={styles.tagline}>{g.tagline}</span>
              </span>
              <span className={styles.go} aria-hidden="true">
                Play →
              </span>
            </button>
          ))}
          <div
            className={`card ${styles.gameCard} ${styles.soon}`}
            aria-disabled="true"
            data-testid="game-card-soon"
          >
            <span className={styles.icon} aria-hidden="true">
              ✨
            </span>
            <span className={styles.body}>
              <span className={styles.name}>More games coming</span>
              <span className={styles.tagline}>
                Every game plugs into the same players, transports and saved-match history.
              </span>
            </span>
          </div>
        </div>

        <section className="stack-sm">
          <div className={styles.rowHead}>
            <h2>Continue</h2>
            {inProgress.length > 0 && (
              <span className="badge">{inProgress.length} in progress</span>
            )}
          </div>
          {loading ? (
            <p className="muted small">Loading…</p>
          ) : inProgress.length === 0 ? (
            <p className="muted small" data-testid="hub-no-saved">
              No matches in progress. Pick a game above to host or join one.
            </p>
          ) : (
            <div className={styles.list}>
              {inProgress.map(({ game, row }) => {
                const def = getGame(game)!;
                return (
                  <div key={`${game}:${row.id}`} className={`card ${styles.match}`}>
                    <span className={styles.matchGame}>
                      <span aria-hidden="true">{def.icon}</span> {def.name}
                    </span>
                    <span className={styles.matchBody}>
                      <span className={styles.matchTitle}>
                        vs {row.opponentName}
                        {row.rules === 'free' && <span className="badge">Free</span>}
                      </span>
                      <span className="muted small">
                        {describeLength(row.length)} · {row.myScore}–{row.theirScore} · code{' '}
                        <code>{row.code}</code> · {relativeTime(row.updatedAt)}
                      </span>
                    </span>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate(def.routes(slug).game(row.id))}
                      data-testid={`hub-resume-${row.id}`}
                    >
                      Resume
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
