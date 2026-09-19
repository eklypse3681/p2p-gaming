import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useProfile } from '../session/ProfileProvider';
import { SessionError } from '../session/session';
import type { FlowProgress } from '../session/retry';
import { decodeClubInvite } from './invites';
import { rememberClub } from './clubsStore';
import { connectClub } from './session';
import { useClubRegistry } from './ClubRegistry';

/** `#/<profile>/club/join/:token` — decode the invite, connect, remember the club, enter the lobby. */
export function ClubJoinScreen() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { slug, path, ready } = useProfile();
  const registry = useClubRegistry();
  const decoded = useMemo(() => {
    try {
      return { ok: true as const, ...decodeClubInvite(token) };
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : 'Bad invite' };
    }
  }, [token]);
  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const started = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const run = async () => {
    if (!decoded.ok) return;
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setError(null);
    setRejected(null);
    const { invite } = decoded;
    try {
      const { profile, signer } = await ready();
      const session = await connectClub(
        {
          slug,
          clubId: invite.clubId,
          address: invite.address,
          profile,
          signer: signer ?? undefined,
          invite: decoded.token,
        },
        { signal: ctl.signal, onProgress: setProgress },
      );
      if (ctl.signal.aborted) {
        session.dispose();
        return;
      }
      const lobby = session.client.getState().lobby;
      rememberClub(slug, {
        clubId: invite.clubId,
        name: lobby?.club.name ?? invite.clubName,
        address: invite.address,
        currency: lobby?.club.currency ?? { code: 'chips', name: 'Chips', decimals: 0 },
        lastSeen: Date.now(),
        balance: lobby?.me.balance,
        invite: decoded.token,
      });
      registry.add(slug, session);
      navigate(path(`/club/${invite.clubId}`), { replace: true });
    } catch (e) {
      if (e instanceof SessionError && e.code === 'cancelled') return;
      if (e instanceof SessionError && e.code === 'rejected') setRejected(e.message);
      else setError(e instanceof SessionError ? e.message : 'Could not reach the club');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    return () => {
      setTimeout(() => controller.current?.abort(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!decoded.ok) {
    return (
      <div className="page page-narrow" data-testid="club-join-screen">
        <div className="card">
          <h1>That invite could not be read</h1>
          <p className="muted" data-testid="club-join-error">
            {decoded.message}
          </p>
          <Link to={path('/clubs')} className="btn">
            Back to clubs
          </Link>
        </div>
      </div>
    );
  }
  const { invite } = decoded;
  return (
    <div className="page page-narrow" data-testid="club-join-screen" data-club={invite.clubId}>
      <div className="card">
        <div className="eyebrow">Club invite</div>
        <h1>{invite.clubName}</h1>
        {rejected ? (
          <>
            <p className="error" role="alert" data-testid="club-rejected">
              {rejected}
            </p>
            <p className="muted small">
              If your membership is pending, an admin has to approve it in the club console; come
              back with the same invite afterwards.
            </p>
          </>
        ) : error ? (
          <p className="error" role="alert" data-testid="club-join-error">
            {error}
          </p>
        ) : (
          <p className="muted" data-testid="club-join-progress">
            Connecting as {invite.role}
            {progress ? ` · attempt ${progress.attempt}` : ''}
            {progress?.nextRetryMs
              ? ` · retrying in ${Math.ceil(progress.nextRetryMs / 1000)} s`
              : ''}
            …
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(error || rejected) && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void run()}
              data-testid="club-join-retry"
            >
              Try again
            </button>
          )}
          <Link to={path('/clubs')} className="btn btn-ghost" data-testid="club-join-cancel">
            Back to clubs
          </Link>
        </div>
      </div>
    </div>
  );
}
