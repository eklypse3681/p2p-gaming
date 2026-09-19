import { useState } from 'react';
import type { LedgerModel } from '../../../session/ledger';
import { formatMoney, formatPoints, ledgerCsv } from '../../../session/ledger';
import { formatTime } from '../../../session/time';
import styles from './LedgerSheet.module.css';

export interface LedgerSheetProps {
  model: LedgerModel;
  mySeat: number | null;
  /** Live table: settling and adjusting send commands; history: read-only. */
  canSettle?: boolean;
  onSettle?: () => void;
  onAdjust?: (seat: number, points: number, note: string) => void;
  /** Reset-scores requests by seat (everyone agreeing resets the scores). */
  resetRequests?: boolean[];
  /** Ask (or withdraw the ask) to reset the scores; absent on read-only sheets and for dealers. */
  onRequestReset?: (requested: boolean) => void;
  onClose: () => void;
  title?: string;
  /** File name stem for the CSV export. */
  exportName?: string;
}

function downloadText(filename: string, text: string, type = 'text/csv'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The score sheet. Scores per seat (money only when a multiplier is set), a "Reset scores" request
 * that goes through when everyone agrees, and the hand history. The full ledger — who owes whom,
 * an immediate settlement and manual adjustments — sits under "Advanced" for tables that keep
 * real accounts.
 */
export function LedgerSheet(p: LedgerSheetProps) {
  const { model } = p;
  const [confirming, setConfirming] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const showMoney = model.multiplier !== 1;
  const requests = p.resetRequests ?? [];
  const wantReset = model.names.map((_, i) => !!requests[i]);
  const myReset = p.mySeat !== null ? (wantReset[p.mySeat] ?? false) : false;
  const askers = model.names.filter((_, i) => wantReset[i]);
  const [adjSeat, setAdjSeat] = useState(p.mySeat ?? 0);
  const [adjPoints, setAdjPoints] = useState('0');
  const [adjNote, setAdjNote] = useState('');
  const buyin = model.baseline > 0;
  const settled = model.plan.length === 0;

  const submitAdjust = () => {
    const n = Number(adjPoints);
    if (!Number.isFinite(n) || n === 0) return;
    p.onAdjust?.(adjSeat, n, adjNote.trim());
    setAdjusting(false);
    setAdjPoints('0');
    setAdjNote('');
  };

  return (
    <div
      className={styles.backdrop}
      data-testid="ledger-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div className={`card ${styles.sheet}`} role="dialog" aria-label="Scores">
        <div className={styles.head}>
          <div>
            <div className="eyebrow">Score sheet</div>
            <h2 style={{ margin: 0 }}>{p.title ?? 'Scores'}</h2>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={p.onClose}
            aria-label="Close ledger"
            data-testid="ledger-close"
          >
            ✕
          </button>
        </div>

        <div className={styles.balances} data-testid="ledger-balances">
          {model.names.map((name, i) => {
            const points = model.unsettled[i] ?? 0;
            return (
              <div
                key={i}
                className={`${styles.balance} ${points > 0 ? styles.up : points < 0 ? styles.down : ''}`}
                data-testid={`ledger-balance-${i}`}
              >
                <span className={styles.balanceName}>
                  {name}
                  {i === p.mySeat && <span className="muted small"> (you)</span>}
                </span>
                <span className={`mono ${styles.balancePoints}`}>
                  {buyin ? model.balances[i] : formatPoints(points)}
                  <span className="muted small"> pts</span>
                </span>
                {showMoney && (
                  <span className="mono muted small">{formatMoney(points * model.multiplier)}</span>
                )}
                {wantReset[i] && (
                  <span className="badge small" data-testid={`reset-request-${i}`}>
                    wants a reset
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <p className="muted small">
          {buyin
            ? `Buy-in ${model.baseline} points${showMoney ? ` · 1 point = ${formatMoney(model.multiplier)}` : ''}`
            : showMoney
              ? `1 point = ${formatMoney(model.multiplier)}`
              : 'Points since the last reset.'}
        </p>

        {p.onRequestReset && (
          <div className={styles.actions} data-testid="reset-scores">
            <button
              className={`btn btn-sm ${myReset ? '' : 'btn-primary'}`}
              onClick={() => p.onRequestReset?.(!myReset)}
              data-testid="settle-request-button"
              data-requested={myReset ? 'true' : 'false'}
            >
              {myReset ? 'Cancel reset' : 'Reset scores'}
            </button>
            <span className="muted small" data-testid="settle-requests">
              {askers.length === 0
                ? 'Resets when everyone asks.'
                : `${askers.join(', ')} want${askers.length === 1 ? 's' : ''} to reset · waiting for ${model.names.filter((_, i) => !wantReset[i]).join(', ') || 'nobody'}`}
            </span>
          </div>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          data-testid="ledger-advanced"
        >
          {advanced ? 'Hide advanced' : 'Advanced: who owes whom, settle, adjust'}
        </button>

        <div className={styles.plan} data-testid="ledger-plan" hidden={!advanced}>
          <span className="label">To settle</span>
          {settled ? (
            <span className="muted small" data-testid="ledger-settled">
              All square.
            </span>
          ) : (
            model.plan.map((t, i) => (
              <div key={i} className={styles.planRow} data-testid="ledger-plan-row">
                <span>
                  <strong>{model.names[t.from]}</strong> pays <strong>{model.names[t.to]}</strong>
                </span>
                <span className="mono">
                  {t.points} pts · {formatMoney(t.amount)}
                </span>
              </div>
            ))
          )}
        </div>

        {p.canSettle && advanced && (
          <div className={styles.actions}>
            {!confirming ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setConfirming(true)}
                disabled={settled}
                data-testid="settle-button"
              >
                Settle up
              </button>
            ) : (
              <div className={styles.confirm} data-testid="settle-confirm">
                <span>
                  Record these payments and reset everyone to{' '}
                  {buyin ? `${model.baseline} points` : 'zero'}?
                </span>
                <span className="row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      p.onSettle?.();
                      setConfirming(false);
                    }}
                    data-testid="confirm-settle"
                  >
                    Yes, settle
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirming(false)}
                    data-testid="cancel-settle"
                  >
                    Cancel
                  </button>
                </span>
              </div>
            )}
            {!adjusting ? (
              <button
                className="btn btn-sm"
                onClick={() => setAdjusting(true)}
                data-testid="adjust-button"
              >
                Adjust…
              </button>
            ) : (
              <div className={styles.adjust} data-testid="adjust-form">
                <select
                  className="select"
                  value={adjSeat}
                  onChange={(e) => setAdjSeat(Number(e.target.value))}
                  aria-label="Seat to adjust"
                  data-testid="adjust-seat"
                >
                  {model.names.map((n, i) => (
                    <option key={i} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono"
                  type="number"
                  step={1}
                  value={adjPoints}
                  onChange={(e) => setAdjPoints(e.target.value)}
                  aria-label="Points (negative to subtract)"
                  data-testid="adjust-points"
                />
                <input
                  className="input"
                  placeholder="Why?"
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                  aria-label="Note"
                  data-testid="adjust-note"
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={submitAdjust}
                  data-testid="confirm-adjust"
                >
                  Apply
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setAdjusting(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        <div className={styles.entries} data-testid="ledger-entries">
          <span className="label">Hands</span>
          {model.lines.length === 0 && <span className="muted small">Nothing yet.</span>}
          {model.lines
            .slice()
            .reverse()
            .map((line, idx) => (
              <div
                key={idx}
                className={styles.entry}
                data-testid="ledger-entry"
                data-kind={line.kind}
              >
                <span className={styles.entryLabel}>
                  {line.label}
                  {line.at ? <span className="muted small"> · {formatTime(line.at)}</span> : null}
                  {line.note ? <span className="muted small"> · {line.note}</span> : null}
                </span>
                <span className={styles.entryDeltas}>
                  {line.deltas.map((d, i) => (
                    <span
                      key={i}
                      className={`mono ${d > 0 ? styles.up : d < 0 ? styles.down : 'muted'}`}
                      title={model.names[i]}
                    >
                      {line.kind === 'settlement' && line.amounts
                        ? formatMoney(line.amounts[i] ?? 0)
                        : formatPoints(d)}
                    </span>
                  ))}
                </span>
              </div>
            ))}
        </div>

        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => downloadText(`${p.exportName ?? 'ledger'}.csv`, ledgerCsv(model))}
            data-testid="export-ledger"
          >
            Export CSV
          </button>
        </div>
      </div>
    </div>
  );
}
