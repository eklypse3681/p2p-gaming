import type { Listener, Transport, TransportProvider } from '@bgf/protocol';
import { TransportError } from '@bgf/protocol';
import { constantTimeEqual, hasWebCrypto, hmacSha256Hex, randomNonce, syncAddress } from './crypto';
import type { SyncChange, SyncData, SyncMessage, SyncStore } from './protocol';
import {
  SYNC_PROTOCOL,
  applied,
  applyData,
  buildManifest,
  collectData,
  diffManifests,
  isEmptyData,
  isEmptyWant,
  parseSyncMessage,
} from './protocol';
import type { DeviceInfo } from './device';

/**
 * Keeps one player's devices in sync over the app's transport (PeerJS/WebRTC in production).
 *
 * All devices holding the same sync key meet at the same room address. Whoever gets there first
 * is the **hub**: it accepts every other device, applies what they send and relays it to the
 * rest, so the topology is a star. A device that fails to host joins as a **client**; when its
 * connection drops it retries with backoff and races to become the hub itself.
 *
 * Nothing here throws into React: every failure lands in `status.lastError`.
 */

export type SyncState = 'off' | 'searching' | 'hub' | 'connected' | 'error';

export interface SyncDevice {
  deviceId: string;
  label: string;
  since: number;
}

export interface SyncStatus {
  state: SyncState;
  devices: SyncDevice[];
  lastSyncAt: number | null;
  lastError: string | null;
  /** Why the manager is off (disabled, unsupported, …). */
  reason: string | null;
}

export const OFF_STATUS: SyncStatus = {
  state: 'off',
  devices: [],
  lastSyncAt: null,
  lastError: null,
  reason: null,
};

export interface SyncManagerOptions {
  store: SyncStore;
  provider: TransportProvider;
  device: DeviceInfo;
  now?: () => number;
  /** Retry delays for a client that lost its hub: base × 2^n, capped. */
  backoff?: { baseMs: number; maxMs: number };
  /** Live changes are coalesced for this long before being pushed. */
  pushDebounceMs?: number;
  joinTimeoutMs?: number;
  log?: (message: string) => void;
}

interface Peer {
  transport: Transport;
  nonce: string;
  remote: { deviceId: string; label: string; nonce: string } | null;
  /** The peer proved it holds the key; data may flow. */
  authed: boolean;
  since: number;
  cleanup: (() => void)[];
  /** Messages are handled strictly in order (handlers await crypto and storage). */
  chain: Promise<void>;
}

export const MAX_SYNC_PEERS = 8;

export class SyncManager {
  private readonly store: SyncStore;
  private readonly provider: TransportProvider;
  private readonly device: DeviceInfo;
  private readonly now: () => number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly pushDebounceMs: number;
  private readonly joinTimeoutMs: number;
  private readonly log: (message: string) => void;

  private status: SyncStatus = OFF_STATUS;
  private readonly listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  private listener: Listener | null = null;
  private readonly peers = new Set<Peer>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private applying = 0;
  private pending: SyncChange[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubStore: (() => void) | null = null;

  constructor(opts: SyncManagerOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.device = opts.device;
    this.now = opts.now ?? Date.now;
    this.backoff = opts.backoff ?? { baseMs: 1000, maxMs: 30_000 };
    this.pushDebounceMs = opts.pushDebounceMs ?? 250;
    this.joinTimeoutMs = opts.joinTimeoutMs ?? 15_000;
    this.log = opts.log ?? (() => {});
  }

  get isHub(): boolean {
    return this.listener !== null;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.running) return;
    if (!hasWebCrypto()) {
      this.setStatus({ ...OFF_STATUS, reason: 'WebCrypto is not available in this browser' });
      return;
    }
    this.running = true;
    this.attempt = 0;
    const gen = ++this.generation;
    this.unsubStore = this.store.onChange((c) => this.onLocalChange(c));
    void this.loop(gen);
  }

  stop(reason: string | null = null): void {
    this.generation++;
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.pending = [];
    this.unsubStore?.();
    this.unsubStore = null;
    for (const peer of Array.from(this.peers)) this.detach(peer, true);
    this.listener?.close();
    this.listener = null;
    this.setStatus({ ...OFF_STATUS, lastSyncAt: this.status.lastSyncAt, reason });
  }

  // -------------------------------------------------------------------------------------------
  // Connection loop
  // -------------------------------------------------------------------------------------------

