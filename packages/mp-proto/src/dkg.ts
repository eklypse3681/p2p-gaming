/**
 * Distributed key generation (Feldman verifiable secret sharing) and proactive resharing.
 *
 * The point of the exercise: produce a public key whose private key never exists anywhere.
 * Each member invents its own secret, splits it along a random polynomial, and sends one point
 * to every other member. Each member sums the points it received. Sums of polynomials are
 * polynomials, so everyone ends up holding a point on a combined curve whose constant term is
 * the sum of all the individual secrets — a number nobody computed and nobody can read.
 *
 * Feldman adds public commitments to each polynomial's coefficients, so a recipient can check
 * that the point it was sent really lies on the curve that was promised. A member who sends a
 * bad share is caught before any hand starts.
 */
import {
  G,
  POINT_BYTES,
  SCALAR_BYTES,
  ZERO,
  addS,
  invS,
  mod,
  msm,
  mul,
  mulS,
  powS,
  subS,
  type Pt,
  type Randomness,
} from './group.ts';

export interface DkgParams {
  /** Number of committee members. Member indices are 1..n (0 is reserved for the secret). */
  n: number;
  /** Shares required to decrypt. */
  k: number;
}

/** What one member publishes to everyone during setup. */
export interface DealerBroadcast {
  from: number;
  /** Commitments to the polynomial's coefficients: `C_m = a_m * G`, `k` of them. */
  commitments: Pt[];
}

/** What one member sends privately to one other member. */
export interface ShareMessage {
  from: number;
  to: number;
  value: bigint;
}

export interface MemberKey {
  index: number;
  /** This member's point on the combined curve. Secret. */
  share: bigint;
  /** `share * G`. Public, and recomputable by anyone from the broadcasts. */
  verification: Pt;
}

export interface DkgResult {
  params: DkgParams;
  /** The joint public key: the sum of every dealer's constant-term commitment. */
  publicKey: Pt;
  members: MemberKey[];
  broadcasts: DealerBroadcast[];
  /** Only for tests: the secret that would exist if anyone assembled it. Never used in protocol. */
  secretForTests: bigint;
}

function polynomial(rng: Randomness, degree: number): bigint[] {
  return Array.from({ length: degree + 1 }, () => rng.scalar());
}

function evaluate(coefficients: bigint[], at: number): bigint {
  // Horner, so a degree k-1 polynomial costs k-1 multiplications.
  const x = BigInt(at);
  let acc = 0n;
  for (let i = coefficients.length - 1; i >= 0; i--) acc = addS(mulS(acc, x), coefficients[i]!);
  return acc;
}

export function commitmentsFor(coefficients: bigint[]): Pt[] {
  return coefficients.map((c) => mul(G, c));
}

/**
 * Check a received share against the dealer's public commitments:
 * `share · G == Σ_m index^m · C_m`.
 *
 * The right-hand side is a `k`-term multi-scalar multiplication, so Pippenger handles it in one
 * pass rather than `k` separate multiplications.
 */
export function verifyShare(share: ShareMessage, broadcast: DealerBroadcast): boolean {
  const x = BigInt(share.to);
  const powers: bigint[] = [];
  let power = 1n;
  for (let i = 0; i < broadcast.commitments.length; i++) {
    powers.push(power);
    power = mod(power * x);
  }
  const expected = msm(broadcast.commitments, powers);
  return mul(G, share.value).equals(expected);
}

/** The same check done the obvious way, kept so the benchmark can show what MSM buys. */
export function verifyShareNaive(share: ShareMessage, broadcast: DealerBroadcast): boolean {
  let expected = ZERO;
  const x = BigInt(share.to);
  let power = 1n;
  for (const c of broadcast.commitments) {
    expected = expected.add(mul(c, power, false));
    power = mod(power * x);
  }
  return mul(G, share.value).equals(expected);
}

/** The public verification share `x_j * G`, recomputable by anyone from the broadcasts. */
export function verificationShare(index: number, broadcasts: DealerBroadcast[]): Pt {
  let acc = ZERO;
  const x = BigInt(index);
  for (const b of broadcasts) {
    let power = 1n;
    for (const c of b.commitments) {
      acc = acc.add(mul(c, power, false));
      power = mod(power * x);
    }
  }
  return acc;
}

/**
 * Run the whole protocol in one process. A real deployment spreads these steps across machines;
 * the arithmetic and the byte counts are identical, which is what the benchmarks measure.
 */
