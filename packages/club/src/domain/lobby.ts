import type { LobbyState, LobbyTable } from '@bgf/protocol';
import { ClubError } from './identity.js';
import { balanceOf, reserve } from './ledger.js';
import { findMember, isAdmin } from './members.js';
import type { ClubState } from './state.js';

/** What one member sees of the club right now. */
export function lobbyFor(
  state: ClubState,
  tables: LobbyTable[],
  memberId: string,
  online: string[],
): LobbyState {
  const member = findMember(state, memberId);
  if (!member) throw new ClubError('no-member', 'no such member');
  return {
    club: state.identity,
    rooms: state.rooms,
    tables,
    me: { member, balance: balanceOf(state, memberId) },
    online: [...online].sort(),
    ...(isAdmin(member) ? { reserve: reserve(state) } : {}),
  };
}
