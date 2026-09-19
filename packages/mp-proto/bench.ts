/**
 * Measurements for the collaborative shuffle.
 *   node scripts/run.mjs bench.ts [--json out.json] [--quick]
 *
 * Everything is deterministic (seeded randomness) so runs are comparable. Timings come from a
 * shared laptop with other work running, so treat absolute numbers as conservative and the ratios
 * as the signal — the same caveat the storage prototype carries.
 *
 * Every phase is measured twice: once naively, and once with the three optimisations a production
 * implementation would use (point precomputation on reused points, Pippenger for interpolation,
 * and optimistic verification). The gap between them is most of the story.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import {
  DECK_SIZE,
  G,
  POINT_BYTES,
  Point,
  SCALAR_BYTES,
  blindForRecipient,
  cardToPoint,
  combine,
  combineFast,
  commitmentsFor,
  dkgBytes,
  encrypt,
  mul,
  optimisticReveal,
  partialDecrypt,
  partialValueOnly,
  precompute,
  proveDleq,
  runDkg,
  seededRandomness,
  shuffleProofBytes,
  shuffleWithProof,
  trivialDeck,
  verifyDleq,
  verifyShare,
  verifyShareNaive,
  verifyShuffle,
  type Ciphertext,
  type DkgResult,
  type Pt,
} from './src/index.ts';
import { PARTIAL_BYTES } from './src/reveal.ts';
import { CIPHERTEXT_BYTES } from './src/elgamal.ts';

const args = new Map<string, string>();
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.replace(/^--/, ''), process.argv[i + 1] ?? '1');
}
const JSON_OUT = args.get('json');
const QUICK = args.has('quick');
const results: Record<string, unknown> = {};

function timeIt(fn: () => void, iterations: number): { p50: number; p95: number; mean: number } {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (p: number) =>
    samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]!;
  return {
    p50: round(at(50)),
    p95: round(at(95)),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
  };
}

function once(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return round(performance.now() - t0);
}

function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** A structurally identical point with no cached window table, for measuring the cold path. */
function cold(p: Pt): Pt {
  return Point.fromBytes(p.toBytes());
}

/**
 * Precompute *and force the table to be built*. noble fills the window lazily on first use, so
 * timing a freshly `precompute()`d point without this measures table construction, not the
 * steady state a long-lived member actually sees.
 */
function warm(p: Pt): Pt {
  const w = precompute(p);
  w.multiplyUnsafe(12345n);
  return w;
}

function show(title: string, rows: Record<string, unknown>) {
  console.log(`\n${title}`);
  console.table(rows);
}

// ---------------------------------------------------------------------------------------------
// 1. Primitives. Everything below is a multiple of these.
// ---------------------------------------------------------------------------------------------
function benchPrimitives() {
  const rng = seededRandomness('prim');
  const s = rng.scalar();
  const p = mul(G, rng.scalar());
  const warmPoint = warm(cold(p));
  const q = mul(G, rng.scalar());
  const iterations = QUICK ? 200 : 1500;

  const rows = {
    'scalar mult, secret scalar, cold point': timeIt(() => void mul(cold(p), s, true), 100),
    'scalar mult, secret scalar, warm point': timeIt(
      () => void mul(warmPoint, s, true),
      iterations,
    ),
    'scalar mult, public scalar, cold point': timeIt(() => void p.multiplyUnsafe(s), iterations),
    'scalar mult, public scalar, warm point': timeIt(
      () => void warmPoint.multiplyUnsafe(s),
      iterations,
    ),
    'scalar mult by the generator': timeIt(() => void mul(G, s, true), iterations),
    'point add': timeIt(() => void p.add(q), iterations * 4),
    'encode to 32 bytes': timeIt(() => void p.toBytes(), iterations * 4),
  };
  show(
    'Primitives (ms)',
    Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { p50: v.p50, mean: v.mean }])),
  );
  results.primitives = rows;
}

