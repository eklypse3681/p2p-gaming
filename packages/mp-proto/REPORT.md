# Collaborative shuffle (mental poker) — prototype findings

**Summary.** A card reveal costs each committee member **1.7 ms** of work and puts **96 bytes** on
the wire; a whole 9-handed hold'em deal is **35 KB** and one round trip. With three optimisations
— pipelining the shuffle, precomputing partial decryptions, and over-requesting — the added wall
clock per hand over a plaintext dealer is **41–109 ms depending on latency**, which is roughly one
extra round trip and essentially no compute. The cryptography is not the problem. **The shuffle
proof is**: cut-and-choose costs 295 KB and 2.2 s of prove-plus-verify per hand at 2^-20 soundness,
and it is the only reason a hand would feel slow. It is also entirely removable — a production
Bayer–Groth proof is O(sqrt N) and §7 sizes it. Almost nothing needs to be stored: **132 bytes per
hand** survives, because every proof is verified live and then discarded.

Throwaway prototype (`packages/mp-proto`) implementing distributed key generation, a verifiable
shuffle, threshold reveal with Chaum–Pedersen proofs, private reveal to one recipient, and
proactive resharing, over ristretto255 via `@noble/curves`.

Environment: Node 25.8, macOS, pure-JavaScript curve arithmetic, on a shared laptop with other
agents running. Absolute timings are conservative; the ratios are the signal. §8 estimates what a
Rust/WASM implementation would change.

---

## 1. Primitives

Everything below is a multiple of one number: the cost of a scalar multiplication.

| Operation                                  | p50 (ms) |
| ------------------------------------------ | -------: |
| scalar mult, secret scalar, **cold** point |    0.726 |
| scalar mult, secret scalar, **warm** point |    0.076 |
| scalar mult, public scalar, **cold** point |    0.540 |
| scalar mult, public scalar, **warm** point |    0.065 |
| scalar mult by the generator               |    0.163 |
| point addition                             |    0.001 |
| encode a group element to 32 bytes         |    0.056 |

"Warm" means the point carries a cached window table. This is the single most valuable
optimisation in the whole prototype — **8x on every multiplication** — and it applies exactly
where it matters, because the hot points are all reused: the joint public key is multiplied once
per card in every re-randomisation, and a member's verification share is multiplied once per proof
it ever verifies. Production must precompute these. (noble builds the table lazily on first use,
so a benchmark that measures the first call measures table construction instead. `bench.ts` forces
the table before timing.)

---

## 2. Reveal: what a card costs

A member's work does not depend on the threshold. Only the combiner's does.

| Threshold | member: partial + proof | member: value only | combiner: verify all proofs (warm) | combiner: interpolate (MSM) | combiner: **optimistic** | bytes/card |
| --------: | ----------------------: | -----------------: | ---------------------------------: | --------------------------: | -----------------------: | ---------: |
|     k = 6 |                 1.79 ms |            0.65 ms |                            6.98 ms |                     2.48 ms |              **2.55 ms** |        576 |
|    k = 20 |                 1.79 ms |            0.65 ms |                           22.90 ms |                     5.51 ms |              **5.53 ms** |      1,920 |
|    k = 34 |                 1.79 ms |            0.65 ms |                           38.83 ms |                     7.13 ms |              **7.15 ms** |      3,264 |
|   k = 100 |                 1.79 ms |            0.65 ms |                          114.20 ms |                    18.52 ms |             **18.60 ms** |      9,600 |

A partial decryption is 32 bytes and its Chaum–Pedersen proof is 64 bytes, so **96 bytes per
member per card**, flat.

### 2.1 Optimistic verification

The combiner's obvious algorithm — verify all `k` proofs, then interpolate — is 4x more expensive
than interpolating alone. It is also unnecessary on the happy path.

**Combine first, and only check proofs if the result fails to decode.** A member below the
threshold does not know the card, so any deviation it introduces shifts the result by a value it
cannot steer, and the combination lands on a point that is not one of the 52 with overwhelming
probability. A quorum large enough to steer the result to a _chosen_ wrong card is by definition
large enough to read the card anyway, so nothing is traded away. When the fast path does fail, the
proofs are still there and they name the culprit (tested).

This is the difference between the last two columns above: **22.9 ms into 5.5 ms at k = 20**.

### 2.2 Batched reveals

A street is one round trip, not one per card.

