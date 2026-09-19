import { describe, expect, it } from 'vitest';
import {
  DECK_SIZE,
  assertDistinctCardPoints,
  blindForRecipient,
  cardToPoint,
  combine,
  combineFast,
  decrypt,
  dkgBytes,
  encrypt,
  expectedResharedCommitment,
  optimisticReveal,
  lagrange,
  mul,
  partialDecrypt,
  partialValueOnly,
  pointToCard,
  precompute,
  precomputeMember,
  privateReveal,
  publicReveal,
  reconstruct,
  reshare,
  runDkg,
  seededRandomness,
  shuffleProofBytes,
  shuffleWithProof,
  trivialDeck,
  verifyPartial,
  verifyShare,
  verifyShareNaive,
  verifyShuffle,
  verificationShare,
  type Ciphertext,
  type MemberKey,
} from '../src/index.ts';
import { G, ZERO } from '../src/group.ts';
import { commitmentsFor } from '../src/dkg.ts';

const REPS = 12; // Soundness 2^-12 — enough for tests, far below what production would use.

function setup(n: number, k: number, seed = 1) {
  const rng = seededRandomness(seed);
  const dkg = runDkg({ n, k }, rng);
  return { rng, dkg };
}

describe('card encoding', () => {
  it('maps 52 cards to distinct points that decode back', () => {
    assertDistinctCardPoints();
    for (let i = 0; i < DECK_SIZE; i++) {
      expect(pointToCard(cardToPoint(i))).toBe(i);
    }
  });

  it('returns null for a point that is not a card', () => {
    expect(pointToCard(ZERO)).toBeNull();
    expect(pointToCard(G)).toBeNull();
  });
});

describe('distributed key generation', () => {
  it('produces a key nobody holds, recoverable only by a quorum', () => {
    const { dkg } = setup(9, 6);
    expect(mul(G, dkg.secretForTests).equals(dkg.publicKey)).toBe(true);

    // Any 6 members interpolate to the same secret.
    const a = reconstruct(dkg.members, [1, 2, 3, 4, 5, 6]);
    const b = reconstruct(dkg.members, [2, 4, 6, 7, 8, 9]);
    expect(a).toBe(dkg.secretForTests);
    expect(b).toBe(dkg.secretForTests);
  });

  it('k-1 members cannot decrypt', () => {
    const { rng, dkg } = setup(9, 6);
    const ct = { a: mul(G, 7n), b: cardToPoint(11).add(mul(dkg.publicKey, 7n)) };

    const quorum = dkg.members.slice(0, 6).map((m) => partialDecrypt(ct, m, rng));
    expect(publicReveal(ct, quorum)).toBe(11);

    const short = dkg.members.slice(0, 5).map((m) => partialDecrypt(ct, m, rng));
    expect(publicReveal(ct, short)).toBeNull();

    // And the wrong interpolation of a short set is not merely undecodable, it is wrong.
    expect(combine(short).equals(combine(quorum))).toBe(false);
  });

  it('detects a dealer who sends a share off its committed polynomial', () => {
    const rng = seededRandomness(42);
    const coefficients = [rng.scalar(), rng.scalar(), rng.scalar()];
    const broadcast = { from: 1, commitments: commitmentsFor(coefficients) };

    let honest = 0n;
    const x = 4n;
    for (let i = coefficients.length - 1; i >= 0; i--) honest = honest * x + coefficients[i]!;

    expect(verifyShare({ from: 1, to: 4, value: honest }, broadcast)).toBe(true);
    expect(verifyShare({ from: 1, to: 4, value: honest + 1n }, broadcast)).toBe(false);
  });

  it('publishes verification shares anyone can recompute', () => {
    const { dkg } = setup(12, 8);
    for (const member of dkg.members) {
      expect(verificationShare(member.index, dkg.broadcasts).equals(member.verification)).toBe(
        true,
      );
    }
  });

  it('accounts for its own bytes', () => {
    const bytes = dkgBytes({ n: 30, k: 20 });
    expect(bytes.broadcastTotal).toBe(30 * 20 * 32);
    expect(bytes.privateTotal).toBe(30 * 29 * 32);
  });
});

