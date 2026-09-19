import type { EntropyRecord, SeedSegment, TableSnapshot } from '@bgf/protocol';
import { createByteRng, hexToBytes, bytesToHex, concatBytes } from './entropy.js';
import { hkdfSha256, sha256, utf8Bytes } from './kdf.js';

/**
 * Seeded randomness (commit-and-reveal). Before any draw of a segment the server publishes
 * `commitment = SHA-256(seed ‖ "|" ‖ tableId ‖ "|" ‖ segment)`; every draw `k` of the segment
 * reads its bytes from `HKDF-SHA-256(seed, salt = SHA-256(tableId), info = "bgf-seeded/v1|"
 * tableId "|" segment "|" k)`; at the end the seed is revealed. Anyone can then recompute the
 * commitment and every draw. The functions here are pure and synchronous.
 */

export const SEED_BYTES = 32;
/** Bytes expanded per draw; a draw that needs more than this (≈2 000 ints) cannot happen in practice. */
export const SEGMENT_DRAW_BYTES = 8160;

export function commitmentFor(seed: Uint8Array, tableId: string, segment: number): string {
  return bytesToHex(sha256(concatBytes([seed, utf8Bytes(`|${tableId}|${segment}`)])));
}

export function segmentDrawBytes(
  seed: Uint8Array,
  tableId: string,
  segment: number,
  drawIndex: number,
  length: number = SEGMENT_DRAW_BYTES,
): Uint8Array {
  return hkdfSha256(
    seed,
    sha256(utf8Bytes(tableId)),
    utf8Bytes(`bgf-seeded/v1|${tableId}|${segment}|${drawIndex}`),
    length,
  );
}

export interface SegmentVerification {
  ok: boolean;
  /** The segment exists and has been revealed. */
  revealed: boolean;
  /** The revealed seed reproduces the published commitment. */
  commitment: boolean;
  /** Per action of the segment: the recorded draws re-derive from the seed. */
  actions: { index: number; ok: boolean }[];
  reasons: string[];
}

/**
 * Verify one segment of a seeded table from public information only (the audit and the action
 * metadata every seat receives). Checks the commitment and that each attributed draw sequence
 * re-derives from the seed. Mapping the draw values onto the action (dice, dealt cards) is the
 * game's part: use `segmentRngFor` to obtain the byte rng for an action and compare.
 */
export function verifySegment(
  snapshot: Pick<TableSnapshot, 'id' | 'actionMeta' | 'entropyAudit'>,
  segmentIndex: number,
): SegmentVerification {
  const reasons: string[] = [];
  const segment = snapshot.entropyAudit?.segments?.find((s) => s.index === segmentIndex);
  if (!segment) {
    return {
      ok: false,
      revealed: false,
      commitment: false,
      actions: [],
      reasons: ['no such segment'],
    };
  }
  if (segment.seed === undefined) {
    return {
      ok: false,
      revealed: false,
      commitment: false,
      actions: [],
      reasons: ['segment not revealed yet'],
    };
  }
  let seed: Uint8Array;
  try {
    seed = hexToBytes(segment.seed);
  } catch {
    return {
      ok: false,
      revealed: true,
      commitment: false,
      actions: [],
      reasons: ['seed is not hex'],
    };
  }
  const commitment = commitmentFor(seed, snapshot.id, segment.index) === segment.commitment;
  if (!commitment) reasons.push('commitment does not match the revealed seed');
  const actions: { index: number; ok: boolean }[] = [];
  for (const [key, meta] of Object.entries(snapshot.actionMeta ?? {})) {
    const record = meta.entropy;
    if (!record || record.segment !== segment.index || record.drawIndex === undefined) continue;
    const index = Number(key);
    const ok = recordDerivesFromSeed(seed, snapshot.id, segment.index, record);
    if (!ok) reasons.push(`action ${index}: draws do not re-derive from the seed`);
    actions.push({ index, ok });
  }
  actions.sort((a, b) => a.index - b.index);
  return {
    ok: commitment && actions.every((a) => a.ok),
    revealed: true,
    commitment,
    actions,
    reasons,
  };
}

/** True when `record.draws` (bounds and values) re-derive from the seed at `record.drawIndex`. */
export function recordDerivesFromSeed(
  seed: Uint8Array,
  tableId: string,
  segment: number,
  record: Pick<EntropyRecord, 'draws' | 'drawIndex' | 'bytes' | 'bytesUsed'>,
): boolean {
  if (record.drawIndex === undefined) return false;
  const bytes = segmentDrawBytes(seed, tableId, segment, record.drawIndex);
  const rng = createByteRng(bytes);
  try {
    for (const d of record.draws) if (rng.int(d.n) !== d.value) return false;
  } catch {
    return false;
  }
  if (rng.used() !== record.bytesUsed) return false;
  return bytesToHex(bytes.subarray(0, rng.used())) === record.bytes.toLowerCase();
}

/**
 * The byte rng that fed `actionIndex` of a revealed seeded table, for re-deriving the concrete
 * values a game embedded (dice, dealt cards). Null when the action drew nothing or its segment
 * is not revealed.
 */
export function segmentRngFor(
  snapshot: Pick<TableSnapshot, 'id' | 'actionMeta' | 'entropyAudit'>,
  actionIndex: number,
): ReturnType<typeof createByteRng> | null {
  const record = snapshot.actionMeta?.[actionIndex]?.entropy;
  if (!record || record.segment === undefined || record.drawIndex === undefined) return null;
  const segment = snapshot.entropyAudit?.segments?.find((s) => s.index === record.segment);
  if (!segment?.seed) return null;
  return createByteRng(
    segmentDrawBytes(hexToBytes(segment.seed), snapshot.id, segment.index, record.drawIndex),
  );
}

/** The seed segments of a snapshot, oldest first (empty when the table is not seeded). */
export function seedSegments(snapshot: Pick<TableSnapshot, 'entropyAudit'>): SeedSegment[] {
  return (snapshot.entropyAudit?.segments ?? []).slice();
}
