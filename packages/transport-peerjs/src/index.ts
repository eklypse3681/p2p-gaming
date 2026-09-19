import type { Listener, Transport, TransportProvider, Unsubscribe } from '@bgf/protocol';
import { BaseTransport, Emitter, TransportError } from '@bgf/protocol';
import type { DataConnection, Peer, PeerOptions } from 'peerjs';

/**
 * WebRTC transport built on PeerJS. The host registers a deterministic peer id derived from the
 * room code on a signalling server (the free PeerJS cloud by default), guests connect straight to
 * that id, and everything afterwards travels over a reliable data channel.
 *
 * PeerJS is only imported lazily (`await import('peerjs')` inside `host` / `join`) so that
 * importing this module in Node — unit tests, SSR, tooling — never touches `window`/`navigator`.
 */

/** Default id namespace; bump it when a deployment must not collide with older clients. */
export const DEFAULT_NAMESPACE = 'v1';
/** Default join timeout: signalling + ICE on a bad network can take a while. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Default application-level keepalive period. `0` disables the keepalive entirely. */
export const DEFAULT_KEEPALIVE_MS = 5_000;
/** How many unanswered keepalives close the transport with reason `timeout`. */
export const KEEPALIVE_MAX_MISSED = 3;

/** Public STUN servers added on top of whatever PeerJS ships as its default configuration. */
export const EXTRA_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface PeerJsProviderOptions {
  /** Signalling host. Defaults to the PeerJS cloud (`0.peerjs.com`). */
  host?: string;
  /** Signalling port. Defaults to `443`. */
  port?: number;
  /** Path of a self-hosted PeerServer, e.g. `/myapp`. */
  path?: string;
  /** Use TLS. Defaults to PeerJS's own default (true for the cloud). */
  secure?: boolean;
  /** PeerServer API key (cloud only; unused by modern self-hosted servers). */
  key?: string;
  /** PeerJS log level: 0 none … 3 all. */
  debug?: number;
  /** Replaces the default ICE server list entirely (add TURN here). */
  iceServers?: RTCIceServer[];
  /** Id namespace, see {@link peerIdFor}. Defaults to `'v1'`. */
  namespace?: string;
  /** Keepalive period in ms; `0` disables it. Defaults to 5000. */
  keepaliveMs?: number;
  /** Default `join` timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
  /**
   * Escape hatch for self-hosters: merged last into the options handed to `new Peer()`, so it can
   * override anything above (`config`, `token`, `pingInterval`, `referrerPolicy`, …).
   */
  peerOptions?: PeerOptions;
  /**
   * Node support. `'auto'` (default) installs the `node-datachannel` WebRTC polyfill when there
   * is no `window` and no `RTCPeerConnection`; `true` forces it; `false` never touches globals.
   * See {@link installNodeWebRtc}.
   */
  node?: boolean | 'auto';
}

/**
 * The signalling id a room code maps to. Namespacing matters on the shared public cloud: without
 * it, two unrelated deployments picking the same room code would fight over one id.
 */
export function peerIdFor(code: string, namespace: string = DEFAULT_NAMESPACE): string {
  return `bgf-${code.toLowerCase()}-${namespace}`;
}

/** Cheap synchronous capability probe; safe to call in Node (returns false). */
export function isWebRtcSupported(): boolean {
  const g = globalThis as { RTCPeerConnection?: unknown };
  return (
    typeof g.RTCPeerConnection === 'function' &&
    typeof (g.RTCPeerConnection as { prototype?: { createDataChannel?: unknown } }).prototype
      ?.createDataChannel === 'function'
  );
}

// ---------------------------------------------------------------------------------------------
// Keepalive envelopes
// ---------------------------------------------------------------------------------------------

const KA_PING = 1;
const KA_PONG = 2;

type KeepaliveEnvelope = { __ka: number };

