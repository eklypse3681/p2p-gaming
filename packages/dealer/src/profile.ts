import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlayerProfile } from '@bgf/protocol';
import { generateId, generateKeyPair } from '@bgf/protocol';

/** The dealer's own keyed identity, persisted in `<dataDir>/profile.json`. */
export interface DealerProfile {
  id: string;
  name: string;
  avatar: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

export const PROFILE_FILE = 'profile.json';

export async function loadOrCreateProfile(
  dataDir: string,
  name = 'Dealer',
): Promise<DealerProfile> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, PROFILE_FILE);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<DealerProfile>;
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      const profile: DealerProfile = {
        id: parsed.id,
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : name,
        avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '🤖',
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      };
      if (profile.name !== parsed.name) await writeFile(path, JSON.stringify(profile, null, 2));
      return profile;
    }
  } catch {
    /* missing or corrupt: create a fresh one */
  }
  const keys = await generateKeyPair();
  const profile: DealerProfile = {
    id: generateId(),
    name,
    avatar: '🤖',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: Date.now(),
  };
  await writeFile(path, JSON.stringify(profile, null, 2), { mode: 0o600 });
  return profile;
}

/** What other players may see: never the private key. */
export function publicProfile(profile: DealerProfile): PlayerProfile {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    publicKey: profile.publicKey,
  };
}
