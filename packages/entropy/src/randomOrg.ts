import type { EntropyBatch, EntropyProof, EntropyProvider, FetchLike } from './types.js';
import { EntropyError, defaultFetch, drawFromFetch } from './types.js';

export const RANDOM_ORG_ENDPOINT = 'https://api.random.org/json-rpc/4/invoke';
/** random.org caps `n` per signed request. */
export const RANDOM_ORG_MAX_PER_REQUEST = 10_000;

export interface RandomOrgOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: FetchLike;
  now?: () => number;
}

interface JsonRpcResponse {
  result?: {
    random?: { data?: unknown; serialNumber?: number } & Record<string, unknown>;
    signature?: string;
    bitsLeft?: number;
    requestsLeft?: number;
    authenticity?: boolean;
  };
  error?: { code?: number; message?: string };
}

let rpcId = 0;

async function rpc(
  fetch: FetchLike,
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++rpcId }),
    });
  } catch (e) {
    throw new EntropyError('network', `random.org request failed: ${(e as Error).message}`, e);
  }
  if (!response.ok) {
    throw new EntropyError('network', `random.org answered HTTP ${response.status}`);
  }
  let body: JsonRpcResponse;
  try {
    body = (await response.json()) as JsonRpcResponse;
  } catch (e) {
    throw new EntropyError(
      'bad-response',
      'random.org answered with something that is not JSON',
      e,
    );
  }
  if (body.error) {
    const code = body.error.code ?? 0;
    const message = body.error.message ?? 'unknown error';
    if (code === 402 || /allowance|quota|bits|requests? left|exhausted/i.test(message)) {
      throw new EntropyError('quota', `random.org quota: ${message}`);
    }
    if (code === 400 || code === 401 || code === 403 || /api key/i.test(message)) {
      throw new EntropyError('auth', `random.org refused the API key: ${message}`);
    }
    throw new EntropyError('bad-response', `random.org error ${code}: ${message}`);
  }
  if (!body.result) throw new EntropyError('bad-response', 'random.org answered without a result');
  return body;
}

/**
 * random.org's signed API: every batch comes with a signature over the `random` object that
 * anyone can check later with `verifyRandomOrg` (no API key needed). The key never leaves the
 * host's browser. Free keys are limited (bits and requests per day); the pool's low-water mark
 * keeps requests infrequent.
 */
export function randomOrgProvider(opts: RandomOrgOptions): EntropyProvider {
  const endpoint = opts.endpoint ?? RANDOM_ORG_ENDPOINT;
  const now = opts.now ?? Date.now;
  const fetchOne = async (n: number, ctx: { purpose: string; tableId: string }) => {
    const fetch = opts.fetch ?? defaultFetch();
    const body = await rpc(fetch, endpoint, 'generateSignedIntegers', {
      apiKey: opts.apiKey,
      n,
      min: 0,
      max: 255,
      replacement: true,
      base: 10,
      userData: { purpose: ctx.purpose, tableId: ctx.tableId },
    });
    const random = body.result!.random;
    const data = random?.data;
    const signature = body.result!.signature;
    if (!Array.isArray(data) || data.length !== n || typeof signature !== 'string') {
      throw new EntropyError('bad-response', 'random.org result is missing data or signature');
    }
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) {
        throw new EntropyError('bad-response', `random.org value out of range: ${String(v)}`);
      }
      bytes[i] = v as number;
    }
    const serialNumber = typeof random?.serialNumber === 'number' ? random.serialNumber : undefined;
    const proof: EntropyProof = {
      kind: 'random.org-signed',
      random,
      signature,
      ...(serialNumber !== undefined ? { serialNumber } : {}),
    };
    const batch: EntropyBatch = { provider: 'random.org', bytes, proof, fetchedAt: now() };
    if (serialNumber !== undefined) batch.serialNumber = serialNumber;
    if (typeof body.result!.bitsLeft === 'number') batch.bitsLeft = body.result!.bitsLeft;
    if (typeof body.result!.requestsLeft === 'number')
      batch.requestsLeft = body.result!.requestsLeft;
    return batch;
  };
  const fetch = async (
    bytes: number,
    ctx: { purpose: string; tableId: string },
  ): Promise<EntropyBatch> => {
    if (!Number.isInteger(bytes) || bytes <= 0) throw new RangeError('bytes must be positive');
    // One signed request per draw = one proof per draw; never more than the API allows.
    return fetchOne(Math.min(bytes, RANDOM_ORG_MAX_PER_REQUEST), ctx);
  };
  return { id: 'random.org', name: 'random.org (signed)', fetch, draw: drawFromFetch(fetch) };
}

/** The bytes a random.org signed proof attests to (its `random.data`), or null if malformed. */
export function bytesFromRandomOrgProof(proof: EntropyProof): Uint8Array | null {
  if (proof.kind !== 'random.org-signed') return null;
  const data = (proof.random as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) return null;
    out[i] = v as number;
  }
  return out;
}

/** Ask random.org whether a signed `random` object and its signature are authentic. */
export async function verifyRandomOrg(
  proof: EntropyProof,
  opts: { endpoint?: string; fetch?: FetchLike } = {},
): Promise<boolean> {
  if (proof.kind !== 'random.org-signed') return false;
  const fetch = opts.fetch ?? defaultFetch();
  const body = await rpc(fetch, opts.endpoint ?? RANDOM_ORG_ENDPOINT, 'verifySignature', {
    random: proof.random,
    signature: proof.signature,
  });
  return body.result?.authenticity === true;
}
