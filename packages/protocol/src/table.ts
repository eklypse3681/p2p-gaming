import type { PlayerProfile } from './messages.js';

/**
 * Generic table protocol (wire format v2). A "table" hosts one match of any game for N seats.
 * Everything game-specific travels as opaque payloads (`command`, `preview`, `state`,
 * `action`); the table core only understands seats, identity, presence and chat.
 *
 * Seats are 0-based indexes. Games map them to their own labels (backgammon: 0 = white,
 * 1 = black).
 */

export interface TableChat {
  /** Seat index, or `DEALER_SEAT` when the dealer speaks. */
  seat: number;
  text: string;
  at: number;
}

/** Seat number used for the dealer (a hosting device that plays no seat) in `by`/chat/commands. */
export const DEALER_SEAT = -1;

// ---------------------------------------------------------------------------------------------
// Randomness modes. `per-draw`: every drawing command fetches bytes just in time. `seeded`: a
// seed per segment (hand / game) is committed before any draw and revealed afterwards; draws
// derive from it. `beacon`: every draw is bound to a future drand round chosen before its value
// exists. See ARCHITECTURE "Randomness modes".
// ---------------------------------------------------------------------------------------------

export type RandomnessMode = 'per-draw' | 'seeded' | 'beacon';

/** Declared in `TableSnapshot.options.randomness` so every seat knows how the table draws. */
export interface RandomnessOptions {
  mode?: RandomnessMode;
  provider: string;
}

// ---------------------------------------------------------------------------------------------
// Randomness audit trail. Randomness may come from an external, verifiable source (random.org's
// signed API, the drand beacon) instead of the host's local CSPRNG. The table records *which*
// bytes fed *which* action so guests can check the proofs; raw bytes never travel.
// ---------------------------------------------------------------------------------------------

/** A verifiable proof attached to a batch of random bytes. */
export type EntropyProof =
  | { kind: 'none' }
  /** random.org `generateSignedIntegers`: the full `random` object and its signature, verifiable with `verifySignature`. */
  | { kind: 'random.org-signed'; random: unknown; signature: string; serialNumber?: number }
  /** A drand beacon round; re-fetch `/public/{round}` on the chain and compare. */
  | {
      kind: 'drand';
      round: number;
      randomness: string;
      signature: string;
      chainHash: string;
      context?: string;
    }
  | { kind: 'custom'; provider: string; data: unknown };

/** One `int(n)` draw and the value it produced; shuffles are sequences of these. */
export interface DrawSpec {
  n: number;
  value: number;
}

/** One request to the randomness source, with everything needed to check it later. */
export interface EntropySourceProof {
  proof: EntropyProof;
  /** Every byte the source returned for this request, hex. */
  bytes: string;
  fetchedAt: number;
  /** random.org bookkeeping: serial numbers must be consecutive for one key with no hidden requests. */
  serialNumber?: number;
  bitsLeft?: number;
  requestsLeft?: number;
}

/**
 * Which randomness fed a draw (a command, a deal, the initial shuffle) and how the values were
 * derived from it. `deriveDraws(bytes, draws)` recomputes the values from `bytes`.
 */
export interface EntropyRecord {
  /** What the draw was for, e.g. `roll`, `start`, `place`, `init`. */
  label: string;
  /** Id of the randomness source. */
  provider: string;
  /** Exactly the bytes consumed, hex, in order. */
  bytes: string;
  bytesUsed: number;
  /** The `int(n)` calls made, in order, with their results. */
  draws: DrawSpec[];
  /** Proofs for the bytes, in order (just-in-time: one per request; a re-run adds a second). */
  sources: EntropySourceProof[];
  /** Pool path only: batch ids in `entropyAudit.batches` (their proofs live there, not inline). */
  batches?: string[];
  /** True when part of the draw came from the local generator because the source failed. */
  fallback: boolean;
  /** Seeded mode: which segment's seed produced the bytes, and the draw counter within it. */
  segment?: number;
  drawIndex?: number;
  /** Beacon mode: the round this draw was bound to, chosen before the round existed. */
  beacon?: BeaconBinding;
}

/** Beacon mode: a draw's commitment to a future round. */
export interface BeaconBinding {
  /** Per-table draw counter; the derivation context uses it. */
  counter: number;
  chainHash: string;
  round: number;
  /** When the round was chosen (server clock). */
  committedAt: number;
}

/** Seeded mode: one committed seed and the actions it fed. */
export interface SeedSegment {
  index: number;
  /** hex SHA-256(seed ‖ "|" ‖ tableId ‖ "|" ‖ index), published before any draw of the segment. */
  commitment: string;
  /** Index of the first action that may belong to this segment. */
  from: number;
  /** Index of the last action of the segment once it is closed. */
  to?: number;
  committedAt: number;
  /** Set on reveal: the seed (hex) and the source request that produced it. */
  seed?: string;
  source?: EntropySourceProof;
  revealedAt?: number;
}

/** Metadata about an entry of the action log, keyed by action index. */
export interface ActionMeta {
  entropy?: EntropyRecord;
}

