import type { Action, DiceSource, MatchConfig, MatchState, Player } from '@bgf/engine';
import type {
  HomeSide,
  MatchSnapshot,
  PlayerProfile,
  RandomnessMode,
  Transport,
  Unsubscribe,
} from '@bgf/protocol';
import { DEFAULT_HOME_SIDE } from '@bgf/protocol';
import type { AuditedRng, Rng, TableServerOptions } from '@bgf/table';
import {
  CHALLENGE_TIMEOUT_MS,
  MAX_CHAT_HISTORY,
  MAX_CONNECTIONS_PER_SEAT,
  TableServer,
  cryptoRng,
  verifySnapshot,
} from '@bgf/table';
import { backgammonDefinition } from './definition.js';
import type { BackgammonCommand } from './definition.js';
import { seatIndex, seatPlayer, toMatchSnapshot, toTableSnapshot } from './snapshot.js';

export { CHALLENGE_TIMEOUT_MS, MAX_CHAT_HISTORY, MAX_CONNECTIONS_PER_SEAT };

export interface GameServerOptions {
  /** Resume from persisted state. The action log is replayed to verify integrity. */
  snapshot?: MatchSnapshot;
  /** Match configuration for a new match (ignored when `snapshot` is given). */
  config?: Partial<MatchConfig>;
  /** Room code (new match). */
  code: string;
  /** Profile of the player hosting this server. */
  host: PlayerProfile;
  /**
   * Seat the host takes in a new match. Default 'white'. `null` = **dealer mode**: the hosting
   * device plays no seat, both colours are guests, and the host may only relay (see `@bgf/table`).
   */
  hostSeat?: Player | null;
  /** Table layout for a new match: side of the home boards as seen from the host. Default 'left'. */
  homeSide?: HomeSide;
  /**
   * Unattended play: the table starts games by itself when both players are here (first game)
   * or ready (next game). Default: on for dealer-hosted matches, off otherwise.
   */
  autopilot?: boolean;
  /** Dice source; default cryptographically random. Ignored when `rng` is given. */
  dice?: DiceSource;
  /**
   * Randomness for the dice; an `@bgf/entropy` pool (`AuditedRng`) makes every roll traceable
   * to a published proof (`snapshot.actionMeta` / `snapshot.entropyAudit`).
   */
  rng?: Rng | AuditedRng;
  /**
   * Just-in-time dice from an external, verifiable source (random.org, drand): bytes are
   * requested when a roll happens, never before. See `TableServerOptions.entropy`.
   */
  /**
   * Randomness mode: `per-draw` (default), `seeded` (a seed committed at each game start and
   * revealed when it ends) or `beacon` (dice bound to future drand rounds). See `@bgf/table`.
   */
  randomness?: { mode?: RandomnessMode };
  entropy?: TableServerOptions<
    MatchState,
    Action,
    BackgammonCommand,
    MatchState,
    MatchConfig
  >['entropy'];
  /** Clock; default Date.now. */
  now?: () => number;
  /** Match id for a new match; default a random id. */
  matchId?: string;
  /** Start a new match from a custom state (set-up positions, tests) instead of `newMatch(config)`. */
  initialMatch?: MatchState;
}

/** An `Rng` whose six-sided draws come from a `DiceSource` (so scripted/seeded dice keep working). */
function rngFromDice(dice: DiceSource): Rng {
  const fallback = cryptoRng();
  const int = (maxExclusive: number): number =>
    maxExclusive === 6 ? dice.rollDie() - 1 : fallback.int(maxExclusive);
  return {
    int,
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

type BackgammonTable = TableServer<MatchState, Action, BackgammonCommand, MatchState, MatchConfig>;

/** Translate the colour-keyed options into the table core's seat-indexed options. */
function tableOptionsFor(
  opts: GameServerOptions,
): TableServerOptions<MatchState, Action, BackgammonCommand, MatchState, MatchConfig> {
  const rng = opts.rng ?? (opts.dice ? rngFromDice(opts.dice) : cryptoRng());
  if (opts.snapshot) {
    return {
      def: backgammonDefinition,
      code: opts.snapshot.code,
      host: opts.host,
      snapshot: toTableSnapshot(opts.snapshot),
      rng,
      entropy: opts.entropy,
      now: opts.now,
    };
  }
  const hostSeat = opts.hostSeat === null ? null : seatIndex(opts.hostSeat ?? 'white');
  return {
    def: backgammonDefinition as never,
    code: opts.code,
    host: opts.host,
    hostSeat,
    seats: 2,
    config: opts.config,
    options: {
      homeSide: opts.homeSide ?? DEFAULT_HOME_SIDE,
      ...(opts.initialMatch ? { customStart: true } : {}),
      ...(opts.randomness?.mode ? { randomness: { mode: opts.randomness.mode } } : {}),
      ...(opts.autopilot !== undefined ? { autopilot: opts.autopilot } : {}),
    },
    initialState: opts.initialMatch,
    rng,
    entropy: opts.entropy,
    now: opts.now,
    matchId: opts.matchId,
  };
}

/**
 * The backgammon game server: a thin, colour-speaking wrapper around the generic
 * `TableServer` running the backgammon definition. It lives in the host's browser and only
 * ever sees `Transport` objects.
 */
export class GameServer {
  readonly table: BackgammonTable;

  constructor(opts: GameServerOptions | { table: BackgammonTable }) {
    if ('table' in opts) {
      this.table = opts.table;
      return;
    }
    this.table = new TableServer(tableOptionsFor(opts));
  }

  /**
   * Like the constructor, but goes through `TableServer.create`, which is required when the
   * randomness mode commits at creation (`seeded`) or an external source is configured.
   */
  static async create(opts: GameServerOptions): Promise<GameServer> {
    return new GameServer({ table: await TableServer.create(tableOptionsFor(opts)) });
  }

  /** Replays a snapshot's action log; returns a snapshot whose `match` is the replayed state. */
  static verifySnapshot(snapshot: MatchSnapshot): MatchSnapshot {
    return toMatchSnapshot(verifySnapshot(backgammonDefinition, toTableSnapshot(snapshot)));
  }

  getSnapshot(): MatchSnapshot {
    return toMatchSnapshot(this.table.getSnapshot());
  }

  onChange(listener: (snapshot: MatchSnapshot, action?: Action) => void): Unsubscribe {
    return this.table.onChange((snapshot, action) => listener(toMatchSnapshot(snapshot), action));
  }

  /** Seats with at least one live connection. */
  connectedSeats(): Player[] {
    return this.table.connectedSeats().map(seatPlayer);
  }

  /** Number of devices currently connected for a seat. */
  connectionCount(seat: Player): number {
    return this.table.connectionCount(seatIndex(seat));
  }

  /** Accept an inbound connection. The first message must be a `hello`. */
  accept(transport: Transport): void {
    this.table.accept(transport);
  }

  /** Create an in-memory connection for the host's own client and return the client's end. */
  connectLocal(): Transport {
    return this.table.connectLocal();
  }

  close(): void {
    this.table.close();
  }
}