export function runDkg(params: DkgParams, rng: Randomness): DkgResult {
  const { n, k } = params;
  if (k < 1 || k > n) throw new RangeError(`threshold ${k} invalid for ${n} members`);

  const polynomials: bigint[][] = [];
  const broadcasts: DealerBroadcast[] = [];
  for (let i = 1; i <= n; i++) {
    const coefficients = polynomial(rng, k - 1);
    polynomials.push(coefficients);
    broadcasts.push({ from: i, commitments: commitmentsFor(coefficients) });
  }

  const members: MemberKey[] = [];
  for (let j = 1; j <= n; j++) {
    let share = 0n;
    for (let i = 1; i <= n; i++) share = addS(share, evaluate(polynomials[i - 1]!, j));
    members.push({ index: j, share, verification: mul(G, share) });
  }

  let publicKey = ZERO;
  for (const b of broadcasts) publicKey = publicKey.add(b.commitments[0]!);

  let secretForTests = 0n;
  for (const p of polynomials) secretForTests = addS(secretForTests, p[0]!);

  return { params, publicKey, members, broadcasts, secretForTests };
}

/** Every private share message the protocol sends, for benchmarking transport and verification. */
export function shareMessages(params: DkgParams, rng: Randomness): ShareMessage[] {
  const out: ShareMessage[] = [];
  for (let i = 1; i <= params.n; i++) {
    const coefficients = polynomial(rng, params.k - 1);
    for (let j = 1; j <= params.n; j++) {
      if (i !== j) out.push({ from: i, to: j, value: evaluate(coefficients, j) });
    }
  }
  return out;
}

/**
 * Lagrange coefficients at zero for a qualifying set of member indices.
 * `Σ λ_i · share_i = secret`, which is how partial decryptions combine.
 */
export function lagrange(indices: number[]): bigint[] {
  return indices.map((i) => {
    let num = 1n;
    let den = 1n;
    for (const j of indices) {
      if (j === i) continue;
      num = mulS(num, BigInt(j));
      den = mulS(den, subS(BigInt(j), BigInt(i)));
    }
    return mulS(num, invS(den));
  });
}

/** Only for tests: reconstruct the secret. The protocol itself never does this. */
export function reconstruct(members: MemberKey[], indices: number[]): bigint {
  const chosen = indices.map((i) => members.find((m) => m.index === i)!);
  const coefficients = lagrange(indices);
  let acc = 0n;
  for (let t = 0; t < chosen.length; t++) acc = addS(acc, mulS(coefficients[t]!, chosen[t]!.share));
  return acc;
}

export interface ResharePackage {
  from: number;
  /** Commitments to the resharing polynomial. Its constant term must equal `λ_i · Y_i`. */
  commitments: Pt[];
  shares: ShareMessage[];
}

/**
 * Hand the key to a new committee without the key changing.
 *
 * Each outgoing member reshares its *Lagrange-weighted* share as the constant term of a fresh
 * polynomial of the new degree. The new members sum what they receive. Because the weighted
 * shares already sum to the secret, the new curve's constant term is the same secret.
 *
 * The integrity check that matters: a resharer's constant-term commitment must equal
 * `λ_i · Y_i`, which is public. That proves it reshared the share it actually holds rather than
 * a value of its choosing.
 */
export function reshare(
  from: { members: MemberKey[]; indices: number[] },
  to: { indices: number[]; k: number },
  rng: Randomness,
): { packages: ResharePackage[]; members: MemberKey[] } {
  const coefficients = lagrange(from.indices);
  const packages: ResharePackage[] = [];

  from.indices.forEach((index, position) => {
    const member = from.members.find((m) => m.index === index);
    if (!member) throw new Error(`member ${index} not in the outgoing committee`);
    const weighted = mulS(coefficients[position]!, member.share);
    const poly = [weighted, ...polynomial(rng, to.k - 1).slice(1)];
    packages.push({
      from: index,
      commitments: commitmentsFor(poly),
      shares: to.indices.map((j) => ({ from: index, to: j, value: evaluate(poly, j) })),
    });
  });

  const members: MemberKey[] = to.indices.map((j) => {
    let share = 0n;
    for (const pkg of packages) {
      const msg = pkg.shares.find((s) => s.to === j)!;
      share = addS(share, msg.value);
    }
    return { index: j, share, verification: mul(G, share) };
  });

  return { packages, members };
}

/** `λ_i · Y_i`: what a resharer's constant-term commitment must equal. Public arithmetic. */
export function expectedResharedCommitment(
  member: MemberKey,
  indices: number[],
  position: number,
): Pt {
  return mul(member.verification, lagrange(indices)[position]!, false);
}

export function dkgBytes(params: DkgParams): {
  broadcastTotal: number;
  privateTotal: number;
  retainedPerMember: number;
} {
  const { n, k } = params;
  return {
    // Every member publishes k commitments, and everyone needs all of them.
    broadcastTotal: n * k * POINT_BYTES,
    // Every member sends one scalar to every other member.
    privateTotal: n * (n - 1) * SCALAR_BYTES,
    // A member keeps its own share plus the joint key; verification shares are recomputable
    // from the broadcasts but are cheaper to cache than to recompute.
    retainedPerMember: SCALAR_BYTES + POINT_BYTES + n * POINT_BYTES,
  };
}

/** `powS` re-exported for benchmark scripts that build polynomial evaluation points. */
export { powS };