| Batch                            | cards | one member | combiner, verify all | combiner, optimistic | on the wire |
| -------------------------------- | ----: | ---------: | -------------------: | -------------------: | ----------: |
| 9-handed hold'em hole cards      |    18 |    31.3 ms |             711.6 ms |          **99.1 ms** |     34.9 KB |
| OFC pineapple turn (3 seats x 3) |     9 |    16.3 ms |             364.2 ms |          **44.4 ms** |     17.4 KB |
| flop                             |     3 |     5.0 ms |             109.6 ms |          **14.5 ms** |      5.6 KB |
| turn or river                    |     1 |     1.6 ms |              36.8 ms |           **4.9 ms** |      1.9 KB |

### 2.3 Precomputation

After the shuffle, the deck is fixed, so a member can compute its partial for **every** position
and hold them. Combining is what reveals a card, so holding partials leaks nothing.

| Member work after the shuffle                    |  total | per card |
| ------------------------------------------------ | -----: | -------: |
| precompute all 52 positions, values only         |  31 ms |  0.60 ms |
| precompute all 52 positions, values **+ proofs** |  85 ms |  1.64 ms |
| answer an unblinded request from the table       |  ~0 ms |    ~0 ms |
| answer a **blinded** request                     | 2.2 ms |   2.2 ms |

**The blinding factor breaks precomputation**, exactly as suspected: it only exists at deal time,
so a blinded request needs a fresh multiplication and a fresh proof. The cost is 2.2 ms per member
per card, which is small enough not to matter, but it is not zero and the report should not
pretend otherwise. Public reveals (community cards) are unblinded and therefore fully
precomputable; private reveals (hole cards) are not.

The whole deck can be precomputed with proofs in 85 ms, comfortably inside the pause between
hands.

---

## 3. The shuffle, and why its proof is the whole cost

Shuffling itself is cheap. Proving it is not.

| Repetitions | soundness | prove (cold key) | prove (warm key) | verify (warm key) | proof size |
| ----------: | --------: | ---------------: | ---------------: | ----------------: | ---------: |
|       t = 8 |      2^-8 |         396.0 ms |     **165.2 ms** |          156.2 ms |    39.4 KB |
|      t = 20 |     2^-20 |         987.5 ms |     **400.0 ms** |          374.5 ms |    98.5 KB |
|      t = 30 |     2^-30 |        1398.8 ms |     **608.6 ms** |          563.1 ms |   147.8 KB |
|      t = 40 |     2^-40 |        1880.5 ms |     **768.3 ms** |          710.1 ms |   197.0 KB |

A shuffle with **no** proof at all is 22 ms (52 re-randomisations, warm key). Everything above
that line is the proof.

**Why cut-and-choose is this big.** The prover publishes `t` independent auxiliary shuffles of the
input and opens each one either toward the input or toward the output. Every repetition therefore
carries a whole deck (3.3 KB) plus a permutation and a randomness vector (1.7 KB). A cheating
shuffler can answer one side but never both, so soundness is exactly 2^-t — crisp, easy to
implement correctly, and expensive.

**What production should use instead.** Bayer–Groth (2012) proves the same statement with a proof
of **O(sqrt N) group elements** and prover cost dominated by a handful of multi-exponentiations of
size N. For a 52-card deck that is on the order of a **few kilobytes and tens of milliseconds**,
against 98.5 KB and 400 ms here — a 20–50x reduction on both axes, and it removes the soundness
parameter entirely (the proof is negligibly sound in one shot). Verifiable-shuffle proofs of this
family are standard in electronic voting and are the reason this report does not treat the shuffle
cost as fundamental. **Not implemented here** (§7).

**In the meantime, pipelining hides it anyway** — see §5.

---

## 4. Setup: DKG and resharing

Per member. The whole protocol is `n` times one member's work, run once per session and amortised.

| Committee    |  commit | verify 1 share (k mults) | verify 1 share (MSM) | verify all n-1 | member total | broadcast (all) | private in | retained |
| ------------ | ------: | -----------------------: | -------------------: | -------------: | -----------: | --------------: | ---------: | -------: |
| n=9, k=6     |  1.1 ms |                  0.35 ms |              1.82 ms |        14.5 ms |  **15.7 ms** |          1.7 KB |      256 B |    352 B |
| n=30, k=20   |  3.2 ms |                  2.02 ms |              3.77 ms |       109.4 ms | **112.6 ms** |         18.8 KB |      928 B |  1,024 B |
| n=50, k=34   |  4.9 ms |                  5.91 ms |              5.73 ms |       280.7 ms | **285.7 ms** |         53.1 KB |    1,568 B |  1,664 B |
| n=150, k=100 | 14.6 ms |                 42.75 ms |             13.55 ms |      2018.2 ms |   **2.03 s** |        468.8 KB |    4,768 B |  4,864 B |

