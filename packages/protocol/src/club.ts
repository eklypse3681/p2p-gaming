import type { PlayerProfile } from './messages.js';

/**
 * CONTRACT — the club channel. A club is a Node runtime (`@bgf/dealer`) with its own keypair
 * that keeps a member roster, a signed chip ledger, and rooms of table templates. Members reach it
 * over any `Transport` (PeerJS id derived from the club id, namespace `club-v1`), authenticate
 * with the same keyed challenge as tables, and talk this protocol. Tables themselves are joined
 * exactly as today, by room code; the club only hands out the code after moving chips.
 */

export const CLUB_PROTOCOL_VERSION = 1;

export interface ClubCurrency {
  /** Short code shown next to amounts, e.g. "chips", "🪙", "USDC". */
  code: string;
  name: string;
  /** Decimal places for display; amounts on the wire are integers in minor units. */
  decimals: number;
}

export interface ClubIdentity {
  /** base64url SHA-256 of the club public key. */
  id: string;
  name: string;
  publicKey: string;
  currency: ClubCurrency;
  createdAt: number;
  /** Free text shown in the lobby. */
  tagline?: string;
}

export type MemberRole = 'owner' | 'admin' | 'member';
export type MemberStatus = 'active' | 'pending' | 'banned';

export interface ClubMember {
  id: string;
  name: string;
  avatar?: string;
  publicKey: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: number;
}

export interface TableStakes {
  /** Chips per point (minor units). 0 = a points-only table (nothing moves in the ledger). */
  chipsPerPoint: number;
  /** Optional buy-in bounds in minor units; the club moves chips to the table on sit. */
  buyIn?: { min: number; max: number; default: number };
  /**
   * Rake taken from every hand's winners, in basis points of the chips that changed hands
   * (capped per hand). Raked chips are burned: they leave the club's economy for good, which is
   * how club reserves dissipate and clubs buy more chips from the platform. The platform
   * enforces a minimum; templates below it are refused.
   */
  rake?: { basisPoints: number; cap?: number };
}

export interface TableTemplate {
  id: string;
  name: string;
  game: string;
  /** Game config (e.g. OFC `TableConfig`); the runtime normalises it with the game definition. */
  config: unknown;
  seats: number;
  stakes: TableStakes;
  randomness?: { mode: 'per-draw' | 'seeded' | 'beacon'; provider: string };
  /** Keep one instance always open in the lobby. */
  alwaysOpen?: boolean;
}

export interface Room {
  id: string;
  name: string;
  description?: string;
  templates: TableTemplate[];
}

export type LedgerKind =
  | 'mint' // platform certificate → house reserve (the only way chips enter a club)
  | 'burn' // rake / entry fees destroyed (the only way chips leave; lines are all negative)
  | 'grant' // club credits a member (deposit, comp)
  | 'redeem' // club debits a member (withdrawal)
  | 'buy-in' // member → table
  | 'cash-out' // table → member
  | 'result' // hand/game result inside a table (net per member)
  | 'transfer' // member → member
  | 'fee' // club takes a fee
  | 'adjust'; // admin correction

export interface LedgerEntry {
  seq: number;
  at: number;
  kind: LedgerKind;
  /** Member ids and signed amounts in minor units; a single entry balances to zero across
   *  members + the house (`house` is the club's own account, e.g. for grants and fees). */
  lines: Array<{ account: string | 'house'; amount: number }>;
  ref?: {
    tableId?: string;
    hand?: number;
    game?: string;
    note?: string;
    by?: string;
    /** `mint`: the platform certificate token that backs the entry. */
    certificate?: string;
    /** `burn` for rake: basis points applied and the chips that changed hands. */
    basisPoints?: number;
    moved?: number;
  };
  prevHash: string;
  hash: string;
  /** Club signature over `hash`. */
  signature: string;
}

/** One row of a member's balance history, ready to display. */
export interface StatementLine {
  seq: number;
  at: number;
  kind: LedgerKind;
  /** Signed change to the member's balance. */
  amount: number;
  /** Balance after this entry. */
  balance: number;
  /** Plain description, e.g. "Buy-in at Pineapple table", "Hand 12 result", "Grant from the club". */
  description: string;
  ref?: LedgerEntry['ref'];
}

export interface MemberStatement {
  memberId: string;
  balance: number;
  /** The member's own entries (each line touching their account), newest last. */
  entries: LedgerEntry[];
  /** The same entries flattened into a readable history with running balances (always sent by the club). */
  history?: StatementLine[];
  /** Latest ledger hash the statement covers, signed by the club. */
  head: { seq: number; hash: string; signature: string };
}

