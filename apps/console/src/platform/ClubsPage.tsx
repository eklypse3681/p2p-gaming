import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '../api/useApi';
import { useToast } from '../components/Toast';
import { platformApi } from './api';
import type { ClubRole, ClubSummary } from './api';
import { fmtChips } from './format';
import { useSession } from './session';

function ClubCard({ club }: { club: ClubSummary & { role: ClubRole } }) {
  const navigate = useNavigate();
  return (
    <article className="card stack" data-testid={`club-card-${club.id}`} data-role={club.role}>
      <div className="card-title">
        <div>
          <h3>{club.name}</h3>
          {club.tagline && <div className="small muted">{club.tagline}</div>}
        </div>
        <span
          className={`badge ${club.status === 'active' ? 'badge-success' : 'badge-danger'}`}
          data-testid="club-role"
        >
          {club.role}
        </span>
      </div>
      <div className="small">
        {club.members} member{club.members === 1 ? '' : 's'} · {club.online} online · {club.tables}{' '}
        table{club.tables === 1 ? '' : 's'} · {club.rooms} room
        {club.rooms === 1 ? '' : 's'}
      </div>
      <div className="small muted">
        Reserve <span className="mono">{fmtChips(club.reserve, club.currency)}</span> · in play{' '}
        <span className="mono">{fmtChips(club.circulation, club.currency)}</span>
      </div>
      <div className="row">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => navigate(`/clubs/${encodeURIComponent(club.id)}`)}
          data-testid={`open-club-${club.id}`}
        >
          Open
        </button>
      </div>
    </article>
  );
}

export function ClubsPage() {
  const { me, refreshMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [code, setCode] = useState('chips');
  const [currencyName, setCurrencyName] = useState('Chips');
  const [decimals, setDecimals] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clubs = me?.clubs ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('A club needs a name.');
    setBusy(true);
    try {
      const club = await platformApi.createClub({
        name: name.trim(),
        currency: {
          code: code.trim() || 'chips',
          name: currencyName.trim() || 'Chips',
          decimals: Math.max(0, Math.min(6, Math.round(Number(decimals) || 0))),
        },
        ...(tagline.trim() ? { tagline: tagline.trim() } : {}),
      });
      toast(`Club ${club.name} created`);
      await refreshMe();
      navigate(`/clubs/${encodeURIComponent(club.id)}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" data-testid="clubs-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Platform</span>
          <h1>My clubs</h1>
          <p className="muted">
            Clubs you own, administer or belong to
            {me?.operator ? '; as an operator you see every club the platform hosts' : ''}.
          </p>
        </div>
      </div>
      <div className="two-col">
        <div className="stack">
          {clubs.length ? (
            <div className="grid" data-testid="club-list">
              {clubs.map((c) => (
                <ClubCard key={c.id} club={c} />
              ))}
            </div>
          ) : (
            <div className="card" data-testid="no-clubs">
              <p>
                No clubs yet. Create one here, or ask a club for an invite link and join from the
                web app.
              </p>
            </div>
          )}
        </div>
        <aside className="stack">
          <form className="card stack" onSubmit={submit} data-testid="create-club-form">
            <h2>Create a club</h2>
            <label className="field">
              <span className="label">Club name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Thursday Pineapple Club"
                data-testid="club-name"
              />
            </label>
            <label className="field">
              <span className="label">Tagline (optional)</span>
              <input
                className="input"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                maxLength={140}
                placeholder="Shown in the lobby"
                data-testid="club-tagline"
              />
            </label>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                <span className="label">Currency code</span>
                <input
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={12}
                  data-testid="currency-code"
                />
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span className="label">Currency name</span>
                <input
                  className="input"
                  value={currencyName}
                  onChange={(e) => setCurrencyName(e.target.value)}
                  maxLength={40}
                  data-testid="currency-name"
                />
              </label>
              <label className="field" style={{ width: 110 }}>
                <span className="label">Decimals</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={6}
                  value={decimals}
                  onChange={(e) => setDecimals(e.target.value)}
                  data-testid="currency-decimals"
                />
              </label>
            </div>
            <p className="help">
              Amounts are kept as integers in minor units; decimals only change how they are shown.
              You become the club's owner; the platform generates and keeps the club's signing key.
            </p>
            {error && (
              <p className="error-text" data-testid="create-club-error">
                {error}
              </p>
            )}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
              data-testid="create-club"
            >
              {busy ? 'Creating…' : 'Create club'}
            </button>
          </form>
        </aside>
      </div>
    </main>
  );
}
