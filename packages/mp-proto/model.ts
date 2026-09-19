/**
 * End-to-end latency model.
 *   node scripts/run.mjs model.ts [--trials 20000] [--sigma 0.6] [--json out.json]
 *
 * Composes the compute costs measured by `bench.ts` with a network model, and shows what each of
 * three optimisations removes from the critical path:
 *
 *   1. **Pipelined shuffle** — the committee for hand N+1 is known in advance, so its deck can be
 *      shuffled while hand N is still being played.
 *   2. **Precomputed partials** — after the shuffle a member can compute its partial decryption
 *      for every deck position and hold it, turning a deal into a pure network round trip.
 *   3. **Over-request** — ask all `n` members and use the first `k` replies instead of asking
 *      exactly `k` and waiting for the slowest of them.
 *
 * Member latencies are drawn from a lognormal with median = RTT, which is the usual shape for
 * internet round trips: most responses near the median, a tail that misbehaves. The whole point
 * of over-requesting is what that tail does to an order statistic.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync, readFileSync } from 'node:fs';

const args = new Map<string, string>();
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.replace(/^--/, ''), process.argv[i + 1] ?? '1');
}
const TRIALS = Number(args.get('trials') ?? 20_000);
const SIGMA = Number(args.get('sigma') ?? 0.6);
const JSON_OUT = args.get('json');
const BENCH = args.get('bench');

/**
 * Compute costs in milliseconds, measured by `bench.ts` on 2026-09-13 (Node 25, ristretto255 via
 * @noble/curves, pure JS, shared laptop). Override with `--bench <bench.json>`.
 */
const COST = {
  shuffleProve: { 8: 174, 20: 381, 30: 565, 40: 747 },
  shuffleVerify: { 8: 157, 20: 354, 30: 532, 40: 724 },
  /** One member, one card: partial decryption plus its proof. */
  partialWithProof: 1.65,
  /** One member, one card: the partial alone, which is the precomputable part. */
  partialValueOnly: 0.6,
  /** Combining k partials optimistically (MSM, decode, no proof checks on the happy path). */
  combineOptimistic: { 6: 2.5, 20: 5.5, 34: 6.9, 100: 18.3 } as Record<number, number>,
  /** Verifying every proof, the pessimistic path, warm points. */
  verifyAll: { 6: 6.7, 20: 22.2, 34: 37.7, 100: 110.9 } as Record<number, number>,
  /** Precomputing all 52 positions once, values only. */
  precomputeDeck: 31,
};

if (BENCH) {
  try {
    const j = JSON.parse(readFileSync(BENCH, 'utf8')) as {
      reveal?: { rows?: Record<string, Record<string, number>> };
    };
    for (const [key, row] of Object.entries(j.reveal?.rows ?? {})) {
      const k = Number(key.replace('k=', ''));
      const r = row as Record<string, number>;
      COST.combineOptimistic[k] = r['combiner: optimistic total (ms)']!;
      COST.verifyAll[k] = r['combiner: verify k proofs, warm (ms)']!;
    }
    console.log(`loaded measured costs from ${BENCH}`);
  } catch (e) {
    console.log(`could not load ${BENCH}: ${(e as Error).message}; using built-in measurements`);
  }
}

