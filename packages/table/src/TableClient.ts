import type {
  AutopilotPending,
  PlayerProfile,
  RejectReason,
  Signer,
  TableChat,
  TableClientMessage,
  TableServerMessage,
  TableSnapshot,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import { PROTOCOL_VERSION, bytesToBase64Url, challengeBytes, isServerMessage } from '@bgf/protocol';
import { MAX_CHAT_HISTORY } from './snapshot.js';

export type ConnectionStatus = 'connecting' | 'joined' | 'rejected' | 'disconnected';
/** What this client is at the table: a player, the non-playing dealer, or (not yet) anything. */
export type TableRole = 'seat' | 'dealer' | 'spectator';

export interface ClientError {
  code: string;
  message: string;
  at: number;
}

export interface LastAction<A> {
  action: A;
  /** Seat that triggered it, when known. */
  by: number | null;
  /** Snapshot seq after the action; strictly increasing. */
  seq: number;
}

/** Persistence for table snapshots; every device saves each snapshot it receives. */
export interface SnapshotStore<S = unknown, A = unknown, Cfg = unknown> {
  put(snapshot: TableSnapshot<S, A, Cfg>): Promise<void>;
}

export interface TableClientState<V = unknown, A = unknown, Cfg = unknown> {
  status: ConnectionStatus;
  rejectReason: RejectReason | null;
  /** Seat this client occupies; null until welcomed, and null for the dealer. */
  seat: number | null;
  /** 'seat' once welcomed into a seat, 'dealer' when this device hosts as the non-playing dealer. */
  role: TableRole;
  /** Dealer-hosted tables: the dealer's public profile and whether a dealer device is connected. */
  dealer: { profile: PlayerProfile; connected: boolean } | null;
  /** Latest snapshot from the server (full for the host seat, a view for the others). */
  snapshot: TableSnapshot<V, A, Cfg> | null;
  lastAction: LastAction<A> | null;
  /** Provisional payloads other seats are currently arranging, by seat. Cleared on every state. */
  previews: Record<number, unknown>;
  /** Presence by seat index (own seat included once joined). */
  presence: boolean[];
  /** Readiness by seat ("ready for the next hand"), table flow shared with every device. */
  ready: boolean[];
  /** What the unattended table will do next (e.g. a next-hand countdown), or null. */
  autopilot: AutopilotPending | null;
  chat: TableChat[];
  latencyMs: number | null;
  error: ClientError | null;
}

export interface TableClientOptions<S = unknown, A = unknown, Cfg = unknown> {
  transport: Transport;
  profile: PlayerProfile;
  /** Signs the server's seat challenge with this player's private key. */
  signer?: Signer;
  /** Our persisted copy, offered to the server so the newest replayable state wins. */
  resumeSnapshot?: TableSnapshot<S, A, Cfg>;
  store?: SnapshotStore<S, A, Cfg>;
  /** Ping interval for latency measurement. Default 10s; 0 disables. */
  pingIntervalMs?: number;
  now?: () => number;
  onStoreError?: (error: unknown) => void;
}

/**
 * The client half of the table protocol: identical on host and guest, talks only to a
 * `Transport`, exposes a `useSyncExternalStore`-friendly state. Game packages wrap it to add
 * their own command helpers and local drafting.
 */
export class TableClient<S = unknown, A = unknown, Cfg = unknown, V = S> {
  readonly profile: PlayerProfile;

  private state: TableClientState<V, A, Cfg>;
  private readonly listeners = new Set<() => void>();
  private readonly transport: Transport;
  private readonly store: SnapshotStore<S, A, Cfg> | undefined;
  private readonly resumeSnapshot: TableSnapshot<S, A, Cfg> | undefined;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly onStoreError: (error: unknown) => void;
  private readonly signer: Signer | undefined;
  private readonly unsubscribe: Unsubscribe[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private helloSent = false;
  private closed = false;

  constructor(opts: TableClientOptions<S, A, Cfg>) {
    this.profile = opts.profile;
    this.transport = opts.transport;
    this.store = opts.store;
    this.resumeSnapshot = opts.resumeSnapshot;
    this.signer = opts.signer;
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onStoreError = opts.onStoreError ?? ((e) => console.warn('[TableClient] store error', e));
    this.state = {
      status: 'connecting',
      rejectReason: null,
      seat: null,
      role: 'spectator',
      dealer: null,
      snapshot: null,
      lastAction: null,
      previews: {},
      presence: [],
      ready: [],
      autopilot: null,
      chat: [],
      latencyMs: null,
      error: null,
    };
    this.unsubscribe.push(this.transport.onMessage((m) => this.handle(m)));
    this.unsubscribe.push(
      this.transport.onStatus((status, reason) => {
        if (status === 'open') this.sendHello();
        if (status === 'closed') this.onTransportClosed(reason);
      }),
    );
    if (this.transport.status === 'open') this.sendHello();
    else if (this.transport.status === 'closed') this.onTransportClosed('closed');
  }

  getState(): TableClientState<V, A, Cfg> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private setState(patch: Partial<TableClientState<V, A, Cfg>>): void {
    this.state = { ...this.state, ...patch };
    for (const l of Array.from(this.listeners)) l();
  }

  // ---------------------------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------------------------

  private sendRaw(message: TableClientMessage): boolean {
    if (this.closed || this.transport.status !== 'open') return false;
    try {
      this.transport.send(message);
      return true;
    } catch {
      return false;
    }
  }

  /** Send a game command (the server validates it). Returns false if nothing was sent. */
  send(command: unknown): boolean {
    return this.sendRaw({ type: 'command', command });
  }

  /** Send a non-authoritative preview payload to the other seats. */
  sendPreview(payload: unknown): boolean {
    if (this.state.status !== 'joined') return false;
    return this.sendRaw({ type: 'preview', payload });
  }

  /** Table flow: tell the table this seat is (not) ready for the next hand / game. */
  setReady(ready: boolean): boolean {
    return this.sendRaw({ type: 'ready', ready });
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.sendRaw({ type: 'chat', text: trimmed });
  }

  private sendHello(): void {
    if (this.helloSent || this.closed) return;
    const hello: TableClientMessage = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      profile: this.profile,
    };
    if (this.resumeSnapshot) hello.snapshot = this.resumeSnapshot;
    if (this.sendRaw(hello)) this.helloSent = true;
  }

  private async answerChallenge(
    msg: Extract<TableServerMessage, { type: 'challenge' }>,
  ): Promise<void> {
    if (!this.signer) {
      this.setState({
        status: 'rejected',
        rejectReason: 'unauthorized',
        error: {
          code: 'rejected:unauthorized',
          message: 'this player has no signing key for that seat',
          at: this.now(),
        },
      });
      return;
    }
    let signature: string;
    try {
      const bytes = challengeBytes({
        matchId: msg.matchId,
        profileId: this.profile.id,
        nonce: msg.nonce,
      });
      signature = bytesToBase64Url(await this.signer(bytes));
    } catch (e) {
      this.setState({
        status: 'rejected',
        rejectReason: 'unauthorized',
        error: { code: 'rejected:unauthorized', message: (e as Error).message, at: this.now() },
      });
      return;
    }
    if (this.closed) return;
    this.sendRaw({ type: 'auth', signature });
  }

  private onTransportClosed(reason?: string): void {
    this.stopPing();
    if (this.state.status === 'rejected') return;
    this.setState({
      status: 'disconnected',
      presence: this.state.presence.map(() => false),
      error:
        reason && reason !== 'closed'
          ? { code: 'disconnected', message: reason, at: this.now() }
          : this.state.error,
    });
  }

  private startPing(): void {
    if (this.pingIntervalMs <= 0 || this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping', t: this.now() });
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private persist(snapshot: TableSnapshot<V, A, Cfg>): void {
    if (!this.store) return;
    try {
      void this.store
        .put(snapshot as unknown as TableSnapshot<S, A, Cfg>)
        .catch((e: unknown) => this.onStoreError(e));
    } catch (e) {
      this.onStoreError(e);
    }
  }

  private presenceWith(seatCount: number, patch: Record<number, boolean>): boolean[] {
    const out = this.state.presence.slice();
    while (out.length < seatCount) out.push(false);
    for (const [k, v] of Object.entries(patch)) out[Number(k)] = v;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------------------------

  private handle(raw: unknown): void {
    if (this.closed || !isServerMessage(raw)) return;
    const msg = raw as TableServerMessage<V, A>;
    switch (msg.type) {
      case 'challenge':
        void this.answerChallenge(msg);
        return;
      case 'welcome': {
        const snapshot = msg.snapshot as TableSnapshot<V, A, Cfg>;
        const role: TableRole = msg.seat === null ? 'dealer' : 'seat';
        this.setState({
          status: 'joined',
          rejectReason: null,
          seat: msg.seat,
          role,
          dealer: snapshot.dealer
            ? { profile: snapshot.dealer, connected: role === 'dealer' }
            : this.state.dealer,
          snapshot,
          chat: snapshot.chat ?? [],
          presence: this.presenceWith(
            snapshot.seats.length,
            msg.seat === null ? {} : { [msg.seat]: true },
          ),
          previews: {},
        });
        this.persist(snapshot);
        this.startPing();
        return;
      }
      case 'rejected':
        this.setState({
          status: 'rejected',
          rejectReason: msg.reason,
          error: { code: `rejected:${msg.reason}`, message: msg.message, at: this.now() },
        });
        return;
      case 'state': {
        const snapshot = msg.snapshot as TableSnapshot<V, A, Cfg>;
        this.setState({
          snapshot,
          chat: snapshot.chat ?? this.state.chat,
          lastAction:
            msg.action !== undefined
              ? { action: msg.action, by: msg.by ?? null, seq: snapshot.seq }
              : this.state.lastAction,
          previews: {},
        });
        this.persist(snapshot);
        return;
      }
      case 'preview':
        if (msg.seat !== this.state.seat) {
          const previews = { ...this.state.previews };
          if (msg.payload === null || msg.payload === undefined) delete previews[msg.seat];
          else previews[msg.seat] = msg.payload;
          this.setState({ previews });
        }
        return;
      case 'presence': {
        const seatCount = Math.max(this.state.presence.length, msg.seat + 1);
        this.setState({ presence: this.presenceWith(seatCount, { [msg.seat]: msg.connected }) });
        return;
      }
      case 'dealer':
        this.setState({ dealer: { profile: msg.profile, connected: msg.connected } });
        return;
      case 'ready':
        // Readiness lives beside the snapshot; the next `state` carries it in `snapshot.ready`.
        this.setState({ ready: msg.ready.slice() });
        return;
      case 'autopilot':
        this.setState({ autopilot: msg.pending });
        return;
      case 'chat': {
        const chat = [...this.state.chat, msg.message].slice(-MAX_CHAT_HISTORY);
        const snapshot = this.state.snapshot ? { ...this.state.snapshot, chat } : null;
        this.setState({ chat, snapshot });
        if (snapshot) this.persist(snapshot);
        return;
      }
      case 'error':
        this.setState({ error: { code: msg.code, message: msg.message, at: this.now() } });
        return;
      case 'pong':
        this.setState({ latencyMs: Math.max(0, this.now() - msg.t) });
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.sendRaw({ type: 'bye' });
    this.closed = true;
    this.stopPing();
    for (const u of this.unsubscribe) u();
    this.transport.close();
    if (this.state.status !== 'rejected') {
      this.setState({ status: 'disconnected', presence: this.state.presence.map(() => false) });
    }
    this.listeners.clear();
  }
}
