import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { describeError, useResource } from '../api/useApi';
import { useToast } from '../components/Toast';
import { GAME_ICON, GAME_NAME } from '../pages/TablesPage';
import { platformApi, subscribeClubEvents } from './api';
import type { MatchmakingStatus } from './api';
import { fmtChips, fmtTime, shortId } from './format';
import { useSession } from './session';

/** Queue waits are seconds-to-minutes; show them the way an operator reads a clock. */
function fmtWait(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Totals run into the thousands on a busy night; group them. */
const fmtCount = (n: number): string => n.toLocaleString();

const REFRESH_MS = 2_000;

/**
 * The house club: the platform's own play-money club, where anyone can join, everyone gets an
 * opening stack and the matchmaker seats them. It is an ordinary club, so the per-club pages still
 * work on it; this page is the parts only the flagship has — the queue, matchmaking controls, the
 * faucet and who is playing right now.
 */
export function HousePage() {
  const { status } = useSession();
  const house = status?.house ?? null;
  const clubId = house?.clubId ?? '';
  const toast = useToast();

  const club = useResource(
    () => (clubId ? platformApi.club(clubId) : Promise.resolve(null)),
    clubId,
  );
  const mm = useResource(
    () => (clubId ? platformApi.matchmaking(clubId) : Promise.resolve(null)),
    clubId,
  );
  const ratings = useResource(
    () => (clubId ? platformApi.ratings(clubId) : Promise.resolve(null)),
    clubId,
  );
  const grants = useResource(
    () =>
      clubId ? platformApi.ledger(clubId, { limit: 10, kind: 'grant' }) : Promise.resolve(null),
    clubId,
  );
  const [live, setLive] = useState<'open' | 'error' | 'idle'>('idle');
  const [busy, setBusy] = useState<string | null>(null);

  const refreshClub = club.refresh;
  const refreshMm = mm.refresh;
  const refreshGrants = grants.refresh;
  const refreshRatings = ratings.refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The queue turns over faster than events arrive, so poll the metrics; the club itself (tables,
  // members, grants) follows the event feed.
  useEffect(() => {
    if (!clubId) return;
    const id = setInterval(() => void refreshMm(), REFRESH_MS);
    return () => clearInterval(id);
  }, [clubId, refreshMm]);

  useEffect(() => {
    if (!clubId) return;
    const unsubscribe = subscribeClubEvents(
      clubId,
      () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void refreshClub();
          void refreshGrants();
          void refreshRatings();
        }, 300);
      },
      (state) => setLive(state),
    );
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [clubId, refreshClub, refreshGrants, refreshRatings]);

  const control = useCallback(
    async (action: 'pause' | 'resume' | 'drain') => {
      if (
        action === 'drain' &&
        !window.confirm('Drain the queue? Everyone waiting is told the club is unavailable.')
      )
        return;
      setBusy(action);
      try {
        const next = await platformApi.matchmakingControl(clubId, action);
        mm.setData(next);
        toast(
          action === 'drain'
            ? `Queue drained (${next.drained ?? 0} waiting)`
            : action === 'pause'
              ? 'Matchmaking paused'
              : 'Matchmaking resumed',
        );
      } catch (e) {
        toast(describeError(e), 'error');
      } finally {
        setBusy(null);
      }
    },
    [clubId, mm, toast],
  );

  const detail = club.data;
  const nameOf = useCallback(
    (memberId: string) => detail?.members.find((m) => m.id === memberId)?.name ?? shortId(memberId),
    [detail],
  );
  const q: MatchmakingStatus | null = mm.data;
  const board = useMemo(() => {
    const games = Object.entries(ratings.data ?? {});
    return games
      .map(([game, byMember]) => ({
        game,
        rows: Object.entries(byMember)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5),
      }))
      .filter((g) => g.rows.length > 0)
      .sort((a, b) => a.game.localeCompare(b.game));
  }, [ratings.data]);
  const seated = (detail?.tables ?? []).reduce(
    (a, t) => a + t.seats.filter((s) => s !== null).length,
    0,
  );

  if (!house)
    return (
      <main className="page" data-testid="house-page">
        <div className="page-head">
          <div>
            <span className="eyebrow">House</span>
            <h1>No house club</h1>
            <p className="muted">
              This platform runs without one. Start the server with <code>P2P_HOUSE_CLUB=1</code> to
              host the public play-money club.
            </p>
          </div>
        </div>
      </main>
    );

  return (
    <main className="page" data-testid="house-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">House</span>
          <h1>{detail?.name ?? house.name}</h1>
          <p className="muted">
            The public play-money club. Anyone can join, every member gets{' '}
            {fmtChips(house.joinGrant, detail?.currency)} to start and the matchmaker seats them.{' '}
            <Link to={`/clubs/${encodeURIComponent(clubId)}`} data-testid="house-club-link">
              Manage it as a club →
            </Link>
          </p>
        </div>
        <span className="small muted" data-testid="house-live" data-live={live}>
          <span className={`dot ${live === 'open' ? 'dot-live' : ''}`} />{' '}
          {live === 'open' ? 'live' : live === 'error' ? 'reconnecting…' : ''}
        </span>
      </div>
      <div className="two-col">
        <div className="stack">
          <section className="card stack" data-testid="matchmaking-panel">
            <div className="card-title">
              <h2>Matchmaking</h2>
              <div className="row">
                <span
                  className={`badge ${q?.running ? 'badge-success' : 'badge-danger'}`}
                  data-testid="matchmaker-state"
                >
                  {q ? (q.running ? 'running' : 'paused') : '…'}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => void control(q?.running ? 'pause' : 'resume')}
                  disabled={!q || busy !== null}
                  data-testid="toggle-matchmaking"
                >
                  {q?.running ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => void control('drain')}
                  disabled={!q || busy !== null || q.queued === 0}
                  data-testid="drain-queue"
                >
                  Drain
                </button>
              </div>
            </div>
            {mm.error && <p className="error-text">{mm.error}</p>}
            <dl className="kv" data-testid="matchmaking-metrics">
              <dt>Waiting</dt>
              <dd data-testid="queued">{q?.queued ?? 0}</dd>
              <dt>Matches / min</dt>
              <dd data-testid="matches-per-minute">{q?.matchesPerMinute ?? 0}</dd>
              <dt>Matched total</dt>
              <dd data-testid="matches-total">{fmtCount(q?.matchesTotal ?? 0)}</dd>
              <dt>Median wait</dt>
              <dd>{fmtWait(q?.medianWaitMs ?? 0)}</dd>
              <dt>Longest wait</dt>
              <dd>{fmtWait(q?.oldestWaitMs ?? 0)}</dd>
              <dt>Expired / cancelled</dt>
              <dd className="mono">
                {fmtCount(q?.expiredTotal ?? 0)} / {fmtCount(q?.cancelledTotal ?? 0)}
              </dd>
            </dl>
            <div className="row" data-testid="queue-depths">
              {Object.entries(q?.depthByGame ?? {}).length === 0 ? (
                <span className="small muted">No queue depth yet.</span>
              ) : (
                Object.entries(q?.depthByGame ?? {})
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([game, depth]) => (
                    <span key={game} className="badge" data-testid={`depth-${game}`}>
                      {GAME_ICON[game] ?? '🎮'} {GAME_NAME[game] ?? game}: {depth}
                    </span>
                  ))
              )}
            </div>
            {q && q.tickets.length > 0 && (
              <div className="seatlist" data-testid="queue-list">
                {q.tickets
                  .slice()
                  .sort((a, b) => b.waitMs - a.waitMs)
                  .map((t) => (
                    <div key={t.id} className="seat" data-testid={`ticket-${t.id}`}>
                      <span aria-hidden="true">{GAME_ICON[t.game] ?? '🎮'}</span>
                      <span className="name">{nameOf(t.memberId)}</span>
                      <span className="small muted">{GAME_NAME[t.game] ?? t.game}</span>
                      <span className="small mono">waiting {fmtWait(t.waitMs)}</span>
                    </div>
                  ))}
              </div>
            )}
            <p className="help">
              Tickets are matched oldest first inside a rating window that widens the longer someone
              waits, then opens to anyone. Pausing leaves the queue standing; draining empties it.
            </p>
          </section>

          <section className="card stack" data-testid="house-tables">
            <div className="card-title">
              <h2>Live tables</h2>
              <span className="small muted" data-testid="house-tables-count">
                {detail?.tables.length ?? 0} open · {seated} seated
              </span>
            </div>
            {club.error && <p className="error-text">{club.error}</p>}
            {(detail?.tables.length ?? 0) === 0 ? (
              <p className="small muted" data-testid="no-house-tables">
                Nothing running right now.
              </p>
            ) : (
              <div className="seatlist">
                {(detail?.tables ?? []).map((t) => (
                  <div
                    key={t.id}
                    className="seat"
                    data-testid={`house-table-${t.id}`}
                    data-status={t.status}
                    style={{ flexWrap: 'wrap' }}
                  >
                    <span aria-hidden="true">{GAME_ICON[t.game] ?? '🎮'}</span>
                    <span className="name">{t.templateName}</span>
                    <code>{t.code}</code>
                    <span className={`badge ${t.status === 'playing' ? 'badge-success' : ''}`}>
                      {t.status}
                    </span>
                    <span className="small muted">
                      {t.seats.filter((s) => s !== null).length}/{t.seats.length} seats
                      {t.seats.some((s) => s !== null)
                        ? ` · ${t.seats
                            .filter((s): s is { name: string; memberId: string } => s !== null)
                            .map((s) => s.name)
                            .join(', ')}`
                        : ''}
                    </span>
                    <span className="small mono">
                      {fmtChips(
                        t.stacks.reduce((a, b) => a + b, 0),
                        detail?.currency,
                      )}{' '}
                      on the table
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card stack" data-testid="house-summary">
            <div className="card-title">
              <h2>Club</h2>
              <button
                className="btn btn-sm"
                onClick={() => {
                  void club.refresh();
                  void mm.refresh();
                  void grants.refresh();
                  void ratings.refresh();
                }}
                data-testid="refresh-house"
              >
                Refresh
              </button>
            </div>
            <dl className="kv">
              <dt>Members</dt>
              <dd data-testid="house-members">{detail?.members.length ?? 0}</dd>
              <dt>Online</dt>
              <dd data-testid="house-online">{detail?.online.length ?? 0}</dd>
              <dt>Join grant</dt>
              <dd className="mono">{fmtChips(house.joinGrant, detail?.currency)}</dd>
              <dt>Faucet</dt>
              <dd className="mono" data-testid="house-faucet">
                {house.faucet > 0 ? fmtChips(house.faucet, detail?.currency) : 'off'}
              </dd>
              <dt>Reserve</dt>
              <dd className="mono">{fmtChips(detail?.reserve ?? 0, detail?.currency)}</dd>
              <dt>Circulation</dt>
              <dd className="mono">{fmtChips(detail?.circulation ?? 0, detail?.currency)}</dd>
              <dt>Minted / burned</dt>
              <dd className="mono">
                {fmtChips(detail?.minted ?? 0, detail?.currency)} /{' '}
                {fmtChips(detail?.burned ?? 0, detail?.currency)}
              </dd>
            </dl>
            <p className="help">
              Rake burns chips out of circulation; the reserve pays them back out as grants, so the
              house needs topping up as it is played.
            </p>
          </section>

          <section className="card stack" data-testid="house-grants">
            <div className="card-title">
              <h2>Grants</h2>
              <span className="small muted" data-testid="grants-total">
                {fmtCount(grants.data?.total ?? 0)} total
              </span>
            </div>
            {grants.error && <p className="error-text">{grants.error}</p>}
            {(grants.data?.entries.length ?? 0) === 0 ? (
              <p className="small muted" data-testid="no-grants">
                Nothing granted yet.
              </p>
            ) : (
              <div className="log" data-testid="grant-list">
                {(grants.data?.entries ?? []).map((e) => {
                  const line = e.lines.find((l) => l.amount > 0 && l.account !== 'house');
                  const note = e.ref?.note ?? '';
                  return (
                    <div key={e.seq} data-testid={`grant-${e.seq}`}>
                      <time>{fmtTime(e.at)}</time>
                      <span>
                        {note.startsWith('faucet') ? '🚰' : '🎁'}{' '}
                        {line ? nameOf(line.account) : 'unknown'} ·{' '}
                        {fmtChips(line?.amount ?? 0, detail?.currency)}
                        {note ? ` · ${note.startsWith('faucet') ? 'faucet' : note}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="help">
              One opening stack per member, then one faucet top-up per cooldown window for anyone
              who busts.
            </p>
          </section>

          <section className="card stack" data-testid="house-ratings">
            <div className="card-title">
              <h2>Ratings</h2>
              <span className="small muted">Elo · top 5</span>
            </div>
            {ratings.error && <p className="error-text">{ratings.error}</p>}
            {board.length === 0 ? (
              <p className="small muted" data-testid="no-ratings">
                Nobody has played yet.
              </p>
            ) : (
              board.map((g) => (
                <div key={g.game} className="stack" data-testid={`ratings-${g.game}`}>
                  <span className="small muted">
                    {GAME_ICON[g.game] ?? '🎮'} {GAME_NAME[g.game] ?? g.game}
                  </span>
                  <div className="seatlist">
                    {g.rows.map(([memberId, rating]) => (
                      <div key={memberId} className="seat">
                        <span className="name">{nameOf(memberId)}</span>
                        <span className="small mono">{Math.round(rating)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            <p className="help">
              Ratings shape the matchmaker's window; they are not chips and never settle.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
