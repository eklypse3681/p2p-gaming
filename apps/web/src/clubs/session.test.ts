import { describe, expect, it, vi } from 'vitest';
import type { Listener, Transport, TransportProvider } from '@bgf/protocol';
import { TransportError, createMemoryPair } from '@bgf/protocol';
import { SessionError } from '../session/session';
import { awaitClubJoined, connectClub, mapClubError } from './session';
import { ClubError } from '@bgf/club-spec';
import { isRetryable } from '../session/retry';
import { FakeClubClient } from './testing/FakeClubClient';
import type { ClubClientApi } from './types';

const profile = { id: 'ada', name: 'Ada', publicKey: 'k' };

function provider(script: Array<'timeout' | 'ok'>): TransportProvider {
  let i = 0;
  const listener: Listener = { address: 'x', onConnection: () => () => {}, close: () => {} };
  return {
    name: 'fake',
    host: async () => listener,
    join: async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'timeout') throw new TransportError('timeout', 'slow');
      return createMemoryPair()[0];
    },
  };
}

describe('connectClub', () => {
  it('retries a stalled join with progress and returns a live session', async () => {
    const progress: number[] = [];
    const createClient = vi.fn((o: { transport: Transport }): ClubClientApi => {
      o.transport.close();
      return new FakeClubClient({ profile });
    });
    const session = await connectClub(
      { slug: 'alice', clubId: 'c1', address: 'c1', profile, invite: 't' },
      { onProgress: (p) => progress.push(p.attempt) },
      {
        provider: provider(['timeout', 'timeout', 'ok']),
        createClient,
        attempts: 3,
        timeoutMs: 50,
      },
    );
    expect(session.client.getState().status).toBe('joined');
    expect(session.invite).toBe('t');
    expect(progress).toEqual([1, 1, 2, 2, 3]);
    expect(createClient).toHaveBeenCalledTimes(1);
    session.dispose();
  }, 15_000);

  it('does not retry a rejection and closes the client', async () => {
    const client = new FakeClubClient({ profile, status: 'rejected', rejectReason: 'banned' });
    const createClient = vi.fn((): ClubClientApi => client);
    await expect(
      connectClub(
        { slug: 'alice', clubId: 'c1', address: 'c1', profile },
        {},
        { provider: provider(['ok']), createClient, attempts: 3, timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: 'rejected' });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.calls.some((c) => c.method === 'close')).toBe(true);
  });

  it('awaitClubJoined resolves on joined, rejects on timeout', async () => {
    const joined = new FakeClubClient({ profile });
    await expect(awaitClubJoined(joined, 20)).resolves.toBeUndefined();
    const connecting = new FakeClubClient({ profile, status: 'connecting' });
    await expect(awaitClubJoined(connecting, 20)).rejects.toBeInstanceOf(SessionError);
  });
});

describe('mapClubError', () => {
  it('sends a club that is busy back round the retry loop', () => {
    for (const code of ['unavailable', 'rate-limited'] as const) {
      const mapped = mapClubError(new ClubError(code, 'busy'));
      expect(mapped.code).toBe('network');
      expect(isRetryable(mapped)).toBe(true);
    }
  });

  it('does not retry a club that refused us, and says why', () => {
    for (const code of ['unauthorized', 'not-a-member', 'pending', 'banned', 'version'] as const) {
      const mapped = mapClubError(new ClubError(code, 'no'));
      expect(mapped.code).toBe('rejected');
      expect(isRetryable(mapped)).toBe(false);
      expect(mapped.message).not.toBe('no');
    }
    expect(mapClubError(new ClubError('unsupported', 'nope')).code).toBe('unsupported');
    expect(mapClubError(new ClubError('invalid', 'eh')).code).toBe('unknown');
  });

  it('still maps transport failures and passes session errors through', () => {
    expect(mapClubError(new TransportError('not-found', 'nobody')).code).toBe('not-found');
    const already = new SessionError('cancelled', 'Cancelled');
    expect(mapClubError(already)).toBe(already);
  });
});