// ---------------------------------------------------------------------------------------------
// 2. DKG, per member. The whole protocol is n times one member's work.
// ---------------------------------------------------------------------------------------------
function benchDkg() {
  const configs = QUICK
    ? [
        { n: 9, k: 6 },
        { n: 30, k: 20 },
      ]
    : [
        { n: 9, k: 6 },
        { n: 30, k: 20 },
        { n: 50, k: 34 },
        { n: 150, k: 100 },
      ];
  const rows: Record<string, unknown> = {};

  for (const { n, k } of configs) {
    const rng = seededRandomness(`dkg:${n}:${k}`);
    const coefficients = Array.from({ length: k }, () => rng.scalar());
    const commitMs = once(() => void commitmentsFor(coefficients));
    const broadcast = { from: 1, commitments: commitmentsFor(coefficients) };

    // Verification is the dominant cost: k multiplications per received share. Warming the
    // dealer's commitment points makes every subsequent check against that dealer cheaper.
    // A realistic member index: powers of a small index stay small for the first few terms, so
    // using index 1 or 2 would flatter the result.
    const index = Math.max(2, Math.floor(n / 2));
    const coldBroadcast = { from: 1, commitments: broadcast.commitments.map(cold) };
    const naiveOne = timeIt(
      () => void verifyShareNaive({ from: 1, to: index, value: rng.scalar() }, coldBroadcast),
      QUICK ? 2 : 5,
    ).mean;
    const msmBroadcast = { from: 1, commitments: broadcast.commitments.map(cold) };
    const msmOne = timeIt(
      () => void verifyShare({ from: 1, to: index, value: rng.scalar() }, msmBroadcast),
      QUICK ? 3 : 10,
    ).mean;

    const bytes = dkgBytes({ n, k });
    rows[`n=${n} k=${k}`] = {
      'commit (ms)': commitMs,
      'verify 1 share, k mults (ms)': round(naiveOne),
      'verify 1 share, MSM (ms)': round(msmOne),
      'verify all n-1, MSM (ms)': round(msmOne * (n - 1)),
      'member total (ms)': round(commitMs + msmOne * (n - 1)),
      'broadcast, all members (KB)': round(bytes.broadcastTotal / 1024, 1),
      'private in (B)': (n - 1) * SCALAR_BYTES,
      'retained (B)': bytes.retainedPerMember,
    };
  }
  show('DKG, per member (setup, amortised over a session)', rows);
  results.dkg = rows;
}

// ---------------------------------------------------------------------------------------------
// 3. Shuffle and its proof.
// ---------------------------------------------------------------------------------------------
function benchShuffle(dkg: DkgResult) {
  const repetitionCounts = QUICK ? [8, 20] : [8, 20, 30, 40];
  const rows: Record<string, unknown> = {};
  const deck = trivialDeck();

  // Re-randomisation multiplies by the joint public key once per card, so warming it is the
  // single most valuable precomputation in the shuffle path.
  const coldKey = cold(dkg.publicKey);
  const warmKey = warm(cold(dkg.publicKey));

  for (const t of repetitionCounts) {
    const rng = seededRandomness(`shuffle:${t}`);
    let proofBytes = 0;
    let shuffled: Ciphertext[] = [];
    let proof!: Parameters<typeof verifyShuffle>[3];

    const coldMs = once(() => void shuffleWithProof(deck, coldKey, seededRandomness(`c:${t}`), t));
    const proveMs = once(() => {
      const r = shuffleWithProof(deck, warmKey, rng, t);
      proofBytes = shuffleProofBytes(r.proof);
      shuffled = r.deck;
      proof = r.proof;
    });
    const verifyMs = once(() => {
      if (!verifyShuffle(deck, shuffled, warmKey, proof)) throw new Error('proof failed');
    });

    rows[`t=${t}`] = {
      soundness: `2^-${t}`,
      'prove, cold key (ms)': coldMs,
      'prove, warm key (ms)': proveMs,
      'verify, warm key (ms)': verifyMs,
      'proof (KB)': round(proofBytes / 1024, 1),
    };
  }
  show('Shuffle, one shuffler, 52 cards', rows);

  const bareCold = timeIt(
    () => void shuffleWithProof(deck, coldKey, seededRandomness('b'), 0),
    QUICK ? 3 : 10,
  );
  const bareWarm = timeIt(
    () => void shuffleWithProof(deck, warmKey, seededRandomness('b'), 0),
    QUICK ? 3 : 10,
  );
  console.log(
    `shuffle with no proof: cold key ${bareCold.p50} ms, warm key ${bareWarm.p50} ms (52 re-randomisations)`,
  );
  results.shuffle = { rows, bareCold: bareCold.p50, bareWarm: bareWarm.p50 };
}

