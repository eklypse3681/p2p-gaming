/**
 * What this club chooses to be, and the capabilities that follow from it.
 *
 * The spec makes a club an interface; a policy is the set of answers this implementation gives.
 * It lives in the club's own state so it survives a restart, and the runtime may override parts
 * of it (custody in particular, which is a deployment fact rather than a club one).
 */

import type {
  ClubCapabilities,
  ClubCustody,
  MembershipPolicy,
  SettlementMode,
  StatementDepth,
} from '@bgf/club-spec';
import { CLUB_SPEC_VERSION } from '@bgf/club-spec';
import { PLATFORM_MIN_RAKE_BPS } from '../platform.js';

export interface ClubPolicy {
  membership: MembershipPolicy;
  joinGrant: number | null;
  settlement: SettlementMode;
  commitmentTtlMs: number;
  matchmaking: boolean;
  transfers: boolean;
  chipRequests: boolean;
  chat: boolean;
  tournaments: boolean;
  statements: StatementDepth;
  ratingScale: string | null;
  custody: ClubCustody;
}

export const DEFAULT_COMMITMENT_TTL_MS = 10 * 60_000;

/** What a club is unless it says otherwise: invite-only, settling every hand, full books. */
export function defaultPolicy(): ClubPolicy {
  return {
    membership: 'invite',
    joinGrant: null,
    settlement: 'immediate',
    commitmentTtlMs: DEFAULT_COMMITMENT_TTL_MS,
    matchmaking: true,
    transfers: true,
    chipRequests: true,
    chat: true,
    tournaments: false,
    statements: 'full',
    ratingScale: null,
    custody: { kind: 'self-hosted', operator: 'this club' },
  };
}

export function resolvePolicy(...layers: Array<Partial<ClubPolicy> | undefined>): ClubPolicy {
  let policy = defaultPolicy();
  for (const layer of layers) {
    if (layer) policy = { ...policy, ...layer };
  }
  if (!Number.isInteger(policy.commitmentTtlMs) || policy.commitmentTtlMs <= 0) {
    policy.commitmentTtlMs = DEFAULT_COMMITMENT_TTL_MS;
  }
  return policy;
}

export function capabilitiesFor(policy: ClubPolicy): ClubCapabilities {
  return {
    spec: CLUB_SPEC_VERSION,
    settlement: policy.settlement,
    ...(policy.settlement === 'deferred' ? { commitmentTtlMs: policy.commitmentTtlMs } : {}),
    membership: policy.membership,
    joinGrant: policy.joinGrant,
    matchmaking: policy.matchmaking,
    transfers: policy.transfers,
    chipRequests: policy.chipRequests,
    chat: policy.chat,
    tournaments: policy.tournaments,
    statements: policy.statements,
    minRakeBasisPoints: PLATFORM_MIN_RAKE_BPS,
    ratingScale: policy.ratingScale,
    custody: policy.custody,
  };
}
