import { TransportError, type Transport } from '@bgf/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDataConnection, fakeNet, type FakePeer } from './fake-peerjs.js';
import {
  DEFAULT_TIMEOUT_MS,
  isWebRtcSupported,
  peerIdFor,
  peerJsProvider,
  type PeerJsProviderOptions,
} from '../src/index.js';

vi.mock('peerjs', () => import('./fake-peerjs.js'));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Flush pending microtasks (fake-network delivery) without touching timers. */
const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

/** Kick off a host and drive the signalling handshake to success. */
async function startHost(options: PeerJsProviderOptions = {}, code = 'ABCD') {
  const provider = peerJsProvider({ ...options });
  const pending = provider.host(code);
  await tick();
  const peer = fakeNet.last();
  peer.markOpen();
  const listener = await pending;
  const accepted: Transport[] = [];
  listener.onConnection((t) => accepted.push(t));
  return { provider, peer, listener, accepted };
}

/** Attach an already-open incoming DataConnection to a running listener. */
function connectGuest(peer: FakePeer, accepted: Transport[], id = 'guest-peer') {
  const conn = new FakeDataConnection(id);
  peer.emit('connection', conn);
  conn.markOpen();
  const transport = accepted[accepted.length - 1];
  if (!transport) throw new Error('listener did not emit a transport');
  return { conn, transport };
}

beforeEach(() => fakeNet.reset());
afterEach(() => {
  vi.useRealTimers();
  fakeNet.reset();
});

describe('peerIdFor', () => {
  it('namespaces and lower-cases the room code', () => {
    expect(peerIdFor('ABCD')).toBe('bgf-abcd-v1');
    expect(peerIdFor('AbCd', 'staging')).toBe('bgf-abcd-staging');
  });
});

describe('isWebRtcSupported', () => {
  it('is false in Node, where there is no RTCPeerConnection', () => {
    expect(isWebRtcSupported()).toBe(false);
  });
});

describe('peerJsProvider options', () => {
  it('registers the namespaced id and merges the extra STUN servers', async () => {
    const { peer } = await startHost({ namespace: 'test', host: 'peer.example.com', path: '/bg' });
    expect(peer.id).toBe('bgf-abcd-test');
    const options = peer.options as { host?: string; path?: string; config: RTCConfiguration };
    expect(options.host).toBe('peer.example.com');
    expect(options.path).toBe('/bg');
    expect(options.config.iceServers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' }, // PeerJS's own default, not duplicated
      { urls: 'stun:stun1.l.google.com:19302' },
    ]);
  });

  it('lets a self-hoster replace the ICE list and override raw Peer options', async () => {
    const iceServers = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
    const { peer } = await startHost({ iceServers, peerOptions: { port: 9000, secure: false } });
    const options = peer.options as { port?: number; secure?: boolean; config: RTCConfiguration };
    expect(options.config.iceServers).toEqual(iceServers);
    expect(options.port).toBe(9000);
    expect(options.secure).toBe(false);
  });
});

describe('host', () => {
  it('resolves a listener once the peer opens', async () => {
    const { listener, peer } = await startHost();
    expect(listener.address).toBe('ABCD');
    expect(peer.destroyed).toBe(false);
  });

  it('rejects with timeout when the signalling server never answers', async () => {
    vi.useFakeTimers();
    try {
      const provider = peerJsProvider({ timeoutMs: 5_000 });
      const pending = provider.host('ABCD').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      const peer = fakeNet.last();
      await vi.advanceTimersByTimeAsync(5_100);
      const error = await pending;
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).code).toBe('timeout');
      expect(peer.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with address-taken when the id is already registered', async () => {
    const provider = peerJsProvider();
    const pending = provider.host('ABCD').catch((e: unknown) => e);
    await tick();
    const peer = fakeNet.last();
    peer.emitError('unavailable-id', 'ID "bgf-abcd-v1" is taken');
    const error = await pending;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe('address-taken');
    expect(peer.destroyed).toBe(true);
  });

  it('rejects with network for signalling failures', async () => {
    const provider = peerJsProvider();
    const pending = provider.host('ABCD').catch((e: unknown) => e);
    await tick();
    fakeNet.last().emitError('network', 'lost connection to the server');
    const error = await pending;
    expect((error as TransportError).code).toBe('network');
  });

  it('closing the listener closes live transports and destroys the peer', async () => {
    const { listener, peer, accepted } = await startHost({ keepaliveMs: 0 });
    const { conn, transport } = connectGuest(peer, accepted);
    listener.close();
    expect(transport.status).toBe('closed');
    expect(conn.closed).toBe(true);
    expect(peer.destroyed).toBe(true);
  });
});

