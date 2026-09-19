import type { AuditedRng, Rng } from '@bgf/table';
import { bytesToHex } from '@bgf/table';
import type { DrawSpec, EntropyBatchSummary, EntropyRecord } from '@bgf/protocol';
import type { EntropyBatch, EntropyProvider, FetchContext } from './types.js';
import { EntropyError } from './types.js';
import { cryptoProvider } from './crypto.js';

export type EntropyEvent =
  | { type: 'refill-start'; bytes: number }
  | { type: 'refill-ok'; batch: EntropyBatchSummary }
  | { type: 'refill-error'; error: EntropyError | Error }
  /** A draw needed more bytes than the pool held; the fallback supplied `bytes`. */
  | { type: 'fallback'; label: string; bytes: number };

export interface EntropyPoolOptions {
  provider: EntropyProvider;
  /** Used synchronously when the pool runs dry; must implement `fetchSync`. Default: this device's CSPRNG. */
  fallback?: EntropyProvider;
  /** Refill when fewer bytes than this remain. Default 256. */
  lowWater?: number;
  /** Bytes fetched per refill. Default 1024. */
  batch?: number;
  tableId: string;
  purpose?: string;
  onEvent?: (event: EntropyEvent) => void;
  /** Keep at most this many draw records (oldest dropped). Default 5000. */
  maxRecords?: number;
  /** After a failed refill, wait this long before trying again. Default 2000 ms. */
  retryMs?: number;
  now?: () => number;
}

export interface EntropyPool extends AuditedRng {
  /** Bytes currently available without touching the fallback. */
  available(): number;
  /** Fetch one batch from the provider (shared while one is in flight). Never throws. */
  refill(): Promise<boolean>;
  /** Resolves true once at least `lowWater` bytes are pooled, false if the provider failed. */
  ready(): Promise<boolean>;
  audit(): { batches: EntropyBatchSummary[]; records: EntropyRecord[] };
  /** Stop refilling. Draws keep working from what is left, then from the fallback. */
  close(): void;
}

interface Chunk {
  id: string;
  bytes: Uint8Array;
  offset: number;
}

interface DrawContext {
  label: string;
  bytesUsed: number;
  batches: string[];
  fallback: boolean;
  consumed: number[];
  draws: DrawSpec[];
}

function summarize(id: string, batch: EntropyBatch): EntropyBatchSummary {
  return {
    id,
    provider: batch.provider,
    fetchedAt: batch.fetchedAt,
    bytes: batch.bytes.length,
    proof: batch.proof,
  };
}

/**
 * A pool of random bytes exposed as the table core's synchronous `Rng`, with every draw made
 * inside `withDraw` attributed (bytes, draw sequence, batch) so a table can publish it.
 *
 * Pools are only allowed over *local* generators (`fetchSync`, i.e. this device's CSPRNG).
 * Pre-fetching from an external oracle would let the host — who is also a player — read the
 * bytes before they are used and know the next deal; external sources are consumed just in
 * time by `TableServerOptions.entropy` instead. For local randomness peeking is meaningless
 * (the host's own generator is not evidence of anything), so the pool exists purely to keep
 * the same attribution/derivation record format for tables that do not use an oracle.
 */
