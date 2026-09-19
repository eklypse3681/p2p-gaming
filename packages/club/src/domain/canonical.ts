import { sha256, utf8Bytes } from '@bgf/table';
import { bytesToBase64Url } from '@bgf/protocol';

/** JSON with object keys sorted recursively, so hashes are stable across runtimes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Base64Url(bytes: Uint8Array): string {
  return bytesToBase64Url(sha256(bytes));
}

export function hashText(text: string): string {
  return sha256Hex(utf8Bytes(text));
}
