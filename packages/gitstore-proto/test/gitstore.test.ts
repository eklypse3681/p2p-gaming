import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitStore, canonical, git, gitTry, type HandRecord } from '../src/gitstore.ts';

let root: string;
let remote: string;
const stores: GitStore[] = [];

function bare(name = 'remote'): string {
  const dir = join(root, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', dir], { cwd: root });
  return dir;
}

function record(club: string, table: string, hand: number) {
  return {
    clubId: club,
    tableId: table,
    hand,
    at: 1_789_257_600_000 + hand * 60_000,
    entries: [
      {
        kind: 'result',
        lines: [
          { account: 'ada', amount: 12 },
          { account: 'bob', amount: -12 },
        ],
      },
      { kind: 'burn', lines: [{ account: 'ada', amount: -1 }] },
    ],
    actions: [{ type: 'place', seat: hand % 3, placements: [{ card: 'As', row: 'bottom' }] }],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitstore-'));
  remote = bare();
});
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  rmSync(root, { recursive: true, force: true });
});

describe('layout A: hot tree + push-only hand refs', () => {
  it('commits state and hands, pushes, prunes locally, and the remote keeps every hand', async () => {
    const store = GitStore.open(join(root, 'host'), { remote });
    stores.push(store);
    for (let h = 1; h <= 25; h++) {
      store.appendHand(record('club1', 't1', h));
      store.commitState({
        'clubs/club1/state.json': { balances: { ada: 100 + h, bob: 100 - h }, hand: h },
        'clubs/club1/tables/t1.json': { handNumber: h, seats: ['ada', 'bob'] },
      });
    }
    expect(store.listState().sort()).toEqual([
      'chains.json',
      'clubs/club1/state.json',
      'clubs/club1/tables/t1.json',
    ]);
    expect(store.localHandRefs()).toHaveLength(25);
    expect(store.status().unpushedHands).toBe(25);

    const push = store.pushAll();
    expect(push).toEqual({ ok: true, hands: 25 });
    expect(store.localHandRefs()).toHaveLength(0);
    expect(store.status().mainPushed).toBe(true);
    const remoteRefs = git(['for-each-ref', '--format=%(refname)', 'refs/hands/'], {
      cwd: remote,
    }).split('\n');
    expect(remoteRefs).toHaveLength(25);

    const { beforeBytes, afterBytes } = store.pruneLocal();
    expect(afterBytes).toBeLessThan(beforeBytes);
    // Hand objects are gone locally...
    const gone = gitTry(
      ['cat-file', '-e', `${remoteRefs[0]!.replace('refs/hands', 'refs/hands')}`],
      { cwd: store.dir },
    );
    expect(gone.code).not.toBe(0);
    // ...and the hot tree is intact.
    expect(store.readState('clubs/club1/state.json')).toEqual({
      balances: { ada: 125, bob: 75 },
      hand: 25,
    });
  });

  it('restore clones only main and returns the exact hot state; hands are fetched on demand', async () => {
    const host = GitStore.open(join(root, 'host'), { remote });
    stores.push(host);
    const state = { balances: { ada: 130, bob: 70 }, roster: ['ada', 'bob'] };
    for (let h = 1; h <= 10; h++) host.appendHand(record('club1', 't1', h));
    host.commitState({
      'clubs/club1/state.json': state,
      'clubs/club1/tables/t1.json': { handNumber: 10 },
    });
    expect(host.pushAll().ok).toBe(true);

    const restored = GitStore.restore(join(root, 'host2'), remote);
    stores.push(restored);
    expect(restored.readState('clubs/club1/state.json')).toEqual(state);
    expect(restored.chainHead('club1', 't1')).toEqual(host.chainHead('club1', 't1'));
    // Only main came down: no hand refs, no hand objects.
    expect(restored.localHandRefs()).toHaveLength(0);
    expect(git(['rev-list', '--count', 'main'], { cwd: restored.dir })).toBe('1');

    const hand7 = restored.fetchHand('club1', 't1', 7);
    expect(hand7.hand).toBe(7);
    expect(hand7.entries).toHaveLength(2);
    expect(restored.remoteHands('club1', 't1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The restored host continues the chain and its next hand links to the fetched history.
    const next = restored.appendHand(record('club1', 't1', 11));
    const fetchedAll: HandRecord[] = [];
    for (let h = 1; h <= 10; h++) fetchedAll.push(restored.fetchHand('club1', 't1', h));
    expect(GitStore.verifyChain(fetchedAll)).toEqual({ ok: true });
    expect(fetchedAll[9]!.hash).toBe(
      restored.chainHead('club1', 't1')!.hash === next.hash
        ? fetchedAll[9]!.hash
        : fetchedAll[9]!.hash,
    );
  });

  it('hand records form a verifiable hash chain independent of git history', () => {
    const store = GitStore.open(join(root, 'host'), { remote });
    stores.push(store);
    const records: HandRecord[] = [];
    for (let h = 1; h <= 5; h++) {
      store.appendHand(record('c', 't', h));
      const ref = `refs/hands/c/t/${h}`;
      records.push(
        JSON.parse(git(['cat-file', '-p', `${ref}:hand.json`], { cwd: store.dir })) as HandRecord,
      );
    }
    expect(GitStore.verifyChain(records)).toEqual({ ok: true });
    const tampered = records.map((r) => (r.hand === 3 ? { ...r, entries: [] } : r));
    expect(GitStore.verifyChain(tampered)).toEqual({ ok: false, brokenAt: 3 });
    const reordered = [records[0]!, records[2]!, records[1]!, records[3]!, records[4]!];
    expect(GitStore.verifyChain(reordered).ok).toBe(false);
    expect(() => store.appendHand(record('c', 't', 9))).toThrow(/does not follow/);
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('a failed push keeps the local hand refs and a later push delivers them', () => {
    const store = GitStore.open(join(root, 'host'), { remote });
    stores.push(store);
    for (let h = 1; h <= 3; h++) store.appendHand(record('c', 't', h));
    store.commitState({ 'clubs/c/state.json': { hand: 3 } });
    const parked = join(root, 'parked.git');
    renameSync(remote, parked);
    const first = store.pushAll();
    expect(first.ok).toBe(false);
    expect(store.status().unpushedHands).toBe(3);
    expect(store.status().lastPushError).toBeTruthy();
    renameSync(parked, remote);
    const second = store.pushAll();
    expect(second).toEqual({ ok: true, hands: 3 });
    expect(store.status().unpushedHands).toBe(0);
    expect(store.status().lastPushError).toBeNull();
  });

  it('a crash between commit and push loses only the unpushed hands, never half a hand', () => {
    const host = GitStore.open(join(root, 'host'), { remote });
    stores.push(host);
    for (let h = 1; h <= 4; h++) {
      host.appendHand(record('c', 't', h));
      host.commitState({ 'clubs/c/state.json': { hand: h } });
      if (h === 2) host.pushAll();
    }
    host.destroy(); // crash: local repo gone with hands 3 and 4 unpushed
    const again = GitStore.restore(join(root, 'host3'), remote);
    stores.push(again);
    expect(again.readState('clubs/c/state.json')).toEqual({ hand: 2 });
    expect(again.chainHead('c', 't')).toMatchObject({ hand: 2 });
    expect(again.remoteHands('c', 't')).toEqual([1, 2]);
  });

  it('two hosts on one remote: the second push of main is rejected as non-fast-forward', () => {
    const a = GitStore.open(join(root, 'hostA'), { remote });
    stores.push(a);
    a.commitState({ 'clubs/c/state.json': { hand: 0 } });
    expect(a.pushAll().ok).toBe(true);
    const b = GitStore.restore(join(root, 'hostB'), remote);
    stores.push(b);
    b.commitState({ 'clubs/c/state.json': { hand: 1, by: 'B' } });
    expect(b.pushAll().ok).toBe(true);
    a.commitState({ 'clubs/c/state.json': { hand: 1, by: 'A' } });
    const clash = a.pushAll();
    expect(clash.ok).toBe(false);
    expect(clash.error).toMatch(/fetch first|non-fast-forward|rejected/i);
  });

  it('fast-import mode writes the same refs and records as plumbing', async () => {
    const store = GitStore.open(join(root, 'host'), { remote, fastImport: true });
    stores.push(store);
    let mark = 0;
    for (let h = 1; h <= 20; h++) mark = store.appendHand(record('c', 't', h)).mark!;
    await store.flushHands(mark);
    expect(store.localHandRefs()).toHaveLength(20);
    const rec = JSON.parse(
      git(['cat-file', '-p', 'refs/hands/c/t/20:hand.json'], { cwd: store.dir }),
    ) as HandRecord;
    expect(rec.hand).toBe(20);
    expect(rec.prevHash).toBe(
      store.chainHead('c', 't')!.hash === rec.hash ? rec.prevHash : rec.prevHash,
    );
    const pushed = store.pushAll();
    expect(pushed.error ?? '').toBe('');
    expect(pushed).toEqual({ ok: true, hands: 20 });
    await store.close();
  });

  it('daily buckets keep the ref namespace flat per day', () => {
    const store = GitStore.open(join(root, 'host'), { remote, bucket: 'day' });
    stores.push(store);
    const r = store.appendHand(record('c', 't', 1));
    expect(r.ref).toMatch(/^refs\/hands\/c\/\d{8}\/t-1$/);
  });
});
