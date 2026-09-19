import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawRow, FairnessSource, Verifiers, VerifyStatus } from '../session/fairness';
import {
  auditJson,
  defaultVerifiers,
  fairnessRows,
  fairnessSummary,
  verdictFor,
  verifyRow,
} from '../session/fairness';
import { modeLabel, sourceLabel } from '../session/entropy';
import styles from './FairnessPanel.module.css';

export interface FairnessPanelProps {
  source: FairnessSource;
  onClose: () => void;
  title?: string;
  /** Extra audit context for the download. */
  gameId?: string;
  actions?: unknown[];
  seat?: number | null;
  verifiers?: Verifiers;
  /** File name stem for the audit download. */
  exportName?: string;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function statusLabel(s: VerifyStatus): string {
  switch (s) {
    case 'ok':
      return 'Verified';
    case 'fail':
      return 'Mismatch';
    case 'pending':
      return 'Awaiting reveal';
    case 'unverifiable':
      return 'This device';
    case 'checking':
      return 'Checking…';
    default:
      return '';
  }
}

function proofLabel(row: DrawRow): string {
  if (row.fallback) return 'fallback (this device)';
  if (row.beacon) return `drand round ${row.beacon.round}`;
  if (row.segment !== undefined)
    return `seed · segment ${row.segment + 1} · draw ${(row.record.drawIndex ?? 0) + 1}`;
  switch (row.proofKind) {
    case 'random.org-signed':
      return `random.org signed${row.record.sources[0]?.serialNumber !== undefined ? ` #${row.record.sources[0].serialNumber}` : ''}`;
    case 'drand':
      return 'drand';
    case 'none':
      return 'this device';
    default:
      return row.proofKind;
  }
}

/**
 * Where a table's randomness came from and whether it checks out: the declared source and mode,
 * every recorded draw with a Verify button, seeded segments (committed / revealed), random.org
 * serial continuity, and an audit download. Verification runs in the browser.
 */
export function FairnessPanel(p: FairnessPanelProps) {
  const verifiers = p.verifiers ?? defaultVerifiers;
  const rows = useMemo(() => fairnessRows(p.source), [p.source]);
  const summary = useMemo(() => fairnessSummary(p.source), [p.source]);
  const [statuses, setStatuses] = useState<Record<string, VerifyStatus>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const statusOf = (row: DrawRow): VerifyStatus => statuses[row.key] ?? 'idle';

  const verifyOne = async (row: DrawRow) => {
    setStatuses((s) => ({ ...s, [row.key]: 'checking' }));
    const result = await verifyRow(p.source, row, verifiers);
    if (alive.current) setStatuses((s) => ({ ...s, [row.key]: result }));
    return result;
  };

  const verifyAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const row of rows) await verifyOne(row);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const verdict = verdictFor(
    rows.map((r) => statusOf(r)),
    summary,
  );
  const openSegment = summary.segments.find((s) => !s.revealed);

  return (
    <div
      className={styles.backdrop}
      data-testid="fairness-panel"
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div className={`card ${styles.sheet}`} role="dialog" aria-label="Fairness">
        <div className={styles.head}>
          <div>
            <div className="eyebrow">Fairness</div>
            <h2 style={{ margin: 0 }}>{p.title ?? 'Where the randomness came from'}</h2>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={p.onClose}
            aria-label="Close fairness panel"
            data-testid="fairness-close"
          >
            ✕
          </button>
        </div>

        <div className={styles.facts}>
          <span className={styles.k}>Source</span>
          <span className={styles.v} data-testid="fairness-source" data-provider={summary.provider}>
            {sourceLabel(summary.provider)}
          </span>
          <span className={styles.k}>Mode</span>
          <span className={styles.v} data-testid="fairness-mode" data-mode={summary.mode}>
            {modeLabel(summary.mode)}
          </span>
          {summary.mode === 'seeded' && (
            <>
              <span className={styles.k}>Current segment</span>
              <span className={styles.v} data-testid="fairness-segment">
                {openSegment
                  ? `#${openSegment.index + 1} committed ${openSegment.commitment.slice(0, 12)}… (seed not revealed yet)`
                  : summary.segments.length > 0
                    ? `${summary.segments.length} segment${summary.segments.length === 1 ? '' : 's'}, all revealed`
                    : 'none yet'}
              </span>
            </>
          )}
          {summary.requestsLeft !== null && (
            <>
              <span className={styles.k}>random.org</span>
              <span className={styles.v} data-testid="fairness-requests-left">
                {summary.requestsLeft} requests left today
              </span>
            </>
          )}
        </div>

        <p className={styles.verdict} data-testid="fairness-verdict" data-busy={busy}>
          {verdict}
        </p>
        {summary.serialGaps.length > 0 && (
          <p className="error-text small" data-testid="fairness-serial-gap">
            random.org serial numbers skip{' '}
            {summary.serialGaps.map((g) => `${g.from}→${g.to}`).join(', ')}: the host made requests
            that are not on this table.
          </p>
        )}
        {error && (
          <p className="error-text small" role="alert">
            {error}
          </p>
        )}

        <div className="row">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void verifyAll()}
            disabled={busy || rows.length === 0 || !summary.verifiable}
            data-testid="verify-all"
          >
            {busy ? 'Verifying…' : 'Verify all'}
          </button>
          <button
            className="btn btn-sm"
            onClick={() =>
              downloadJson(
                `${p.exportName ?? `audit-${p.source.id}`}.json`,
                auditJson(p.source, { gameId: p.gameId, actions: p.actions, seat: p.seat }),
              )
            }
            data-testid="download-audit"
          >
            Download audit JSON
          </button>
        </div>

        {summary.mode === 'seeded' && summary.segments.length > 0 && (
          <div className={styles.segments} data-testid="fairness-segments">
            {summary.segments.map((s) => (
              <div
                key={s.index}
                className={styles.segment}
                data-testid={`fairness-segment-${s.index}`}
                data-revealed={s.revealed}
              >
                <span>
                  Segment {s.index + 1} · actions {s.from}
                  {s.to !== undefined ? `–${s.to}` : '…'}
                </span>
                <span className="mono small muted" title={s.commitment}>
                  {s.commitment.slice(0, 16)}…
                </span>
                <span className={`badge ${s.revealed ? 'badge-success' : ''}`}>
                  {s.revealed ? 'revealed' : 'committed'}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.rows} data-testid="fairness-rows">
          {rows.length === 0 && <span className="muted small">No draws recorded yet.</span>}
          {rows.map((row) => {
            const st = statusOf(row);
            return (
              <div
                key={row.key}
                className={styles.row}
                data-testid={`fairness-row-${row.key}`}
                data-verified={st === 'idle' || st === 'checking' ? 'pending' : st}
                data-status={st}
              >
                <span className={styles.rowIndex}>
                  {row.index === null ? 'init' : `#${row.index}`}
                </span>
                <span className={styles.rowLabel}>
                  <strong>{row.label}</strong>
                  <small>{proofLabel(row)}</small>
                </span>
                <span className={`mono ${styles.rowValues}`} title="Values drawn">
                  {row.values.length > 12
                    ? `${row.values.slice(0, 12).join(' ')} … (${row.values.length})`
                    : row.values.join(' ')}
                </span>
                <span
                  className={`${styles.rowStatus} ${styles[`status_${st}`] ?? ''}`}
                  data-testid={`fairness-status-${row.key}`}
                >
                  {statusLabel(st)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void verifyOne(row)}
                  disabled={busy || st === 'checking'}
                  data-testid={`verify-${row.key}`}
                >
                  Verify
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
