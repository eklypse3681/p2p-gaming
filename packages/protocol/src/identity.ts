/**
 * Player identity keys.
 *
 * Every player owns an ECDSA P-256 key pair. The public key is bound to a seat the first time the
 * player takes it (trust on first use); afterwards a device can only claim that seat by signing
 * the server's challenge with the matching private key — whoever runs the server. Private keys
 * travel only inside a player's own exports, transfer codes and hand-off links.
 *
 * Encoding: base64url without padding. Public keys are the raw uncompressed point (65 bytes),
 * private keys are PKCS#8, signatures are the 64-byte IEEE P1363 form WebCrypto produces.
 */

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

/** Produces a signature for the given bytes with a private key it holds. */
export type Signer = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface Challenge {
  matchId: string;
  profileId: string;
  nonce: string;
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is not available');
  return c.subtle;
}

export function hasSubtleCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;
}

export function bytesToBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A plain ArrayBuffer view of `bytes` (WebCrypto rejects views over shared buffers). */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await subtle().generateKey(EC, true, ['sign', 'verify']);
  const [pub, priv] = await Promise.all([
    subtle().exportKey('raw', pair.publicKey),
    subtle().exportKey('pkcs8', pair.privateKey),
  ]);
  return { publicKey: bytesToBase64Url(pub), privateKey: bytesToBase64Url(priv) };
}

async function importPrivate(privateKey: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', buf(base64UrlToBytes(privateKey)), EC, false, ['sign']);
}

async function importPublic(publicKey: string): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(base64UrlToBytes(publicKey)), EC, false, ['verify']);
}

export async function sign(privateKey: string, bytes: Uint8Array): Promise<Uint8Array> {
  const key = await importPrivate(privateKey);
  return new Uint8Array(await subtle().sign(SIG, key, buf(bytes)));
}

/** False for a bad key, a bad signature or tampered bytes; never throws. */
export async function verify(
  publicKey: string,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await importPublic(publicKey);
    return await subtle().verify(SIG, key, buf(signature), buf(bytes));
  } catch {
    return false;
  }
}

/** A signer bound to one private key. */
export function signerFor(privateKey: string): Signer {
  return (bytes) => sign(privateKey, bytes);
}

/** The bytes a client signs to prove it may take a seat: deterministic, domain-separated. */
export function challengeBytes(c: Challenge): Uint8Array {
  const text = `p2p-gaming seat v1\n${c.matchId}\n${c.profileId}\n${c.nonce}`;
  return new TextEncoder().encode(text);
}

export function randomNonce(bytes = 16): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  let out = '';
  for (const b of a) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Loose shape check for a base64url public key of the expected length (65 raw bytes → 87 chars). */
export function looksLikePublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(value);
}
