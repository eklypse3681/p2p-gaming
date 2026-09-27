import { randomNonce } from '@bgf/protocol';
import type { GrantScope } from '@bgf/wallet';
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
export async function verifyChallengeAnswer(
  pending: PendingChallenge,
  bytes: Uint8Array,
  signatureBase64Url: string,
  opts: { grant?: string; scope?: GrantScope; now?: number } = {},
): Promise<boolean> {
  try {
    const result = await verifyDelegated(
      pending.publicKey,
      bytes,
      { signature: signatureBase64Url, ...(opts.grant ? { grant: opts.grant } : {}) },
      { now: opts.now ?? Date.now(), scope: opts.scope ?? 'seat' },
    );
    return result.ok;
  } catch {
    return false;
  }
}
