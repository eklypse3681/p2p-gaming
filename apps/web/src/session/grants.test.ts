import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@bgf/protocol';
import { decodeGrant, issueGrant, issueRevocation, openRevocation } from '@bgf/wallet';
import { DEVICE_GRANT_MS, RENEW_WITHIN_MS, acceptGrant, renewGrant } from './grants';
import {
  createProfile,
  ensureKeys,
  getProfile,
  getSecrets,
  markDeviceRevoked,
  recordPairedDevice,
  resetProfilesForTests,
} from './profiles';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  localStorage.clear();
  resetProfilesForTests();
});

async function setup(opts: { knownHere?: boolean } = {}) {
  const { slug } = createProfile('Steve');
  const record = (await ensureKeys(slug))!;
  const root = { publicKey: record.publicKey!, privateKey: getSecrets(slug)!.privateKey! };
  const phone = await generateKeyPair();
  const grant = await issueGrant(root, {
    device: phone.publicKey,
    serial: 1,
    label: 'phone',
    scopes: ['seat', 'sync', 'club'],
    issuedAt: T0,
    expiresAt: T0 + DEVICE_GRANT_MS,
  });
  if (opts.knownHere !== false) {
    recordPairedDevice(slug, {
      serial: 1,
      label: 'phone',
      publicKey: phone.publicKey,
      pairedAt: T0,
      expiresAt: T0 + DEVICE_GRANT_MS,
    });
  }
  return { slug, root, phone, grant };
}

const noList = async () => null;
const offline = async () => {
  throw new Error('offline');
};

describe('renewing a paired device’s grant', () => {
  it('waits until it is getting old, then renews it for the same device and serial', async () => {
    const { slug, grant, phone } = await setup();
    expect(await renewGrant(slug, grant, T0 + DAY, noList)).toBeNull();
    const at = T0 + DEVICE_GRANT_MS - RENEW_WITHIN_MS + DAY;
    const fresh = (await renewGrant(slug, grant, at, noList))!;
    const g = decodeGrant(fresh)!.grant;
    expect(g.device).toBe(phone.publicKey);
    expect(g.serial).toBe(1);
    expect(g.expiresAt).toBe(at + DEVICE_GRANT_MS);
  });

  it('renews one that already ran out: the phone was just away a while', async () => {
    const { slug, grant } = await setup();
    expect(await renewGrant(slug, grant, T0 + 60 * DAY, noList)).not.toBeNull();
  });

  it('never renews a device the player signed out', async () => {
    const { slug, grant } = await setup();
    markDeviceRevoked(slug, 1);
    expect(await renewGrant(slug, grant, T0 + 25 * DAY, noList)).toBeNull();
  });

  it('renews a device paired elsewhere only once the published list clears it', async () => {
    const { slug, grant } = await setup({ knownHere: false });
    const at = T0 + 25 * DAY;
    // Cannot read the list: better to try again later than renew a device that may be lost.
    expect(await renewGrant(slug, grant, at, offline)).toBeNull();
    expect(await renewGrant(slug, grant, at, noList)).not.toBeNull();
  });

  it('stops renewing a device signed out on another of the player’s devices', async () => {
    const { slug, grant, root } = await setup();
    const at = T0 + 25 * DAY;
    const revoked = await openRevocation(
      await issueRevocation(root, { serials: [1] }),
      root.publicKey,
    );
    expect(await renewGrant(slug, grant, at, async () => revoked)).toBeNull();
    // And remembers it here, so it stays signed out without the list.
    expect(getProfile(slug)!.devices![0]!.revokedAt).toBeDefined();
    expect(await renewGrant(slug, grant, at, noList)).toBeNull();
  });

  it('keeps a device it paired itself working through a network blip', async () => {
    const { slug, grant } = await setup();
    expect(await renewGrant(slug, grant, T0 + 25 * DAY, offline)).not.toBeNull();
  });

  it('refuses a grant some other player signed', async () => {
    const { slug } = await setup();
    const mallory = await generateKeyPair();
    const phone = await generateKeyPair();
    const foreign = await issueGrant(mallory, {
      device: phone.publicKey,
      serial: 1,
      label: 'x',
      scopes: ['seat'],
      issuedAt: T0,
    });
    expect(await renewGrant(slug, foreign, T0 + 25 * DAY, noList)).toBeNull();
  });
});

describe('a paired device accepting a renewal', () => {
  it('takes a later grant for its own key and nothing else', async () => {
    const { root, phone, grant } = await setup();
    const paired = createProfile('Steve', {
      id: 'steve-on-phone',
      publicKey: root.publicKey,
      deviceKey: phone.privateKey,
      grant,
    }).slug;
    const now = T0 + 25 * DAY;
    const later = await issueGrant(root, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
      issuedAt: now,
      expiresAt: now + DEVICE_GRANT_MS,
    });
    const otherDevice = await generateKeyPair();
    const notMine = await issueGrant(root, {
      device: otherDevice.publicKey,
      serial: 2,
      label: 'tablet',
      scopes: ['seat'],
      issuedAt: now,
      expiresAt: now + DEVICE_GRANT_MS,
    });
    expect(await acceptGrant(paired, notMine, now)).toBe(false);
    expect(await acceptGrant(paired, later, now)).toBe(true);
    expect(getProfile(paired)!.grant).toBe(later);
    expect(await acceptGrant(paired, grant, now)).toBe(false); // older: kept the newer one
  });
});
