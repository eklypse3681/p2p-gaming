/**
 * The transport abstraction. Both the host-side GameServer and every GameClient talk only to
 * this interface; whether messages travel in-memory, across browser tabs, over WebRTC (PeerJS)
 * or via some future Discord-based channel is invisible to them.
 *
 * Messages must be JSON-serialisable plain objects. Delivery is in-order and reliable per
 * connection (in-memory and BroadcastChannel are trivially so; WebRTC data channels are opened
 * with `reliable: true`).
 */

export type TransportStatus = 'connecting' | 'open' | 'closed';
export type Unsubscribe = () => void;

export interface Transport {
  /** Stable identifier for this connection (e.g. the remote peer id). */
  readonly id: string;
  readonly status: TransportStatus;
  /** Send a message. Throws if the transport is closed. */
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): Unsubscribe;
  /** Fires on every status change; `reason` is set when closing due to an error. */
  onStatus(listener: (status: TransportStatus, reason?: string) => void): Unsubscribe;
  close(): void;
}

/** A host-side endpoint that accepts incoming connections for a room code. */
export interface Listener {
  /** The address peers use to reach this listener (normally the room code). */
  readonly address: string;
  onConnection(listener: (transport: Transport) => void): Unsubscribe;
  close(): void;
}

/**
 * Creates listeners (host side) and outbound connections (guest side) for a given medium.
 * Implementations: `memoryProvider()` (same JS realm), `broadcastChannelProvider()` (same
 * browser, any tab), `peerJsProvider()` (WebRTC over the internet).
 */
export interface TransportProvider {
  readonly name: string;
  host(code: string): Promise<Listener>;
  join(code: string, opts?: { timeoutMs?: number }): Promise<Transport>;
}

export class TransportError extends Error {
  constructor(
    public readonly code:
      'address-taken' | 'not-found' | 'timeout' | 'closed' | 'network' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** How many messages a transport keeps for a listener that has not subscribed yet. */
export const EARLY_BUFFER_LIMIT = 256;

/** Small typed event emitter used by transport implementations. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  get size(): number {
    return this.listeners.size;
  }
  on(fn: (value: T) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(value: T): void {
    for (const fn of Array.from(this.listeners)) fn(value);
  }
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Base class that handles listener bookkeeping and status transitions. Subclasses implement
 * `doSend` and `doClose` and call `deliver` / `setStatus`.
 *
 * Messages that arrive before anyone has subscribed with `onMessage` are buffered and replayed
 * to the first subscriber, so a peer that talks the instant a connection opens is never missed
 * by a receiver still returning from `await provider.join()`.
 */
export abstract class BaseTransport implements Transport {
  private _status: TransportStatus = 'connecting';
  private messages = new Emitter<unknown>();
  private statuses = new Emitter<{ status: TransportStatus; reason?: string }>();
  private early: unknown[] = [];

  constructor(public readonly id: string) {}

  get status(): TransportStatus {
    return this._status;
  }

  send(message: unknown): void {
    if (this._status === 'closed') throw new TransportError('closed', 'transport is closed');
    this.doSend(message);
  }

  onMessage(listener: (message: unknown) => void): Unsubscribe {
    const unsubscribe = this.messages.on(listener);
    if (this.early.length > 0) {
      const queued = this.early;
      this.early = [];
      for (const m of queued) listener(m);
    }
    return unsubscribe;
  }

  onStatus(listener: (status: TransportStatus, reason?: string) => void): Unsubscribe {
    return this.statuses.on(({ status, reason }) => listener(status, reason));
  }

  close(): void {
    if (this._status === 'closed') return;
    this.doClose();
    this.setStatus('closed');
  }

  protected deliver(message: unknown): void {
    if (this._status === 'closed') return;
    if (this.messages.size === 0) {
      this.early.push(message);
      if (this.early.length > EARLY_BUFFER_LIMIT) this.early.shift();
      return;
    }
    this.messages.emit(message);
  }

  protected setStatus(status: TransportStatus, reason?: string): void {
    if (this._status === status) return;
    if (this._status === 'closed') return;
    this._status = status;
    this.statuses.emit({ status, reason });
    if (status === 'closed') {
      this.messages.clear();
      this.statuses.clear();
      this.early = [];
    }
  }

  protected abstract doSend(message: unknown): void;
  protected abstract doClose(): void;
}

/** Structured clone via JSON: guarantees the receiver never shares object identity with the sender. */
export function cloneMessage<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}