  private async loop(gen: number): Promise<void> {
    if (!this.alive(gen)) return;
    this.setStatus({ state: 'searching' });
    let address: string;
    try {
      address = await syncAddress(this.store.syncKey);
    } catch (e) {
      this.fail(gen, `could not derive the sync address: ${(e as Error).message}`, true);
      return;
    }
    if (!this.alive(gen)) return;

    // Race to be the hub.
    try {
      const listener = await this.provider.host(address);
      if (!this.alive(gen)) {
        listener.close();
        return;
      }
      this.listener = listener;
      listener.onConnection((t) => this.attach(t, gen));
      this.attempt = 0;
      this.setStatus({ state: 'hub', lastError: null });
      this.log(`hub at ${address}`);
      return;
    } catch (e) {
      if (!this.alive(gen)) return;
      if (e instanceof TransportError && e.code === 'unsupported') {
        this.fail(gen, e.message, true);
        return;
      }
      if (!(e instanceof TransportError && e.code === 'address-taken')) {
        this.fail(gen, describe(e));
        this.scheduleRetry(gen);
        return;
      }
    }

    // Another device is the hub: join it.
    try {
      const transport = await this.provider.join(address, { timeoutMs: this.joinTimeoutMs });
      if (!this.alive(gen)) {
        transport.close();
        return;
      }
      this.attempt = 0;
      this.attach(transport, gen);
      this.log(`joined hub at ${address}`);
    } catch (e) {
      if (!this.alive(gen)) return;
      this.fail(gen, describe(e));
      this.scheduleRetry(gen);
    }
  }