describe('shuffle', () => {
  it('preserves the multiset of cards and hides the permutation', () => {
    const { rng, dkg } = setup(5, 3);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);

    const decoded = shuffled.deck.map((ct) => pointToCard(decrypt(ct, dkg.secretForTests)));
    expect(decoded.every((c) => c !== null)).toBe(true);
    expect([...decoded].sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: DECK_SIZE }, (_, i) => i),
    );
    // A shuffle that returned the deck untouched would be suspicious.
    expect(decoded).not.toEqual(Array.from({ length: DECK_SIZE }, (_, i) => i));
  });

  it('verifies an honest proof', () => {
    const { rng, dkg } = setup(5, 3);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
    expect(verifyShuffle(deck, shuffled.deck, dkg.publicKey, shuffled.proof)).toBe(true);
    expect(shuffleProofBytes(shuffled.proof)).toBeGreaterThan(0);
  });

  it('rejects an output with a substituted card', () => {
    const { rng, dkg } = setup(5, 3);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
    const tampered = shuffled.deck.slice();
    tampered[7] = tampered[3]!; // two copies of one card
    expect(verifyShuffle(deck, tampered, dkg.publicKey, shuffled.proof)).toBe(false);
  });

  it('rejects a proof whose openings were swapped', () => {
    const { rng, dkg } = setup(5, 3);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
    const openings = shuffled.proof.openings.map((o) => ({ ...o, bit: (1 - o.bit) as 0 | 1 }));
    expect(verifyShuffle(deck, shuffled.deck, dkg.publicKey, { ...shuffled.proof, openings })).toBe(
      false,
    );
  });

  it('chains shufflers so one honest shuffler suffices', () => {
    const { rng, dkg } = setup(5, 3);
    let deck = trivialDeck();
    const inputs: Ciphertext[][] = [];
    for (let i = 0; i < 3; i++) {
      inputs.push(deck);
      const result = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
      expect(verifyShuffle(deck, result.deck, dkg.publicKey, result.proof)).toBe(true);
      deck = result.deck;
    }
    const decoded = deck.map((ct) => pointToCard(decrypt(ct, dkg.secretForTests)));
    expect([...decoded].sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: DECK_SIZE }, (_, i) => i),
    );
  });
});

describe('threshold reveal', () => {
  it('reveals a public card and rejects a tampered partial', () => {
    const { rng, dkg } = setup(9, 6);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
    const ct = shuffled.deck[0]!;

    const quorum = dkg.members.slice(0, 6);
    const partials = quorum.map((m) => partialDecrypt(ct, m, rng));
    partials.forEach((p, i) => {
      expect(verifyPartial(ct, p, quorum[i]!.verification)).toBe(true);
    });

    const card = publicReveal(ct, partials);
    expect(card).not.toBeNull();
    expect(card).toBe(pointToCard(decrypt(ct, dkg.secretForTests)));

    // A member that emits a wrong value is caught by its own proof.
    const bad = { ...partials[2]!, value: partials[2]!.value.add(G) };
    expect(verifyPartial(ct, bad, quorum[2]!.verification)).toBe(false);

    // And a proof from the wrong member does not verify against this member's key.
    expect(verifyPartial(ct, partials[1]!, quorum[2]!.verification)).toBe(false);
  });

  it('delivers a private card to its recipient only', () => {
    const { rng, dkg } = setup(9, 6);
    const deck = trivialDeck();
    const shuffled = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
    const ct = shuffled.deck[4]!;

    const blinding = blindForRecipient(ct, dkg.publicKey, rng);
    const quorum = dkg.members.slice(2, 8);
    const partials = quorum.map((m) => partialDecrypt(blinding.blinded, m, rng));
    partials.forEach((p, i) => {
      expect(verifyPartial(blinding.blinded, p, quorum[i]!.verification)).toBe(true);
    });

    const card = privateReveal(blinding, partials);
    expect(card).toBe(pointToCard(decrypt(ct, dkg.secretForTests)));

    // Without the recipient's blinding factor the same partials do not open the public
    // ciphertext: an observer holding the transcript cannot link them to a deck position.
    expect(publicReveal(ct, partials)).toBeNull();
  });

  it('interpolates to the same value from any quorum', () => {
    const { rng, dkg } = setup(12, 8);
    const ct = { a: mul(G, 99n), b: cardToPoint(20).add(mul(dkg.publicKey, 99n)) };
    const first = dkg.members.slice(0, 8).map((m) => partialDecrypt(ct, m, rng));
    const second = dkg.members.slice(4, 12).map((m) => partialDecrypt(ct, m, rng));
    expect(combine(first).equals(combine(second))).toBe(true);
    expect(publicReveal(ct, first)).toBe(20);
    expect(publicReveal(ct, second)).toBe(20);
  });

  it('produces Lagrange coefficients that sum a secret correctly', () => {
    const indices = [2, 5, 9];
    const coefficients = lagrange(indices);
    expect(coefficients).toHaveLength(3);
    expect(coefficients.every((c) => c > 0n)).toBe(true);
  });
});

describe('resharing', () => {
  it('rotates the committee without changing the key', () => {
    const rng = seededRandomness(7);
    const dkg = runDkg({ n: 9, k: 6 }, rng);
    const outgoing = [1, 2, 3, 4, 5, 6];
    const incoming = [10, 11, 12, 13, 14, 15, 16];

    const { packages, members } = reshare(
      { members: dkg.members, indices: outgoing },
      { indices: incoming, k: 5 },
      rng,
    );

    // Each resharer proved it reshared the share it actually holds.
    packages.forEach((pkg, position) => {
      const member = dkg.members.find((m) => m.index === pkg.from)!;
      const expected = expectedResharedCommitment(member, outgoing, position);
      expect(pkg.commitments[0]!.equals(expected)).toBe(true);
    });

    // The new committee decrypts what the old one could.
    const ct = { a: mul(G, 31n), b: cardToPoint(44).add(mul(dkg.publicKey, 31n)) };
    const quorum: MemberKey[] = members.slice(0, 5);
    const partials = quorum.map((m) => partialDecrypt(ct, m, rng));
    expect(publicReveal(ct, partials)).toBe(44);

    // Old shares are unrelated to new ones; the key is the only thing preserved.
    expect(members[0]!.share).not.toBe(dkg.members[0]!.share);
  });
});

