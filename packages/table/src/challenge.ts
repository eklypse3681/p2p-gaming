import { base64UrlToBytes, randomNonce, verify } from '@bgf/protocol';

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
 * `bytes` are the domain-separated challenge bytes the client was expected to sign.
 */
export async function verifyChallengeAnswer(
  pending: PendingChallenge,
  bytes: Uint8Array,
  signatureBase64Url: string,
): Promise<boolean> {
  try {
    const signature = base64UrlToBytes(signatureBase64Url);
    return await verify(pending.publicKey, bytes, signature);
  } catch {
    return false;
  }
}
