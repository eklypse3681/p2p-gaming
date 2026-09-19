import { describe, expect, it, vi } from 'vitest';
import type { EntropyRecord, PlayerProfile } from '@bgf/protocol';
import type { GameDefinition } from '@bgf/table';
import { TableClient, TableServer } from '@bgf/table';
import {
  beaconContext,
  bytesToHex,
  commitmentFor,
  cryptoProvider,
  createByteRng,
  drandProvider,
  expandDrand,
  hexToBytes,
  hkdfSha256,
  segmentRngFor,
  seedSegments,
  utf8Bytes,
  verifyBeaconRecord,
  verifySegment,
} from '../src/index.js';

/** Two-seat dice game: `roll` draws two dice; `next` ends a "game" (segment). */
interface S {
  rolls: number[][];
  over: boolean;
}
type A = { type: 'rolled'; dice: number[] } | { type: 'next' } | { type: 'over' };
type C = { type: 'roll' } | { type: 'next' } | { type: 'over' };
const dice: GameDefinition<S, A, C> = {
  id: 'dice',
  minSeats: 2,
  maxSeats: 2,
  init: () => ({ rolls: [], over: false }),
  validateCommand: (raw) => {
    const t = (raw as { type?: unknown })?.type;
    return t === 'roll' || t === 'next' || t === 'over' ? ({ type: t } as C) : null;
  },
  command: (_s, _seat, cmd, ctx) =>
    cmd.type === 'roll'
      ? { type: 'rolled', dice: [ctx.rng.int(6) + 1, ctx.rng.int(6) + 1] }
      : cmd.type === 'next'
        ? { type: 'next' }
        : { type: 'over' },
  reduce: (s, a) =>
    a.type === 'rolled'
      ? { ...s, rolls: [...s.rolls, a.dice] }
      : a.type === 'next'
        ? { rolls: [], over: false }
        : { ...s, over: true },
  view: (s) => s,
  segmentBoundary: (_s, cmd) => cmd.type === 'next',
  segmentComplete: (s) => s.over,
};

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const P = (id: string): PlayerProfile => ({ id, name: id });