// ---------------------------------------------------------------------------------------------
// Network: the k-th fastest of n responders.
// ---------------------------------------------------------------------------------------------
let seed = 0x2f6e2b1;
function random(): number {
  // xorshift32, so the model is reproducible.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}
function gaussian(): number {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Mean and p95 of the k-th smallest of n lognormal round trips with median `rtt`.
 * `n === k` is "ask exactly k and wait for the slowest of them".
 */
function orderStatistic(n: number, k: number, rtt: number): { mean: number; p95: number } {
  const samples: number[] = [];
  const draw = new Array<number>(n);
  for (let t = 0; t < TRIALS; t++) {
    for (let i = 0; i < n; i++) draw[i] = rtt * Math.exp(SIGMA * gaussian());
    draw.sort((a, b) => a - b);
    samples.push(draw[k - 1]!);
  }
  samples.sort((a, b) => a - b);
  return {
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    p95: round(samples[Math.floor(0.95 * samples.length)]!),
  };
}

function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------------------------
const RTTS = [20, 50, 150, 300];
const results: Record<string, unknown> = { sigma: SIGMA, trials: TRIALS, cost: COST };

interface Phase {
  name: string;
  /** Round trips on the critical path. */
  trips: number;
  /** Compute on the critical path, milliseconds. */
  compute: number;
  note?: string;
}

function timeline(phases: Phase[], n: number, k: number, rtt: number, overRequest: boolean) {
  const trip = overRequest ? orderStatistic(n, k, rtt) : orderStatistic(k, k, rtt);
  let total = 0;
  const rows = phases.map((p) => {
    const network = p.trips * trip.mean;
    const ms = network + p.compute;
    total += ms;
    return {
      phase: p.name,
      'network (ms)': round(network),
      'compute (ms)': round(p.compute, 1),
      'total (ms)': round(ms),
    };
  });
  return { rows, total: round(total), trip };
}

// -------------------------------------------------------------------------------------------
// 1. What over-requesting is worth.
// -------------------------------------------------------------------------------------------
function benchOverRequest() {
  const rows: Record<string, unknown> = {};
  for (const [n, k] of [
    [9, 6],
    [30, 20],
    [50, 34],
    [150, 100],
  ] as const) {
    for (const rtt of [50, 150]) {
      const exact = orderStatistic(k, k, rtt);
      const over = orderStatistic(n, k, rtt);
      rows[`k=${k} of n=${n}, RTT ${rtt}ms`] = {
        'ask k, wait for all k (ms)': exact.mean,
        'ask n, take first k (ms)': over.mean,
        'saved (ms)': round(exact.mean - over.mean),
        ratio: round(exact.mean / over.mean, 2),
        'p95 exact': exact.p95,
        'p95 over-request': over.p95,
      };
    }
  }
  console.log(`\nOver-requesting, lognormal sigma=${SIGMA} (median = RTT)`);
  console.table(rows);
  results.overRequest = rows;
}

// -------------------------------------------------------------------------------------------
// 2. Nine-handed hold'em.
// -------------------------------------------------------------------------------------------
function holdem(
  n: number,
  k: number,
  rtt: number,
  opts: {
    pipelined: boolean;
    precomputed: boolean;
    overRequest: boolean;
    shufflers: number;
    t: 8 | 20 | 30 | 40;
  },
) {
  const { pipelined, precomputed, overRequest, shufflers, t } = opts;
  const shuffleCompute = pipelined ? 0 : shufflers * (COST.shuffleProve[t] + COST.shuffleVerify[t]);
  const shuffleTrips = pipelined ? 0 : shufflers;
  const memberDeal = precomputed ? 0 : 18 * COST.partialWithProof;
  const memberStreet = precomputed ? 0 : COST.partialWithProof;

  const phases: Phase[] = [
    {
      name: 'shuffle (3 shufflers, chained)',
      trips: shuffleTrips,
      compute: shuffleCompute,
      note: pipelined ? 'off critical path' : undefined,
    },
    {
      name: 'deal 18 hole cards (batched)',
      trips: 1,
      compute: memberDeal + (18 * COST.combineOptimistic[k]!) / 9,
    },
    { name: 'flop', trips: 1, compute: memberStreet * 3 + COST.combineOptimistic[k]! * 3 },
    { name: 'turn', trips: 1, compute: memberStreet + COST.combineOptimistic[k]! },
    { name: 'river', trips: 1, compute: memberStreet + COST.combineOptimistic[k]! },
  ];
  return timeline(phases, n, k, rtt, overRequest);
}

function ofc(
  n: number,
  k: number,
  rtt: number,
  opts: {
    pipelined: boolean;
    precomputed: boolean;
    overRequest: boolean;
    shufflers: number;
    t: 8 | 20 | 30 | 40;
  },
) {
  const { pipelined, precomputed, overRequest, shufflers, t } = opts;
  const shuffleCompute = pipelined ? 0 : shufflers * (COST.shuffleProve[t] + COST.shuffleVerify[t]);
  const shuffleTrips = pipelined ? 0 : shufflers;
  const perCardMember = precomputed ? 0 : COST.partialWithProof;

  const phases: Phase[] = [
    { name: 'shuffle (3 shufflers, chained)', trips: shuffleTrips, compute: shuffleCompute },
    {
      name: 'opening 5 per seat (15 cards)',
      trips: 1,
      compute: perCardMember * 15 + COST.combineOptimistic[k]! * 5,
    },
    ...[1, 2, 3, 4].map((r) => ({
      name: `turn ${r}: 3 per seat (9 cards)`,
      trips: 1,
      compute: perCardMember * 9 + COST.combineOptimistic[k]! * 3,
    })),
  ];
  return timeline(phases, n, k, rtt, overRequest);
}

function showTimeline(title: string, result: ReturnType<typeof timeline>) {
  console.log(`\n${title} — total ${result.total} ms`);
  console.table(result.rows);
}

// -------------------------------------------------------------------------------------------
// 3. The optimisation ladder.
// -------------------------------------------------------------------------------------------
function ladder() {
  const n = 30;
  const k = 20;
  const shufflers = 3;
  const t = 20 as const;
  const rows: Record<string, unknown> = {};

  for (const rtt of RTTS) {
    const naive = holdem(n, k, rtt, {
      pipelined: false,
      precomputed: false,
      overRequest: false,
      shufflers,
      t,
    });
    const over = holdem(n, k, rtt, {
      pipelined: false,
      precomputed: false,
      overRequest: true,
      shufflers,
      t,
    });
    const pre = holdem(n, k, rtt, {
      pipelined: false,
      precomputed: true,
      overRequest: true,
      shufflers,
      t,
    });
    const all = holdem(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers,
      t,
    });
    rows[`RTT ${rtt} ms`] = {
      'naive (ms)': naive.total,
      '+ over-request (ms)': over.total,
      '+ precomputed partials (ms)': pre.total,
      '+ pipelined shuffle (ms)': all.total,
      'plaintext dealer (ms)': round(4 * orderStatistic(1, 1, rtt).mean),
      'added vs plaintext (ms)': round(all.total - 4 * orderStatistic(1, 1, rtt).mean),
    };
  }
  console.log(
    `\n9-handed hold'em, committee 20 of 30, 3 shufflers, t=20 — the optimisation ladder`,
  );
  console.table(rows);
  results.ladder = rows;

  const ofcRows: Record<string, unknown> = {};
  for (const rtt of RTTS) {
    const naive = ofc(n, k, rtt, {
      pipelined: false,
      precomputed: false,
      overRequest: false,
      shufflers,
      t,
    });
    const all = ofc(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers,
      t,
    });
    ofcRows[`RTT ${rtt} ms`] = {
      'naive (ms)': naive.total,
      'all three optimisations (ms)': all.total,
      'plaintext dealer (ms)': round(5 * orderStatistic(1, 1, rtt).mean),
      'added vs plaintext (ms)': round(all.total - 5 * orderStatistic(1, 1, rtt).mean),
    };
  }
  console.log(`\nOFC pineapple, 3 seats, committee 20 of 30 — the optimisation ladder`);
  console.table(ofcRows);
  results.ladderOfc = ofcRows;
}

