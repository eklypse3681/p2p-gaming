/**
 * Benchmark for the git-backed persistence layouts. Deterministic content, local bare remote.
 *   node bench.ts [--hands 1000] [--clubs 10] [--tables 3] [--layouts A,B,C] [--refs 100000] [--json out.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GitStore, canonical, git, gitTry } from './src/gitstore.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '1');
const HANDS = Number(args.get('hands') ?? 1000);
const CLUBS = Number(args.get('clubs') ?? 10);
const TABLES = Number(args.get('tables') ?? 3);
const LAYOUTS = (args.get('layouts') ?? 'A,B,C').split(',');
const REFS = Number(args.get('refs') ?? 100_000);
const JSON_OUT = args.get('json');

const root = mkdtempSync(join(tmpdir(), 'gitbench-'));
const results: Record<string, unknown> = {
  hands: HANDS,
  clubs: CLUBS,
  tables: TABLES,
  git: git(['--version'], { cwd: root }),
};

function bare(name: string): string {
  const dir = join(root, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', dir], { cwd: root });
  return dir;
}
function duKb(path: string): number {
  return Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]);
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
function ms(x: number): string {
  return `${x.toFixed(1)} ms`;
}
function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}
let seed = 42;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const CARDS = ['As', 'Kd', 'Qh', 'Jc', 'Ts', '9d', '8h', '7c', '6s', '5d', '4h', '3c', '2s'];
function handRecord(club: string, table: string, hand: number) {
  const seats = ['ada', 'bob', 'cy'];
  const points = [Math.floor(rnd() * 20) - 10, Math.floor(rnd() * 20) - 10];
  const entries = [
    {
      kind: 'result',
      lines: [
        { account: seats[0], amount: points[0] },
        { account: seats[1], amount: -points[0]! + points[1]! },
        { account: seats[2], amount: -points[1]! },
      ],
      ref: { tableId: table, hand },
    },
    {
      kind: 'burn',
      lines: [{ account: seats[0], amount: -1 }],
      ref: { tableId: table, hand, basisPoints: 200 },
    },
  ];
  const actions = [];
  for (let turn = 0; turn < 13; turn++) {
    actions.push({
      type: 'place',
      seat: turn % 3,
      placements: [
        {
          card: CARDS[Math.floor(rnd() * 13)],
          row: ['top', 'middle', 'bottom'][Math.floor(rnd() * 3)],
        },
        {
          card: CARDS[Math.floor(rnd() * 13)],
          row: ['top', 'middle', 'bottom'][Math.floor(rnd() * 3)],
        },
      ],
      discards: [CARDS[Math.floor(rnd() * 13)]],
    });
  }
  return {
    clubId: club,
    tableId: table,
    hand,
    at: 1_789_257_600_000 + hand * 45_000,
    entries,
    actions,
  };
}
function clubState(club: string, hand: number) {
  const balances: Record<string, number> = {};
  for (let m = 0; m < 12; m++) balances[`member${m}`] = 10_000 + ((hand * 7 + m * 13) % 500) - 250;
  return {
    club,
    balances,
    roster: Object.keys(balances),
    rooms: [{ id: 'main', templates: ['p27-3'] }],
    updatedAt: hand,
  };
}
function tableSnapshot(club: string, table: string, hand: number) {
  return {
    club,
    table,
    handNumber: hand,
    seats: ['ada', 'bob', 'cy'],
    scores: [hand % 17, -(hand % 13), (hand % 13) - (hand % 17)],
    phase: 'complete',
    deckCount: 52 - 39,
  };
}

// ---------------------------------------------------------------------------------------------
function benchLayoutA(mode: 'plumbing' | 'fastimport') {
  const remote = bare(`A-${mode}`);
  const store = GitStore.open(join(root, `A-${mode}`), {
    remote,
    fastImport: mode === 'fastimport',
  });
  const handMs: number[] = [];
  const stateMs: number[] = [];
  let rawBytes = 0;
  let mark = 0;
  const t0 = performance.now();
  for (let h = 1; h <= HANDS; h++) {
    const club = `club${h % CLUBS}`;
    const table = `t${Math.floor(h / CLUBS) % TABLES}`;
    const handNo = Math.floor(h / (CLUBS * TABLES)) + 1;
    const rec = handRecord(club, table, handNo);
    rawBytes += Buffer.byteLength(canonical(rec));
    const th = timed(() => store.appendHand(rec));
    mark = th.value.mark ?? 0;
    handMs.push(th.ms);
    const ts = timed(() =>
      store.commitState({
        [`clubs/${club}/state.json`]: clubState(club, handNo),
        [`clubs/${club}/tables/${table}.json`]: tableSnapshot(club, table, handNo),
      }),
    );
    stateMs.push(ts.ms);
  }
  return { remote, store, handMs, stateMs, rawBytes, wallMs: performance.now() - t0, mark };
}

async function runA(mode: 'plumbing' | 'fastimport') {
  const r = benchLayoutA(mode);
  if (mode === 'fastimport') {
    const tf = timed(() => 0);
    const t = performance.now();
    await r.store.flushHands(r.mark);
    void tf;
    (r as unknown as { flushMs: number }).flushMs = performance.now() - t;
  }
  const localBefore = duKb(r.store.dir);
  const push = timed(() => r.store.pushAll());
  const prune = timed(() => r.store.pruneLocal());
  const localAfter = duKb(r.store.dir);
  const remoteBefore = duKb(r.remote);
  const gc = timed(() => git(['gc', '-q', '--aggressive', '--prune=now'], { cwd: r.remote }));
  const remoteAfter = duKb(r.remote);
  const restore = timed(() => GitStore.restore(join(root, `A-${mode}-restored`), r.remote));
  const fetchOne = timed(() => restore.value.fetchHand('club1', 't0', 1));
  const lsRemote = timed(
    () =>
      git(['ls-remote', '--refs', 'origin', 'refs/hands/*'], { cwd: r.store.dir }).split('\n')
        .length,
  );
  const forEach = timed(
    () =>
      git(['for-each-ref', '--format=%(refname)', 'refs/hands/'], { cwd: r.remote }).split('\n')
        .length,
  );
  await r.store.close();
  const out = {
    mode,
    hands: HANDS,
    wallMs: r.wallMs,
    handCommit: { p50: pct(r.handMs, 50), p95: pct(r.handMs, 95) },
    stateCommit: { p50: pct(r.stateMs, 50), p95: pct(r.stateMs, 95) },
    flushMs: (r as unknown as { flushMs?: number }).flushMs ?? 0,
    pushMs: push.ms,
    pushRefs: push.value.hands,
    localKbBefore: localBefore,
    localKbAfterPrune: localAfter,
    pruneMs: prune.ms,
    remoteKbBeforeGc: remoteBefore,
    remoteKbAfterGc: remoteAfter,
    gcMs: gc.ms,
    rawRecordKb: Math.round(r.rawBytes / 1024),
    restoreMs: restore.ms,
    restoredKb: duKb(restore.value.dir),
    fetchOneHandMs: fetchOne.ms,
    lsRemoteMs: lsRemote.ms,
    lsRemoteRefs: lsRemote.value,
    forEachRefMs: forEach.ms,
    forEachRefs: forEach.value,
  };
  console.log(`[A/${mode}]`, JSON.stringify(out));
  return out;
}

// Everything through one long-lived fast-import with a checkpoint per hand: the realistic
// "commit locally per hand" latency (hand record + hot state durable before the next hand).
async function runAFastAll(n: number) {
  const remote = bare('A-fastall');
  const store = GitStore.open(join(root, 'A-fastall'), {
    remote,
    fastImport: true,
    fastImportState: true,
  });
  const perHand: number[] = [];
  const t0 = performance.now();
  for (let h = 1; h <= n; h++) {
    const club = `club${h % CLUBS}`;
    const table = `t${Math.floor(h / CLUBS) % TABLES}`;
    const handNo = Math.floor(h / (CLUBS * TABLES)) + 1;
    const t = performance.now();
    store.appendHand(handRecord(club, table, handNo));
    store.commitState({
      [`clubs/${club}/state.json`]: clubState(club, handNo),
      [`clubs/${club}/tables/${table}.json`]: tableSnapshot(club, table, handNo),
    });
    await store.flush();
    perHand.push(performance.now() - t);
  }
  const wallMs = performance.now() - t0;
  const packs = git(['count-objects', '-v'], { cwd: store.dir });
  const push = timed(() => store.pushAll());
  const repack = timed(() => git(['gc', '-q', '--prune=now'], { cwd: store.dir }));
  const head = store.head();
  const state = store.readState(`clubs/club1/state.json`) as { updatedAt: number } | null;
  await store.close();
  const out = {
    n,
    wallMs,
    perHandDurable: { p50: pct(perHand, 50), p95: pct(perHand, 95) },
    packsBeforeGc: Number(packs.match(/packs: (\d+)/)?.[1] ?? 0),
    pushMs: push.ms,
    pushed: push.value.hands,
    gcMs: repack.ms,
    headOk: !!head,
    stateOk: !!state,
    localKbAfterGc: duKb(store.dir),
    remoteKb: duKb(remote),
  };
  console.log('[A/fastimport-all per-hand checkpoint]', JSON.stringify(out));
  return out;
}

// Incremental pushes per hand (small N) — the "push independently" cost when done eagerly.
async function runIncrementalPush(n: number) {
  const remote = bare('A-incr');
  const store = GitStore.open(join(root, 'A-incr'), { remote });
  const pushMs: number[] = [];
  for (let h = 1; h <= n; h++) {
    store.appendHand(handRecord('club0', 't0', h));
    store.commitState({
      'clubs/club0/state.json': clubState('club0', h),
      'clubs/club0/tables/t0.json': tableSnapshot('club0', 't0', h),
    });
    pushMs.push(timed(() => store.pushAll()).ms);
  }
  const out = { n, pushPerHand: { p50: pct(pushMs, 50), p95: pct(pushMs, 95) } };
  console.log('[A/incremental-push]', JSON.stringify(out));
  return out;
}

// Layout B: one hot branch per club.
async function runB() {
  const remote = bare('B');
  const stores = new Map<string, GitStore>();
  const stateMs: number[] = [];
  const handMs: number[] = [];
  const t0 = performance.now();
  for (let c = 0; c < CLUBS; c++) {
    stores.set(`club${c}`, GitStore.open(join(root, 'B'), { remote, branch: `clubs/club${c}` }));
  }
  for (let h = 1; h <= HANDS; h++) {
    const club = `club${h % CLUBS}`;
    const table = `t${Math.floor(h / CLUBS) % TABLES}`;
    const handNo = Math.floor(h / (CLUBS * TABLES)) + 1;
    const store = stores.get(club)!;
    handMs.push(timed(() => store.appendHand(handRecord(club, table, handNo))).ms);
    stateMs.push(
      timed(() =>
        store.commitState({
          'state.json': clubState(club, handNo),
          [`tables/${table}.json`]: tableSnapshot(club, table, handNo),
        }),
      ).ms,
    );
  }
  const wallMs = performance.now() - t0;
  let pushMs = 0;
  let pushed = 0;
  for (const store of stores.values()) {
    const p = timed(() => store.pushAll());
    pushMs += p.ms;
    pushed += p.value.hands;
  }
  const restore = timed(() =>
    GitStore.restore(join(root, 'B-restored'), remote, { branch: 'clubs/club3' }),
  );
  const out = {
    hands: HANDS,
    wallMs,
    handCommit: { p50: pct(handMs, 50), p95: pct(handMs, 95) },
    stateCommit: { p50: pct(stateMs, 50), p95: pct(stateMs, 95) },
    pushMsAllClubs: pushMs,
    pushedHands: pushed,
    restoreOneClubMs: restore.ms,
    restoredKb: duKb(restore.value.dir),
    remoteKb: duKb(remote),
  };
  console.log('[B]', JSON.stringify(out));
  return out;
}

// Layout C: naive single chain — hot state + hand file in every commit on main; restore = full clone.
async function runC() {
  const remote = bare('C');
  const store = GitStore.open(join(root, 'C'), { remote });
  const commitMs: number[] = [];
  const t0 = performance.now();
  for (let h = 1; h <= HANDS; h++) {
    const club = `club${h % CLUBS}`;
    const table = `t${Math.floor(h / CLUBS) % TABLES}`;
    const handNo = Math.floor(h / (CLUBS * TABLES)) + 1;
    commitMs.push(
      timed(() =>
        store.commitState({
          [`clubs/${club}/state.json`]: clubState(club, handNo),
          [`clubs/${club}/tables/${table}.json`]: tableSnapshot(club, table, handNo),
          [`hands/${club}/${table}/${String(handNo).padStart(6, '0')}.json`]: handRecord(
            club,
            table,
            handNo,
          ),
        }),
      ).ms,
    );
  }
  const wallMs = performance.now() - t0;
  const push = timed(() => store.pushAll());
  const remoteBefore = duKb(remote);
  git(['gc', '-q', '--aggressive', '--prune=now'], { cwd: remote });
  const remoteAfter = duKb(remote);
  const restore = timed(() =>
    git(['clone', '-q', '--single-branch', '--branch', 'main', remote, join(root, 'C-restored')], {
      cwd: root,
    }),
  );
  const restoreShallow = timed(() =>
    git(
      [
        'clone',
        '-q',
        '--depth',
        '1',
        '--single-branch',
        '--branch',
        'main',
        remote,
        join(root, 'C-restored-shallow'),
      ],
      { cwd: root },
    ),
  );
  const out = {
    hands: HANDS,
    wallMs,
    commit: {
      p50: pct(commitMs, 50),
      p95: pct(commitMs, 95),
      first100p50: pct(commitMs.slice(0, 100), 50),
      last100p50: pct(commitMs.slice(-100), 50),
    },
    pushMs: push.ms,
    remoteKbBeforeGc: remoteBefore,
    remoteKbAfterGc: remoteAfter,
    restoreFullMs: restore.ms,
    restoreFullKb: duKb(join(root, 'C-restored')),
    restoreShallowMs: restoreShallow.ms,
    restoreShallowKb: duKb(join(root, 'C-restored-shallow')),
  };
  console.log('[C]', JSON.stringify(out));
  return out;
}

// Ref scale: many refs on a bare remote; does protocol v2 keep single-branch fetches cheap?
async function runRefScale(n: number) {
  const remote = bare('refs');
  const work = GitStore.open(join(root, 'refs-work'), { remote });
  work.commitState({ 'clubs/c/state.json': { hand: 0 } });
  work.pushAll();
  const commit = git(['rev-parse', 'main'], { cwd: remote });
  const lines: string[] = [];
  for (let i = 0; i < n; i++)
    lines.push(`create refs/hands/club${i % 50}/t${i % 3}/${i} ${commit}\n`);
  const create = timed(() =>
    git(['update-ref', '--stdin'], { cwd: remote, input: lines.join('') }),
  );
  git(['pack-refs', '--all'], { cwd: remote });
  const lsAll = timed(() => git(['ls-remote', '--refs', remote], { cwd: root }).split('\n').length);
  const lsPrefix = timed(
    () =>
      git(['ls-remote', '--refs', remote, 'refs/hands/club7/*'], { cwd: root }).split('\n').length,
  );
  const forEach = timed(
    () =>
      git(['for-each-ref', '--format=%(refname)', 'refs/hands/'], { cwd: remote }).split('\n')
        .length,
  );
  const cloneV2 = timed(() =>
    git(
      [
        '-c',
        'protocol.version=2',
        'clone',
        '-q',
        '--single-branch',
        '--branch',
        'main',
        '--no-tags',
        remote,
        join(root, 'refs-clone-v2'),
      ],
      { cwd: root },
    ),
  );
  const cloneV0 = timed(() =>
    git(
      [
        '-c',
        'protocol.version=0',
        'clone',
        '-q',
        '--single-branch',
        '--branch',
        'main',
        '--no-tags',
        remote,
        join(root, 'refs-clone-v0'),
      ],
      { cwd: root },
    ),
  );
  const fetchV2 = timed(() =>
    git(['-c', 'protocol.version=2', 'fetch', '-q', 'origin', 'main'], {
      cwd: join(root, 'refs-clone-v2'),
    }),
  );
  const fetchV0 = timed(() =>
    git(['-c', 'protocol.version=0', 'fetch', '-q', 'origin', 'main'], {
      cwd: join(root, 'refs-clone-v0'),
    }),
  );
  const out = {
    refs: n,
    createMs: create.ms,
    lsRemoteAllMs: lsAll.ms,
    lsRemoteAllCount: lsAll.value,
    lsRemotePrefixMs: lsPrefix.ms,
    lsRemotePrefixCount: lsPrefix.value,
    forEachRefMs: forEach.ms,
    cloneSingleBranchV2Ms: cloneV2.ms,
    cloneSingleBranchV0Ms: cloneV0.ms,
    fetchMainV2Ms: fetchV2.ms,
    fetchMainV0Ms: fetchV0.ms,
    remoteKb: duKb(remote),
    packedRefsKb: duKb(join(remote, 'packed-refs')),
  };
  console.log('[refs]', JSON.stringify(out));
  return out;
}

// Failure modes.
async function runFailures() {
  const remote = bare('fail');
  const store = GitStore.open(join(root, 'fail'), { remote });
  for (let h = 1; h <= 5; h++) {
    store.appendHand(handRecord('c', 't', h));
    store.commitState({ 'clubs/c/state.json': clubState('c', h) });
  }
  const parked = join(root, 'fail-parked.git');
  renameSync(remote, parked);
  const failed = store.pushAll();
  renameSync(parked, remote);
  const recovered = store.pushAll();
  // crash window
  for (let h = 6; h <= 8; h++) store.appendHand(handRecord('c', 't', h));
  store.commitState({ 'clubs/c/state.json': clubState('c', 8) });
  rmSync(store.dir, { recursive: true, force: true });
  const restored = GitStore.restore(join(root, 'fail-restored'), remote);
  const remoteHands = restored.remoteHands('c', 't');
  const state = restored.readState('clubs/c/state.json') as { updatedAt: number };
  // two hosts
  const b = GitStore.restore(join(root, 'fail-B'), remote);
  b.commitState({ 'clubs/c/state.json': clubState('c', 9) });
  b.pushAll();
  restored.commitState({ 'clubs/c/state.json': clubState('c', 10) });
  const clash = restored.pushAll();
  const out = {
    pushWhileRemoteMissing: {
      ok: failed.ok,
      retainedRefs: 5,
      error: (failed.error ?? '').split('\n')[0],
    },
    laterPush: recovered,
    crashBetweenCommitAndPush: {
      remoteHands,
      stateHandOnRemote: state.updatedAt,
      lostHands: [6, 7, 8],
    },
    twoHosts: {
      secondPushOk: clash.ok,
      error: (clash.error ?? '')
        .split('\n')
        .find((l) => /rejected|fetch first|non-fast-forward/.test(l)),
    },
  };
  console.log('[failures]', JSON.stringify(out));
  return out;
}

(async () => {
  try {
    if (LAYOUTS.includes('A')) {
      results['A_plumbing'] = await runA('plumbing');
      results['A_fastimport'] = await runA('fastimport');
      results['A_fastall'] = await runAFastAll(HANDS);
      results['A_incremental'] = await runIncrementalPush(Math.min(200, HANDS));
    }
    if (LAYOUTS.includes('B')) results['B'] = await runB();
    if (LAYOUTS.includes('C')) results['C'] = await runC();
    if (LAYOUTS.includes('R')) results['refs'] = await runRefScale(REFS);
    if (LAYOUTS.includes('F')) results['failures'] = await runFailures();
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
    console.log('done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
export { pct, ms, gitTry };
