import { describe, expect, it, vi } from 'vitest';
import type { EntropyRecord } from '@bgf/protocol';
import type { FairnessSource, Verifiers } from './fairness';
import { auditJson, fairnessRows, fairnessSummary, verdictFor, verifyRow } from './fairness';

function record(over: Partial<EntropyRecord> = {}): EntropyRecord {
  return {
    label: 'roll',
    provider: 'random.org',
    bytes: 'aabb',
    bytesUsed: 2,
    draws: [{ n: 6, value: 3 }],
    sources: [
      {
        proof: { kind: 'random.org-signed', random: {}, signature: 's', serialNumber: 7 },
        bytes: 'aabb',
        fetchedAt: 1,
        serialNumber: 7,
        requestsLeft: 990,
      },
    ],
    fallback: false,
    ...over,
  };
}

const perDraw: FairnessSource = {
  id: 't1',
  randomness: { provider: 'random.org', mode: 'per-draw' },
  actionMeta: {
    2: { entropy: record() },
    5: {
      entropy: record({
        sources: [
          {
            ...record().sources[0]!,
            proof: { kind: 'random.org-signed', random: {}, signature: 's', serialNumber: 9 },
            serialNumber: 9,
            requestsLeft: 988,
          },
        ],
      }),
    },
  },
};

const verifiers: Verifiers = {
  record: vi.fn(async (r: EntropyRecord) => ({ ok: r.draws[0]!.value === 3 })),
  segment: vi.fn((_s: FairnessSource, index: number) => ({
    ok: index === 0,
    revealed: true,
    commitment: true,
    actions: [{ index: 1, ok: index === 0 }],
    reasons: [],
  })),
  beacon: vi.fn(async () => ({ ok: true })),
};

describe('fairness model', () => {
  it('lists draws oldest first with proof kinds, quota and serial gaps', () => {
    const rows = fairnessRows(perDraw);
    expect(rows.map((r) => r.index)).toEqual([2, 5]);
    expect(rows[0]!.proofKind).toBe('random.org-signed');
    expect(rows[0]!.values).toEqual([3]);
    const s = fairnessSummary(perDraw);
    expect(s.provider).toBe('random.org');
    expect(s.mode).toBe('per-draw');
    expect(s.verifiable).toBe(true);
    expect(s.requestsLeft).toBe(988);
    expect(s.serialGaps).toEqual([{ afterIndex: 0, from: 7, to: 9 }]);
    expect(s.drawCount).toBe(2);
  });

  it('verifies per-draw records through the record verifier', async () => {
    const rows = fairnessRows(perDraw);
    expect(await verifyRow(perDraw, rows[0]!, verifiers)).toBe('ok');
    const bad = { ...rows[1]!, record: record({ draws: [{ n: 6, value: 4 }] }) };
    expect(await verifyRow(perDraw, bad, verifiers)).toBe('fail');
  });

  it('this-device and fallback draws are unverifiable', async () => {
    const local: FairnessSource = {
      id: 't2',
      randomness: { provider: 'crypto', mode: 'per-draw' },
      actionMeta: {
        0: {
          entropy: record({
            provider: 'crypto',
            sources: [{ proof: { kind: 'none' }, bytes: 'aabb', fetchedAt: 1 }],
          }),
        },
      },
    };
    const rows = fairnessRows(local);
    expect(await verifyRow(local, rows[0]!, verifiers)).toBe('unverifiable');
    expect(fairnessSummary(local).verifiable).toBe(false);
    expect(verdictFor(['unverifiable'], fairnessSummary(local))).toMatch(/not verifiable/);
    const fb = { ...rows[0]!, record: record({ fallback: true }) };
    expect(await verifyRow(perDraw, fb, verifiers)).toBe('unverifiable');
  });

  it('seeded rows are pending until the segment is revealed, then verified per action', async () => {
    const seeded: FairnessSource = {
      id: 't3',
      randomness: { provider: 'drand', mode: 'seeded' },
      actionMeta: {
        1: { entropy: record({ provider: 'drand', sources: [], segment: 0, drawIndex: 0 }) },
        4: { entropy: record({ provider: 'drand', sources: [], segment: 1, drawIndex: 0 }) },
      },
      entropyAudit: {
        batches: [],
        mode: 'seeded',
        segments: [
          { index: 0, commitment: 'c0', from: 0, to: 2, committedAt: 1, seed: 'aa' },
          { index: 1, commitment: 'c1', from: 3, committedAt: 2 },
        ],
      },
    };
    const rows = fairnessRows(seeded);
    expect(await verifyRow(seeded, rows[0]!, verifiers)).toBe('ok');
    expect(await verifyRow(seeded, rows[1]!, verifiers)).toBe('pending');
    const s = fairnessSummary(seeded);
    expect(s.segments.map((x) => x.revealed)).toEqual([true, false]);
    expect(verdictFor(['ok', 'pending'], s)).toBe('1 verified · 1 awaiting reveal');
  });

  it('beacon rows use the beacon verifier and verdicts count outcomes', async () => {
    const beacon: FairnessSource = {
      id: 't4',
      randomness: { provider: 'drand', mode: 'beacon' },
      actionMeta: {
        0: {
          entropy: record({
            provider: 'drand',
            beacon: { counter: 0, chainHash: 'h', round: 10, committedAt: 1 },
          }),
        },
      },
    };
    const rows = fairnessRows(beacon);
    expect(await verifyRow(beacon, rows[0]!, verifiers)).toBe('ok');
    const s = fairnessSummary(beacon);
    expect(verdictFor(['idle'], s)).toBe('1 draw recorded · not verified yet');
    expect(verdictFor(['ok'], s)).toBe('All 1 draw verified');
    expect(verdictFor(['ok', 'fail'], s)).toBe('1 draw could not be verified');
  });

  it('exports a public audit document', () => {
    const doc = auditJson(perDraw, { gameId: 'backgammon', actions: [{ type: 'roll' }], seat: 0 });
    expect(doc).toMatchObject({
      format: 'p2p-gaming-audit',
      tableId: 't1',
      gameId: 'backgammon',
      seat: 0,
      randomness: { provider: 'random.org' },
    });
    expect((doc.actionMeta as Record<string, unknown>)['2']).toBeDefined();
  });
});
