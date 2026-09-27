/**
 * The passkey backup as stored at `/api/backup/<credential id>`. Shared by the browser, which
 * seals it, and the Pages Function, which keeps it: the function checks the signature and never
 * sees anything but ciphertext.
 *
 * A backup is bound to the player's own key the first time it is written. Replacing it needs a
 * signature from that same key, so knowing someone's credential id is not enough to overwrite
 * their backup, and reading it gives only ciphertext that just their passkey can open.
 */
import { base64UrlToBytes, utf8Bytes, verify } from '@bgf/protocol';

export const BACKUP_VERSION = 1;
/** A sealed player is well under a kilobyte; anything much larger is not one. */
export const MAX_CIPHERTEXT = 8192;

export interface StoredBackup {
  v: typeof BACKUP_VERSION;
  credentialId: string;
  /** The player's own public key: who may replace this backup. */
  publicKey: string;
  /** base64url AES-GCM nonce and ciphertext (tag included). */
  iv: string;
  ciphertext: string;
  /** base64url signature by `publicKey` over `backupBytes`. */
  signature: string;
}

export function backupBytes(b: Omit<StoredBackup, 'signature' | 'v'>): Uint8Array {
  return utf8Bytes(
    ['amongfriends passkey backup v1', b.credentialId, b.publicKey, b.iv, b.ciphertext].join('\n'),
  );
}

const B64 = /^[A-Za-z0-9_-]+$/;

export function asStoredBackup(value: unknown): StoredBackup | null {
  const v = value as Partial<StoredBackup> | null;
  if (!v || v.v !== BACKUP_VERSION) return null;
  for (const field of ['credentialId', 'publicKey', 'iv', 'ciphertext', 'signature'] as const) {
    const s = v[field];
    if (typeof s !== 'string' || !B64.test(s)) return null;
  }
  if (v.credentialId!.length > 512 || v.ciphertext!.length > MAX_CIPHERTEXT) return null;
  return v as StoredBackup;
}

export async function backupSignatureValid(b: StoredBackup): Promise<boolean> {
  try {
    return await verify(b.publicKey, backupBytes(b), base64UrlToBytes(b.signature));
  } catch {
    return false;
  }
}
