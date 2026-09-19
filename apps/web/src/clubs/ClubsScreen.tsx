import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useProfile } from '../session/ProfileProvider';
import { relativeTime } from '../session/time';
import { useJoinedClubs, forgetClub } from './clubsStore';
import { extractClubToken, decodeClubInvite } from './invites';
import { formatChips } from './money';
import styles from './clubs.module.css';

/** `#/<profile>/clubs` — the clubs this player belongs to, plus joining a new one by invite. */
export function ClubsScreen() {
  const { slug, path, profile } = useProfile();
  const navigate = useNavigate();
  const clubs = useJoinedClubs(slug);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);

  const join = (e: FormEvent) => {
    e.preventDefault();
    const token = extractClubToken(invite);
    if (!token) {
      setError('Paste a club invite link or token (it starts with p2pc1.)');
      return;
    }
    try {
      decodeClubInvite(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That invite could not be read');
      return;
    }
    setError(null);
    navigate(path(`/club/join/${token}`));
  };

  return (
    <div className="page" data-testid="clubs-screen">
      <section className={`${styles.hero} fade-up`}>
        <div className="eyebrow">Clubs · chips · rooms</div>
        <h1>Your clubs</h1>
        <p className="muted">
          A club runs on someone's dealer runtime: it keeps a member list, house chips, and rooms of
          tables. Playing as <strong>{profile.name}</strong>.
        </p>
      </section>

      <div className="stack">
        {clubs.length === 0 ? (
          <p className="muted" data-testid="clubs-empty">
            You have not joined a club yet.
          </p>
        ) : (
          <div className={styles.grid} data-testid="clubs-list">
            {clubs.map((c) => (
              <div
                key={c.clubId}
                className={`card ${styles.clubCard}`}
                data-testid={`club-${c.clubId}`}
              >
                <Link to={path(`/club/${c.clubId}`)} data-testid={`open-club-${c.clubId}`}>
                  <strong>{c.name}</strong>
                </Link>
                <span className="muted small">
                  {c.balance !== undefined ? formatChips(c.balance, c.currency) : c.currency.name} ·{' '}
                  last seen {relativeTime(c.lastSeen)}
                </span>
                <span className={styles.form}>
                  <Link to={path(`/club/${c.clubId}`)} className="btn btn-primary btn-sm">
                    Enter lobby
                  </Link>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => forgetClub(slug, c.clubId)}
                    data-testid={`forget-club-${c.clubId}`}
                  >
                    Forget
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <form className="card" onSubmit={join} data-testid="club-join-form">
          <h2>Join a club</h2>
          <p className="muted small">
            Paste the invite link or token a club sent you. Scanning its QR opens the same link.
          </p>
          <div className={styles.form}>
            <input
              className="input"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="https://…#/club/join/p2pc1.… or p2pc1.…"
              aria-label="Club invite"
              data-testid="club-invite-input"
              style={{ flex: 1, minWidth: 240 }}
            />
            <button type="submit" className="btn btn-primary" data-testid="club-join-button">
              Join
            </button>
          </div>
          {error && (
            <p className="error" role="alert" data-testid="club-join-error">
              {error}
            </p>
          )}
        </form>

        <div className="card">
          <h2>Run your own club</h2>
          <p className="muted small">
            Start the dealer runtime from a terminal (<code>pnpm dealer serve</code>) and open its
            console to create a club, set its chips, add rooms and hand out invites. See the README
            section "Dealer console".
          </p>
        </div>
      </div>
    </div>
  );
}