// ---------------------------------------------------------------------------------------------
// 4. Reveal, per card, naive against tuned.
// ---------------------------------------------------------------------------------------------
function benchReveal() {
  const thresholds = QUICK ? [6, 20] : [6, 20, 34, 100];
  const rows: Record<string, unknown> = {};
  const rng = seededRandomness('reveal');
  const iterations = QUICK ? 20 : 100;
  let sampled = false;
  let partialMs = 0;
  let valueOnlyMs = 0;
  let verifyCold = 0;
  let verifyWarm = 0;

  for (const k of thresholds) {
    // A committee per threshold: a quorum smaller than k cannot interpolate, so measuring the
    // optimistic path against an under-sized quorum would only ever measure the fallback.
    const dkg = runDkg({ n: k, k }, seededRandomness(`reveal:${k}`));
    const quorum = dkg.members;
    const ct: Ciphertext = encrypt(cardToPoint(17), dkg.publicKey, rng.scalar());
    const partials = quorum.map((m) => partialDecrypt(ct, m, rng));
    const verifications = new Map(quorum.map((m) => [m.index, m.verification]));

    if (!sampled) {
      sampled = true;
      const member = quorum[0]!;
      partialMs = timeIt(() => void partialDecrypt(ct, member, rng), iterations).p50;
      valueOnlyMs = timeIt(() => void partialValueOnly(ct, member), iterations).p50;
      const value = partialValueOnly(ct, member);
      const proof = proveDleq(ct.a, member.verification, value, member.share, rng);
      verifyCold = timeIt(
        () => void verifyDleq(cold(ct.a), cold(member.verification), value, proof),
        40,
      ).p50;
      const warmA = warm(cold(ct.a));
      const warmY = warm(cold(member.verification));
      verifyWarm = timeIt(() => void verifyDleq(warmA, warmY, value, proof), iterations).p50;
    }

    const combineNaive = timeIt(() => void combine(partials), QUICK ? 5 : 20).p50;
    const combineMsm = timeIt(() => void combineFast(partials), QUICK ? 5 : 20).p50;
    const optimistic = timeIt(
      () => void optimisticReveal(ct, partials, verifications),
      QUICK ? 5 : 20,
    ).p50;
    // Sanity: the fast path must actually have produced the card, not fallen through.
    if (optimisticReveal(ct, partials, verifications).card !== 17) {
      throw new Error(`optimistic reveal failed at k=${k}`);
    }

    rows[`k=${k}`] = {
      'member: partial+proof (ms)': partialMs,
      'member: value only (ms)': valueOnlyMs,
      'combiner: verify k proofs, cold (ms)': round(verifyCold * k),
      'combiner: verify k proofs, warm (ms)': round(verifyWarm * k),
      'combiner: interpolate, naive (ms)': combineNaive,
      'combiner: interpolate, MSM (ms)': combineMsm,
      'combiner: optimistic total (ms)': optimistic,
      'bytes per card': k * PARTIAL_BYTES,
    };
  }
  show('Reveal, one card (member work is independent of k; combiner work is not)', rows);
  results.reveal = { rows };
}

// ---------------------------------------------------------------------------------------------
// 5. Batched reveals: a whole street at once, tuned path.
// ---------------------------------------------------------------------------------------------
function benchBatched(dkg: DkgResult) {
  const rng = seededRandomness('batch');
  const warmKey = warm(cold(dkg.publicKey));
  const deck = shuffleWithProof(trivialDeck(), warmKey, rng, 8).deck;
  const k = 20;
  const quorum = dkg.members.slice(0, k);
  for (const m of quorum) warm(m.verification);
  const verifications = new Map(quorum.map((m) => [m.index, m.verification]));
  const rows: Record<string, unknown> = {};

  for (const [label, count, blinded] of [
    ['9-handed hold’em hole cards', 18, true],
    ['OFC pineapple turn (3 seats × 3)', 9, true],
    ['flop', 3, false],
    ['turn or river', 1, false],
  ] as const) {
    const cards = deck.slice(0, count);
    const targets = blinded
      ? cards.map((ct) => blindForRecipient(ct, warmKey, rng))
      : cards.map((ct) => ({ blinded: ct, beta: 0n }));

    const memberMs = once(() => {
      for (const b of targets) partialDecrypt(b.blinded, quorum[0]!, rng);
    });
    const all = targets.map((b) => quorum.map((m) => partialDecrypt(b.blinded, m, rng)));

    const pessimistic = once(() => {
      all.forEach((partials, i) => {
        partials.forEach((p, j) => {
          if (!verifyDleq(targets[i]!.blinded.a, quorum[j]!.verification, p.value, p.proof))
            throw new Error('bad partial');
        });
        combine(partials);
      });
    });
    const optimistic = once(() => {
      all.forEach(
        (partials, i) => void optimisticReveal(targets[i]!.blinded, partials, verifications),
      );
    });

    rows[label] = {
      cards: count,
      'one member, all cards (ms)': memberMs,
      'combiner: verify all + combine (ms)': pessimistic,
      'combiner: optimistic (ms)': optimistic,
      'on the wire (KB)': round(
        (count * (k * PARTIAL_BYTES + (blinded ? 2 * POINT_BYTES : 0))) / 1024,
        1,
      ),
    };
  }
  show('Batched reveals at k=20 (one round trip each)', rows);
  results.batched = rows;
}