  private scheduleRetry(gen: number): void {
    if (!this.alive(gen)) return;
    const delay = Math.min(this.backoff.baseMs * 2 ** this.attempt, this.backoff.maxMs);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.loop(gen);
    }, delay);
  }

  private alive(gen: number): boolean {
    return this.running && gen === this.generation;
  }

  private fail(gen: number, message: string, off = false): void {
    if (!this.alive(gen)) return;
    this.log(`error: ${message}`);
    if (off) {
      this.running = false;
      this.unsubStore?.();
      this.unsubStore = null;
      this.setStatus({ ...OFF_STATUS, lastError: message, reason: message });
    } else {
      this.setStatus({ state: 'error', lastError: message });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------------------------

  private attach(transport: Transport, gen: number): void {
    if (!this.alive(gen) || this.peers.size >= MAX_SYNC_PEERS) {
      transport.close();
      return;
    }
    const peer: Peer = {
      transport,
      nonce: randomNonce(),
      remote: null,
      authed: false,
      since: this.now(),
      cleanup: [],
      chain: Promise.resolve(),
    };
    this.peers.add(peer);
    this.log(`peer ${transport.id} attached (${transport.status})`);
    peer.cleanup.push(
      transport.onMessage((raw) => {
        peer.chain = peer.chain.then(() => this.handle(peer, raw, gen)).catch(() => {});
      }),
      transport.onStatus((status) => {
        if (status === 'closed') this.detach(peer, false, gen);
      }),
    );
    this.send(peer, {
      type: 'sync-hello',
      protocol: SYNC_PROTOCOL,
      profileId: this.store.profileId,
      deviceId: this.device.id,
      deviceLabel: this.device.label,
      nonce: peer.nonce,
    });
    if (transport.status === 'closed') this.detach(peer, false, gen);
  }

  private detach(peer: Peer, closing: boolean, gen: number = this.generation): void {
    if (!this.peers.has(peer)) return;
    this.peers.delete(peer);
    this.log(`peer ${peer.transport.id} detached (closing=${closing}, ${peer.transport.status})`);
    for (const c of peer.cleanup) c();
    if (peer.transport.status !== 'closed') {
      if (closing) {
        try {
          peer.transport.send({ type: 'bye' } satisfies SyncMessage);
        } catch {
          /* already gone */
        }
      }
      peer.transport.close();
    }
    if (closing) return;
    this.syncDevices();
    // A client that lost its hub goes looking again (and may become the hub itself).
    if (!this.isHub && this.alive(gen)) {
      this.setStatus({ state: 'searching' });
      this.scheduleRetry(gen);
    }
  }

  private send(peer: Peer, message: SyncMessage): void {
    try {
      peer.transport.send(message);
    } catch (e) {
      this.log(`send failed: ${describe(e)}`);
    }
  }

  private authedPeers(): Peer[] {
    return Array.from(this.peers).filter((p) => p.authed);
  }

  private syncDevices(): void {
    const devices: SyncDevice[] = this.authedPeers().map((p) => ({
      deviceId: p.remote!.deviceId,
      label: p.remote!.label,
      since: p.since,
    }));
    const state: SyncState = this.isHub ? 'hub' : devices.length ? 'connected' : 'searching';
    this.setStatus({ devices, state });
  }

  private async handle(peer: Peer, raw: unknown, gen: number): Promise<void> {
    if (!this.alive(gen) || !this.peers.has(peer)) return;
    const msg = parseSyncMessage(raw);
    if (!msg) {
      this.log('malformed message; closing peer');
      this.detach(peer, true);
      return;
    }
    this.log(`recv ${msg.type} from ${peer.transport.id}`);
    try {
      switch (msg.type) {
        case 'sync-hello': {
          if (msg.protocol !== SYNC_PROTOCOL || msg.profileId !== this.store.profileId) {
            this.detach(peer, true);
            return;
          }
          peer.remote = { deviceId: msg.deviceId, label: msg.deviceLabel, nonce: msg.nonce };
          const mac = await hmacSha256Hex(this.store.syncKey, msg.nonce);
          if (!this.peers.has(peer)) return;
          this.send(peer, { type: 'sync-auth', mac });
          return;
        }
        case 'sync-auth': {
          const expected = await hmacSha256Hex(this.store.syncKey, peer.nonce);
          if (!this.peers.has(peer)) return;
          if (!peer.remote || !constantTimeEqual(expected, msg.mac)) {
            this.log('peer failed authentication; closing');
            this.setStatus({ lastError: 'a device tried to sync with the wrong key' });
            this.detach(peer, true);
            return;
          }
          peer.authed = true;
          this.syncDevices();
          this.send(peer, { type: 'manifest', ...(await buildManifest(this.store)) });
          return;
        }
        case 'bye':
          this.detach(peer, false, gen);
          return;
        default:
          break;
      }
      if (!peer.authed) {
        this.detach(peer, true);
        return;
      }
      switch (msg.type) {
        case 'manifest': {
          const want = diffManifests(await buildManifest(this.store), msg);
          if (!isEmptyWant(want)) this.send(peer, { type: 'want', ...want });
          return;
        }
        case 'want': {
          const data = await collectData(this.store, msg);
          if (!isEmptyData(data)) this.send(peer, { type: 'data', ...data });
          return;
        }
        case 'data': {
          const { type: _type, ...data } = msg;
          this.applying++;
          try {
            const result = await applyData(this.store, data);
            if (applied(result)) this.setStatus({ lastSyncAt: this.now(), lastError: null });
          } finally {
            this.applying--;
          }
          // The hub is the star's centre: pass it on to every other device.
          if (this.isHub) this.broadcast(data, peer);
          return;
        }
      }
    } catch (e) {
      this.log(`handling ${msg.type} failed: ${describe(e)}`);
      this.setStatus({ lastError: describe(e) });
    }
  }

  private broadcast(data: SyncData, except?: Peer): void {
    if (isEmptyData(data)) return;
    for (const p of this.authedPeers()) if (p !== except) this.send(p, { type: 'data', ...data });
  }

  // -------------------------------------------------------------------------------------------
  // Live push of local changes
  // -------------------------------------------------------------------------------------------

  private onLocalChange(change: SyncChange): void {
    if (!this.running || this.applying > 0) return; // echo of something a peer just sent us
    this.pending.push(change);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushPush();
    }, this.pushDebounceMs);
  }

  private async flushPush(): Promise<void> {
    const changes = this.pending;
    this.pending = [];
    if (!this.running || changes.length === 0 || this.authedPeers().length === 0) return;
    const data: SyncData = {};
    let unknown = false;
    const matchIds = new Map<string, { game: SyncChange & { kind: 'match' } }>();
    for (const c of changes) {
      if (c.kind === 'profile') data.profile = this.store.profile();
      else if (c.kind === 'settings') data.settings = this.store.settings();
      else if (c.kind === 'match') matchIds.set(`${c.game}/${c.id}`, { game: c });
      else unknown = true;
    }
    for (const { game: c } of matchIds.values()) {
      const m = await this.store.getMatch(c.game, c.id).catch(() => undefined);
      if (m) ((data.matches ??= {})[c.game] ??= []).push(m);
    }
    if (!this.running) return;
    this.broadcast(data);
    if (unknown) {
      // Something changed that we cannot name: let the peers ask for what they lack.
      const manifest = await buildManifest(this.store);
      for (const p of this.authedPeers()) this.send(p, { type: 'manifest', ...manifest });
    }
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of Array.from(this.listeners)) l();
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
