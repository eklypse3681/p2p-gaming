/**
 * Shuffling, and proving a shuffle was honest.
 *
 * A shuffle permutes the deck and re-randomises every ciphertext, so the output is unlinkable to
 * the input without the secret key. That alone is not enough: a dishonest shuffler could drop a
 * card and substitute a second copy of the ace of spades. The proof establishes that the output
 * is exactly the input, permuted and re-randomised, without revealing the permutation.
 *
 * The proof here is **cut-and-choose**, chosen because its soundness is easy to state and easy to
 * get right: the prover publishes `t` independent auxiliary shuffles of the input and, for each,
 * is asked at random either "show me how you got here from the input" or "show me how you get
 * from here to your output". A prover who tampered can answer one of the two but never both, so
 * cheating survives with probability `2^-t`.
 *
 * It is not what production should use. Cut-and-choose proofs are large — each repetition carries
 * a whole deck and a whole randomness vector — and §"Proof sizes" of the report contrasts this
 * with Bayer–Groth, whose proof is O(√N) group elements.
 */
import { challenge, concat, subS, type Pt, type Randomness } from './group.ts';
import { CIPHERTEXT_BYTES, ciphertextBytes, rerandomize, type Ciphertext } from './elgamal.ts';
import { DECK_SIZE } from './cards.ts';

export interface ShuffleWitness {
  /** `perm[i]` is which input index lands in output slot `i`. */
  perm: number[];
  /** Re-randomisation factor applied to output slot `i`. */
  rand: bigint[];
}

export interface ShuffleProof {
  /** The `t` auxiliary decks, published before the challenge is derived. */
  auxiliary: Ciphertext[][];
  /** One opening per repetition: to the input (bit 0) or to the output (bit 1). */
  openings: { bit: 0 | 1; perm: number[]; rand: bigint[] }[];
}

export interface ShuffleResult {
  deck: Ciphertext[];
  witness: ShuffleWitness;
  proof: ShuffleProof;
}

export function randomPermutation(rng: Randomness, size = DECK_SIZE): number[] {
  const perm = Array.from({ length: size }, (_, i) => i);
  // Fisher-Yates with rejection-free reduction; bias here is irrelevant to what we measure.
  for (let i = size - 1; i > 0; i--) {
    const j = Number(rng.scalar() % BigInt(i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm;
}

export function invertPermutation(perm: number[]): number[] {
  const inverse = new Array<number>(perm.length);
  perm.forEach((from, to) => {
    inverse[from] = to;
  });
  return inverse;
}

/** `out[i] = Rerand(deck[perm[i]], rand[i])`. */
export function applyShuffle(
  deck: Ciphertext[],
  h: Pt,
  perm: number[],
  rand: bigint[],
): Ciphertext[] {
  return perm.map((from, to) => rerandomize(deck[from]!, h, rand[to]!));
}

function deckDigest(deck: Ciphertext[]): Uint8Array {
  return concat(...deck.map(ciphertextBytes));
}

function challengeBits(
  input: Ciphertext[],
  output: Ciphertext[],
  auxiliary: Ciphertext[][],
  t: number,
): (0 | 1)[] {
  const seed = challenge(deckDigest(input), deckDigest(output), ...auxiliary.map(deckDigest));
  // One bit per repetition, drawn from the Fiat-Shamir scalar and extended as needed.
  const bits: (0 | 1)[] = [];
  let acc = seed;
  let counter = 0n;
  while (bits.length < t) {
    if (acc === 0n) {
      counter += 1n;
      acc = challenge(deckDigest(input), new Uint8Array([Number(counter & 0xffn)]));
    }
    bits.push(Number(acc & 1n) as 0 | 1);
    acc >>= 1n;
  }
  return bits;
}

/**
 * Shuffle and prove it. `repetitions` sets the soundness: a tampering shuffler escapes detection
 * with probability `2^-repetitions`.
 */
export function shuffleWithProof(
  deck: Ciphertext[],
  h: Pt,
  rng: Randomness,
  repetitions: number,
): ShuffleResult {
  const size = deck.length;
  const perm = randomPermutation(rng, size);
  const rand = Array.from({ length: size }, () => rng.scalar());
  const output = applyShuffle(deck, h, perm, rand);

  const auxPerms: number[][] = [];
  const auxRands: bigint[][] = [];
  const auxiliary: Ciphertext[][] = [];
  for (let j = 0; j < repetitions; j++) {
    const sigma = randomPermutation(rng, size);
    const s = Array.from({ length: size }, () => rng.scalar());
    auxPerms.push(sigma);
    auxRands.push(s);
    auxiliary.push(applyShuffle(deck, h, sigma, s));
  }

  const bits = challengeBits(deck, output, auxiliary, repetitions);
  const openings = bits.map((bit, j) => {
    const sigma = auxPerms[j]!;
    const s = auxRands[j]!;
    if (bit === 0) return { bit, perm: sigma, rand: s };
    // Link the auxiliary deck to the real output: tau[i] = sigma^-1[perm[i]],
    // u[i] = rand[i] - s[tau[i]].
    const sigmaInverse = invertPermutation(sigma);
    const tau = perm.map((from) => sigmaInverse[from]!);
    const u = tau.map((t, i) => subS(rand[i]!, s[t]!));
    return { bit, perm: tau, rand: u };
  });

  return { deck: output, witness: { perm, rand }, proof: { auxiliary, openings } };
}

export function verifyShuffle(
  input: Ciphertext[],
  output: Ciphertext[],
  h: Pt,
  proof: ShuffleProof,
): boolean {
  const { auxiliary, openings } = proof;
  if (auxiliary.length !== openings.length) return false;
  const bits = challengeBits(input, output, auxiliary, openings.length);

  for (let j = 0; j < openings.length; j++) {
    const opening = openings[j]!;
    if (opening.bit !== bits[j]) return false;
    const aux = auxiliary[j]!;
    const recomputed =
      opening.bit === 0
        ? applyShuffle(input, h, opening.perm, opening.rand)
        : applyShuffle(aux, h, opening.perm, opening.rand);
    const target = opening.bit === 0 ? aux : output;
    if (recomputed.length !== target.length) return false;
    for (let i = 0; i < recomputed.length; i++) {
      if (!recomputed[i]!.a.equals(target[i]!.a)) return false;
      if (!recomputed[i]!.b.equals(target[i]!.b)) return false;
    }
  }
  return true;
}

/**
 * Wire size of a cut-and-choose proof. Each repetition carries a full auxiliary deck plus one
 * opening (a permutation and a randomness vector), which is why these proofs are measured in
 * hundreds of kilobytes rather than hundreds of bytes.
 */
export function shuffleProofBytes(proof: ShuffleProof, size = DECK_SIZE): number {
  const decks = proof.auxiliary.length * size * CIPHERTEXT_BYTES;
  // A permutation entry needs 6 bits; one byte per entry is what this prototype serialises.
  const perms = proof.openings.length * size;
  const rands = proof.openings.length * size * 32;
  return decks + perms + rands;
}

/** Soundness error of a cut-and-choose proof with `t` repetitions, as a probability. */
export function soundnessError(repetitions: number): number {
  return Math.pow(2, -repetitions);
}
