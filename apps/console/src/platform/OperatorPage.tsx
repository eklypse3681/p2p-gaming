import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { describeError, useResource } from '../api/useApi';
import { useToast } from '../components/Toast';
import { platformApi, subscribeOperatorEvents } from './api';
import type { PlatformEvent, PurchaseRow } from './api';
import { fmtChips, fmtDate, fmtTime, shortId } from './format';

export function OperatorPage() {
  const toast = useToast();
  const clubs = useResource(() => platformApi.operatorClubs());
  const purchases = useResource(() => platformApi.operatorPurchases());
  const report = useResource(() => platformApi.operatorReport());
  const refreshClubs = clubs.refresh;
  const refreshPurchases = purchases.refresh;
  const refreshReport = report.refresh;
  const refreshAll = useCallback(
    () => Promise.all([refreshClubs(), refreshPurchases(), refreshReport()]).then(() => {}),
    [refreshClubs, refreshPurchases, refreshReport],
  );
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [live, setLive] = useState<'open' | 'error' | 'idle'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeOperatorEvents(
      (e) => {
        setEvents((prev) =>
          prev.some((x) => x.seq === e.seq)
            ? prev
            : [...prev.slice(-299), e].sort((a, b) => a.seq - b.seq),
        );
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void refreshAll(), 300);
      },
      (state) => setLive(state),
    );
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refreshAll]);

  const clubOf = (clubId: string) => clubs.data?.find((c) => c.id === clubId);
  const markPaid = async (p: PurchaseRow) => {
    const club = clubOf(p.clubId);
    if (
      !window.confirm(
        `Mark ${fmtChips(p.amount, club?.currency)} for ${club?.name ?? shortId(p.clubId)} as paid? A certificate is issued and minted into the club's reserve.`,
      )
    )
      return;
    setBusy(p.id);
    try {
      await platformApi.markPaid(p.id);
      toast('Purchase marked paid');
      await refreshAll();
    } catch (e) {
      toast(describeError(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const rows = (purchases.data ?? [])
    .slice()
    .sort((a, b) =>
      a.status === b.status ? b.createdAt - a.createdAt : a.status === 'pending' ? -1 : 1,
    );
  const pending = rows.filter((p) => p.status === 'pending').length;
  const sum = (
    pick: (c: {
      members: number;
      reserve: number;
      circulation: number;
      minted: number;
      burned: number;
      tables: number;
    }) => number,
  ) => (report.data?.clubs ?? []).reduce((a, c) => a + pick(c), 0);

  return (
    <main className="page" data-testid="operator-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Operator</span>
          <h1>Platform</h1>
          <p className="muted">
            Every club the platform hosts, chip sales and the live event feed.
          </p>
        </div>
        <span className="small muted" data-testid="live-indicator" data-live={live}>
          <span className={`dot ${live === 'open' ? 'dot-live' : ''}`} />{' '}
          {live === 'open' ? 'live' : live === 'error' ? 'reconnecting…' : ''}
        </span>
      </div>
      <div className="two-col">
        <div className="stack">
          <section className="card stack">
            <div className="card-title">
              <h2>Clubs</h2>
              <span className="small muted">{clubs.data?.length ?? 0}</span>
            </div>
            {clubs.error && <p className="error-text">{clubs.error}</p>}
            {clubs.data && clubs.data.length === 0 && (
              <p className="small muted" data-testid="no-operator-clubs">
                No clubs yet.
              </p>
            )}
            {clubs.data && clubs.data.length > 0 && (
              <div className="seatlist" data-testid="operator-clubs">
                {clubs.data.map((c) => (
                  <div
                    key={c.id}
                    className="seat"
                    data-testid={`operator-club-${c.id}`}
                    style={{ flexWrap: 'wrap' }}
                  >
                    <span className="name">
                      <Link to={`/clubs/${encodeURIComponent(c.id)}`}>{c.name}</Link>
                    </span>
                    <span
                      className={`badge ${c.status === 'active' ? 'badge-success' : 'badge-danger'}`}
                    >
                      {c.status}
                    </span>
                    <span className="small muted">
                      {c.members} members · {c.online} online · {c.tables} tables · {c.rooms} rooms
                    </span>
                    <span className="small mono">reserve {fmtChips(c.reserve, c.currency)}</span>
                    <span className="small mono" data-testid="club-sales">
                      sales {fmtChips(c.sales, c.currency)}
                    </span>
                    {c.pendingPurchases > 0 && (
                      <span className="badge badge-accent" data-testid="club-pending">
                        {c.pendingPurchases} pending
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card stack" data-testid="operator-purchases">
            <div className="card-title">
              <h2>Purchases</h2>
              <span className="small muted">{pending} pending</span>
            </div>
            {purchases.error && <p className="error-text">{purchases.error}</p>}
            {rows.length === 0 ? (
              <p className="small muted" data-testid="no-purchases">
                No purchases yet.
              </p>
            ) : (
              <div className="seatlist">
                {rows.map((p) => {
                  const club = clubOf(p.clubId);
                  return (
                    <div
                      key={p.id}
                      className="seat"
                      data-testid={`purchase-${p.id}`}
                      data-status={p.status}
                      style={{ flexWrap: 'wrap' }}
                    >
                      <span
                        className={`badge ${
                          p.status === 'paid'
                            ? 'badge-success'
                            : p.status === 'cancelled'
                              ? 'badge-danger'
                              : 'badge-accent'
                        }`}
                      >
                        {p.status}
                      </span>
                      <span className="name">{club?.name ?? shortId(p.clubId)}</span>
                      <span className="mono">{fmtChips(p.amount, club?.currency)}</span>
                      <span className="small muted">
                        {p.method}
                        {p.reference ? ` · ${p.reference}` : ''} · {fmtDate(p.createdAt)}
                        {p.paidAt ? ` · paid ${fmtDate(p.paidAt)}` : ''}
                      </span>
                      {p.status === 'pending' && (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void markPaid(p)}
                          disabled={busy === p.id}
                          data-testid={`mark-paid-${p.id}`}
                        >
                          Mark paid
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="help">
              Marking a manual purchase paid issues a platform certificate for the amount and mints
              it into the club's reserve.
            </p>
          </section>
        </div>
        <aside className="stack">
          <section className="card stack" data-testid="operator-report">
            <div className="card-title">
              <h2>Report</h2>
              <button
                className="btn btn-sm"
                onClick={() => void refreshReport()}
                data-testid="refresh-report"
              >
                Refresh
              </button>
            </div>
            {report.error && <p className="error-text">{report.error}</p>}
            {report.data ? (
              <dl className="kv">
                <dt>As of</dt>
                <dd>{fmtDate(report.data.at)}</dd>
                <dt>Clubs</dt>
                <dd data-testid="report-clubs">{report.data.clubs.length}</dd>
                <dt>Members</dt>
                <dd>{sum((c) => c.members)}</dd>
                <dt>Live tables</dt>
                <dd>{sum((c) => c.tables)}</dd>
                <dt>Reserves</dt>
                <dd className="mono">{sum((c) => c.reserve)}</dd>
                <dt>Circulation</dt>
                <dd className="mono">{sum((c) => c.circulation)}</dd>
                <dt>Minted / burned</dt>
                <dd className="mono">
                  {sum((c) => c.minted)} / {sum((c) => c.burned)}
                </dd>
              </dl>
            ) : (
              <p className="muted">Loading…</p>
            )}
            <p className="help">
              Chip totals are summed in minor units across every club's currency.
            </p>
          </section>
          <section className="card stack">
            <div className="card-title">
              <h2>Event feed</h2>
              <span className="small muted">all clubs</span>
            </div>
            <div className="log" data-testid="operator-feed">
              {events.length === 0 && <span className="muted">Nothing yet.</span>}
              {events
                .slice()
                .reverse()
                .map((e) => (
                  <div key={e.seq} data-type={e.type}>
                    <time>{fmtTime(e.at)}</time>
                    <span>
                      {e.clubId ? `[${clubOf(e.clubId)?.name ?? shortId(e.clubId, 6)}] ` : ''}
                      {e.message}
                    </span>
                  </div>
                ))}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
