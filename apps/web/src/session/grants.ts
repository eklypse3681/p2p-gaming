/**
 * Keeping paired devices' grants fresh.
 *
 * A grant lasts `DEVICE_GRANT_MS`. Whenever a paired device and a device holding the player's own
 * key meet over device sync, the paired one shows its grant and gets a fresh one if less than
 * `RENEW_WITHIN_MS` is left — unless it was signed out. So a phone in daily use never notices,
 * and a signed-out one stops working when its last grant runs out, even at tables that could
 * not check the published list.
 */
import type { Revocation } from '@bgf/wallet';
import { decodeGrant, isRevoked, issueGrant, verifyGrant } from '@bgf/wallet';
import { lookupRevocation } from './revocations';
import {
  getProfile,
  getSecrets,
  markDeviceRevoked,
  recordPairedDevice,
  setGrant,
} from './profiles';

const DAY = 86_400_000;
export const DEVICE_GRANT_MS = 30 * DAY;
export const RENEW_WITHIN_MS = 20 * DAY;

/**
 * On a device holding the player's key: a fresh grant for the device that showed `token`, or
 * null when it does not need one, is not ours to renew, or was signed out.
 */
export async function renewGrant(
  slug: string,
  token: string,
  now = Date.now(),
  lookup: (key: string) => Promise<Revocation | null> = (key) => lookupRevocation(key),
): Promise<string | null> {
  const record = getProfile(slug);
  const privateKey = getSecrets(slug)?.privateKey;
  if (!record?.publicKey || !privateKey) return null;
  const decoded = decodeGrant(token);
  if (!decoded) return null;
  const { grant } = decoded;
  // Our signature, even if it has since expired: an expired grant is exactly what needs renewing.
  const check = await verifyGrant(token, { now: grant.issuedAt, root: record.publicKey });
  if (!check.ok) return null;
  if (grant.expiresAt - now > RENEW_WITHIN_MS) return null;
  const known = (record.devices ?? []).find((d) => d.serial === grant.serial);
  if (known && (known.revokedAt || known.publicKey !== grant.device)) return null;
  // Another of the player's devices may have signed it out; only the published list says so.
  const revocation = await lookup(record.publicKey).catch(() => undefined);
  if (revocation && isRevoked(revocation, grant.serial)) {
    if (known) markDeviceRevoked(slug, grant.serial);
    return null;
  }
  // A device this one never paired is renewed only once the list has been read; one it did pair
  // keeps working through a network blip.
  if (!known && revocation === undefined) return null;
  const fresh = await issueGrant(
    { publicKey: record.publicKey, privateKey },
    {
      device: grant.device,
      serial: grant.serial,
      label: grant.label,
      scopes: grant.scopes,
      issuedAt: now,
      expiresAt: now + DEVICE_GRANT_MS,
    },
  );
  recordPairedDevice(slug, {
    serial: grant.serial,
    label: grant.label,
    publicKey: grant.device,
    pairedAt: known?.pairedAt ?? grant.issuedAt,
    expiresAt: now + DEVICE_GRANT_MS,
  });
  return fresh;
}

/** On a paired device: adopt a renewed grant if it is really ours and lasts longer. */
export async function acceptGrant(slug: string, token: string, now = Date.now()): Promise<boolean> {
  const record = getProfile(slug);
  if (!record?.publicKey || !record.grant) return false;
  const current = decodeGrant(record.grant);
  const check = await verifyGrant(token, { now, root: record.publicKey });
  if (!current || !check.ok) return false;
  if (check.grant.device !== current.grant.device) return false;
  if (check.grant.expiresAt <= current.grant.expiresAt) return false;
  setGrant(slug, token);
  return true;
}
