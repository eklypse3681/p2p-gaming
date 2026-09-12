import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { useSavedMatches } from '../../session/matchStore';
import { computeStats, describeLength, summarizeMatch } from '../../session/history';
import type { MatchRow } from '../../session/history';
import { formatDate, relativeTime } from '../../session/time';
import { kindLabel } from '../../hud/derive';
import styles from './HistoryScreen.module.css';

function Stat({ k, v, sub }: { k: string; v: string | number; sub?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statK}>{k}</span>
      <span className={styles.statV}>{v}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

function pct(won: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((won / total) * 100)}%`;
}

export function HistoryScreen() {
  const { profile } = useProfile();
  const { path, id: gameId } = useGame();
  const { matches, loading, remove } = useSavedMatches(gameId);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = params.get('match');

  const rows = useMemo(
    () =>
      matches.map((m) => summarizeMatch(m, profile.id)).filter((r): r is MatchRow => r !== null),
    [matches, profile.id],
  );
  const stats = useMemo(() => computeStats(rows), [rows]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('match', id);
    else next.delete('match');
    setParams(next, { replace: true });
  };

  return (
    <div className="page" data-testid="history-screen">
      <div className="stack">
        <div>
          <div className="eyebrow">Personal history</div>
          <h1>Your record</h1>
          <p className="muted">
            Everything here lives in this browser. Nothing is uploaded anywhere.
          </p>
        </div>

        <div className={styles.stats} data-testid="history-stats">
          <Stat
            k="Matches"
            v={`${stats.matchesWon}–${stats.matchesLost}`}
            sub={`${pct(stats.matchesWon, stats.matchesPlayed)} won · ${stats.matchesInProgress} in progress`}
          />
          <Stat
            k="Games"
            v={`${stats.gamesWon}–${stats.gamesLost}`}
            sub={`${pct(stats.gamesWon, stats.gamesWon + stats.gamesLost)} won`}
          />
          <Stat k="Points" v={`${stats.pointsFor}–${stats.pointsAgainst}`} sub="for – against" />
          <Stat k="Gammons" v={`${stats.gammonsFor}–${stats.gammonsAgainst}`} sub="for – against" />
          <Stat
            k="Backgammons"
            v={`${stats.backgammonsFor}–${stats.backgammonsAgainst}`}
            sub="for – against"
          />
        </div>

        <div className={`${styles.layout} ${selected ? styles.layoutDetail : ''}`}>
          <section className="card">
            <div className="card-title">
              <h2>Matches</h2>
              <span className="muted small">{rows.length} saved</span>
            </div>
            {loading ? (
              <p className="muted">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="muted" data-testid="history-empty">
                No matches yet. <Link to={path('/')}>Host or join one</Link> to get started.
              </p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="history-list">
                  <thead>
                    <tr>
                      <th>Opponent</th>
                      <th>Result</th>
                      <th>Score</th>
                      <th>Length</th>
                      <th>Last played</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className={`${styles.rowBtn} ${r.id === selectedId ? styles.rowActive : ''}`}
                        onClick={() => select(r.id === selectedId ? null : r.id)}
                        data-testid={`history-row-${r.id}`}
                      >
                        <td>{r.opponentName}</td>
                        <td>
                          <span
                            className={`badge ${r.outcome === 'won' ? 'badge-success' : r.outcome === 'lost' ? 'badge-danger' : ''}`}
                          >
                            {r.outcome === 'in-progress' ? 'In progress' : r.outcome}
                          </span>
                        </td>
                        <td className="mono">
                          {r.myScore}–{r.theirScore}
                        </td>
                        <td>
                          {describeLength(r.length)}
                          {r.rules === 'free' && (
                            <span
                              className="badge badge-outline-accent"
                              style={{ marginLeft: 6 }}
                              data-testid="history-rules-free"
                            >
                              Free
                            </span>
                          )}
                        </td>
                        <td title={formatDate(r.updatedAt)}>{relativeTime(r.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {selected && (
            <section className={`card ${styles.detail}`} data-testid="history-detail">
              <div className="card-title">
                <h2>vs {selected.opponentName}</h2>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => select(null)}
                  aria-label="Close details"
                >
                  ✕
                </button>
              </div>
              <div className="row">
                <span className="badge">{describeLength(selected.length)}</span>
                {selected.rules === 'free' && (
                  <span className="badge badge-outline-accent">Free board</span>
                )}
                <span className="badge">Code {selected.code}</span>
                <span className="muted small">
                  {formatDate(selected.createdAt)} → {formatDate(selected.updatedAt)}
                </span>
              </div>
              <div className="mono" style={{ fontSize: '1.6rem', fontWeight: 700 }}>
                {selected.myScore}–{selected.theirScore}
                <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
                  you – them
                </span>
              </div>
              <div className={styles.games}>
                {selected.games.length === 0 && (
                  <span className="muted small">No games finished yet.</span>
                )}
                {selected.games.map((g) => {
                  const won = g.result.winner === selected.mySeat;
                  return (
                    <div key={g.number} className={styles.game} data-testid="history-game">
                      <span className="muted">#{g.number}</span>
                      <span>
                        {won ? 'Won' : 'Lost'} · {kindLabel(g.result.kind).toLowerCase()}
                        {g.result.how === 'drop'
                          ? ' (cube dropped)'
                          : g.result.how === 'resign'
                            ? ' (resigned)'
                            : g.result.how === 'recorded'
                              ? ' (recorded)'
                              : ''}
                        {g.crawford ? ' · Crawford' : ''}
                      </span>
                      <span className="mono">
                        {won ? '+' : '−'}
                        {g.result.points}
                      </span>
                      <span className="mono muted">
                        {g.scoreAfter[selected.mySeat]}–{g.scoreAfter[selected.theirSeat]}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="row">
                {selected.outcome === 'in-progress' && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => navigate(path(`/game/${selected.id}`))}
                  >
                    Resume
                  </button>
                )}
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    if (window.confirm('Delete this match from your history?')) {
                      void remove(selected.id).then(() => select(null));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </section>
          )}
        </div>

        {stats.opponents.length > 0 && (
          <section className="card">
            <div className="card-title">
              <h2>Head to head</h2>
            </div>
            <div className={styles.opps} data-testid="head-to-head">
              {stats.opponents.map((o) => (
                <div key={o.id} className={styles.opp}>
                  <span style={{ fontWeight: 650 }}>{o.name}</span>
                  <span className="mono" title="Matches won–lost">
                    M {o.matchesWon}–{o.matchesLost}
                  </span>
                  <span className="mono" title="Games won–lost">
                    G {o.gamesWon}–{o.gamesLost}
                  </span>
                  <span className="mono" title="Points for–against">
                    P {o.pointsFor}–{o.pointsAgainst}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
