# Git-backed persistence for hosted clubs — prototype findings

**Summary.** A hand is ~270 bytes as a self-contained binary record and ~160 bytes once
chunked; git can hold the hot state beautifully (43 ms clone regardless of history) but costs
~1.8 KB and ~65 ms per hand if every hand is a commit, and cannot hold a ref per hand at any
real scale. Recommendation in §7: hot state in the process (git optional), an append log per
table, sealed Parquet chunks in object storage queried with DuckDB.

Throwaway prototype (`packages/gitstore-proto`) measuring how far "commit locally, push
independently, the process is the source of truth" can be taken for club tables, hands and
ledgers, what a hand costs in bytes, and where git stops being the right tool.

Environment: git 2.47.0, Node 25.8, macOS, APFS SSD; a shared machine with other agents running
(absolute timings are conservative; relative comparisons are what matter). All remotes are
local bare repositories (no network), so push/fetch numbers exclude the wire.

## 1. What a hand costs

Records are denormalised and self-contained (§4): club, table, hand number, start and end
state hashes, previous-record hash, timestamps, every card each seat received (6-bit indexes),
every action, the result and rake. Real hands were produced by driving the real engines
(`@bgf/ofc-engine` for 3-seat Pineapple / Pineapple 2-7 / classic, `@bgf/engine` +
`@bgf/server` for backgammon) with the soak bots.

### 1.1 One record, several encodings (bytes, mean of 500 real records)

| Record                                  | verbose JSON | short-key JSON | compact binary | verbose·gzip | short·gzip | binary·gzip | short·zstd | binary·zstd |
| --------------------------------------- | -----------: | -------------: | -------------: | -----------: | ---------: | ----------: | ---------: | ----------: |
| OFC Pineapple 2-7, 3 seats (quick play) |        2,831 |          1,153 |        **273** |          746 |        521 |         296 |        505 |         283 |
| OFC Pineapple 2-7, 3 seats (soak bot)   |        2,883 |          1,164 |            276 |          781 |        540 |         299 |        525 |         286 |
| OFC Pineapple, 3 seats                  |        2,872 |          1,165 |            276 |          763 |        529 |         299 |        512 |         286 |
| OFC classic, 3 seats                    |        3,424 |          1,361 |            291 |          704 |        496 |         312 |        475 |         254 |
| OFC Pineapple 2-7 + 32-byte seed        |        2,905 |          1,227 |            305 |          754 |        531 |         299 |        517 |         289 |
| Backgammon game, 2 seats (~135 actions) |       10,294 |          2,448 |      **1,102** |        1,200 |        840 |         649 |        798 |         605 |

Observations:

- The compact binary form of an OFC hand is ~270 bytes, of which **96 bytes are the three
  32-byte hashes** (start state, end state, previous record). Everything the hand did — 51
  cards dealt, 15 placements, discards, result — fits in ~175 bytes. Compressing a single
  binary record gains nothing (zstd 283 vs 273 raw): there is no redundancy left inside one hand.
- JSON compresses well but never below ~500 bytes on its own; short keys halve verbose JSON.
- A backgammon game is 4× an OFC hand: ~135 actions of dice and moves. Its binary form still
  has structure to compress (605 bytes with zstd).

### 1.2 Records in chunks (bytes per record, real 10k-hand set)

Redundancy appears _between_ hands (same club/table ids, similar deals, same action shapes):

| Chunk                         | NDJSON | NDJSON·gzip | NDJSON·zstd | binary | binary·gzip | binary·zstd |
| ----------------------------- | -----: | ----------: | ----------: | -----: | ----------: | ----------: |
| OFC 2-7, 100 hands/chunk      |  1,152 |         270 |         240 |    233 |         160 |     **153** |
| OFC 2-7, 1,000 hands/chunk    |  1,154 |         263 |         226 |    233 |         157 |     **149** |
| Backgammon, 100 games/chunk   |  2,517 |         528 |         426 |  1,093 |         420 |         370 |
| Backgammon, 1,000 games/chunk |  2,426 |         502 |         350 |  1,052 |         392 |     **297** |

