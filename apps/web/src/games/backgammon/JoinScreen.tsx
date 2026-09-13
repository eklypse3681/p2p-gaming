import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { isValidRoomCode, normalizeRoomCode } from '@bgf/protocol';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { getMatchStore } from '../../session/matchStore';
import { getProvider } from '../../session/providers';
import { joinMatch, SessionError } from '../../session/session';
import { useSessionRegistry } from '../../session/SessionRegistry';
import { extractCode } from '../../session/links';

export function JoinScreen() {
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
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
  const started = useRef(false);

  const runJoin = async (c: string) => {
    try {
      const { profile, signer } = await ready();
      const session = await joinMatch(
        { code: c, profile, signer: signer ?? undefined },
        { provider: getProvider(slug, gameId), store: getMatchStore(slug, gameId) },
      );
      registry.add(slug, gameId, session);
      navigate(path(`/game/${session.matchId}`), { replace: true });
    } catch (err) {
      setError(err instanceof SessionError ? err.message : 'Could not join the match');
      setBusy(false);
    }
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

  return (
    <div className="page page-narrow" data-testid="join-screen">
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
          <div className="row" data-testid="join-progress">
            <span className="pulse">●</span>
            <span className="muted">Looking for the host…</span>
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
