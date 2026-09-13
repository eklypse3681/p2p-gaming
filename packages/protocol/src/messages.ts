import type {
  Action,
  CubeOwner,
  MatchConfig,
  MatchState,
  Play,
  Player,
  RelPoint,
  ResultKind,
} from '@bgf/engine';

export const PROTOCOL_VERSION = 1;

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
 * The whole persisted state of a match. Both peers keep a copy so either can resume as host.
 * `actions` is the authoritative log; `match` is derived from it (and cached for convenience).
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
  /** Seat of the profile that created the match. */
  hostSeat: Player;
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
}

export type ClientMessage =
  | {
      type: 'hello';
      protocol: number;
      profile: PlayerProfile;
      /** When resuming, the guest offers its own copy so the newest one wins. */
      snapshot?: MatchSnapshot;
    }
  /** Answer to a `challenge`: base64url signature over `challengeBytes({ matchId, profileId, nonce })`. */
  | { type: 'auth'; signature: string }
  | { type: 'start-game' }
  | { type: 'opening-roll' }
  | { type: 'roll' }
  | { type: 'play'; play: Play }
  | { type: 'double' }
  | { type: 'take' }
  | { type: 'drop' }
  | { type: 'offer-resign'; stakes: ResultKind }
  | { type: 'accept-resign' }
  | { type: 'decline-resign' }
  // ---- free-board mode only (server maps them to free-* actions) ----
  | { type: 'free-roll' }
  | { type: 'free-move'; checker: Player; from: RelPoint; to: RelPoint }
  | { type: 'free-cube'; value: number; owner: CubeOwner }
  | { type: 'free-reset' }
  | { type: 'free-result'; winner: Player; kind: ResultKind }
  /** Non-authoritative: provisional sub-moves so the opponent can watch the turn being built. */
  | { type: 'preview'; play: Play }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'bye' };

export type RejectReason = 'full' | 'protocol' | 'wrong-match' | 'bad-hello' | 'unauthorized';

export type ServerMessage =
  /** Prove you hold the key for this seat: sign `challengeBytes({ matchId, profileId, nonce })`. */
  | { type: 'challenge'; nonce: string; matchId: string }
  | { type: 'welcome'; seat: Player; snapshot: MatchSnapshot }
  | { type: 'rejected'; reason: RejectReason; message: string }
  /** Full snapshot after every change; `action` says what caused it (for animation). */
  | { type: 'state'; snapshot: MatchSnapshot; action?: Action; by?: Player }
  | { type: 'preview'; seat: Player; play: Play }
  | { type: 'presence'; seat: Player; connected: boolean }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number };

export function isClientMessage(m: unknown): m is ClientMessage {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}

export function isServerMessage(m: unknown): m is ServerMessage {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
