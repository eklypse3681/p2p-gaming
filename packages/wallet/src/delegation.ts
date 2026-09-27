/**
 * Device grants: how a second device acts for a player without ever holding the seed.
 *
 * The new device generates its own key pair and shows its public key. The wallet signs a **grant**
 * saying "this device key may do these things, until this date, as serial N". From then on the
 * device signs challenges with its own key and presents the grant alongside; a verifier checks the
 * grant against the player's root public key, which is what seats and club memberships are bound
 * to. Nothing secret crosses the pairing channel, so a photographed QR code is worth nothing.
 *
 * Losing the device revokes serial N — a signed **revocation** the wallet publishes — and every
 * other device keeps working. Compare with copying the private key, where the only remedy is to
 * abandon the identity and everything attached to it.
 *
 * Tokens are `p2pd1.<payload>.<signature>` (and `p2pr1.…` for revocations), matching the club's
 * invite and mint certificates.
 */
import type { KeyPair } from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, sign, utf8Bytes, verify } from '@bgf/protocol';
import { WalletError } from './errors.js';

export const GRANT_PREFIX = 'p2pd1.';
export const REVOCATION_PREFIX = 'p2pr1.';

export const GRANT_SCOPES = ['seat', 'sync', 'club', 'admin'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export function isGrantScope(value: unknown): value is GrantScope {
  return typeof value === 'string' && (GRANT_SCOPES as readonly string[]).includes(value);
}

const DAY = 86_400_000;
/** What a pairing hands out unless asked otherwise. */
export const DEFAULT_GRANT_MS = 90 * DAY;
/** A grant is a standing permission; it does not get to be permanent. */
export const MAX_GRANT_MS = 400 * DAY;
/** Two devices rarely agree on the time to the second. */
export const CLOCK_SKEW_MS = 60_000;
export const MAX_LABEL = 64;

export interface DeviceGrant {
  v: 1;
  /** base64url root (identity) public key: the player this device speaks for. */
  root: string;
  /** base64url public key the device generated and kept to itself. */
  device: string;
  /** Unique per root, from 1 up. What a revocation names. */
  serial: number;
  /** For the person: "Steve's phone". Never trusted, only displayed. */
  label: string;
  scopes: GrantScope[];
  issuedAt: number;
  expiresAt: number;
}

export type GrantProblem =
  | 'bad-token'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'revoked'
  | 'stale-revocation'
  | 'wrong-root'
  | 'out-of-scope';

export type GrantCheck =
  { ok: true; grant: DeviceGrant } | { ok: false; reason: GrantProblem; grant?: DeviceGrant };

export function describeGrantProblem(reason: GrantProblem): string {
  switch (reason) {
    case 'bad-token':
      return 'that device grant is damaged';
    case 'bad-signature':
      return 'that device grant was not signed by this player';
    case 'expired':
      return 'that device grant has expired; pair the device again';
    case 'not-yet-valid':
      return 'that device grant is dated in the future';
    case 'revoked':
      return 'that device was signed out';
    case 'stale-revocation':
      return 'the list of signed-out devices is too old to rely on';
    case 'wrong-root':
      return 'that device grant belongs to a different player';
    case 'out-of-scope':
      return 'that device is not allowed to do this';
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------------------------

/** Labels are display-only, so they are flattened to keep the signed encoding unambiguous. */
export function cleanLabel(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

function cleanScopes(scopes: readonly GrantScope[]): GrantScope[] {
  return GRANT_SCOPES.filter((s) => scopes.includes(s));
}

/** Normalised so that issuing and verifying always hash the same bytes. */
export function normalizeGrant(grant: DeviceGrant): DeviceGrant {
  return { ...grant, label: cleanLabel(grant.label), scopes: cleanScopes(grant.scopes) };
}

export function grantBytes(grant: DeviceGrant): Uint8Array {
  const g = normalizeGrant(grant);
  return utf8Bytes(
    [
      'p2p-gaming device grant v1',
      g.root,
      g.device,
      String(g.serial),
      g.label,
      g.scopes.join(','),
      String(g.issuedAt),
      String(g.expiresAt),
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------------------------
// Issue and decode
// ---------------------------------------------------------------------------------------------

export interface GrantRequest {
  device: string;
  serial: number;
  label: string;
  scopes: readonly GrantScope[];
  issuedAt?: number;
  /** Defaults to `DEFAULT_GRANT_MS` after `issuedAt`. */
  expiresAt?: number;
}

/** Sign a grant with the player's root key. Throws `WalletError` for a request that makes no sense. */
export async function issueGrant(root: KeyPair, request: GrantRequest): Promise<string> {
  const issuedAt = request.issuedAt ?? Date.now();
  const expiresAt = request.expiresAt ?? issuedAt + DEFAULT_GRANT_MS;
  if (!Number.isInteger(request.serial) || request.serial < 1) {
    throw new WalletError('bad-grant', 'a device serial is a whole number from 1 up');
  }
  if (expiresAt <= issuedAt) {
    throw new WalletError('bad-grant', 'a device grant must expire after it is issued');
  }
  if (expiresAt - issuedAt > MAX_GRANT_MS) {
    throw new WalletError('bad-grant', `a device grant may not run longer than ${MAX_GRANT_MS} ms`);
  }
  const scopes = cleanScopes(request.scopes);
  if (scopes.length === 0) throw new WalletError('bad-scope', 'a device grant needs a scope');
  const grant = normalizeGrant({
    v: 1,
    root: root.publicKey,
    device: request.device,
    serial: request.serial,
    label: request.label,
    scopes,
    issuedAt,
    expiresAt,
  });
  const signature = await sign(root.privateKey, grantBytes(grant));
  return `${GRANT_PREFIX}${encode(grant)}.${bytesToBase64Url(signature)}`;
}

/** Parse without checking the signature. Use `verifyGrant` before believing any of it. */
export function decodeGrant(token: string): { grant: DeviceGrant; signature: Uint8Array } | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith(GRANT_PREFIX)) return null;
  const parts = trimmed.slice(GRANT_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  let parsed: unknown;
  try {
    parsed = decode(payload);
  } catch {
    return null;
  }
  const grant = asGrant(parsed);
  if (!grant) return null;
  try {
    return { grant, signature: base64UrlToBytes(sig) };
  } catch {
    return null;
  }
}

function asGrant(value: unknown): DeviceGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  if (typeof v.root !== 'string' || typeof v.device !== 'string') return null;
  if (typeof v.label !== 'string') return null;
  if (!Number.isInteger(v.serial) || (v.serial as number) < 1) return null;
  if (!Number.isFinite(v.issuedAt) || !Number.isFinite(v.expiresAt)) return null;
  if (!Array.isArray(v.scopes) || !v.scopes.every(isGrantScope)) return null;
  return normalizeGrant({
    v: 1,
    root: v.root,
    device: v.device,
    serial: v.serial as number,
    label: v.label,
    scopes: v.scopes,
    issuedAt: v.issuedAt as number,
    expiresAt: v.expiresAt as number,
  });
}

export interface VerifyGrantOptions {
  now: number;
  /** The player the grant must belong to. */
  root?: string;
  /** Required permission. */
  scope?: GrantScope;
  revocation?: Revocation | null;
  /** Refuse a revocation list older than this, rather than trust a replayed one. */
  revocationMaxAge?: number;
}

export async function verifyGrant(token: string, opts: VerifyGrantOptions): Promise<GrantCheck> {
  const decoded = decodeGrant(token);
  if (!decoded) return { ok: false, reason: 'bad-token' };
  const { grant, signature } = decoded;
  if (opts.root && opts.root !== grant.root) return { ok: false, reason: 'wrong-root', grant };
  if (!(await verify(grant.root, grantBytes(grant), signature))) {
    return { ok: false, reason: 'bad-signature', grant };
  }
  if (opts.now + CLOCK_SKEW_MS < grant.issuedAt) {
    return { ok: false, reason: 'not-yet-valid', grant };
  }
  if (opts.now - CLOCK_SKEW_MS >= grant.expiresAt) return { ok: false, reason: 'expired', grant };
  if (opts.scope && !grant.scopes.includes(opts.scope)) {
    return { ok: false, reason: 'out-of-scope', grant };
  }
  const revocation = opts.revocation;
  if (revocation) {
    if (revocation.root !== grant.root) return { ok: false, reason: 'wrong-root', grant };
    if (
      opts.revocationMaxAge !== undefined &&
      opts.now - revocation.issuedAt > opts.revocationMaxAge
    ) {
      return { ok: false, reason: 'stale-revocation', grant };
    }
    if (isRevoked(revocation, grant.serial)) return { ok: false, reason: 'revoked', grant };
  }
  return { ok: true, grant };
}

// ---------------------------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------------------------

export interface Revocation {
  v: 1;
  root: string;
  /** Every serial below this is revoked — "sign out every device" in one number. */
  minSerial: number;
  /** Individually revoked serials at or above `minSerial`. */
  serials: number[];
  issuedAt: number;
}

export function revocationBytes(revocation: Revocation): Uint8Array {
  const serials = [...new Set(revocation.serials)].sort((a, b) => a - b);
  return utf8Bytes(
    [
      'p2p-gaming device revocation v1',
      revocation.root,
      String(revocation.minSerial),
      serials.join(','),
      String(revocation.issuedAt),
    ].join('\n'),
  );
}

export function isRevoked(revocation: Revocation | null | undefined, serial: number): boolean {
  if (!revocation) return false;
  return serial < revocation.minSerial || revocation.serials.includes(serial);
}

export async function issueRevocation(
  root: KeyPair,
  input: { minSerial?: number; serials?: readonly number[]; issuedAt?: number },
): Promise<string> {
  const revocation: Revocation = {
    v: 1,
    root: root.publicKey,
    minSerial: input.minSerial ?? 1,
    serials: [...new Set(input.serials ?? [])].sort((a, b) => a - b),
    issuedAt: input.issuedAt ?? Date.now(),
  };
  const signature = await sign(root.privateKey, revocationBytes(revocation));
  return `${REVOCATION_PREFIX}${encode(revocation)}.${bytesToBase64Url(signature)}`;
}

/** The revocation a token carries, or null when it is damaged or not signed by `root`. */
export async function openRevocation(
  token: string,
  rootPublicKey: string,
): Promise<Revocation | null> {
  const trimmed = token.trim();
  if (!trimmed.startsWith(REVOCATION_PREFIX)) return null;
  const parts = trimmed.slice(REVOCATION_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  let value: unknown;
  let signature: Uint8Array;
  try {
    value = decode(payload);
    signature = base64UrlToBytes(sig);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.root !== rootPublicKey) return null;
  if (!Number.isInteger(v.minSerial) || (v.minSerial as number) < 1) return null;
  if (!Number.isFinite(v.issuedAt)) return null;
  if (!Array.isArray(v.serials) || !v.serials.every((s) => Number.isInteger(s) && s >= 1)) {
    return null;
  }
  const revocation: Revocation = {
    v: 1,
    root: rootPublicKey,
    minSerial: v.minSerial as number,
    serials: [...new Set(v.serials as number[])].sort((a, b) => a - b),
    issuedAt: v.issuedAt as number,
  };
  if (!(await verify(rootPublicKey, revocationBytes(revocation), signature))) return null;
  return revocation;
}

// ---------------------------------------------------------------------------------------------

function encode(value: unknown): string {
  return bytesToBase64Url(utf8Bytes(JSON.stringify(value)));
}

function decode(payload: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
}
