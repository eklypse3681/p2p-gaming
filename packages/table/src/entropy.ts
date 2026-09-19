import type { DrawSpec, EntropyProof, EntropyRecord, EntropySourceProof } from '@bgf/protocol';
import type { Rng } from './definition.js';

/**
 * Just-in-time randomness. A table asks its `EntropySource` for bytes *when a command needs
 * them*, never before, so a host who is also a player can never see what the next deal will be.
 * The bytes are turned into values by `createByteRng` — a fixed, documented derivation — so a
 * verifier holding the source's proof can recompute every value (`deriveDraws`).
 */

export interface DrawContext {
  /** What the bytes are for: the command label (`roll`, `start`, …) or `init`. */
  label: string;
  tableId: string;
  purpose: string;
}

export interface EntropyDraw {
  bytes: Uint8Array;
  proof: EntropyProof;
  fetchedAt: number;
  serialNumber?: number;
  bitsLeft?: number;
  requestsLeft?: number;
}

export interface EntropySource {
  readonly id: string;
  draw(bytes: number, ctx: DrawContext): Promise<EntropyDraw>;
}

/**
 * A public randomness beacon (drand): rounds are published on a fixed schedule and cannot be
 * known before their time. Beacon mode binds each draw to a *future* round before its value
 * exists, so nobody — the host included — can know the outcome in advance.
 */
export interface BeaconSource extends EntropySource {
  readonly chainHash: string;
  /** Round period in milliseconds and the chain's genesis time (ms since epoch). */
  schedule(): Promise<{ periodMs: number; genesisMs: number }>;
  /** The latest round that exists at `nowMs` according to the schedule. */
  roundAt(nowMs: number, schedule: { periodMs: number; genesisMs: number }): number;
  /**
   * Fetch a specific round (waiting for it to be published) and expand it to `bytes` bytes with
   * `context`. Rejects with an error after `timeoutMs`.
   */
  drawRound(
    round: number,
    bytes: number,
    ctx: DrawContext & { context: string; timeoutMs: number },
  ): Promise<EntropyDraw>;
}

export function isBeaconSource(source: EntropySource): source is BeaconSource {
  const s = source as Partial<BeaconSource>;
  return (
    typeof s.chainHash === 'string' &&
    typeof s.schedule === 'function' &&
    typeof s.roundAt === 'function' &&
    typeof s.drawRound === 'function'
  );
}

/** Derivation context for a beacon-bound draw: the table and the per-table draw counter. */
export function beaconContext(tableId: string, counter: number): string {
  return `bgf-beacon/v1|${tableId}|draw:${counter}`;
}

/** Thrown by a byte-backed rng when its bytes are used up; the caller fetches more and re-runs. */
export class EntropyExhausted extends Error {
  constructor(public readonly needed: number) {
    super(`entropy exhausted: needed ${needed} more bytes`);
    this.name = 'EntropyExhausted';
  }
}

/** Thrown by the probe rng on the first draw: the command needs randomness. */
export class NeedsEntropy extends Error {
  constructor() {
    super('command needs entropy');
    this.name = 'NeedsEntropy';
  }
}

/** An rng that refuses to draw; used to find out whether a command draws at all. */
export function probeRng(): Rng {
  return {
    int: () => {
      throw new NeedsEntropy();
    },
    shuffle: () => {
      throw new NeedsEntropy();
    },
  };
}

export const BYTES_PER_INT = 4;

/**
 * Deterministic derivation: each `int(n)` reads 4 bytes big-endian as a uint32 and rejection-
 * samples so the result is uniform (a rejected sample consumes its 4 bytes and reads the next);
 * `shuffle` is Fisher–Yates over `int`. `n === 1` consumes nothing.
 */
export interface ByteRng extends Rng {
  /** Bytes consumed so far. */
  used(): number;
  /** Every `int(n)` made so far with its result. */
  draws(): DrawSpec[];
}

export function createByteRng(bytes: Uint8Array): ByteRng {
  let offset = 0;
  const draws: DrawSpec[] = [];
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`rng.int needs a positive integer bound, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) {
      draws.push({ n: 1, value: 0 });
      return 0;
    }
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      if (offset + BYTES_PER_INT > bytes.length) throw new EntropyExhausted(BYTES_PER_INT);
      const v =
        ((bytes[offset]! << 24) >>> 0) +
        (bytes[offset + 1]! << 16) +
        (bytes[offset + 2]! << 8) +
        bytes[offset + 3]!;
      offset += BYTES_PER_INT;
      if (v < limit) {
        const value = v % maxExclusive;
        draws.push({ n: maxExclusive, value });
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
  return { int, shuffle, used: () => offset, draws: () => draws.slice() };
}

/**
 * Recompute the values of a recorded draw sequence from its bytes. Returns the values in order;
 * throws `EntropyExhausted` if the bytes are too short for the bounds in `spec`.
 */
export function deriveDraws(bytes: Uint8Array, spec: readonly Pick<DrawSpec, 'n'>[]): number[] {
  const rng = createByteRng(bytes);
  return spec.map((d) => rng.int(d.n));
}

/** True when re-deriving `record.draws` from `record.bytes` reproduces the recorded values. */
export function drawsMatch(record: Pick<EntropyRecord, 'bytes' | 'draws'>): boolean {
  try {
    const values = deriveDraws(hexToBytes(record.bytes), record.draws);
    return values.every((v, i) => v === record.draws[i]!.value);
  } catch {
    return false;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean))
    throw new Error('expected a hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Build the proof entry for one source request. */
export function sourceProof(draw: EntropyDraw): EntropySourceProof {
  const out: EntropySourceProof = {
    proof: draw.proof,
    bytes: bytesToHex(draw.bytes),
    fetchedAt: draw.fetchedAt,
  };
  if (draw.serialNumber !== undefined) out.serialNumber = draw.serialNumber;
  if (draw.bitsLeft !== undefined) out.bitsLeft = draw.bitsLeft;
  if (draw.requestsLeft !== undefined) out.requestsLeft = draw.requestsLeft;
  return out;
}

/**
 * random.org numbers every signed request of a key consecutively. Two consecutive draws of one
 * table whose serial numbers are not adjacent mean the key made requests in between: another
 * table, or a host re-requesting until they liked the result. Gaps are evidence, not proof.
 */
export function checkSerials(records: readonly EntropyRecord[]): {
  ok: boolean;
  gaps: { afterIndex: number; from: number; to: number }[];
} {
  const gaps: { afterIndex: number; from: number; to: number }[] = [];
  let previous: number | null = null;
  let previousIndex = -1;
  records.forEach((record, index) => {
    for (const s of record.sources) {
      if (s.proof.kind !== 'random.org-signed' || s.serialNumber === undefined) continue;
      if (previous !== null && s.serialNumber !== previous + 1) {
        gaps.push({ afterIndex: previousIndex, from: previous, to: s.serialNumber });
      }
      previous = s.serialNumber;
      previousIndex = index;
    }
  });
  return { ok: gaps.length === 0, gaps };
}
