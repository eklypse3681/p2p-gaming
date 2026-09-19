import type {
  AutopilotPending,
  BeaconBinding,
  EntropyAudit,
  EntropyRecord,
  EntropySourceProof,
  PlayerProfile,
  RandomnessMode,
  RejectReason,
  SeedSegment,
  TableClientMessage,
  TableServerMessage,
  TableSnapshot,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import {
  DEALER_SEAT,
  Emitter,
  PROTOCOL_VERSION,
  challengeBytes,
  createMemoryPair,
  generateId,
} from '@bgf/protocol';
import type { PendingChallenge } from './challenge.js';
import { beginChallenge, cancelChallenge, verifyChallengeAnswer } from './challenge.js';
import type { AuditedRng, AutopilotContext, GameDefinition, Rng } from './definition.js';
import { isAuditedRng, isCodedError } from './definition.js';
import { describeTrust } from './trust.js';
import type { BeaconSource, EntropyDraw, EntropySource } from './entropy.js';
import {
  EntropyExhausted,
  NeedsEntropy,
  beaconContext,
  bytesToHex,
  concatBytes,
  createByteRng,
  isBeaconSource,
  probeRng,
  sourceProof,
} from './entropy.js';
import { cryptoRng } from './rng.js';
import { SEED_BYTES, commitmentFor, segmentDrawBytes } from './seeded.js';
import { MAX_CHAT_HISTORY, verifySnapshot, viewSnapshot } from './snapshot.js';
import { validateTableMessage } from './validate.js';

export interface TableServerOptions<S, A, C, V, Cfg> {
  def: GameDefinition<S, A, C, V, Cfg>;
  /** Room code (new table). */
  code: string;
  /** Profile of the player (or dealer) hosting this server. */
  host: PlayerProfile;
  /**
   * Seat the host takes in a new table. Default 0. `null` = **dealer mode**: the hosting device
   * plays no seat; it holds the authoritative state, may send only the definition's
   * `dealerCommands`, and every player is a guest.
   */
  hostSeat?: number | null;
  /** Number of seats. Default `def.minSeats`; clamped to [minSeats, maxSeats]. */
  seats?: number;
  /** Game configuration for a new table (passed through `def.normalizeConfig`). */
  config?: unknown;
  /**
   * Table-level options the game does not interpret (layout, house preferences). The
   * `randomness` entry selects the randomness mode: `{ mode: 'per-draw' | 'seeded' | 'beacon' }`
   * (default `per-draw`); the provider name is filled in from `entropy.source`.
   */
  options?: Record<string, unknown>;
  /** Start from a custom state instead of `def.init` (set-up positions, tests). */
  initialState?: S;
  /** Resume from persisted state; the action log is replayed to verify it. */
  snapshot?: TableSnapshot<S, A, Cfg>;
  /** Attribution for a pre-drawn `initialState` (set by `TableServer.create`). */
  initRecord?: EntropyRecord;
  /**
   * Randomness for dice, shuffles, …; default the platform CSPRNG. Pass an `AuditedRng` (an
   * `@bgf/entropy` pool) and every action that consumed randomness is annotated in
   * `snapshot.actionMeta`, the batch proofs are published in `snapshot.entropyAudit`, and
   * `options.randomness.provider` names the declared source.
   */
  rng?: Rng | AuditedRng;
  /**
   * Just-in-time randomness from an external, verifiable source (random.org, drand). Bytes are
   * requested only when a command draws, so nobody — the host included — can see them early.
   * Takes precedence over `rng` for commands that draw; `rng` is then only the fallback.
   * In `seeded` mode the source supplies one seed per segment; in `beacon` mode it must be a
   * `BeaconSource` (drand).
   */
  entropy?: {
    source: EntropySource;
    /** Bytes requested per command; doubled and re-run when a command needs more. Default 64. */
    bytes?: number;
    /** On source failure use this device's generator (flagged in the record) instead of refusing. Default false. */
    fallback?: boolean;
    /** Recorded with each request. Default 'table'. */
    purpose?: string;
    /** Beacon mode: how long to wait for a round before refusing the command. Default 30 s. */
    beaconTimeoutMs?: number;
  };
  now?: () => number;
  matchId?: string;
  /** @internal Build without an initial state; `create` fills it in after an asynchronous draw. */
  skipInit?: boolean;
}

interface QueuedCommand<C> {
  conn: Connection;
  seat: number;
  command: C;
}

/** Default byte budget per drawing command (a backgammon roll needs 8, an OFC shuffle ~230). */
export const DEFAULT_ENTROPY_BYTES = 64;
/** How many times a command is re-run with a bigger budget before it is refused. */
export const MAX_ENTROPY_ROUNDS = 4;
/** Beacon mode: how long a command may wait for its round. */
export const DEFAULT_BEACON_TIMEOUT_MS = 30_000;

type Role = 'seat' | 'dealer';

interface Connection {
  transport: Transport;
  /** Seat index once admitted as a player; `DEALER_SEAT` once admitted as the dealer; null before. */
  seat: number | null;
  role: Role | null;
  closed: boolean;
  unsubscribe: Unsubscribe[];
  pending?: PendingAuth;
}

interface PendingAuth {
  role: Role;
  seat: number;
  profile: PlayerProfile;
  publicKey: string;
  nonce: string;
  snapshot?: TableSnapshot;
  timer: ReturnType<typeof setTimeout>;
  verifying: boolean;
  challenge: PendingChallenge;
}

/**
 * A seat held for one player before they arrive: only a hello from that profile id AND that key
 * may take it. Reservations live in memory (the host re-creates them on resume) and vanish once
 * the player is seated, released, or expired.
 */
export interface SeatReservation {
  profileId: string;
  publicKey: string;
  /** Epoch ms after which the reservation no longer holds. */
  expiresAt?: number;
}

/** A seeded segment as the server keeps it: the seed itself never leaves this object until reveal. */
interface PrivateSegment {
  index: number;
  seed: Uint8Array;
  source: EntropySourceProof;
  draws: number;
  revealed: boolean;
}

/** How long a client has to answer a challenge before the connection is dropped. */
export const CHALLENGE_TIMEOUT_MS = 30_000;
/** How many devices one player may have connected at once; the oldest is dropped beyond this. */
export const MAX_CONNECTIONS_PER_SEAT = 4;
export { MAX_CHAT_HISTORY };

interface EntropyConfig {
  source: EntropySource;
  bytes: number;
  fallback: boolean;
  purpose: string;
  beaconTimeoutMs: number;
}

/**
 * The authoritative table server. It lives in the host's browser (or in a Node test) and only
 * ever sees `Transport` objects. It knows nothing about the game beyond its `GameDefinition`.
 *
 * A seat is a player, not a connection: the same profile may be connected from several devices
 * at once and every device of a seat receives every message meant for it. The host seat's
 * devices (or the dealer's, in dealer mode) receive the full state; other seats receive
 * `def.view(state, seat)`.
 */
export class TableServer<S, A, C, V = S, Cfg = unknown> {
  readonly def: GameDefinition<S, A, C, V, Cfg>;
  private snapshot: TableSnapshot<S, A, Cfg>;
  private readonly rng: Rng;
  private readonly audited: AuditedRng | null;
  private readonly entropy: EntropyConfig | null;
  private readonly mode: RandomnessMode;
  /** Seeded mode: every segment so far (seeds stay private until revealed). */
  private readonly segments: PrivateSegment[] = [];
  /** Beacon mode: per-table draw counter. */
  private beaconCounter = 0;
  /** Commands waiting behind an in-flight just-in-time draw, in arrival order. */
  private readonly queue: QueuedCommand<C>[] = [];
  private busy = false;
  private readonly now: () => number;
  private readonly connections = new Set<Connection>();
  private readonly reservedSeats = new Map<number, SeatReservation>();
  /** Live connections per seat, oldest first. A seat with no connections has no entry. */
  private readonly seats = new Map<number, Connection[]>();
  /** Live dealer connections (dealer mode), oldest first. */
  private dealers: Connection[] = [];
  private readonly changes = new Emitter<{ snapshot: TableSnapshot<S, A, Cfg>; action?: A }>();
  private readonly autopilotEvents = new Emitter<AutopilotEvent>();
  private autopilotTimer: ReturnType<typeof setTimeout> | null = null;
  private autopilotPending: { reason: string; at: number } | null = null;
  private evaluating = false;
  private applyingReason: string | null = null;
  /** Stand-in connection for commands the table sends itself; its transport swallows replies. */
  private readonly systemConn: Connection = {
    transport: {
      id: 'autopilot',
      status: 'closed',
      send() {
        /* nothing to deliver */
      },
      onMessage: () => () => {},
      onStatus: () => () => {},
      close() {
        /* nothing to close */
      },
    },
    seat: DEALER_SEAT,
    role: 'dealer',
    closed: false,
    unsubscribe: [],
  };
  private closed = false;

  constructor(opts: TableServerOptions<S, A, C, V, Cfg>) {
    this.def = opts.def;
    this.rng = opts.rng ?? cryptoRng();
    this.audited = isAuditedRng(this.rng) ? this.rng : null;
    const requestedMode =
      (opts.options?.randomness as { mode?: RandomnessMode } | undefined)?.mode ??
      (opts.snapshot?.options?.randomness as { mode?: RandomnessMode } | undefined)?.mode;
    this.mode = requestedMode ?? 'per-draw';
    if (this.mode === 'seeded' && !opts.entropy) {
      // Commit-and-reveal with this device's own generator: still proves the seed was fixed
      // before any draw, even though nobody can check where the seed came from.
      this.entropy = {
        source: localSource(),
        bytes: DEFAULT_ENTROPY_BYTES,
        fallback: false,
        purpose: 'table',
        beaconTimeoutMs: DEFAULT_BEACON_TIMEOUT_MS,
      };
    } else {
      this.entropy = opts.entropy
        ? {
            source: opts.entropy.source,
            bytes: opts.entropy.bytes ?? DEFAULT_ENTROPY_BYTES,
            fallback: opts.entropy.fallback ?? false,
            purpose: opts.entropy.purpose ?? 'table',
            beaconTimeoutMs: opts.entropy.beaconTimeoutMs ?? DEFAULT_BEACON_TIMEOUT_MS,
          }
        : null;
    }
    if (this.mode === 'beacon' && (!this.entropy || !isBeaconSource(this.entropy.source))) {
      throw new Error('beacon randomness needs a BeaconSource (drand) as entropy.source');
    }
    this.now = opts.now ?? Date.now;
    if (opts.snapshot) {
      this.snapshot = verifySnapshot(this.def, opts.snapshot);
      if (this.mode === 'seeded') this.restoreSegments();
      if (this.mode === 'beacon') this.restoreBeacon();
      if (this.audited) this.snapshot = this.withAudit(this.snapshot);
      this.snapshot = this.withTrust(this.snapshot);
      return;
    }
    const seatCount = Math.min(
      this.def.maxSeats,
      Math.max(this.def.minSeats, opts.seats ?? this.def.minSeats),
    );
    const hostSeat = opts.hostSeat === undefined ? 0 : opts.hostSeat;
    if (hostSeat !== null && (hostSeat < 0 || hostSeat >= seatCount)) {
      throw new RangeError(`hostSeat ${hostSeat} is out of range for ${seatCount} seats`);
    }
    const config = (
      this.def.normalizeConfig ? this.def.normalizeConfig(opts.config) : opts.config
    ) as Cfg;
    let initialState = opts.initialState as S;
    let initRecord: EntropyRecord | null = opts.initRecord ?? null;
    if (opts.skipInit) {
      initialState = undefined as never;
    } else if (opts.initialState === undefined) {
      if (this.entropy) {
        // A just-in-time source cannot be consulted synchronously: use `TableServer.create`.
        try {
          initialState = this.def.init(config, { rng: probeRng(), seats: seatCount });
        } catch (e) {
          if (e instanceof NeedsEntropy) {
            throw new Error(
              'this game draws randomness in init(); with a just-in-time entropy source use `await TableServer.create(opts)`',
            );
          }
          throw e;
        }
      } else if (this.audited) {
        const drawn = this.audited.withDraw('init', (rng) =>
          this.def.init(config, { rng, seats: seatCount }),
        );
        initialState = drawn.value;
        initRecord = drawn.record;
      } else {
        initialState = this.def.init(config, { rng: this.rng, seats: seatCount });
      }
    }
    const seats: (PlayerProfile | null)[] = new Array<PlayerProfile | null>(seatCount).fill(null);
    if (hostSeat !== null) seats[hostSeat] = opts.host;
    const t = this.now();
    const provider = this.entropy?.source.id ?? this.audited?.provider;
    this.snapshot = {
      id: opts.matchId ?? generateId(),
      code: opts.code,
      seq: 0,
      createdAt: t,
      updatedAt: t,
      gameId: this.def.id,
      config,
      seats,
      hostSeat,
      ...(hostSeat === null ? { dealer: publicProfile(opts.host) } : {}),
      options: {
        ...(opts.options ?? {}),
        ...(provider
          ? {
              randomness: {
                ...((opts.options?.randomness as object | undefined) ?? {}),
                mode: this.mode,
                provider,
              },
            }
          : {}),
      },
      initialState,
      actions: [],
      state: initialState,
      chat: [],
    };
    if (this.audited || initRecord || this.mode !== 'per-draw') {
      this.snapshot = this.withAudit(this.snapshot, initRecord ?? undefined);
    }
    this.snapshot = this.withTrust(this.snapshot);
  }

  /**
   * `options.trust`: who can see what at this table, derived from the game's declaration, the
   * hosting arrangement and the declared randomness. Public, so every seat reads the same text.
   */
  private withTrust(snapshot: TableSnapshot<S, A, Cfg>): TableSnapshot<S, A, Cfg> {
    const randomness = snapshot.options?.randomness as
      { mode?: RandomnessMode; provider?: string } | undefined;
    const trust = describeTrust(this.def, { hostSeat: snapshot.hostSeat, randomness });
    return { ...snapshot, options: { ...snapshot.options, trust } };
  }

  /**
   * Build a table whose `init` may draw from a just-in-time entropy source (e.g. a game that
   * shuffles an opening deck), or whose randomness mode needs an asynchronous set-up (the first
   * seed of a seeded table). Draws the bytes first, then constructs the server with the
   * resulting state and its attribution.
   */
  static async create<S, A, C, V = S, Cfg = unknown>(
    opts: TableServerOptions<S, A, C, V, Cfg>,
  ): Promise<TableServer<S, A, C, V, Cfg>> {
    const mode = (opts.options?.randomness as { mode?: RandomnessMode } | undefined)?.mode;
    if (mode === 'seeded' && !opts.snapshot) return TableServer.createSeeded(opts);
    if (!opts.entropy || opts.snapshot || opts.initialState !== undefined) {
      return new TableServer(opts);
    }
    const seatCount = Math.min(
      opts.def.maxSeats,
      Math.max(opts.def.minSeats, opts.seats ?? opts.def.minSeats),
    );
    const config = (
      opts.def.normalizeConfig ? opts.def.normalizeConfig(opts.config) : opts.config
    ) as Cfg;
    let needs = false;
    try {
      opts.def.init(config, { rng: probeRng(), seats: seatCount });
    } catch (e) {
      if (!(e instanceof NeedsEntropy)) throw e;
      needs = true;
    }
    if (!needs) return new TableServer(opts);
    if (mode === 'beacon') {
      // Beacon mode: the opening draw is bound to a future round like any other draw. The
      // placeholder server is kept so the draw counter stays continuous.
      const server = new TableServer({ ...opts, skipInit: true });
      const drawn = await server.beaconDraw('init', (rng) =>
        opts.def.init(config, { rng, seats: seatCount }),
      );
      server.snapshot = { ...server.snapshot, initialState: drawn.value, state: drawn.value };
      server.snapshot = server.withAudit(server.snapshot, drawn.record);
      return server;
    }
    const entropy = {
      ...opts.entropy,
      bytes: opts.entropy.bytes ?? DEFAULT_ENTROPY_BYTES,
      fallback: opts.entropy.fallback ?? false,
      purpose: opts.entropy.purpose ?? 'table',
    };
    const drawn = await drawWith(
      entropy,
      { label: 'init', tableId: opts.matchId ?? 'new', now: opts.now ?? Date.now },
      (rng) => opts.def.init(config, { rng, seats: seatCount }),
    );
    return new TableServer({ ...opts, initialState: drawn.value, initRecord: drawn.record });
  }

  /** Seeded mode: commit segment 0 first, then build the initial state from it. */
  private static async createSeeded<S, A, C, V, Cfg>(
    opts: TableServerOptions<S, A, C, V, Cfg>,
  ): Promise<TableServer<S, A, C, V, Cfg>> {
    const matchId = opts.matchId ?? generateId();
    const seatCount = Math.min(
      opts.def.maxSeats,
      Math.max(opts.def.minSeats, opts.seats ?? opts.def.minSeats),
    );
    const config = (
      opts.def.normalizeConfig ? opts.def.normalizeConfig(opts.config) : opts.config
    ) as Cfg;
    // Build with a placeholder state so the server exists to hold the segment, then re-run init.
    const server = new TableServer({ ...opts, matchId, skipInit: true });
    await server.beginSegment(true);
    let initialState = opts.initialState as S;
    let initRecord: EntropyRecord | null = null;
    if (opts.initialState === undefined) {
      const drawn = server.segmentDraw('init', (rng) =>
        opts.def.init(config, { rng, seats: seatCount }),
      );
      initialState = drawn.value;
      initRecord = drawn.record;
    }
    server.snapshot = {
      ...server.snapshot,
      initialState,
      state: initialState,
    };
    server.snapshot = server.withAudit(server.snapshot, initRecord ?? undefined);
    return server;
  }

  /** Refresh the published proofs (and optionally the init record) from the audited rng. */
  private withAudit(
    snapshot: TableSnapshot<S, A, Cfg>,
    init?: EntropyRecord,
  ): TableSnapshot<S, A, Cfg> {
    const provider = this.entropy?.source.id ?? this.audited?.provider;
    if (!provider) return snapshot;
    const previous = snapshot.entropyAudit;
    const entropyAudit: EntropyAudit = {
      batches: this.audited ? this.audited.audit().batches : (previous?.batches ?? []),
      ...(init ? { init } : previous?.init ? { init: previous.init } : {}),
      mode: this.mode,
    };
    if (this.mode === 'seeded') entropyAudit.segments = this.publicSegments(previous?.segments);
    if (this.mode === 'beacon') {
      entropyAudit.beacon = {
        chainHash: (this.entropy!.source as BeaconSource).chainHash,
        pending: previous?.beacon?.pending ?? [],
      };
    }
    const options = snapshot.options.randomness
      ? snapshot.options
      : { ...snapshot.options, randomness: { mode: this.mode, provider } };
    return { ...snapshot, options, entropyAudit };
  }

  getSnapshot(): TableSnapshot<S, A, Cfg> {
    return this.snapshot;
  }

  get seatCount(): number {
    return this.snapshot.seats.length;
  }

  /** True when this table is hosted by a non-playing dealer. */
  get dealerMode(): boolean {
    return this.snapshot.hostSeat === null;
  }

  /**
   * Invitation-only tables (`options.invitationOnly`) admit nobody to an unreserved seat: a
   * leaked room code is useless unless the host reserved a seat for that player first.
   */
  get invitationOnly(): boolean {
    return this.snapshot.options?.invitationOnly === true;
  }

  /**
   * Hold `seat` for one player: only a hello from that profile id with that key may take it,
   * from any device. Holding a seat already bound to another player, or already reserved for
   * someone else, is refused. Reserving for the player who already holds the seat is a no-op.
   */
  reserveSeat(seat: number, reservation: SeatReservation): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seatCount)
      throw new RangeError(`seat ${seat} is out of range for ${this.seatCount} seats`);
    if (!reservation.publicKey) throw new Error("a reservation needs the player's public key");
    const occupant = this.snapshot.seats[seat];
    if (occupant) {
      if (occupant.id === reservation.profileId) return;
      throw new Error(`seat ${seat} is taken by another player`);
    }
    const current = this.reservation(seat);
    if (current && current.profileId !== reservation.profileId)
      throw new Error(`seat ${seat} is reserved for another player`);
    this.reservedSeats.set(seat, { ...reservation });
  }

  releaseSeat(seat: number): void {
    this.reservedSeats.delete(seat);
  }

  /** Live (unexpired) reservations by seat. */
  reservations(): Record<number, SeatReservation> {
    const out: Record<number, SeatReservation> = {};
    for (const seat of [...this.reservedSeats.keys()]) {
      const r = this.reservation(seat);
      if (r) out[seat] = { ...r };
    }
    return out;
  }

  private reservation(seat: number): SeatReservation | undefined {
    const r = this.reservedSeats.get(seat);
    if (!r) return undefined;
    if (r.expiresAt !== undefined && r.expiresAt <= this.now()) {
      this.reservedSeats.delete(seat);
      return undefined;
    }
    return r;
  }

  /** The seat currently held (by reservation) for this profile, if any. */
  private reservedFor(profileId: string): number | undefined {
    for (const seat of [...this.reservedSeats.keys()]) {
      const r = this.reservation(seat);
      if (r && r.profileId === profileId) return seat;
    }
    return undefined;
  }

  onChange(listener: (snapshot: TableSnapshot<S, A, Cfg>, action?: A) => void): Unsubscribe {
    return this.changes.on(({ snapshot, action }) => listener(snapshot, action));
  }

  /** Seats with at least one live connection. */
  connectedSeats(): number[] {
    return Array.from(this.seats.keys()).sort((a, b) => a - b);
  }

  /** Number of devices currently connected for a seat. */
  connectionCount(seat: number): number {
    return this.seats.get(seat)?.length ?? 0;
  }

  /** Dealer mode: whether at least one dealer device is connected. */
  dealerConnected(): boolean {
    return this.dealers.length > 0;
  }

  /**
   * Unattended play is on for every dealer-hosted table (unless `options.autopilot` is false)
   * and for player-hosted tables that opted in with `options.autopilot: true`.
   */
  get autopilotEnabled(): boolean {
    const opt = this.snapshot.options?.autopilot;
    if (opt === true) return true;
    if (opt === false) return false;
    return this.dealerMode;
  }

  /** What the autopilot has scheduled, if anything. */
  autopilotStatus(): { enabled: boolean; pending?: AutopilotPending } {
    return {
      enabled: this.autopilotEnabled && !!this.def.autopilot,
      ...(this.autopilotPending ? { pending: { ...this.autopilotPending } } : {}),
    };
  }

  /** Readiness by seat (table flow, see `TableSnapshot.ready`). */
  readiness(): boolean[] {
    const out = new Array<boolean>(this.seatCount).fill(false);
    (this.snapshot.ready ?? []).forEach((r, i) => {
      if (i < out.length) out[i] = !!r;
    });
    return out;
  }

  /** Autopilot decisions as they are scheduled, applied, cancelled or refused. */
  onAutopilot(listener: (event: AutopilotEvent) => void): Unsubscribe {
    return this.autopilotEvents.on(listener);
  }

  /** Accept an inbound connection. The first message must be a `hello`. */
  accept(transport: Transport): void {
    if (this.closed) {
      transport.close();
      return;
    }
    const conn: Connection = { transport, seat: null, role: null, closed: false, unsubscribe: [] };
    this.connections.add(conn);
    conn.unsubscribe.push(transport.onMessage((raw) => this.handle(conn, raw)));
    conn.unsubscribe.push(
      transport.onStatus((status) => {
        if (status === 'closed') this.dropConnection(conn);
      }),
    );
    if (transport.status === 'closed') this.dropConnection(conn);
  }

  /** Create an in-memory connection for the host's own client and return the client's end. */
  connectLocal(): Transport {
    const [serverEnd, clientEnd] = createMemoryPair('local');
    this.accept(serverEnd);
    return clientEnd;
  }

  close(): void {
    if (this.closed) return;
    this.cancelAutopilot(false);
    // A seeded segment still open is revealed so the last hand stays verifiable.
    if (this.mode === 'seeded' && this.revealActive()) {
      this.snapshot = this.withAudit(this.snapshot);
      this.broadcastState();
      this.changes.emit({ snapshot: this.snapshot });
    }
    this.closed = true;
    for (const conn of Array.from(this.connections)) this.closeConnection(conn);
    this.changes.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------------------------

  private send(conn: Connection, message: TableServerMessage<S | V, A>): void {
    if (conn.closed || conn.transport.status === 'closed') return;
    try {
      conn.transport.send(message);
    } catch {
      /* transport died between the status check and the send; the status handler cleans up */
    }
  }

  private sendToSeat(seat: number, message: TableServerMessage<S | V, A>): void {
    for (const conn of this.seats.get(seat) ?? []) this.send(conn, message);
  }

  private sendToDealers(message: TableServerMessage<S | V, A>): void {
    for (const conn of this.dealers) this.send(conn, message);
  }

  /** Every admitted connection: seats and dealer devices. */
  private broadcast(message: TableServerMessage<S | V, A>, except?: Connection): void {
    for (const list of this.seats.values()) {
      for (const conn of list) if (conn !== except) this.send(conn, message);
    }
    for (const conn of this.dealers) if (conn !== except) this.send(conn, message);
  }

  /** Send the current snapshot (full or a seat's view) to every device, optionally with the action. */
  private broadcastState(action?: A, by?: number, except?: Connection): void {
    for (const [seat, list] of this.seats) {
      const message = this.stateMessage(seat, action, by);
      for (const conn of list) if (conn !== except) this.send(conn, message);
    }
    if (this.dealers.length > 0) {
      const message = this.stateMessage(DEALER_SEAT, action, by);
      for (const conn of this.dealers) if (conn !== except) this.send(conn, message);
    }
  }

  private stateMessage(seat: number, action?: A, by?: number): TableServerMessage<S | V, A> {
    const snapshot = this.snapshotFor(seat);
    const message: TableServerMessage<S | V, A> = { type: 'state', snapshot };
    if (action !== undefined) {
      const visible = this.actionFor(action, seat);
      if (visible !== null) message.action = visible;
    }
    if (by !== undefined) message.by = by;
    return message;
  }

  /** Whether a seat (or the dealer, `DEALER_SEAT`) holds the authoritative copy. */
  private holdsFullState(seat: number | null): boolean {
    if (seat === DEALER_SEAT) return this.dealerMode;
    return seat !== null && seat === this.snapshot.hostSeat;
  }

  /** The host's devices hold the authoritative copy; every other seat gets its view. */
  private snapshotFor(seat: number | null): TableSnapshot<S | V, A, Cfg> {
    if (this.holdsFullState(seat)) return this.snapshot;
    return viewSnapshot(this.def, this.snapshot, seat === DEALER_SEAT ? null : seat);
  }

  private actionFor(action: A, seat: number | null): A | null {
    if (!this.def.hiddenInformation || this.holdsFullState(seat)) return action;
    return this.def.viewAction
      ? this.def.viewAction(action, seat === DEALER_SEAT ? null : seat)
      : null;
  }

  private closeConnection(conn: Connection): void {
    if (conn.closed) return;
    this.detach(conn, false);
    try {
      conn.transport.close();
    } catch {
      /* ignore */
    }
  }

  private dropConnection(conn: Connection): void {
    if (conn.closed) return;
    this.detach(conn, true);
  }

  private detach(conn: Connection, announce: boolean): void {
    conn.closed = true;
    if (conn.pending) {
      clearTimeout(conn.pending.timer);
      conn.pending = undefined;
    }
    for (const u of conn.unsubscribe) u();
    conn.unsubscribe = [];
    this.connections.delete(conn);
    if (conn.role === 'dealer') {
      this.dealers = this.dealers.filter((c) => c !== conn);
      if (this.dealers.length === 0 && announce && !this.closed && this.snapshot.dealer) {
        this.broadcast({ type: 'dealer', profile: this.snapshot.dealer, connected: false });
      }
      this.evaluateAutopilot();
      return;
    }
    const seat = conn.seat;
    if (seat === null) return;
    const list = this.seats.get(seat);
    if (!list) return;
    const remaining = list.filter((c) => c !== conn);
    if (remaining.length > 0) {
      this.seats.set(seat, remaining);
      return; // another device of this player is still here: presence is unchanged
    }
    this.seats.delete(seat);
    if (announce && !this.closed) this.broadcast({ type: 'presence', seat, connected: false });
    this.evaluateAutopilot();
  }

  private reject(conn: Connection, reason: RejectReason, message: string): void {
    this.send(conn, { type: 'rejected', reason, message });
    this.closeConnection(conn);
  }

  // ---------------------------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------------------------

  private handle(conn: Connection, raw: unknown): void {
    if (conn.closed || this.closed) return;
    const result = validateTableMessage(raw);
    if (!result.ok) {
      if (conn.role === null) this.reject(conn, 'bad-hello', `expected hello: ${result.reason}`);
      else this.send(conn, { type: 'error', code: 'bad-message', message: result.reason });
      return;
    }
    const msg = result.message;
    if (conn.role === null) {
      if (conn.pending) {
        if (msg.type !== 'auth') {
          this.reject(conn, 'unauthorized', 'answer the seat challenge first');
          return;
        }
        void this.handleAuth(conn, msg);
        return;
      }
      if (msg.type !== 'hello') {
        this.reject(conn, 'bad-hello', 'first message must be hello');
        return;
      }
      this.handleHello(conn, msg);
      return;
    }
    if (msg.type === 'hello' || msg.type === 'auth') {
      this.send(conn, { type: 'error', code: 'already-joined', message: 'hello already received' });
      return;
    }
    if (conn.role === 'dealer') this.handleDealer(conn, msg);
    else this.handleSeated(conn, conn.seat!, msg);
  }

  private handleHello(conn: Connection, msg: Extract<TableClientMessage, { type: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.reject(
        conn,
        'protocol',
        `protocol ${msg.protocol} not supported (server is ${PROTOCOL_VERSION})`,
      );
      return;
    }
    if (msg.snapshot && msg.snapshot.id !== this.snapshot.id) {
      this.reject(conn, 'wrong-match', 'that snapshot belongs to a different match');
      return;
    }
    const profile = msg.profile;
    const resolved = this.resolve(profile);
    if (resolved === null) {
      const { reason, message } = this.refusal(profile);
      this.reject(conn, reason, message);
      return;
    }
    const { role, seat } = resolved;
    const held = role === 'seat' ? this.reservation(seat) : undefined;
    const bound =
      role === 'dealer'
        ? this.snapshot.dealer?.publicKey
        : (this.snapshot.seats[seat]?.publicKey ?? held?.publicKey);
    if (bound) {
      // The seat (or the dealer role) is bound or reserved to a key: only its holder may take
      // it, from any device.
      if (profile.publicKey !== bound) {
        this.reject(
          conn,
          'unauthorized',
          held && !this.snapshot.seats[seat]
            ? 'that seat is reserved'
            : 'that seat belongs to a different key',
        );
        return;
      }
      this.challenge(conn, role, seat, profile, bound, msg.snapshot);
      return;
    }
    if (profile.publicKey) {
      // Unbound seat (free, or a legacy record): bind this key on a successful answer.
      this.challenge(conn, role, seat, profile, profile.publicKey, msg.snapshot);
      return;
    }
    // Legacy: an unkeyed client taking an unkeyed seat needs no proof.
    this.admit(conn, role, seat, profile, msg.snapshot);
  }

  private challenge(
    conn: Connection,
    role: Role,
    seat: number,
    profile: PlayerProfile,
    publicKey: string,
    snapshot: TableSnapshot | undefined,
  ): void {
    const challenge = beginChallenge({
      publicKey,
      timeoutMs: CHALLENGE_TIMEOUT_MS,
      onTimeout: () => {
        if (!conn.closed && conn.role === null) {
          this.reject(conn, 'unauthorized', 'no answer to the seat challenge');
        }
      },
    });
    conn.pending = {
      role,
      seat,
      profile,
      publicKey,
      nonce: challenge.nonce,
      snapshot,
      timer: challenge.timer,
      verifying: false,
      challenge,
    };
    this.send(conn, { type: 'challenge', nonce: challenge.nonce, matchId: this.snapshot.id });
  }

  private async handleAuth(
    conn: Connection,
    msg: Extract<TableClientMessage, { type: 'auth' }>,
  ): Promise<void> {
    const pending = conn.pending;
    if (!pending || pending.verifying) return;
    pending.verifying = true;
    const ok = await verifyChallengeAnswer(
      pending.challenge,
      challengeBytes({
        matchId: this.snapshot.id,
        profileId: pending.profile.id,
        nonce: pending.nonce,
      }),
      msg.signature,
    );
    if (conn.closed || this.closed) return;
    cancelChallenge(pending.challenge);
    conn.pending = undefined;
    if (!ok) {
      this.reject(conn, 'unauthorized', 'the seat challenge was not signed with the right key');
      return;
    }
    // The roster may have moved on while we waited: re-resolve. A different free seat is fine
    // (someone else finished first); a lost role or a full table is not.
    const resolved = this.resolve(pending.profile);
    if (resolved === null || resolved.role !== pending.role) {
      if (resolved === null) {
        const { reason, message } = this.refusal(pending.profile);
        this.reject(conn, reason, message);
      } else {
        this.reject(conn, 'unauthorized', 'the seat changed while authenticating');
      }
      return;
    }
    const seat = resolved.seat;
    const bound =
      pending.role === 'dealer'
        ? this.snapshot.dealer?.publicKey
        : (this.snapshot.seats[seat]?.publicKey ?? this.reservation(seat)?.publicKey);
    if (bound && bound !== pending.publicKey) {
      this.reject(conn, 'unauthorized', 'that seat belongs to a different key');
      return;
    }
    const profile: PlayerProfile = { ...pending.profile, publicKey: pending.publicKey };
    this.admit(conn, pending.role, seat, profile, pending.snapshot);
  }

  /** Admit an authenticated (or legacy unkeyed) connection as a seat or as the dealer. */
  private admit(
    conn: Connection,
    role: Role,
    seat: number,
    profile: PlayerProfile,
    offered: TableSnapshot | undefined,
  ): void {
    if (offered) this.maybeAdopt(conn, offered as TableSnapshot<S, A, Cfg>);
    if (role === 'dealer') {
      this.admitDealer(conn, profile);
      return;
    }

    // The seat is taken by the player it was held for: the reservation has done its job.
    this.reservedSeats.delete(seat);

    // Record the freshest profile (name/avatar may have changed, a key may be bound) and tell
    // the other seats.
    const known = this.snapshot.seats[seat] ?? null;
    const rosterChanged =
      !known ||
      known.id !== profile.id ||
      known.name !== profile.name ||
      known.avatar !== profile.avatar ||
      known.publicKey !== profile.publicKey;
    if (rosterChanged) {
      // A bound key is never replaced here (handleHello/handleAuth already enforced it).
      const stored: PlayerProfile = { ...profile };
      if (known?.publicKey) stored.publicKey = known.publicKey;
      const seats = this.snapshot.seats.slice();
      seats[seat] = stored;
      this.snapshot = { ...this.snapshot, seats };
      this.broadcastState(undefined, undefined, conn);
    }

    // Join this seat's set of devices; beyond the cap the oldest device is dropped.
    const list = this.seats.get(seat) ?? [];
    const first = list.length === 0;
    conn.seat = seat;
    conn.role = 'seat';
    this.seats.set(seat, [...list, conn]);
    while ((this.seats.get(seat)?.length ?? 0) > MAX_CONNECTIONS_PER_SEAT) {
      const oldest = this.seats.get(seat)![0]!;
      this.closeConnection(oldest); // the seat stays occupied, so no presence change
    }

    this.send(conn, { type: 'welcome', seat, snapshot: this.snapshotFor(seat) });
    for (let other = 0; other < this.seatCount; other++) {
      if (other === seat) continue;
      this.send(conn, { type: 'presence', seat: other, connected: this.seats.has(other) });
      // Other seats only learn about presence when this seat goes from absent to present.
      if (first) this.sendToSeat(other, { type: 'presence', seat, connected: true });
    }
    if (this.dealerMode && this.snapshot.dealer) {
      this.send(conn, {
        type: 'dealer',
        profile: this.snapshot.dealer,
        connected: this.dealers.length > 0,
      });
      if (first) this.sendToDealers({ type: 'presence', seat, connected: true });
    }
    this.send(conn, { type: 'ready', ready: this.readiness() });
    if (this.autopilotPending)
      this.send(conn, { type: 'autopilot', pending: this.autopilotPending });
    this.changes.emit({ snapshot: this.snapshot });
    this.evaluateAutopilot();
  }

  private admitDealer(conn: Connection, profile: PlayerProfile): void {
    const known = this.snapshot.dealer;
    const stored: PlayerProfile = { ...publicProfile(profile) };
    if (known?.publicKey) stored.publicKey = known.publicKey;
    const changed =
      !known ||
      known.name !== stored.name ||
      known.avatar !== stored.avatar ||
      known.publicKey !== stored.publicKey;
    if (changed) {
      this.snapshot = { ...this.snapshot, dealer: stored };
      this.broadcastState(undefined, undefined, conn);
    }
    const first = this.dealers.length === 0;
    conn.seat = DEALER_SEAT;
    conn.role = 'dealer';
    this.dealers = [...this.dealers, conn];
    while (this.dealers.length > MAX_CONNECTIONS_PER_SEAT) this.closeConnection(this.dealers[0]!);
    this.send(conn, { type: 'welcome', seat: null, snapshot: this.snapshot });
    for (let other = 0; other < this.seatCount; other++) {
      this.send(conn, { type: 'presence', seat: other, connected: this.seats.has(other) });
    }
    this.send(conn, { type: 'dealer', profile: stored, connected: true });
    if (first) {
      for (let s = 0; s < this.seatCount; s++) {
        this.sendToSeat(s, { type: 'dealer', profile: stored, connected: true });
      }
    }
    this.send(conn, { type: 'ready', ready: this.readiness() });
    if (this.autopilotPending)
      this.send(conn, { type: 'autopilot', pending: this.autopilotPending });
    this.changes.emit({ snapshot: this.snapshot });
    this.evaluateAutopilot();
  }

  /**
   * Who a hello belongs to: in dealer mode the dealer's profile id is the dealer (from any
   * device); a known profile id always gets its own seat (a reconnect or another device); a new
   * profile id gets the first free seat; otherwise the table is full.
   */
  private resolve(profile: PlayerProfile): { role: Role; seat: number } | null {
    if (this.dealerMode && this.snapshot.dealer?.id === profile.id) {
      return { role: 'dealer', seat: DEALER_SEAT };
    }
    const { seats } = this.snapshot;
    const own = seats.findIndex((p) => p?.id === profile.id);
    if (own >= 0) return { role: 'seat', seat: own };
    // Seats being claimed by another player's pending challenge count as taken, so that
    // simultaneous hellos do not race for the same seat; a player's own pending claim is kept.
    const reserved = new Map<number, string>();
    for (const c of this.connections) {
      if (c.pending && c.pending.role === 'seat')
        reserved.set(c.pending.seat, c.pending.profile.id);
    }
    const held = this.reservedFor(profile.id);
    if (held !== undefined && seats[held] === null) return { role: 'seat', seat: held };
    if (this.invitationOnly) return null; // unreserved seats are never handed out
    const mine = [...reserved].find(([, id]) => id === profile.id)?.[0];
    if (mine !== undefined && seats[mine] === null) return { role: 'seat', seat: mine };
    const free = seats.findIndex(
      (p, i) =>
        p === null &&
        (!reserved.has(i) || reserved.get(i) === profile.id) &&
        this.reservation(i) === undefined,
    );
    return free >= 0 ? { role: 'seat', seat: free } : null;
  }

  /** Why `resolve` found no seat for this profile. */
  private refusal(profile: PlayerProfile): { reason: RejectReason; message: string } {
    if (this.invitationOnly && this.reservedFor(profile.id) === undefined) {
      return { reason: 'unauthorized', message: 'sit through the club first' };
    }
    const free = this.snapshot.seats.some((p, i) => p === null && this.reservation(i));
    if (free) return { reason: 'unauthorized', message: 'that seat is reserved' };
    return { reason: 'full', message: 'every seat is taken' };
  }

  /**
   * Adopt the peer's snapshot if it is strictly newer and its action log replays cleanly.
   * Hidden-information games never adopt: a guest only ever holds a view.
   */
  private maybeAdopt(conn: Connection, incoming: TableSnapshot<S, A, Cfg>): void {
    if (incoming.seq <= this.snapshot.seq) return;
    if (this.def.hiddenInformation || incoming.view) {
      this.send(conn, {
        type: 'error',
        code: 'host-only-resume',
        message: 'only the host copy of this game can be resumed',
      });
      return;
    }
    let verified: TableSnapshot<S, A, Cfg>;
    try {
      verified = verifySnapshot(this.def, incoming);
    } catch (e) {
      this.send(conn, {
        type: 'error',
        code: 'bad-snapshot',
        message: `your snapshot could not be replayed: ${(e as Error).message}`,
      });
      return;
    }
    // Our roster wins where we have one: in particular a key bound here can never be replaced
    // by a peer's copy of the match. Table identity, options and the randomness audit are ours too.
    const seats = this.snapshot.seats.map((mine, i) => mine ?? verified.seats[i] ?? null);
    this.snapshot = {
      ...verified,
      code: this.snapshot.code,
      hostSeat: this.snapshot.hostSeat,
      ...(this.snapshot.dealer ? { dealer: this.snapshot.dealer } : {}),
      options: this.snapshot.options,
      seats,
      updatedAt: this.now(),
    };
    this.broadcastState(undefined, undefined, conn);
    this.changes.emit({ snapshot: this.snapshot });
  }

  /** Dealer devices may chat, ping, leave, and send the definition's dealer commands. */
  private handleDealer(conn: Connection, msg: TableClientMessage): void {
    switch (msg.type) {
      case 'command': {
        const command = this.def.validateCommand(msg.command);
        if (command === null) {
          this.error(conn, 'bad-message', 'invalid command');
          return;
        }
        const type = (command as { type?: unknown } | null)?.type;
        if (typeof type !== 'string' || !(this.def.dealerCommands ?? []).includes(type)) {
          this.error(conn, 'not-seated', 'the dealer plays no seat');
          return;
        }
        this.apply(conn, DEALER_SEAT, command);
        return;
      }
      case 'preview':
      case 'ready':
        this.error(conn, 'not-seated', 'the dealer plays no seat');
        return;
      case 'chat':
      case 'ping':
      case 'bye':
        this.handleSeated(conn, DEALER_SEAT, msg);
        return;
      default:
        return;
    }
  }

  private handleSeated(conn: Connection, seat: number, msg: TableClientMessage): void {
    switch (msg.type) {
      case 'hello':
      case 'auth':
        return; // handled above
      case 'command': {
        const command = this.def.validateCommand(msg.command);
        if (command === null) {
          this.error(conn, 'bad-message', 'invalid command');
          return;
        }
        this.apply(conn, seat, command);
        return;
      }
      case 'preview': {
        const payload = this.def.validatePreview
          ? this.def.validatePreview(msg.payload)
          : msg.payload;
        if (payload === null) {
          this.error(conn, 'bad-message', 'invalid preview');
          return;
        }
        for (let other = 0; other < this.seatCount; other++) {
          if (other !== seat) this.sendToSeat(other, { type: 'preview', seat, payload });
        }
        this.sendToDealers({ type: 'preview', seat, payload });
        return;
      }
      case 'chat': {
        const message = { seat, text: msg.text, at: this.now() };
        this.snapshot = {
          ...this.snapshot,
          chat: [...this.snapshot.chat, message].slice(-MAX_CHAT_HISTORY),
        };
        this.broadcast({ type: 'chat', message });
        this.changes.emit({ snapshot: this.snapshot });
        return;
      }
      case 'ping':
        this.send(conn, { type: 'pong', t: msg.t });
        return;
      case 'ready': {
        if (seat < 0) return;
        const ready = this.readiness();
        if (ready[seat] === msg.ready) return;
        ready[seat] = msg.ready;
        this.setReadiness(ready);
        this.evaluateAutopilot();
        return;
      }
      case 'bye':
        // Announce absence only if this was the player's last device (detach decides).
        this.detach(conn, true);
        try {
          conn.transport.close();
        } catch {
          /* ignore */
        }
        return;
    }
  }

  private error(conn: Connection, code: string, message: string): void {
    if (conn === this.systemConn) {
      this.autopilotEvents.emit({
        kind: 'refused',
        reason: this.applyingReason ?? '',
        code,
        message,
      });
      return;
    }
    this.send(conn, { type: 'error', code, message });
  }

  // ---------------------------------------------------------------------------------------------
  // Commands and randomness
  // ---------------------------------------------------------------------------------------------

  /**
   * Commands are applied in arrival order. A command that draws randomness from a just-in-time
   * source (or that begins a seeded segment, or is bound to a beacon round) is asynchronous;
   * everything that arrives while it is in flight queues behind it. Commands that draw nothing
   * apply immediately when nothing is queued.
   */
  private apply(conn: Connection, seat: number, command: C): void {
    if (this.busy) {
      this.queue.push({ conn, seat, command });
      return;
    }
    if (this.mode === 'seeded') {
      const boundary = this.def.segmentBoundary?.(this.snapshot.state, command) ?? false;
      const active = this.activeSegment();
      const draws = this.needsEntropy(seat, command);
      if (boundary || (draws && !active)) {
        this.busy = true;
        void this.applySeededSegmentStart(conn, seat, command).finally(() => this.drain());
        return;
      }
      if (draws) {
        this.applyWith(conn, seat, command, null);
        return;
      }
      this.applyWith(conn, seat, command, this.rng);
      return;
    }
    if (this.mode === 'beacon' && this.needsEntropy(seat, command)) {
      this.busy = true;
      void this.applyBeacon(conn, seat, command).finally(() => this.drain());
      return;
    }
    if (this.mode === 'per-draw' && this.entropy && this.needsEntropy(seat, command)) {
      this.busy = true;
      void this.applyJustInTime(conn, seat, command).finally(() => this.drain());
      return;
    }
    this.applyWith(conn, seat, command, this.rng);
  }

  /** Apply queued commands in order until the queue is empty or another draw goes in flight. */
  private drain(): void {
    this.busy = false;
    while (!this.busy && !this.closed && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.apply(next.conn, next.seat, next.command);
    }
    if (!this.busy) this.evaluateAutopilot();
  }

  /** Run the command against a probe rng: true when it tries to draw. Rule errors are left to the real run. */
  private needsEntropy(seat: number, command: C): boolean {
    try {
      this.def.command(this.snapshot.state, seat, command, {
        rng: probeRng(),
        now: this.now(),
        seats: this.seatCount,
      });
      return false;
    } catch (e) {
      return e instanceof NeedsEntropy;
    }
  }

  /**
   * Synchronous path: a plain or pooled (`AuditedRng`) rng, or — when `rng` is null — the
   * active seeded segment.
   */
  private applyWith(conn: Connection, seat: number, command: C, rng: Rng | null): void {
    let entropy: EntropyRecord | null = null;
    let produced: A | A[];
    try {
      const ctx = { now: this.now(), seats: this.seatCount };
      const run = (r: Rng) =>
        this.def.command(this.snapshot.state, seat, command, { rng: r, ...ctx });
      if (rng === null) {
        const drawn = this.segmentDraw(commandLabel(command), run);
        produced = drawn.value;
        entropy = drawn.record;
      } else if (this.audited && rng === this.audited) {
        const drawn = this.audited.withDraw(commandLabel(command), run);
        produced = drawn.value;
        entropy = drawn.record;
      } else {
        produced = run(rng);
      }
    } catch (e) {
      this.reportCommandError(conn, e);
      return;
    }
    this.commit(conn, seat, produced, entropy);
  }

  /** Just-in-time path: fetch bytes, run, re-run with more bytes if the command wanted more. */
  private async applyJustInTime(conn: Connection, seat: number, command: C): Promise<void> {
    const entropy = this.entropy!;
    const label = commandLabel(command);
    const state = this.snapshot.state;
    const ctx = { now: this.now(), seats: this.seatCount };
    let drawn: { value: A | A[]; record: EntropyRecord };
    try {
      drawn = await drawWith(entropy, { label, tableId: this.snapshot.id, now: this.now }, (rng) =>
        this.def.command(state, seat, command, { rng, ...ctx }),
      );
    } catch (e) {
      if (this.closed) return;
      if (e instanceof EntropyUnavailable) {
        this.error(conn, 'entropy-unavailable', e.message);
        return;
      }
      this.reportCommandError(conn, e);
      return;
    }
    if (this.closed) return;
    // The state cannot have moved: nothing else applies while a draw is in flight.
    this.commit(conn, seat, drawn.value, drawn.record);
  }

  // ---- seeded mode ---------------------------------------------------------------------------

  private activeSegment(): PrivateSegment | null {
    const last = this.segments[this.segments.length - 1];
    return last && !last.revealed ? last : null;
  }

  /** Public view of the segments (seeds only once revealed). */
  private publicSegments(previous?: SeedSegment[]): SeedSegment[] {
    const byIndex = new Map((previous ?? []).map((s) => [s.index, s]));
    return this.segments.map((s) => {
      const pub = byIndex.get(s.index);
      if (!pub) throw new Error(`segment ${s.index} has no public record`);
      return pub;
    });
  }

  /** Rebuild the private segment list from a resumed snapshot (revealed seeds are public). */
  private restoreSegments(): void {
    for (const s of this.snapshot.entropyAudit?.segments ?? []) {
      this.segments.push({
        index: s.index,
        seed: s.seed ? hexToBytesLocal(s.seed) : new Uint8Array(0),
        source: s.source ?? { proof: { kind: 'none' }, bytes: '', fetchedAt: 0 },
        draws: 0,
        revealed: true, // an unrevealed seed is lost with the process; the next draw opens a new segment
      });
    }
    const audit = this.snapshot.entropyAudit;
    if (audit?.segments?.some((s) => s.seed === undefined)) {
      // Close any segment whose seed did not survive: it can never be verified, say so.
      const segments = audit.segments.map((s) =>
        s.seed === undefined ? { ...s, to: s.to ?? this.snapshot.actions.length - 1 } : s,
      );
      this.snapshot = { ...this.snapshot, entropyAudit: { ...audit, segments } };
    }
  }

  private restoreBeacon(): void {
    const meta = this.snapshot.actionMeta ?? {};
    for (const m of Object.values(meta)) {
      const c = m.entropy?.beacon?.counter;
      if (c !== undefined && c >= this.beaconCounter) this.beaconCounter = c + 1;
    }
    // Pending bindings of a previous process can never resolve: drop them.
    const audit = this.snapshot.entropyAudit;
    if (audit?.beacon?.pending.length) {
      this.snapshot = {
        ...this.snapshot,
        entropyAudit: { ...audit, beacon: { ...audit.beacon, pending: [] } },
      };
    }
  }

  /**
   * Begin a seeded segment: fetch a fresh seed from the source (falling back to this device
   * when allowed), publish its commitment, keep the seed private. Reveals the previous segment
   * first if it is still open.
   */
  private async beginSegment(initial = false): Promise<void> {
    const entropy = this.entropy!;
    const index = this.segments.length;
    let draw: EntropyDraw;
    try {
      draw = await entropy.source.draw(SEED_BYTES, {
        label: 'seed',
        tableId: this.snapshot.id,
        purpose: entropy.purpose,
      });
    } catch (e) {
      if (!entropy.fallback) {
        throw new EntropyUnavailable(
          `randomness source ${entropy.source.id} failed: ${(e as Error)?.message ?? String(e)}`,
        );
      }
      const bytes = new Uint8Array(SEED_BYTES);
      globalThis.crypto.getRandomValues(bytes);
      draw = { bytes, proof: { kind: 'none' }, fetchedAt: this.now() };
    }
    if (draw.bytes.length < SEED_BYTES) {
      throw new EntropyUnavailable(`randomness source ${entropy.source.id} returned a short seed`);
    }
    const seed = draw.bytes.slice(0, SEED_BYTES);
    if (this.closed) return;
    this.revealActive();
    this.segments.push({ index, seed, source: sourceProof(draw), draws: 0, revealed: false });
    const segment: SeedSegment = {
      index,
      commitment: commitmentFor(seed, this.snapshot.id, index),
      from: this.snapshot.actions.length,
      committedAt: this.now(),
    };
    const audit = this.snapshot.entropyAudit ?? { batches: [] };
    this.snapshot = {
      ...this.snapshot,
      updatedAt: this.now(),
      entropyAudit: { ...audit, mode: 'seeded', segments: [...(audit.segments ?? []), segment] },
    };
    if (!initial) {
      // Everyone learns the commitment before any draw of the segment.
      this.broadcastState();
      this.changes.emit({ snapshot: this.snapshot });
    }
  }

  /** Reveal the open segment (seed + source proof). Returns true when something was revealed. */
  private revealActive(): boolean {
    const active = this.activeSegment();
    if (!active) return false;
    active.revealed = true;
    const audit = this.snapshot.entropyAudit;
    if (!audit?.segments) return false;
    const segments = audit.segments.map((s) =>
      s.index === active.index
        ? {
            ...s,
            to: Math.max(s.from, this.snapshot.actions.length - 1),
            seed: bytesToHex(active.seed),
            source: active.source,
            revealedAt: this.now(),
          }
        : s,
    );
    this.snapshot = {
      ...this.snapshot,
      updatedAt: this.now(),
      entropyAudit: { ...audit, segments },
    };
    return true;
  }

  /** Run `fn` over bytes derived from the active segment's seed; synchronous. */
  private segmentDraw<T>(
    label: string,
    fn: (rng: Rng) => T,
  ): { value: T; record: EntropyRecord | null } {
    const active = this.activeSegment();
    if (!active) throw new EntropyUnavailable('no open seeded segment');
    const drawIndex = active.draws;
    const bytes = segmentDrawBytes(active.seed, this.snapshot.id, active.index, drawIndex);
    const rng = createByteRng(bytes);
    const value = fn(rng);
    if (rng.used() === 0) return { value, record: null };
    active.draws += 1;
    return {
      value,
      record: {
        label,
        provider: `seeded:${this.entropy!.source.id}`,
        bytes: bytesToHex(bytes.subarray(0, rng.used())),
        bytesUsed: rng.used(),
        draws: rng.draws(),
        sources: [],
        fallback: false,
        segment: active.index,
        drawIndex,
      },
    };
  }

  /** Seeded mode: a command that begins a segment (or the first draw with none open). */
  private async applySeededSegmentStart(conn: Connection, seat: number, command: C): Promise<void> {
    try {
      await this.beginSegment();
    } catch (e) {
      if (this.closed) return;
      this.error(
        conn,
        'entropy-unavailable',
        e instanceof Error ? e.message : 'could not obtain a seed',
      );
      return;
    }
    if (this.closed) return;
    this.applyWith(conn, seat, command, this.needsEntropy(seat, command) ? null : this.rng);
  }

  // ---- beacon mode ---------------------------------------------------------------------------

  /**
   * Bind a draw to the next round *after now*, publish the binding, wait for the round, then
   * run `fn` over bytes expanded from it. The round is chosen before its value exists anywhere.
   */
  private async beaconDraw<T>(
    label: string,
    fn: (rng: Rng) => T,
  ): Promise<{ value: T; record: EntropyRecord }> {
    const entropy = this.entropy!;
    const source = entropy.source as BeaconSource;
    const schedule = await source.schedule();
    const round = source.roundAt(this.now(), schedule) + 1;
    const counter = this.beaconCounter++;
    const binding: BeaconBinding = {
      counter,
      chainHash: source.chainHash,
      round,
      committedAt: this.now(),
    };
    this.setPendingBeacon(binding, true);
    const context = beaconContext(this.snapshot.id, counter);
    let budget = entropy.bytes;
    const draws: EntropyDraw[] = [];
    try {
      for (let attempt = 0; attempt < MAX_ENTROPY_ROUNDS; attempt++) {
        const draw = await source.drawRound(round, budget, {
          label,
          tableId: this.snapshot.id,
          purpose: entropy.purpose,
          context,
          timeoutMs: entropy.beaconTimeoutMs,
        });
        draws.push(draw);
        const rng = createByteRng(draw.bytes);
        try {
          const value = fn(rng);
          this.setPendingBeacon(binding, false);
          return {
            value,
            record: {
              label,
              provider: source.id,
              bytes: bytesToHex(draw.bytes.subarray(0, rng.used())),
              bytesUsed: rng.used(),
              draws: rng.draws(),
              sources: [sourceProof(draw)],
              fallback: false,
              beacon: binding,
            },
          };
        } catch (e) {
          if (!(e instanceof EntropyExhausted)) throw e;
          budget *= 2; // the same round expands to any length deterministically
        }
      }
      throw new EntropyUnavailable(
        `"${label}" needed more randomness than the beacon could expand`,
      );
    } catch (e) {
      this.setPendingBeacon(binding, false);
      if (e instanceof EntropyUnavailable) throw e;
      if (isCodedError(e)) throw e;
      throw new EntropyUnavailable(
        `beacon round ${round} unavailable: ${(e as Error)?.message ?? String(e)}`,
      );
    }
  }

  private setPendingBeacon(binding: BeaconBinding, pending: boolean): void {
    const audit = this.snapshot.entropyAudit ?? { batches: [] };
    const chainHash = (this.entropy!.source as BeaconSource).chainHash;
    const current = audit.beacon?.pending ?? [];
    const next = pending
      ? [...current, binding]
      : current.filter((b) => b.counter !== binding.counter);
    this.snapshot = {
      ...this.snapshot,
      updatedAt: this.now(),
      entropyAudit: { ...audit, mode: 'beacon', beacon: { chainHash, pending: next } },
    };
    if (pending && !this.closed) {
      // The binding is public before the round exists.
      this.broadcastState();
      this.changes.emit({ snapshot: this.snapshot });
    }
  }

  private async applyBeacon(conn: Connection, seat: number, command: C): Promise<void> {
    const state = this.snapshot.state;
    const ctx = { now: this.now(), seats: this.seatCount };
    let drawn: { value: A | A[]; record: EntropyRecord };
    try {
      drawn = await this.beaconDraw(commandLabel(command), (rng) =>
        this.def.command(state, seat, command, { rng, ...ctx }),
      );
    } catch (e) {
      if (this.closed) return;
      if (e instanceof EntropyUnavailable) {
        this.error(conn, 'entropy-unavailable', e.message);
        return;
      }
      this.reportCommandError(conn, e);
      return;
    }
    if (this.closed) return;
    this.commit(conn, seat, drawn.value, drawn.record);
  }

  // ---- commit ----------------------------------------------------------------------------------

  private reportCommandError(conn: Connection, e: unknown): void {
    if (isCodedError(e)) this.error(conn, e.code, e.message);
    else this.error(conn, 'internal', (e as Error)?.message ?? String(e));
  }

  /** Reduce the produced actions (validating all before committing any) and broadcast them. */
  private commit(
    conn: Connection,
    seat: number,
    produced: A | A[],
    entropy: EntropyRecord | null,
  ): void {
    const steps: { action: A; state: S }[] = [];
    try {
      let state = this.snapshot.state;
      for (const action of Array.isArray(produced) ? produced : [produced]) {
        state = this.def.reduce(state, action);
        steps.push({ action, state });
      }
    } catch (e) {
      this.reportCommandError(conn, e);
      return;
    }
    steps.forEach(({ action, state }, i) => {
      const index = this.snapshot.actions.length;
      // The randomness a command drew is attributed to the last action it produced: that is
      // where a deal or a roll lands (e.g. `[place, deal-next]`).
      const last = i === steps.length - 1;
      const actionMeta =
        last && entropy
          ? { ...(this.snapshot.actionMeta ?? {}), [index]: { entropy } }
          : this.snapshot.actionMeta;
      const resetsReadiness = this.def.resetsReadiness?.(action) ?? false;
      this.snapshot = {
        ...this.snapshot,
        state,
        seq: this.snapshot.seq + 1,
        updatedAt: this.now(),
        actions: [...this.snapshot.actions, action],
        ...(actionMeta ? { actionMeta } : {}),
        ...(resetsReadiness ? { ready: new Array<boolean>(this.seatCount).fill(false) } : {}),
      };
      if (last && (this.audited || this.entropy)) this.snapshot = this.withAudit(this.snapshot);
      this.broadcastState(action, seat);
      if (resetsReadiness) this.broadcast({ type: 'ready', ready: this.readiness() });
      this.changes.emit({ snapshot: this.snapshot, action });
    });
    if (conn === this.systemConn) {
      this.autopilotEvents.emit({
        kind: 'applied',
        reason: this.applyingReason ?? '',
        seq: this.snapshot.seq,
      });
    }
    // Seeded mode: a completed segment (showdown, game over) is revealed at once so the seat
    // can be verified while the result is on the table.
    if (this.mode === 'seeded' && this.def.segmentComplete?.(this.snapshot.state)) {
      if (this.revealActive()) {
        this.snapshot = this.withAudit(this.snapshot);
        this.broadcastState();
        this.changes.emit({ snapshot: this.snapshot });
      }
    }
    this.evaluateAutopilot();
  }

  // ---------------------------------------------------------------------------------------------
  // Unattended play
  // ---------------------------------------------------------------------------------------------

  private setReadiness(ready: boolean[]): void {
    this.snapshot = { ...this.snapshot, ready, updatedAt: this.now() };
    this.broadcast({ type: 'ready', ready: this.readiness() });
    this.changes.emit({ snapshot: this.snapshot });
  }

  private autopilotContext(): AutopilotContext<Cfg> {
    const n = this.seatCount;
    const seatsFilled: boolean[] = [];
    const present: boolean[] = [];
    for (let i = 0; i < n; i++) {
      seatsFilled.push(this.snapshot.seats[i] !== null && this.snapshot.seats[i] !== undefined);
      present.push(this.seats.has(i));
    }
    return {
      seatsFilled,
      present,
      ready: this.readiness(),
      // The server itself is the dealer's presence: a headless runtime never opens a dealer
      // client, and a dealer's own screen being closed must not stall the table it hosts.
      dealerPresent: true,
      now: this.now(),
      config: this.snapshot.config,
    };
  }

  /**
   * Ask the game what the table should do next and do it. Immediate decisions apply at once
   * (and the game is asked again, since one command often enables the next); delayed ones are
   * scheduled and re-checked when they fire. Nothing runs while a draw is in flight: `drain`
   * calls back here afterwards.
   */
  private evaluateAutopilot(): void {
    if (this.closed || this.busy || this.evaluating) return;
    if (!this.autopilotEnabled || !this.def.autopilot) return;
    this.evaluating = true;
    try {
      for (let guard = 0; guard < 8; guard++) {
        const decision = this.def.autopilot(this.snapshot.state, this.autopilotContext());
        if (!decision) {
          this.cancelAutopilot();
          return;
        }
        if (decision.afterMs !== undefined && decision.afterMs > 0) {
          if (this.autopilotPending && this.autopilotPending.reason === decision.reason) return;
          this.scheduleAutopilot(decision.reason, decision.afterMs);
          return;
        }
        this.cancelAutopilot();
        this.applyingReason = decision.reason;
        this.apply(this.systemConn, DEALER_SEAT, decision.command);
        this.applyingReason = null;
        if (this.busy) return; // asynchronous draw in flight: drain() re-evaluates
      }
    } finally {
      this.evaluating = false;
    }
  }

  private scheduleAutopilot(reason: string, afterMs: number): void {
    this.cancelAutopilot(false);
    const at = this.now() + afterMs;
    this.autopilotPending = { reason, at };
    this.autopilotTimer = setTimeout(() => {
      this.autopilotTimer = null;
      const pending = this.autopilotPending;
      this.autopilotPending = null;
      if (this.closed || !pending) return;
      this.broadcast({ type: 'autopilot', pending: null });
      // The game is asked again: the room may have changed while the clock ran.
      const decision = this.def.autopilot?.(this.snapshot.state, this.autopilotContext());
      if (!decision || decision.reason !== pending.reason) {
        this.autopilotEvents.emit({ kind: 'cancelled', reason: pending.reason });
        this.evaluateAutopilot();
        return;
      }
      if (this.busy) return; // re-evaluated (and re-scheduled) after the draw in flight
      this.evaluating = true;
      try {
        this.applyingReason = decision.reason;
        this.apply(this.systemConn, DEALER_SEAT, decision.command);
        this.applyingReason = null;
      } finally {
        this.evaluating = false;
      }
      if (!this.busy) this.evaluateAutopilot();
    }, afterMs);
    this.broadcast({ type: 'autopilot', pending: this.autopilotPending });
    this.autopilotEvents.emit({ kind: 'scheduled', reason, at });
  }

  private cancelAutopilot(announce = true): void {
    if (this.autopilotTimer !== null) {
      clearTimeout(this.autopilotTimer);
      this.autopilotTimer = null;
    }
    const pending = this.autopilotPending;
    this.autopilotPending = null;
    if (pending && announce && !this.closed) {
      this.broadcast({ type: 'autopilot', pending: null });
      this.autopilotEvents.emit({ kind: 'cancelled', reason: pending.reason });
    }
  }
}

