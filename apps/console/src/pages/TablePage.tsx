import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, subscribeEvents } from '../api/client';
import type { ManagerEvent, TableDetail } from '../api/client';
import { describeError, useResource } from '../api/useApi';
import { QrCode } from '../components/QrCode';
import { useToast } from '../components/Toast';
import { GAME_ICON, GAME_NAME, summaryLine } from './TablesPage';

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Seconds until `at`, ticking once a second. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return <>{Math.max(0, Math.ceil((at - now) / 1000))}</>;
}

function money(points: number, multiplier: number): string {
  const v = points * multiplier;
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
}

export function LedgerPanel({
  id,
  names,
  running,
}: {
  id: string;
  names: (string | null)[];
  running: boolean;
}) {
  const toast = useToast();
  const { data, refresh } = useResource(() => api.ledger(id), id);
  const [adjust, setAdjust] = useState<{ seat: number; points: string; note: string } | null>(null);
  if (!data) return null;
  const settle = async () => {
    const lines = data.plan.map(
      (p) =>
        `${names[p.from] ?? p.from} pays ${names[p.to] ?? p.to} ${p.amount.toFixed(2)} (${p.points} pts)`,
    );
    if (!window.confirm(`Settle now?\n\n${lines.join('\n') || 'Nothing to settle.'}`)) return;
    try {
      await api.command(id, { type: 'settle' });
      await refresh();
      toast('Settled');
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  const submitAdjust = async () => {
    if (!adjust) return;
    try {
      await api.command(id, {
        type: 'adjust',
        seat: adjust.seat,
        points: Number(adjust.points) || 0,
        note: adjust.note,
      });
      setAdjust(null);
      await refresh();
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  return (
    <section className="card stack" data-testid="ledger-panel">
      <div className="card-title">
        <h2>Ledger</h2>
        <span className="small muted">
          {data.mode === 'buyin' ? `buy-in ${data.buyIn}` : 'points up'} · ×{data.multiplier}
        </span>
      </div>
      <dl className="kv">
        {data.balances.map((b, i) => (
          <>
            <dt key={`n${i}`}>{names[i] ?? `Seat ${i}`}</dt>
            <dd key={`v${i}`} className="mono" data-testid={`ledger-balance-${i}`}>
              {b} pts · unsettled {money(data.unsettled[i] ?? 0, data.multiplier)}
            </dd>
          </>
        ))}
      </dl>
      {data.plan.length > 0 ? (
        <ul className="small" data-testid="ledger-plan">
          {data.plan.map((p, i) => (
            <li key={i}>
              {names[p.from] ?? p.from} pays {names[p.to] ?? p.to}{' '}
              <strong>{p.amount.toFixed(2)}</strong> ({p.points} pts)
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted" data-testid="ledger-settled">
          Nothing to settle.
        </p>
      )}
      {running && (
        <div className="row">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void settle()}
            disabled={data.plan.length === 0}
            data-testid="settle-button"
          >
            Settle
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setAdjust({ seat: 0, points: '0', note: '' })}
            data-testid="adjust-button"
          >
            Adjust…
          </button>
        </div>
      )}
      {adjust && (
        <div className="row" data-testid="adjust-form">
          <select
            className="select"
            value={adjust.seat}
            onChange={(e) => setAdjust({ ...adjust, seat: Number(e.target.value) })}
            data-testid="adjust-seat"
            style={{ width: 160 }}
          >
            {names.map((n, i) => (
              <option key={i} value={i}>
                {n ?? `Seat ${i}`}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="number"
            value={adjust.points}
            onChange={(e) => setAdjust({ ...adjust, points: e.target.value })}
            data-testid="adjust-points"
            style={{ width: 110 }}
          />
          <input
            className="input"
            placeholder="note"
            value={adjust.note}
            onChange={(e) => setAdjust({ ...adjust, note: e.target.value })}
            data-testid="adjust-note"
            style={{ width: 200 }}
          />
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void submitAdjust()}
            data-testid="confirm-adjust"
          >
            Apply
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setAdjust(null)}>
            Cancel
          </button>
        </div>
      )}
      <p className="small muted">{data.entries.length} ledger entries</p>
    </section>
  );
}

export function TablePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, refresh, setData } = useResource(() => api.table(id), id);
  // Events the server listed on load plus the ones that arrived live since (merged by seq).
  const [liveEvents, setLiveEvents] = useState<ManagerEvent[]>([]);
  const [live, setLive] = useState<'open' | 'error' | 'idle'>('idle');
  const [busy, setBusy] = useState(false);
  const [ledgerKey, setLedgerKey] = useState(0);
  const events = useMemo(() => {
    const seen = new Set<number>();
    const merged: ManagerEvent[] = [];
    for (const e of [...(data?.events ?? []), ...liveEvents]) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      merged.push(e);
    }
    return merged.sort((a, b) => a.seq - b.seq).slice(-200);
  }, [data?.events, liveEvents]);

  useEffect(
    () =>
      subscribeEvents(
        (e) => {
          if (e.table !== id) return;
          setLiveEvents((prev) => [...prev.slice(-199), e]);
          if (e.type === 'action') setLedgerKey((k) => k + 1);
          void refresh();
        },
        (state) => setLive(state),
      ),
    [id, refresh],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        const result = await fn();
        if (result && typeof result === 'object' && 'seatsInfo' in (result as object)) {
          setData((prev) => (prev ? { ...prev, ...(result as TableDetail) } : prev));
        }
        await refresh();
        if (done) toast(done);
      } catch (e) {
        toast(describeError(e), 'error');
      } finally {
        setBusy(false);
      }
    },
    [refresh, setData, toast],
  );

  if (error && !data) {
    return (
      <main className="page">
        <p className="error-text">{error}</p>
        <Link to="/">Back to tables</Link>
      </main>
    );
  }
  if (!data) return <main className="page">Loading…</main>;
  const t = data;
  const running = t.status === 'running';
  const names = t.seatsInfo.map((s) => s.name);
  const summary = t.summary as Record<string, unknown> | null;
  const ofcState =
    t.game === 'ofc' ? (summary as { status?: string; handNumber?: number } | null) : null;

  return (
    <main className="page" data-testid="table-page" data-status={t.status}>
      <div className="page-head">
        <div>
          <span className="eyebrow">
            {GAME_ICON[t.game]} {GAME_NAME[t.game]}
          </span>
          <h1>{t.name || `Table ${t.code}`}</h1>
          <p className="muted">{t.rules}</p>
        </div>
        <div className="row">
          <span className={`badge ${running ? 'badge-success' : ''}`} data-testid="table-status">
            <span className={`dot ${running ? 'dot-live' : ''}`} />
            {t.status}
          </span>
          {running ? (
            <button
              className="btn"
              onClick={() => void act(() => api.stop(t.id), 'Table stopped')}
              disabled={busy}
              data-testid="stop-button"
            >
              Stop
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary"
                onClick={() => void act(() => api.resume(t.id), 'Table resumed')}
                disabled={busy}
                data-testid="resume-button"
              >
                Resume
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm('Remove this table? Its saved file is kept on disk.')) {
                    void api.remove(t.id).then(
                      () => navigate('/'),
                      (e) => toast(describeError(e), 'error'),
                    );
                  }
                }}
                disabled={busy}
                data-testid="remove-button"
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>

      <div className="two-col">
        <div className="stack">
          <section className="card stack">
            <div className="card-title">
              <h2>Seats</h2>
              <span className="small muted">
                {t.occupied}/{t.seats} taken · dealer {t.dealer?.name ?? '—'}
              </span>
            </div>
            <div className="seatlist">
              {t.seatsInfo.map((s) => (
                <div
                  key={s.seat}
                  className="seat"
                  data-testid={`seat-${s.seat}`}
                  data-connected={s.connected}
                >
                  <span className={`dot ${s.connected ? 'dot-live' : ''}`} />
                  <span className="name">{s.name ?? <span className="muted">open seat</span>}</span>
                  <span className="small muted">
                    {s.name
                      ? s.connected
                        ? `online · ${s.devices} device${s.devices === 1 ? '' : 's'}`
                        : 'offline'
                      : `seat ${s.seat}`}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="card stack">
            <div className="card-title">
              <h2>Game</h2>
              <span className="small mono" data-testid="summary-line">
                {summaryLine(t)}
              </span>
            </div>
            {running && (
              <p
                className="small"
                data-testid="autopilot-status"
                data-enabled={t.autopilot?.enabled ? 'true' : 'false'}
              >
                {t.autopilot?.enabled ? (
                  t.autopilot.pending ? (
                    <>
                      Unattended · {t.autopilot.pending.reason} — in{' '}
                      <Countdown at={t.autopilot.pending.at} /> s
                    </>
                  ) : (
                    `Unattended · ${
                      t.game === 'ofc'
                        ? 'deals when every seat is taken, moves on when everyone is ready, resets scores when everyone agrees'
                        : 'starts the first game when both players are here and the next when both are ready'
                    } · ready ${(t.ready ?? []).filter(Boolean).length}/${t.seatsInfo.length}`
                  )
                ) : (
                  'Manual dealing: the dealer presses the buttons.'
                )}
              </p>
            )}
            {t.game === 'ofc' && running && (
              <div className="row">
                <button
                  className={`btn ${t.autopilot?.enabled ? '' : 'btn-primary'}`}
                  onClick={() => void act(() => api.command(t.id, { type: 'start' }), 'Hand dealt')}
                  disabled={busy || t.occupied < 2}
                  data-testid="deal-button"
                  title={t.autopilot?.enabled ? 'Override: the table deals by itself' : undefined}
                >
                  {t.autopilot?.enabled
                    ? ofcState?.handNumber
                      ? 'Deal next hand now'
                      : 'Deal now'
                    : ofcState?.handNumber
                      ? 'Next hand'
                      : 'Deal first hand'}
                </button>
                <span className="small muted">
                  {t.occupied < 2
                    ? 'Waiting for at least two players'
                    : t.autopilot?.enabled
                      ? 'Override only — the table deals itself'
                      : 'Deals when every seat has finished the previous hand'}
                </span>
              </div>
            )}
            {t.game === 'backgammon' && (
              <p className="small muted">
                {t.autopilot?.enabled
                  ? 'The match starts itself; players roll and move, the dealer relays and keeps the state.'
                  : 'Players start and play the match themselves; the dealer relays and keeps the state.'}
              </p>
            )}
          </section>

          {t.game === 'ofc' && (
            <LedgerPanel key={ledgerKey} id={t.id} names={names} running={running} />
          )}

          <section className="card stack">
            <div className="card-title">
              <h2>Events</h2>
              <span className="small muted" data-testid="live-indicator" data-live={live}>
                {live === 'open' ? 'live' : live === 'error' ? 'reconnecting…' : ''}
              </span>
            </div>
            <div className="log" data-testid="event-log">
              {events.length === 0 && <span className="muted">Nothing yet.</span>}
              {events
                .slice()
                .reverse()
                .map((e) => (
                  <div key={e.seq} data-type={e.type}>
                    <time>{fmtTime(e.at)}</time>
                    <span>{e.message}</span>
                  </div>
                ))}
            </div>
          </section>
        </div>

        <aside className="stack">
          <section className="card stack">
            <h2>Invite</h2>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <QrCode value={t.inviteLink} />
              <div className="stack" style={{ flex: 1, minWidth: 160 }}>
                <div>
                  <span className="label">Room code</span>
                  <div
                    className="mono"
                    style={{ fontSize: '1.6rem', letterSpacing: '0.2em' }}
                    data-testid="room-code"
                  >
                    {t.code}
                  </div>
                </div>
                <input
                  className="input mono small"
                  readOnly
                  value={t.inviteLink}
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="invite-link"
                />
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(t.inviteLink)
                      .then(() => toast('Link copied'))
                  }
                  data-testid="copy-link"
                >
                  Copy link
                </button>
              </div>
            </div>
            <p className="help">
              Players open the link (or scan the code) in the web app. The dealer plays no seat.
            </p>
          </section>

          <section className="card stack" data-testid="entropy-panel">
            <h2>Randomness</h2>
            <dl className="kv">
              <dt>Source</dt>
              <dd>{t.randomness?.provider ?? 'crypto'}</dd>
              <dt>Mode</dt>
              <dd>{t.randomness?.mode ?? 'per-draw'}</dd>
              <dt>Actions</dt>
              <dd>{t.seq}</dd>
            </dl>
            <p className="help">
              Every draw is recorded with its proof. Download the public audit to verify a hand with
              the tools in <code>@bgf/entropy</code>.
            </p>
            <a
              className="btn btn-sm"
              href={api.auditUrl(t.id)}
              download={`audit-${t.code}.json`}
              data-testid="audit-link"
            >
              Download audit JSON
            </a>
          </section>
        </aside>
      </div>
    </main>
  );
}
