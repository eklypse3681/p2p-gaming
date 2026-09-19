import type { ClubInvite } from '@bgf/protocol';

/**
 * Club invite tokens are opaque to the web app: the club validates them. We only decode enough
 * to know which club to connect to and what to call it. Accepted shapes:
 * `p2pc1.<base64url JSON>` where the JSON is a `ClubInvite` (optionally with `signature`), or
 * `{ invite: ClubInvite, signature }`. Links look like `…#/club/join/<token>`.
 */
export const CLUB_INVITE_PREFIX = 'p2pc1.';

export interface DecodedInvite {
  token: string;
  invite: ClubInvite;
  signature?: string;
}

function base64UrlDecode(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeClubInvite(tokenOrLink: string): DecodedInvite {
  const token = extractClubToken(tokenOrLink);
  if (!token) throw new Error('That does not look like a club invite');
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(token.slice(CLUB_INVITE_PREFIX.length)));
  } catch {
    throw new Error('That club invite is damaged');
  }
  const obj = parsed as Record<string, unknown>;
  const raw = (obj.invite && typeof obj.invite === 'object' ? obj.invite : obj) as Record<
    string,
    unknown
  >;
  if (typeof raw.clubId !== 'string' || !raw.clubId || typeof raw.clubName !== 'string') {
    throw new Error('That club invite is missing the club');
  }
  const invite: ClubInvite = {
    clubId: raw.clubId,
    clubName: raw.clubName,
    address: typeof raw.address === 'string' && raw.address ? raw.address : raw.clubId,
    role: raw.role === 'owner' || raw.role === 'admin' ? raw.role : 'member',
    autoApprove: raw.autoApprove === true,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
    maxUses: typeof raw.maxUses === 'number' ? raw.maxUses : undefined,
    nonce: typeof raw.nonce === 'string' ? raw.nonce : '',
  };
  const signature = typeof obj.signature === 'string' ? obj.signature : undefined;
  return { token, invite, signature };
}

/** The token from a pasted link or a bare token; null when neither. */
export function extractClubToken(input: string): string | null {
  const text = input.trim();
  const m = text.match(/club\/join\/([A-Za-z0-9._-]+)/);
  const token = m ? m[1]! : text;
  return token.startsWith(CLUB_INVITE_PREFIX) && token.length > CLUB_INVITE_PREFIX.length
    ? token
    : null;
}

export function clubJoinLink(token: string): string {
  const base =
    typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
  return `${base}#/club/join/${token}`;
}

/** Test/dev helper: build a token from an invite payload (unsigned). */
export function encodeClubInvite(invite: ClubInvite, signature?: string): string {
  const json = JSON.stringify(signature ? { invite, signature } : invite);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return CLUB_INVITE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