Feldman verification is a `k`-term multi-scalar multiplication, so Pippenger handles it in one
pass. That is why the MSM column beats the naive one by **3x** at k=100 and loses slightly at k=6:
MSM's crossover is around ten terms. The same crossover appears in reveal interpolation (§2).

**Setup is quadratic in members and it is the reason to rotate rather than rebuild.** A committee
of 150 costs two seconds per member and nearly half a megabyte of broadcast. A committee of 30
costs 113 ms. Resharing rotates membership without redoing any of it:

| Rotation                            | one resharer | all resharers | broadcast | private shares |
| ----------------------------------- | -----------: | ------------: | --------: | -------------: |
| 20 of 30 into a new committee of 30 |       3.2 ms |       64.3 ms |   12.5 KB |        18.8 KB |
| 34 of 50 into a new committee of 50 |       4.8 ms |      163.1 ms |   36.1 KB |        53.1 KB |

Resharing also refreshes the shares, so an attacker compromising members slowly never accumulates
a quorum. Run it every few minutes.

---

## 5. Latency: what can be moved off the critical path

Compute costs from §§2–4 composed with a network model. Member latencies are lognormal with
median = RTT and sigma = 0.6, which is the usual shape for internet round trips: most responses
near the median, a tail that misbehaves. 20,000 trials per figure.

### 5.1 Over-requesting

Ask all `n` members and use the first `k` replies, rather than asking exactly `k` and waiting for
the slowest of them. The whole value of this is what a heavy tail does to an order statistic.

| Configuration         | ask k, wait for all k | ask n, take first k |  saved | ratio | p95 exact | p95 over-request |
| --------------------- | --------------------: | ------------------: | -----: | ----: | --------: | ---------------: |
| k=6 of 9, RTT 50      |                115 ms |           **61 ms** |  54 ms |  1.89 |    209 ms |        **89 ms** |
| k=20 of 30, RTT 50    |                162 ms |           **63 ms** |  99 ms |  2.57 |    269 ms |        **79 ms** |
| k=34 of 50, RTT 50    |                183 ms |           **65 ms** | 118 ms |  2.82 |    299 ms |        **78 ms** |
| k=100 of 150, RTT 50  |                233 ms |           **64 ms** | 169 ms |  3.64 |    358 ms |        **71 ms** |
| k=20 of 30, RTT 150   |                485 ms |          **191 ms** | 294 ms |  2.54 |    811 ms |       **238 ms** |
| k=100 of 150, RTT 150 |                699 ms |          **193 ms** | 506 ms |  3.62 |  1,071 ms |       **215 ms** |

Two things worth noticing. **Over-requesting gets better as the committee grows**, because the
spare capacity grows with it — at k=100 of 150 it is a 3.6x improvement. And it collapses the
tail: p95 goes from 358 ms to 71 ms. Without it, a large committee is slower than a small one;
with it, **committee size is nearly free in latency terms**, which removes the main argument
against large committees.

### 5.2 The optimisation ladder — 9-handed hold'em

Committee 20 of 30, 3 shufflers, t = 20.

| RTT    |    naive | + over-request | + precomputed partials | + pipelined shuffle | plaintext dealer |  **added** |
| ------ | -------: | -------------: | ---------------------: | ------------------: | ---------------: | ---------: |
| 20 ms  | 2,735 ms |       2,455 ms |               2,417 ms |          **137 ms** |            96 ms |  **41 ms** |
| 50 ms  | 3,407 ms |       2,728 ms |               2,690 ms |          **289 ms** |           236 ms |  **49 ms** |
| 150 ms | 5,668 ms |       3,617 ms |               3,579 ms |          **801 ms** |           716 ms |  **89 ms** |
| 300 ms | 9,084 ms |       4,947 ms |               4,909 ms |        **1,561 ms** |         1,436 ms | **109 ms** |

### 5.3 The same ladder — OFC pineapple, 3 seats