(`binary` in a chunk omits the club/table ids and the previous-hash — the chunk carries the ids
once and adjacency implies the chain.)

### 1.3 Effective bytes per record inside a git pack (10k OFC hands, 3k backgammon games, `gc --aggressive`)

| Storage in git                 | OFC 2-7 (bytes/hand) | Backgammon (bytes/game) |
| ------------------------------ | -------------------: | ----------------------: |
| one JSON blob per record       |                  569 |                     878 |
| JSON, 100 records per blob     |                  285 |                     712 |
| JSON, 1,000 records per blob   |                  278 |                     726 |
| one binary blob per record     |                  338 |                     687 |
| binary, 100 records per blob   |                  161 |                     416 |
| binary, 1,000 records per blob |              **157** |                 **404** |

Git's delta compression recovers most of what zstd finds between hands, but only when the
records share a blob; one object per hand costs 2–3× more, and the per-object overhead (a
commit + tree per hand in layout A, ~150–200 bytes more) comes on top of that. Backgammon
delta-compresses worse than zstd on a chunk (404 vs 297) because git's delta window is
per-object-size ordered and the games differ in length.

## 2. Layouts measured (10 clubs × 3 tables, local bare remote)

Layouts:

- **A. Hot tree + push-only hand refs.** `main` holds only current state. Each hand is an orphan
  commit under `refs/hands/<club>/<table>/<n>`; hand refs are pushed then deleted locally and
  their objects pruned; restore clones `main` only; a hand is fetched on demand by exact ref.
- **B. Branch per club.** As A, but the hot tree lives on `refs/heads/clubs/<club>`; a host
  checks out only its clubs.
- **C. Naive single chain.** Hot state and the hand record in the same commit on `main`;
  restore pulls the whole history.

### 2.1 Latency per hand (ms), 1,000 hands

| Operation                                              |                   A plumbing |                                           A fast-import |      B (branch/club) |                             C (single chain) |
| ------------------------------------------------------ | ---------------------------: | ------------------------------------------------------: | -------------------: | -------------------------------------------: |
| hand commit (orphan commit + ref) p50 / p95            |                  21.8 / 23.5 |                               **0.06 / 0.08** (enqueue) |          21.4 / 23.0 |                        — (folded into state) |
| hot-state commit (2 files) p50 / p95                   |                  43.0 / 46.2 |                                             43.1 / 70.7 |          41.2 / 43.7 |                                  48.7 / 51.0 |
| durable per hand (hand + state + checkpoint) p50 / p95 |                          ~65 | **71.0 / 123.6** (fast-import for both, one checkpoint) |                  ~63 |                                          ~49 |
| push, one batch of 1,000 hands                         |                        1,946 |                                                   1,731 |  3,508 (10 branches) |                                        1,063 |
| push per hand when pushing eagerly (n=200) p50 / p95   |                     97 / 123 |                                                         |                      |                                              |
| restore (clone)                                        |                51 ms, 1.9 MB |                                           47 ms, 1.9 MB | 52 ms / club, 1.5 MB | 93 ms, 5.7 MB (shallow 99 ms, **same size**) |
| fetch one hand on demand                               |                        38 ms |                                                   36 ms |                      |                       n/a (history is local) |
| local repo before → after push+prune                   |                45.7 → 1.0 MB |                                           34.4 → 1.7 MB |                      |                          grows without bound |
| remote after gc                                        | 1.8 MB (1.79 MB raw records) |                                                  1.8 MB |               5.5 MB |                                       1.5 MB |

Reading the numbers:

- **Git plumbing costs ~20 ms per object-creating step** on this machine (each `hash-object`,
  `mktree`, `commit-tree`, `update-ref` is a process spawn). A hand needs four, a two-file
  state commit needs five. That is 60–70 ms of process spawning per hand: fine for a table
  (a hand takes minutes), but it caps a single host at roughly **15 hands/second** across all
  its tables if every hand is committed individually.
