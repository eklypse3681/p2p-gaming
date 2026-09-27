import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportProvider } from '@bgf/protocol';
import { challengeBytes, generateKeyPair, memoryProvider } from '@bgf/protocol';
import { issueGrant, verifyDelegated, verifyGrant } from '@bgf/wallet';
import { bytesToBase64Url } from '@bgf/protocol';
import type { PairingRequest } from './pairing';

/**
 * Two browsers in one test: the player's device keeps the profiles module it was imported with,
 * and the new device gets a fresh copy of every module over emptied storage.
 */
async function playerDevice() {
  localStorage.clear();
  vi.resetModules();
  const profiles = await import('./profiles');
  const pairing = await import('./pairing');
  profiles.resetProfilesForTests();
  const entry = profiles.createProfile('Steve', { syncKey: 'steves-devices' });
  await profiles.ensureKeys(entry.slug);
  return { profiles, pairing, slug: entry.slug, record: profiles.getProfile(entry.slug)! };
}

async function newDevice() {
  localStorage.clear();
  vi.resetModules();
  const profiles = await import('./profiles');
  const pairing = await import('./pairing');
  const provider = await import('./ProfileProvider');
  profiles.resetProfilesForTests();
  return { profiles, pairing, provider };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
};

describe('pairing a device', () => {
  let net: TransportProvider;
  beforeEach(() => {
    net = memoryProvider();
  });

  it('makes the new device the player without the player’s key ever crossing', async () => {
    const phone = await playerDevice().then(async (host) => ({ host, device: await newDevice() }));
    const { host, device } = phone;
    const offer = await host.pairing.hostPairing(host.slug, net, { code: 'PAIRTEST' });
    const requests: PairingRequest[] = [];
    offer.onRequest((r) => requests.push(r));

    const join = await device.pairing.joinPairing('PAIRTEST', net, { label: 'iPhone · Safari' });
    await settle();
    expect(requests).toHaveLength(1);
    // Both screens show the same code for the new device's key.
    expect(requests[0]!.fingerprint).toBe(join.fingerprint);
    expect(requests[0]!.label).toBe('iPhone · Safari');

    const paired = await requests[0]!.approve();
    const slug = await join.done;

    const mine = device.profiles.getProfile(slug)!;
    expect(mine.id).toBe(host.record.id);
    expect(mine.publicKey).toBe(host.record.publicKey);
    expect(device.profiles.getSecrets(slug)).toMatchObject({ syncKey: 'steves-devices' });
    // Neither the player's key nor their seed reached the phone.
    expect(device.profiles.getSecrets(slug)!.privateKey).toBeUndefined();
    expect(device.profiles.getSecrets(slug)!.seed).toBeUndefined();
    expect(JSON.stringify(localStorage)).not.toContain(
      host.profiles.getSecrets(host.slug)!.privateKey!,
    );

    // The phone signs a seat challenge and a table accepts it for the player.
    const signer = device.provider.signerOf(device.profiles.getSecrets(slug)!, mine.grant!)!;
    expect(signer.grant).toBe(mine.grant);
    const bytes = challengeBytes({ matchId: 'm', profileId: mine.id, nonce: 'n' });
    const auth = await verifyDelegated(
      host.record.publicKey!,
      bytes,
      { signature: bytesToBase64Url(await signer(bytes)), grant: signer.grant! },
      { now: Date.now(), scope: 'seat' },
    );
    expect(auth.ok).toBe(true);

    // The player's device remembers it, for the Devices list.
    expect(host.profiles.getProfile(host.slug)!.devices).toEqual([paired]);
    expect(paired.serial).toBe(1);
    offer.close();
  });

  it('tells the new device when the person says no', async () => {
    const host = await playerDevice();
    const device = await newDevice();
    const offer = await host.pairing.hostPairing(host.slug, net, { code: 'NOPE0001' });
    offer.onRequest((r) => r.decline());
    const join = await device.pairing.joinPairing('NOPE0001', net);
    await expect(join.done).rejects.toMatchObject({ code: 'declined' });
    expect(device.profiles.listProfiles()).toHaveLength(0);
    offer.close();
  });

  it('only lets a device holding the player’s own key pair others', async () => {
    const host = await playerDevice();
    const device = await newDevice();
    const offer = await host.pairing.hostPairing(host.slug, net, { code: 'FIRST001' });
    offer.onRequest((r) => void r.approve());
    const slug = await (await device.pairing.joinPairing('FIRST001', net)).done;
    expect(device.pairing.canPairDevices(slug)).toBe(false);
    await expect(device.pairing.hostPairing(slug, net)).rejects.toMatchObject({
      code: 'not-yours',
    });
    expect(host.pairing.canPairDevices(host.slug)).toBe(true);
    offer.close();
  });

  it('refuses a grant that names some other device', async () => {
    const device = await newDevice();
    const player = await generateKeyPair();
    const someoneElse = await generateKeyPair();
    const listener = await net.host('FAKE0001');
    listener.onConnection((t) => {
      t.send({
        t: 'hello',
        v: 1,
        player: { id: 'x', name: 'X', avatar: '🎲', publicKey: player.publicKey },
      });
      t.onMessage(async () => {
        const grant = await issueGrant(player, {
          device: someoneElse.publicKey,
          serial: 1,
          label: 'not you',
          scopes: ['seat'],
        });
        expect((await verifyGrant(grant, { now: Date.now() })).ok).toBe(true);
        t.send({ t: 'grant', grant });
      });
    });
    const join = await device.pairing.joinPairing('FAKE0001', net);
    await expect(join.done).rejects.toMatchObject({ code: 'bad-grant' });
    expect(device.profiles.listProfiles()).toHaveLength(0);
    listener.close();
  });

  it('a cancelled attempt never asks, and one that leaves is withdrawn', async () => {
    const host = await playerDevice();
    const device = await newDevice();
    const offer = await host.pairing.hostPairing(host.slug, net, { code: 'RACE0001' });
    const requests: PairingRequest[] = [];
    offer.onRequest((r) => requests.push(r));

    // Cancelled before it could connect: it must not turn up as a request later.
    const abandoned = await device.pairing.joinPairing('RACE0001', net);
    abandoned.cancel();
    await settle();
    expect(requests).toHaveLength(0);

    // Connected, asked, then the page went away before anyone answered.
    const leaving = await device.pairing.joinPairing('RACE0001', net);
    await settle();
    expect(requests).toHaveLength(1);
    let withdrawn = false;
    requests[0]!.onWithdrawn(() => (withdrawn = true));
    leaving.cancel();
    await settle();
    expect(withdrawn).toBe(true);
    await expect(requests[0]!.approve()).rejects.toMatchObject({ code: 'closed' });

    // The attempt that stays is the one that gets paired.
    const staying = await device.pairing.joinPairing('RACE0001', net);
    await settle();
    expect(requests).toHaveLength(2);
    await requests[1]!.approve();
    await expect(staying.done).resolves.toMatch(/steve/);
    offer.close();
  });

  it('names devices the way people know them', async () => {
    const { deviceLabel } = await import('./pairing');
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone · Safari');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe('Mac · Chrome');
  });
});
