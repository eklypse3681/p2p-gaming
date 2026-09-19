import { describe, expect, it, vi } from 'vitest';
import type { EntropyBatch, EntropyProvider } from '../src/index.js';
import { createEntropyPool, cryptoProvider, deriveDraws, drawsMatch } from '../src/index.js';
import { hexToBytes } from '@bgf/table';

/** A local (poolable) provider that hands out a fixed byte pattern and can be made to fail. */
function fakeProvider(opts: { fail?: () => boolean; delay?: number } = {}): EntropyProvider & {
  calls: number;
} {
  let counter = 0;
  const make = (bytes: number): EntropyBatch => {
    p.calls++;
    if (opts.fail?.()) throw new Error('nope');
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = (counter++ * 7 + 3) & 0xff;
    return {
      provider: 'fake',
      bytes: out,
      proof: { kind: 'custom', provider: 'fake', data: p.calls },
      fetchedAt: 1,
    };
  };
  const p = {
    id: 'fake',
    name: 'Fake',
    calls: 0,
    async fetch(bytes: number) {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return make(bytes);
    },
    fetchSync: (bytes: number) => make(bytes),
    draw: async (bytes: number) => make(bytes),
  };
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('entropy pool', () => {
  it('draws from the provider once filled and attributes draws to batches', async () => {
    const provider = fakeProvider();
    const pool = createEntropyPool({ provider, tableId: 't', lowWater: 16, batch: 64 });
    expect(pool.provider).toBe('fake');
    await expect(pool.ready()).resolves.toBe(true);
    expect(pool.available()).toBe(64);
    const { value, record } = pool.withDraw('roll', (rng) => [rng.int(6), rng.int(6)]);
    expect(value.every((v) => v >= 0 && v < 6)).toBe(true);
    expect(record).toMatchObject({
      label: 'roll',
      provider: 'fake',
      batches: ['b1'],
      fallback: false,
      sources: [],
    });
    expect(record!.bytesUsed).toBeGreaterThanOrEqual(8);
    expect(record!.bytes.length).toBe(record!.bytesUsed * 2);
    expect(record!.draws.map((d) => d.n)).toEqual([6, 6]);
    expect(record!.draws.map((d) => d.value)).toEqual(value);
    expect(drawsMatch(record!)).toBe(true);
    expect(deriveDraws(hexToBytes(record!.bytes), record!.draws)).toEqual(value);
    expect(pool.available()).toBe(64 - record!.bytesUsed);
    const nothing = pool.withDraw('noop', () => 42);
    expect(nothing).toEqual({ value: 42, record: null });
    const audit = pool.audit();
    expect(audit.batches).toEqual([
      {
        id: 'b1',
        provider: 'fake',
        fetchedAt: 1,
        bytes: 64,
        proof: { kind: 'custom', provider: 'fake', data: 1 },
      },
    ]);
    expect(audit.records).toEqual([record]);
  });

  it('refills in the background at the low-water mark and straddles batches', async () => {
    const provider = fakeProvider();
    const pool = createEntropyPool({ provider, tableId: 't', lowWater: 12, batch: 16 });
    await pool.ready();
    expect(provider.calls).toBe(1);
    // 16 bytes available: one int uses 4; after two draws 8 remain (< 12) → refill kicks off.
    pool.withDraw('a', (r) => r.int(100));
    pool.withDraw('b', (r) => r.int(100));
    expect(pool.available()).toBe(8);
    await tick();
    await tick();
    expect(provider.calls).toBe(2);
    expect(pool.available()).toBe(24);
    // A draw of 3 ints (12 bytes) crosses from b1 (8 left) into b2.
    const { record } = pool.withDraw('c', (r) => [r.int(2), r.int(2), r.int(2)]);
    expect(record!.batches).toEqual(['b1', 'b2']);
  });

  it('falls back when empty, flags the record and reports the event', async () => {
    const events: string[] = [];
    const provider = fakeProvider({ fail: () => true });
    const pool = createEntropyPool({
      provider,
      tableId: 't',
      lowWater: 8,
      batch: 8,
      retryMs: 10_000,
      onEvent: (e) => events.push(e.type),
    });
    await expect(pool.ready()).resolves.toBe(false);
    const { value, record } = pool.withDraw('shuffle', (r) => r.shuffle([1, 2, 3, 4, 5]));
    expect(value.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(record).toMatchObject({ fallback: true, batches: [], provider: 'fake' });
    expect(drawsMatch(record!)).toBe(true);
    expect(events).toContain('refill-error');
    expect(events).toContain('fallback');
    // The failed refill is not retried before the cooldown.
    const calls = provider.calls;
    pool.withDraw('again', (r) => r.int(3));
    await tick();
    expect(provider.calls).toBe(calls);
  });

  it('shuffle and int are uniform-ish over pooled bytes', async () => {
    const provider = cryptoProvider();
    const pool = createEntropyPool({ provider, tableId: 't', lowWater: 4096, batch: 65_536 });
    await pool.ready();
    const buckets = new Array<number>(6).fill(0);
    const n = 12_000;
    for (let i = 0; i < n; i++) buckets[pool.int(6)]!++;
    const expected = n / 6;
    const chi2 = buckets.reduce((acc, b) => acc + (b - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(25); // 5 degrees of freedom; 25 is far beyond p = 0.001
    const first = new Array<number>(5).fill(0);
    for (let i = 0; i < 5000; i++) first[pool.shuffle([0, 1, 2, 3, 4])[0]!]!++;
    expect(Math.min(...first)).toBeGreaterThan(800);
  });

  it('refuses nested draws, requires a synchronous fallback, and stops after close', async () => {
    const pool = createEntropyPool({
      provider: fakeProvider(),
      tableId: 't',
      lowWater: 4,
      batch: 8,
    });
    await pool.ready();
    expect(() => pool.withDraw('outer', () => pool.withDraw('inner', () => 1))).toThrow(/nested/);
    const remote: EntropyProvider = {
      id: 'x',
      name: 'x',
      fetch: async () => {
        throw new Error('no');
      },
      draw: async () => {
        throw new Error('no');
      },
    };
    expect(() =>
      createEntropyPool({ provider: fakeProvider(), fallback: remote, tableId: 't' }),
    ).toThrow(/fetchSync/);
    // External oracles are never pooled: pre-fetching would let the host peek.
    expect(() => createEntropyPool({ provider: remote, tableId: 't' })).toThrow(
      /only local generators/,
    );
    pool.close();
    await expect(pool.refill()).resolves.toBe(false);
    expect(pool.withDraw('after', (r) => r.int(4)).record!.fallback).toBe(false); // still had bytes
  });

  it('caps the records it keeps', async () => {
    const pool = createEntropyPool({
      provider: fakeProvider(),
      tableId: 't',
      lowWater: 8,
      batch: 4096,
      maxRecords: 3,
    });
    await pool.ready();
    for (let i = 0; i < 5; i++) pool.withDraw(`d${i}`, (r) => r.int(2));
    expect(pool.audit().records.map((r) => r.label)).toEqual(['d2', 'd3', 'd4']);
  });

  it('shares one in-flight refill and honours a slow provider', async () => {
    vi.useFakeTimers();
    try {
      const provider = fakeProvider({ delay: 50 });
      const pool = createEntropyPool({ provider, tableId: 't', lowWater: 8, batch: 8 });
      const a = pool.refill();
      const b = pool.refill();
      expect(a).toBe(b);
      await vi.advanceTimersByTimeAsync(60);
      await expect(a).resolves.toBe(true);
      expect(provider.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