/** What the unattended table did or plans to do. */
export type AutopilotEvent =
  | { kind: 'scheduled'; reason: string; at: number }
  | { kind: 'applied'; reason: string; seq: number }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'refused'; reason: string; code: string; message: string };

/** The source could not supply bytes and no fallback was allowed. */
export class EntropyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntropyUnavailable';
  }
}

/** Strip anything that is not public from a profile. */
function publicProfile(profile: PlayerProfile): PlayerProfile {
  const out: PlayerProfile = { id: profile.id, name: profile.name };
  if (profile.avatar) out.avatar = profile.avatar;
  if (profile.publicKey) out.publicKey = profile.publicKey;
  return out;
}

/** This device's generator as an `EntropySource` (proof `none`). */
function localSource(): EntropySource {
  return {
    id: 'crypto',
    async draw(bytes) {
      const out = new Uint8Array(bytes);
      globalThis.crypto.getRandomValues(out);
      return { bytes: out, proof: { kind: 'none' }, fetchedAt: Date.now() };
    },
  };
}

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Fetch bytes just in time and run `fn` over them. The byte budget doubles and `fn` re-runs
 * from scratch whenever it asks for more than was fetched; the record carries every request's
 * proof, the exact bytes consumed and the draw sequence.
 */
export async function drawWith<T>(
  entropy: { source: EntropySource; bytes: number; fallback: boolean; purpose: string },
  ctx: { label: string; tableId: string; now: () => number },
  fn: (rng: Rng) => T,
): Promise<{ value: T; record: EntropyRecord }> {
  const draws: EntropyDraw[] = [];
  let fallback = false;
  let budget = entropy.bytes;
  for (let round = 0; round < MAX_ENTROPY_ROUNDS; round++) {
    let draw: EntropyDraw;
    try {
      draw = await entropy.source.draw(budget, {
        label: ctx.label,
        tableId: ctx.tableId,
        purpose: entropy.purpose,
      });
    } catch (e) {
      if (!entropy.fallback) {
        throw new EntropyUnavailable(
          `randomness source ${entropy.source.id} failed: ${(e as Error)?.message ?? String(e)}`,
        );
      }
      const bytes = new Uint8Array(budget);
      globalThis.crypto.getRandomValues(bytes);
      draw = { bytes, proof: { kind: 'none' }, fetchedAt: ctx.now() };
      fallback = true;
    }
    draws.push(draw);
    const all = concatBytes(draws.map((d) => d.bytes));
    const rng = createByteRng(all);
    try {
      const value = fn(rng);
      const used = rng.used();
      return {
        value,
        record: {
          label: ctx.label,
          provider: entropy.source.id,
          bytes: bytesToHex(all.subarray(0, used)),
          bytesUsed: used,
          draws: rng.draws(),
          sources: draws.map(sourceProof),
          fallback,
        },
      };
    } catch (e) {
      if (!(e instanceof EntropyExhausted)) throw e;
      budget *= 2;
    }
  }
  throw new EntropyUnavailable(
    `command "${ctx.label}" needed more randomness than ${MAX_ENTROPY_ROUNDS} requests supplied`,
  );
}

/** Label for a command's draw: its `type` when it has one. */
function commandLabel(command: unknown): string {
  const t = (command as { type?: unknown } | null)?.type;
  return typeof t === 'string' && t.length > 0 ? t : 'command';
}
