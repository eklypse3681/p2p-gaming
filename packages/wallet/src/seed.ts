/**
 * The root secret behind one player.
 *
 * A wallet is 32 random bytes and nothing else. Every key the player uses — the identity key that
 * seats are bound to, the device-sync key, a separate key per club — is *derived* from it, so a
 * backup of the seed restores all of them and losing a device loses none of them.
 *
 * The seed itself never leaves the browser it was made in. Moving to a second device delegates a
 * grant to a key that device generates for itself (see `delegation.ts`); it does not copy this.
 */
import { base64UrlToBytes, bytesToBase64Url, sha256 } from '@bgf/protocol';
import { WalletError } from './errors.js';

export const SEED_BYTES = 32;

export function generateSeed(): Uint8Array {
  const seed = new Uint8Array(SEED_BYTES);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}

export function seedToBase64Url(seed: Uint8Array): string {
  checkSeed(seed);
  return bytesToBase64Url(seed);
}

export function seedFromBase64Url(text: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(text.trim());
  } catch {
    throw new WalletError('bad-seed', 'that is not a wallet seed');
  }
  checkSeed(bytes);
  return bytes;
}

export function checkSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new WalletError('bad-seed', `a wallet seed is ${SEED_BYTES} bytes`);
  }
}

/**
 * A short, human-comparable code for a public key: 12 hex digits in three groups. Shown on both
 * screens when pairing a device, so the person can see they match without trusting the channel.
 */
export function fingerprint(publicKey: string): string {
  const digest = sha256(base64UrlToBytes(publicKey));
  const hex = Array.from(digest.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