// ---------------------------------------------------------------------------------------------
// 6. Precomputation: how much of a reveal can be done before the card is asked for.
// ---------------------------------------------------------------------------------------------
function benchPrecompute(dkg: DkgResult) {
  const rng = seededRandomness('precompute');
  const warmKey = warm(cold(dkg.publicKey));
  const deck = shuffleWithProof(trivialDeck(), warmKey, rng, 8).deck;
  const member = dkg.members[0]!;
  warm(member.verification);

  const valuesOnly = once(() => {
    for (const ct of deck) partialValueOnly(ct, member);
  });
  const withProofs = once(() => {
    for (const ct of deck) partialDecrypt(ct, member, rng);
  });
  const lookup = timeIt(() => void deck[7], 2000).p50;
  const ct = deck[0]!;
  const blindedRequest = once(() => {
    const b = blindForRecipient(ct, warmKey, rng);
    partialDecrypt(b.blinded, member, rng);
  });

  const rows = {
    'precompute 52 positions, values only': {
      total: valuesOnly,
      'per card': round(valuesOnly / 52),
    },
    'precompute 52 positions, values + proofs': {
      total: withProofs,
      'per card': round(withProofs / 52),
    },
    'answer an unblinded request from the table': { total: lookup, 'per card': lookup },
    'answer a blinded request (nothing reusable)': {
      total: blindedRequest,
      'per card': blindedRequest,
    },
  };
  show('Precomputation after the shuffle (ms), one member', rows);
  results.precompute = rows;
}

// ---------------------------------------------------------------------------------------------
// 7. Resharing.
// ---------------------------------------------------------------------------------------------
function benchReshare() {
  const configs = QUICK
    ? [{ n: 9, k: 6 }]
    : [
        { n: 30, k: 20 },
        { n: 50, k: 34 },
      ];
  const rows: Record<string, unknown> = {};
  for (const { n, k } of configs) {
    const rng = seededRandomness(`reshare:${n}`);
    const coefficients = Array.from({ length: k }, () => rng.scalar());
    const perMemberMs = once(() => void commitmentsFor(coefficients));
    rows[`${k} of ${n} → fresh committee of ${n}`] = {
      'one resharer (ms)': perMemberMs,
      'all k resharers (ms)': round(perMemberMs * k),
      'broadcast (KB)': round((k * k * POINT_BYTES) / 1024, 1),
      'private shares (KB)': round((k * n * SCALAR_BYTES) / 1024, 1),
    };
  }
  show('Resharing (committee rotation, key unchanged)', rows);
  results.reshare = rows;
}

// ---------------------------------------------------------------------------------------------
// 8. Bytes per hand.
// ---------------------------------------------------------------------------------------------
function benchAccounting() {
  const k = 20;
  const shufflers = 3;
  const rows: Record<string, unknown> = {};

  for (const t of [8, 20, 30]) {
    const proofKb = (DECK_SIZE * CIPHERTEXT_BYTES * t + DECK_SIZE * t + DECK_SIZE * 32 * t) / 1024;
    const deckKb = (DECK_SIZE * CIPHERTEXT_BYTES) / 1024;
    const holdem =
      deckKb * shufflers +
      proofKb * shufflers +
      (18 * (k * PARTIAL_BYTES + 2 * POINT_BYTES)) / 1024 +
      (5 * k * PARTIAL_BYTES) / 1024;
    const ofc =
      deckKb * shufflers +
      proofKb * shufflers +
      (51 * (k * PARTIAL_BYTES + 2 * POINT_BYTES)) / 1024;
    rows[`t=${t} (2^-${t} soundness)`] = {
      'shuffle proofs (KB)': round(proofKb * shufflers, 1),
      'decks published (KB)': round(deckKb * shufflers, 1),
      "hold'em reveals (KB)": round(
        (18 * (k * PARTIAL_BYTES + 2 * POINT_BYTES) + 5 * k * PARTIAL_BYTES) / 1024,
        1,
      ),
      'OFC reveals (KB)': round((51 * (k * PARTIAL_BYTES + 2 * POINT_BYTES)) / 1024, 1),
      "hold'em TOTAL (KB)": round(holdem, 1),
      'OFC TOTAL (KB)': round(ofc, 1),
    };
  }
  show(`Bytes per hand at k=${k}, ${shufflers} shufflers`, rows);

  const retained = {
    'transcript hash': 32,
    'final deck commitment': 32,
    'committee id + threshold + beacon round': 16,
    'the dealt cards themselves (1 byte each)': 52,
    TOTAL: 132,
  };
  show(
    'Retained after the hand (bytes) — everything else is verified live and discarded',
    retained,
  );
  results.accounting = { rows, retained, k, shufflers };
}

// ---------------------------------------------------------------------------------------------

const mainDkg = runDkg({ n: 30, k: 20 }, seededRandomness('main'));

benchPrimitives();
benchDkg();
benchShuffle(mainDkg);
benchReveal();
benchBatched(mainDkg);
benchPrecompute(mainDkg);
benchReshare();
benchAccounting();

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(results, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1),
  );
  console.log(`\nwrote ${JSON_OUT}`);
}
