import type { Action, MatchConfig, MatchState, Player } from '@bgf/engine';
import type { ActionMeta, EntropyAudit, RandomnessMode } from './table.js';

/** Wire protocol version: 2 = generic table protocol (see table.ts). */
export const PROTOCOL_VERSION = 2;

/**
 * Which side of the table the home boards are on, as seen from a given seat. A match has one
 * table layout (`MatchSnapshot.homeSide`, as seen by the host); the opposite seat necessarily
 * sees the home boards on the other side, exactly like sitting across a physical board.
 */
export type HomeSide = 'left' | 'right';
export const DEFAULT_HOME_SIDE: HomeSide = 'left';

export function oppositeSide(side: HomeSide): HomeSide {
  return side === 'left' ? 'right' : 'left';
}

/** Side of the home boards as seen from `seat`, given the table layout from the host's seat. */
export function sideForSeat(
  snapshot: Pick<MatchSnapshot, 'hostSeat' | 'homeSide'>,
  seat: Player,
): HomeSide {
  const hostSide = snapshot.homeSide ?? DEFAULT_HOME_SIDE;
  return seat === snapshot.hostSeat ? hostSide : oppositeSide(hostSide);
}

/** A player's identity as known to this browser. `id` is a random stable token. */
export interface PlayerProfile {
  id: string;
  name: string;
  /** Optional emoji or short token used for the avatar. */
  avatar?: string;
  /**
   * base64url ECDSA P-256 public key. Bound to the seat on first use; later claims of the seat
   * must be signed with the matching private key. Absent only for legacy, unkeyed players.
   */
  publicKey?: string;
}

export interface ChatMessage {
  seat: Player;
  text: string;
  at: number;
}

/**
 * The persisted state of a backgammon match as the web app stores and syncs it. On the wire and
 * inside the table core the generic `TableSnapshot` is used; `@bgf/server`/`@bgf/client`
 * convert between the two (see packages/server/src/snapshot.ts).
 */
export interface MatchSnapshot {
  /** Stable match identifier (uuid-ish). */
  id: string;
  /** Room code used to find each other on the transport. */
  code: string;
  /** Monotonic version; incremented on every action. */
  seq: number;
  createdAt: number;
  updatedAt: number;
  config: MatchConfig;
  players: Record<Player, PlayerProfile | null>;
  /** Seat of the profile that created the match ('white' when a non-playing dealer hosts; see `dealer`). */
  hostSeat: Player;
  /** Public profile of the dealer when the table is dealer-hosted (no host seat). */
  dealer?: PlayerProfile;
  /** Table layout: side of the home boards as seen from `hostSeat`. Missing = 'left'. */
  homeSide?: HomeSide;
  actions: Action[];
  match: MatchState;
  chat: ChatMessage[];
  /**
   * Optional custom starting state (e.g. a set-up position). When present, `actions` replay from
   * it instead of from a fresh match. Absent for ordinary matches.
   */
  initialMatch?: MatchState;
  /** Randomness source and mode the host declared (`options.randomness` on the table). */
  randomness?: { provider: string; mode?: RandomnessMode };
  /** Unattended play (`options.autopilot` on the table): games start when both are ready. */
  autopilot?: boolean;
  /** Readiness for the next game by colour (table flow, not match state). */
  ready?: Record<Player, boolean>;
  /** Randomness attribution per action index; see `ActionMeta`. */
  actionMeta?: Record<number, ActionMeta>;
  /** Proofs for the randomness batches used by this match. */
  entropyAudit?: EntropyAudit;
}
