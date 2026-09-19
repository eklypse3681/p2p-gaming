import { describe, expect, it, vi } from 'vitest';
import type { EntropyRecord } from '@bgf/protocol';
import {
  bytesToHex,
  createByteRng,
  DRAND_QUICKNET_CHAIN,
  drandContext,
  expandDrand,
  verifyEntropyRecord,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Build a record the way a table does: run a draw over the bytes, keep bytes + draws + proof. */
function recordFor(
  bytes: Uint8Array,
  proof: EntropyRecord['sources'][number]['proof'],
  extra: Partial<EntropyRecord['sources'][number]> = {},
): { record: EntropyRecord; dice: number[] } {
  const rng = createByteRng(bytes);
  const dice = [rng.int(6) + 1, rng.int(6) + 1];
  const record: EntropyRecord = {
    label: 'roll',
    provider: proof.kind === 'drand' ? 'drand' : 'random.org',
    bytes: bytesToHex(bytes.subarray(0, rng.used())),
    bytesUsed: rng.used(),
    draws: rng.draws(),
    sources: [{ proof, bytes: bytesToHex(bytes), fetchedAt: 1, ...extra }],
    fallback: false,
  };
  return { record, dice };
}

describe('verifyEntropyRecord', () => {
  it('accepts a genuine random.org record and rejects tampered bytes or values', async () => {
    const data = Array.from({ length: 64 }, (_, i) => (i * 53 + 11) & 0xff);
    const bytes = Uint8Array.from(data);
    const proof = {
      kind: 'random.org-signed' as const,
      random: { data },
      signature: 'SIG',
      serialNumber: 9,
    };
    const fetch = vi.fn(async (_u: string, init?: { body?: string }) => {
      const req = JSON.parse(init!.body!) as { params: { signature: string } };
      return jsonResponse({ result: { authenticity: req.params.signature === 'SIG' } });
    });
    const { record, dice } = recordFor(bytes, proof, { serialNumber: 9 });
    const ok = await verifyEntropyRecord(record, { fetch });
    expect(ok).toMatchObject({ ok: true, proofs: true, bytes: true, draws: true, fallback: false });
    expect(record.draws.map((d) => d.value + 1)).toEqual(dice);

    // A host that swapped the dice after the fact: draws no longer derive from the bytes.
    const forgedValues: EntropyRecord = {
      ...record,
      draws: record.draws.map((d) => ({ ...d, value: (d.value + 1) % 6 })),
    };
    expect((await verifyEntropyRecord(forgedValues, { fetch })).draws).toBe(false);
    // A host that swapped the bytes: the proof still verifies but does not attest to these bytes.
    const forgedBytes: EntropyRecord = {
      ...record,
      bytes: 'ff'.repeat(record.bytesUsed),
      sources: [{ ...record.sources[0]!, bytes: 'ff'.repeat(64) }],
    };
    const r2 = await verifyEntropyRecord(forgedBytes, { fetch });
    expect(r2.proofs).toBe(true);
    expect(r2.bytes).toBe(false);
    expect(r2.ok).toBe(false);
    // A forged signature.
    const forgedSig: EntropyRecord = {
      ...record,
      sources: [{ ...record.sources[0]!, proof: { ...proof, signature: 'NOPE' } }],
    };
    expect((await verifyEntropyRecord(forgedSig, { fetch })).proofs).toBe(false);
  });

  it('accepts a drand record by re-fetching the round and re-expanding the bytes', async () => {
    const randomness = 'c'.repeat(64);
    const context = drandContext({ purpose: 'table:roll', tableId: 'T' }, 42);
    const bytes = await expandDrand(randomness, DRAND_QUICKNET_CHAIN, context, 64);
    const proof = {
      kind: 'drand' as const,
      round: 42,
      randomness,
      signature: 'sig42',
      chainHash: DRAND_QUICKNET_CHAIN,
      context,
    };
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/public/42')
        ? jsonResponse({ round: 42, randomness, signature: 'sig42' })
        : jsonResponse({}, 404),
    );
    const { record } = recordFor(bytes, proof);
    expect(await verifyEntropyRecord(record, { fetch })).toMatchObject({ ok: true });
    const wrongRound: EntropyRecord = {
      ...record,
      sources: [{ ...record.sources[0]!, proof: { ...proof, round: 43 } }],
    };
    await expect(verifyEntropyRecord(wrongRound, { fetch })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('never marks a fallback record ok', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    const { record } = recordFor(bytes, { kind: 'none' });
    const flagged: EntropyRecord = { ...record, fallback: true };
    const r = await verifyEntropyRecord(flagged, { fetch: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.fallback).toBe(true);
    expect(r.draws).toBe(true);
  });
});
