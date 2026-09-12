import { describe, expect, it, vi } from 'vitest';
import type {
  Listener,
  MatchSnapshot,
  PlayerProfile,
  Transport,
  TransportProvider,
} from '@bgf/protocol';
import { TransportError, createMemoryPair } from '@bgf/protocol';
import type { ClientState, GameClientApi } from '@bgf/client';
import { newMatch } from '@bgf/engine';
import { awaitJoined, hostNewMatch, joinMatch, resumeMatch, SessionError } from './session';

const profile: PlayerProfile = { id: 'me', name: 'Me' };

function snapshot(): MatchSnapshot {
  const match = newMatch({ length: 3 });
  return {
    id: 'match-x',
    code: 'ROOM42',
    seq: 5,
    createdAt: 1,
    updatedAt: 2,
    config: match.config,
    players: { white: { id: 'me', name: 'Me' }, black: { id: 'them', name: 'Them' } },
    hostSeat: 'white',
    actions: [],
    match,
    chat: [],
  };
}

/** A client that reports `joined` on the next tick with the given snapshot. */
function fakeClientFactory(outcome: 'joined' | 'rejected' | 'never' = 'joined') {
  const created: { opts: unknown; client: GameClientApi }[] = [];
  const factory = (opts: {
    transport: Transport;
    profile: PlayerProfile;
    resumeSnapshot?: MatchSnapshot;
  }) => {
    let state: ClientState = {
      status: 'connecting',
      rejectReason: null,
      seat: null,
      snapshot: null,
      lastAction: null,
      opponentPreview: null,
      presence: { white: false, black: false },
      chat: [],
      latencyMs: null,
      error: null,
      draft: {
        played: [],
        board: { points: [], bar: { white: 0, black: 0 }, off: { white: 0, black: 0 } },
        next: [],
        remaining: [],
        complete: false,
        maxMoves: 0,
      },
    };
    const listeners = new Set<() => void>();
    const client = {
      profile: opts.profile,
      getState: () => state,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      close: vi.fn(),
    } as unknown as GameClientApi;
    created.push({ opts, client });
    queueMicrotask(() => {
      if (outcome === 'joined')
        state = {
          ...state,
          status: 'joined',
          seat: 'white',
          snapshot: opts.resumeSnapshot ?? snapshot(),
        };
      else if (outcome === 'rejected')
        state = { ...state, status: 'rejected', rejectReason: 'full' };
      for (const l of Array.from(listeners)) l();
    });
    return client;
  };
  return { factory, created };
}

function fakeServer() {
  const accept = vi.fn();
  const close = vi.fn();
  const [, local] = createMemoryPair();
  return {
    accept,
    close,
    connectLocal: () => local,
    getSnapshot: () => snapshot(),
    onChange: () => () => {},
    connectedSeats: () => [],
  };
}

function fakeProvider(opts: { hostThrows?: TransportError; joinThrows?: TransportError } = {}) {
  const listener: Listener = { address: 'ROOM42', onConnection: () => () => {}, close: vi.fn() };
  const host = vi.fn(async (_code: string) => {
    if (opts.hostThrows) throw opts.hostThrows;
    return listener;
  });
  const join = vi.fn(async (_code: string) => {
    if (opts.joinThrows) throw opts.joinThrows;
    return createMemoryPair()[0];
  });
  const provider: TransportProvider = { name: 'fake', host, join };
  return { provider, host, join, listener };
}

describe('session factories', () => {
  it('hostNewMatch hosts under a fresh code and connects the local client', async () => {
    const { provider, host } = fakeProvider();
    const server = fakeServer();
    const { factory, created } = fakeClientFactory();
    const s = await hostNewMatch(
      { profile, config: { length: 3 } },
      { provider, createServer: () => server as never, createClient: factory as never },
    );
    expect(s.role).toBe('host');
    expect(host).toHaveBeenCalledWith(s.code);
    expect(s.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created).toHaveLength(1);
    s.dispose();
    expect(server.close).toHaveBeenCalled();
  });

  it('refuses to play without a name', async () => {
    const { provider } = fakeProvider();
    await expect(
      hostNewMatch({ profile: { id: 'x', name: '  ' }, config: {} }, { provider }),
    ).rejects.toMatchObject({
      code: 'no-name',
    });
  });

  it('joinMatch passes a saved snapshot for the code as resumeSnapshot', async () => {
    const { provider, join } = fakeProvider();
    const { factory, created } = fakeClientFactory();
    const saved = snapshot();
    const store = {
      list: async () => [saved],
      get: async () => saved,
      put: async () => {},
      delete: async () => {},
      findByCode: async (code: string) => (code === 'ROOM42' ? saved : undefined),
    };
    const s = await joinMatch(
      { code: 'ROOM42', profile },
      { provider, store, createClient: factory as never },
    );
    expect(s.role).toBe('guest');
    expect(s.matchId).toBe('match-x');
    expect(join).toHaveBeenCalledWith(
      'ROOM42',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect((created[0]!.opts as { resumeSnapshot?: MatchSnapshot }).resumeSnapshot).toBe(saved);
  });

  it('joinMatch maps transport errors to friendly SessionErrors', async () => {
    const { provider } = fakeProvider({ joinThrows: new TransportError('not-found', 'nope') });
    await expect(joinMatch({ code: 'ROOM42', profile }, { provider })).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringMatching(/no one is hosting/i),
    });
  });

  it('joinMatch rejects when the host rejects us', async () => {
    const { provider } = fakeProvider();
    const { factory, created } = fakeClientFactory('rejected');
    await expect(
      joinMatch({ code: 'ROOM42', profile }, { provider, createClient: factory as never }),
    ).rejects.toMatchObject({
      code: 'rejected',
      message: expect.stringMatching(/two players/i),
    });
    expect(created[0]!.client.close).toHaveBeenCalled();
  });

  it('resumeMatch hosts when the code is free', async () => {
    const { provider, host, join } = fakeProvider();
    const server = fakeServer();
    const createServer = vi.fn(() => server as never);
    const { factory } = fakeClientFactory();
    const s = await resumeMatch(
      { snapshot: snapshot(), profile },
      { provider, createServer, createClient: factory as never },
    );
    expect(s.role).toBe('host');
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ id: 'match-x' }),
        code: 'ROOM42',
      }),
    );
    expect(host).toHaveBeenCalledWith('ROOM42');
    expect(join).not.toHaveBeenCalled();
  });

  it('resumeMatch falls back to joining when the code is already hosted', async () => {
    const { provider, join } = fakeProvider({
      hostThrows: new TransportError('address-taken', 'taken'),
    });
    const server = fakeServer();
    const { factory, created } = fakeClientFactory();
    const snap = snapshot();
    const s = await resumeMatch(
      { snapshot: snap, profile },
      { provider, createServer: () => server as never, createClient: factory as never },
    );
    expect(s.role).toBe('guest');
    expect(server.close).toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith('ROOM42', expect.anything());
    expect((created[0]!.opts as { resumeSnapshot?: MatchSnapshot }).resumeSnapshot).toBe(snap);
  });

  it('resumeMatch surfaces other hosting errors', async () => {
    const { provider } = fakeProvider({ hostThrows: new TransportError('network', 'offline') });
    await expect(
      resumeMatch(
        { snapshot: snapshot(), profile },
        { provider, createServer: () => fakeServer() as never },
      ),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('awaitJoined times out', async () => {
    const { factory } = fakeClientFactory('never');
    const client = factory({ transport: createMemoryPair()[0], profile });
    await expect(awaitJoined(client, 10)).rejects.toBeInstanceOf(SessionError);
  });
});
