/**
 * The wallet: one seed, and everything a player signs with.
 *
 * `createWallet()` makes a new player. `openWallet(seed)` reopens one from its backup. Keys are
 * derived on demand and memoised, so asking twice for the same club key costs nothing.
 *
 * A club key is *separate per club*: the same person at two clubs presents two unrelated public
 * keys, so clubs cannot correlate their rosters, while the player still restores both from one
 * backup. Seats stay bound to the root key, which is the identity the games already know.
 */
import type { KeyPair } from '@bgf/protocol';
import type { GrantScope, Revocation } from './delegation.js';
import { DEFAULT_GRANT_MS, issueGrant, issueRevocation } from './delegation.js';
import {
  IDENTITY_PATH,
  SYNC_PATH,
  clubPath,
  deriveKeyPair,
  deriveSecret,
  devicePath,
  playerIdFor,
} from './derive.js';
import { fingerprint, generateSeed } from './seed.js';

export interface PairDeviceRequest {
  /** The public key the new device generated for itself. */
  device: string;
  serial: number;
  label: string;
  scopes?: readonly GrantScope[];
  issuedAt?: number;
  expiresAt?: number;
}

export interface Wallet {
  /** The backup. Never leaves this browser. */
  readonly seed: Uint8Array;
  /** The identity key pair: what seats and memberships are bound to. */
  readonly root: KeyPair;
  readonly publicKey: string;
  /** Short code to read aloud when pairing. */
  readonly fingerprint: string;
  /** The device-sync secret, derived rather than stored. */
  readonly syncKey: string;
  /** The player id this seed restores to (players made before the wallet keep a random one). */
  readonly playerId: string;
  /** This player's key at one club; unrelated to their key at any other. */
  clubKeys(clubId: string): Promise<KeyPair>;
  /** A key this wallet can re-derive for a device it owns, when it holds both ends. */
  deviceKeys(serial: number): Promise<KeyPair>;
  /** Authorise a device's own key. The seed is not involved and does not move. */
  pairDevice(request: PairDeviceRequest): Promise<string>;
  /** Sign out devices: everything below `minSerial`, plus any named serials. */
  revoke(input: {
    minSerial?: number;
    serials?: readonly number[];
    issuedAt?: number;
  }): Promise<string>;
}

export async function createWallet(): Promise<Wallet> {
  return openWallet(generateSeed());
}

export async function openWallet(seed: Uint8Array): Promise<Wallet> {
  const root = await deriveKeyPair(seed, IDENTITY_PATH);
  const cache = new Map<string, Promise<KeyPair>>();
  const at = (path: string): Promise<KeyPair> => {
    let pending = cache.get(path);
    if (!pending) {
      pending = deriveKeyPair(seed, path);
      cache.set(path, pending);
    }
    return pending;
  };
  return {
    seed,
    root,
    publicKey: root.publicKey,
    fingerprint: fingerprint(root.publicKey),
    syncKey: deriveSecret(seed, SYNC_PATH),
    playerId: playerIdFor(seed),
    clubKeys: (clubId) => at(clubPath(clubId)),
    deviceKeys: (serial) => at(devicePath(serial)),
    pairDevice: (request) =>
      issueGrant(root, {
        device: request.device,
        serial: request.serial,
        label: request.label,
        scopes: request.scopes ?? ['seat', 'sync', 'club'],
        issuedAt: request.issuedAt ?? Date.now(),
        expiresAt: request.expiresAt ?? (request.issuedAt ?? Date.now()) + DEFAULT_GRANT_MS,
      }),
    revoke: (input) => issueRevocation(root, input),
  };
}

export type { Revocation };
