import type { Action, DiceSource, MatchConfig, MatchState, Player } from '@bgf/engine';
import {
  RuleError,
  applyAction,
  cryptoDice,
  isFreeMode,
  newMatch,
  opponent,
  replay,
  rollDice,
} from '@bgf/engine';
import type {
  ClientMessage,
  HomeSide,
  MatchSnapshot,
  PlayerProfile,
  ServerMessage,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import {
  DEFAULT_HOME_SIDE,
  Emitter,
  PROTOCOL_VERSION,
  createMemoryPair,
  generateId,
} from '@bgf/protocol';
import { validateClientMessage } from './validate.js';

export interface GameServerOptions {
  /** Resume from persisted state. The action log is replayed to verify integrity. */
  snapshot?: MatchSnapshot;
  /** Match configuration for a new match (ignored when `snapshot` is given). */
  config?: Partial<MatchConfig>;
  /** Room code (new match). */
  code: string;
  /** Profile of the player hosting this server. */
  host: PlayerProfile;
  /** Seat the host takes in a new match. Default 'white'. */
  hostSeat?: Player;
  /** Table layout for a new match: side of the home boards as seen from the host. Default 'left'. */
  homeSide?: HomeSide;
  /** Dice source; default cryptographically random. */
  dice?: DiceSource;
  /** Clock; default Date.now. */
  now?: () => number;
  /** Match id for a new match; default a random id. */
  matchId?: string;
  /** Start a new match from a custom state (set-up positions, tests) instead of `newMatch(config)`. */
  initialMatch?: MatchState;
}

interface Connection {
  transport: Transport;
  seat: Player | null;
  closed: boolean;
  unsubscribe: Unsubscribe[];
}

export const MAX_CHAT_HISTORY = 200;
/** How many devices one player may have connected at once; the oldest is dropped beyond this. */
export const MAX_CONNECTIONS_PER_SEAT = 4;

/**
 * The authoritative game server. It lives in the host's browser (or in a Node test) and only ever
 * sees `Transport` objects: it does not know or care whether a connection is in-memory, a
 * BroadcastChannel or a WebRTC data channel.
 *
 * A seat is a player, not a connection: the same profile may be connected from several devices
 * at once (a laptop and a phone) and every device of a seat receives every message meant for it.
 */
export class GameServer {
  private snapshot: MatchSnapshot;
  private readonly dice: DiceSource;
  private readonly now: () => number;
  private readonly connections = new Set<Connection>();
  /** Live connections per seat, oldest first. A seat with no connections has no entry. */
  private readonly seats = new Map<Player, Connection[]>();
  private readonly changes = new Emitter<{ snapshot: MatchSnapshot; action?: Action }>();
  private closed = false;

  constructor(opts: GameServerOptions) {
    this.dice = opts.dice ?? cryptoDice();
    this.now = opts.now ?? Date.now;
    if (opts.snapshot) {
      this.snapshot = GameServer.verifySnapshot(opts.snapshot);
    } else {
      const hostSeat = opts.hostSeat ?? 'white';
      const match = opts.initialMatch ?? newMatch(opts.config);
      const t = this.now();
      this.snapshot = {
        id: opts.matchId ?? generateId(),
        code: opts.code,
        seq: 0,
        createdAt: t,
        updatedAt: t,
        config: match.config,
        players: { white: null, black: null, [hostSeat]: opts.host },
        hostSeat,
        homeSide: opts.homeSide ?? DEFAULT_HOME_SIDE,
        actions: [],
        match,
        chat: [],
        ...(opts.initialMatch ? { initialMatch: opts.initialMatch } : {}),
      };
    }
  }

  /** Replays a snapshot's action log; returns a snapshot whose `match` is the replayed state. */
  static verifySnapshot(snapshot: MatchSnapshot): MatchSnapshot {
    const match: MatchState = snapshot.initialMatch
      ? snapshot.actions.reduce(applyAction, snapshot.initialMatch)
      : replay(snapshot.config, snapshot.actions);
    return {
      ...snapshot,
      homeSide: snapshot.homeSide ?? DEFAULT_HOME_SIDE,
      actions: snapshot.actions.slice(),
      chat: (snapshot.chat ?? []).slice(-MAX_CHAT_HISTORY),
      players: { white: snapshot.players?.white ?? null, black: snapshot.players?.black ?? null },
      match,
    };
  }

  getSnapshot(): MatchSnapshot {
    return this.snapshot;
  }

  onChange(listener: (snapshot: MatchSnapshot, action?: Action) => void): Unsubscribe {
    return this.changes.on(({ snapshot, action }) => listener(snapshot, action));
  }

  /** Seats with at least one live connection. */
  connectedSeats(): Player[] {
    return Array.from(this.seats.keys());
  }

  /** Number of devices currently connected for a seat. */
  connectionCount(seat: Player): number {
    return this.seats.get(seat)?.length ?? 0;
  }

  /** Accept an inbound connection. The first message must be a `hello`. */
  accept(transport: Transport): void {
    if (this.closed) {
      transport.close();
      return;
    }
    const conn: Connection = { transport, seat: null, closed: false, unsubscribe: [] };
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
    this.closed = true;
    for (const conn of Array.from(this.connections)) this.closeConnection(conn);
    this.changes.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------------------------

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.closed || conn.transport.status === 'closed') return;
    try {
      conn.transport.send(message);
    } catch {
      /* transport died between the status check and the send; the status handler cleans up */
    }
  }

  /** Deliver to every device of a seat. */
  private sendToSeat(seat: Player, message: ServerMessage): void {
    for (const conn of this.seats.get(seat) ?? []) this.send(conn, message);
  }

  private broadcast(message: ServerMessage, except?: Connection): void {
    for (const list of this.seats.values()) {
      for (const conn of list) if (conn !== except) this.send(conn, message);
    }
  }

  /** Close a connection we no longer want (rejection, replacement, shutdown). */
  private closeConnection(conn: Connection): void {
    if (conn.closed) return;
    this.detach(conn, false);
    try {
      conn.transport.close();
    } catch {
      /* ignore */
    }
  }

  /** The transport closed underneath us. */
  private dropConnection(conn: Connection): void {
    if (conn.closed) return;
    this.detach(conn, true);
  }

  private detach(conn: Connection, announce: boolean): void {
    conn.closed = true;
    for (const u of conn.unsubscribe) u();
    conn.unsubscribe = [];
    this.connections.delete(conn);
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
  }

  private reject(
    conn: Connection,
    reason: Extract<ServerMessage, { type: 'rejected' }>['reason'],
    message: string,
  ): void {
    this.send(conn, { type: 'rejected', reason, message });
    this.closeConnection(conn);
  }

  // ---------------------------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------------------------

  private handle(conn: Connection, raw: unknown): void {
    if (conn.closed || this.closed) return;
    const result = validateClientMessage(raw);
    if (!result.ok) {
      if (conn.seat === null) this.reject(conn, 'bad-hello', `expected hello: ${result.reason}`);
      else this.send(conn, { type: 'error', code: 'bad-message', message: result.reason });
      return;
    }
    const msg = result.message;
    if (conn.seat === null) {
      if (msg.type !== 'hello') {
        this.reject(conn, 'bad-hello', 'first message must be hello');
        return;
      }
      this.handleHello(conn, msg);
      return;
    }
    if (msg.type === 'hello') {
      this.send(conn, { type: 'error', code: 'already-joined', message: 'hello already received' });
      return;
    }
    this.handleCommand(conn, conn.seat, msg);
  }

  private handleHello(conn: Connection, msg: Extract<ClientMessage, { type: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.reject(
        conn,
        'protocol',
        `protocol ${msg.protocol} not supported (server is ${PROTOCOL_VERSION})`,
      );
      return;
    }
    if (msg.snapshot) {
      if (msg.snapshot.id !== this.snapshot.id) {
        this.reject(conn, 'wrong-match', 'that snapshot belongs to a different match');
        return;
      }
      this.maybeAdopt(conn, msg.snapshot);
    }

    const seat = this.resolveSeat(msg.profile);
    if (!seat) {
      this.reject(conn, 'full', 'both seats are taken');
      return;
    }
    const profile = msg.profile;

    // Record the freshest profile (name/avatar may have changed) and tell the other seat.
    const known = this.snapshot.players[seat];
    const rosterChanged =
      !known ||
      known.id !== profile.id ||
      known.name !== profile.name ||
      known.avatar !== profile.avatar;
    if (rosterChanged) {
      this.snapshot = {
        ...this.snapshot,
        players: { ...this.snapshot.players, [seat]: profile },
      };
      this.broadcast({ type: 'state', snapshot: this.snapshot }, conn);
    }

    // Join this seat's set of devices; beyond the cap the oldest device is dropped.
    const list = this.seats.get(seat) ?? [];
    const first = list.length === 0;
    conn.seat = seat;
    this.seats.set(seat, [...list, conn]);
    while ((this.seats.get(seat)?.length ?? 0) > MAX_CONNECTIONS_PER_SEAT) {
      const oldest = this.seats.get(seat)![0]!;
      this.closeConnection(oldest); // the seat stays occupied, so no presence change
    }

    this.send(conn, { type: 'welcome', seat, snapshot: this.snapshot });
    const other = opponent(seat);
    this.send(conn, { type: 'presence', seat: other, connected: this.seats.has(other) });
    // The opponent only learns about presence when the seat goes from absent to present.
    if (first) this.sendToSeat(other, { type: 'presence', seat, connected: true });
    this.changes.emit({ snapshot: this.snapshot });
  }

  /**
   * Which seat a hello belongs to: a known profile id always gets its own seat (whether that is
   * a reconnect or a second device joining alongside the first); a new profile id gets the first
   * free seat; otherwise the table is full.
   */
  private resolveSeat(profile: PlayerProfile): Player | null {
    const { players } = this.snapshot;
    const seats = ['white', 'black'] as const;
    return (
      seats.find((s) => players[s]?.id === profile.id) ??
      seats.find((s) => players[s] === null) ??
      null
    );
  }

  /** Adopt the peer's snapshot if it is strictly newer and its action log replays cleanly. */
  private maybeAdopt(conn: Connection, incoming: MatchSnapshot): void {
    if (incoming.seq <= this.snapshot.seq) return;
    let verified: MatchSnapshot;
    try {
      verified = GameServer.verifySnapshot(incoming);
    } catch (e) {
      this.send(conn, {
        type: 'error',
        code: 'bad-snapshot',
        message: `your snapshot could not be replayed: ${(e as Error).message}`,
      });
      return;
    }
    const players = {
      white: this.snapshot.players.white ?? verified.players.white,
      black: this.snapshot.players.black ?? verified.players.black,
    };
    this.snapshot = {
      ...verified,
      code: this.snapshot.code,
      hostSeat: this.snapshot.hostSeat,
      homeSide: this.snapshot.homeSide,
      players,
      updatedAt: this.now(),
    };
    this.broadcast({ type: 'state', snapshot: this.snapshot }, conn);
    this.changes.emit({ snapshot: this.snapshot });
  }

  private handleCommand(conn: Connection, seat: Player, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello':
        return; // handled above
      case 'start-game':
        this.apply(conn, seat, { type: 'start-game' });
        return;
      case 'opening-roll': {
        const game = this.snapshot.match.game;
        if (!game || game.phase.kind !== 'opening') {
          this.error(conn, 'wrong-phase', 'not in the opening roll');
          return;
        }
        if (game.phase.rolls[seat] !== undefined) {
          this.error(conn, 'already-rolled', 'you already rolled');
          return;
        }
        this.apply(conn, seat, { type: 'opening-roll', player: seat, die: this.dice.rollDie() });
        return;
      }
      case 'roll': {
        const game = this.snapshot.match.game;
        if (!game || game.phase.kind !== 'to-roll') {
          this.error(conn, 'wrong-phase', 'not waiting for a roll');
          return;
        }
        if (game.phase.player !== seat) {
          this.error(conn, 'not-your-turn', 'it is not your turn to roll');
          return;
        }
        this.apply(conn, seat, { type: 'roll', player: seat, dice: rollDice(this.dice) });
        return;
      }
      case 'play':
        this.apply(conn, seat, { type: 'play', player: seat, play: msg.play });
        return;
      case 'double':
        this.apply(conn, seat, { type: 'double', player: seat });
        return;
      case 'take':
        this.apply(conn, seat, { type: 'take', player: seat });
        return;
      case 'drop':
        this.apply(conn, seat, { type: 'drop', player: seat });
        return;
      case 'offer-resign':
        this.apply(conn, seat, { type: 'offer-resign', player: seat, stakes: msg.stakes });
        return;
      case 'accept-resign':
        this.apply(conn, seat, { type: 'accept-resign', player: seat });
        return;
      case 'decline-resign':
        this.apply(conn, seat, { type: 'decline-resign', player: seat });
        return;
      case 'free-roll': {
        if (!isFreeMode(this.snapshot.match.config)) {
          this.error(conn, 'free-mode', 'only available on a free board');
          return;
        }
        const game = this.snapshot.match.game;
        if (!game || game.phase.kind !== 'free') {
          this.error(conn, 'wrong-phase', 'no free board in play');
          return;
        }
        this.apply(conn, seat, { type: 'free-roll', player: seat, dice: rollDice(this.dice) });
        return;
      }
      case 'free-move':
        this.apply(conn, seat, {
          type: 'free-move',
          player: seat,
          checker: msg.checker,
          from: msg.from,
          to: msg.to,
        });
        return;
      case 'free-cube':
        this.apply(conn, seat, {
          type: 'free-cube',
          player: seat,
          value: msg.value,
          owner: msg.owner,
        });
        return;
      case 'free-reset':
        this.apply(conn, seat, { type: 'free-reset', player: seat });
        return;
      case 'free-result':
        this.apply(conn, seat, {
          type: 'free-result',
          player: seat,
          winner: msg.winner,
          kind: msg.kind,
        });
        return;
      case 'preview':
        this.sendToSeat(opponent(seat), { type: 'preview', seat, play: msg.play });
        return;
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
    this.send(conn, { type: 'error', code, message });
  }

  private apply(conn: Connection, seat: Player, action: Action): void {
    let match: MatchState;
    try {
      match = applyAction(this.snapshot.match, action);
    } catch (e) {
      if (e instanceof RuleError) this.error(conn, e.code, e.message);
      else this.error(conn, 'internal', (e as Error).message ?? String(e));
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      match,
      seq: this.snapshot.seq + 1,
      updatedAt: this.now(),
      actions: [...this.snapshot.actions, action],
    };
    this.broadcast({ type: 'state', snapshot: this.snapshot, action, by: seat });
    this.changes.emit({ snapshot: this.snapshot, action });
  }
}
