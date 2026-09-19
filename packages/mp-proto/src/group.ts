/**
 * Group and scalar arithmetic over ristretto255.
 *
 * ristretto255 is a prime-order group built on Curve25519: encodings are 32 bytes, there is no
 * cofactor to reason about, and equality of encodings is equality of elements. That makes the
 * byte accounting in this prototype honest — every group element on the wire is exactly 32 bytes
 * and every scalar is exactly 32 bytes.
 *
 * Notation is additive throughout: `P.add(Q)` is the group operation and `mul(P, s)` is repeated
 * addition. Where the parent conversation says "g^r" this code says `mul(G, r)`.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { pippenger } from '@noble/curves/abstract/curve.js';
import { sha512 } from '@noble/hashes/sha2.js';

export const Point: typeof ristretto255.Point = ristretto255.Point;
export type Pt = InstanceType<typeof ristretto255.Point>;

/** Standard generator. */
export const G: Pt = Point.BASE;
/** Identity element. */
export const ZERO: Pt = Point.ZERO;
/** Prime order of the group; scalars live in [0, L). */
export const L: bigint = Point.Fn.ORDER;

export const POINT_BYTES = 32;
export const SCALAR_BYTES = 32;

/**
 * Scalar multiplication.
 *
 * `secret: true` uses noble's constant-time ladder, which is what a production implementation
 * must do for anything multiplied by a secret (a DKG share, a re-randomisation factor). Public
 * scalars — verification equations, Lagrange coefficients — use the faster variable-time path.
 * Benchmarks below keep this distinction so the numbers reflect a real implementation rather
 * than an optimistically fast one.
 */
export function mul(p: Pt, s: bigint, secret = true): Pt {
  const k = mod(s);
  if (k === 0n) return ZERO;
  return secret ? p.multiply(k) : p.multiplyUnsafe(k);
}

/**
 * Cache a window table on a point so later multiplications by it are ~8x faster.
 *
 * This matters more than any algorithmic choice here, because the hot points are all reused: the
 * joint public key is multiplied once per card in every re-randomisation, and a member's
 * verification share is multiplied once per proof it ever verifies. Production must do this;
 * benchmarks report both paths so the difference is visible.
 */
export function precompute(p: Pt, window = 8): Pt {
  p.precompute(window);
  return p;
}

/** Multi-scalar multiplication. Pippenger beats the naive loop from about k = 10 upward. */
export function msm(points: Pt[], scalars: bigint[]): Pt {
  if (points.length === 0) return ZERO;
  return pippenger(Point, points, scalars) as Pt;
}

export function mod(a: bigint): bigint {
  const r = a % L;
  return r < 0n ? r + L : r;
}

export function addS(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

export function subS(a: bigint, b: bigint): bigint {
  return mod(a - b);
}

export function mulS(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

/** Modular inverse via Fermat (L is prime). Used for Lagrange coefficients. */
export function invS(a: bigint): bigint {
  return powS(mod(a), L - 2n);
}

export function powS(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

/**
 * Deterministic scalar stream. Benchmarks and tests need repeatable runs; production would draw
 * from `crypto.getRandomValues`. `seededRandomness(seed)` returns a closure with the same shape.
 */
export interface Randomness {
  scalar(): bigint;
  bytes(n: number): Uint8Array;
}

export function seededRandomness(seed: number | string): Randomness {
  let counter = 0;
  const label = typeof seed === 'number' ? `seed:${seed}` : seed;
  const next = (): Uint8Array => sha512(utf8(`${label}:${counter++}`));
  return {
    scalar() {
      // Reduce 64 bytes mod L: bias is below 2^-128, the standard construction.
      return mod(bytesToBigIntLE(next()));
    },
    bytes(n: number) {
      const out = new Uint8Array(n);
      let filled = 0;
      while (filled < n) {
        const block = next();
        const take = Math.min(block.length, n - filled);
        out.set(block.subarray(0, take), filled);
        filled += take;
      }
      return out;
    },
  };
}

export function cryptoRandomness(): Randomness {
  return {
    scalar() {
      const b = new Uint8Array(64);
      globalThis.crypto.getRandomValues(b);
      return mod(bytesToBigIntLE(b));
    },
    bytes(n: number) {
      const b = new Uint8Array(n);
      globalThis.crypto.getRandomValues(b);
      return b;
    },
  };
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToBigIntLE(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
  return x;
}

export function scalarToBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(SCALAR_BYTES);
  let x = mod(s);
  for (let i = 0; i < SCALAR_BYTES; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Fiat-Shamir challenge: hash transcript bytes to a scalar. */
export function challenge(...parts: Uint8Array[]): bigint {
  return mod(bytesToBigIntLE(sha512(concat(...parts))));
}

export function hashToPoint(label: string, dst: string): Pt {
  return ristretto255_hasher.hashToCurve(utf8(label), { DST: dst }) as Pt;
}

export function pointHex(p: Pt): string {
  return p.toHex();
}
