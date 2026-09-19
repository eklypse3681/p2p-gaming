import { describe, expect, it } from 'vitest';
import { looksLikePublicKey, sign, verify } from '@bgf/protocol';
import {
  IDENTITY_PATH,
  SYNC_PATH,
  SEED_BYTES,
  WalletError,
  clubPath,
  deriveBytes,
  deriveKeyPair,
  deriveSecret,
  devicePath,
  fingerprint,
  generateSeed,
  seedFromBase64Url,
  seedToBase64Url,
} from '../src/index.js';

/** Bytes 0..31: the vector the known-answer test below is pinned to. */
const FIXED = new Uint8Array(SEED_BYTES).map((_, i) => i);

describe('seeds', () => {
  it('generates 32 random bytes', () => {
    const a = generateSeed();
    const b = generateSeed();
    expect(a).toHaveLength(SEED_BYTES);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('round-trips through base64url', () => {
    const seed = generateSeed();
    expect(Array.from(seedFromBase64Url(seedToBase64Url(seed)))).toEqual(Array.from(seed));
  });

  it('refuses anything that is not a seed', () => {
    expect(() => seedFromBase64Url('nope!')).toThrow(WalletError);
    expect(() => seedFromBase64Url('AAAA')).toThrow(/32 bytes/);
    expect(() => deriveSecret(new Uint8Array(16), IDENTITY_PATH)).toThrow(/32 bytes/);
  });
});

describe('paths', () => {
  it('builds the canonical shapes', () => {
    expect(clubPath('abc-DEF_123')).toBe('club/abc-DEF_123');
    expect(devicePath(3)).toBe('device/3');
  });

  it('refuses malformed paths and serials', () => {
    expect(() => deriveSecret(FIXED, 'Identity')).toThrow(WalletError);
    expect(() => deriveSecret(FIXED, '')).toThrow(WalletError);
    expect(() => deriveSecret(FIXED, 'club/bad id')).toThrow(WalletError);
    expect(() => devicePath(0)).toThrow(WalletError);
    expect(() => devicePath(1.5)).toThrow(WalletError);
  });
});

describe('derivation', () => {
  it('is deterministic for one seed and path', async () => {
    const a = await deriveKeyPair(FIXED, IDENTITY_PATH);
    const b = await deriveKeyPair(FIXED, IDENTITY_PATH);
    expect(a).toEqual(b);
    expect(deriveSecret(FIXED, SYNC_PATH)).toBe(deriveSecret(FIXED, SYNC_PATH));
  });

  it('gives unrelated keys for different paths and different seeds', async () => {
    const identity = await deriveKeyPair(FIXED, IDENTITY_PATH);
    const club = await deriveKeyPair(FIXED, clubPath('one'));
    const other = await deriveKeyPair(FIXED, clubPath('two'));
    const elsewhere = await deriveKeyPair(generateSeed(), IDENTITY_PATH);
    const keys = [identity, club, other, elsewhere].map((k) => k.publicKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('produces keys the rest of the system already accepts', async () => {
    const pair = await deriveKeyPair(FIXED, IDENTITY_PATH);
    expect(looksLikePublicKey(pair.publicKey)).toBe(true);
    const message = new TextEncoder().encode('seat me');
    const signature = await sign(pair.privateKey, message);
    expect(signature).toHaveLength(64);
    expect(await verify(pair.publicKey, message, signature)).toBe(true);
    expect(await verify(pair.publicKey, new TextEncoder().encode('other'), signature)).toBe(false);
  });

  it('never lets one derivation be a prefix of another', () => {
    // HKDF expand is a prefix function of its length, so purpose and length are bound into info.
    const short = deriveBytes(FIXED, IDENTITY_PATH, 32);
    const long = deriveBytes(FIXED, IDENTITY_PATH, 48);
    expect(Array.from(long.subarray(0, 32))).not.toEqual(Array.from(short));

    const secret = deriveBytes(FIXED, IDENTITY_PATH, 32, 'secret');
    const material = deriveBytes(FIXED, IDENTITY_PATH, 32, 'ecdsa-p256');
    expect(Array.from(secret)).not.toEqual(Array.from(material));
  });

  it('gives a stable, short fingerprint', async () => {
    const pair = await deriveKeyPair(FIXED, IDENTITY_PATH);
    const fp = fingerprint(pair.publicKey);
    expect(fp).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(fingerprint(pair.publicKey)).toBe(fp);
  });
});

describe('known answers', () => {
  /**
   * These are pinned on purpose. Derivation decides what public key a player *is*, so a change
   * here silently rebuilds every identity, orphans every seat binding and every club membership,
   * and no backup would restore them. If a change to `derive.ts` breaks this test, the change is
   * wrong unless it comes with a migration and a new `WALLET_KDF` version string.
   */
  it('derives the pinned keys for the all-bytes-0..31 seed', async () => {
    const identity = await deriveKeyPair(FIXED, IDENTITY_PATH);
    expect(identity.publicKey).toBe(
      'BH8DGq5QbckKxAxAOa0-pR3TJYLofcCyOJn4s0oUHzBW2RPGWfBGPped60AsJ3LePmcxNvdGwFC5quw9_Shx05c',
    );
    expect(deriveSecret(FIXED, SYNC_PATH)).toBe('VUo6JMEqWq08_gbGYkZIu0u-krGEoDdKNsMMCF2qKE8');
    const club = await deriveKeyPair(FIXED, clubPath('house'));
    expect(club.publicKey).toBe(
      'BKCM5Ei4eF0Zb0we45kgVyAnLHSAmLGrcYwbsJ1veKRN-PA5LQ557sY4UrdZTKFDMbwhLo8nZk0LegAUy79VuNU',
    );
  });
});