export interface LobbyTable {
  id: string;
  roomId: string;
  templateId: string;
  templateName: string;
  game: string;
  code: string;
  seats: Array<{ name: string; memberId: string } | null>;
  status: 'open' | 'playing' | 'closing';
  /** Chips currently on the table per seat (minor units). */
  stacks: number[];
  summary?: unknown;
}

export interface LobbyState {
  club: ClubIdentity;
  rooms: Room[];
  tables: LobbyTable[];
  me: { member: ClubMember; balance: number };
  /** Members online right now (ids). */
  online: string[];
  /** Club reserve (house balance); only sent to the owner and admins. */
  reserve?: number;
}

/**
 * A platform certificate: the platform (Steve) sells chips to clubs; the club mints them into
 * its reserve by presenting the certificate, which is signed by the platform key and single-use.
 */
export interface PlatformCertificate {
  clubId: string;
  /** Currency code the chips are denominated in. */
  currency: string;
  /** Minor units. */
  amount: number;
  nonce: string;
  issuedAt: number;
  expiresAt?: number;
}

/**
 * Methods reachable through the `call` envelope. These mirror `ClubApi` in `@bgf/club-spec`
 * one for one, so a remote club and an in-process one are the same interface to a caller.
 */
export type ClubCallMethod =
  | 'info'
  | 'lobby'
  | 'sit'
  | 'leave'
  | 'settle'
  | 'statement'
  | 'transfer'
  | 'requestChips'
  | 'chat'
  | 'queue'
  | 'unqueue';

export type ClubClientMessage =
  | { type: 'hello'; protocol: number; profile: PlayerProfile; invite?: string; spec?: number }
  | { type: 'auth'; signature: string }
  | { type: 'lobby' }
  | { type: 'sit'; tableId?: string; templateId?: string; buyIn?: number }
  | { type: 'leave'; tableId: string }
  | { type: 'statement' }
  | { type: 'transfer'; to: string; amount: number; note?: string }
  | { type: 'request-chips'; amount: number; note?: string }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'bye' }
  /**
   * A correlated request. Everything the spec adds rides this one envelope rather than a new
   * message per operation, so the wire stays small and old clients keep working untouched.
   */
  | { type: 'call'; id: string; method: ClubCallMethod; params?: unknown };

export type ClubRejectReason =
  | 'protocol'
  /** The client was written against a club spec this club cannot serve. */
  | 'version'
  | 'unauthorized'
  | 'not-a-member'
  | 'banned'
  | 'pending';

/** A member's request for chips; admins resolve it out of band (console/runtime). */
export interface ChipRequest {
  id: string;
  memberId: string;
  amount: number;
  note?: string;
  at: number;
  status: 'pending' | 'granted' | 'declined';
  resolvedBy?: string;
  resolvedAt?: number;
}

export type ClubServerMessage =
  | { type: 'challenge'; nonce: string; clubId: string }
  /** Acknowledges a `request-chips`; later status changes are sent the same way. */
  | { type: 'chip-request'; request: ChipRequest }
  | { type: 'welcome'; lobby: LobbyState }
  | { type: 'rejected'; reason: ClubRejectReason; message: string }
  | { type: 'lobby'; lobby: LobbyState }
  /** Answer to `sit`: join this table by code; the club has moved `buyIn` chips onto it. */
  | { type: 'seat'; tableId: string; code: string; game: string; seat: number; buyIn: number }
  | { type: 'statement'; statement: MemberStatement }
  | { type: 'balance'; balance: number }
  | { type: 'chat'; from: { id: string; name: string }; text: string; at: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number }
  /** The answer to a `call`, carrying either the value or a code from the spec's vocabulary. */
  | { type: 'result'; id: string; ok: true; value?: unknown }
  | { type: 'result'; id: string; ok: false; code: string; message: string }
  /** A `ClubUpdate` from `@bgf/club-spec`; opaque here so the protocol stays dependency-free. */
  | { type: 'update'; update: unknown };

/** Invite token payload (signed by the club): lets a non-member join as `pending` or `member`. */
export interface ClubInvite {
  clubId: string;
  clubName: string;
  /** PeerJS-reachable club address (the club id is enough with the default namespace). */
  address: string;
  role: MemberRole;
  autoApprove: boolean;
  expiresAt?: number;
  maxUses?: number;
  nonce: string;
}

/** The bytes a member signs to enter a club: deterministic, domain-separated from seats. */
export function clubChallengeBytes(c: {
  clubId: string;
  profileId: string;
  nonce: string;
}): Uint8Array {
  const text = `p2p-gaming club v1\n${c.clubId}\n${c.profileId}\n${c.nonce}`;
  return new TextEncoder().encode(text);
}
