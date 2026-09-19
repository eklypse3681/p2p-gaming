/**
 * Seat commitments: the club's signed promise that a member has staked chips on a table.
 *
 * A table can verify one offline, and it is the ceiling on what its holder can lose there. A
 * commitment is consumed by the tally that settles it, or expires back to its owner.
 */

import type { SeatCommitment } from '@bgf/club-spec';
import type { Signer } from '@bgf/protocol';
import { bytesToBase64Url, randomNonce, verify, base64UrlToBytes } from '@bgf/protocol';
import { utf8Bytes } from '@bgf/table';
import { canonicalJson } from './canonical.js';
import type { ClubState } from './state.js';

export interface CommitmentRecord extends SeatCommitment {
  /** Spent by a tally, released on leaving, or reclaimed after expiry. */
  settled?: boolean;
  settledAt?: number;
  reason?: 'settled' | 'left' | 'expired';
}

export function commitmentBytes(body: Omit<SeatCommitment, 'signature'>): Uint8Array {
  return utf8Bytes(`p2p-gaming seat commitment v1\n${canonicalJson(body)}`);
}

export async function signCommitment(
  body: Omit<SeatCommitment, 'signature'>,
  signer: Signer,
): Promise<SeatCommitment> {
  return { ...body, signature: bytesToBase64Url(await signer(commitmentBytes(body))) };
}

/** Verify a commitment against the club's public key, as a table would before seating anyone. */
export async function verifyCommitment(
  commitment: SeatCommitment,
  clubPublicKey: string,
): Promise<boolean> {
  const { signature, ...body } = commitment;
  try {
    return await verify(clubPublicKey, commitmentBytes(body), base64UrlToBytes(signature));
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return randomNonce(12);
}

export function commitmentsOf(state: ClubState): CommitmentRecord[] {
  return state.commitments ?? [];
}

export function liveCommitments(state: ClubState, now: number): CommitmentRecord[] {
  return commitmentsOf(state).filter((c) => !c.settled && c.expiresAt > now);
}

export function findCommitment(state: ClubState, nonce: string): CommitmentRecord | undefined {
  return commitmentsOf(state).find((c) => c.nonce === nonce);
}

/** Live commitments for one member: what their balance has already promised elsewhere. */
export function encumbered(state: ClubState, memberId: string, now: number): number {
  return liveCommitments(state, now)
    .filter((c) => c.memberId === memberId)
    .reduce((a, c) => a + c.amount, 0);
}

export function addCommitment(state: ClubState, commitment: SeatCommitment): ClubState {
  return { ...state, commitments: [...commitmentsOf(state), { ...commitment }] };
}

export function closeCommitments(
  state: ClubState,
  nonces: readonly string[],
  reason: CommitmentRecord['reason'],
  now: number,
): ClubState {
  const wanted = new Set(nonces);
  return {
    ...state,
    commitments: commitmentsOf(state).map((c) =>
      wanted.has(c.nonce) && !c.settled ? { ...c, settled: true, settledAt: now, reason } : c,
    ),
  };
}

/** Commitments that have run out of time, so their stakes can be reclaimed. */
export function expiredCommitments(state: ClubState, now: number): CommitmentRecord[] {
  return commitmentsOf(state).filter((c) => !c.settled && c.expiresAt <= now);
}

/** Keep the list from growing for ever: settled commitments are only needed briefly. */
export function pruneCommitments(state: ClubState, now: number, keepMs = 60 * 60_000): ClubState {
  const commitments = commitmentsOf(state).filter(
    (c) => !c.settled || (c.settledAt ?? c.issuedAt) > now - keepMs,
  );
  return commitments.length === commitmentsOf(state).length ? state : { ...state, commitments };
}
