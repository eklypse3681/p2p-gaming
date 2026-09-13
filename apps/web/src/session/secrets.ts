import { base64UrlToBytes, bytesToBase64Url } from '@bgf/protocol';

/**
 * Password protection for a player's secrets (signing key and device-sync key).
 *
 * At rest a locked player stores `secrets`: PBKDF2-SHA-256 (600k iterations) → AES-256-GCM over
 * the JSON of the plain secrets. Unlocking keeps the plain secrets in `sessionStorage` for the
 * current tab only, so a reload asks again and other tabs stay locked.
 */

export interface PlainSecrets {
  privateKey?: string;
  syncKey?: string;
}

export interface EncryptedSecrets {
  alg: 'pbkdf2-aes-gcm';
  /** base64url */
  salt: string;
  iterations: number;
  /** base64url, 12 bytes */
  iv: string;
  /** base64url AES-GCM ciphertext (tag included) */
  ciphertext: string;
}

export const DEFAULT_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 4;

export class SecretsError extends Error {
  constructor(
    public readonly code: 'wrong-password' | 'no-crypto' | 'bad-secrets' | 'weak-password',
    message: string,
  ) {
    super(message);
    this.name = 'SecretsError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new SecretsError('no-crypto', 'WebCrypto is not available in this browser');
  return s;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', buf(enc.encode(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedSecrets(v: unknown): v is EncryptedSecrets {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    s.alg === 'pbkdf2-aes-gcm' &&
    typeof s.salt === 'string' &&
    typeof s.iv === 'string' &&
    typeof s.ciphertext === 'string' &&
    typeof s.iterations === 'number' &&
    s.iterations > 0
  );
}

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new SecretsError(
      'weak-password',
      `use at least ${MIN_PASSWORD_LENGTH} characters for the password`,
    );
  }
}

export async function encryptSecrets(
  secrets: PlainSecrets,
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<EncryptedSecrets> {
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await deriveKey(password, salt, iterations);
  const plain = enc.encode(JSON.stringify(secrets));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plain));
  return {
    alg: 'pbkdf2-aes-gcm',
    salt: bytesToBase64Url(salt),
    iterations,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

/** Throws `SecretsError('wrong-password')` when the password does not open the block. */
export async function decryptSecrets(
  encrypted: EncryptedSecrets,
  password: string,
): Promise<PlainSecrets> {
  if (!isEncryptedSecrets(encrypted)) {
    throw new SecretsError('bad-secrets', 'the encrypted secrets are malformed');
  }
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(password, base64UrlToBytes(encrypted.salt), encrypted.iterations);
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(base64UrlToBytes(encrypted.iv)) },
      key,
      buf(base64UrlToBytes(encrypted.ciphertext)),
    );
  } catch (e) {
    if (e instanceof SecretsError) throw e;
    throw new SecretsError('wrong-password', 'that password does not unlock this player');
  }
  try {
    const parsed = JSON.parse(dec.decode(plain)) as Record<string, unknown>;
    const out: PlainSecrets = {};
    if (typeof parsed.privateKey === 'string') out.privateKey = parsed.privateKey;
    if (typeof parsed.syncKey === 'string') out.syncKey = parsed.syncKey;
    return out;
  } catch {
    throw new SecretsError('bad-secrets', 'the decrypted secrets are malformed');
  }
}

// ---- per-tab unlocked copy -------------------------------------------------------------------

const unlockedKey = (slug: string) => `p2p:unlocked:${slug}`;

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberUnlocked(slug: string, secrets: PlainSecrets): void {
  session()?.setItem(unlockedKey(slug), JSON.stringify(secrets));
}

export function readUnlocked(slug: string): PlainSecrets | null {
  const raw = session()?.getItem(unlockedKey(slug));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlainSecrets;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetUnlocked(slug: string): void {
  session()?.removeItem(unlockedKey(slug));
}
