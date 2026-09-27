import { randomNonce } from '@bgf/protocol';
import type { GrantScope, Revocation } from '@bgf/wallet';
import { verifyDelegated } from '@bgf/wallet';

/**
 * Keyed challenge/response shared by every server that seats keyed identities (tables, clubs).
 * The server hands out a nonce, the client signs domain-separated bytes containing it, and the
 * server verifies the signature against the public key it expects for that identity.
 */
export interface PendingChallenge {
  nonce: string;
  publicKey: string;
  timer: ReturnType<typeof setTimeout>;
  verifying: boolean;
}

export function beginChallenge(opts: {
  publicKey: string;
  timeoutMs: number;
  onTimeout: () => void;
}): PendingChallenge {
  const nonce = randomNonce();
  const timer = setTimeout(opts.onTimeout, opts.timeoutMs);
  return { nonce, publicKey: opts.publicKey, timer, verifying: false };
}

export function cancelChallenge(pending: PendingChallenge): void {
  clearTimeout(pending.timer);
}

/**
 * Verify a client's answer. Returns false for a malformed or wrong signature; never throws.
 * `bytes` are the domain-separated challenge bytes the client was expected to sign. The seat (or
 * membership) stays bound to the player's own key: a device answers with its own signature plus
 * the grant from that key, which must be current and must allow `scope`.
 */
export function verifyChallengeAnswer(
  pending: PendingChallenge,
  bytes: Uint8Array,
  signatureBase64Url: string,
  opts: AnswerOptions = {},
): Promise<boolean> {
  return verifyAnswer(pending.publicKey, bytes, signatureBase64Url, opts);
}

export interface AnswerOptions {
  grant?: string;
  scope?: GrantScope;
  now?: number;
  /** Where to learn which of the player's devices were signed out; default: this runtime's. */
  revocationFor?: RevocationLookup | null;
}

/** The same check for callers that hold the expected key rather than a pending challenge. */
export async function verifyAnswer(
  publicKey: string,
  bytes: Uint8Array,
  signatureBase64Url: string,
  opts: AnswerOptions = {},
): Promise<boolean> {
  const pending = { publicKey };
  try {
    const lookup = opts.revocationFor === undefined ? defaultLookup : opts.revocationFor;
    // Only a device's grant can be revoked; the player's own key needs no lookup.
    const revocation =
      opts.grant && lookup ? await lookup(pending.publicKey).catch(() => null) : null;
    const result = await verifyDelegated(
      pending.publicKey,
      bytes,
      { signature: signatureBase64Url, ...(opts.grant ? { grant: opts.grant } : {}) },
      { now: opts.now ?? Date.now(), scope: opts.scope ?? 'seat', revocation },
    );
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Finds the devices a player has signed out: the revocation their own key signed, or null when
 * there is none (or it cannot be reached — a table that cannot ask still admits the device, and
 * short grant lifetimes bound how long that lasts).
 */
export type RevocationLookup = (playerPublicKey: string) => Promise<Revocation | null>;

let defaultLookup: RevocationLookup | null = null;

/**
 * How this runtime learns about signed-out devices, for every table and club it hosts. The web
 * app points it at amongfriends.gg; a server can point it anywhere, or leave it unset.
 */
export function setRevocationLookup(lookup: RevocationLookup | null): void {
  defaultLookup = lookup;
}