function isKeepalive(message: unknown): message is KeepaliveEnvelope {
  return typeof message === 'object' && message !== null && '__ka' in message;
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

/**
 * One WebRTC data channel. WebRTC is slow (or silent) about noticing that the far side vanished,
 * so on top of PeerJS's `close`/`error` events we run an application-level ping: every
 * `keepaliveMs` we send `{__ka:1}` and expect anything with a `__ka` back. Peers answer a ping
 * with `{__ka:2}` regardless of their own keepalive setting. After {@link KEEPALIVE_MAX_MISSED}
 * unanswered pings the transport closes with reason `timeout`.
 */
class PeerJsTransport extends BaseTransport {
  private timer: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private awaitingPong = false;
  private cleaned = false;

  constructor(
    id: string,
    private readonly conn: DataConnection,
    private readonly keepaliveMs: number,
    private readonly onClosed: () => void,
  ) {
    super(id);
    conn.on('data', (data: unknown) => this.handleData(data));
    conn.on('close', () => this.fail('peer closed'));
    conn.on('error', (err: unknown) => this.fail(errorMessage(err, 'data connection error')));
  }

  /** Marks the transport open (the DataConnection has already fired `open`) and starts pinging. */
  open(): void {
    if (this.status !== 'connecting') return;
    this.setStatus('open');
    this.startKeepalive();
  }

  protected doSend(message: unknown): void {
    this.rawSend(message);
  }

  protected doClose(): void {
    this.cleanup();
    try {
      this.conn.close();
    } catch {
      /* already gone */
    }
  }

  private handleData(data: unknown): void {
    if (isKeepalive(data)) {
      this.missed = 0;
      this.awaitingPong = false;
      if (data.__ka === KA_PING) this.rawSend({ __ka: KA_PONG });
      return;
    }
    this.deliver(data);
  }

  private rawSend(message: unknown): void {
    try {
      void this.conn.send(message);
    } catch (err) {
      this.fail(errorMessage(err, 'send failed'));
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveMs <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.keepaliveMs);
    unrefTimer(this.timer);
  }

  private tick(): void {
    if (this.status !== 'open') return;
    if (this.awaitingPong) this.missed += 1;
    if (this.missed >= KEEPALIVE_MAX_MISSED) {
      this.fail('timeout');
      return;
    }
    this.awaitingPong = true;
    this.rawSend({ __ka: KA_PING });
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onClosed();
  }

  /** Close because of something the far side (or the network) did; keeps the reason. */
  private fail(reason: string): void {
    if (this.status === 'closed') return;
    this.cleanup();
    // Set the status first: closing the DataConnection can re-enter through `close`/`error`.
    this.setStatus('closed', reason);
    try {
      this.conn.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------------------------

class PeerJsListener implements Listener {
  private readonly connections = new Emitter<Transport>();
  private readonly transports = new Set<PeerJsTransport>();
  private closed = false;

  constructor(
    public readonly address: string,
    private readonly peer: Peer,
    private readonly keepaliveMs: number,
  ) {
    this.peer.on('connection', (conn: DataConnection) => this.accept(conn));
  }

  private accept(conn: DataConnection): void {
    if (this.closed) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return;
    }
    // Only surface a connection once its data channel is actually usable.
    if (conn.open) this.attach(conn);
    else conn.on('open', () => this.attach(conn));
  }

  private attach(conn: DataConnection): void {
    if (this.closed) return;
    const transport: PeerJsTransport = new PeerJsTransport(
      conn.peer || conn.connectionId,
      conn,
      this.keepaliveMs,
      () => this.transports.delete(transport),
    );
    this.transports.add(transport);
    transport.open();
    this.connections.emit(transport);
  }

  onConnection(listener: (transport: Transport) => void): Unsubscribe {
    return this.connections.on(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of Array.from(this.transports)) t.close();
    this.transports.clear();
    this.connections.clear();
    this.peer.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// PeerJS loading + option plumbing
// ---------------------------------------------------------------------------------------------

interface PeerConstructor {
  new (id: string | undefined, options?: PeerOptions): Peer;
}

interface LoadedPeerJs {
  Peer: PeerConstructor;
  defaultIceServers: RTCIceServer[];
}

const RTC_GLOBALS = [
  'RTCPeerConnection',
  'RTCSessionDescription',
  'RTCIceCandidate',
  'RTCDataChannel',
] as const;

let nodeWebRtcInstalled: boolean | null = null;

/**
 * Make WebRTC available to PeerJS under Node (22+) by installing the classes from the optional
 * `node-datachannel` package as globals. Synchronous and idempotent so that `host()`/`join()`
 * construct the `Peer` without an extra async gap. Node builtins are reached through
 * `process.getBuiltinModule`, never a static import, so browser bundles contain no Node code and
 * the package name is never a literal import specifier for a bundler to chase.
 */
export function installNodeWebRtcSync(): boolean {
  if (isWebRtcSupported()) return true;
  if (nodeWebRtcInstalled !== null) return nodeWebRtcInstalled;
  const g = globalThis as Record<string, unknown>;
  const proc = g.process as { getBuiltinModule?: (id: string) => unknown } | undefined;
  const getBuiltin = proc?.getBuiltinModule;
  if (typeof getBuiltin !== 'function') return (nodeWebRtcInstalled = false);
  try {
    const { createRequire } = getBuiltin('node:module') as {
      createRequire: (from: string) => (id: string) => unknown;
    };
    const require = createRequire(import.meta.url);
    const polyfill = require('node-datachannel/polyfill') as Record<string, unknown>;
    for (const name of RTC_GLOBALS) {
      if (typeof g[name] === 'undefined' && typeof polyfill[name] === 'function') {
        g[name] = polyfill[name];
      }
    }
    nodeWebRtcInstalled = isWebRtcSupported() && typeof g.WebSocket === 'function';
  } catch {
    nodeWebRtcInstalled = false;
  }
  return nodeWebRtcInstalled;
}

/** Promise-flavoured {@link installNodeWebRtcSync} for callers that prefer to await it. */
export function installNodeWebRtc(): Promise<boolean> {
  return Promise.resolve(installNodeWebRtcSync());
}

function ensureWebRtc(mode: boolean | 'auto'): void {
  if (mode === false) return;
  const inBrowser = typeof window !== 'undefined';
  if (mode === 'auto' && inBrowser) return;
  if (!installNodeWebRtcSync() && mode === true) {
    throw new TransportError(
      'unsupported',
      'WebRTC is not available in this Node process: install node-datachannel (Node 22+)',
    );
  }
}

/**
 * Lazily pull in PeerJS. Kept dynamic so this module imports cleanly in Node, and tolerant of
 * both the ESM namespace and the CJS-interop (`default`) shape.
 */
async function loadPeerJs(node: boolean | 'auto' = 'auto'): Promise<LoadedPeerJs> {
  ensureWebRtc(node);
  const mod = (await import('peerjs')) as unknown as Record<string, unknown>;
  const ns = (
    typeof mod.Peer === 'function' ? mod : ((mod.default ?? {}) as Record<string, unknown>)
  ) as Record<string, unknown>;
  const Peer = ns.Peer;
  if (typeof Peer !== 'function') {
    throw new TransportError('unsupported', 'peerjs could not be loaded in this environment');
  }
  const util = ns.util as { defaultConfig?: { iceServers?: RTCIceServer[] } } | undefined;
  return {
    Peer: Peer as unknown as PeerConstructor,
    defaultIceServers: util?.defaultConfig?.iceServers ?? [],
  };
}

function mergeIceServers(
  defaults: RTCIceServer[],
  override: RTCIceServer[] | undefined,
): RTCIceServer[] {
  if (override) return override;
  const merged = [...defaults];
  const seen = new Set(merged.map((s) => JSON.stringify(s.urls)));
  for (const server of EXTRA_ICE_SERVERS) {
    const key = JSON.stringify(server.urls);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(server);
  }
  return merged;
}

function buildPeerOptions(options: PeerJsProviderOptions, defaults: RTCIceServer[]): PeerOptions {
  const peerOptions: PeerOptions = {
    config: { iceServers: mergeIceServers(defaults, options.iceServers) },
  };
  if (options.host !== undefined) peerOptions.host = options.host;
  if (options.port !== undefined) peerOptions.port = options.port;
  if (options.path !== undefined) peerOptions.path = options.path;
  if (options.secure !== undefined) peerOptions.secure = options.secure;
  if (options.key !== undefined) peerOptions.key = options.key;
  if (options.debug !== undefined) peerOptions.debug = options.debug;
  return { ...peerOptions, ...options.peerOptions };
}

/** Keep Node's event loop free: a heartbeat or a join timeout must never hold a process open. */
function unrefTimer(handle: unknown): void {
  (handle as { unref?: () => void }).unref?.();
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function errorType(err: unknown): string {
  const type = (err as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type : '';
}

/** Maps a PeerJS error onto the transport error vocabulary. */
function toTransportError(err: unknown, fallback: string): TransportError {
  const type = errorType(err);
  const message = `${type || 'error'}: ${errorMessage(err, fallback)}`;
  if (type === 'unavailable-id') return new TransportError('address-taken', message);
  if (type === 'peer-unavailable') return new TransportError('not-found', message);
  if (type === 'browser-incompatible') return new TransportError('unsupported', message);
  return new TransportError('network', message);
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

/**
 * A {@link TransportProvider} backed by PeerJS/WebRTC. With no options it uses the free PeerJS
 * cloud for signalling and public Google STUN servers for NAT traversal — see the README for the
 * caveats (no TURN, so symmetric NATs can fail).
 */
export function peerJsProvider(options: PeerJsProviderOptions = {}): TransportProvider {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const node = options.node ?? 'auto';

  return {
    name: 'peerjs',

    async host(code: string): Promise<Listener> {
      const { Peer, defaultIceServers } = await loadPeerJs(node);
      const peer = new Peer(
        peerIdFor(code, namespace),
        buildPeerOptions(options, defaultIceServers),
      );
      return new Promise<Listener>((resolve, reject) => {
        let settled = false;
        // The signalling server occasionally never answers (stale socket after a reload);
        // without a deadline the whole resume flow would hang silently.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          peer.destroy();
          reject(
            new TransportError(
              'timeout',
              `timed out registering ${code} with the signalling server after ${defaultTimeoutMs}ms`,
            ),
          );
        }, defaultTimeoutMs);
        peer.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new PeerJsListener(code, peer, keepaliveMs));
        });
        peer.on('error', (err: unknown) => {
          // After the listener exists, errors are per-connection noise; PeerJS keeps the peer.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          peer.destroy();
          reject(toTransportError(err, `could not host ${code}`));
        });
      });
    },

    async join(code: string, opts?: { timeoutMs?: number }): Promise<Transport> {
      const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
      const { Peer, defaultIceServers } = await loadPeerJs(node);
      const target = peerIdFor(code, namespace);
      const peer = new Peer(undefined, buildPeerOptions(options, defaultIceServers));

      return new Promise<Transport>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          fail(new TransportError('timeout', `timed out joining ${code} after ${timeoutMs}ms`));
        }, timeoutMs);
        unrefTimer(timer);

        function settle(): boolean {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          return true;
        }

        function fail(error: TransportError): void {
          if (!settle()) return;
          peer.destroy();
          reject(error);
        }

        peer.on('error', (err: unknown) => fail(toTransportError(err, `could not join ${code}`)));

        peer.on('open', () => {
          if (settled) return;
          const conn = peer.connect(target, { reliable: true, serialization: 'json' });
          conn.on('open', () => {
            if (!settle()) return;
            const transport = new PeerJsTransport(target, conn, keepaliveMs, () => peer.destroy());
            transport.open();
            resolve(transport);
          });
          // Pre-open failures only: once resolved, the transport owns these events.
          conn.on('error', (err: unknown) => fail(toTransportError(err, `could not join ${code}`)));
          conn.on('close', () =>
            fail(new TransportError('closed', `connection to ${code} closed before opening`)),
          );
        });
      });
    },
  };
}
