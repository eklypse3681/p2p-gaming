import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { createMemoryPair } from '@bgf/protocol';
import type { BeaconSource, EntropySource, GameDefinition } from '../src/index.js';
import {
  CommandError,
  TableClient,
  TableServer,
  beaconContext,
  commitmentFor,
  createByteRng,
  hexToBytes,
  hkdfSha256,
  segmentRngFor,
  utf8Bytes,
  verifySegment,
} from '../src/index.js';

/**
 * A toy card game with hands: `new-hand` deals one card per seat (a segment boundary), `draw`
 * deals one more card to the sender, `end` finishes the hand (segment complete). Cards are
 * numbers 0..51 drawn with the rng; the deck is not tracked (draws are independent).
 */
interface HandState {
  hand: number;
  cards: Record<number, number[]>;
  over: boolean;
}
type HandAction =
  | { type: 'dealt'; hand: number; cards: number[] }
  | { type: 'drew'; seat: number; card: number }
  | { type: 'ended' };
type HandCommand = { type: 'new-hand' } | { type: 'draw' } | { type: 'end' } | { type: 'bad' };

const handGame: GameDefinition<HandState, HandAction, HandCommand> = {
  id: 'hands',
  minSeats: 2,
  maxSeats: 3,
  init: () => ({ hand: 0, cards: {}, over: true }),
  validateCommand: (raw) => {
    const t = (raw as { type?: unknown })?.type;
    return t === 'new-hand' || t === 'draw' || t === 'end' || t === 'bad'
      ? ({ type: t } as HandCommand)
      : null;
  },
  command(state, seat, cmd, ctx) {
    if (cmd.type === 'new-hand') {
      if (!state.over) throw new CommandError('in-hand', 'finish the hand first');
      return {
        type: 'dealt',
        hand: state.hand + 1,
        cards: Array.from({ length: ctx.seats }, () => ctx.rng.int(52)),
      };
    }
    if (cmd.type === 'draw') return { type: 'drew', seat, card: ctx.rng.int(52) };
    if (cmd.type === 'bad') {
      ctx.rng.int(52);
      throw new CommandError('nope', 'refused after drawing');
    }
    return { type: 'ended' };
  },
  reduce(state, action) {
    if (action.type === 'dealt') {
      const cards: Record<number, number[]> = {};
      action.cards.forEach((c, i) => (cards[i] = [c]));
      return { hand: action.hand, cards, over: false };
    }
    if (action.type === 'drew') {
      return {
        ...state,
        cards: {
          ...state.cards,
          [action.seat]: [...(state.cards[action.seat] ?? []), action.card],
        },
      };
    }
    return { ...state, over: true };
  },
  view: (s) => s,
  segmentBoundary: (_s, cmd) => cmd.type === 'new-hand',
  segmentComplete: (s) => s.over,
};

const P = (id: string): PlayerProfile => ({ id, name: id });
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake signed source: predictable bytes, a serial counter, optional failure. */
function source(opts: { fail?: () => boolean } = {}) {
  let serial = 0;
  const labels: string[] = [];
  const src: EntropySource = {
    id: 'oracle',
    async draw(bytes, ctx) {
      labels.push(ctx.label);
      if (opts.fail?.()) throw new Error('oracle down');
      serial += 1;
      const out = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) out[i] = (i * 13 + serial * 7) & 0xff;
      return {
        bytes: out,
        proof: {
          kind: 'random.org-signed',
          random: { data: Array.from(out) },
          signature: `s${serial}`,
          serialNumber: serial,
        },
        fetchedAt: 1,
        serialNumber: serial,
      };
    },
  };
  return { src, labels };
}

type HS = TableServer<HandState, HandAction, HandCommand>;
type HC = TableClient<HandState, HandAction>;

function guest(server: HS, profile: PlayerProfile): HC {
  const [serverEnd, clientEnd] = createMemoryPair('rnd');
  server.accept(serverEnd);
  return new TableClient({ transport: clientEnd, profile, pingIntervalMs: 0 });
}

async function seededTable(src: EntropySource, extra: { fallback?: boolean } = {}) {
  const server: HS = await TableServer.create({
    def: handGame,
    code: 'SEED',
    host: P('h'),
    seats: 2,
    options: { randomness: { mode: 'seeded' } },
    entropy: { source: src, fallback: extra.fallback ?? false },
    now: () => 42,
    matchId: 'seeded-1',
  });
  const host: HC = new TableClient({
    transport: server.connectLocal(),
    profile: P('h'),
    pingIntervalMs: 0,
  });
  const g = guest(server, P('g'));
  await flush();
  return { server, host, g };
}

