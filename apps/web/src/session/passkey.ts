/**
 * Saving a player with a passkey, and getting them back on any device.
 *
 * A passkey (Face ID, a fingerprint, Windows Hello) is synced by Apple, Google or the password
 * manager to the person's own devices. With the WebAuthn PRF extension it also yields a secret
 * that only that passkey can reproduce. That secret encrypts a copy of the player (id, name, key,
 * seed, sync key), and the ciphertext is kept at `/api/backup/<credential id>`. On a new device,
 * signing in with the passkey reproduces the secret, fetches the ciphertext and opens it.
 *
 * Nothing that leaves the device can be opened without the passkey, and the passkey never leaves
 * the person's keychain.
 */
import { bytesToBase64Url, base64UrlToBytes, sha256, sign, utf8Bytes } from '@bgf/protocol';
import type { StoredBackup } from './backupFormat';
import { BACKUP_VERSION, asStoredBackup, backupBytes } from './backupFormat';
import type { ProfileExport } from './transfer';
import { EXPORT_FORMAT, EXPORT_VERSION, importProfile } from './transfer';
import { DEFAULT_SETTINGS } from './settings';
import { getProfile, getSecrets, recordPasskey } from './profiles';

/** Every backup is sealed under PRF(passkey, this); it only separates our use from any other. */
const PRF_SALT = sha256(utf8Bytes('amongfriends passkey backup v1'));

export class PasskeyError extends Error {
  constructor(
    public readonly code:
      'unsupported' | 'no-prf' | 'cancelled' | 'not-yours' | 'no-backup' | 'damaged' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** What goes inside the sealed copy. */
export interface SealedPlayer {
  v: 1;
  id: string;
  name: string;
  avatar: string;
  publicKey: string;
  privateKey: string;
  seed?: string;
  syncKey?: string;
}

// ---- sealing ---------------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new PasskeyError('unsupported', 'this browser has no WebCrypto');
  return s;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function aesKey(prf: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', buf(prf), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(PRF_SALT), info: buf(utf8Bytes('aes-256-gcm')) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealPlayer(
  player: SealedPlayer,
  prf: Uint8Array,
  credentialId: string,
): Promise<StoredBackup> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    await aesKey(prf),
    buf(utf8Bytes(JSON.stringify(player))),
  );
  const body = {
    credentialId,
    publicKey: player.publicKey,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
  const signature = bytesToBase64Url(await sign(player.privateKey, backupBytes(body)));
  return { v: BACKUP_VERSION, ...body, signature };
}

export async function openPlayer(stored: StoredBackup, prf: Uint8Array): Promise<SealedPlayer> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(base64UrlToBytes(stored.iv)) },
      await aesKey(prf),
      buf(base64UrlToBytes(stored.ciphertext)),
    );
  } catch {
    throw new PasskeyError('damaged', 'that passkey does not open this backup');
  }
  const p = JSON.parse(new TextDecoder().decode(plain)) as Partial<SealedPlayer>;
  if (
    p.v !== 1 ||
    typeof p.id !== 'string' ||
    typeof p.name !== 'string' ||
    typeof p.publicKey !== 'string' ||
    typeof p.privateKey !== 'string' ||
    p.publicKey !== stored.publicKey
  ) {
    throw new PasskeyError('damaged', 'the backup is damaged');
  }
  return p as SealedPlayer;
}

// ---- WebAuthn --------------------------------------------------------------------------------

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };

function webauthn(): CredentialsContainer {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) {
    throw new PasskeyError('unsupported', 'this browser cannot use passkeys');
  }
  return navigator.credentials;
}

let available: Promise<boolean> | null = null;

/** Whether this site can store passkey backups (false on the dev server, or before it is set up). */
export function backupsAvailable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  available ??= fetchImpl('/api/backup-status')
    .then(async (res) => res.ok && ((await res.json()) as { passkeys?: unknown }).passkeys === true)
    .catch(() => false);
  return available;
}

/** For tests. */
export function resetBackupsAvailable(): void {
  available = null;
}

/** Best guess before trying: `false` only when the browser says outright it cannot. */
export async function passkeysLikelyWork(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  const caps = (
    PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    }
  ).getClientCapabilities;
  if (!caps) return true;
  try {
    const c = await caps.call(PublicKeyCredential);
    return c['extension:prf'] !== false;
  } catch {
    return true;
  }
}

