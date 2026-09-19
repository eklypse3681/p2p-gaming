import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { useSavedSnapshots } from '../../session/matchStore';
import { formatDate, relativeTime } from '../../session/time';
import type { OfcSnapshot, TableRow } from './history';
import { computeOfcStats, summarizeTable } from './history';
import { describeRules, rowLabel, variantName } from './rules/describe';
import { LedgerSheet } from './ledger/LedgerSheet';
import { FairnessPanel } from '../../hud/FairnessPanel';
import type { RandomnessMode } from '@bgf/protocol';
import { ofcLedgerModel } from './ledger/model';
import styles from '../backgammon/HistoryScreen.module.css';

function Stat({ k, v, sub }: { k: string; v: string | number; sub?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statK}>{k}</span>
      <span className={styles.statV}>{v}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function HistoryScreen() {
  const { profile } = useProfile();
  const { path, id: gameId } = useGame();
  const { matches, loading, remove } = useSavedSnapshots<OfcSnapshot>(gameId);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = params.get('match');
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  const rows = useMemo(
    () =>
      matches.map((m) => summarizeTable(m, profile.id)).filter((r): r is TableRow => r !== null),
    [matches, profile.id],
  );
  const stats = useMemo(() => computeOfcStats(rows), [rows]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('match', id);
    else next.delete('match');
    setParams(next, { replace: true });
    setLedgerOpen(false);
  };

  return (
    <div className="page" data-testid="history-screen" data-game={gameId}>
      <div className="stack">
        <div>
          <div className="eyebrow">Personal history</div>
          <h1>Your OFC record</h1>
          <p className="muted">
            Everything here lives in this browser. Nothing is uploaded anywhere.
          </p>
        </div>

        <div className={styles.stats} data-testid="history-stats">
          <Stat k="Tables" v={stats.tables} sub={`${stats.tablesInProgress} in progress`} />
          <Stat k="Hands" v={stats.handsPlayed} />
          <Stat k="Points" v={signed(stats.pointsNet)} sub="net across all tables" />
          <Stat k="Royalties" v={signed(stats.royalties)} sub="earned" />
          <Stat k="Fouls" v={stats.fouls} />
          <Stat k="Fantasylands" v={stats.fantasylands} sub="entered" />
        </div>

        <div className={`${styles.layout} ${selected ? styles.layoutDetail : ''}`}>
          <section className="card">
            <div className="card-title">
              <h2>Tables</h2>
              <span className="muted small">{rows.length} saved</span>
            </div>
            {loading ? (
              <p className="muted">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="muted" data-testid="history-empty">
                No tables yet. <Link to={path('/')}>Host or join one</Link> to get started.
              </p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="history-list">
                  <thead>
                    <tr>
                      <th>Players</th>
                      <th>Variant</th>
                      <th>Hands</th>
                      <th>Net</th>
                      <th>Status</th>
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
                        <td>{r.opponents.map((o) => o.name).join(', ') || '—'}</td>
                        <td>{variantName(r.config.variant)}</td>
                        <td className="mono">{r.results.length}</td>
                        <td className="mono">{signed(r.myNet)}</td>
                        <td>
                          <span className={`badge ${r.status === 'over' ? '' : 'badge-accent'}`}>
                            {r.status === 'over' ? 'Finished' : 'In progress'}
                          </span>
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
                <h2>with {selected.opponents.map((o) => o.name).join(', ') || 'nobody yet'}</h2>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => select(null)}
                  aria-label="Close details"
                >
                  ✕
                </button>
              </div>
              <div className="row">
                <span className="badge">{describeRules(selected.config)}</span>
                <span className="badge">Code {selected.code}</span>
                <span className="muted small">
                  {formatDate(selected.createdAt)} → {formatDate(selected.updatedAt)}
                </span>
              </div>
              <div className="mono" style={{ fontSize: '1.6rem', fontWeight: 700 }}>
                {signed(selected.myNet)}
                <span className="muted small" style={{ marginLeft: 8, fontWeight: 400 }}>
                  points · balance {selected.myBalance}
                </span>
              </div>
              <div className={styles.games}>
                {selected.results.length === 0 && (
                  <span className="muted small">No hands finished yet.</span>
                )}
                {selected.results.map((h) => {
                  const me = h.seats[selected.mySeat]!;
                  return (
                    <div key={h.hand} className={styles.game} data-testid="history-hand">
                      <span className="muted">#{h.hand}</span>
                      <span>
                        {me.fouled ? (
                          <span className="badge badge-danger">Fouled</span>
                        ) : (
                          <>
                            {me.rows.bottom.description} · {rowLabel(selected.config, 'middle')}{' '}
                            {me.rows.middle.description} · top {me.rows.top.description}
                          </>
                        )}
                        {me.fantasylandNext > 0 && (
                          <span className="badge badge-accent" style={{ marginLeft: 6 }}>
                            FL {me.fantasylandNext}
                          </span>
                        )}
                      </span>
                      <span className="mono" title="Royalties">
                        {me.royalties > 0 ? `♛${me.royalties}` : ''}
                      </span>
                      <span className={`mono ${me.points > 0 ? 'badge-success' : ''}`}>
                        {signed(me.points)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="row">
                {selected.status !== 'over' && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => navigate(path(`/game/${selected.id}`))}
                  >
                    Resume
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => setLedgerOpen(true)}
                  data-testid="history-ledger"
                >
                  Ledger
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setFairnessOpen(true)}
                  data-testid="history-fairness"
                >
                  Fairness
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    if (window.confirm('Delete this table from your history?')) {
                      void remove(selected.id).then(() => select(null));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
              {fairnessOpen && (
                <FairnessPanel
                  source={{
                    id: selected.snapshot.id,
                    randomness: selected.snapshot.options?.randomness as
                      { provider: string; mode?: RandomnessMode } | undefined,
                    actionMeta: selected.snapshot.actionMeta,
                    entropyAudit: selected.snapshot.entropyAudit,
                  }}
                  gameId="ofc"
                  actions={selected.snapshot.actions as unknown[]}
                  seat={selected.mySeat}
                  exportName={`ofc-${selected.code}-audit`}
                  onClose={() => setFairnessOpen(false)}
                />
              )}
              {ledgerOpen && (
                <LedgerSheet
                  model={ofcLedgerModel(selected.snapshot.state, selected.names)}
                  mySeat={selected.mySeat}
                  onClose={() => setLedgerOpen(false)}
                  exportName={`ofc-${selected.code}-ledger`}
                />
              )}
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
                  <span className="mono" title="Tables">
                    T {o.tables}
                  </span>
                  <span className="mono" title="Hands">
                    H {o.hands}
                  </span>
                  <span className="mono" title="Net points against them">
                    {signed(o.pointsNet)}
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
