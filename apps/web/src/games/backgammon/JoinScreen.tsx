import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { getMatchStore } from '../../session/matchStore';
import { getProvider } from '../../session/providers';
import { joinMatch, SessionError } from '../../session/session';
import { useSessionRegistry } from '../../session/SessionRegistry';
import { extractCode } from '../../session/links';
import type { FlowProgress } from '../../session/retry';
import { describeTrust } from '@bgf/table';
import { backgammonDefinition } from '@bgf/server';
import { TrustBadge } from '../../hud/TrustBadge';
import { ClubChip } from '../../clubs/ClubChip';

export function JoinScreen() {
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const registry = useSessionRegistry();
  const { profile, slug, ready } = useProfile();
  const { path, id: gameId } = useGame();
  const autoCode =
    codeParam && isValidRoomCode(normalizeRoomCode(codeParam))
      ? normalizeRoomCode(codeParam)
      : null;
  const [code, setCode] = useState(autoCode ?? (codeParam ? normalizeRoomCode(codeParam) : ''));
  // Arriving with a valid code in the address: start joining immediately.
  const [busy, setBusy] = useState(() => !!autoCode);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const started = useRef(false);
  const controller = useRef<AbortController | null>(null);
  // Abort an in-flight join only when the screen really goes away (StrictMode re-mounts run the
  // cleanup and immediately mount again; a deferred check tells the two apart).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) controller.current?.abort();
      }, 0);
    };
  }, []);

  const runJoin = async (c: string) => {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setProgress(null);
    try {
      const { profile, signer } = await ready();
      const session = await joinMatch(
        { code: c, profile, signer: signer ?? undefined, attempts: 3 },
        { provider: getProvider(slug, gameId), store: getMatchStore(slug, gameId) },
        { signal: ctl.signal, onProgress: setProgress },
      );
      if (ctl.signal.aborted) {
        session.dispose();
        return;
      }
      registry.add(slug, gameId, session);
      navigate(`${path(`/game/${session.matchId}`)}${location.search}`, { replace: true });
    } catch (err) {
      if (err instanceof SessionError && err.code === 'cancelled') return;
      setError(err instanceof SessionError ? err.message : 'Could not join the match');
      setBusy(false);
    }
  };
  const cancelJoin = () => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setProgress(null);
  };

  useEffect(() => {
    if (started.current || !autoCode) return;
    started.current = true;
    void runJoin(autoCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCode]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeRoomCode(extractCode(code));
    if (!isValidRoomCode(c)) {
      setError('That does not look like a room code');
      return;
    }
    setBusy(true);
    setError(null);
    void runJoin(c);
  };

  const joinTrust = describeTrust(backgammonDefinition, { hostSeat: 0 });
  return (
    <div className="page page-narrow" data-testid="join-screen">
      <ClubChip />
      <form className="card stack" onSubmit={submit}>
        <div>
          <div className="eyebrow">Join</div>
          <h1>Join a match</h1>
          <p className="muted">
            Enter the code your opponent shared. They need to have the table open.
          </p>
          <p className="muted small" data-testid="join-as">
            Joining as <span aria-hidden="true">{profile.avatar}</span>{' '}
            <strong>{profile.name}</strong>
          </p>
          <p className="small" data-testid="join-trust">
            <TrustBadge trust={joinTrust} />{' '}
            <span className="muted">
              {joinTrust.hiddenInformation
                ? 'On a player-hosted table the host’s device can see hidden cards; a dealer-hosted table shows “Dealer-hosted” once you are in.'
                : 'Nothing at this table is hidden from anyone.'}
            </span>
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="join-code">
            Room code
          </label>
          <input
            id="join-code"
            className="input mono"
            data-testid="join-code-input"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ letterSpacing: '0.2em', fontSize: '1.2rem' }}
          />
        </div>
        {busy && (
          <div className="row" data-testid="join-progress" data-attempt={progress?.attempt ?? 1}>
            <span className="pulse">●</span>
            <span className="muted">
              {progress && progress.attempt > 1
                ? `Looking for the host… attempt ${progress.attempt}${progress.nextRetryMs !== undefined ? ` · retrying in ${Math.ceil(progress.nextRetryMs / 1000)} s` : ''}`
                : progress?.nextRetryMs !== undefined
                  ? `No answer yet · retrying in ${Math.ceil(progress.nextRetryMs / 1000)} s`
                  : 'Looking for the host…'}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={cancelJoin}
              data-testid="cancel-join"
            >
              Cancel
            </button>
          </div>
        )}
        {error && (
          <div className="error-text" role="alert" data-testid="join-error">
            {error}
          </div>
        )}
        <div className="row">
          <button
            className="btn btn-primary btn-lg"
            type="submit"
            disabled={busy}
            data-testid="join-button"
          >
            {busy ? 'Connecting…' : 'Join match'}
          </button>
          <Link to={path('/')} className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
