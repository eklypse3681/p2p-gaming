import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EntropyRecord } from '@bgf/protocol';
import type { FairnessSource, Verifiers } from '../session/fairness';
import { FairnessPanel } from './FairnessPanel';

function record(over: Partial<EntropyRecord> = {}): EntropyRecord {
  return {
    label: 'roll',
    provider: 'random.org',
    bytes: 'aabb',
    bytesUsed: 2,
    draws: [{ n: 6, value: 3 }],
    sources: [
      {
        proof: { kind: 'random.org-signed', random: {}, signature: 's', serialNumber: 1 },
        bytes: 'aabb',
        fetchedAt: 1,
        serialNumber: 1,
        requestsLeft: 999,
      },
    ],
    fallback: false,
    ...over,
  };
}

const source: FairnessSource = {
  id: 'tbl',
  randomness: { provider: 'random.org', mode: 'per-draw' },
  actionMeta: {
    1: { entropy: record() },
    3: { entropy: record({ draws: [{ n: 6, value: 5 }] }) },
    4: { entropy: record({ fallback: true }) },
  },
};

describe('FairnessPanel', () => {
  let objectUrls: string[];
  beforeEach(() => {
    objectUrls = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      objectUrls.push(`blob:${b.size}`);
      (globalThis as { __lastBlob?: Blob }).__lastBlob = b;
      return `blob:${b.size}`;
    }) as never;
    URL.revokeObjectURL = vi.fn() as never;
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows source, mode, quota and per-row outcomes when verified', async () => {
    const verifiers: Verifiers = {
      record: vi.fn(async (r) => ({ ok: r.draws[0]!.value === 3 })),
      segment: vi.fn(),
      beacon: vi.fn(async () => ({ ok: true })),
    };
    const onClose = vi.fn();
    render(<FairnessPanel source={source} onClose={onClose} verifiers={verifiers} />);
    expect(screen.getByTestId('fairness-source')).toHaveTextContent('random.org');
    expect(screen.getByTestId('fairness-mode')).toHaveTextContent('Per draw');
    expect(screen.getByTestId('fairness-requests-left')).toHaveTextContent('999');
    expect(screen.getByTestId('fairness-verdict')).toHaveTextContent('3 draws recorded');
    await userEvent.click(screen.getByTestId('verify-all'));
    await waitFor(() =>
      expect(screen.getByTestId('fairness-row-1')).toHaveAttribute('data-verified', 'ok'),
    );
    expect(screen.getByTestId('fairness-row-3')).toHaveAttribute('data-verified', 'fail');
    expect(screen.getByTestId('fairness-row-4')).toHaveAttribute('data-verified', 'unverifiable');
    expect(screen.getByTestId('fairness-verdict')).toHaveTextContent(
      '1 draw could not be verified',
    );
    expect(verifiers.record).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByTestId('fairness-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('seeded: an open segment shows as committed and its rows as pending; download exports the audit', async () => {
    const seeded: FairnessSource = {
      id: 'tbl2',
      randomness: { provider: 'drand', mode: 'seeded' },
      actionMeta: { 2: { entropy: record({ provider: 'drand', sources: [], segment: 0 }) } },
      entropyAudit: {
        batches: [],
        mode: 'seeded',
        segments: [{ index: 0, commitment: 'abcdef0123456789', from: 0, committedAt: 1 }],
      },
    };
    const verifiers: Verifiers = {
      record: vi.fn(async () => ({ ok: true })),
      segment: vi.fn(),
      beacon: vi.fn(async () => ({ ok: true })),
    };
    render(
      <FairnessPanel
        source={seeded}
        onClose={() => {}}
        verifiers={verifiers}
        gameId="ofc"
        actions={[{ type: 'start' }]}
        seat={1}
      />,
    );
    expect(screen.getByTestId('fairness-segment')).toHaveTextContent('not revealed yet');
    expect(screen.getByTestId('fairness-segment-0')).toHaveAttribute('data-revealed', 'false');
    await userEvent.click(screen.getByTestId('verify-1' in {} ? 'x' : 'verify-2'));
    await waitFor(() =>
      expect(screen.getByTestId('fairness-row-2')).toHaveAttribute('data-verified', 'pending'),
    );
    expect(verifiers.segment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('download-audit'));
    const blob = (globalThis as { __lastBlob?: Blob }).__lastBlob!;
    const text = await blob.text();
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({
      format: 'p2p-gaming-audit',
      tableId: 'tbl2',
      gameId: 'ofc',
      seat: 1,
      randomness: { provider: 'drand', mode: 'seeded' },
    });
    expect(doc.entropyAudit.segments[0].commitment).toBe('abcdef0123456789');
    expect(doc.actions).toEqual([{ type: 'start' }]);
  });

  it('this-device tables say they are not verifiable and disable verify all', () => {
    const local: FairnessSource = {
      id: 'tbl3',
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
    render(<FairnessPanel source={local} onClose={() => {}} />);
    expect(screen.getByTestId('fairness-verdict')).toHaveTextContent(/not verifiable/);
    expect(screen.getByTestId('verify-all')).toBeDisabled();
  });
});
