/**
 * The recovery phrase: 24 words that are the player's seed. They bring back the same id, the
 * same key and the same device sync, so settings and matches return from any other device the
 * player still has.
 *
 * Only players whose id came from their seed have words (everyone made since the wallet). Older
 * players keep a random id the words could not restore; a passkey backup covers them instead.
 */
import {
  openWallet,
  phraseToSeed,
  playerIdFor,
  seedFromBase64Url,
  seedToBase64Url,
  seedToPhrase,
} from '@bgf/wallet';
import {
  createProfile,
  ensureKeys,
  getProfile,
  getProfilesIndex,
  getSecrets,
  setProfileSecrets,
} from './profiles';

/** The words for this player, or null when they have none (or this device does not hold them). */
export function phraseFor(slug: string): string[] | null {
  const record = getProfile(slug);
  const seed = getSecrets(slug)?.seed;
  if (!record || !seed) return null;
  const bytes = seedFromBase64Url(seed);
  return playerIdFor(bytes) === record.id ? seedToPhrase(bytes) : null;
}

/**
 * Restore the player the words belong to. A copy already here is completed (a paired device
 * becomes a device holding the player's own key); otherwise the player is created, named
 * `name` until sync brings their real name from another device. Returns the local slug.
 */
export async function restoreFromPhrase(phrase: string, name = 'Player'): Promise<string> {
  const seed = phraseToSeed(phrase); // throws on a bad phrase before anything changes
  const wallet = await openWallet(seed);
  const existing = Object.entries(getProfilesIndex()).find(([, r]) => r.id === wallet.playerId);
  if (existing) {
    const [slug, record] = existing;
    if (!getSecrets(slug)?.privateKey && record.publicKey === wallet.publicKey) {
      await setProfileSecrets(slug, {
        privateKey: wallet.root.privateKey,
        seed: seedToBase64Url(seed),
      });
    }
    return slug;
  }
  const { slug } = createProfile(name, { seed: seedToBase64Url(seed) });
  await ensureKeys(slug);
  return slug;
}
