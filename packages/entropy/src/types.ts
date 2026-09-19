import type { EntropyBatchSummary, EntropyProof, EntropyRecord } from '@bgf/protocol';
import type { EntropyDraw, EntropySource } from '@bgf/table';

export type { EntropyBatchSummary, EntropyProof, EntropyRecord, EntropyDraw, EntropySource };

/** Why a fetch failed. */
export type EntropyErrorCode = 'quota' | 'network' | 'auth' | 'bad-response' | 'unsupported';

export class EntropyError extends Error {
  constructor(
    public readonly code: EntropyErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EntropyError';
  }
}

export interface FetchContext {
  /** What the bytes are for (free text recorded with the proof, e.g. `table`). */
  purpose: string;
  /** The table the bytes are for. */
  tableId: string;
}

/** A batch of random bytes with the proof that they came from where the provider says. */
export interface EntropyBatch extends EntropyDraw {
  provider: string;
}

/**
 * A source of random bytes. `draw`/`fetch` go to the network and are called *just in time* by
 * a table (see `TableServerOptions.entropy`); `fetchSync`, present only for local generators,
 * returns immediately and is what makes a provider poolable.
 */
export interface EntropyProvider extends EntropySource {
  readonly name: string;
  fetch(bytes: number, ctx: FetchContext): Promise<EntropyBatch>;
  fetchSync?(bytes: number, ctx: FetchContext): EntropyBatch;
}

/** Turn a `fetch` into the `draw` a table calls. */
export function drawFromFetch(
  fetch: (bytes: number, ctx: FetchContext) => Promise<EntropyBatch>,
): EntropySource['draw'] {
  return (bytes, ctx) =>
    fetch(bytes, { purpose: `${ctx.purpose}:${ctx.label}`, tableId: ctx.tableId });
}

/** Minimal `fetch` shape so providers can be tested without the network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new EntropyError('unsupported', 'fetch is not available in this environment');
  }
  return f as FetchLike;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new EntropyError('bad-response', 'expected a hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
