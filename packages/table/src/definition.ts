import type { EntropyBatchSummary, EntropyRecord } from '@bgf/protocol';
import type { TrustDeclaration } from './trust.js';

/**
 * The contract a game implements to run on a table. The table core handles seats, identity,
 * presence, chat, previews, persistence and resume; the definition supplies the rules.
 *
 * Determinism contract: `reduce` must be pure, and every random value a game needs (dice, a
 * shuffled deck) must be drawn from `ctx.rng` inside `command` and embedded in the returned
 * action(s), so that `actions` replayed from `initialState` reproduce `state` exactly. `init`
 * may also use `rng` (e.g. to shuffle an opening deck) because the initial state is persisted.
 */

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Fisher-Yates shuffle; returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * An `Rng` that can say where its bytes came from. `withDraw` groups every draw made inside
 * `fn` under `label` and returns the attribution record (null when nothing was drawn). Provided
 * by `@bgf/entropy`'s pool; the table core attaches the records to the action log.
 */
export interface AuditedRng extends Rng {
  /** Id of the declared randomness source, e.g. `crypto`, `random.org`, `drand`. */
  readonly provider: string;
  withDraw<T>(label: string, fn: (rng: Rng) => T): { value: T; record: EntropyRecord | null };
  /** Proofs for every batch fetched so far (no raw bytes). */
  audit(): { batches: EntropyBatchSummary[] };
}

export function isAuditedRng(rng: Rng): rng is AuditedRng {
  const r = rng as Partial<AuditedRng>;
  return typeof r.withDraw === 'function' && typeof r.audit === 'function';
}

export interface CommandContext {
  rng: Rng;
  now: number;
  /** Number of seats at this table. */
  seats: number;
}

export interface InitContext {
  rng: Rng;
  seats: number;
}

/** What the unattended table knows about the room when it asks the game what to do next. */
export interface AutopilotContext<Config = unknown> {
  /** Seat i has a player profile bound to it. */
  seatsFilled: boolean[];
  /** Seat i has at least one live device right now. */
  present: boolean[];
  /** Seat i pressed "ready" (table flow, cleared when the game says a round began). */
  ready: boolean[];
  /** The hosting device is running the table (always true today; reserved for remote dealers). */
  dealerPresent: boolean;
  now: number;
  config: Config;
}

/**
 * A dealer command the table should send on the game's behalf. `afterMs` schedules it (the
 * table re-asks when the state changes and drops the timer if the decision disappears);
 * without it the command applies immediately. `reason` is logged and shown to players.
 */
export interface AutopilotDecision<Command> {
  command: Command;
  afterMs?: number;
  reason: string;
}

export interface GameDefinition<State, Action, Command, View = State, Config = unknown> {
  id: string;
  minSeats: number;
  maxSeats: number;
  /**
   * True when `view` hides information from some seats (secret cards, hidden discards). Such
   * games send redacted snapshots to non-host seats, never adopt a guest's copy on resume, and
   * pass actions through `viewAction` before broadcasting them.
   */
  hiddenInformation?: boolean;
  /**
   * What a hosting device can see (plain language) so the table can disclose it to players.
   * Any game may be hosted by a player; this only describes the consequences. Falls back to a
   * declaration derived from `hiddenInformation` with no details.
   */
  trust?: TrustDeclaration;
  /** Normalise a config object coming from the host UI (fill defaults, clamp). */
  normalizeConfig?(config: unknown): Config;
  /** Fresh authoritative state. */
  init(config: Config, ctx: InitContext): State;
  /** Shape-check a raw command from the wire; return null to refuse it (the sender gets `bad-message`). */
  validateCommand(raw: unknown): Command | null;
  /** Shape-check a raw preview payload. Default: pass through. */
  validatePreview?(raw: unknown): unknown | null;
  /**
   * Validate a seat's command against the rules and turn it into the action(s) to apply. Throw
   * an error with a string `code` (e.g. the engine's RuleError) to refuse it; the sender receives
   * `error { code, message }` and nothing changes.
   */
  command(state: State, seat: number, command: Command, ctx: CommandContext): Action | Action[];
  reduce(state: State, action: Action): State;
  /** What `seat` may see; `null` = spectator. Identity for games without hidden information. */
  view(state: State, seat: number | null): View;
  /**
   * The action as `seat` may see it (e.g. a deal with the other seats' cards blanked), or null to
   * withhold it entirely. Only consulted when `hiddenInformation` is true.
   */
  viewAction?(action: Action, seat: number | null): Action | null;
  /** True when the current game/match cannot accept further commands. */
  isOver?(state: State): boolean;
  /** Small, serialisable digest for lists and history cards. */
  summary?(state: State): unknown;
  /**
   * Command `type`s a non-playing dealer (a hosting device with no seat) may send. Such
   * commands reach `command` with `seat === DEALER_SEAT` (-1). Anything else from the dealer is
   * refused with `not-seated`. Default: none.
   */
  dealerCommands?: readonly string[];
  /**
   * Unattended play. Asked after every applied action, readiness change and presence change
   * (only while the table runs unattended: dealer mode, or `options.autopilot === true`).
   * Return the dealer command to send now or after a delay, or null when nothing should happen.
   * Must be idempotent: once the command has applied, the same state must yield null.
   */
  autopilot?(state: State, ctx: AutopilotContext<Config>): AutopilotDecision<Command> | null;
  /**
   * True when `action` starts a new round (a hand, a game), so the table clears every seat's
   * readiness. Default: readiness is never cleared automatically.
   */
  resetsReadiness?(action: Action): boolean;
  /**
   * Seeded randomness: true when `command` begins a new segment (a hand, a game), i.e. a fresh
   * seed must be committed before it runs. Default: only table creation begins a segment.
   */
  segmentBoundary?(state: State, command: Command): boolean;
  /**
   * Seeded randomness: true when the state has reached the end of the current segment (showdown,
   * game over), so the seed can be revealed for verification. Default: segments are revealed
   * when the next one begins or when the table closes.
   */
  segmentComplete?(state: State): boolean;
}

/** Errors thrown by `command` carry a machine-readable code. */
export interface CodedError {
  code: string;
  message: string;
}

export function isCodedError(e: unknown): e is CodedError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

export class CommandError extends Error implements CodedError {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}