- **`git fast-import` removes the spawn cost**: appending a hand is 60 µs, a checkpoint
  (refs written, pack durable) every hand costs ~70 ms p50, or amortises to nothing when
  checkpointing every second instead. This is the write path the real store should use: one
  long-lived fast-import per repository, checkpoint on a timer, push on a timer.
- **Pushes should be batched**: an eager push per hand is ~100 ms (local remote — over the
  internet it is 300 ms+ and rate-limited); one push per few seconds carries hundreds of hands
  for ~2 s. The loss window is the push interval (see failure modes).
- **Restore is small and flat in A/B** (clone of a tree with N clubs, 1 commit), and grows
  with history in C — and a _shallow_ clone of C does not help: the 5.7 MB is the tree of
  hand files, not the history. C is what "just commit everything" gives you.
- **B costs more per push** (one branch per club → 10 ref updates, 3.5 s vs 1.9 s) and buys
  per-club checkout. It matters only when one repository serves clubs hosted on different
  machines; a repository per club-period makes B unnecessary.

### 2.2 Ref scale (bare remote with 100,000 hand refs)

| Measurement                                        |                                   Value |
| -------------------------------------------------- | --------------------------------------: |
| create 100k refs (`update-ref --stdin`, one batch) |                                  18.8 s |
| `packed-refs` size                                 |                  6.6 MB (**~66 B/ref**) |
| `ls-remote` all refs                               | 110 ms, 100,001 refs, ~7 MB transferred |
| `ls-remote` one club prefix                        |    117 ms (server still walks all refs) |
| `for-each-ref` on the remote                       |                                   50 ms |
| clone single branch, protocol **v2**               |                               **26 ms** |
| clone single branch, protocol v0                   |           102 ms (advertises every ref) |
| fetch `main`, v2 / v0                              |                          27 ms / 130 ms |

Protocol v2 does what the design needs: a host that clones `main` never sees the hand refs.
The cost of refs is paid on the server (packed-refs rewrite on every push, 66 B per ref) and by
any v0 client (GitHub serves v2 to git ≥ 2.26). Budget refs per repository (§6).

### 2.3 Failure modes (measured)

| Scenario                             | Result                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| push while the remote is unreachable | push fails, local hand refs and hot commits are **retained**; the next push delivers all of them (`{ ok: true, hands: 5 }`)                                                                                                                       |
| crash after commit, before push      | the remote has hands 1–5 and the state as of hand 5; hands 6–8 are lost **as whole hands** — the hot state and the hand record travel in the same push, so a restored host never sees a state whose hands are missing or a hand without its state |
| two hosts pushing to one remote      | the second host's push of `main` is rejected `non-fast-forward (fetch first)`; the store must refuse to serve after a rejected push rather than fetch-merge (the process is the source of truth — two processes means two truths)                 |
| ref chain integrity                  | hand records verify by `prevHash` alone; a tampered or reordered record fails without any git history (tested)                                                                                                                                    |

### 2.4 Layout A at 10,000 hands

| Measurement (10,000 hands, 30 tables)  |                                                                         A plumbing |                A fast-import (hands) | A fast-import (hands + state, checkpoint per hand) |
| -------------------------------------- | ---------------------------------------------------------------------------------: | -----------------------------------: | -------------------------------------------------: |
| wall time for 10,000 hands             |                                                                              612 s |                                379 s |                                        **5,912 s** |
| hand commit p50 / p95                  |                                                                     20.3 / 22.4 ms |             0.06 / 0.07 ms (enqueue) |                                                  — |
| state commit p50 / p95                 |                                                                     40.1 / 44.9 ms |                       37.5 / 41.2 ms |                                                  — |
| durable per hand p50 / p95             |                                                                             ~60 ms | — (one checkpoint at the end: 1.5 s) |                                 **587 / 1,135 ms** |
| push of 10,000 hand refs in one batch  |                                                                             72.2 s |                               63.4 s |                                             69.5 s |
| local repo before → after push + prune |                                                        458 → 9.4 MB (prune 16.7 s) |                 345 → 17 MB (13.5 s) |                              52 MB after gc (17 s) |
| remote after gc                        | 17.7 MB (18.0 MB raw records → **~1.8 KB/hand in git incl. commit+tree per hand**) |                              17.6 MB |                      55.5 MB (no gc on the remote) |
| restore (clone `main`)                 |                                                            **43 ms**, 16.6 MB tree |                                44 ms |                                                  — |
| fetch one hand                         |                                                                              33 ms |                                34 ms |                                                  — |
| `ls-remote` 10k refs                   |                                                                              22 ms |                                22 ms |                                                  — |