describe('seeded randomness (commit and reveal)', () => {
  it('commits a seed before any draw of a hand and reveals it when the hand ends', async () => {
    const { src, labels } = source();
    const { server, host, g } = await seededTable(src);
    // Table creation opened segment 0 (nothing drew from it yet).
    const audit0 = server.getSnapshot().entropyAudit!;
    expect(audit0.mode).toBe('seeded');
    expect(server.getSnapshot().options.randomness).toEqual({ mode: 'seeded', provider: 'oracle' });
    expect(audit0.segments).toHaveLength(1);
    expect(audit0.segments![0]).toMatchObject({ index: 0, from: 0, committedAt: 42 });
    expect(audit0.segments![0]!.seed).toBeUndefined();
    expect(labels).toEqual(['seed']);

    // A new hand is a boundary: segment 1 is committed (and the empty segment 0 revealed).
    host.send({ type: 'new-hand' });
    await flush();
    const snap1 = server.getSnapshot();
    expect(labels).toEqual(['seed', 'seed']);
    const [s0, s1] = snap1.entropyAudit!.segments!;
    expect(s0!.seed).toBeDefined();
    expect(s1).toMatchObject({ index: 1, from: 0 });
    expect(s1!.seed).toBeUndefined(); // the hand is in progress: still secret
    // The guest saw the commitment before the deal arrived, and sees the deal's attribution.
    const gs = g.getState().snapshot!;
    expect(gs.entropyAudit!.segments![1]!.commitment).toBe(s1!.commitment);
    const dealRecord = snap1.actionMeta![0]!.entropy!;
    expect(dealRecord).toMatchObject({
      label: 'new-hand',
      provider: 'seeded:oracle',
      segment: 1,
      drawIndex: 0,
      sources: [],
    });
    expect(dealRecord.draws).toHaveLength(2);

    g.send({ type: 'draw' });
    await flush();
    const drawRecord = server.getSnapshot().actionMeta![1]!.entropy!;
    expect(drawRecord).toMatchObject({ label: 'draw', segment: 1, drawIndex: 1 });
    expect(labels).toEqual(['seed', 'seed']); // no request per draw: everything derives from the seed
    expect(verifySegment(server.getSnapshot(), 1)).toMatchObject({ ok: false, revealed: false });

    host.send({ type: 'end' });
    await flush();
    const done = server.getSnapshot();
    const revealed = done.entropyAudit!.segments![1]!;
    expect(revealed.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(revealed.source!.proof.kind).toBe('random.org-signed');
    expect(revealed.to).toBe(2);
    expect(commitmentFor(hexToBytes(revealed.seed!), done.id, 1)).toBe(revealed.commitment);
    const check = verifySegment(done, 1);
    expect(check).toMatchObject({ ok: true, revealed: true, commitment: true });
    expect(check.actions).toEqual([
      { index: 0, ok: true },
      { index: 1, ok: true },
    ]);
    // Guests can run the same verification from their copy.
    expect(verifySegment(g.getState().snapshot!, 1).ok).toBe(true);
    // The concrete values re-derive: the deal's two cards and the drawn card.
    const rng0 = segmentRngFor(done, 0)!;
    expect([rng0.int(52), rng0.int(52)]).toEqual((done.actions[0] as { cards: number[] }).cards);
    expect(segmentRngFor(done, 1)!.int(52)).toBe((done.actions[1] as { card: number }).card);
    server.close();
  });

  it('detects tampering with a draw value or with the revealed seed', async () => {
    const { src } = source();
    const { server, host } = await seededTable(src);
    host.send({ type: 'new-hand' });
    await flush();
    host.send({ type: 'end' });
    await flush();
    const snap = server.getSnapshot();
    const tamperedDraw = JSON.parse(JSON.stringify(snap)) as typeof snap;
    tamperedDraw.actionMeta![0]!.entropy!.draws[0]!.value ^= 1;
    expect(verifySegment(tamperedDraw, 1).ok).toBe(false);
    const tamperedSeed = JSON.parse(JSON.stringify(snap)) as typeof snap;
    tamperedSeed.entropyAudit!.segments![1]!.seed = '00'.repeat(32);
    const r = verifySegment(tamperedSeed, 1);
    expect(r.commitment).toBe(false);
    expect(r.ok).toBe(false);
    expect(verifySegment(snap, 9)).toMatchObject({ ok: false, reasons: ['no such segment'] });
    server.close();
  });

  it('reveals an open segment when the table closes, and a rule error mid-hand changes nothing', async () => {
    const { src } = source();
    const { server, host, g } = await seededTable(src);
    host.send({ type: 'new-hand' });
    await flush();
    g.send({ type: 'bad' });
    await flush();
    expect(g.getState().error).toMatchObject({ code: 'nope' });
    expect(server.getSnapshot().actions).toHaveLength(1);
    const seenByGuest: (string | undefined)[] = [];
    g.subscribe(() => seenByGuest.push(g.getState().snapshot!.entropyAudit!.segments![1]!.seed));
    server.close();
    await flush();
    const seg = server.getSnapshot().entropyAudit!.segments![1]!;
    expect(seg.seed).toBeDefined();
    expect(seenByGuest.at(-1)).toBe(seg.seed);
    expect(verifySegment(server.getSnapshot(), 1).ok).toBe(true);
  });

  it('refuses the boundary command with entropy-unavailable when no seed can be obtained', async () => {
    let calls = 0;
    const { src } = source({ fail: () => ++calls > 1 });
    const { server, host } = await seededTable(src);
    host.send({ type: 'new-hand' });
    await flush();
    expect(host.getState().error).toMatchObject({ code: 'entropy-unavailable' });
    expect(server.getSnapshot().actions).toEqual([]);
    expect(server.getSnapshot().entropyAudit!.segments).toHaveLength(1);
    server.close();
  });

  it('works with this device as the seed source when no oracle is configured', async () => {
    const server: HS = await TableServer.create({
      def: handGame,
      code: 'LOCAL',
      host: P('h'),
      seats: 2,
      options: { randomness: { mode: 'seeded' } },
      matchId: 'seeded-local',
    });
    const host: HC = new TableClient({
      transport: server.connectLocal(),
      profile: P('h'),
      pingIntervalMs: 0,
    });
    await flush();
    host.send({ type: 'new-hand' });
    await flush();
    host.send({ type: 'end' });
    await flush();
    const snap = server.getSnapshot();
    expect(snap.options.randomness).toEqual({ mode: 'seeded', provider: 'crypto' });
    expect(snap.entropyAudit!.segments![1]!.source!.proof).toEqual({ kind: 'none' });
    expect(verifySegment(snap, 1).ok).toBe(true);
    server.close();
  });

  it('a resumed seeded table opens a fresh segment for its next hand', async () => {
    const { src } = source();
    const { server, host } = await seededTable(src);
    host.send({ type: 'new-hand' });
    await flush();
    host.send({ type: 'end' });
    await flush();
    const copy = server.getSnapshot();
    server.close();
    const again: HS = new TableServer({
      def: handGame,
      code: 'SEED',
      host: P('h'),
      snapshot: copy,
      options: { randomness: { mode: 'seeded' } },
      entropy: { source: src },
    });
    const h2: HC = new TableClient({
      transport: again.connectLocal(),
      profile: P('h'),
      pingIntervalMs: 0,
    });
    await flush();
    h2.send({ type: 'new-hand' });
    await flush();
    const segs = again.getSnapshot().entropyAudit!.segments!;
    expect(segs.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(segs[2]!.seed).toBeUndefined();
    expect(verifySegment(again.getSnapshot(), 1).ok).toBe(true);
    again.close();
  });
});

/** A fake drand chain: 3 s rounds, published when the fake clock reaches them. */
function fakeBeacon(opts: { periodMs?: number; never?: boolean } = {}) {
  const periodMs = opts.periodMs ?? 3000;
  const genesisMs = 1_000_000;
  let now = genesisMs + 10_000; // round 4 is the latest
  const chainHash = 'ab'.repeat(32);
  const served: number[] = [];
  const randomness = (round: number) =>
    (round.toString(16).padStart(2, '0') + 'cd'.repeat(31)).slice(0, 64);
  const publishedAt = (round: number) => genesisMs + (round - 1) * periodMs;
  const beacon: BeaconSource = {
    id: 'drand',
    chainHash,
    async draw() {
      throw new Error('latest-round draws are not used in beacon mode');
    },
    async schedule() {
      return { periodMs, genesisMs };
    },
    roundAt(t, s) {
      return Math.floor((t - s.genesisMs) / s.periodMs) + 1;
    },
    async drawRound(round, bytes, ctx) {
      const deadline = now + ctx.timeoutMs;
      for (;;) {
        if (!opts.never && now >= publishedAt(round)) {
          served.push(round);
          const out = hkdfSha256(
            hexToBytes(randomness(round)),
            hexToBytes(chainHash),
            utf8Bytes(ctx.context),
            bytes,
          );
          return {
            bytes: out,
            proof: {
              kind: 'drand',
              round,
              randomness: randomness(round),
              signature: 'sig',
              chainHash,
              context: ctx.context,
            },
            fetchedAt: now,
          };
        }
        if (now >= deadline) throw new Error(`round ${round} not available`);
        now += 1000; // "sleep" a second
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
  return {
    beacon,
    served,
    clock: () => now,
    randomness,
    chainHash,
    periodMs,
    genesisMs,
    publishedAt,
  };
}

describe('beacon randomness (draws bound to a future drand round)', () => {
  it('chooses the next round before it exists, publishes the binding, and derives the draw from it', async () => {
    const fb = fakeBeacon();
    const server: HS = await TableServer.create({
      def: handGame,
      code: 'BEAC',
      host: P('h'),
      seats: 2,
      options: { randomness: { mode: 'beacon' } },
      entropy: { source: fb.beacon, bytes: 16, beaconTimeoutMs: 30_000 },
      now: fb.clock,
      matchId: 'beacon-1',
    });
    const host: HC = new TableClient({
      transport: server.connectLocal(),
      profile: P('h'),
      pingIntervalMs: 0,
    });
    const g = guest(server, P('g'));
    await flush();
    expect(server.getSnapshot().options.randomness).toEqual({ mode: 'beacon', provider: 'drand' });
    expect(server.getSnapshot().entropyAudit).toMatchObject({
      mode: 'beacon',
      beacon: { chainHash: fb.chainHash, pending: [] },
    });

    const t0 = fb.clock();
    const roundNow = Math.floor((t0 - fb.genesisMs) / fb.periodMs) + 1;
    const pendingSeen: number[][] = [];
    g.subscribe(() =>
      pendingSeen.push(g.getState().snapshot!.entropyAudit!.beacon!.pending.map((b) => b.round)),
    );
    host.send({ type: 'new-hand' });
    await flush(2);
    // The binding is public while the round is still in the future.
    expect(pendingSeen.some((p) => p.includes(roundNow + 1))).toBe(true);
    await flush(20);
    const snap = server.getSnapshot();
    expect(snap.actions).toHaveLength(1);
    const rec = snap.actionMeta![0]!.entropy!;
    expect(rec.beacon).toMatchObject({
      counter: 0,
      round: roundNow + 1,
      chainHash: fb.chainHash,
      committedAt: t0,
    });
    expect(rec.beacon!.committedAt).toBeLessThan(fb.publishedAt(roundNow + 1));
    expect(fb.served).toEqual([roundNow + 1]);
    expect(snap.entropyAudit!.beacon!.pending).toEqual([]);
    expect(rec.sources[0]!.proof).toMatchObject({
      kind: 'drand',
      round: roundNow + 1,
      context: beaconContext('beacon-1', 0),
    });
    // Anyone can re-derive: expand the round with the recorded context and replay the draws.
    const bytes = hkdfSha256(
      hexToBytes(fb.randomness(roundNow + 1)),
      hexToBytes(fb.chainHash),
      utf8Bytes(beaconContext('beacon-1', 0)),
      16,
    );
    const rng = createByteRng(bytes);
    expect([rng.int(52), rng.int(52)]).toEqual((snap.actions[0] as { cards: number[] }).cards);
    expect(g.getState().snapshot!.actionMeta![0]).toEqual(snap.actionMeta![0]);

    // A second draw gets the next counter and a later round.
    g.send({ type: 'draw' });
    await flush(20);
    const rec2 = server.getSnapshot().actionMeta![1]!.entropy!;
    expect(rec2.beacon!.counter).toBe(1);
    expect(rec2.beacon!.round).toBeGreaterThan(roundNow + 1);
    server.close();
  });

  it('refuses the command when the round never arrives, leaving the state untouched', async () => {
    const fb = fakeBeacon({ never: true });
    const server: HS = await TableServer.create({
      def: handGame,
      code: 'BEAC',
      host: P('h'),
      seats: 2,
      options: { randomness: { mode: 'beacon' } },
      entropy: { source: fb.beacon, beaconTimeoutMs: 5_000 },
      now: fb.clock,
    });
    const host: HC = new TableClient({
      transport: server.connectLocal(),
      profile: P('h'),
      pingIntervalMs: 0,
    });
    await flush();
    host.send({ type: 'new-hand' });
    await flush(30);
    expect(host.getState().error).toMatchObject({ code: 'entropy-unavailable' });
    expect(server.getSnapshot().actions).toEqual([]);
    expect(server.getSnapshot().entropyAudit!.beacon!.pending).toEqual([]);
    server.close();
  });

  it('needs a beacon source', () => {
    const { src } = source();
    expect(
      () =>
        new TableServer({
          def: handGame,
          code: 'X',
          host: P('h'),
          options: { randomness: { mode: 'beacon' } },
          entropy: { source: src },
        }),
    ).toThrow(/BeaconSource/);
  });
});
