import { useState } from 'react';
import { describeError } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { platformApi } from '../api';
import type { PlatformEvent, PurchaseMethod } from '../api';
import { fmtChips, fmtDate, fmtTime } from '../format';
import { useSession } from '../session';
import type { PanelProps } from './panel';

function Stat({
  id,
  label,
  value,
  help,
}: {
  id: string;
  label: string;
  value: string;
  help: string;
}) {
  return (
    <div className="card stack" style={{ gap: 4 }} data-testid={`stat-${id}`}>
      <span className="label">{label}</span>
      <span className="mono" style={{ fontSize: '1.5rem', fontWeight: 650 }}>
        {value}
      </span>
      <span className="help">{help}</span>
    </div>
  );
}

export function OverviewPanel({
  club,
  admin,
  refresh,
  events,
}: PanelProps & { events: PlatformEvent[] }) {
  const { status } = useSession();
  const toast = useToast();
  const dev = status?.dev === true;
  const [amount, setAmount] = useState('1000');
  const [method, setMethod] = useState<PurchaseMethod>(dev ? 'dev' : 'manual');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeMembers = club.members.filter((m) => m.status === 'active').length;
  const templates = club.rooms.reduce((a, r) => a + r.templates.length, 0);
  const owner = club.members.find((m) => m.id === club.ownerId);
  const purchases = club.purchases.slice().sort((a, b) => b.createdAt - a.createdAt);

  const buy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0)
      return setError('Amount must be a positive integer (minor units).');
    setBusy(true);
    try {
      const p = await platformApi.purchase(club.id, {
        amount: n,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      toast(
        p.status === 'paid'
          ? `${fmtChips(p.amount, club.currency)} minted into the reserve`
          : 'Purchase recorded; the operator marks it paid',
      );
      setReference('');
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="two-col">
      <div className="stack">
        <div className="grid" data-testid="stats">
          <Stat
            id="reserve"
            label="Reserve"
            value={fmtChips(club.reserve, club.currency)}
            help="House balance: chips bought from the platform and not yet granted"
          />
          <Stat
            id="circulation"
            label="In circulation"
            value={fmtChips(club.circulation, club.currency)}
            help="Held by members and on tables"
          />
          <Stat
            id="minted"
            label="Minted"
            value={fmtChips(club.minted, club.currency)}
            help="Everything ever bought from the platform"
          />
          <Stat
            id="burned"
            label="Burned"
            value={fmtChips(club.burned, club.currency)}
            help="Rake and fees destroyed for good"
          />
        </div>
        <section className="card stack">
          <h2>Club</h2>
          <dl className="kv">
            <dt>Members</dt>
            <dd data-testid="stat-members">
              {activeMembers} active · {club.pendingMembers} pending · {club.online.length} online
            </dd>
            <dt>Rooms</dt>
            <dd data-testid="stat-rooms">
              {club.rooms.length} room{club.rooms.length === 1 ? '' : 's'} · {templates} template
              {templates === 1 ? '' : 's'} · {club.tables.length} live table
              {club.tables.length === 1 ? '' : 's'}
            </dd>
            <dt>Currency</dt>
            <dd>
              {club.currency.name} ({club.currency.code}, {club.currency.decimals} decimals)
            </dd>
            <dt>Owner</dt>
            <dd className="small">
              {owner?.name ?? '—'} <span className="mono muted">{club.ownerId}</span>
            </dd>
            <dt>Club id</dt>
            <dd className="mono small">{club.id}</dd>
            <dt>Public key</dt>
            <dd className="mono small" style={{ wordBreak: 'break-all' }}>
              {club.publicKey}
            </dd>
            <dt>Created</dt>
            <dd>{fmtDate(club.createdAt)}</dd>
          </dl>
        </section>
        <section className="card stack">
          <div className="card-title">
            <h2>Activity</h2>
            <span className="small muted">live platform events for this club</span>
          </div>
          <div className="log" data-testid="event-log">
            {events.length === 0 && <span className="muted">Nothing yet.</span>}
            {events
              .slice()
              .reverse()
              .map((e) => (
                <div key={e.seq} data-type={e.type}>
                  <time>{fmtTime(e.at)}</time>
                  <span>{e.message}</span>
                </div>
              ))}
          </div>
        </section>
      </div>
      <aside className="stack">
        {admin && (
          <form className="card stack" onSubmit={buy} data-testid="buy-form">
            <h2>Buy chips</h2>
            <p className="help">
              The platform sells chips to the club; a paid purchase is minted into the reserve with
              a signed certificate. Amounts are in minor units of {club.currency.code}.
            </p>
            <label className="field">
              <span className="label">Amount</span>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="buy-amount"
              />
            </label>
            <label className="field">
              <span className="label">Method</span>
              <select
                className="select"
                value={method}
                onChange={(e) => setMethod(e.target.value as PurchaseMethod)}
                data-testid="buy-method"
              >
                {dev && <option value="dev">Dev (instant, minted now)</option>}
                <option value="manual">Manual (the operator marks it paid)</option>
              </select>
            </label>
            {method === 'manual' && (
              <label className="field">
                <span className="label">Payment reference</span>
                <input
                  className="input"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="INV-42, bank transfer…"
                  maxLength={120}
                  data-testid="buy-reference"
                />
              </label>
            )}
            {error && (
              <p className="error-text" data-testid="buy-error">
                {error}
              </p>
            )}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
              data-testid="buy-submit"
            >
              {busy ? 'Buying…' : 'Buy chips'}
            </button>
          </form>
        )}
        {admin && (
          <section className="card stack">
            <div className="card-title">
              <h2>Purchases</h2>
              <span className="small muted">{purchases.length}</span>
            </div>
            {purchases.length === 0 ? (
              <p className="small muted" data-testid="no-purchases">
                No purchases yet.
              </p>
            ) : (
              <div className="seatlist" data-testid="purchase-list">
                {purchases.map((p) => (
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
                            : ''
                      }`}
                    >
                      {p.status}
                    </span>
                    <span className="name mono">{fmtChips(p.amount, club.currency)}</span>
                    <span className="small muted">
                      {p.method}
                      {p.reference ? ` · ${p.reference}` : ''} · {fmtDate(p.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
