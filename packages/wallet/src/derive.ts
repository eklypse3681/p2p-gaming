/**
 * Deterministic derivation: seed + path → key.
 *
 * HKDF-SHA-256 (RFC 5869) with a fixed salt, expanding an `info` string that names the *purpose*,
 * the output length and the path. Binding all three matters: HKDF's expand step is a prefix
 * function of its length, so asking for 32 bytes and 48 bytes under one info would hand out the
 * short answer as the head of the long one. Nothing here shares material with anything else.
 *
 * Signing keys come out as an ordinary `KeyPair` from `@bgf/protocol` — raw uncompressed public
 * key, PKCS#8 private key, both base64url — so a derived key is accepted everywhere a generated
 * one already is. WebCrypto cannot turn a private scalar into a public point, so `@noble/curves`
 * does that one step and WebCrypto does the rest.
 */
import { p256 } from '@noble/curves/nist.js';
import type { KeyPair } from '@bgf/protocol';
import { bytesToBase64Url, hkdfSha256, utf8Bytes } from '@bgf/protocol';
import { WalletError, subtle } from './errors.js';
import { checkSeed } from './seed.js';

export const WALLET_KDF = 'p2p-gaming wallet v1';

const SALT = utf8Bytes(WALLET_KDF);
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** 384 bits reduced into [1, n-1]: the modulo bias is about 2^-128, i.e. none. */
const WIDE_BYTES = 48;

/** Paths are lowercase segments joined by `/`, e.g. `identity`, `club/<id>`, `device/3`. */
const PATH = /^[a-z][a-z0-9]*(\/[A-Za-z0-9_-]+)*$/;

export const IDENTITY_PATH = 'identity';
export const SYNC_PATH = 'sync';

export function clubPath(clubId: string): string {
  return checkPath(`club/${clubId}`);
}

export function devicePath(serial: number): string {
  if (!Number.isInteger(serial) || serial < 1) {
    throw new WalletError('bad-path', 'a device serial is a whole number from 1 up');
  }
  return `device/${serial}`;
}

export function checkPath(path: string): string {
  if (!PATH.test(path)) throw new WalletError('bad-path', `"${path}" is not a wallet path`);
  return path;
}

function infoFor(purpose: string, path: string, length: number): Uint8Array {
  return utf8Bytes(`${purpose}|${length}|${checkPath(path)}`);
}

/** Raw derived bytes. Distinct `(purpose, length, path)` triples give unrelated output. */
export function deriveBytes(
  seed: Uint8Array,
  path: string,
  length: number,
  purpose = 'bytes',
): Uint8Array {
  checkSeed(seed);
  return hkdfSha256(seed, SALT, infoFor(purpose, path, length), length);
}

/** A 32-byte symmetric secret as base64url — the shape the sync layer already stores. */
export function deriveSecret(seed: Uint8Array, path: string): string {
  return bytesToBase64Url(deriveBytes(seed, path, 32, 'secret'));
}

/** The ECDSA P-256 key pair at `path`. Same seed and path always give the same key. */
export async function deriveKeyPair(seed: Uint8Array, path: string): Promise<KeyPair> {
  const wide = deriveBytes(seed, path, WIDE_BYTES, 'ecdsa-p256');
  return keyPairFromScalar(scalarFromWide(wide));
}

function scalarFromWide(wide: Uint8Array): Uint8Array {
  const order = p256.Point.Fn.ORDER;
  let value = 0n;
  for (const byte of wide) value = (value << 8n) | BigInt(byte);
  const scalar = (value % (order - 1n)) + 1n;
  const out = new Uint8Array(32);
  let rest = scalar;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

async function keyPairFromScalar(scalar: Uint8Array): Promise<KeyPair> {
  const point = p256.getPublicKey(scalar, false); // 65 bytes, uncompressed
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64Url(scalar),
    x: bytesToBase64Url(point.subarray(1, 33)),
    y: bytesToBase64Url(point.subarray(33, 65)),
    ext: true,
  };
  const key = await subtle().importKey('jwk', jwk, EC, true, ['sign']);
  const pkcs8 = await subtle().exportKey('pkcs8', key);
  return { publicKey: bytesToBase64Url(point), privateKey: bytesToBase64Url(pkcs8) };
}
