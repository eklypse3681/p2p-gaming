import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { base64UrlToBytes, generateKeyPair, verify } from '@bgf/protocol';
import { PlatformApp } from './PlatformApp';
import { loginBytes } from './api';
import { encodeIdentityCode } from './identity';
import { FakeEventSource, installFakeApi } from '../test/fakeApi';
import { authHeader, body, fakeMe, platformStatus } from '../test/platformFixtures';

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.location.hash = '#/';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('decodes an identity code, signs the challenge and stores the session token', async () => {
    const keys = await generateKeyPair();
    const code = encodeIdentityCode({
      id: 'p1',
      name: 'Ann',
      avatar: '🦊',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
    let challenge: Record<string, unknown> | null = null;
    let login: Record<string, unknown> | null = null;
    installFakeApi({
      'POST /api/auth/challenge': (init) => {
        challenge = body(init);
        return { nonce: 'n0nce' };
      },
      'POST /api/auth/login': async (init) => {
        login = body(init);
        const ok = await verify(
          String(login.publicKey),
          loginBytes({
            profileId: String(login.profileId),
            publicKey: String(login.publicKey),
            nonce: 'n0nce',
          }),
          base64UrlToBytes(String(login.signature)),
        );
        if (!ok)
          throw Object.assign(new Error('the challenge was not signed with that key'), {
            status: 401,
          });
        return { token: 'tok-1', profileId: 'p1', name: 'Ann', expiresAt: 9e12, operator: false };
      },
      'GET /api/me': (init) => {
        if (authHeader(init) !== 'Bearer tok-1')
          throw Object.assign(new Error('sign in first'), { status: 401 });
        return fakeMe({ profileId: 'p1' });
      },
    });
    render(<PlatformApp status={platformStatus()} />);
    const textarea = await screen.findByTestId('login-code');
    expect(screen.getByTestId('login-submit')).toBeDisabled();

    await userEvent.type(textarea, 'garbage');
    expect(screen.getByTestId('login-code-error')).toHaveTextContent('p2pi1.');
    await userEvent.clear(textarea);

    // A code without the private key cannot sign.
    await userEvent.click(textarea);
    await userEvent.paste(encodeIdentityCode({ id: 'p1', name: 'Ann', publicKey: keys.publicKey }));
    expect(screen.getByTestId('login-problem')).toHaveTextContent('no private key');
    expect(screen.getByTestId('login-submit')).toBeDisabled();
    await userEvent.clear(textarea);

    await userEvent.click(textarea);
    await userEvent.paste(code);
    expect(screen.getByTestId('login-identity')).toHaveTextContent('Ann');
    expect(screen.getByTestId('login-identity')).toHaveTextContent('p1');
    expect(screen.getByTestId('login-submit')).toBeEnabled();
    await userEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => expect(localStorage.getItem('platform-session-token')).toBe('tok-1'));
    expect(challenge).toEqual({ profileId: 'p1', publicKey: keys.publicKey });
    expect(login).toMatchObject({ profileId: 'p1', publicKey: keys.publicKey, name: 'Ann' });
    expect(await screen.findByTestId('clubs-page')).toBeInTheDocument();
    expect(screen.getByTestId('status-line')).toHaveTextContent('Ann');
    expect(screen.getByTestId('nav-clubs')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-operator')).not.toBeInTheDocument();
  });

  it('drops a rejected session and returns to the login page', async () => {
    localStorage.setItem('platform-session-token', 'stale');
    installFakeApi({
      'GET /api/me': () => {
        throw Object.assign(new Error('sign in first'), { status: 401 });
      },
    });
    window.location.hash = '#/clubs';
    render(<PlatformApp status={platformStatus()} />);
    expect(await screen.findByTestId('login-page')).toBeInTheDocument();
    expect(localStorage.getItem('platform-session-token')).toBeNull();
  });

  it('signs out through the API and forgets the token', async () => {
    localStorage.setItem('platform-session-token', 'tok-1');
    let loggedOut = false;
    installFakeApi({
      'GET /api/me': () => fakeMe(),
      'POST /api/auth/logout': (init) => {
        loggedOut = authHeader(init) === 'Bearer tok-1';
        return { ok: true };
      },
    });
    window.location.hash = '#/clubs';
    render(<PlatformApp status={platformStatus()} />);
    await userEvent.click(await screen.findByTestId('sign-out'));
    expect(await screen.findByTestId('login-page')).toBeInTheDocument();
    expect(loggedOut).toBe(true);
    expect(localStorage.getItem('platform-session-token')).toBeNull();
  });
});