function prfOf(credential: PublicKeyCredential): Uint8Array | null {
  const prf = (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
  const first = prf?.results?.first;
  if (!first) return null;
  return first instanceof ArrayBuffer
    ? new Uint8Array(first)
    : new Uint8Array((first as ArrayBufferView).buffer);
}

function randomChallenge(): ArrayBuffer {
  return buf(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function ceremony<T>(run: () => Promise<T | null>): Promise<T> {
  try {
    const out = await run();
    if (!out) throw new PasskeyError('cancelled', 'no passkey was chosen');
    return out;
  } catch (e) {
    if (e instanceof PasskeyError) throw e;
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new PasskeyError('cancelled', 'the passkey prompt was dismissed');
    }
    throw new PasskeyError('unsupported', (e as Error).message || 'passkeys failed');
  }
}

/** Ask for the PRF secret of a known credential (some platforms only give it on sign-in). */
async function prfFromGet(credentialId?: string): Promise<{ id: string; prf: Uint8Array }> {
  const credential = await ceremony(
    () =>
      webauthn().get({
        publicKey: {
          challenge: randomChallenge(),
          rpId: location.hostname,
          userVerification: 'required',
          timeout: 120_000,
          ...(credentialId
            ? {
                allowCredentials: [{ type: 'public-key', id: buf(base64UrlToBytes(credentialId)) }],
              }
            : {}),
          extensions: {
            prf: { eval: { first: buf(PRF_SALT) } },
          } as AuthenticationExtensionsClientInputs,
        },
      }) as Promise<PublicKeyCredential | null>,
  );
  const prf = prfOf(credential);
  if (!prf) throw new PasskeyError('no-prf', 'this passkey cannot protect a backup');
  return { id: bytesToBase64Url(credential.rawId), prf };
}

// ---- save and restore ------------------------------------------------------------------------

/** Create a passkey for this player and keep an encrypted copy that only it can open. */
export async function saveWithPasskey(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const record = getProfile(slug);
  const secrets = getSecrets(slug);
  if (!record?.publicKey || !secrets?.privateKey) {
    throw new PasskeyError('not-yours', 'only a device holding this player’s own key can save it');
  }
  const created = await ceremony(
    () =>
      webauthn().create({
        publicKey: {
          rp: { id: location.hostname, name: 'Among Friends' },
          user: {
            id: buf(utf8Bytes(record.id).subarray(0, 64)),
            name: record.name,
            displayName: record.name,
          },
          challenge: randomChallenge(),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          timeout: 120_000,
          extensions: {
            prf: { eval: { first: buf(PRF_SALT) } },
          } as AuthenticationExtensionsClientInputs,
        },
      }) as Promise<PublicKeyCredential | null>,
  );
  const credentialId = bytesToBase64Url(created.rawId);
  const enabled = (created.getClientExtensionResults() as { prf?: PrfResults }).prf?.enabled;
  let prf = prfOf(created);
  if (!prf) {
    if (enabled === false) throw new PasskeyError('no-prf', 'this passkey cannot protect a backup');
    prf = (await prfFromGet(credentialId)).prf;
  }
  const player: SealedPlayer = {
    v: 1,
    id: record.id,
    name: record.name,
    avatar: record.avatar,
    publicKey: record.publicKey,
    privateKey: secrets.privateKey,
    ...(secrets.seed ? { seed: secrets.seed } : {}),
    ...(secrets.syncKey ? { syncKey: secrets.syncKey } : {}),
  };
  const sealed = await sealPlayer(player, prf, credentialId);
  let res: Response;
  try {
    res = await fetchImpl(`/api/backup/${credentialId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sealed),
    });
  } catch {
    throw new PasskeyError('network', 'could not reach amongfriends.gg to store the backup');
  }
  if (!res.ok) throw new PasskeyError('network', `the backup was not stored (${res.status})`);
  recordPasskey(slug, { credentialId, createdAt: Date.now() });
}

/** Sign in with a passkey on this device and bring its player back. Returns the local slug. */
export async function restoreWithPasskey(fetchImpl: typeof fetch = fetch): Promise<string> {
  const { id, prf } = await prfFromGet();
  let res: Response;
  try {
    res = await fetchImpl(`/api/backup/${id}`);
  } catch {
    throw new PasskeyError('network', 'could not reach amongfriends.gg');
  }
  if (res.status === 404)
    throw new PasskeyError('no-backup', 'no player is saved with that passkey');
  if (!res.ok) throw new PasskeyError('network', `the backup could not be read (${res.status})`);
  const stored = asStoredBackup(await res.json());
  if (!stored) throw new PasskeyError('damaged', 'the backup is damaged');
  return adoptSealed(await openPlayer(stored, prf), id);
}

/** Bring a sealed player into this browser, merging with a copy already here. */
export async function adoptSealed(player: SealedPlayer, credentialId?: string): Promise<string> {
  const data: ProfileExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    profile: {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      createdAt: Date.now(),
      publicKey: player.publicKey,
      privateKey: player.privateKey,
      ...(player.seed ? { seed: player.seed } : {}),
      ...(player.syncKey ? { syncKey: player.syncKey } : {}),
    },
    settings: { ...DEFAULT_SETTINGS },
    matches: {},
  };
  const { slug } = await importProfile(data, { replaceSettings: false });
  if (credentialId) recordPasskey(slug, { credentialId, createdAt: Date.now() });
  return slug;
}