| RTT    |     naive | all three optimisations | plaintext dealer |  **added** |
| ------ | --------: | ----------------------: | ---------------: | ---------: |
| 20 ms  |  2,900 ms |              **215 ms** |           120 ms |  **95 ms** |
| 50 ms  |  3,676 ms |              **405 ms** |           300 ms | **105 ms** |
| 150 ms |  6,276 ms |            **1,045 ms** |           900 ms | **160 ms** |
| 300 ms | 10,132 ms |            **1,995 ms** |         1,795 ms | **195 ms** |

OFC pays slightly more than hold'em because it has five dealing rounds to hold'em's four, and all
of them are blinded private reveals.

### 5.4 Where the time goes, RTT 50 ms

**Naive — 3,407 ms.** The shuffle is 79% of it.

| Phase                          | network |  compute |    total |
| ------------------------------ | ------: | -------: | -------: |
| shuffle (3 shufflers, chained) |  483 ms | 2,205 ms | 2,688 ms |
| deal 18 hole cards (batched)   |  161 ms |    41 ms |   202 ms |
| flop                           |  161 ms |    21 ms |   182 ms |
| turn                           |  161 ms |     7 ms |   168 ms |
| river                          |  161 ms |     7 ms |   168 ms |

**All three optimisations — 289 ms.** Every phase is one round trip with rounding-error compute.

| Phase                          | network | compute | total |
| ------------------------------ | ------: | ------: | ----: |
| shuffle (3 shufflers, chained) |    0 ms |    0 ms |  0 ms |
| deal 18 hole cards (batched)   |   63 ms |   11 ms | 74 ms |
| flop                           |   63 ms |   17 ms | 80 ms |
| turn                           |   63 ms |    6 ms | 69 ms |
| river                          |   63 ms |    6 ms | 69 ms |

**Confirmed:** with all three optimisations the added wall clock is one network round trip at the
deal plus one per street, and compute is near zero.

### 5.5 Connection setup

The committee holding warm connections is not optional.

| Scenario                  |   hand |    setup | first hand | steady state |
| ------------------------- | -----: | -------: | ---------: | -----------: |
| RTT 50, warm pool         | 295 ms |        0 |     295 ms |       295 ms |
| RTT 50, cold WebRTC, 1 s  | 295 ms | 1,000 ms |   1,295 ms |       295 ms |
| RTT 50, cold WebRTC, 3 s  | 295 ms | 3,000 ms |   3,295 ms |       295 ms |
| RTT 150, warm pool        | 799 ms |        0 |     799 ms |       799 ms |
| RTT 150, cold WebRTC, 3 s | 799 ms | 3,000 ms |   3,799 ms |       799 ms |

A committee drawn fresh per hand from cold peers pays 1–3 s **before every hand**, which is 4–10x
the entire cryptographic cost. A stable pool with connections already open pays it once. This is
the strongest operational argument for a long-lived committee rotated by resharing rather than
rebuilt per hand.

---

## 6. Data: transmitted against retained

### 6.1 Transmitted, per hand (k = 20, 3 shufflers)

| Component                      |        t = 8 |       t = 20 |       t = 30 |
| ------------------------------ | -----------: | -----------: | -----------: |
| shuffle proofs                 |     118.2 KB |     295.5 KB |     443.3 KB |
| decks published                |       9.8 KB |       9.8 KB |       9.8 KB |
| hold'em reveals (18 + 5 cards) |      44.3 KB |      44.3 KB |      44.3 KB |
| OFC reveals (51 cards)         |      98.8 KB |      98.8 KB |      98.8 KB |
| **hold'em total**              | **172.2 KB** | **349.5 KB** | **497.3 KB** |
| **OFC total**                  | **226.8 KB** | **404.1 KB** | **551.9 KB** |

The shuffle proof is **67–89% of every byte moved**. Reveals — the part that happens on the
critical path — are 44 KB for a whole hold'em hand. With a Bayer–Groth proof the totals would drop
to roughly **55–60 KB for hold'em** and **110 KB for OFC**, at which point the deck itself is the
biggest single item.

### 6.2 Retained, per hand

Near zero, and that is the right answer.

| Item                                  |   bytes |
| ------------------------------------- | ------: |
| transcript hash                       |      32 |
| final deck commitment                 |      32 |
| committee id, threshold, beacon round |      16 |
| the dealt cards themselves            |      52 |
| **total**                             | **132** |

**Nothing cryptographic needs to be stored.** Every proof exists to convince the participants at
the moment it is checked, and once checked it has done its job. What survives is a hash of the
transcript, so that a later dispute can be tested against a transcript someone kept, plus the
cards and the committee identity so the hand record is self-contained. That fits inside the
~270-byte hand record the storage prototype already measured, with room to spare.

