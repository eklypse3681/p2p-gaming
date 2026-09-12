import type { Listener, Transport, TransportProvider, Unsubscribe } from './transport.js';
import { BaseTransport, Emitter, TransportError } from './transport.js';

/**
 * Cross-tab transport built on `BroadcastChannel`. One channel per room code carries a tiny
 * envelope protocol: guests announce themselves, the host acks, and thereafter every message is
 * addressed by connection id. Same-origin only; used for local two-window play and end-to-end
 * tests that must not touch the network.
 */

type Envelope =
  | { kind: 'probe'; conn: string }
  | { kind: 'probe-ack'; conn: string }
  | { kind: 'connect'; conn: string }
  | { kind: 'accept'; conn: string }
  | { kind: 'msg'; conn: string; to: 'host' | 'guest'; body: unknown }
  | { kind: 'close'; conn: string };

function channelName(code: string): string {
  return `bgf:room:${code}`;
}

class BcTransport extends BaseTransport {
  constructor(
    id: string,
    private readonly channel: BroadcastChannel,
    private readonly role: 'host' | 'guest',
    private readonly conn: string,
    private readonly onClosed: () => void,
  ) {
    super(id);
  }

  handle(env: Envelope): void {
    if (env.conn !== this.conn) return;
    if (env.kind === 'msg' && env.to === this.role) this.deliver(env.body);
    if (env.kind === 'close') this.setStatus('closed', 'peer closed');
  }

  protected doSend(message: unknown): void {
    const env: Envelope = {
      kind: 'msg',
      conn: this.conn,
      to: this.role === 'host' ? 'guest' : 'host',
      body: message,
    };
    this.channel.postMessage(env);
  }

  protected doClose(): void {
    try {
      this.channel.postMessage({ kind: 'close', conn: this.conn } satisfies Envelope);
    } catch {
      /* channel already closed */
    }
    this.onClosed();
  }

  open(): void {
    this.setStatus('open');
  }
}

class BcListener implements Listener {
  private connections = new Emitter<Transport>();
  private transports = new Map<string, BcTransport>();
  private readonly channel: BroadcastChannel;

  constructor(
    public readonly address: string,
    private readonly onClose: () => void,
  ) {
    this.channel = new BroadcastChannel(channelName(address));
    this.channel.onmessage = (ev: MessageEvent<Envelope>) => this.handle(ev.data);
  }

  private handle(env: Envelope): void {
    if (env.kind === 'probe') {
      this.channel.postMessage({ kind: 'probe-ack', conn: env.conn } satisfies Envelope);
      return;
    }
    if (env.kind === 'connect') {
      const t = new BcTransport(`bc-${env.conn}`, this.channel, 'host', env.conn, () =>
        this.transports.delete(env.conn),
      );
      this.transports.set(env.conn, t);
      t.open();
      this.channel.postMessage({ kind: 'accept', conn: env.conn } satisfies Envelope);
      this.connections.emit(t);
      return;
    }
    this.transports.get(env.conn)?.handle(env);
  }

  onConnection(listener: (transport: Transport) => void): Unsubscribe {
    return this.connections.on(listener);
  }

  close(): void {
    for (const t of Array.from(this.transports.values())) t.close();
    this.channel.close();
    this.onClose();
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function isBroadcastChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

export function broadcastChannelProvider(): TransportProvider {
  const hosted = new Set<string>();
  return {
    name: 'broadcast',
    async host(code: string): Promise<Listener> {
      if (!isBroadcastChannelSupported()) {
        throw new TransportError('unsupported', 'BroadcastChannel is not available');
      }
      if (hosted.has(code)) throw new TransportError('address-taken', `code ${code} is in use`);
      // Probe for another tab already hosting this code.
      const taken = await probe(code, 150);
      if (taken) throw new TransportError('address-taken', `code ${code} is hosted elsewhere`);
      hosted.add(code);
      return new BcListener(code, () => hosted.delete(code));
    },
    async join(code: string, opts?: { timeoutMs?: number }): Promise<Transport> {
      if (!isBroadcastChannelSupported()) {
        throw new TransportError('unsupported', 'BroadcastChannel is not available');
      }
      const channel = new BroadcastChannel(channelName(code));
      const conn = randomId();
      return new Promise<Transport>((resolve, reject) => {
        const timer = setTimeout(() => {
          channel.close();
          reject(new TransportError('not-found', `no host answered for code ${code}`));
        }, opts?.timeoutMs ?? 1500);
        let transport: BcTransport | null = null;
        channel.onmessage = (ev: MessageEvent<Envelope>) => {
          const env = ev.data;
          if (env.conn !== conn) return;
          if (env.kind === 'accept' && !transport) {
            clearTimeout(timer);
            transport = new BcTransport(`bc-${conn}`, channel, 'guest', conn, () => channel.close());
            transport.open();
            resolve(transport);
            return;
          }
          transport?.handle(env);
        };
        channel.postMessage({ kind: 'connect', conn } satisfies Envelope);
      });
    },
  };
}

function probe(code: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(channelName(code));
    const conn = randomId();
    const timer = setTimeout(() => {
      channel.close();
      resolve(false);
    }, timeoutMs);
    channel.onmessage = (ev: MessageEvent<Envelope>) => {
      if (ev.data.kind === 'probe-ack' && ev.data.conn === conn) {
        clearTimeout(timer);
        channel.close();
        resolve(true);
      }
    };
    channel.postMessage({ kind: 'probe', conn } satisfies Envelope);
  });
}