/** One fetched batch as it appears in a snapshot (pool path): the proof and size, never the bytes. */
export interface EntropyBatchSummary {
  id: string;
  provider: string;
  fetchedAt: number;
  bytes: number;
  proof: EntropyProof;
}

export interface EntropyAudit {
  batches: EntropyBatchSummary[];
  /** Randomness used by `init` (e.g. an opening shuffle), if any. */
  init?: EntropyRecord;
  mode?: RandomnessMode;
  /** Seeded mode: every segment so far, oldest first. */
  segments?: SeedSegment[];
  /** Beacon mode: draws whose round was chosen but whose value has not arrived yet. */
  beacon?: { chainHash: string; pending: BeaconBinding[] };
}

/**
 * The persisted/wire state of a table. `actions` replayed from `initialState` through the game's
 * reducer must reproduce `state`; that is how a resumed copy is verified. When `view` is true the
 * snapshot is one seat's redacted view of a hidden-information game: `state`/`actions` cannot be
 * replayed and the copy is never adopted as authoritative.
 */
export interface TableSnapshot<State = unknown, Action = unknown, Config = unknown> {
  id: string;
  code: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
  /** Game definition id, e.g. 'backgammon'. */
  gameId: string;
  config: Config;
  /** One entry per seat; null while the seat is free. */
  seats: (PlayerProfile | null)[];
  /** Seat of the hosting player, or null when a non-playing dealer hosts (see `dealer`). */
  hostSeat: number | null;
  /** Public profile of the dealer when the table is dealer-hosted. */
  dealer?: PlayerProfile;
  /** Table-level options the game does not interpret (e.g. `homeSide` for backgammon). */
  options: Record<string, unknown>;
  initialState: State;
  actions: Action[];
  state: State;
  chat: TableChat[];
  view?: boolean;
  /**
   * Per-action metadata (randomness attribution), keyed by index into `actions`. Kept beside
   * the log, not inside it, so reducers and replay never see it. Views re-key it to match their
   * filtered `actions`.
   */
  actionMeta?: Record<number, ActionMeta>;
  /** Proofs for every batch of randomness the host fetched for this table (public). */
  entropyAudit?: EntropyAudit;
  /**
   * Readiness by seat ("ready for the next hand / game"). Table flow, not game state: it is
   * toggled with a `ready` message, read by the game's autopilot, and cleared by the table when
   * the game says a new round began. Absent means nobody is ready.
   */
  ready?: boolean[];
}

/** A pending autopilot decision (e.g. "next hand" countdown) that clients may display. */
export interface AutopilotPending {
  reason: string;
  /** Epoch ms at which the table will act. */
  at: number;
}

export type TableClientMessage =
  | {
      type: 'hello';
      protocol: number;
      profile: PlayerProfile;
      /** When resuming, a device offers its own copy so the newest replayable one wins. */
      snapshot?: TableSnapshot;
    }
  /** Answer to a `challenge`: base64url signature over `challengeBytes({ matchId, profileId, nonce })`. */
  | { type: 'auth'; signature: string }
  /** A game command; validated and interpreted by the game definition. */
  | { type: 'command'; command: unknown }
  /** Table flow: this seat is (not) ready for the next hand / game. */
  | { type: 'ready'; ready: boolean }
  /** Non-authoritative payload forwarded to every other seat (e.g. a move being arranged). */
  | { type: 'preview'; payload: unknown }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'bye' };

export type RejectReason = 'full' | 'protocol' | 'wrong-match' | 'bad-hello' | 'unauthorized';

export type TableServerMessage<State = unknown, Action = unknown> =
  /** Prove you hold the key for this seat: sign `challengeBytes({ matchId, profileId, nonce })`. */
  | { type: 'challenge'; nonce: string; matchId: string }
  /** `seat` is null for the dealer (a hosting device that plays no seat). */
  | { type: 'welcome'; seat: number | null; snapshot: TableSnapshot<State, Action> }
  | { type: 'rejected'; reason: RejectReason; message: string }
  /** Snapshot (full for the host seat, a view for the others) after every change. */
  | { type: 'state'; snapshot: TableSnapshot<State, Action>; action?: Action; by?: number }
  | { type: 'preview'; seat: number; payload: unknown }
  | { type: 'presence'; seat: number; connected: boolean }
  /** Dealer presence (dealer-hosted tables only). */
  | { type: 'dealer'; profile: PlayerProfile; connected: boolean }
  /** Table flow: readiness by seat changed. */
  | { type: 'ready'; ready: boolean[] }
  /** Table flow: what the unattended table will do next, or null when nothing is scheduled. */
  | { type: 'autopilot'; pending: AutopilotPending | null }
  | { type: 'chat'; message: TableChat }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number };

/** Convenience aliases: the generic messages are the only wire format. */
export type ClientMessage = TableClientMessage;
export type ServerMessage<State = unknown, Action = unknown> = TableServerMessage<State, Action>;

export function isClientMessage(m: unknown): m is TableClientMessage {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

export function isServerMessage(m: unknown): m is TableServerMessage {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