export function createEntropyPool(opts: EntropyPoolOptions): EntropyPool {
  const provider = opts.provider;
  if (typeof provider.fetchSync !== 'function') {
    throw new EntropyError(
      'unsupported',
      `only local generators can be pooled; use TableServerOptions.entropy for ${provider.id}`,
    );
  }
  const fallback = opts.fallback ?? cryptoProvider();
  if (typeof fallback.fetchSync !== 'function') {
    throw new EntropyError('unsupported', 'the fallback provider must implement fetchSync');
  }
  const lowWater = opts.lowWater ?? 256;
  const batchSize = opts.batch ?? 1024;
  const maxRecords = opts.maxRecords ?? 5000;
  const retryMs = opts.retryMs ?? 2000;
  const now = opts.now ?? Date.now;
  const ctx: FetchContext = { purpose: opts.purpose ?? 'table', tableId: opts.tableId };
  const emit = (e: EntropyEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* listeners must not break the pool */
    }
  };

  const chunks: Chunk[] = [];
  const batches: EntropyBatchSummary[] = [];
  const records: EntropyRecord[] = [];
  let batchCounter = 0;
  let inflight: Promise<boolean> | null = null;
  let notBefore = 0;
  let closed = false;
  let current: DrawContext | null = null;

  const available = (): number => chunks.reduce((n, c) => n + (c.bytes.length - c.offset), 0);

  const refill = (): Promise<boolean> => {
    if (inflight) return inflight;
    if (closed) return Promise.resolve(false);
    inflight = (async () => {
      emit({ type: 'refill-start', bytes: batchSize });
      try {
        const batch = await provider.fetch(batchSize, ctx);
        if (!(batch.bytes instanceof Uint8Array) || batch.bytes.length === 0) {
          throw new EntropyError('bad-response', 'provider returned no bytes');
        }
        const id = `b${++batchCounter}`;
        chunks.push({ id, bytes: batch.bytes, offset: 0 });
        const summary = summarize(id, batch);
        batches.push(summary);
        emit({ type: 'refill-ok', batch: summary });
        return true;
      } catch (e) {
        notBefore = now() + retryMs;
        emit({ type: 'refill-error', error: e as Error });
        return false;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const maybeRefill = () => {
    if (closed || inflight || available() >= lowWater) return;
    if (now() < notBefore) return;
    void refill();
  };

  /** Take exactly `n` bytes: from the pool while it lasts, then from the fallback. */
  const take = (n: number, label: string): Uint8Array => {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n && chunks.length > 0) {
      const chunk = chunks[0]!;
      const remaining = chunk.bytes.length - chunk.offset;
      const count = Math.min(remaining, n - filled);
      out.set(chunk.bytes.subarray(chunk.offset, chunk.offset + count), filled);
      chunk.offset += count;
      filled += count;
      if (current && !current.batches.includes(chunk.id)) current.batches.push(chunk.id);
      if (chunk.offset >= chunk.bytes.length) chunks.shift();
    }
    if (filled < n) {
      const missing = n - filled;
      const fb = fallback.fetchSync!(missing, ctx);
      out.set(fb.bytes.subarray(0, missing), filled);
      if (current) current.fallback = true;
      emit({ type: 'fallback', label, bytes: missing });
    }
    if (current) {
      current.bytesUsed += n;
      for (const b of out) current.consumed.push(b);
    }
    maybeRefill();
    return out;
  };

  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`rng.int needs a positive integer bound, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) {
      current?.draws.push({ n: 1, value: 0 });
      return 0;
    }
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const label = current?.label ?? 'unlabelled';
    for (;;) {
      const b = take(4, label);
      const v = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
      if (v < limit) {
        const value = v % maxExclusive;
        current?.draws.push({ n: maxExclusive, value });
        return value;
      }
    }
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  const rng: Rng = { int, shuffle };

  const pool: EntropyPool = {
    provider: provider.id,
    int,
    shuffle,
    withDraw<T>(label: string, fn: (rng: Rng) => T): { value: T; record: EntropyRecord | null } {
      if (current) throw new Error(`nested draw "${label}" inside "${current.label}"`);
      const done: DrawContext = {
        label,
        bytesUsed: 0,
        batches: [],
        fallback: false,
        consumed: [],
        draws: [],
      };
      current = done;
      let value: T;
      try {
        value = fn(rng);
      } finally {
        current = null;
      }
      if (done.bytesUsed === 0) return { value, record: null };
      const record: EntropyRecord = {
        label,
        provider: provider.id,
        bytes: bytesToHex(Uint8Array.from(done.consumed)),
        bytesUsed: done.bytesUsed,
        draws: done.draws,
        sources: [],
        batches: done.batches,
        fallback: done.fallback,
      };
      records.push(record);
      if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
      return { value, record };
    },
    available,
    refill,
    async ready(): Promise<boolean> {
      if (available() >= lowWater) return true;
      const ok = await refill();
      return ok && available() >= lowWater;
    },
    audit: () => ({ batches: batches.slice(), records: records.slice() }),
    close: () => {
      closed = true;
    },
  };
  // Start filling right away so the first draws come from the provider when it is quick.
  void refill();
  return pool;
}
