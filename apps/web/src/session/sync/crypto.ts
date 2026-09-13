/**
 * WebCrypto helpers for device sync. The sync key is a per-player secret; devices prove they hold
 * it with an HMAC over the other side's nonce, and find each other under an address derived from
 * its hash (the key itself never goes on the wire).
 */

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hasWebCrypto(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function' &&
    !!crypto.subtle &&
    typeof crypto.subtle.digest === 'function'
  );
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

export const SYNC_ADDRESS_PREFIX = 'sync-';

/** Room address the player's devices meet at: `sync-` + the first 24 hex chars of SHA-256(key). */
export async function syncAddress(syncKey: string): Promise<string> {
  return SYNC_ADDRESS_PREFIX + (await sha256Hex(syncKey)).slice(0, 24);
}

export function randomNonce(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a);
}

/** Compare two hex strings without leaking where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