Two things only appear at 10k:

- **Pushing 10,000 refs in one batch is superlinear**: 1.9 s for 1,000 refs became 72 s for
  10,000 (the receiving side rewrites `packed-refs` and updates reflogs per ref). Pushes must
  be small and frequent (hundreds of refs), or — the real fix — hands must not be one ref each
  (chunk refs, §7).
- **`git fast-import`'s `checkpoint` rewrites every ref the session has created**, so a
  checkpoint per hand costs O(refs in the session): 71 ms at 1k hands, 587 ms at 10k. Either
  restart the fast-import process after every push+prune (the refs it holds are then gone),
  or use fast-import for objects only and write refs with one `update-ref --stdin` batch.
- Restore stays flat (43 ms, tree only) — which is the point of the layout — while the
  remote's per-hand cost with a commit + tree + blob per hand is ~1.8 KB/hand _before_
  `gc --aggressive` deltas (§1.3 measured 340 B/hand for the blobs alone, packed).

## 3. History tier: append logs, Parquet, DuckDB

Measured with the same real records (3,000 OFC 2-7 hands, 800 backgammon games), DuckDB
writing Parquet with zstd.

### 3.1 The hot append path (per-table log, 2,000 records)

| Log format             | bytes/hand | append + fsync p50 / p95 | append, no fsync p50 / p95 |
| ---------------------- | ---------: | -----------------------: | -------------------------: |
| NDJSON                 |      1,154 |           4.00 / 4.81 ms |           0.041 / 0.090 ms |
| NDJSON + zstd frame    |        529 |           3.93 / 4.62 ms |           0.039 / 0.086 ms |
| binary length-prefixed |    **233** |           3.97 / 4.37 ms |       **0.033 / 0.078 ms** |

An append is 33 µs; the 4 ms is the `fsync`, and it is the same 4 ms whatever the format, so
the encoding is free and durability is the only cost. Fsync per hand is affordable (a hand
lasts minutes) but pointless if the seal interval is the real loss window: fsync on the seal
or push tick instead and an append costs nothing.

### 3.2 Sealed Parquet (zstd)

| Table                            |  rows |   bytes | bytes/row |
| -------------------------------- | ----: | ------: | --------: |
| OFC hands, full record           | 3,000 | 795,233 |   **265** |
| OFC hands, hashes dropped        | 3,000 | 502,445 |   **167** |
| Backgammon games, full           |   800 | 394,786 |       493 |
| Backgammon games, hashes dropped |   800 | 316,118 |       395 |

Row-group size (10k vs 100k) made no difference at this scale. Where the bytes go, per row:

| Column                                                          | compressed | raw |
| --------------------------------------------------------------- | ---------: | --: |
| `payload` (the compact binary record)                           |    **160** | 235 |
| `ph`, `s0`, `s1` (three 32-byte hashes)                         |     **97** | 108 |
| `hand_no`, `started_at`, `ended_at`                             |          4 |  20 |
| club, table, game, day, seats, rake, transfers, members, points |      **0** | ~11 |

Dictionary and run-length encoding reduce every low-cardinality column to **zero bytes per
row** — club, table, game, day, rake and the transfer lists cost nothing once sorted. What
remains is the payload and the hashes, and the hashes are 37% of the row. Dropping `ph` and
`s0` inside a sealed file (adjacency implies both, §4) takes an OFC hand to **167 bytes**.

### 3.3 Sealing and querying

| Operation                                                        |    Result |
| ---------------------------------------------------------------- | --------: |
| seal 1,000 buffered hands → one Parquet file                     |      5 ms |
| seal 10,000 buffered hands → one Parquet file                    |     12 ms |
| lake written as 140 small files (`club=/date=` over-partitioned) | 511 B/row |
| lake written as whole-table files                                | 265 B/row |