// -------------------------------------------------------------------------------------------
// 4. Detailed timelines at a realistic RTT.
// -------------------------------------------------------------------------------------------
function detail() {
  const n = 30;
  const k = 20;
  const rtt = 50;
  showTimeline(
    `9-handed hold'em, RTT ${rtt} ms, naive`,
    holdem(n, k, rtt, {
      pipelined: false,
      precomputed: false,
      overRequest: false,
      shufflers: 3,
      t: 20,
    }),
  );
  showTimeline(
    `9-handed hold'em, RTT ${rtt} ms, all three optimisations`,
    holdem(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers: 3,
      t: 20,
    }),
  );
  showTimeline(
    `OFC pineapple 3 seats, RTT ${rtt} ms, all three optimisations`,
    ofc(n, k, rtt, { pipelined: true, precomputed: true, overRequest: true, shufflers: 3, t: 20 }),
  );
  results.detail = {
    holdemNaive: holdem(n, k, rtt, {
      pipelined: false,
      precomputed: false,
      overRequest: false,
      shufflers: 3,
      t: 20,
    }),
    holdemTuned: holdem(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers: 3,
      t: 20,
    }),
    ofcTuned: ofc(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers: 3,
      t: 20,
    }),
  };
}

// -------------------------------------------------------------------------------------------
// 5. Connection setup: warm pool against cold WebRTC.
// -------------------------------------------------------------------------------------------
function connections() {
  const rows: Record<string, unknown> = {};
  const n = 30;
  const k = 20;
  for (const rtt of [50, 150]) {
    const tuned = holdem(n, k, rtt, {
      pipelined: true,
      precomputed: true,
      overRequest: true,
      shufflers: 3,
      t: 20,
    }).total;
    for (const [label, setup] of [
      ['warm pool (connections already open)', 0],
      ['cold WebRTC setup, 1 s', 1000],
      ['cold WebRTC setup, 3 s', 3000],
    ] as const) {
      rows[`RTT ${rtt} ms, ${label}`] = {
        'hand (ms)': tuned,
        'setup (ms)': setup,
        'first hand (ms)': round(tuned + setup),
        'steady state (ms)': tuned,
      };
    }
  }
  console.log('\nConnection setup: a committee that changes per hand pays this before every hand');
  console.table(rows);
  results.connections = rows;
}

const t0 = performance.now();
benchOverRequest();
ladder();
detail();
connections();
console.log(`\nmodel ran in ${round((performance.now() - t0) / 1000, 1)} s`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}
