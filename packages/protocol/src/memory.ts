import type { Listener, Transport, TransportProvider, Unsubscribe } from './transport.js';
import { BaseTransport, Emitter, TransportError, cloneMessage } from './transport.js';

/**
 * In-memory transport pair. Messages are delivered asynchronously (microtask) so that the
 * behaviour matches a real network: a `send` never re-enters the receiver synchronously.
 */
class MemoryTransport extends BaseTransport {
  peer: MemoryTransport | null = null;
  private queue: unknown[] = [];
  private flushing = false;

  protected doSend(message: unknown): void {
    const peer = this.peer;
    if (!peer || peer.status === 'closed') throw new TransportError('closed', 'peer is closed');
    peer.enqueue(cloneMessage(message));
  }

  private enqueue(message: unknown): void {
    this.queue.push(message);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const items = this.queue;
      this.queue = [];
      for (const m of items) this.deliver(m);
    });
  }

  protected doClose(): void {
    const peer = this.peer;
    this.peer = null;
    if (peer && peer.status !== 'closed') {
      peer.peer = null;
      queueMicrotask(() => peer.closeFromPeer());
    }
  }

  closeFromPeer(): void {
    this.setStatus('closed', 'peer closed');
  }

  open(): void {
    this.setStatus('open');
  }
}

let pairCounter = 0;

/** Two connected transports; whatever is sent on one arrives on the other. Both start open. */
export function createMemoryPair(idPrefix = 'mem'): [Transport, Transport] {
  const n = ++pairCounter;
  const a = new MemoryTransport(`${idPrefix}-${n}-a`);
  const b = new MemoryTransport(`${idPrefix}-${n}-b`);
  a.peer = b;
  b.peer = a;
  a.open();
  b.open();
  return [a, b];
}

class MemoryListener implements Listener {
  private connections = new Emitter<Transport>();
  constructor(
    public readonly address: string,
    private readonly onClose: () => void,
  ) {}
  onConnection(listener: (transport: Transport) => void): Unsubscribe {
    return this.connections.on(listener);
  }
  accept(): Transport {
    const [hostSide, guestSide] = createMemoryPair(`mem-${this.address}`);
    queueMicrotask(() => this.connections.emit(hostSide));
    return guestSide;
  }
  close(): void {
    this.onClose();
    this.connections.clear();
  }
}

/**
 * A provider whose "network" is a registry inside the current JS realm. Used for hotseat play
 * (host and guest in the same page) and for unit tests of the full server/client stack.
 */
export function memoryProvider(): TransportProvider {
  const listeners = new Map<string, MemoryListener>();
  return {
    name: 'memory',
    async host(code: string): Promise<Listener> {
      if (listeners.has(code)) throw new TransportError('address-taken', `code ${code} is in use`);
      const l = new MemoryListener(code, () => listeners.delete(code));
      listeners.set(code, l);
      return l;
    },
    async join(code: string): Promise<Transport> {
      const l = listeners.get(code);
      if (!l) throw new TransportError('not-found', `no host for code ${code}`);
      return l.accept();
    },
  };
}
