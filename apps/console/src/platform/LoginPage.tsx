import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { bytesToBase64Url, sign } from '@bgf/protocol';
import { describeError } from '../api/useApi';
import { loginBytes, platformApi } from './api';
import { IDENTITY_PREFIX, TRANSFER_PREFIX, decodeIdentityCode } from './identity';
import type { DecodedIdentity } from './identity';
import { useSession } from './session';

type Decoded = { ok: true; identity: DecodedIdentity } | { ok: false; message: string };

/** Paste a player code; the private key signs one challenge and never leaves this tab. */
export function LoginPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decoded = useMemo<Decoded | null>(() => {
    if (!code.trim()) return null;
    try {
      return { ok: true, identity: decodeIdentityCode(code) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [code]);
  const identity = decoded?.ok ? decoded.identity : null;
  const problem = !identity
    ? null
    : !identity.publicKey
      ? 'This code carries no public key. Export a keyed identity from the web app.'
      : !identity.privateKey
        ? 'This code carries no private key, so it cannot sign the login challenge. Export an identity code with keys from an unlocked player.'
        : null;
  const ready = !!identity && !problem && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identity?.publicKey || !identity.privateKey || problem) return;
    setBusy(true);
    setError(null);
    try {
      const { nonce } = await platformApi.challenge({
        profileId: identity.id,
        publicKey: identity.publicKey,
      });
      const signature = bytesToBase64Url(
        await sign(
          identity.privateKey,
          loginBytes({ profileId: identity.id, publicKey: identity.publicKey, nonce }),
        ),
      );
      const login = await platformApi.login({
        profileId: identity.id,
        publicKey: identity.publicKey,
        name: identity.name,
        signature,
      });
      await signIn(login.token);
      navigate('/clubs');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" data-testid="login-page">
      <form className="card gate stack" onSubmit={submit} data-testid="login-form">
        <span className="eyebrow">Platform console</span>
        <h1>Sign in</h1>
        <p className="muted">
          Paste an identity code (<code>{IDENTITY_PREFIX}…</code>) or a transfer code (
          <code>{TRANSFER_PREFIX}…</code>) from the web app. The key signs one challenge here and is
          forgotten when you leave the page.
        </p>
        <textarea
          className="textarea"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`${IDENTITY_PREFIX}…`}
          spellCheck={false}
          autoComplete="off"
          data-testid="login-code"
        />
        {decoded && !decoded.ok && (
          <p className="error-text" data-testid="login-code-error">
            {decoded.message}
          </p>
        )}
        {identity && (
          <div className="seat" data-testid="login-identity">
            <span aria-hidden="true">{identity.avatar ?? '🙂'}</span>
            <span className="name">{identity.name}</span>
            <span className="small muted mono">{identity.id}</span>
          </div>
        )}
        {problem && (
          <p className="error-text" data-testid="login-problem">
            {problem}
          </p>
        )}
        {error && (
          <p className="error-text" data-testid="login-error">
            {error}
          </p>
        )}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!ready}
          data-testid="login-submit"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
