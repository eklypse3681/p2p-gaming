import { useState } from 'react';
import type { MemberRole } from '@bgf/protocol';
import { describeError } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { platformApi } from '../api';
import type { ClubDetail } from '../api';
import { fmtChips, fmtDate, shortId } from '../format';
import { useSession } from '../session';
import type { PanelProps } from './panel';

const STATUS_ORDER = { pending: 0, active: 1, banned: 2 } as const;

export function MembersPanel({ club, admin, setClub }: PanelProps) {
  const toast = useToast();
  const { me } = useSession();
  const [chips, setChips] = useState<{
    memberId: string;
    kind: 'grant' | 'redeem';
    amount: string;
    note: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<ClubDetail>, done: string) => {
    setBusy(true);
    try {
      setClub(await fn());
      toast(done);
    } catch (e) {
      toast(describeError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const submitChips = async () => {
    if (!chips) return;
    const n = Number(chips.amount);
    if (!Number.isInteger(n) || n <= 0) return toast('Amount must be a positive integer', 'error');
    const body = { amount: n, ...(chips.note.trim() ? { note: chips.note.trim() } : {}) };
    const who = club.members.find((m) => m.id === chips.memberId)?.name ?? chips.memberId;
    await act(
      () =>
        chips.kind === 'grant'
          ? platformApi.grant(club.id, chips.memberId, body)
          : platformApi.redeem(club.id, chips.memberId, body),
      `${chips.kind === 'grant' ? 'Granted' : 'Redeemed'} ${fmtChips(n, club.currency)} ${
        chips.kind === 'grant' ? 'to' : 'from'
      } ${who}`,
    );
    setChips(null);
  };
  const sorted = club.members
    .slice()
    .sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
    );
  const count = (s: string) => club.members.filter((m) => m.status === s).length;

  return (
    <section className="card stack" data-testid="members-panel">
      <div className="card-title">
        <h2>Members</h2>
        <span className="small muted">
          {count('active')} active · {count('pending')} pending · {count('banned')} banned ·{' '}
          {club.online.length} online
        </span>
      </div>
      {sorted.length === 0 && <p className="small muted">No members yet.</p>}
      <div className="seatlist" data-testid="member-list">
        {sorted.map((m) => {
          const online = club.online.includes(m.id);
          const isOwner = m.role === 'owner';
          return (
            <div
              key={m.id}
              className="seat"
              data-testid={`member-${m.id}`}
              data-status={m.status}
              data-role={m.role}
              style={{ flexWrap: 'wrap' }}
            >
              <span className={`dot ${online ? 'dot-live' : ''}`} />
              <span className="name">
                {m.name}
                {m.id === me?.profileId ? ' (you)' : ''}
              </span>
              <span className="small muted mono">{shortId(m.id)}</span>
              <span
                className={`badge ${
                  m.status === 'active'
                    ? 'badge-success'
                    : m.status === 'banned'
                      ? 'badge-danger'
                      : 'badge-accent'
                }`}
              >
                {m.status}
              </span>
              {admin && !isOwner ? (
                <select
                  className="select input-sm"
                  style={{ width: 120, textAlign: 'left' }}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => {
                    const role = e.target.value as MemberRole;
                    void act(
                      () => platformApi.setRole(club.id, m.id, role),
                      `${m.name} is now ${role}`,
                    );
                  }}
                  data-testid={`role-${m.id}`}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              ) : (
                <span className="badge">{m.role}</span>
              )}
              <span className="small muted">joined {fmtDate(m.joinedAt)}</span>
              {admin && (
                <span className="row" style={{ gap: 6 }}>
                  {m.status === 'pending' && (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(() => platformApi.approve(club.id, m.id), `${m.name} approved`)
                      }
                      data-testid={`approve-${m.id}`}
                    >
                      Approve
                    </button>
                  )}
                  {m.status !== 'banned' && !isOwner && (
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Ban ${m.name}? They lose access to the club.`))
                          void act(() => platformApi.ban(club.id, m.id), `${m.name} banned`);
                      }}
                      data-testid={`ban-${m.id}`}
                    >
                      Ban
                    </button>
                  )}
                  {m.status === 'active' && (
                    <>
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setChips({ memberId: m.id, kind: 'grant', amount: '', note: '' })
                        }
                        data-testid={`grant-${m.id}`}
                      >
                        Grant…
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setChips({ memberId: m.id, kind: 'redeem', amount: '', note: '' })
                        }
                        data-testid={`redeem-${m.id}`}
                      >
                        Redeem…
                      </button>
                    </>
                  )}
                </span>
              )}
              {chips?.memberId === m.id && (
                <div
                  className="row"
                  style={{ width: '100%' }}
                  data-testid="chips-form"
                  data-kind={chips.kind}
                >
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    placeholder={`amount (${club.currency.code}, minor units)`}
                    value={chips.amount}
                    onChange={(e) => setChips({ ...chips, amount: e.target.value })}
                    data-testid="chips-amount"
                    style={{ width: 220 }}
                  />
                  <input
                    className="input"
                    placeholder="note"
                    value={chips.note}
                    onChange={(e) => setChips({ ...chips, note: e.target.value })}
                    data-testid="chips-note"
                    style={{ width: 220 }}
                  />
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void submitChips()}
                    disabled={busy}
                    data-testid="chips-confirm"
                  >
                    {chips.kind === 'grant' ? 'Grant from reserve' : 'Redeem to reserve'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setChips(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="help">
        Grants move chips from the reserve to a member; redeems move them back. Every move is a
        signed ledger entry.
      </p>
    </section>
  );
}