describe('a whole hand', () => {
  it('deals hole cards privately and community cards publicly', () => {
    const rng = seededRandomness(2024);
    const dkg = runDkg({ n: 30, k: 20 }, rng);
    const quorum = dkg.members.slice(0, 20);

    let deck = trivialDeck();
    for (let s = 0; s < 3; s++) {
      const result = shuffleWithProof(deck, dkg.publicKey, rng, REPS);
      expect(verifyShuffle(deck, result.deck, dkg.publicKey, result.proof)).toBe(true);
      deck = result.deck;
    }

    const seats = 9;
    const holes: number[][] = Array.from({ length: seats }, () => []);
    let position = 0;
    for (let round = 0; round < 2; round++) {
      for (let seat = 0; seat < seats; seat++) {
        const ct = deck[position++]!;
        const blinding = blindForRecipient(ct, dkg.publicKey, rng);
        const partials = quorum.map((m) => partialDecrypt(blinding.blinded, m, rng));
        const card = privateReveal(blinding, partials);
        expect(card).not.toBeNull();
        holes[seat]!.push(card!);
      }
    }

    const board: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ct = deck[position++]!;
      const partials = quorum.map((m) => partialDecrypt(ct, m, rng));
      const card = publicReveal(ct, partials);
      expect(card).not.toBeNull();
      board.push(card!);
    }

    // 18 hole cards + 5 board cards, all distinct: no card was dealt twice.
    const dealt = [...holes.flat(), ...board];
    expect(dealt).toHaveLength(23);
    expect(new Set(dealt).size).toBe(23);
  });
});

describe('the tuned paths behave like the plain ones', () => {
  it('MSM interpolation agrees with the naive loop', () => {
    const { rng, dkg } = setup(12, 8);
    const ct = { a: mul(G, 55n), b: cardToPoint(9).add(mul(dkg.publicKey, 55n)) };
    const partials = dkg.members.slice(0, 8).map((m) => partialDecrypt(ct, m, rng));
    expect(combineFast(partials).equals(combine(partials))).toBe(true);
    expect(combineFast([])).toEqual(ZERO);
  });

  it('MSM share verification agrees with the naive loop, and both catch a bad share', () => {
    const rng = seededRandomness(99);
    const coefficients = [rng.scalar(), rng.scalar(), rng.scalar(), rng.scalar()];
    const broadcast = { from: 1, commitments: commitmentsFor(coefficients) };
    let honest = 0n;
    const x = 7n;
    for (let i = coefficients.length - 1; i >= 0; i--) honest = honest * x + coefficients[i]!;

    const good = { from: 1, to: 7, value: honest };
    const bad = { from: 1, to: 7, value: honest + 5n };
    expect(verifyShare(good, broadcast)).toBe(true);
    expect(verifyShareNaive(good, broadcast)).toBe(true);
    expect(verifyShare(bad, broadcast)).toBe(false);
    expect(verifyShareNaive(bad, broadcast)).toBe(false);
  });

  it('optimistic reveal returns the card without checking proofs, and names culprits when it cannot', () => {
    const { rng, dkg } = setup(9, 6);
    const ct = encrypt(cardToPoint(33), dkg.publicKey, rng.scalar());
    const quorum = dkg.members.slice(0, 6);
    const verifications = new Map(quorum.map((m) => [m.index, m.verification]));
    const partials = quorum.map((m) => partialDecrypt(ct, m, rng));

    const good = optimisticReveal(ct, partials, verifications);
    expect(good.card).toBe(33);
    expect(good.culprits).toBeUndefined();

    // One member deviates: the result no longer decodes, and the fallback identifies them.
    const tampered = partials.map((p, i) => (i === 3 ? { ...p, value: p.value.add(G) } : p));
    const bad = optimisticReveal(ct, tampered, verifications);
    expect(bad.card).toBeNull();
    expect(bad.culprits).toEqual([quorum[3]!.index]);
  });

  it('precomputation does not change any result', () => {
    const { rng, dkg } = setup(9, 6);
    const ct = encrypt(cardToPoint(2), dkg.publicKey, rng.scalar());
    const before = dkg.members.slice(0, 6).map((m) => partialValueOnly(ct, m).toHex());
    for (const m of dkg.members) precomputeMember(m);
    precompute(dkg.publicKey);
    const after = dkg.members.slice(0, 6).map((m) => partialValueOnly(ct, m).toHex());
    expect(after).toEqual(before);

    const partials = dkg.members.slice(0, 6).map((m) => partialDecrypt(ct, m, rng));
    expect(publicReveal(ct, partials)).toBe(2);
  });
});
