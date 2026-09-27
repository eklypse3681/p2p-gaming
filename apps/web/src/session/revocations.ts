/**
 * Signing out a paired device, and learning which devices other players signed out.
 *
 * The list lives at `/api/revocations/<player key>`, signed by the player's own key. Tables and
 * clubs this browser hosts consult it before seating a paired device (see `main.tsx`), and the
 * player's own devices stop renewing a signed-out device's grant, so even a table that cannot
 * reach the list stops admitting it once the grant runs out.
 */
import type { Revocation } from '@bgf/wallet';
import { issueRevocation, openRevocation } from '@bgf/wallet';
import { getProfile, getSecrets, markDeviceRevoked, markRevocationsPublished } from './profiles';

const CACHE_MS = 30_000;
const TIMEOUT_MS = 3_000;
const cache = new Map<string, { at: number; value: Revocation | null }>();

/** A player's current revocation, or null when they have none. Throws when it cannot be reached. */
export async function lookupRevocation(
  playerKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Revocation | null> {
  const hit = cache.get(playerKey);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`/api/revocations/${playerKey}`, { signal: controller.signal });
    let value: Revocation | null = null;
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`revocations ${res.status}`);
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== 'string') throw new Error('revocations: no token');
      value = await openRevocation(body.token, playerKey);
    }
    cache.set(playerKey, { at: now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign a device out: this device stops renewing its grant at once, and the list every table
 * checks is republished with it. Resolves `false` when the list could not be published (the
 * device is still signed out here; publishing again later catches up).
 */
export async function signOutDevice(
  slug: string,
  serial: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  markDeviceRevoked(slug, serial);
  return publishRevocations(slug, fetchImpl);
}

/** Publish a list revoking every device this player signed out here, and any published before. */
export async function publishRevocations(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const record = getProfile(slug);
  const privateKey = getSecrets(slug)?.privateKey;
  if (!record?.publicKey || !privateKey) return false;
  const local = (record.devices ?? []).filter((d) => d.revokedAt).map((d) => d.serial);
  try {
    cache.delete(record.publicKey);
    const published = await lookupRevocation(record.publicKey, fetchImpl);
    const serials = [...new Set([...local, ...(published?.serials ?? [])])];
    const token = await issueRevocation(
      { publicKey: record.publicKey, privateKey },
      { serials, minSerial: published?.minSerial ?? 1 },
    );
    const res = await fetchImpl(`/api/revocations/${record.publicKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      cache.delete(record.publicKey);
      markRevocationsPublished(slug);
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** For tests. */
export function clearRevocationCache(): void {
  cache.clear();
}
