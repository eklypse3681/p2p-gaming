import type { MatchSnapshot, TableSnapshot } from '@bgf/protocol';

/**
 * Whether a game is played while apart: it has a mailbox key and every seated player's device
 * gets turn notifications. Otherwise it is played as always, together, and a dropped connection
 * means Reconnect. Either snapshot shape (backgammon's, or a table's).
 */
export function playedByMail(s: MatchSnapshot | TableSnapshot | null | undefined): boolean {
  if (!s) return false;
  if ('players' in s) {
    const m = s as MatchSnapshot;
    if (typeof m.mailboxKey !== 'string') return false;
    const seated = (['white', 'black'] as const).filter((c) => m.players[c]);
    return seated.length > 0 && seated.every((c) => m.push?.[c] === true);
  }
  const t = s as TableSnapshot;
  if (typeof t.options?.mailboxKey !== 'string') return false;
  const seated = t.seats.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  return seated.length > 0 && seated.every((i) => t.push?.[i] === true);
}