describe('verifySegment over a seeded table with this device as the source', () => {
  it('passes for genuine records, exposes the dice, and fails on tampering', async () => {
    const server = await TableServer.create({
      def: dice,
      code: 'DICE',
      host: P('h'),
      options: { randomness: { mode: 'seeded' } },
      entropy: { source: cryptoProvider() },
      matchId: 'dice-1',
    });
    const host = new TableClient<S, A>({
      transport: server.connectLocal(),
      profile: P('h'),
      pingIntervalMs: 0,
    });
    await flush();
    host.send({ type: 'next' });
    await flush();
    host.send({ type: 'roll' });
    host.send({ type: 'roll' });
    await flush();
    const midway = server.getSnapshot();
    expect(seedSegments(midway).map((s) => s.index)).toEqual([0, 1]);
    expect(verifySegment(midway, 1)).toMatchObject({ ok: false, revealed: false });
    host.send({ type: 'over' });
    await flush();
    const snap = server.getSnapshot();
    const seg = seedSegments(snap)[1]!;
    expect(seg.seed).toBeDefined();
    expect(commitmentFor(hexToBytes(seg.seed!), 'dice-1', 1)).toBe(seg.commitment);
    const check = verifySegment(snap, 1);
    expect(check.ok).toBe(true);
    expect(check.actions.map((a) => a.index)).toEqual([1, 2]);
    for (const index of [1, 2]) {
      const rng = segmentRngFor(snap, index)!;
      expect([rng.int(6) + 1, rng.int(6) + 1]).toEqual(
        (snap.actions[index] as { dice: number[] }).dice,
      );
    }
    const tampered = JSON.parse(JSON.stringify(snap)) as typeof snap;
    tampered.actionMeta![2]!.entropy!.bytes =
      '00' + tampered.actionMeta![2]!.entropy!.bytes.slice(2);
    expect(verifySegment(tampered, 1).ok).toBe(false);
    server.close();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('drand as a beacon source', () => {
  const chainHash = 'ab'.repeat(32);
  const randomness = (round: number) =>
    (round.toString(16).padStart(2, '0') + 'ef'.repeat(31)).slice(0, 64);

  it('expands rounds identically to the synchronous HKDF used by verifiers', async () => {
    const ctx = beaconContext('t1', 3);
    const a = await expandDrand(randomness(5), chainHash, ctx, 40);
    const b = hkdfSha256(hexToBytes(randomness(5)), hexToBytes(chainHash), utf8Bytes(ctx), 40);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('waits for a future round, then a record verifies as committed in advance', async () => {
    const schedule = { periodMs: 3000, genesisMs: 1_000_000 };
    let now = schedule.genesisMs + 9_500; // round 4 is out; round 5 publishes at +12 000
    const fetch = vi.fn(async (url: string) => {
      const m = /public\/(\d+)$/.exec(url);
      if (!m) return jsonResponse({}, 404);
      const round = Number(m[1]);
      const publishedAt = schedule.genesisMs + (round - 1) * schedule.periodMs;
      if (now < publishedAt) return jsonResponse({ error: 'not yet' }, 404);
      return jsonResponse({ round, randomness: randomness(round), signature: 'sig' + round });
    });
    const provider = drandProvider({
      chainHash,
      baseUrl: 'https://fake',
      fetch,
      now: () => now,
      schedule,
      pollMs: 500,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(provider.roundAt(now, await provider.schedule())).toBe(4);
    const committedAt = now;
    const ctx = beaconContext('t1', 0);
    const draw = await provider.drawRound(5, 16, {
      label: 'roll',
      tableId: 't1',
      purpose: 'table',
      context: ctx,
      timeoutMs: 30_000,
    });
    expect(fetch.mock.calls.length).toBeGreaterThan(1); // it had to wait
    expect(draw.proof).toMatchObject({ kind: 'drand', round: 5, context: ctx });
    const rng = createByteRng(draw.bytes);
    const record: EntropyRecord = {
      label: 'roll',
      provider: 'drand',
      bytes: '',
      bytesUsed: 0,
      draws: [
        { n: 6, value: rng.int(6) },
        { n: 6, value: rng.int(6) },
      ],
      sources: [{ proof: draw.proof, bytes: bytesToHex(draw.bytes), fetchedAt: draw.fetchedAt }],
      fallback: false,
      beacon: { counter: 0, chainHash, round: 5, committedAt },
    };
    record.bytesUsed = rng.used();
    record.bytes = bytesToHex(draw.bytes.subarray(0, rng.used()));
    const ok = await verifyBeaconRecord(record, { baseUrl: 'https://fake', fetch, schedule });
    expect(ok).toEqual({
      ok: true,
      round: true,
      bytes: true,
      draws: true,
      committedInAdvance: true,
    });
    const late = await verifyBeaconRecord(
      { ...record, beacon: { ...record.beacon!, committedAt: now + 1 } },
      { baseUrl: 'https://fake', fetch, schedule },
    );
    expect(late.committedInAdvance).toBe(false);
    const forged = await verifyBeaconRecord(
      { ...record, draws: [{ n: 6, value: (record.draws[0]!.value + 1) % 6 }, record.draws[1]!] },
      { baseUrl: 'https://fake', fetch, schedule },
    );
    expect(forged.ok).toBe(false);
  });

  it('gives up on a round that never arrives', async () => {
    let now = 5_000_000;
    const provider = drandProvider({
      chainHash,
      baseUrl: 'https://fake',
      fetch: vi.fn(async () => jsonResponse({}, 404)),
      now: () => now,
      schedule: { periodMs: 3000, genesisMs: 1_000_000 },
      pollMs: 1000,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(
      provider.drawRound(99_999, 8, {
        label: 'x',
        tableId: 't',
        purpose: 'p',
        context: 'c',
        timeoutMs: 4000,
      }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
