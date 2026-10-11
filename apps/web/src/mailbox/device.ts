import { bytesToBase64Url, sign } from '@bgf/protocol';
import { decodeGrant } from '@bgf/wallet';
import { getProfile, getSecrets } from '../session/profiles';
import type { MailboxDevice } from './client';
import {
  MailboxAuthError,
  forgetMailboxDevice,
  getMailboxDevice,
  mailboxStatus,
  putMailboxDevice,
  registerDevice,
} from './client';
import { registrationBytes } from './bytes';

/** Re-register (refreshing the mailbox's "last seen") at most this often. */
const REFRESH_MS = 7 * 24 * 3600_000;

/**
 * This device's mailbox registration for player `slug`, registering it first if needed. Signs
 * with the player's own key, or on a paired device with its device key and grant. Null when the
 * site has no mailbox or this device cannot sign as the player (locked, or not keyed).
 *
 * `push` updates where the mailbox wakes this device: a subscription, or null to stop.
 */
export async function ensureMailboxDevice(
  slug: string,
  push?: PushSubscriptionJSON | null,
): Promise<MailboxDevice | null> {
  if (!(await mailboxStatus()).available) return null;
  const existing = await getMailboxDevice(slug);
  const endpoint = push === undefined ? existing?.endpoint : (push?.endpoint ?? undefined);
  if (existing && push === undefined && Date.now() - existing.registeredAt < REFRESH_MS) {
    return existing;
  }
  const record = getProfile(slug);
  const secrets = getSecrets(slug);
  if (!record?.publicKey || !secrets) return existing ?? null;
  let device: string;
  let privateKey: string;
  let grant: string | undefined;
  if (secrets.privateKey) {
    device = record.publicKey;
    privateKey = secrets.privateKey;
  } else if (secrets.deviceKey && record.grant) {
    const decoded = decodeGrant(record.grant);
    if (!decoded) return existing ?? null;
    device = decoded.grant.device;
    privateKey = secrets.deviceKey;
    grant = record.grant;
  } else {
    return existing ?? null;
  }
  const token =
    existing?.token ?? bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const at = Date.now();
  const r = { player: record.publicKey, device, at, token };
  const signature = bytesToBase64Url(await sign(privateKey, registrationBytes(r)));
  const subscription =
    push === undefined
      ? undefined
      : push && push.endpoint && push.keys?.p256dh && push.keys.auth
        ? { endpoint: push.endpoint, p256dh: push.keys.p256dh, auth: push.keys.auth }
        : null;
  await registerDevice({
    ...r,
    signature,
    ...(grant ? { grant } : {}),
    ...(subscription !== undefined ? { push: subscription } : {}),
  });
  const saved: MailboxDevice = {
    slug,
    player: record.publicKey,
    token,
    registeredAt: at,
    ...(endpoint ? { endpoint } : {}),
  };
  await putMailboxDevice(saved);
  return saved;
}

/**
 * Run `fn` with this device's registration; if the mailbox no longer knows it (its records were
 * reset), register afresh and try once more. Null when the device cannot use the mailbox.
 */
export async function withMailboxDevice<T>(
  slug: string,
  fn: (device: MailboxDevice) => Promise<T>,
): Promise<T | null> {
  const device = await ensureMailboxDevice(slug);
  if (!device) return null;
  try {
    return await fn(device);
  } catch (e) {
    if (!(e instanceof MailboxAuthError)) throw e;
    await forgetMailboxDevice(slug);
    const again = await ensureMailboxDevice(slug);
    return again ? fn(again) : null;
  }
}
