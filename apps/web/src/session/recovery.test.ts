import { beforeEach, describe, expect, it } from 'vitest';
import { WalletError, openWallet, seedFromBase64Url } from '@bgf/wallet';
import {
  createProfile,
  deleteProfile,
  ensureKeys,
  getProfile,
  getSecrets,
  resetProfilesForTests,
} from './profiles';
import { phraseFor, restoreFromPhrase } from './recovery';
import { adoptSealed, openPlayer, sealPlayer } from './passkey';
import type { SealedPlayer } from './passkey';

beforeEach(() => {
  localStorage.clear();
  resetProfilesForTests();
});

describe('recovery words', () => {
  it('bring back the same player, key and device sync on a browser that lost them', async () => {
    const { slug } = createProfile('Steve');
    const before = (await ensureKeys(slug))!;
    const words = phraseFor(slug)!;
    expect(words).toHaveLength(24);
    const { syncKey, privateKey } = getSecrets(slug)!;

    deleteProfile(slug); // the computer died
    const restored = await restoreFromPhrase(words.join(' '));
    const after = getProfile(restored)!;
    expect(after.id).toBe(before.id);
    expect(after.publicKey).toBe(before.publicKey);
    expect(getSecrets(restored)!.syncKey).toBe(syncKey);
    expect(getSecrets(restored)!.privateKey).toBe(privateKey);
  });

  it('make a paired device into one holding the player’s own key', async () => {
    const { slug } = createProfile('Steve');
    const root = (await ensureKeys(slug))!;
    const words = phraseFor(slug)!;
    const seed = seedFromBase64Url(getSecrets(slug)!.seed!);
    deleteProfile(slug);
    const paired = createProfile('Steve', {
      id: root.id,
      publicKey: root.publicKey,
      deviceKey: 'device-key',
      grant: 'p2pd1.x.y',
    }).slug;
    expect(await restoreFromPhrase(words.join(' '))).toBe(paired);
    expect(getSecrets(paired)!.privateKey).toBe((await openWallet(seed)).root.privateKey);
  });

  it('are refused when mistyped, and nothing changes', async () => {
    const before = localStorage.getItem('bgf:profiles');
    await expect(restoreFromPhrase('abandon '.repeat(24))).rejects.toBeInstanceOf(WalletError);
    expect(localStorage.getItem('bgf:profiles')).toBe(before);
  });

  it('do not exist for a player whose id was not derived from a seed', async () => {
    const { slug } = createProfile('Old', { id: 'random-old-id' });
    await ensureKeys(slug);
    expect(phraseFor(slug)).toBeNull();
  });
});

describe('passkey backups', () => {
  const prf = new Uint8Array(32).fill(9);

  async function player(): Promise<SealedPlayer> {
    const { slug } = createProfile('Steve');
    const r = (await ensureKeys(slug))!;
    const s = getSecrets(slug)!;
    deleteProfile(slug);
    return {
      v: 1,
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      publicKey: r.publicKey!,
      privateKey: s.privateKey!,
      seed: s.seed!,
      syncKey: s.syncKey!,
    };
  }

  it('open only with the passkey that sealed them', async () => {
    const p = await player();
    const sealed = await sealPlayer(p, prf, 'cred-1234567890abcdef');
    expect(JSON.stringify(sealed)).not.toContain(p.privateKey);
    expect(await openPlayer(sealed, prf)).toEqual(p);
    await expect(openPlayer(sealed, new Uint8Array(32).fill(1))).rejects.toMatchObject({
      code: 'damaged',
    });
  });

  it('restore the player into this browser', async () => {
    const p = await player();
    const slug = await adoptSealed(p, 'cred-1234567890abcdef');
    expect(getProfile(slug)).toMatchObject({ id: p.id, publicKey: p.publicKey, name: 'Steve' });
    expect(getSecrets(slug)).toMatchObject({ privateKey: p.privateKey, seed: p.seed });
    expect(getProfile(slug)!.passkeys?.[0]?.credentialId).toBe('cred-1234567890abcdef');
  });
});
