import { describe, expect, it, vi } from 'vitest';
import {
  DRAND_QUICKNET_CHAIN,
  EntropyError,
  bytesToHex,
  cryptoProvider,
  drandContext,
  drandProvider,
  expandDrand,
  randomOrgProvider,
  verifyDrand,
  verifyRandomOrg,
} from '../src/index.js';

const ctx = { purpose: 'test', tableId: 't1' };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('cryptoProvider', () => {
  it('returns the requested number of bytes synchronously and asynchronously with no proof', async () => {
    const p = cryptoProvider();
    const a = p.fetchSync!(70_000, ctx);
    expect(a.bytes.length).toBe(70_000);
    expect(a.proof).toEqual({ kind: 'none' });
    const b = await p.fetch(16, ctx);
    expect(b.bytes.length).toBe(16);
    expect(bytesToHex(a.bytes.subarray(0, 16))).not.toBe(bytesToHex(b.bytes));
  });
});

describe('randomOrgProvider', () => {
  const random = {
    method: 'generateSignedIntegers',
    hashedApiKey: 'abc',
    n: 4,
    min: 0,
    max: 255,
    replacement: true,
    base: 10,
    data: [1, 2, 3, 255],
    completionTime: '2026-09-12 00:00:00Z',
    serialNumber: 42,
  };

  it('requests signed integers 0..255 and keeps the signed object as the proof', async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const req = JSON.parse(init!.body!) as { method: string; params: Record<string, unknown> };
      expect(req.method).toBe('generateSignedIntegers');
      expect(req.params).toMatchObject({
        apiKey: 'KEY',
        n: 4,
        min: 0,
        max: 255,
        replacement: true,
        base: 10,
      });
      return jsonResponse({
        jsonrpc: '2.0',
        result: { random, signature: 'SIG', bitsLeft: 1 },
        id: 1,
      });
    });
    const p = randomOrgProvider({ apiKey: 'KEY', fetch, now: () => 7 });
    const batch = await p.fetch(4, ctx);
    expect(Array.from(batch.bytes)).toEqual([1, 2, 3, 255]);
    expect(batch.proof).toEqual({
      kind: 'random.org-signed',
      random,
      signature: 'SIG',
      serialNumber: 42,
    });
    expect(batch.fetchedAt).toBe(7);
    expect(batch.provider).toBe('random.org');
  });

  it('maps quota, auth, network and malformed answers to error codes', async () => {
    const quota = randomOrgProvider({
      apiKey: 'K',
      fetch: vi.fn(async () =>
        jsonResponse({ error: { code: 402, message: 'You have reached your daily allowance' } }),
      ),
    });
    await expect(quota.fetch(4, ctx)).rejects.toMatchObject({ code: 'quota' });
    const auth = randomOrgProvider({
      apiKey: 'K',
      fetch: vi.fn(async () =>
        jsonResponse({ error: { code: 401, message: 'The API key does not exist' } }),
      ),
    });
    await expect(auth.fetch(4, ctx)).rejects.toMatchObject({ code: 'auth' });
    const http = randomOrgProvider({
      apiKey: 'K',
      fetch: vi.fn(async () => jsonResponse({}, 503)),
    });
    await expect(http.fetch(4, ctx)).rejects.toMatchObject({ code: 'network' });
    const thrown = randomOrgProvider({
      apiKey: 'K',
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(thrown.fetch(4, ctx)).rejects.toMatchObject({ code: 'network' });
    const bad = randomOrgProvider({
      apiKey: 'K',
      fetch: vi.fn(async () =>
        jsonResponse({ result: { random: { data: [1, 999] }, signature: 'x' } }),
      ),
    });
    await expect(bad.fetch(2, ctx)).rejects.toBeInstanceOf(EntropyError);
    await expect(bad.fetch(2, ctx)).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('verifies a signed proof through verifySignature', async () => {
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const req = JSON.parse(init!.body!) as {
        method: string;
        params: { random: unknown; signature: string };
      };
      expect(req.method).toBe('verifySignature');
      return jsonResponse({ result: { authenticity: req.params.signature === 'SIG' } });
    });
    await expect(
      verifyRandomOrg({ kind: 'random.org-signed', random, signature: 'SIG' }, { fetch }),
    ).resolves.toBe(true);
    await expect(
      verifyRandomOrg({ kind: 'random.org-signed', random, signature: 'FORGED' }, { fetch }),
    ).resolves.toBe(false);
    await expect(verifyRandomOrg({ kind: 'none' }, { fetch })).resolves.toBe(false);
  });
});

describe('drandProvider', () => {
  const randomness = 'a'.repeat(64);
  const round = { round: 1234, randomness, signature: 'deadbeef' };

  it('fetches the latest round and expands it deterministically', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`https://api.drand.sh/${DRAND_QUICKNET_CHAIN}/public/latest`);
      return jsonResponse(round);
    });
    const p = drandProvider({ fetch, now: () => 9 });
    const batch = await p.fetch(64, ctx);
    expect(batch.bytes.length).toBe(64);
    expect(batch.proof).toEqual({
      kind: 'drand',
      round: 1234,
      randomness,
      signature: 'deadbeef',
      chainHash: DRAND_QUICKNET_CHAIN,
      context: drandContext(ctx, 1234),
    });
    const again = await expandDrand(randomness, DRAND_QUICKNET_CHAIN, drandContext(ctx, 1234), 64);
    expect(bytesToHex(again)).toBe(bytesToHex(batch.bytes));
    const other = await expandDrand(
      randomness,
      DRAND_QUICKNET_CHAIN,
      drandContext({ ...ctx, tableId: 't2' }, 1234),
      64,
    );
    expect(bytesToHex(other)).not.toBe(bytesToHex(batch.bytes));
  });

  it('rejects malformed rounds and HTTP errors', async () => {
    const bad = drandProvider({ fetch: vi.fn(async () => jsonResponse({ round: 'x' })) });
    await expect(bad.fetch(8, ctx)).rejects.toMatchObject({ code: 'bad-response' });
    const http = drandProvider({ fetch: vi.fn(async () => jsonResponse({}, 500)) });
    await expect(http.fetch(8, ctx)).rejects.toMatchObject({ code: 'network' });
  });

  it('verifyDrand re-fetches the round and compares', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/public/1234') ? jsonResponse(round) : jsonResponse({}, 404),
    );
    const proof = {
      kind: 'drand' as const,
      round: 1234,
      randomness,
      signature: 'deadbeef',
      chainHash: DRAND_QUICKNET_CHAIN,
    };
    await expect(verifyDrand(proof, { fetch })).resolves.toBe(true);
    await expect(verifyDrand({ ...proof, signature: 'other' }, { fetch })).resolves.toBe(false);
    await expect(verifyDrand({ ...proof, round: 1 }, { fetch })).rejects.toMatchObject({
      code: 'network',
    });
  });
});
