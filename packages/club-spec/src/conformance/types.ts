/**
 * What an implementation hands the conformance suite so the suite can drive it.
 *
 * The suite knows nothing about how a club stores chips, admits members or reaches its tables.
 * It is given keys it can sign with, a way to put chips into a member's hands, and a template
 * to sit at; everything else it discovers from `info()`.
 */

import type { PlayerProfile, Signer } from '@bgf/protocol';
import type { ClubApi } from '../api.js';
import type { MatchPolicy } from '../matching.js';

export interface ConformanceMember {
  profile: PlayerProfile;
  /** Signs the club's challenge bytes with this member's private key. */
  signer: Signer;
}

export interface ConformanceTarget {
  club: ClubApi;
  /**
   * Put chips into a member's balance, however this club issues them. Called before any
   * check that needs a funded player.
   */
  fund(memberId: string, amount: number): Promise<void>;
  /** At least three, all already permitted to authenticate (invited, listed, or walk-ins). */
  members: ConformanceMember[];
  /**
   * Profiles the club should refuse. Only meaningful where membership is not `open`; the
   * suite skips the check when this is absent.
   */
  strangers?: ConformanceMember[];
  /** Required for every check that seats anyone. Without it those checks are skipped. */
  templateId?: string;
  /** Buy-in the template accepts. Defaults to whatever the club chooses. */
  buyIn?: number;
  /** Ban a member, so the suite can prove `banned` is reported. Skipped when absent. */
  ban?(memberId: string): Promise<void>;
  /** Move the club's clock forward, for commitment expiry. Skipped when absent. */
  advance?(ms: number): Promise<void>;
  /**
   * Build a fresh target whose club uses the given grouping policy, so the suite can prove the
   * club asks the policy rather than deciding for itself. Skipped when absent; a club with a
   * fixed policy legitimately has nothing to offer here.
   */
  withPolicy?(policy: MatchPolicy): Promise<ConformanceTarget>;
  close(): Promise<void>;
}

export interface ConformanceOptions {
  /** Shown in test names, e.g. "ClubServer (deferred)". */
  name: string;
  create(): Promise<ConformanceTarget>;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  group: string;
  name: string;
  status: CheckStatus;
  /** Why it was skipped, or what went wrong. */
  note?: string;
  durationMs: number;
}

export interface ConformanceReport {
  name: string;
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

/** Thrown by a check to record a skip rather than a failure. */
export class SkipCheck extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipCheck';
  }
}

export function skip(reason: string): never {
  throw new SkipCheck(reason);
}

export interface Check {
  group: string;
  name: string;
  /** A fresh target per check, so one check's chips never explain another's result. */
  run(target: ConformanceTarget): Promise<void>;
}
