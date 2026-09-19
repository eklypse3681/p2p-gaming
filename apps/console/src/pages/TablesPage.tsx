import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, subscribeEvents } from '../api/client';
import type { TableInfo } from '../api/client';
import { describeError, useResource } from '../api/useApi';
import { useToast } from '../components/Toast';

export const GAME_ICON: Record<string, string> = { backgammon: '🎲', ofc: '🃏' };
export const GAME_NAME: Record<string, string> = {
  backgammon: 'Backgammon',
  ofc: 'Open Face Chinese Poker',
};

export function summaryLine(t: TableInfo): string {
  const s = t.summary as Record<string, unknown> | null;
  if (!s) return '';
  if (t.game === 'ofc') {
    const scores = (s.scores as number[] | undefined) ?? [];
    return `Hand ${String(s.handNumber ?? 0)} · ${scores.map((v) => (v > 0 ? `+${v}` : String(v))).join(' / ')}`;
  }
  const score = s.score as { white?: number; black?: number } | undefined;
  return `Game ${String(s.gameNumber ?? 1)} · ${score?.white ?? 0}–${score?.black ?? 0}${s.winner ? ' · over' : ''}`;
}

export function TableCard({ table, onChange }: { table: TableInfo; onChange: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const names = table.seatsInfo.filter((s) => s.name).map((s) => s.name);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  return (
    <article
      className="card stack"
      data-testid={`table-card-${table.id}`}
      data-status={table.status}
    >
      <div className="card-title">
        <div className="row">
          <span style={{ fontSize: '1.4rem' }} aria-hidden="true">
            {GAME_ICON[table.game] ?? '🎮'}
          </span>
          <div>
            <h3>{table.name || GAME_NAME[table.game] || table.game}</h3>
            <div className="small muted">
              <code data-testid="card-code">{table.code}</code> ·{' '}
              {GAME_NAME[table.game] ?? table.game}
            </div>
          </div>
        </div>
        <span
          className={`badge ${table.status === 'running' ? 'badge-success' : ''}`}
          data-testid="card-status"
        >
          <span className={`dot ${table.status === 'running' ? 'dot-live' : ''}`} />
          {table.status}
        </span>
      </div>
      <div className="small">
        {table.occupied}/{table.seats} seats{names.length ? ` · ${names.join(', ')}` : ''}
      </div>
      <div className="small muted">{table.rules}</div>
      {table.summary ? <div className="small mono">{summaryLine(table)}</div> : null}
      <div className="row">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => navigate(`/tables/${table.id}`)}
          data-testid="card-open"
        >
          Open
        </button>
        {table.status === 'running' ? (
          <button
            className="btn btn-sm"
            onClick={() => act(() => api.stop(table.id))}
            data-testid="card-stop"
          >
            Stop
          </button>
        ) : (
          <>
            <button
              className="btn btn-sm"
              onClick={() => act(() => api.resume(table.id))}
              data-testid="card-resume"
            >
              Resume
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                if (window.confirm('Remove this table from the list? Its saved file is kept.'))
                  void act(() => api.remove(table.id));
              }}
              data-testid="card-remove"
            >
              Remove
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function TablesPage() {
  const { data, error, loading, refresh } = useResource(() => api.tables());
  useEffect(() => subscribeEvents(() => void refresh()), [refresh]);
  return (
    <main className="page" data-testid="tables-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Tables</span>
          <h1>Your tables</h1>
          <p className="muted">
            Every table this dealer hosts. Running tables keep their state here; stopped ones can be
            resumed.
          </p>
        </div>
        <Link to="/new" className="btn btn-primary" data-testid="new-table-button">
          New table
        </Link>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : data && data.length ? (
        <div className="grid" data-testid="table-list">
          {data.map((t) => (
            <TableCard key={t.id} table={t} onChange={() => void refresh()} />
          ))}
        </div>
      ) : (
        <div className="card" data-testid="empty">
          <p>No tables yet. Create one and share its invite link or QR code with the players.</p>
        </div>
      )}
    </main>
  );
}
