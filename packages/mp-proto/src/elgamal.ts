/**
 * Exponential-free ElGamal over ristretto255, in additive notation.
 *
 * A ciphertext is `(A, B) = (rG, M + rH)` where `H` is the joint public key and `M` is the card
 * point. Two properties carry the whole scheme:
 *
 *  - **Re-randomisation.** `(A + r'G, B + r'H)` encrypts the same card and is unlinkable to the
 *    original without the secret key. This is what lets a shuffler hide the permutation.
 *  - **Homomorphic decryption.** `M = B - xA` where `H = xG`. Because `xA` is linear in `x`, the
 *    secret can be Shamir-shared and each holder can contribute `x_i A` without the key ever
 *    existing in one place.
 */
import { G, POINT_BYTES, ZERO, mul, type Pt, type Randomness } from './group.ts';
import { cardToPoint, DECK_SIZE } from './cards.ts';

export interface Ciphertext {
  a: Pt;
  b: Pt;
}

export const CIPHERTEXT_BYTES = 2 * POINT_BYTES;

export function encrypt(cardPoint: Pt, h: Pt, r: bigint): Ciphertext {
  return { a: mul(G, r), b: cardPoint.add(mul(h, r)) };
}

/**
 * The unshuffled deck needs no randomness: everyone already knows it is the 52 cards in order,
 * so `r = 0` is a correct (and free) encryption. Hiding begins at the first shuffle, which
 * re-randomises every ciphertext. Skipping this saves 104 scalar multiplications per hand.
 */
export function trivialDeck(): Ciphertext[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => ({ a: ZERO, b: cardToPoint(i) }));
}

export function rerandomize(ct: Ciphertext, h: Pt, r: bigint): Ciphertext {
  return { a: ct.a.add(mul(G, r)), b: ct.b.add(mul(h, r)) };
}

/** Decryption with the whole secret key. Only the tests ever hold one. */
export function decrypt(ct: Ciphertext, x: bigint): Pt {
  return ct.b.subtract(mul(ct.a, x));
}

/** Recover the card point once the combined `xA` term is known. */
export function openWithShared(ct: Ciphertext, sharedTerm: Pt): Pt {
  return ct.b.subtract(sharedTerm);
}

export function ciphertextBytes(ct: Ciphertext): Uint8Array {
  const out = new Uint8Array(CIPHERTEXT_BYTES);
  out.set(ct.a.toBytes(), 0);
  out.set(ct.b.toBytes(), POINT_BYTES);
  return out;
}

export function deckBytes(deck: Ciphertext[]): number {
  return deck.length * CIPHERTEXT_BYTES;
}

export function randomScalars(rng: Randomness, n: number): bigint[] {
  return Array.from({ length: n }, () => rng.scalar());
}
