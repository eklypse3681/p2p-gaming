import type { ClubErrorCode } from '@bgf/club-spec';
import { isRetryable } from '@bgf/club-spec';

/**
 * Club errors in plain words. The codes are fixed by the spec so a client written once reacts
 * correctly to every implementation; the prose is ours. Unknown codes fall back to whatever the
 * club said, which is the only case where an implementation's own wording reaches a player.
 */
export function friendlyClubError(code: string, message: string): string {
  switch (code) {
    // Membership and identity.
    case 'unauthorized':
      return 'The club did not recognise this player.';
    case 'not-a-member':
      return 'This player is not a member of the club. Join with an invite first.';
    case 'pending':
      return 'Your membership is waiting for an admin to approve it.';
    case 'banned':
      return 'This club has banned this player.';

    // Capability and version.
    case 'unsupported':
      return 'This club does not offer that.';
    case 'version':
      return 'This club speaks a different version of the club protocol. Update the app.';

    // Chips.
    case 'insufficient-chips':
    case 'insufficient':
      return 'Not enough chips for that.';
    case 'commitment-exceeded':
      return 'That table tried to move more chips than you staked. The club refused it.';
    case 'commitment-stale':
      return 'Your stake on that table has already been settled.';
    case 'tally-invalid':
      return 'The club could not balance that table’s result, so nothing moved.';

    // Seats and tables.
    case 'unknown-table':
    case 'unknown-template':
      return 'That table is no longer available.';
    case 'unknown-member':
      return 'The club does not know that member.';
    case 'not-seated':
      return 'You are not at that table.';
    case 'seat-taken':
    case 'table-full':
      return 'Someone took that seat first. Try another or open a new table.';
    case 'buy-in-range':
    case 'bad-buy-in':
      return 'That buy-in is outside the table limits.';

    // Request handling.
    case 'conflict':
      return 'That request clashed with one already in flight. Try again.';
    case 'invalid':
    case 'bad-message':
      return 'The club did not understand that request.';
    case 'rate-limited':
      return 'You are going too fast for this club. Give it a moment.';
    case 'unavailable':
      return 'The club is there but cannot answer right now.';
    default:
      return message || 'Something went wrong at the club.';
  }
}

/** Whether to offer a retry button for this failure. */
export function clubErrorRetryable(code: string): boolean {
  return isRetryable(code as ClubErrorCode);
}
