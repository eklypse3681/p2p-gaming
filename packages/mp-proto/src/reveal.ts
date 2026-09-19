/**
 * Threshold reveal: turning a ciphertext into a card without the key ever existing.
 *
 * Each member computes `D_i = x_i · A` from its own share and proves, with a Chaum–Pedersen
 * proof, that it used the share it committed to at setup. Without that proof a member could emit
 * garbage and corrupt a card with nobody able to say who did it. `k` partials interpolate to
 * `x · A`, and the card falls out as `B − x·A`.
 *
 * Two flavours:
 *
 *  - **Public reveal** (community cards): partials are broadcast, anyone combines.
 *  - **Private reveal** (hole cards): the recipient first re-randomises the ciphertext with a
 *    blinding factor only it knows, and partials are returned to the recipient alone. See
 *    `privateReveal` for exactly what the blinding does and does not protect against.
 */
import {
  G,
  POINT_BYTES,
  SCALAR_BYTES,
  ZERO,
  addS,
  challenge,
  mod,
  msm,
  mul,
  mulS,
  precompute,
  subS,
  type Pt,
  type Randomness,
} from './group.ts';
import { lagrange, type MemberKey } from './dkg.ts';
import { rerandomize, type Ciphertext } from './elgamal.ts';
import { pointToCard } from './cards.ts';

/** Chaum–Pedersen proof of discrete-log equality, in compact challenge/response form. */
export interface DleqProof {
  c: bigint;
  s: bigint;
}

export const DLEQ_PROOF_BYTES = 2 * SCALAR_BYTES;

export interface PartialDecryption {
  index: number;
  /** `x_i · A`. */
  value: Pt;
  proof: DleqProof;
}

export const PARTIAL_BYTES = POINT_BYTES + DLEQ_PROOF_BYTES;

function dleqChallenge(a: Pt, y: Pt, d: Pt, t1: Pt, t2: Pt): bigint {
  return challenge(G.toBytes(), a.toBytes(), y.toBytes(), d.toBytes(), t1.toBytes(), t2.toBytes());
}

/**
 * Prove `log_G(Y) == log_A(D)` where `Y = x·G` is the member's public verification share and
 * `D = x·A` is the partial decryption. Costs two secret-scalar multiplications.
 */
export function proveDleq(a: Pt, y: Pt, d: Pt, x: bigint, rng: Randomness): DleqProof {
  const w = rng.scalar();
  const t1 = mul(G, w);
  const t2 = mul(a, w);
  const c = dleqChallenge(a, y, d, t1, t2);
  return { c, s: addS(w, mulS(c, x)) };
}

/** Four variable-time multiplications: all inputs are public. */
export function verifyDleq(a: Pt, y: Pt, d: Pt, proof: DleqProof): boolean {
  const t1 = mul(G, proof.s, false).subtract(mul(y, proof.c, false));
  const t2 = mul(a, proof.s, false).subtract(mul(d, proof.c, false));
  return dleqChallenge(a, y, d, t1, t2) === mod(proof.c);
}

export function partialDecrypt(
  ct: Ciphertext,
  member: MemberKey,
  rng: Randomness,
): PartialDecryption {
  const value = mul(ct.a, member.share);
  return {
    index: member.index,
    value,
    proof: proveDleq(ct.a, member.verification, value, member.share, rng),
  };
}

/** The partial without its proof: the only part that can be precomputed ahead of a challenge. */
export function partialValueOnly(ct: Ciphertext, member: MemberKey): Pt {
  return mul(ct.a, member.share);
}

export function verifyPartial(
  ct: Ciphertext,
  partial: PartialDecryption,
  verification: Pt,
): boolean {
  return verifyDleq(ct.a, verification, partial.value, partial.proof);
}

