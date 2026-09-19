import { useState } from 'react';
import type { MemberStatement } from '@bgf/protocol';
import { useResource } from '../../api/useApi';
import { platformApi } from '../api';
import { fmtChips, fmtSigned, fmtTime, shortId } from '../format';
import { useSession } from '../session';
import type { PanelProps } from './panel';

interface Line {
  seq: number;
  at: number;
  kind: string;
  description: string;
  change: number;
  balance: number | null;
}

const num = (v: unknown, dflt: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Statement lines as the club sends them (`history`), or rebuilt from the raw entries. */
export function statementLines(s: MemberStatement): Line[] {
  const raw = (s.history ?? []) as unknown as Array<Record<string, unknown>>;
  if (raw.length) {
    return raw.map((r, i) => ({
      seq: num(r.seq, i) ?? i,
      at: num(r.at, 0) ?? 0,
      kind: text(r.kind),
      description: text(r.description) || text(r.note),
      change: num(r.amount, null) ?? num(r.change, null) ?? num(r.delta, 0) ?? 0,
      balance: num(r.balance, null),
    }));
  }
  let running = 0;
  return (s.entries ?? []).map((e) => {
    const change = e.lines
      .filter((l) => l.account === s.memberId)
      .reduce((a, l) => a + l.amount, 0);
    running += change;
    return {
      seq: e.seq,
      at: e.at,
      kind: e.kind,
      description: e.ref?.note ?? '',
      change,
      balance: running,
    };
  });
}

export function StatementsPanel({ club, admin }: PanelProps) {
  const { me } = useSession();
  const [memberId, setMemberId] = useState(me?.profileId ?? '');
  const { data, error, refresh } = useResource(
    () =>
      memberId
        ? platformApi.statement(club.id, memberId)
        : Promise.resolve<MemberStatement | null>(null),
    `${club.id}:${memberId}`,
  );
  const lines = data ? statementLines(data) : [];
  const meIsMember = !!me && club.members.some((m) => m.id === me.profileId);

  return (
    <section className="card stack" data-testid="statements-panel">
      <div className="card-title" style={{ flexWrap: 'wrap' }}>
        <h2>Statement</h2>
        <div className="row">
          {admin ? (
            <select
              className="select input-sm"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              data-testid="statement-member"
              style={{ width: 240, textAlign: 'left' }}
            >
              {me && !meIsMember && <option value={me.profileId}>{me.name} (you)</option>}
              {club.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === me?.profileId ? ' (you)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="small muted">{me?.name}</span>
          )}
          <button
            className="btn btn-sm"
            onClick={() => void refresh()}
            data-testid="refresh-statement"
          >
            Refresh
          </button>
        </div>
      </div>
      {error && (
        <p className="error-text" data-testid="statement-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <dl className="kv">
            <dt>Member</dt>
            <dd className="mono small">{data.memberId}</dd>
            <dt>Balance</dt>
            <dd className="mono" data-testid="statement-balance">
              {fmtChips(data.balance, club.currency)}
            </dd>
            <dt>Ledger head</dt>
            <dd className="mono small">
              seq {data.head?.seq ?? 0} · {shortId(data.head?.hash ?? '', 16)}
            </dd>
          </dl>
          {lines.length === 0 ? (
            <p className="small muted" data-testid="no-statement-lines">
              No entries touch this account yet.
            </p>
          ) : (
            <div className="log" data-testid="statement-lines">
              {lines
                .slice()
                .reverse()
                .map((l) => (
                  <div
                    key={l.seq}
                    data-testid={`statement-line-${l.seq}`}
                    data-kind={l.kind}
                    style={{ gridTemplateColumns: '48px 62px 80px 1fr 120px 120px' }}
                  >
                    <span className="muted">#{l.seq}</span>
                    <time>{fmtTime(l.at)}</time>
                    <span className="badge">{l.kind}</span>
                    <span>{l.description}</span>
                    <span className="mono">{fmtSigned(l.change, club.currency)}</span>
                    <span className="mono muted">
                      {l.balance === null ? '' : fmtChips(l.balance, club.currency)}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
      <p className="help">
        {admin
          ? 'Pick any member; members only ever see their own statement.'
          : 'Your own entries with running balances, signed by the club.'}
      </p>
    </section>
  );
}
