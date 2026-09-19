import type { ClubInvite, MemberRole, Signer } from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, randomNonce, verify } from '@bgf/protocol';
import { utf8Bytes } from '@bgf/table';
import { canonicalJson } from './canonical.js';
import { ClubError } from './identity.js';
import type { ClubState, InviteRecord } from './state.js';

export const INVITE_PREFIX = 'p2pc1';

export interface CreateInviteOptions {
  role?: MemberRole;
  autoApprove?: boolean;
  expiresAt?: number;
  maxUses?: number;
  /** Address members dial (defaults to the club id). */
  address?: string;
}

/** Bytes the club signs for an invite: the canonical JSON of the payload. */
export function inviteBytes(invite: ClubInvite): Uint8Array {
  return utf8Bytes(`p2p-gaming club invite v1\n${canonicalJson(invite)}`);
}

export async function signInvite(invite: ClubInvite, signer: Signer): Promise<string> {
  const payload = bytesToBase64Url(utf8Bytes(canonicalJson(invite)));
  const signature = bytesToBase64Url(await signer(inviteBytes(invite)));
  return `${INVITE_PREFIX}.${payload}.${signature}`;
}

export function parseInviteToken(token: string): { invite: ClubInvite; signature: string } {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) {
    throw new ClubError('bad-invite', 'that is not a club invite');
  }
  let invite: ClubInvite;
  try {
    invite = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]!))) as ClubInvite;
  } catch {
    throw new ClubError('bad-invite', 'the invite is damaged');
  }
  if (
    !invite ||
    typeof invite.clubId !== 'string' ||
    typeof invite.nonce !== 'string' ||
    (invite.role !== 'owner' && invite.role !== 'admin' && invite.role !== 'member') ||
    typeof invite.autoApprove !== 'boolean'
  ) {
    throw new ClubError('bad-invite', 'the invite is malformed');
  }
  return { invite, signature: parts[2]! };
}

/** Verify a token against the club's key. Throws `ClubError` with a specific code. */
export async function verifyInvite(
  token: string,
  clubPublicKey: string,
  clubId: string,
  now = Date.now(),
): Promise<ClubInvite> {
  const { invite, signature } = parseInviteToken(token);
  if (invite.clubId !== clubId)
    throw new ClubError('wrong-club', 'that invite is for another club');
  const ok = await verify(clubPublicKey, inviteBytes(invite), base64UrlToBytes(signature));
  if (!ok) throw new ClubError('bad-invite', 'the invite signature does not verify');
  if (invite.expiresAt !== undefined && now > invite.expiresAt) {
    throw new ClubError('invite-expired', 'the invite has expired');
  }
  return invite;
}

/** Issue an invite: records it in state (so uses can be counted) and returns the token. */
export async function createInvite(
  state: ClubState,
  signer: Signer,
  opts: CreateInviteOptions = {},
  now = Date.now(),
): Promise<{ state: ClubState; token: string; invite: ClubInvite }> {
  const role = opts.role ?? 'member';
  if (role === 'owner') throw new ClubError('bad-invite', 'ownership is not granted by invite');
  const invite: ClubInvite = {
    clubId: state.identity.id,
    clubName: state.identity.name,
    address: opts.address ?? state.identity.id,
    role,
    autoApprove: opts.autoApprove ?? true,
    nonce: randomNonce(12),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
  };
  void now;
  const token = await signInvite(invite, signer);
  const record: InviteRecord = { invite, token, uses: 0 };
  return {
    state: { ...state, invites: { ...state.invites, [invite.nonce]: record } },
    token,
    invite,
  };
}

/** Check that an invite is still usable in this club and count a use. */
export function consumeInvite(state: ClubState, invite: ClubInvite): ClubState {
  const record = state.invites[invite.nonce];
  if (!record) throw new ClubError('bad-invite', 'the invite is not known to this club');
  if (record.revoked) throw new ClubError('invite-revoked', 'the invite was revoked');
  if (invite.maxUses !== undefined && record.uses >= invite.maxUses) {
    throw new ClubError('invite-used', 'the invite has been used up');
  }
  return {
    ...state,
    invites: { ...state.invites, [invite.nonce]: { ...record, uses: record.uses + 1 } },
  };
}

export function revokeInvite(state: ClubState, nonce: string): ClubState {
  const record = state.invites[nonce];
  if (!record) throw new ClubError('bad-invite', 'no such invite');
  return { ...state, invites: { ...state.invites, [nonce]: { ...record, revoked: true } } };
}