/** Interpolate `k` partials to `x·A`. Lagrange coefficients are public, so variable-time is fine. */
export function combine(partials: PartialDecryption[]): Pt {
  const indices = partials.map((p) => p.index);
  const coefficients = lagrange(indices);
  let acc = ZERO;
  for (let i = 0; i < partials.length; i++) {
    acc = acc.add(mul(partials[i]!.value, coefficients[i]!, false));
  }
  return acc;
}

/**
 * The same interpolation as a single multi-scalar multiplication. Partial values are fresh points
 * every time, so precomputation cannot help them, but Pippenger can: roughly 2x at k = 20 and
 * 3.5x at k = 100.
 */
export function combineFast(partials: PartialDecryption[]): Pt {
  if (partials.length === 0) return ZERO;
  const coefficients = lagrange(partials.map((p) => p.index));
  return msm(
    partials.map((p) => p.value),
    coefficients,
  );
}

/** Cache window tables on the points a member will be multiplied by over and over. */
export function precomputeMember(member: { verification: Pt }): void {
  precompute(member.verification);
}

/**
 * Optimistic reveal: combine first, and only fall back to verifying proofs if the result does not
 * decode to a card.
 *
 * This is sound against exactly the adversary the threshold already assumes. A member below the
 * threshold does not know the card, so any deviation it introduces shifts the result by a value
 * it cannot steer, and the combination lands on a point that is not in the 52-entry table with
 * overwhelming probability. A quorum large enough to steer the result to a *chosen* wrong card is
 * by definition large enough to read the card anyway, so this trades nothing away.
 *
 * The happy path costs one interpolation instead of `k` proof verifications, which is where most
 * of the combiner's time goes.
 */
export interface OptimisticResult {
  card: number | null;
  /** Set when the fast path failed and proofs had to be checked; names the members at fault. */
  culprits?: number[];
}

export function optimisticReveal(
  ct: Ciphertext,
  partials: PartialDecryption[],
  verifications: Map<number, Pt>,
): OptimisticResult {
  const card = pointToCard(ct.b.subtract(combineFast(partials)));
  if (card !== null) return { card };
  const culprits = partials
    .filter((p) => !verifyDleq(ct.a, verifications.get(p.index)!, p.value, p.proof))
    .map((p) => p.index);
  return { card: null, culprits };
}

/** Public reveal: combine broadcast partials and decode the card. */
export function publicReveal(ct: Ciphertext, partials: PartialDecryption[]): number | null {
  return pointToCard(ct.b.subtract(combine(partials)));
}

export interface Blinding {
  /** The re-randomised ciphertext the committee is asked to work on. */
  blinded: Ciphertext;
  /** Secret to the recipient. */
  beta: bigint;
}

/**
 * The recipient re-randomises the ciphertext before the committee touches it.
 *
 * What this buys: the partials that appear on the wire are computed against a ciphertext nobody
 * else can link to a deck position, so a relay carrying them — or anyone who obtains the
 * transcript later — learns nothing, and the partials cannot be replayed against the public deck.
 *
 * What it does **not** buy: protection from the committee itself. Any `k` members hold enough
 * share material to compute `x·A` on the *public* ciphertext at any time, with or without a
 * blinding factor. Threshold cryptography converts "trust one dealer" into "trust that `k` of `n`
 * are not colluding"; it does not make confidentiality unconditional.
 */
export function blindForRecipient(ct: Ciphertext, h: Pt, rng: Randomness): Blinding {
  const beta = rng.scalar();
  return { blinded: rerandomize(ct, h, beta), beta };
}

/** The recipient combines the partials it received and decodes its card. */
export function privateReveal(blinding: Blinding, partials: PartialDecryption[]): number | null {
  return pointToCard(blinding.blinded.b.subtract(combine(partials)));
}

/**
 * Bytes on the wire for one revealed card at threshold `k`: each responding member returns a
 * group element plus a 64-byte proof. A blinded request also carries the blinded ciphertext.
 */
export function revealBytes(k: number, blinded: boolean): number {
  return k * PARTIAL_BYTES + (blinded ? 2 * POINT_BYTES : 0);
}

export { subS };
