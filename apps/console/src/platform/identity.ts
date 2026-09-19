/**
 * Decodes the web app's pasteable player codes (kept in step with apps/web/src/session/transfer.ts,
 * without importing it): an identity code `p2pi1.<base64url JSON {i,n,a,k,p,s}>` or a transfer
 * code `p2pg1.<base64url JSON {p: {id,name,avatar,publicKey,privateKey,...}, s?}>`.
 */
export const IDENTITY_PREFIX = 'p2pi1.';
export const TRANSFER_PREFIX = 'p2pg1.';

export interface DecodedIdentity {
  kind: 'identity' | 'transfer';
  id: string;
  name: string;
  avatar?: string;
  /** base64url ECDSA P-256 public key. */
  publicKey?: string;
  /** base64url PKCS#8 private key; stays in memory and is only used to sign the login challenge. */
  privateKey?: string;
}

function fromBase64Url(data: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(data)) throw new Error('not base64url');
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (data.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 400): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function isIdentityCode(text: string): boolean {
  const t = text.trim();
  return t.startsWith(IDENTITY_PREFIX) || t.startsWith(TRANSFER_PREFIX);
}

/** Throws an `Error` with a message fit for the login form. */
export function decodeIdentityCode(text: string): DecodedIdentity {
  const trimmed = text.trim();
  const kind = trimmed.startsWith(IDENTITY_PREFIX)
    ? 'identity'
    : trimmed.startsWith(TRANSFER_PREFIX)
      ? 'transfer'
      : null;
  if (!kind) throw new Error(`a code starts with "${IDENTITY_PREFIX}" or "${TRANSFER_PREFIX}"`);
  const prefix = kind === 'identity' ? IDENTITY_PREFIX : TRANSFER_PREFIX;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(prefix.length)));
  } catch {
    throw new Error('that code is damaged');
  }
  if (!isRecord(parsed)) throw new Error('that code is damaged');
  const raw: unknown =
    kind === 'identity'
      ? {
          id: parsed.i,
          name: parsed.n,
          avatar: parsed.a,
          publicKey: parsed.p,
          privateKey: parsed.s,
        }
      : parsed.p;
  if (!isRecord(raw)) throw new Error('no player identity found in that code');
  const id = str(raw.id, 120);
  const name = str(raw.name, 40);
  if (!id) throw new Error('the player identity has no id');
  if (!name) throw new Error('the player identity has no name');
  if (raw.secrets !== undefined && !str(raw.privateKey)) {
    throw new Error(
      'that player is password-protected; unlock it in the web app and export a fresh code',
    );
  }
  const avatar = str(raw.avatar, 16);
  const publicKey = str(raw.publicKey);
  const privateKey = str(raw.privateKey, 800);
  return {
    kind,
    id,
    name,
    ...(avatar ? { avatar } : {}),
    ...(publicKey ? { publicKey } : {}),
    ...(privateKey ? { privateKey } : {}),
  };
}

/** Test helper and the reverse of `decodeIdentityCode` for identity codes. */
export function encodeIdentityCode(profile: {
  id: string;
  name: string;
  avatar?: string;
  publicKey?: string;
  privateKey?: string;
}): string {
  const payload: Record<string, string> = { i: profile.id, n: profile.name };
  if (profile.avatar) payload.a = profile.avatar;
  if (profile.publicKey) payload.p = profile.publicKey;
  if (profile.privateKey) payload.s = profile.privateKey;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return IDENTITY_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
