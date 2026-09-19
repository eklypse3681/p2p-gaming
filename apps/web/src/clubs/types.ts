import type { ClubRejectReason, LobbyState, MemberStatement, PlayerProfile } from '@bgf/protocol';
import type {
  ClubCapabilities,
  ClubInfo,
  MatchCriteria,
  MatchTicket,
  SeatCommitment,
  Settlement,
} from '@bgf/club-spec';

/**
 * CONTRACT — what the Clubs screens consume.
 *
 * A club is an interface now (`ClubApi` in `@bgf/club-spec`), and implementations differ in
 * what they support and in who holds the chips. The screens never call a club directly: they
 * read this store, which `ClubApiClient` fills from any `ClubApi`, and they consult
 * `state.info.capabilities` before offering anything optional.
 */

export type ClubStatus = 'connecting' | 'joined' | 'rejected' | 'disconnected';

export interface ClubSeat {
  tableId: string;
  code: string;
  game: string;
  seat: number;
  /** Chips staked on this table. */
  buyIn: number;
  /** Present when the club settles `deferred`: the stake is held until this is settled. */
  commitment?: SeatCommitment;
}

export interface ClubChatMessage {
  from: { id: string; name: string };
  text: string;
  at: number;
}

export interface ClubClientState {
  status: ClubStatus;
  rejectReason: ClubRejectReason | null;
  /** Identity, capabilities and rooms, as the club declares them. Null until it answers. */
  info: ClubInfo | null;
  lobby: LobbyState | null;
  statement: MemberStatement | null;
  /** Chips free to stake. Excludes anything committed to a table. */
  balance: number | null;
  /** Chips committed to tables and not yet settled. Always 0 for immediate-settlement clubs. */
  staked: number;
  chat: ClubChatMessage[];
  error: { code: string; message: string; at: number } | null;
  /** The seat the club last handed us (cleared by `leave`). */
  seat: ClubSeat | null;
  /** Live matchmaking ticket, if we are queued. */
  ticket: MatchTicket | null;
  /** Set when a queue ends, so the screen can say why. */
  queueEnded: { reason: string; at: number } | null;
  /** The most recent settlement the club reported back to us. */
  settlement: Settlement | null;
}

export interface ClubClientApi {
  readonly profile: PlayerProfile;
  getState(): ClubClientState;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  sit(opts: { tableId?: string; templateId?: string; buyIn?: number }): void;
  leave(tableId: string): void;
  statement(): void;
  transfer(to: string, amount: number, note?: string): void;
  requestChips(amount: number, note?: string): void;
  chat(text: string): void;
  /** Matchmaking, offered only when `capabilities.matchmaking`. */
  queue(criteria: MatchCriteria): void;
  unqueue(ticketId?: string): void;
  close(): void;
}

/**
 * What to assume about a club that has not declared itself — an older runtime, or the moment
 * before `info()` answers. Permissive, so nothing that used to work disappears, and honest
 * about the one thing we cannot guess: who holds the chips.
 */
export const LEGACY_CAPABILITIES: ClubCapabilities = {
  spec: 0,
  settlement: 'immediate',
  membership: 'invite',
  joinGrant: null,
  matchmaking: false,
  transfers: true,
  chipRequests: true,
  chat: true,
  tournaments: false,
  statements: 'full',
  minRakeBasisPoints: null,
  ratingScale: null,
  custody: { kind: 'self-hosted', operator: 'this club' },
};

export function capabilitiesOf(state: ClubClientState | null | undefined): ClubCapabilities {
  return state?.info?.capabilities ?? LEGACY_CAPABILITIES;
}
