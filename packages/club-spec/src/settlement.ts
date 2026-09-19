/**
 * Staking chips onto a table and settling what comes back.
 *
 * The problem this solves: a ledger may be slow or expensive to write — a contract with block
 * times, a remote service, anything rate-limited — while a hand must never wait on it. So
 * authorisation and settlement are separated. The club authorises a stake when a member sits,
 * the table plays as many hands as it likes without touching the ledger, and the net movement
 * reaches the books once, when the member leaves or the window closes.
 *
 * Two properties make that safe. A member can never lose more than the stake they committed,
 * because the commitment is a ceiling the club enforces. And a tally must conserve chips: the
 * sum of what everyone won and lost, plus the rake, is zero. A club that cannot verify a tally
 * rejects it, and the commitments expire back to their owners.
 */

/** A club's authorisation for one member to put `amount` chips on one table. */
export interface SeatCommitment {
  tableId: string;
  memberId: string;
  /** Chips staked, in minor units. The member cannot lose more than this at this table. */
  amount: number;
  /** Unique per commitment; a tally naming a stale nonce is rejected. */
  nonce: string;
  issuedAt: number;
  /** After this the club may reclaim the stake and free the seat. */
  expiresAt: number;
  /** The club's signature over the commitment, so the table can verify it offline. */
  signature: string;
}

/** What one member did at a table over the hands covered by a tally. */
export interface TallyEntry {
  memberId: string;
  /** Signed net movement in minor units: positive won, negative lost. */
  net: number;
  /** Chips this member contributed to the rake, always zero or more. */
  rake: number;
}

/**
 * The result of a session at a table, submitted once by whoever ran it.
 *
 * `entries` must conserve: the sum of every `net` plus the total rake is zero. No entry may
 * lose more than that member's live commitment. `handCount` and `transcriptHash` let a club
 * cross-check against the hand records it keeps, and let a member dispute later.
 */
export interface TableTally {
  tableId: string;
  /** Idempotency key. Submitting the same tally twice must move chips once. */
  opId: string;
  /** The commitment nonces this tally settles, one per seated member. */
  nonces: string[];
  entries: TallyEntry[];
  /** Total rake taken, in minor units. Must equal the sum of entry rakes. */
  rake: number;
  handCount: number;
  /** Hash over the hands this tally covers, for dispute resolution. */
  transcriptHash?: string;
  from: number;
  to: number;
}

export interface Settlement {
  tableId: string;
  /** Balances after settling, keyed by member id. */
  balances: Record<string, number>;
  /** What each member's stake became. */
  entries: TallyEntry[];
  rake: number;
  settledAt: number;
  /** Ledger sequence this landed at, where the implementation has one. */
  seq?: number;
}

export type TallyProblem =
  | { code: 'not-conserved'; delta: number }
  | { code: 'rake-mismatch'; declared: number; summed: number }
  | { code: 'negative-rake'; memberId: string }
  | { code: 'exceeds-commitment'; memberId: string; net: number; commitment: number }
  | { code: 'unknown-commitment'; nonce: string }
  | { code: 'duplicate-member'; memberId: string };

/**
 * Check a tally against the commitments it claims to settle. Pure, so every implementation
 * and the conformance suite agree on what a valid tally is.
 */
export function checkTally(
  tally: TableTally,
  commitments: readonly SeatCommitment[],
): TallyProblem[] {
  const problems: TallyProblem[] = [];
  const byNonce = new Map(commitments.map((c) => [c.nonce, c]));
  const byMember = new Map(commitments.map((c) => [c.memberId, c]));

  for (const nonce of tally.nonces) {
    if (!byNonce.has(nonce)) problems.push({ code: 'unknown-commitment', nonce });
  }

  const seen = new Set<string>();
  let summedRake = 0;
  let summedNet = 0;
  for (const entry of tally.entries) {
    if (seen.has(entry.memberId))
      problems.push({ code: 'duplicate-member', memberId: entry.memberId });
    seen.add(entry.memberId);
    if (entry.rake < 0) problems.push({ code: 'negative-rake', memberId: entry.memberId });
    summedRake += entry.rake;
    summedNet += entry.net;
    const commitment = byMember.get(entry.memberId);
    const staked = commitment?.amount ?? 0;
    if (entry.net < 0 && -entry.net > staked) {
      problems.push({
        code: 'exceeds-commitment',
        memberId: entry.memberId,
        net: entry.net,
        commitment: staked,
      });
    }
  }

  if (summedRake !== tally.rake) {
    problems.push({ code: 'rake-mismatch', declared: tally.rake, summed: summedRake });
  }
  const delta = summedNet + tally.rake;
  if (delta !== 0) problems.push({ code: 'not-conserved', delta });

  return problems;
}

export function tallyIsValid(tally: TableTally, commitments: readonly SeatCommitment[]): boolean {
  return checkTally(tally, commitments).length === 0;
}
