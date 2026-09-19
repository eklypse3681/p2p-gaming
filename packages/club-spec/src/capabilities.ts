/**
 * What a club implementation declares about itself.
 *
 * A club is an interface, not a product. The hosted platform, someone's own server and a
 * smart contract are all legal implementations, and they differ in what they can do and in
 * who holds the chips. Both differences are declared up front so the client adapts instead
 * of discovering them through failures, and so a player is told who they are trusting before
 * they put chips on a table — the same courtesy tables already pay about who can see cards.
 *
 * The public play-money world is not a separate system sitting beside clubs. It is a club:
 * open membership, a grant on joining, matchmaking across everyone online. Building it that
 * way is what keeps this interface honest, because the flagship is its own first consumer.
 */

export const CLUB_SPEC_VERSION = 1;

/**
 * Who holds the chips. This is the club-level twin of a table's trust disclosure, and it is
 * the first thing shown to a member deciding whether to join.
 */
export type ClubCustody =
  /** A named operator runs the books on their own infrastructure. */
  | { kind: 'hosted'; operator: string; url?: string }
  /** A member of the community runs it themselves. Trust is personal. */
  | { kind: 'self-hosted'; operator: string; contact?: string }
  /** Balances live in a contract; the club server is an adapter that reads and writes it. */
  | { kind: 'contract'; chain: string; address: string; explorer?: string }
  /** In-process, for development, tests and the simulator. Never for real chips. */
  | { kind: 'local'; note?: string };

/**
 * When chip movements reach the ledger.
 *
 * `immediate` settles every hand as it finishes: simplest, and what an in-process ledger does.
 * `deferred` authorises a stake when a player sits and moves the net once when they leave or
 * when a period closes, which is what makes a ledger with slow or costly writes — a contract,
 * a remote service, a rate-limited API — viable without a hand ever waiting on it.
 */
export type SettlementMode = 'immediate' | 'deferred';

/** How a stranger becomes a member. */
export type MembershipPolicy =
  /** Anyone with a key may join and play at once. The play-money world works this way. */
  | 'open'
  /** Anyone may ask; an admin approves. */
  | 'request'
  /** A signed invite is required. */
  | 'invite';

/** How much of a member's history an implementation can produce. */
export type StatementDepth = 'full' | 'summary' | 'none';

export interface ClubCapabilities {
  /** Spec version this implementation was written against. */
  spec: number;
  settlement: SettlementMode;
  /**
   * `deferred` only: how long a seat commitment stays valid before it expires and the stake
   * returns to the member. Tables must settle within this window.
   */
  commitmentTtlMs?: number;
  membership: MembershipPolicy;
  /** Chips handed to a new member on joining, or null if they arrive with nothing. */
  joinGrant: number | null;
  /** The club can queue members and form tables for them. */
  matchmaking: boolean;
  /** Member-to-member chip transfers. */
  transfers: boolean;
  /** Members may ask an admin for chips. */
  chipRequests: boolean;
  /** Lobby chat relayed by the club. */
  chat: boolean;
  tournaments: boolean;
  statements: StatementDepth;
  /** Minimum rake this club enforces, in basis points, or null if it takes none. */
  minRakeBasisPoints: number | null;
  /**
   * If the club rates its members, the name of the scale it uses. Ratings are computed by the
   * club and are opaque to the client, which only ever displays them.
   */
  ratingScale: string | null;
  custody: ClubCustody;
}

export type OptionalOperation =
  'transfer' | 'request-chips' | 'chat' | 'tournaments' | 'statement' | 'matchmaking';

export function isSupported(caps: ClubCapabilities, op: OptionalOperation): boolean {
  switch (op) {
    case 'transfer':
      return caps.transfers;
    case 'request-chips':
      return caps.chipRequests;
    case 'chat':
      return caps.chat;
    case 'tournaments':
      return caps.tournaments;
    case 'statement':
      return caps.statements !== 'none';
    case 'matchmaking':
      return caps.matchmaking;
  }
}

/** One line of plain language per property, for the club's disclosure panel. */
export function describeCustody(custody: ClubCustody): { title: string; detail: string } {
  switch (custody.kind) {
    case 'hosted':
      return {
        title: `Chips held by ${custody.operator}`,
        detail: `${custody.operator} runs this club's books. Your balance is what their records say it is.`,
      };
    case 'self-hosted':
      return {
        title: `Chips held by ${custody.operator}`,
        detail: `${custody.operator} runs this club on their own machine. You are trusting them personally, as you would in a home game.`,
      };
    case 'contract':
      return {
        title: 'Chips held by a contract',
        detail: `Balances live in a contract on ${custody.chain}. Nobody, including the club, can move them outside its rules.`,
      };
    case 'local':
      return {
        title: 'Chips held in this process',
        detail:
          custody.note ?? 'A local club for development and testing. These chips are not real.',
      };
  }
}

export function describeSettlement(caps: ClubCapabilities): string {
  if (caps.settlement === 'immediate') return 'Chips move after every hand.';
  const minutes = Math.round((caps.commitmentTtlMs ?? 0) / 60_000);
  return minutes > 0
    ? `Chips are staked when you sit and settle when you leave, within ${minutes} minutes.`
    : 'Chips are staked when you sit and settle when you leave.';
}

export function describeMembership(caps: ClubCapabilities): string {
  const grant = caps.joinGrant ? ` You start with ${caps.joinGrant}.` : '';
  switch (caps.membership) {
    case 'open':
      return `Anyone can join and play straight away.${grant}`;
    case 'request':
      return `Ask to join and an admin lets you in.${grant}`;
    case 'invite':
      return `You need an invite from a member.${grant}`;
  }
}