| DuckDB query over the partitioned lake (`read_parquet(…, hive_partitioning=true)`) |  median |
| ---------------------------------------------------------------------------------- | ------: |
| every hand one member played                                                       | 10.3 ms |
| rake by club by day                                                                |  9.9 ms |
| one table, last 50 hands                                                           |  8.1 ms |
| one day, all clubs, totals                                                         |  6.7 ms |

Two findings matter more than the timings:

- **Small files double the cost.** The same rows cost 265 B/row in whole-table files and
  511 B/row spread over 140 partition files: Parquet's footer, dictionaries and row-group
  metadata are per file. Partition to keep files large (≥ 10k rows; a busy table makes ~300
  hands/day, so `club=<id>/month=<yyyy-mm>/` for most clubs, `date=` only for busy ones).
- **Arrow IPC was not available** through this DuckDB build's `COPY … TO` (`Catalog Error:
Copy Function with name arrows does not exist`), so the hot log stays the binary
  length-prefixed file above; nothing is lost — it is smaller than Arrow would be and
  DuckDB reads it through a tiny loader at seal time.

## 4. The record format (denormalised)

A **table ref points at the table's current state**: the hot tree holds `clubs/<club>/state.json`
(balances, roster, rooms), `clubs/<club>/tables/<t>.json` (the live snapshot) and `chains.json`
(per-table chain head: last hand number + record hash). A **hand is a transition** from one state
to the next and is recorded on its own:

```
OfcHandRecord {
  v: 1, g: 'ofc', c: clubId, t: tableId, n: handNo,
  s0: sha256(state before), s1: sha256(state after), ph: previous record hash | 'genesis',
  at: [startMs, endMs], seed?: hex (seeded mode only),
  btn, deals: number[seat][]          // every card each seat received, 6-bit card indexes, deal order
  acts: [{ s, p: [[card,row]...], d: [card...] }...]   // placements and discards, in order
  res: { pts[], roy[], foul (bitmask), fl[] (Fantasyland cards next), rake, tr: [[from,to,pts]...] }
}
BgGameRecord { …, acts: [[code, ...payload]...] }   // 0 opening, 1 roll, 2 play(from,to,die…), 3 double, 4 take, 5 drop
```

Nothing outside the record is needed to replay or audit it: the deals reproduce the deck, the
actions reproduce the play, `s0`/`s1` tie it to states, `ph` chains it to its predecessor. The
state hashed must be the _denormalised current state_ (balances, snapshot, chain heads), never
the engine's accumulated history — hashing history made the first prototype run quadratic and
was the single biggest lesson of the exercise: **current state has to stay small by construction**.

Hash budget: three 32-byte hashes are ~35% of an OFC record. Inside a chunk, `ph` is implied by
adjacency and can be dropped (done in the chunk encoding); `s0` is the previous record's `s1` and
can also be dropped inside a chunk; truncating the remaining `s1` to 16 bytes is defensible when
the record hash chain (not the state hash) is the integrity mechanism.

## 5. GitHub as the remote — documented limits

From GitHub's documentation (not measured here):

- Repository size: GitHub _recommends_ keeping repositories under **1 GB** and _strongly_
  recommends under **5 GB**; individual files over 50 MB warn and over **100 MB** are blocked
  without LFS. [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- A single push is limited to **2 GB**. [Troubleshooting the 2 GB push limit](https://docs.github.com/en/get-started/using-git/troubleshooting-the-2-gb-push-limit)
- There is no published hard limit on the _number of refs_, but every ref is advertised to every
  client that does not use protocol v2 ref filtering, and GitHub's own guidance on repository
  health warns that very large numbers of refs slow operations for everyone. Treat refs as a
  budgeted resource (measured below: `ls-remote` of 100k refs works but is a multi-second,
  multi-megabyte operation).
- Protocol v2 (ref-prefix filtered `ls-refs`) is the default in git ≥ 2.26 and is served by
  GitHub, which is what makes "push-only refs" viable: a `clone --single-branch` asks only for
  `refs/heads/main` and never sees the hand refs. [Introducing Git protocol version 2](https://opensource.googleblog.com/2018/05/introducing-git-protocol-version-2.html)
- Authentication for an unattended host: a deploy key (SSH, per repository, write-enabled) or a
  fine-grained PAT scoped to the data repository. [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
- Git operations are not covered by the REST rate limits, but abusive push rates trip secondary
  limits; one push per hand per table would be a poor fit for a busy club (batch pushes per
  N seconds instead — measured cost of incremental pushes is in §2).

## 6. Scale model: 1e6, 1e8, 1e9 hands

Per-hand costs from §1 (OFC 2-7; backgammon games are ~2.5×): git pack with one blob per hand
≈ **340 B**; git pack with 1,000-hand chunks ≈ **160 B**; zstd binary chunks ≈ **150 B**; Parquet
(zstd, see §3) ≈ **265 B** full / **167 B** without hashes.

| Hands         | 1 blob/hand in git | 1,000-hand chunks in git | zstd chunks in object storage |      Parquet in object storage |
| ------------- | -----------------: | -----------------------: | ----------------------------: | -----------------------------: |
| 1,000,000     |             340 MB |                   160 MB |                        150 MB | 265 MB (167 MB without hashes) |
| 100,000,000   |              34 GB |                    16 GB |                         15 GB |                  27 GB (17 GB) |
| 1,000,000,000 |             340 GB |                   160 GB |                        150 GB |                265 GB (167 GB) |

Against GitHub's guidance (≤ 1 GB recommended, ≤ 5 GB strongly recommended per repository):

- 1e6 hands fits in one repository under any layout.
- 1e8 hands needs ≥ 4 repositories even with chunking (≥ 7 with one blob per hand), i.e. a shard
  key (club, or club × year).
- 1e9 hands means 32+ repositories at the 5 GB line and 160+ at the 1 GB line. Possible, silly.

**Refs.** One ref per hand is impossible at scale: `packed-refs` costs ~60–90 bytes per ref
(measured 68 B at 100k refs), so 1e9 hands is a **60–90 GB `packed-refs`
file**; every push, `ls-remote` and gc touches it, and GitHub advertises it to any v0 client.
Alternatives, all with a busy OFC table at ~12–15 hands/hour:

| Ref policy                               | refs at 1e6 hands |  at 1e8 |    at 1e9 | verdict                                             |
| ---------------------------------------- | ----------------: | ------: | --------: | --------------------------------------------------- |
| one ref per hand                         |         1,000,000 |     1e8 |       1e9 | impossible beyond ~1e5 per repo                     |
| one ref per table-hour chunk (~13 hands) |            77,000 |   7.7e6 |     7.7e7 | too many at 1e8+                                    |
| one ref per table-day chunk (~300 hands) |             3,300 | 330,000 |     3.3e6 | workable per repo only up to ~1e7 hands             |
| one ref per fixed 1,000-hand chunk       |             1,000 | 100,000 | 1,000,000 | fine **per shard** of ≤ 1e7 hands (≤ 10k refs each) |

So the ref namespace, not the bytes, is what forces sharding first: keep **≤ ~10k chunk refs per
repository** (measured cost of 100k refs in §2 — usable but heavy), which with 1,000-hand chunks
means **≤ 1e7 hands per repository** and therefore a repository per club-period (club × quarter
for a busy club, club × year for a quiet one).

**Archive tier.** Past a repository's budget, sealed chunks move to object storage and git keeps
only a manifest (chunk id → content hash, byte range, object key). Cloudflare R2 storage is
$0.015/GB-month with free egress; S3 standard ≈ $0.023/GB-month plus egress. Cost per **billion
hands** at ~150–263 bytes/hand: **R2 ≈ $2.3–4.0 per month**, S3 ≈ $3.5–6.0 per
month, plus one-time write operations (1e6 chunk uploads × $4.50/million ≈ $4.50 on R2). GitHub
costs $0 in dollars and 32–160 repositories in operations.

## 7. Recommendation

**Three tiers, and git is not the one on the game path.**

| Tier           | What                                                                 | Where                                                                        | Cost (measured)                                 |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| Hot state      | balances, roster, rooms, live table snapshots, per-table chain heads | process memory, snapshot file per club, optionally one git commit per change | 40 ms per state commit if git is used; 0 if not |
| Open log       | the current, unsealed hands of each table, appended as they finish   | `logs/<club>/<table>.bin`, binary length-prefixed                            | **33 µs** append, 4 ms if fsynced               |
| Sealed history | immutable chunks of finished hands                                   | Parquet (zstd) in object storage, `club=<id>/month=<yyyy-mm>/`               | **167–265 B/hand**, 12 ms to seal 10,000        |

Queries (statements, rake reports, a member's history) run in DuckDB over the sealed Parquet
plus the open log: 7–10 ms for every shape measured. Nothing reads history to play a hand.

**The record is the unit of truth, not the commit.** Each hand is denormalised and
self-contained (§4): start and end state hashes, every card dealt, every action, the result,
and the previous record's hash. It verifies with no git history and no database — which is why
the storage tier underneath it is free to be a file, a blob or a row.

**Do this**

1. Append the finished hand to the table's open log and update hot state in the same step;
   fsync on the seal or push tick, not per hand. The loss window is that tick, and a hand and
   its state always travel together, so a restored host never sees a state whose hands are
   missing (measured, §2.3).
2. Seal on a boundary (10,000 hands or a day, whichever first) into one Parquet file and upload
   it; drop `ph` and `s0` inside the file (adjacency implies them) for 167 B/hand. Keep files
   large: over-partitioning doubled the per-row cost to 511 B.
3. Keep a manifest of sealed chunks (chunk id → content hash → object key) in the hot state, so
   restore is snapshot + manifest + replay of the open log, and any auditor can fetch a chunk by
   hash.
4. If git is used at all, use it for the hot state and the manifest — a repository that stays a
   few megabytes and clones in 43 ms regardless of how many hands have been played (§2.4). One
   push per few seconds, protocol v2, deploy key, and refuse to serve after a rejected push (two
   processes means two truths).
5. Shard by club when a club outgrows a repository or a lake prefix: one process per club is
   already the unit, so the storage key is already the shard key.

**Do not do this**

- **A commit per hand.** 60–70 ms of process spawning per hand caps a host at ~15 hands/second,
  and costs ~1.8 KB/hand on the remote (§2.4) — 5× the blob alone, for history nobody reads.
- **A ref per hand.** `packed-refs` costs 68 B/ref: 1e9 hands is a 60–90 GB refs file, rewritten
  on every push. Pushing 10,000 refs in one batch already takes 72 s (§2.4). Chunk refs, or none.
- **`fast-import` with a checkpoint per hand.** The checkpoint rewrites every ref the session
  created: 71 ms at 1k hands, 587 ms at 10k. Checkpoint on a timer, or restart the session after
  each push and prune.
- **Hashing the engine's accumulated history.** The first prototype did and went quadratic. The
  hashed state must be the denormalised current state, small by construction.
- **Parquet partitioned finer than the data warrants** (§3.3).

**Where the crossover is.** Git as the sole store is fine up to ~1e7 hands per repository
(10k chunk refs, a few gigabytes) — years of a busy club. Past that, and for anything
approaching a billion hands, the sealed tier belongs in object storage: **$2.30–4.00 per month
per billion hands on R2** with free egress, against 32–160 GitHub repositories holding the
same thing. Git keeps the part it is good at: a small, auditable, clone-in-milliseconds record
of what the state is now and which chunks exist.

**Against the four priorities.** Fast: 33 µs on the game path, no network, no database. Stable:
immutable sealed files, a loss window of one tick, integrity that does not depend on the store.
Inexpensive: ephemeral disk, single-digit dollars per billion hands, no managed database.
Simple to run unattended: one process, one data directory, one bucket, and a status line that
says what is unsealed and unpushed.
