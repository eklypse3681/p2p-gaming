import type { EntropyRecord } from '@bgf/protocol';
import type { BeaconSource, DrawContext, EntropyDraw } from '@bgf/table';
import { beaconContext, createByteRng, bytesToHex as hexOf } from '@bgf/table';
import type { EntropyBatch, EntropyProof, EntropyProvider, FetchLike } from './types.js';
import {
  EntropyError,
  bytesToHex,
  defaultFetch,
  drawFromFetch,
  hexToBytes,
  utf8,
} from './types.js';

/** League of Entropy "quicknet" (3 s rounds, unchained). */
export const DRAND_QUICKNET_CHAIN =
  '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const DRAND_BASE_URL = 'https://api.drand.sh';
/** HKDF-SHA-256 can expand at most 255 × 32 bytes from one round. */
export const DRAND_MAX_BYTES = 255 * 32;

export interface DrandOptions {
  chainHash?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Chain schedule; fetched from `/{chain}/info` when omitted. */
  schedule?: { periodMs: number; genesisMs: number };
  /** Beacon mode: how often to re-ask for a round that is not published yet. Default 1000 ms. */
  pollMs?: number;
  /** Test hook: wait function (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** League of Entropy quicknet: 3 s period, genesis 2023-08-23T15:49:27Z. */
export const DRAND_QUICKNET_SCHEDULE = { periodMs: 3000, genesisMs: 1692803367 * 1000 };

/** A drand provider is also a `BeaconSource`: it can target a specific (future) round. */
export interface DrandProvider extends EntropyProvider, BeaconSource {}

interface DrandRound {
  round: number;
  randomness: string;
  signature: string;
}

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new EntropyError('unsupported', 'WebCrypto (crypto.subtle) is not available');
  return s;
}

function parseRound(raw: unknown): DrandRound {
  const r = raw as Partial<DrandRound> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    !Number.isInteger(r.round) ||
    typeof r.randomness !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(r.randomness) ||
    typeof r.signature !== 'string'
  ) {
    throw new EntropyError('bad-response', 'drand answered with an unexpected round shape');
  }
  return {
    round: r.round as number,
    randomness: r.randomness.toLowerCase(),
    signature: r.signature,
  };
}

