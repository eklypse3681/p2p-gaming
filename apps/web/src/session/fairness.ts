import type {
  ActionMeta,
  BeaconBinding,
  EntropyAudit,
  EntropyRecord,
  RandomnessMode,
} from '@bgf/protocol';
import {
  DRAND_QUICKNET_SCHEDULE,
  checkSerials,
  verifyBeaconRecord,
  verifyEntropyRecord,
  verifySegment,
} from '@bgf/entropy';
import type { SegmentVerification } from '@bgf/entropy';

/**
 * The public randomness audit of a table, as every seat receives it: which source and mode the
 * host declared, one record per drawing action, and (seeded mode) the committed segments.
 * Backgammon's `MatchSnapshot` and a table's `TableSnapshot` both provide these fields.
 */
export interface FairnessSource {
  id: string;
  randomness?: { provider: string; mode?: RandomnessMode };
  actionMeta?: Record<number, ActionMeta>;
  entropyAudit?: EntropyAudit;
}

export type VerifyStatus = 'idle' | 'checking' | 'ok' | 'fail' | 'pending' | 'unverifiable';

export interface DrawRow {
  key: string;
  /** Index into the action log, or null for the initial draw (`entropyAudit.init`). */
  index: number | null;
  label: string;
  provider: string;
  proofKind: string;
  values: number[];
  fallback: boolean;
  segment?: number;
  beacon?: BeaconBinding;
  record: EntropyRecord;
}

export interface SegmentSummary {
  index: number;
  commitment: string;
  revealed: boolean;
  from: number;
  to?: number;
}

export interface FairnessSummary {
  provider: string;
  mode: RandomnessMode;
  /** False when the source is this device (nothing for anyone else to check). */
  verifiable: boolean;
  /** random.org quota after the latest request, when known. */
  requestsLeft: number | null;
  segments: SegmentSummary[];
  /** random.org serial-number gaps between consecutive draws (evidence of hidden requests). */
  serialGaps: { afterIndex: number; from: number; to: number }[];
  drawCount: number;
}

function proofKindOf(record: EntropyRecord): string {
  const kinds = new Set(record.sources.map((s) => s.proof.kind));
  if (kinds.size === 0) return record.segment !== undefined ? 'seed' : 'none';
  return Array.from(kinds).join('+');
}

/** Every recorded draw, oldest first. */
export function fairnessRows(src: FairnessSource): DrawRow[] {
  const rows: DrawRow[] = [];
  const toRow = (index: number | null, record: EntropyRecord): DrawRow => ({
    key: index === null ? 'init' : String(index),
    index,
    label: record.label,
    provider: record.provider,
    proofKind: proofKindOf(record),
    values: record.draws.map((d) => d.value),
    fallback: record.fallback,
    segment: record.segment,
    beacon: record.beacon,
    record,
  });
  if (src.entropyAudit?.init) rows.push(toRow(null, src.entropyAudit.init));
  const indexes = Object.keys(src.actionMeta ?? {})
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const i of indexes) {
    const record = src.actionMeta?.[i]?.entropy;
    if (record) rows.push(toRow(i, record));
  }
  return rows;
}

export function fairnessSummary(src: FairnessSource): FairnessSummary {
  const rows = fairnessRows(src);
  const provider = src.randomness?.provider ?? rows[0]?.provider ?? 'crypto';
  const mode: RandomnessMode = src.randomness?.mode ?? src.entropyAudit?.mode ?? 'per-draw';
  let requestsLeft: number | null = null;
  for (const row of rows) {
    for (const s of row.record.sources) {
      if (typeof s.requestsLeft === 'number') requestsLeft = s.requestsLeft;
    }
  }
  for (const seg of src.entropyAudit?.segments ?? []) {
    if (typeof seg.source?.requestsLeft === 'number') requestsLeft = seg.source.requestsLeft;
  }
  const segments: SegmentSummary[] = (src.entropyAudit?.segments ?? []).map((s) => ({
    index: s.index,
    commitment: s.commitment,
    revealed: s.seed !== undefined,
    from: s.from,
    to: s.to,
  }));
  const serials = checkSerials(rows.map((r) => r.record));
  return {
    provider,
    mode,
    verifiable: provider !== 'crypto',
    requestsLeft,
    segments,
    serialGaps: serials.gaps,
    drawCount: rows.length,
  };
}