describe('incoming connections', () => {
  it('emits a transport only once the data connection is open', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 0 });
    const conn = new FakeDataConnection('guest-peer');
    peer.emit('connection', conn);
    expect(accepted).toHaveLength(0);
    conn.markOpen();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.status).toBe('open');
    expect(accepted[0]?.id).toBe('guest-peer');
  });

  it('delivers messages and sends over the data connection', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 0 });
    const { conn, transport } = connectGuest(peer, accepted);
    const got: unknown[] = [];
    transport.onMessage((m) => got.push(m));
    conn.receive({ kind: 'hello', profile: { name: 'Ada' } });
    expect(got).toEqual([{ kind: 'hello', profile: { name: 'Ada' } }]);
    transport.send({ kind: 'welcome', seat: 'white' });
    expect(conn.sent).toEqual([{ kind: 'welcome', seat: 'white' }]);
  });

  it('closes with a reason when the remote hangs up', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 0 });
    const { conn, transport } = connectGuest(peer, accepted);
    const statuses: Array<[string, string | undefined]> = [];
    transport.onStatus((status, reason) => statuses.push([status, reason]));
    conn.close();
    expect(transport.status).toBe('closed');
    expect(statuses).toEqual([['closed', 'peer closed']]);
    expect(() => transport.send({})).toThrow(TransportError);
  });

  it('closes with a reason when the data connection errors', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 0 });
    const { conn, transport } = connectGuest(peer, accepted);
    const statuses: Array<[string, string | undefined]> = [];
    transport.onStatus((status, reason) => statuses.push([status, reason]));
    conn.emitError('ice failed');
    expect(statuses).toEqual([['closed', 'ice failed']]);
  });
});

describe('join', () => {
  it('resolves when the data connection opens, with a reliable json channel', async () => {
    const provider = peerJsProvider({ keepaliveMs: 0 });
    const pending = provider.join('ABCD');
    await tick();
    const peer = fakeNet.last();
    peer.markOpen();
    const conn = peer.outgoing[0];
    if (!conn) throw new Error('join did not open a data connection');
    expect(conn.peer).toBe('bgf-abcd-v1');
    expect(conn.options).toEqual({ reliable: true, serialization: 'json' });
    conn.markOpen();
    const transport = await pending;
    expect(transport.status).toBe('open');
    expect(transport.id).toBe('bgf-abcd-v1');

    // The guest owns its Peer: closing the transport must destroy it.
    transport.close();
    expect(conn.closed).toBe(true);
    expect(peer.destroyed).toBe(true);
  });

  it('rejects with not-found when the host id is unknown', async () => {
    const provider = peerJsProvider();
    const pending = provider.join('ZZZZ').catch((e: unknown) => e);
    await tick();
    const peer = fakeNet.last();
    peer.markOpen();
    peer.emitError('peer-unavailable', 'Could not connect to peer bgf-zzzz-v1');
    const error = await pending;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe('not-found');
    expect(peer.destroyed).toBe(true);
  });

  it('times out when the data connection never opens', async () => {
    const provider = peerJsProvider();
    const pending = provider.join('ABCD', { timeoutMs: 20 }).catch((e: unknown) => e);
    await tick();
    const peer = fakeNet.last();
    peer.markOpen();
    const error = await pending;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe('timeout');
    expect(peer.destroyed).toBe(true);
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });
});

