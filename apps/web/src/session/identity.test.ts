import { beforeEach, describe, expect, it } from 'vitest';
import { challengeBytes, verify } from '@bgf/protocol';
import {
  changePassword,
  createProfile,
  ensureKeys,
  getProfile,
  getSecrets,
  isLocked,
  isUnlocked,
  lockNow,
  lockProfile,
  removePassword,
  resetProfilesForTests,
  rotateSyncKey,
  setProfileSyncKey,
  toPlayerProfile,
  unlockProfile,
} from './profiles';
import { publicProfile } from './session';

const FAST = { iterations: 1000 };

describe('player keys', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProfilesForTests();
  });

  it('ensureKeys gives a player a key pair once, and the public profile exposes only the public key', async () => {
    const { slug } = createProfile('Steve');
    expect(getProfile(slug)!.publicKey).toBeUndefined();
    const a = await ensureKeys(slug);
    const b = await ensureKeys(slug);
    expect(a!.publicKey).toBeTruthy();
    expect(a!.privateKey).toBeTruthy();
    expect(b!.publicKey).toBe(a!.publicKey);
    const pub = publicProfile(toPlayerProfile(getProfile(slug)!));
    expect(pub.publicKey).toBe(a!.publicKey);
    expect(JSON.stringify(pub)).not.toContain(a!.privateKey!);
    expect(JSON.stringify(pub)).not.toContain(getSecrets(slug)!.syncKey!);
    // The private key really signs for the public key.
    const { signerFor } = await import('@bgf/protocol');
    const bytes = challengeBytes({ matchId: 'm', profileId: pub.id, nonce: 'n' });
    const sig = await signerFor(getSecrets(slug)!.privateKey!)(bytes);
    expect(await verify(pub.publicKey!, bytes, sig)).toBe(true);
  });

  it('a password locks the secrets at rest and unlocks them per tab', async () => {
    const { slug } = createProfile('Steve');
    await ensureKeys(slug);
    const before = getSecrets(slug)!;
    await lockProfile(slug, 'open sesame', FAST);
    const record = getProfile(slug)!;
    expect(isLocked(record)).toBe(true);
    expect(record.privateKey).toBeUndefined();
    expect(record.syncKey).toBeUndefined();
    expect(record.publicKey).toBe(before.privateKey ? record.publicKey : undefined);
    expect(JSON.stringify(record)).not.toContain(before.privateKey!);
    // This tab stays unlocked after setting the password…
    expect(isUnlocked(slug)).toBe(true);
    expect(getSecrets(slug)).toEqual(before);
    // …until locked now.
    lockNow(slug);
    expect(isUnlocked(slug)).toBe(false);
    expect(getSecrets(slug)).toBeNull();
    expect(await unlockProfile(slug, 'wrong')).toBe(false);
    expect(isUnlocked(slug)).toBe(false);
    expect(await unlockProfile(slug, 'open sesame')).toBe(true);
    expect(getSecrets(slug)).toEqual(before);
    await expect(lockProfile(slug, 'abc', FAST)).rejects.toMatchObject({ code: 'weak-password' });
  });

  it('changes and removes the password, and secret updates re-encrypt', async () => {
    const { slug } = createProfile('Steve');
    await ensureKeys(slug);
    await lockProfile(slug, 'first-pw', FAST);
    await expect(changePassword(slug, 'nope', 'second-pw', FAST)).rejects.toMatchObject({
      code: 'wrong-password',
    });
    await changePassword(slug, 'first-pw', 'second-pw', FAST);
    lockNow(slug);
    expect(await unlockProfile(slug, 'first-pw')).toBe(false);
    expect(await unlockProfile(slug, 'second-pw')).toBe(true);
    // Rotating the sync key on a locked player needs the password and keeps it locked.
    await expect(rotateSyncKey(slug)).rejects.toMatchObject({ code: 'wrong-password' });
    const oldKey = getSecrets(slug)!.syncKey;
    await rotateSyncKey(slug, { password: 'second-pw' });
    expect(isLocked(getProfile(slug)!)).toBe(true);
    expect(getSecrets(slug)!.syncKey).not.toBe(oldKey);
    await setProfileSyncKey(slug, 'imported-key', { password: 'second-pw' });
    expect(getSecrets(slug)!.syncKey).toBe('imported-key');
    await removePassword(slug, 'second-pw');
    const record = getProfile(slug)!;
    expect(isLocked(record)).toBe(false);
    expect(record.syncKey).toBe('imported-key');
    expect(record.privateKey).toBeTruthy();
  });
});
