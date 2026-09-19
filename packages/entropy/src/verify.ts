import type { EntropyRecord, EntropySourceProof } from '@bgf/protocol';
import { bytesToHex, concatBytes, drawsMatch, hexToBytes } from '@bgf/table';
import type { FetchLike } from './types.js';
import { bytesFromRandomOrgProof, verifyRandomOrg } from './randomOrg.js';
import { expandDrand, verifyDrand } from './drand.js';

export interface RecordVerification {
  /** Every source's proof checked out with its authority (random.org signature / drand round). */
  proofs: boolean;
  /** The bytes the proofs attest to are the bytes the record says were consumed. */
  bytes: boolean;
  /** Re-deriving the draw sequence from those bytes reproduces the recorded values. */
  draws: boolean;
  /** All three. */
  ok: boolean;
  /** Per source detail. */
  sources: { proof: boolean; bytes: boolean; kind: string }[];
  /** The record used this device's generator for some or all bytes: nothing to verify there. */
  fallback: boolean;
}

/** The bytes a source proof attests to, recomputed from the proof itself (not from `source.bytes`). */
export async function bytesFromProof(source: EntropySourceProof): Promise<Uint8Array | null> {
  const { proof } = source;
  if (proof.kind === 'random.org-signed') return bytesFromRandomOrgProof(proof);
  if (proof.kind === 'drand') {
    if (!proof.context) return null;
    const declared = hexToBytes(source.bytes);
    return expandDrand(proof.randomness, proof.chainHash, proof.context, declared.length);
  }
  return null;
}

/**
 * Check one action's randomness end to end: authority, bytes and derivation. A verifier needs
 * only the record (which every seat receives) and network access to the authority.
 */
export async function verifyEntropyRecord(
  record: EntropyRecord,
  opts: { fetch?: FetchLike; randomOrgEndpoint?: string; drandBaseUrl?: string } = {},
): Promise<RecordVerification> {
  const sources: RecordVerification['sources'] = [];
  const attested: Uint8Array[] = [];
  for (const source of record.sources) {
    const kind = source.proof.kind;
    let proof = false;
    let bytesOk = false;
    if (kind === 'random.org-signed') {
      proof = await verifyRandomOrg(source.proof, {
        fetch: opts.fetch,
        endpoint: opts.randomOrgEndpoint,
      });
    } else if (kind === 'drand') {
      proof = await verifyDrand(source.proof, { fetch: opts.fetch, baseUrl: opts.drandBaseUrl });
    }
    const derived = await bytesFromProof(source);
    if (derived) {
      bytesOk = bytesToHex(derived) === source.bytes.toLowerCase();
      attested.push(derived);
    } else if (kind === 'none') {
      attested.push(hexToBytes(source.bytes)); // fallback bytes: taken on trust, flagged below
    }
    sources.push({ proof, bytes: bytesOk, kind });
  }
  const verifiable = record.sources.filter((s) => s.proof.kind !== 'none');
  const proofs = verifiable.length > 0 && sources.every((s) => s.kind === 'none' || s.proof);
  const consumed = concatBytes(attested).subarray(0, record.bytesUsed);
  const bytes =
    sources.every((s) => s.kind === 'none' || s.bytes) &&
    bytesToHex(consumed) === record.bytes.toLowerCase();
  const draws = drawsMatch(record);
  return {
    proofs,
    bytes,
    draws,
    ok: proofs && bytes && draws && !record.fallback,
    sources,
    fallback: record.fallback,
  };
}