describe('keepalive', () => {
  it('pings on an interval, answers pings and never leaks envelopes to onMessage', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 5000 });
    vi.useFakeTimers();
    const { conn, transport } = connectGuest(peer, accepted);
    const got: unknown[] = [];
    transport.onMessage((m) => got.push(m));

    vi.advanceTimersByTime(5000);
    expect(conn.sent).toEqual([{ __ka: 1 }]);

    // A ping from the far side is answered with a pong, and neither reaches the application.
    conn.receive({ __ka: 1 });
    expect(conn.sent).toEqual([{ __ka: 1 }, { __ka: 2 }]);
    conn.receive({ __ka: 2 });
    expect(got).toEqual([]);

    conn.receive({ kind: 'state' });
    expect(got).toEqual([{ kind: 'state' }]);
    expect(transport.status).toBe('open');
  });

  it('closes with reason timeout after three unanswered pings', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 5000 });
    vi.useFakeTimers();
    const { conn, transport } = connectGuest(peer, accepted);
    const statuses: Array<[string, string | undefined]> = [];
    transport.onStatus((status, reason) => statuses.push([status, reason]));

    vi.advanceTimersByTime(5000); // ping 1
    conn.receive({ __ka: 2 }); // answered: still healthy
    vi.advanceTimersByTime(15_000); // pings 2, 3, 4 — none answered
    expect(transport.status).toBe('open');
    vi.advanceTimersByTime(5000); // third miss
    expect(transport.status).toBe('closed');
    expect(statuses).toEqual([['closed', 'timeout']]);
    expect(conn.closed).toBe(true);
  });

  it('sends nothing when the keepalive is disabled', async () => {
    const { peer, accepted } = await startHost({ keepaliveMs: 0 });
    vi.useFakeTimers();
    const { conn, transport } = connectGuest(peer, accepted);
    vi.advanceTimersByTime(60_000);
    expect(conn.sent).toEqual([]);
    expect(transport.status).toBe('open');
    // A peer with the keepalive off still answers pings, so the other side stays happy.
    conn.receive({ __ka: 1 });
    expect(conn.sent).toEqual([{ __ka: 2 }]);
  });
});

describe('two providers over the fake network', () => {
  it('round-trips a message host -> guest -> host', async () => {
    fakeNet.auto = true;
    const hostProvider = peerJsProvider({ keepaliveMs: 0 });
    const guestProvider = peerJsProvider({ keepaliveMs: 0 });

    const listener = await hostProvider.host('WXYZ');
    const accepted: Transport[] = [];
    listener.onConnection((t) => accepted.push(t));

    const guest = await guestProvider.join('WXYZ');
    await flush();
    const host = accepted[0];
    if (!host) throw new Error('host never saw the guest');
    expect(host.status).toBe('open');
    expect(guest.status).toBe('open');

    const atGuest: unknown[] = [];
    const atHost: unknown[] = [];
    guest.onMessage((m) => atGuest.push(m));
    host.onMessage((m) => atHost.push(m));

    host.send({ kind: 'welcome', seat: 'white' });
    await flush();
    expect(atGuest).toEqual([{ kind: 'welcome', seat: 'white' }]);

    guest.send({ kind: 'roll' });
    await flush();
    expect(atHost).toEqual([{ kind: 'roll' }]);

    // Tearing down the guest propagates to the host side.
    guest.close();
    await flush();
    expect(host.status).toBe('closed');
  });

  it('rejects with not-found when nobody is hosting the code', async () => {
    fakeNet.auto = true;
    const provider = peerJsProvider();
    const error = await provider.join('NOPE', { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe('not-found');
  });
});
