import { base64UrlToBytes, bytesToBase64Url } from '@bgf/protocol';

/**
 * What players send each other through the mailbox is sealed with the match's own key
 * (`mailboxKey`, made by the host when the match is created and known only to its players):
 * AES-256-GCM, so the mailbox can neither read a message nor forge one, and a message for one
 * match cannot be passed off as belonging to another.
 */

/** A fresh match key: 32 random bytes, base64url. */
export function newMailboxKey(): string {
  return bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function importKey(key: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', buf(base64UrlToBytes(key)), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Seal `value` (JSON) for the match `matchId`: `<iv>.<ciphertext>`, both base64url. */
export async function seal(key: string, matchId: string, value: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(new TextEncoder().encode(matchId)) },
    await importKey(key),
    buf(data),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(sealed))}`;
}

/** Open what `seal` made; null when it was not sealed with this key for this match. */
export async function open(key: string, matchId: string, sealed: string): Promise<unknown> {
  const [iv, body] = sealed.split('.');
  if (!iv || !body) return null;
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(base64UrlToBytes(iv)),
        additionalData: buf(new TextEncoder().encode(matchId)),
      },
      await importKey(key),
      buf(base64UrlToBytes(body)),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
