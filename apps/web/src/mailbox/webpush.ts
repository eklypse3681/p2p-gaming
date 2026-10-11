import { base64UrlToBytes } from '@bgf/protocol';

/**
 * Web push payload encryption (RFC 8291, `aes128gcm`): what lets a push carry the message itself.
 * The payload is encrypted for the one browser subscription (its `p256dh` key and `auth` secret),
 * so the push service relays it without being able to read it. (Our messages are already sealed
 * with the match key inside; this is the push standard's own layer on top.)
 */

/** The most plaintext one push can carry: 4096 bytes on the wire, less header and overhead. */
export const MAX_PUSH_PLAINTEXT = 3993;

const te = new TextEncoder();
const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
      key,
      bytes * 8,
    ),
  );
}

/** The keys both sides derive from the ECDH secret, the subscription's auth secret and the salt. */
export async function pushKeys(
  ecdh: Uint8Array,
  auth: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const ikm = await hkdf(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  return {
    cek: await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16),
    nonce: await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12),
  };
}

/**
 * Encrypt `plaintext` for a subscription. Returns the request body (header + one record); null
 * when it is too big for a push.
 */
export async function encryptPush(
  plaintext: Uint8Array,
  sub: { p256dh: string; auth: string },
): Promise<Uint8Array | null> {
  if (plaintext.length > MAX_PUSH_PLAINTEXT) return null;
  const uaPublic = base64UrlToBytes(sub.p256dh);
  const auth = base64UrlToBytes(sub.auth);
  const ua = await crypto.subtle.importKey(
    'raw',
    buf(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const mine = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey));
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, mine.privateKey, 256),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await pushKeys(ecdh, auth, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  // One record: the plaintext and the last-record delimiter (0x02), no padding.
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(nonce) },
      key,
      buf(concat(plaintext, new Uint8Array([2]))),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, record);
}