async function getRound(fetch: FetchLike, url: string): Promise<DrandRound> {
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new EntropyError('network', `drand request failed: ${(e as Error).message}`, e);
  }
  if (!response.ok) throw new EntropyError('network', `drand answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    throw new EntropyError('bad-response', 'drand answered with something that is not JSON', e);
  }
  return parseRound(body);
}

/** The context string mixed into the expansion so different tables never share bytes. */
export function drandContext(ctx: { purpose: string; tableId: string }, round: number): string {
  return `bgf-entropy/v1|${ctx.purpose}|${ctx.tableId}|round:${round}`;
}

/** Deterministically expand a round's randomness to `bytes` bytes (HKDF-SHA-256). */
export async function expandDrand(
  randomnessHex: string,
  chainHash: string,
  context: string,
  bytes: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > DRAND_MAX_BYTES) {
    throw new RangeError(`bytes must be in 1..${DRAND_MAX_BYTES}`);
  }
  const s = subtle();
  const key = await s.importKey('raw', hexToBytes(randomnessHex) as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const out = await s.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: hexToBytes(chainHash) as BufferSource,
      info: utf8(context) as BufferSource,
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(out);
}

/**
 * The drand beacon: a public, unpredictable-until-published random value every few seconds,
 * signed by the League of Entropy. The host cannot influence the value; anyone can re-fetch
 * the round and check it matches. As a plain `EntropySource` (per-draw mode) it proves *what*
 * was used, not that the host could not wait for a round it liked; as a `BeaconSource` (beacon
 * mode) the table commits to the *next* round before it exists, closing that gap.
 */
export function drandProvider(opts: DrandOptions = {}): DrandProvider {
  const chainHash = opts.chainHash ?? DRAND_QUICKNET_CHAIN;
  const baseUrl = (opts.baseUrl ?? DRAND_BASE_URL).replace(/\/$/, '');
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let schedule: { periodMs: number; genesisMs: number } | null = opts.schedule ?? null;
  const toBatch = async (
    round: DrandRound,
    context: string,
    bytes: number,
  ): Promise<EntropyBatch> => {
    const out = await expandDrand(
      round.randomness,
      chainHash,
      context,
      Math.min(bytes, DRAND_MAX_BYTES),
    );
    const proof: EntropyProof = {
      kind: 'drand',
      round: round.round,
      randomness: round.randomness,
      signature: round.signature,
      chainHash,
      context,
    };
    return { provider: 'drand', bytes: out, proof, fetchedAt: now() };
  };
  const fetch = async (
    bytes: number,
    ctx: { purpose: string; tableId: string },
  ): Promise<EntropyBatch> => {
    const fetch = opts.fetch ?? defaultFetch();
    const round = await getRound(fetch, `${baseUrl}/${chainHash}/public/latest`);
    return toBatch(round, drandContext(ctx, round.round), bytes);
  };
  return {
    id: 'drand',
    name: 'drand beacon (League of Entropy)',
    chainHash,
    fetch,
    draw: drawFromFetch(fetch),
    async schedule() {
      if (schedule) return schedule;
      if (chainHash === DRAND_QUICKNET_CHAIN && !opts.baseUrl) {
        schedule = DRAND_QUICKNET_SCHEDULE;
        return schedule;
      }
      const f = opts.fetch ?? defaultFetch();
      let response;
      try {
        response = await f(`${baseUrl}/${chainHash}/info`);
      } catch (e) {
        throw new EntropyError('network', `drand info request failed: ${(e as Error).message}`, e);
      }
      if (!response.ok) throw new EntropyError('network', `drand answered HTTP ${response.status}`);
      const info = (await response.json()) as { period?: unknown; genesis_time?: unknown };
      if (typeof info.period !== 'number' || typeof info.genesis_time !== 'number') {
        throw new EntropyError('bad-response', 'drand chain info has no period/genesis_time');
      }
      schedule = { periodMs: info.period * 1000, genesisMs: info.genesis_time * 1000 };
      return schedule;
    },
    roundAt(nowMs, sch) {
      if (nowMs < sch.genesisMs) return 0;
      return Math.floor((nowMs - sch.genesisMs) / sch.periodMs) + 1;
    },
    async drawRound(round, bytes, ctx: DrawContext & { context: string; timeoutMs: number }) {
      const f = opts.fetch ?? defaultFetch();
      const deadline = now() + ctx.timeoutMs;
      for (;;) {
        try {
          const r = await getRound(f, `${baseUrl}/${chainHash}/public/${round}`);
          if (r.round !== round) {
            throw new EntropyError('bad-response', `asked for round ${round}, got ${r.round}`);
          }
          const batch = await toBatch(r, ctx.context, bytes);
          const draw: EntropyDraw = {
            bytes: batch.bytes,
            proof: batch.proof,
            fetchedAt: batch.fetchedAt,
          };
          return draw;
        } catch (e) {
          // Not published yet (404) or a transient failure: keep asking until the deadline.
          if (now() >= deadline) {
            throw new EntropyError(
              'network',
              `drand round ${round} was not available within ${ctx.timeoutMs} ms`,
              e,
            );
          }
          await sleep(pollMs);
        }
      }
    },
  };
}

/**
 * Verify a beacon-bound record: re-fetch the round it was bound to, re-expand the bytes with
 * the recorded context, and check the draw values re-derive. Also reports whether the binding
 * was made before the round existed (needs the chain schedule).
 */
export async function verifyBeaconRecord(
  record: EntropyRecord,
  opts: {
    baseUrl?: string;
    fetch?: FetchLike;
    schedule?: { periodMs: number; genesisMs: number };
  } = {},
): Promise<{
  ok: boolean;
  round: boolean;
  bytes: boolean;
  draws: boolean;
  committedInAdvance: boolean | null;
}> {
  const binding = record.beacon;
  const source = record.sources[0];
  if (!binding || !source || source.proof.kind !== 'drand') {
    return { ok: false, round: false, bytes: false, draws: false, committedInAdvance: null };
  }
  const proof = source.proof;
  const roundOk =
    proof.round === binding.round &&
    proof.chainHash === binding.chainHash &&
    (await verifyDrand(proof, { baseUrl: opts.baseUrl, fetch: opts.fetch }));
  const context = beaconContext(tableIdFromContext(proof.context ?? ''), binding.counter);
  const expected = proof.context === context;
  const expanded = await expandDrand(
    proof.randomness,
    proof.chainHash,
    proof.context ?? context,
    Math.max(record.bytesUsed, 1),
  );
  const bytesOk =
    expected && hexOf(expanded.subarray(0, record.bytesUsed)) === record.bytes.toLowerCase();
  let drawsOk = true;
  try {
    const rng = createByteRng(expanded);
    for (const d of record.draws) if (rng.int(d.n) !== d.value) drawsOk = false;
  } catch {
    drawsOk = false;
  }
  let committedInAdvance: boolean | null = null;
  if (opts.schedule) {
    const publishedAt = opts.schedule.genesisMs + (binding.round - 1) * opts.schedule.periodMs;
    committedInAdvance = binding.committedAt < publishedAt;
  }
  return {
    ok: roundOk && bytesOk && drawsOk,
    round: roundOk,
    bytes: bytesOk,
    draws: drawsOk,
    committedInAdvance,
  };
}

function tableIdFromContext(context: string): string {
  // beaconContext(tableId, counter) = `bgf-beacon/v1|<tableId>|draw:<n>`
  const parts = context.split('|');
  return parts.length >= 3 ? parts.slice(1, -1).join('|') : '';
}

/**
 * Re-fetch the round named in a drand proof and compare randomness and signature. This checks
 * the proof against the beacon's public record; it does not verify the BLS signature locally
 * (future work).
 */
export async function verifyDrand(
  proof: EntropyProof,
  opts: { baseUrl?: string; fetch?: FetchLike } = {},
): Promise<boolean> {
  if (proof.kind !== 'drand') return false;
  const baseUrl = (opts.baseUrl ?? DRAND_BASE_URL).replace(/\/$/, '');
  const fetch = opts.fetch ?? defaultFetch();
  const round = await getRound(fetch, `${baseUrl}/${proof.chainHash}/public/${proof.round}`);
  return (
    round.round === proof.round &&
    round.randomness === proof.randomness.toLowerCase() &&
    round.signature === proof.signature
  );
}

export { bytesToHex };
