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

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(buf(bytes)).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(buf(bytes)).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Like `seal`, compressed first (`z.<iv>.<ciphertext>`): what a push carries, where space is short. */
export async function sealCompact(key: string, matchId: string, value: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await gzip(new TextEncoder().encode(JSON.stringify(value)));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(new TextEncoder().encode(matchId)) },
    await importKey(key),
    buf(data),
  );
  return `z.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(sealed))}`;
}

/**
 * Open what `seal` or `sealCompact` made; null when it was not sealed with this key for this
 * match.
 */
export async function open(key: string, matchId: string, sealed: string): Promise<unknown> {
  const compact = sealed.startsWith('z.');
  const [iv, body] = (compact ? sealed.slice(2) : sealed).split('.');
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
    const bytes = compact ? await gunzip(new Uint8Array(plain)) : new Uint8Array(plain);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
