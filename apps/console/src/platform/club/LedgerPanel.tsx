import { useState } from 'react';
import type { LedgerKind } from '@bgf/protocol';
import { describeError, useResource } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { LEDGER_KINDS, platformApi } from '../api';
import type { HistoryRecord, LedgerVerification } from '../api';
import { bpsToPercent, fmtChips, fmtSigned, fmtTime, shortId } from '../format';
import type { PanelProps } from './panel';

const PAGE = 50;

function describeHistory(h: HistoryRecord): string {
  const d = (h.data ?? {}) as Record<string, unknown>;
  switch (h.kind) {
    case 'ledger':
      return `ledger #${h.seq ?? '?'} ${String(d.kind ?? '')}${d.ref && typeof d.ref === 'object' && (d.ref as { note?: string }).note ? ` — ${(d.ref as { note?: string }).note}` : ''}`;
    case 'hand':
    case 'game': {
      const transfers = (d.transfers as Array<{ from: string; to: string; points: number }>) ?? [];
      return `${h.kind} ${String(d.round ?? '')}: ${transfers
        .map((t) => `${shortId(t.from, 6)} → ${shortId(t.to, 6)} ${t.points} pts`)
        .join(', ')}${d.rake ? ` · rake ${String(d.rake)}` : ''}`;
    }
    case 'purchase':
      return `${String(d.amount ?? '')} chips via ${String(d.method ?? '')}${d.reference ? ` (${String(d.reference)})` : ''}`;
    default:
      return JSON.stringify(h.data).slice(0, 200);
  }
}

export function LedgerPanel({ club }: PanelProps) {
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<'all' | LedgerKind>('all');
  const { data, error, refresh } = useResource(
    () => platformApi.ledger(club.id, { offset, limit: PAGE }),
    `${club.id}:${offset}`,
  );
  const [verification, setVerification] = useState<LedgerVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [historyMember, setHistoryMember] = useState('');
  const [historyTable, setHistoryTable] = useState('');
  const [history, setHistory] = useState<HistoryRecord[] | null>(null);

  const nameOf = (account: string) =>
    account === 'house' || account.startsWith('table:') || account.startsWith('tournament:')
      ? account
      : (club.members.find((m) => m.id === account)?.name ?? shortId(account));
  const entries = (data?.entries ?? []).filter((e) => kind === 'all' || e.kind === kind);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  const verify = async () => {
    setVerifying(true);
    try {
      setVerification(await platformApi.verify(club.id));
    } catch (e) {
      toast(describeError(e), 'error');
    } finally {
      setVerifying(false);
    }
  };
  const loadHistory = async () => {
    try {
      setHistory(
        await platformApi.history(club.id, {
          ...(historyMember.trim() ? { member: historyMember.trim() } : {}),
          ...(historyTable.trim() ? { table: historyTable.trim() } : {}),
        }),
      );
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };

  return (
    <div className="stack">
      <section className="card stack" data-testid="ledger-panel">
        <div className="card-title" style={{ flexWrap: 'wrap' }}>
          <h2>Ledger</h2>
          <div className="row">
            <select
              className="select input-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'all' | LedgerKind)}
              data-testid="ledger-kind"
              style={{ width: 140, textAlign: 'left' }}
            >
              <option value="all">all kinds</option>
              {LEDGER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm"
              onClick={() => void refresh()}
              data-testid="refresh-ledger"
            >
              Refresh
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void verify()}
              disabled={verifying}
              data-testid="verify-ledger"
            >
              {verifying ? 'Verifying…' : 'Verify ledger'}
            </button>
          </div>
        </div>
        {verification && (
          <p
            className={verification.ok ? 'small' : 'error-text'}
            data-testid="verify-result"
            data-ok={String(verification.ok)}
          >
            {verification.ok
              ? `✓ ${verification.entries} entries verified: hashes chain, every entry is signed by the club and certificates check out.`
              : `✗ Problem at seq ${verification.problem?.seq ?? '?'}: ${verification.problem?.reason ?? 'unknown'}`}
            {verification.totals &&
              ` Minted ${fmtChips(verification.totals.minted, club.currency)} · burned ${fmtChips(
                verification.totals.burned,
                club.currency,
              )} · reserve ${fmtChips(verification.totals.reserve, club.currency)} · circulation ${fmtChips(
                verification.totals.circulation,
                club.currency,
              )}.`}
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!data ? (
          <p className="muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="small muted" data-testid="no-entries">
            {total === 0 ? 'The ledger is empty.' : 'No entries of that kind on this page.'}
          </p>
        ) : (
          <div className="log" data-testid="ledger-list" style={{ maxHeight: 520 }}>
            {entries.map((e) => (
              <div
                key={e.seq}
                data-testid={`ledger-entry-${e.seq}`}
                data-kind={e.kind}
                style={{ gridTemplateColumns: '48px 62px 80px 1fr' }}
              >
                <span className="muted">#{e.seq}</span>
                <time>{fmtTime(e.at)}</time>
                <span className="badge">{e.kind}</span>
                <span>
                  {e.lines
                    .map((l) => `${nameOf(l.account)} ${fmtSigned(l.amount, club.currency)}`)
                    .join(' · ')}
                  {e.ref?.note ? ` — ${e.ref.note}` : ''}
                  {e.ref?.tableId
                    ? ` [table ${shortId(e.ref.tableId)}${e.ref.hand ? ` hand ${e.ref.hand}` : ''}]`
                    : ''}
                  {e.ref?.basisPoints
                    ? ` (${bpsToPercent(e.ref.basisPoints)} of ${fmtChips(e.ref.moved ?? 0, club.currency)})`
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <button
            className="btn btn-sm"
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
            disabled={offset === 0}
            data-testid="ledger-prev"
          >
            Newer
          </button>
          <span className="small muted" data-testid="ledger-page">
            page {page} of {pages} · {total} entries
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setOffset(offset + PAGE)}
            disabled={offset + PAGE >= total}
            data-testid="ledger-next"
          >
            Older
          </button>
        </div>
        <p className="help">
          Newest first; the kind filter applies to the page shown. Every entry is hash-chained and
          signed by the club key; verifying re-checks the whole chain on the server.
        </p>
      </section>
      <section className="card stack" data-testid="history-panel">
        <div className="card-title">
          <h2>History</h2>
          <span className="small muted">hands, purchases, sits and ledger lines as recorded</span>
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="member id"
            value={historyMember}
            onChange={(e) => setHistoryMember(e.target.value)}
            data-testid="history-member"
            style={{ width: 260 }}
          />
          <input
            className="input"
            placeholder="table id"
            value={historyTable}
            onChange={(e) => setHistoryTable(e.target.value)}
            data-testid="history-table"
            style={{ width: 260 }}
          />
          <button
            className="btn btn-sm"
            onClick={() => void loadHistory()}
            data-testid="load-history"
          >
            Load history
          </button>
        </div>
        {history &&
          (history.length === 0 ? (
            <p className="small muted" data-testid="no-history">
              Nothing recorded for that filter.
            </p>
          ) : (
            <div className="log" data-testid="history-list">
              {history
                .slice()
                .reverse()
                .map((h, i) => (
                  <div key={i} data-kind={h.kind} style={{ gridTemplateColumns: '62px 80px 1fr' }}>
                    <time>{fmtTime(h.at)}</time>
                    <span className="badge">{h.kind}</span>
                    <span>{describeHistory(h)}</span>
                  </div>
                ))}
            </div>
          ))}
      </section>
    </div>
  );
}
