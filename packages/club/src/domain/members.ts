import type { ClubInvite, ClubMember, MemberRole, PlayerProfile } from '@bgf/protocol';
import { ClubError } from './identity.js';
import type { ClubState } from './state.js';

export function findMember(state: ClubState, id: string): ClubMember | undefined {
  return state.members.find((m) => m.id === id);
}

export function isAdmin(member: ClubMember | undefined): boolean {
  return (
    !!member && member.status === 'active' && (member.role === 'owner' || member.role === 'admin')
  );
}

function requireAdmin(state: ClubState, by: string): ClubMember {
  const actor = findMember(state, by);
  if (!isAdmin(actor)) throw new ClubError('forbidden', 'only the owner or an admin may do that');
  return actor!;
}

function replace(state: ClubState, member: ClubMember): ClubState {
  return { ...state, members: state.members.map((m) => (m.id === member.id ? member : m)) };
}

/** The first member is the owner (the club's creator). */
export function addOwner(state: ClubState, profile: PlayerProfile, now = Date.now()): ClubState {
  if (!profile.publicKey) throw new ClubError('unkeyed', 'the owner needs a keyed profile');
  if (state.members.some((m) => m.role === 'owner')) {
    throw new ClubError('has-owner', 'the club already has an owner');
  }
  const owner: ClubMember = {
    id: profile.id,
    name: profile.name,
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    publicKey: profile.publicKey,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  };
  return { ...state, members: [...state.members, owner] };
}

/**
 * A profile presents itself, with or without an invite. Known members are refreshed (name,
 * avatar) but their key must match. Strangers need an invite; `autoApprove` seats them as
 * active, otherwise they wait as `pending`.
 */
export interface JoinPolicy {
  /** `open` admits walk-ins, `request` seats them pending, `invite` refuses them. */
  membership?: 'open' | 'request' | 'invite';
}

export function requestJoin(
  state: ClubState,
  profile: PlayerProfile,
  invite?: ClubInvite,
  now = Date.now(),
  policy: JoinPolicy = {},
): { state: ClubState; member: ClubMember; created: boolean } {
  if (!profile.publicKey) throw new ClubError('unkeyed', 'a keyed profile is required');
  const known = findMember(state, profile.id);
  if (known) {
    if (known.publicKey !== profile.publicKey) {
      throw new ClubError('unauthorized', 'that member id belongs to a different key');
    }
    const refreshed: ClubMember = {
      ...known,
      name: profile.name,
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
    };
    return { state: replace(state, refreshed), member: refreshed, created: false };
  }
  const membership = policy.membership ?? 'invite';
  if (!invite && membership === 'invite') {
    throw new ClubError('not-a-member', 'an invite is needed to join this club');
  }
  const role: MemberRole = invite?.role ?? 'member';
  const active = invite ? invite.autoApprove : membership === 'open';
  const member: ClubMember = {
    id: profile.id,
    name: profile.name,
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    publicKey: profile.publicKey,
    role,
    status: active ? 'active' : 'pending',
    joinedAt: now,
  };
  return { state: { ...state, members: [...state.members, member] }, member, created: true };
}

export function approveMember(state: ClubState, memberId: string, by: string): ClubState {
  requireAdmin(state, by);
  const member = findMember(state, memberId);
  if (!member) throw new ClubError('no-member', 'no such member');
  if (member.status === 'active') return state;
  return replace(state, { ...member, status: 'active' });
}

export function banMember(state: ClubState, memberId: string, by: string): ClubState {
  const actor = requireAdmin(state, by);
  const member = findMember(state, memberId);
  if (!member) throw new ClubError('no-member', 'no such member');
  if (member.role === 'owner') throw new ClubError('forbidden', 'the owner cannot be banned');
  if (member.role === 'admin' && actor.role !== 'owner') {
    throw new ClubError('forbidden', 'only the owner may ban an admin');
  }
  return replace(state, { ...member, status: 'banned' });
}

export function setRole(
  state: ClubState,
  memberId: string,
  role: MemberRole,
  by: string,
): ClubState {
  const actor = requireAdmin(state, by);
  const member = findMember(state, memberId);
  if (!member) throw new ClubError('no-member', 'no such member');
  if (member.role === 'owner' || role === 'owner') {
    if (actor.role !== 'owner')
      throw new ClubError('forbidden', 'only the owner may transfer ownership');
    if (role === 'owner' && member.id !== actor.id) {
      // Transfer: the old owner becomes an admin.
      const handed = replace(state, { ...member, role: 'owner' });
      return replace(handed, { ...actor, role: 'admin' });
    }
    if (member.role === 'owner' && role !== 'owner') {
      throw new ClubError('forbidden', 'transfer ownership instead of demoting the owner');
    }
  }
  if (member.role === 'admin' && actor.role !== 'owner' && role !== 'admin') {
    throw new ClubError('forbidden', 'only the owner may demote an admin');
  }
  return replace(state, { ...member, role });
}

export function activeMembers(state: ClubState): ClubMember[] {
  return state.members.filter((m) => m.status === 'active');
}