/** Verification back ends; injectable so the panel can be tested without a network. */
export interface Verifiers {
  record(record: EntropyRecord): Promise<{ ok: boolean }>;
  segment(src: FairnessSource, index: number): SegmentVerification;
  beacon(record: EntropyRecord): Promise<{ ok: boolean }>;
}

export const defaultVerifiers: Verifiers = {
  record: (record) => verifyEntropyRecord(record),
  segment: (src, index) => verifySegment(src, index),
  beacon: (record) => verifyBeaconRecord(record, { schedule: DRAND_QUICKNET_SCHEDULE }),
};

/** Decide how (and whether) a row can be verified, then verify it. */
export async function verifyRow(
  src: FairnessSource,
  row: DrawRow,
  verifiers: Verifiers = defaultVerifiers,
): Promise<Exclude<VerifyStatus, 'idle' | 'checking'>> {
  const mode = src.randomness?.mode ?? src.entropyAudit?.mode ?? 'per-draw';
  if (row.fallback) return 'unverifiable';
  if (mode === 'seeded' || row.segment !== undefined) {
    if (row.segment === undefined) return 'unverifiable';
    const seg = src.entropyAudit?.segments?.find((s) => s.index === row.segment);
    if (!seg || seg.seed === undefined) return 'pending';
    try {
      const v = verifiers.segment(src, row.segment);
      if (row.index === null) return v.ok ? 'ok' : 'fail';
      const a = v.actions.find((x) => x.index === row.index);
      return (a ? a.ok : v.ok) ? 'ok' : 'fail';
    } catch {
      return 'fail';
    }
  }
  if (row.beacon) {
    try {
      return (await verifiers.beacon(row.record)).ok ? 'ok' : 'fail';
    } catch {
      return 'fail';
    }
  }
  if (row.provider === 'crypto' || row.proofKind === 'none') return 'unverifiable';
  try {
    return (await verifiers.record(row.record)).ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

/** One line for the header, from the rows' statuses. */
export function verdictFor(statuses: VerifyStatus[], summary: FairnessSummary): string {
  const total = statuses.length;
  if (!summary.verifiable) return 'This table uses this device’s randomness (not verifiable)';
  if (total === 0) return 'No draws yet';
  const count = (s: VerifyStatus) => statuses.filter((x) => x === s).length;
  const fail = count('fail');
  const pending = count('pending');
  const ok = count('ok');
  const unverifiable = count('unverifiable');
  const untouched = count('idle') + count('checking');
  if (untouched === total)
    return `${total} draw${total === 1 ? '' : 's'} recorded · not verified yet`;
  if (fail > 0) return `${fail} draw${fail === 1 ? '' : 's'} could not be verified`;
  const parts: string[] = [];
  if (ok > 0 && pending === 0 && unverifiable === 0 && untouched === 0)
    return `All ${ok} draw${ok === 1 ? '' : 's'} verified`;
  if (ok > 0) parts.push(`${ok} verified`);
  if (pending > 0) parts.push(`${pending} awaiting reveal`);
  if (unverifiable > 0) parts.push(`${unverifiable} from this device`);
  if (untouched > 0) parts.push(`${untouched} unchecked`);
  return parts.join(' · ');
}

/** The public audit as a downloadable document (never contains hidden information). */
export function auditJson(
  src: FairnessSource,
  extra: { gameId?: string; actions?: unknown[]; seat?: number | null } = {},
): Record<string, unknown> {
  return {
    format: 'p2p-gaming-audit',
    version: 1,
    exportedAt: new Date().toISOString(),
    tableId: src.id,
    gameId: extra.gameId ?? null,
    seat: extra.seat ?? null,
    randomness: src.randomness ?? null,
    entropyAudit: src.entropyAudit ?? null,
    actionMeta: src.actionMeta ?? {},
    actions: extra.actions ?? null,
  };
}
