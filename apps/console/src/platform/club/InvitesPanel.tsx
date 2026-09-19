import { useState } from 'react';
import type { MemberRole } from '@bgf/protocol';
import { describeError } from '../../api/useApi';
import { QrCode } from '../../components/QrCode';
import { useToast } from '../../components/Toast';
import { platformApi } from '../api';
import type { InviteResult } from '../api';
import { fmtDate, shortId } from '../format';
import type { PanelProps } from './panel';

export function InvitesPanel({ club, refresh }: PanelProps) {
  const toast = useToast();
  const [role, setRole] = useState<MemberRole>('member');
  const [autoApprove, setAutoApprove] = useState(true);
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const uses = Number(maxUses);
      const hours = Number(expiresHours);
      const r = await platformApi.createInvite(club.id, {
        role,
        autoApprove,
        ...(uses > 0 ? { maxUses: Math.round(uses) } : {}),
        ...(hours > 0 ? { expiresAt: Date.now() + hours * 3_600_000 } : {}),
      });
      setResult(r);
      toast('Invite created');
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (nonce: string) => {
    if (!window.confirm('Revoke this invite? Links made from it stop working.')) return;
    try {
      await platformApi.revokeInvite(club.id, nonce);
      if (result?.invite.nonce === nonce) setResult(null);
      toast('Invite revoked');
      await refresh();
    } catch (err) {
      toast(describeError(err), 'error');
    }
  };
  const copy = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`));

  return (
    <div className="two-col">
      <div className="stack">
        {result && (
          <section className="card stack" data-testid="invite-result">
            <h2>Share this invite</h2>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <QrCode value={result.link} />
              <div className="stack" style={{ flex: 1, minWidth: 160 }}>
                <div>
                  <span className="label">Link</span>
                  <input
                    className="input mono small"
                    readOnly
                    value={result.link}
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="invite-link"
                  />
                </div>
                <div className="row">
                  <button
                    className="btn btn-sm"
                    onClick={() => copy(result.link, 'Link')}
                    data-testid="copy-invite-link"
                  >
                    Copy link
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => copy(result.token, 'Token')}
                    data-testid="copy-invite-token"
                  >
                    Copy token
                  </button>
                </div>
                <div>
                  <span className="label">Token</span>
                  <textarea
                    className="textarea"
                    readOnly
                    value={result.token}
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="invite-token"
                    style={{ minHeight: 80 }}
                  />
                </div>
                <p className="help">
                  Joins as {result.invite.role}
                  {result.invite.autoApprove ? ' right away' : ', pending your approval'}
                  {result.invite.maxUses ? ` · ${result.invite.maxUses} uses` : ''}
                  {result.invite.expiresAt ? ` · expires ${fmtDate(result.invite.expiresAt)}` : ''}.
                  Players open the link (or scan the code) in the web app.
                </p>
              </div>
            </div>
          </section>
        )}
        <section className="card stack">
          <div className="card-title">
            <h2>Active invites</h2>
            <span className="small muted">{club.invites.length}</span>
          </div>
          {club.invites.length === 0 ? (
            <p className="small muted" data-testid="no-invites">
              No invites yet.
            </p>
          ) : (
            <div className="seatlist" data-testid="invite-list">
              {club.invites.map((i) => (
                <div
                  key={i.nonce}
                  className="seat"
                  data-testid={`invite-${i.nonce}`}
                  style={{ flexWrap: 'wrap' }}
                >
                  <span className="name mono small">{shortId(i.nonce, 12)}</span>
                  <span className="badge">{i.role}</span>
                  <span className="small muted">
                    {i.autoApprove ? 'auto-approve' : 'pending on join'} · {i.uses}
                    {i.maxUses ? `/${i.maxUses}` : ''} used
                    {i.expiresAt ? ` · expires ${fmtDate(i.expiresAt)}` : ''}
                  </span>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void revoke(i.nonce)}
                    data-testid={`revoke-invite-${i.nonce}`}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <aside className="stack">
        <form className="card stack" onSubmit={create} data-testid="invite-form">
          <h2>New invite</h2>
          <label className="field">
            <span className="label">Role</span>
            <select
              className="select"
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              data-testid="invite-role"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              data-testid="invite-auto-approve"
            />
            Auto-approve (otherwise they join as pending)
          </label>
          <label className="field">
            <span className="label">Max uses (blank = unlimited)</span>
            <input
              className="input"
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              data-testid="invite-max-uses"
            />
          </label>
          <label className="field">
            <span className="label">Expires in hours (blank = never)</span>
            <input
              className="input"
              type="number"
              min={1}
              value={expiresHours}
              onChange={(e) => setExpiresHours(e.target.value)}
              data-testid="invite-expires-hours"
            />
          </label>
          {error && (
            <p className="error-text" data-testid="invite-error">
              {error}
            </p>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy}
            data-testid="create-invite"
          >
            {busy ? 'Creating…' : 'Create invite'}
          </button>
          <p className="help">
            An invite is a token signed by the club; the link opens the web app's join screen with
            it. Revoking the invite invalidates every link made from it.
          </p>
        </form>
      </aside>
    </div>
  );
}