If a hand is ever disputed, the participants can be asked to produce the transcript they verified;
its hash either matches or it does not. Storing half a megabyte of proofs per hand to pre-empt a
dispute that may never happen would cost 500 GB per million hands, against 132 MB for the hashes.

---

## 7. Not implemented

- **Bayer–Groth shuffle proof.** The single most valuable missing piece: O(sqrt N) proof size
  against this prototype's O(t*N), and no soundness parameter to tune. Expect a few kilobytes and
  tens of milliseconds for 52 cards, replacing 98.5 KB and 400 ms. §3 and §6.1 both change
  materially.
- **Batch verification of Chaum–Pedersen proofs.** With proofs in (T1, T2, s) form rather than the
  compact (c, s) form used here, `k` proofs can be checked as one random linear combination. Worth
  perhaps 2–3x on the pessimistic path — but optimistic verification (§2.1) already avoids that
  path entirely, so this matters only for an auditor replaying a transcript.
- **Side-channel hardening.** Secret-scalar multiplications use noble's constant-time ladder, but
  nothing else is hardened, and the prototype makes no attempt at constant-time table lookups when
  decoding a card.
- **Adversarial DKG completion.** Bad shares are detected (tested), but there is no complaint,
  disqualification, or restart protocol. A real deployment needs one.
- **Browser measurement.** Everything here ran in Node. §8 estimates the difference.
- **The transport.** No messages are actually sent; the network model is analytic.

---

## 8. What a browser would change

The curve arithmetic here is pure JavaScript. A Rust implementation of the same curve compiled to
WebAssembly is typically **3–6x faster** for this kind of workload, and browsers run the same WASM
at close to Node's speed. So the compute numbers above are the pessimistic end, and the
optimisations that matter — precomputation, MSM, optimistic verification — are the same in either
language.

Applying a conservative 3x to the tuned path: a hold'em hand's crypto compute falls from about
40 ms to roughly 13 ms, which is already below the noise floor of a single round trip. **The
conclusion does not depend on the language.** It depends on pipelining the shuffle, which is an
architectural choice, not a performance one.

One genuine browser constraint, unrelated to speed: a browser tab cannot listen for connections,
so committee members in browsers need the same rendezvous help as everyone else, and a tab that
sleeps stops responding. Over-requesting (§5.1) is what makes that survivable.

---

## 9. Recommendation

**Viable for 9-handed ring play, with one condition.**

The added cost of dealing every card through a threshold committee, rather than through a dealer
who can see them, is **41–109 ms per hand** across realistic latencies. That is one extra round
trip. Against a hand that takes minutes of human decision-making, it is invisible.

The condition is that all three optimisations are architectural, not optional:

1. **Pipeline the shuffle.** The committee for the next hand is known in advance, so shuffle its
   deck while the current hand is being played. This removes 2.2 s — 79% of the naive cost — from
   the critical path. Without it, nothing else matters.
2. **Precompute partial decryptions** for every deck position immediately after the shuffle
   (85 ms with proofs, for the whole deck). Public reveals then cost a member nothing. Private
   reveals still cost 2.2 ms because the recipient's blinding factor only exists at deal time.
3. **Over-request**: ask all `n`, use the first `k`. Worth 2.5–3.6x, and it makes committee size
   nearly free, which is what allows a committee large enough to be worth trusting.

And two things that follow from the measurements:

- **Keep the committee warm and long-lived**, rotated by resharing (64 ms) rather than rebuilt by
  DKG (113 ms at n=30, 2 s at n=150). Cold WebRTC setup at 1–3 s per hand would dwarf everything
  measured here.
- **Combine optimistically.** Verify proofs only when a reveal fails to decode. 4x on the
  combiner, no security given up.

**Committee sizing.** 20 of 30 is the sweet spot the numbers support: 113 ms of setup, 5.5 ms to
combine a card, 1.9 KB per card on the wire, and over-requesting absorbs ten stragglers. 34 of 50
costs little more and is defensible. 100 of 150 is affordable in latency thanks to over-requesting
(64 ms at RTT 50) but costs 2 s of setup and 9.6 KB per card, and should be reserved for stakes
that justify it.

**Do this before shipping it:** replace the cut-and-choose proof with Bayer–Groth. It is 67–89% of
the bytes and, absent pipelining, most of the time. Everything else measured here is already fast
enough.
