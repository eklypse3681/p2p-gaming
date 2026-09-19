import { useEffect, useState } from 'react';
import type { LobbyTable } from '@bgf/protocol';
import { describeError, useResource } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { GAME_ICON } from '../../pages/TablesPage';
import { platformApi } from '../api';
import { fmtChips } from '../format';
import type { PanelProps } from './panel';

export function TablesPanel({ club, admin }: PanelProps) {
  const toast = useToast();
  const { data, error, refresh } = useResource(() => platformApi.tables(club.id), club.id);
  const [snapshot, setSnapshot] = useState<{ tableId: string; data: unknown } | null>(null);
  // The club detail reloads on every platform event; follow it.
  useEffect(() => {
    void refresh();
  }, [club.tables, refresh]);

  const close = async (t: LobbyTable) => {
    if (!window.confirm(`Close table ${t.code}? Stacks are cashed out to the members.`)) return;
    try {
      await platformApi.closeTable(club.id, t.id);
      toast('Table closed');
      await refresh();
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  const view = async (t: LobbyTable) => {
    try {
      setSnapshot({ tableId: t.id, data: await platformApi.snapshot(club.id, t.id) });
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  const tables = data ?? club.tables;

  return (
    <div className="stack">
      <section className="card stack" data-testid="tables-panel">
        <div className="card-title">
          <h2>Live tables</h2>
          <div className="row">
            <span className="small muted">{tables.length} open</span>
            <button
              className="btn btn-sm"
              onClick={() => void refresh()}
              data-testid="refresh-tables"
            >
              Refresh
            </button>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        {tables.length === 0 ? (
          <p className="small muted" data-testid="no-tables">
            No tables right now. Templates marked “always open” keep one instance in the lobby; the
            others open when a member sits.
          </p>
        ) : (
          <div className="seatlist" data-testid="table-list">
            {tables.map((t) => {
              const seated = t.seats.filter((s) => s !== null);
              return (
                <div
                  key={t.id}
                  className="seat"
                  data-testid={`table-${t.id}`}
                  data-status={t.status}
                  style={{ flexWrap: 'wrap' }}
                >
                  <span aria-hidden="true">{GAME_ICON[t.game] ?? '🎮'}</span>
                  <span className="name">{t.templateName}</span>
                  <code data-testid="table-code">{t.code}</code>
                  <span className={`badge ${t.status === 'playing' ? 'badge-success' : ''}`}>
                    {t.status}
                  </span>
                  <span className="small muted">
                    {seated.length}/{t.seats.length} seats
                    {seated.length
                      ? ` · ${t.seats
                          .map((s, i) =>
                            s ? `${s.name} (${fmtChips(t.stacks[i] ?? 0, club.currency)})` : null,
                          )
                          .filter(Boolean)
                          .join(', ')}`
                      : ''}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => void view(t)}
                      data-testid={`view-table-${t.id}`}
                    >
                      View
                    </button>
                    {admin && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void close(t)}
                        data-testid={`close-table-${t.id}`}
                      >
                        Close
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {snapshot && (
        <section className="card stack" data-testid="table-snapshot" data-table={snapshot.tableId}>
          <div className="card-title">
            <h2>Public view</h2>
            <button className="btn btn-sm btn-ghost" onClick={() => setSnapshot(null)}>
              Close
            </button>
          </div>
          <pre className="log" style={{ whiteSpace: 'pre-wrap', maxHeight: 420, margin: 0 }}>
            {JSON.stringify(snapshot.data, null, 2)}
          </pre>
          <p className="help">What a spectator sees: hidden cards and seeds are stripped.</p>
        </section>
      )}
    </div>
  );
}
