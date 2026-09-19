/**
 * The error vocabulary every club implementation shares.
 *
 * A client written against one club must be able to react correctly to another's failures, so
 * the codes are fixed here and the prose is not. An implementation always supplies a message;
 * the client decides what to show from the code.
 */

export type ClubErrorCode =
  /** The signature did not match the key claimed. */
  | 'unauthorized'
  /** Valid key, but this club has never heard of you and does not take walk-ins. */
  | 'not-a-member'
  /** You have asked to join and nobody has approved you yet. */
  | 'pending'
  | 'banned'
  /** The club does not implement this operation; check capabilities before calling. */
  | 'unsupported'
  /** Written against a spec version this club cannot serve. */
  | 'version'
  | 'unknown-table'
  | 'unknown-template'
  | 'unknown-member'
  /** Not enough chips for the stake or transfer requested. */
  | 'insufficient-chips'
  /** A tally tried to move more than the commitment allowed. */
  | 'commitment-exceeded'
  /** The commitment has expired or was already settled. */
  | 'commitment-stale'
  /** A tally did not conserve chips. */
  | 'tally-invalid'
  /** You are not sitting at that table. */
  | 'not-seated'
  /** Someone took the seat first. */
  | 'seat-taken'
  /** The same operation id was reused with different arguments. */
  | 'conflict'
  /** Malformed request. */
  | 'invalid'
  | 'rate-limited'
  /** The club is up but cannot serve this right now; retry is reasonable. */
  | 'unavailable';

export class ClubError extends Error {
  constructor(
    readonly code: ClubErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ClubError';
  }
}

export function isClubError(e: unknown): e is ClubError {
  return e instanceof Error && 'code' in e && typeof (e as ClubError).code === 'string';
}

/** True when retrying the identical request later could plausibly succeed. */
export function isRetryable(code: ClubErrorCode): boolean {
  return code === 'unavailable' || code === 'rate-limited' || code === 'seat-taken';
}
