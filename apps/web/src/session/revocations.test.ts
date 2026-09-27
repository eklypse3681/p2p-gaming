import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@bgf/protocol';
import { isRevoked, issueRevocation, openRevocation } from '@bgf/wallet';
import { onRequestGet, onRequestPut } from '../../functions/api/revocations/[key]';
import {
  createProfile,
  ensureKeys,
  getProfile,
  recordPairedDevice,
  resetProfilesForTests,
} from './profiles';
import {
  clearRevocationCache,
  lookupRevocation,
  publishRevocations,
  signOutDevice,
} from './revocations';

/** The Pages Function over an in-memory KV, reachable through a `fetch` stand-in. */
function site() {
  const data = new Map<string, string>();
  const env = {
    BACKUPS: {
      async get(k: string) {
        const v = data.get(k);
        return v === undefined ? null : JSON.parse(v);
      },
      async put(k: string, v: string) {
        data.set(k, v);
      },
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://amongfriends.gg');
    const key = url.pathname.split('/api/revocations/')[1]!;
    const request = new Request(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), 'Sec-Fetch-Site': 'same-origin' },
    });
    const ctx = { request, env, params: { key } };
    return request.method === 'PUT' ? onRequestPut(ctx) : onRequestGet(ctx);
  }) as typeof fetch;
  return { env, fetchImpl, data };
}

beforeEach(() => {
  localStorage.clear();
  resetProfilesForTests();
  clearRevocationCache();
});

async function playerWithDevices() {
  const { slug } = createProfile('Steve');
  const record = (await ensureKeys(slug))!;
  for (const serial of [1, 2, 3]) {
    recordPairedDevice(slug, {
      serial,
      label: `device ${serial}`,
      publicKey: 'x'.repeat(87),
      pairedAt: 0,
      expiresAt: 1,
    });
  }
  return { slug, key: record.publicKey! };
}

describe('signing out a device', () => {
  it('publishes a list every table can read, and it grows but never shrinks', async () => {
    const s = site();
    const { slug, key } = await playerWithDevices();
    expect(await lookupRevocation(key, s.fetchImpl)).toBeNull();

    expect(await signOutDevice(slug, 2, s.fetchImpl)).toBe(true);
    clearRevocationCache();
    let list = await lookupRevocation(key, s.fetchImpl);
    expect(isRevoked(list, 2)).toBe(true);
    expect(isRevoked(list, 1)).toBe(false);

    expect(await signOutDevice(slug, 3, s.fetchImpl)).toBe(true);
    clearRevocationCache();
    list = await lookupRevocation(key, s.fetchImpl);
    expect([isRevoked(list, 2), isRevoked(list, 3), isRevoked(list, 1)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      getProfile(slug)!
        .devices!.filter((d) => d.revokedAt)
        .map((d) => d.serial),
    ).toEqual([2, 3]);
  });

  it('keeps what another of the player’s devices already published', async () => {
    const s = site();
    const { slug, key } = await playerWithDevices();
    await signOutDevice(slug, 1, s.fetchImpl);
    // Another device of this player, which never heard of serial 1, signs out serial 3.
    const other = getProfile(slug)!;
    recordPairedDevice(slug, { ...other.devices![0]!, revokedAt: undefined });
    await signOutDevice(slug, 3, s.fetchImpl);
    clearRevocationCache();
    const list = await lookupRevocation(key, s.fetchImpl);
    expect(isRevoked(list, 1)).toBe(true);
    expect(isRevoked(list, 3)).toBe(true);
  });

  it('refuses a list that would sign a device back in, or one signed by someone else', async () => {
    const s = site();
    const player = await generateKeyPair();
    const mallory = await generateKeyPair();
    const put = (token: string, key = player.publicKey) =>
      s.fetchImpl(`/api/revocations/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ token }),
      });
    expect((await put(await issueRevocation(player, { serials: [4] }))).status).toBe(200);
    expect((await put(await issueRevocation(player, { serials: [] }))).status).toBe(409);
    expect((await put(await issueRevocation(mallory, { serials: [] }))).status).toBe(400);
    const stored = JSON.parse([...s.data.values()][0]!).token as string;
    expect(isRevoked(await openRevocation(stored, player.publicKey), 4)).toBe(true);
  });

  it('says it could not publish when the site is unreachable', async () => {
    const { slug } = await playerWithDevices();
    const offline = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await signOutDevice(slug, 1, offline)).toBe(false);
    expect(getProfile(slug)!.devices!.find((d) => d.serial === 1)!.revokedAt).toBeDefined();
    expect(await publishRevocations(slug, offline)).toBe(false);
  });
});
