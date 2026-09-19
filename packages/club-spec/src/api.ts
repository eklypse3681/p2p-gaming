/**
 * The club interface.
 *
 * Everything a client needs from a club, and nothing about how a club is built. The hosted
 * platform, somebody's own server and a contract-backed adapter all satisfy this, and the
 * conformance suite in this package is what lets each of them prove it.
 *
 * Three rules hold for every implementation:
 *
 *  1. **Declare before you serve.** `info()` is answerable without authentication, and an
 *     operation the capabilities do not claim must fail with `unsupported` rather than
 *     half-work.
 *  2. **Every mutation is idempotent.** Each carries an `opId` chosen by the caller. Repeating
 *     an operation with the same id returns the original result and moves no chips a second
 *     time. The same id with different arguments is a `conflict`.
 *  3. **Chips are conserved.** Across any sequence of operations, what members hold plus what
 *     is staked plus what was raked equals what the club issued. An implementation that cannot
 *     guarantee that refuses the operation rather than guessing.
 */

import type {
  ChipRequest,
  ClubIdentity,
  ClubMember,
  LobbyState,
  LobbyTable,
  MemberStatement,
  PlayerProfile,
  Room,
} from '@bgf/protocol';
import type { ClubCapabilities } from './capabilities.js';
import type { MatchCriteria, MatchEvent, MatchTicket } from './matching.js';
import type { SeatCommitment, Settlement, TableTally } from './settlement.js';

/** Public description of a club, answerable to anyone who can reach it. */
export interface ClubInfo {
  identity: ClubIdentity;
  capabilities: ClubCapabilities;
  /** Rooms and templates on offer, so a lobby can be drawn before joining. */
  rooms: Room[];
  /** Members currently online, for a "42 playing now" line. */
  online: number;
}

/** Proof that a caller holds the key they claim. Issued by `authenticate`. */
export interface ClubSession {
  member: ClubMember;
  /** Opaque to the client; implementations put whatever they need here. */
  token: string;
  expiresAt?: number;
}

export interface AuthRequest {
  profile: PlayerProfile;
  /** Signature over the club's challenge, proving the private key. */
  signature: string;
  nonce: string;
  /** Required where membership is by invite. */
  invite?: string;
  /** Spec version the client was written against. */
  spec: number;
}

/** Every mutating call carries one of these. */
export interface Idempotent {
  opId: string;
}

export interface SitRequest extends Idempotent {
  /** Sit at an existing table, or ask for a new one from a template. */
  tableId?: string;
  templateId?: string;
  /** Chips to stake. Bounded by the template and by the member's balance. */
  buyIn?: number;
}

/**
 * A seat, and the authority to take it.
 *
 * `code` is how the client reaches the table itself; the table admits nobody who cannot prove
 * the key named in the commitment, so a leaked code is worthless.
 */
export interface SeatGrant {
  tableId: string;
  code: string;
  game: string;
  seat: number;
  commitment: SeatCommitment;
}

export interface LeaveRequest extends Idempotent {
  tableId: string;
}

export interface TransferRequest extends Idempotent {
  to: string;
  amount: number;
  note?: string;
}

export interface ChipRequestInput extends Idempotent {
  amount: number;
  note?: string;
}

export interface Receipt {
  opId: string;
  /** Balance after the operation, where the club tracks one for the caller. */
  balance?: number;
  seq?: number;
  at: number;
}

/** Everything a member is told about without asking. */
export type ClubUpdate =
  | { kind: 'lobby'; lobby: LobbyState }
  | { kind: 'balance'; balance: number }
  | { kind: 'table'; table: LobbyTable }
  | { kind: 'match'; event: MatchEvent }
  | { kind: 'settled'; settlement: Settlement }
  | { kind: 'chip-request'; request: ChipRequest }
  | { kind: 'chat'; from: { id: string; name: string }; text: string; at: number }
  | { kind: 'closed'; reason: string };

export type Unsubscribe = () => void;

/**
 * What a club does. Implementations throw `ClubError` with a code from the shared vocabulary.
 */
export interface ClubApi {
  /** Unauthenticated. Identity, capabilities, what is on offer. */
  info(): Promise<ClubInfo>;

  /** Step one of authentication: ask for a challenge to sign. */
  challenge(profileId: string): Promise<{ nonce: string; clubId: string }>;

  /** Step two: present the signature. Joins the club where membership is open. */
  authenticate(req: AuthRequest): Promise<ClubSession>;

  lobby(session: ClubSession): Promise<LobbyState>;

  /** Live updates for this member until unsubscribed. */
  subscribe(session: ClubSession, listener: (update: ClubUpdate) => void): Unsubscribe;

  /** Stake chips and take a seat. */
  sit(session: ClubSession, req: SitRequest): Promise<SeatGrant>;

  /** Stand up. Returns once the club has settled, which may be immediate or deferred. */
  leave(session: ClubSession, req: LeaveRequest): Promise<Settlement | null>;

  /**
   * Submit what happened at a table. Called by whoever ran it, not by players.
   * In `immediate` mode a club may also accept per-hand tallies; in `deferred` mode this is
   * the only thing that moves chips.
   */
  settle(tally: TableTally): Promise<Settlement>;

  /** Optional, per capabilities. Each throws `unsupported` when not offered. */
  statement(
    session: ClubSession,
    opts?: { since?: number; limit?: number },
  ): Promise<MemberStatement>;
  transfer(session: ClubSession, req: TransferRequest): Promise<Receipt>;
  requestChips(session: ClubSession, req: ChipRequestInput): Promise<Receipt>;
  chat(session: ClubSession, text: string): Promise<void>;

  /** Matchmaking, per capabilities. */
  queue(session: ClubSession, criteria: MatchCriteria, req: Idempotent): Promise<MatchTicket>;
  unqueue(session: ClubSession, ticketId: string): Promise<void>;

  /** Release resources held for this caller. */
  disconnect(session: ClubSession): Promise<void>;
}
