/**
 * A tiny in-process stand-in for the slice of PeerJS this package touches: `new Peer(id, opts)`,
 * `peer.connect(target, opts)`, the `open` / `connection` / `error` events and DataConnections that
 * can be wired to each other so two providers really exchange messages.
 *
 * Tests drive everything by hand (`peer.markOpen()`, `conn.markOpen()`, `peer.emitError(...)`)
 * unless `fakeNet.auto` is set, in which case peers open themselves and `connect()` finds a
 * registered host automatically — enough to round-trip a message between two providers.
 */

type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event);
    if (list) list.push(fn);
    else this.handlers.set(event, [fn]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
}

let counter = 0;

export class FakeDataConnection extends FakeEmitter {
  open = false;
  closed = false;
  /** Everything handed to `send()`, keepalive envelopes included. */
  readonly sent: unknown[] = [];
  /** The other end of the wire, when two providers are talking through the fake network. */
  remote: FakeDataConnection | null = null;

  constructor(
    readonly peer: string,
    readonly options: unknown = {},
    readonly connectionId = `dc_${++counter}`,
  ) {
    super();
  }

  send(data: unknown): void {
    if (this.closed) throw new Error('connection is closed');
    this.sent.push(data);
    const remote = this.remote;
    if (remote && remote.open) queueMicrotask(() => remote.receive(data));
  }

  /** Deliver a message as if it arrived from the far side (JSON round-tripped, like the wire). */
  receive(data: unknown): void {
    if (this.closed) return;
    this.emit('data', JSON.parse(JSON.stringify(data)) as unknown);
  }

  markOpen(): void {
    if (this.open || this.closed) return;
    this.open = true;
    this.emit('open');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    const remote = this.remote;
    this.remote = null;
    if (remote) queueMicrotask(() => remote.close());
  }

  /** Simulate a data-channel level failure. */
  emitError(message = 'data channel failed'): void {
    this.emit('error', Object.assign(new Error(message), { type: 'connection-error' }));
  }
}

export class FakePeer extends FakeEmitter {
  id: string | undefined;
  destroyed = false;
  opened = false;
  readonly outgoing: FakeDataConnection[] = [];

  constructor(
    id: string | undefined,
    readonly options?: unknown,
  ) {
    super();
    this.id = id;
    peers.push(this);
    if (fakeNet.auto) queueMicrotask(() => this.markOpen());
  }

  connect(target: string, options?: unknown): FakeDataConnection {
    const conn = new FakeDataConnection(target, options);
    this.outgoing.push(conn);
    if (fakeNet.auto) {
      queueMicrotask(() => {
        const host = registry.get(target);
        if (!host) {
          this.emitError('peer-unavailable', `Could not connect to peer ${target}`);
          return;
        }
        const hostSide = new FakeDataConnection(this.id ?? 'anonymous');
        hostSide.remote = conn;
        conn.remote = hostSide;
        host.emit('connection', hostSide);
        hostSide.markOpen();
        conn.markOpen();
      });
    }
    return conn;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.id && registry.get(this.id) === this) registry.delete(this.id);
    this.emit('close');
  }

  markOpen(): void {
    if (this.opened || this.destroyed) return;
    this.opened = true;
    this.id ??= `anon-${++counter}`;
    registry.set(this.id, this);
    this.emit('open', this.id);
  }

  emitError(type: string, message = type): void {
    this.emit('error', Object.assign(new Error(message), { type }));
  }
}

const registry = new Map<string, FakePeer>();
const peers: FakePeer[] = [];

export const fakeNet = {
  /** Peers open themselves and `connect()` wires up to a registered host. */
  auto: false,
  peers,
  reset(): void {
    registry.clear();
    peers.length = 0;
    fakeNet.auto = false;
  },
  /** The most recently constructed peer (throws rather than returning undefined). */
  last(): FakePeer {
    const peer = peers[peers.length - 1];
    if (!peer) throw new Error('no Peer has been constructed');
    return peer;
  },
};

/** What PeerJS exposes as `util.defaultConfig.iceServers`. */
export const util = {
  defaultConfig: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    sdpSemantics: 'unified-plan',
  },
};

export { FakePeer as Peer };
