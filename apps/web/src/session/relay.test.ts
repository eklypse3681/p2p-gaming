import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayServers, resetRelayCache } from './relay';

const TURN = { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' };

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('relay credentials', () => {
  beforeEach(() => resetRelayCache());
  afterEach(() => vi.unstubAllGlobals());

  it('fetches once and reuses the credentials until shortly before they expire', async () => {
    let now = 0;
    const fetch = respond({ iceServers: [TURN], expiresAt: 24 * 3600_000 });
    vi.stubGlobal('fetch', fetch);
    expect(await relayServers(() => now)).toEqual([TURN]);
    now = 20 * 3600_000;
    expect(await relayServers(() => now)).toEqual([TURN]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 23.5 * 3600_000; // inside the refresh margin
    await relayServers(() => now);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between connections opened together', async () => {
    const fetch = respond({ iceServers: [TURN], expiresAt: 24 * 3600_000 });
    vi.stubGlobal('fetch', fetch);
    await Promise.all([relayServers(() => 0), relayServers(() => 0), relayServers(() => 0)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('goes without a relay when the endpoint is missing or refuses', async () => {
    vi.stubGlobal('fetch', respond({ error: 'forbidden' }, 403));
    expect(await relayServers(() => 0)).toEqual([]);
    resetRelayCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html>', { status: 200 })),
    );
    expect(await relayServers(() => 0)).toEqual([]);
  });

  it('keeps unexpired credentials through a failed refresh', async () => {
    let now = 0;
    vi.stubGlobal('fetch', respond({ iceServers: [TURN], expiresAt: 24 * 3600_000 }));
    await relayServers(() => now);
    now = 23.5 * 3600_000;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await relayServers(() => now)).toEqual([TURN]);
  });
});
