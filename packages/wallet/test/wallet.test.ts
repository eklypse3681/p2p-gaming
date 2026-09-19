import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@bgf/protocol';
import {
  createWallet,
  delegatedSigner,
  generateSeed,
  openRevocation,
  openWallet,
  rootSigner,
  verifyDelegated,
} from '../src/index.js';

const NOW = 1_700_000_000_000;
const challenge = new TextEncoder().encode('p2p-gaming seat v1\nmatch\nsteve\nnonce');

describe('a wallet', () => {
  it('restores everything from the seed alone', async () => {
    const wallet = await createWallet();
    const restored = await openWallet(wallet.seed);
    expect(restored.publicKey).toBe(wallet.publicKey);
    expect(restored.syncKey).toBe(wallet.syncKey);
    expect(restored.fingerprint).toBe(wallet.fingerprint);
    expect((await restored.clubKeys('house')).publicKey).toBe(
      (await wallet.clubKeys('house')).publicKey,
    );
  });

  it('gives a different, unlinkable key at every club', async () => {
    const wallet = await openWallet(generateSeed());
    const house = await wallet.clubKeys('house');
    const other = await wallet.clubKeys('other');
    expect(house.publicKey).not.toBe(other.publicKey);
    expect(house.publicKey).not.toBe(wallet.publicKey);
    // Stable, and memoised rather than re-derived into a different answer.
    expect((await wallet.clubKeys('house')).publicKey).toBe(house.publicKey);
  });

  it('signs for itself with no grant at all', async () => {
    const wallet = await openWallet(generateSeed());
    const signed = await rootSigner(wallet.root.privateKey)(challenge);
    expect(signed.grant).toBeUndefined();
    expect(await verifyDelegated(wallet.publicKey, challenge, signed, { now: NOW })).toMatchObject({
      ok: true,
      viaGrant: false,
      device: wallet.publicKey,
    });
  });
});

describe('pairing a second device', () => {
  it('never moves a secret, and the device signs as the player', async () => {
    const wallet = await openWallet(generateSeed());
    // The phone makes its own key and shows only the public half.
    const phone = await generateKeyPair();
    const grant = await wallet.pairDevice({
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      issuedAt: NOW,
    });

    // Everything that crossed the pairing channel is public.
    expect(grant).not.toContain(phone.privateKey);
    expect(grant).not.toContain(wallet.root.privateKey);

    const signed = await delegatedSigner(phone.privateKey, grant)(challenge);
    const auth = await verifyDelegated(wallet.publicKey, challenge, signed, {
      now: NOW,
      scope: 'seat',
    });
    expect(auth).toMatchObject({ ok: true, viaGrant: true, device: phone.publicKey });
  });

  it('refuses a signature the device did not make', async () => {
    const wallet = await openWallet(generateSeed());
    const phone = await generateKeyPair();
    const stranger = await generateKeyPair();
    const grant = await wallet.pairDevice({
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      issuedAt: NOW,
    });
    // A real grant, but signed by a key it does not name.
    const signed = await delegatedSigner(stranger.privateKey, grant)(challenge);
    expect(await verifyDelegated(wallet.publicKey, challenge, signed, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses another player’s grant', async () => {
    const mine = await openWallet(generateSeed());
    const theirs = await openWallet(generateSeed());
    const phone = await generateKeyPair();
    const grant = await theirs.pairDevice({
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      issuedAt: NOW,
    });
    const signed = await delegatedSigner(phone.privateKey, grant)(challenge);
    expect(await verifyDelegated(mine.publicKey, challenge, signed, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'wrong-root',
    });
  });

  it('holds a device to the scopes it was given', async () => {
    const wallet = await openWallet(generateSeed());
    const phone = await generateKeyPair();
    const grant = await wallet.pairDevice({
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
      issuedAt: NOW,
    });
    const signed = await delegatedSigner(phone.privateKey, grant)(challenge);
    expect(
      await verifyDelegated(wallet.publicKey, challenge, signed, { now: NOW, scope: 'seat' }),
    ).toMatchObject({ ok: true });
    expect(
      await verifyDelegated(wallet.publicKey, challenge, signed, { now: NOW, scope: 'admin' }),
    ).toMatchObject({ ok: false, reason: 'out-of-scope' });
  });
});

describe('losing a device', () => {
  it('cuts off the lost one and nothing else — the whole point of not copying the key', async () => {
    const wallet = await openWallet(generateSeed());
    const lost = await generateKeyPair();
    const laptop = await generateKeyPair();
    const lostGrant = await wallet.pairDevice({
      device: lost.publicKey,
      serial: 1,
      label: 'lost phone',
      issuedAt: NOW,
    });
    const laptopGrant = await wallet.pairDevice({
      device: laptop.publicKey,
      serial: 2,
      label: 'laptop',
      issuedAt: NOW,
    });

    const revocation = await openRevocation(
      await wallet.revoke({ serials: [1], issuedAt: NOW }),
      wallet.publicKey,
    );

    const fromLost = await delegatedSigner(lost.privateKey, lostGrant)(challenge);
    const fromLaptop = await delegatedSigner(laptop.privateKey, laptopGrant)(challenge);

    expect(
      await verifyDelegated(wallet.publicKey, challenge, fromLost, { now: NOW, revocation }),
    ).toMatchObject({ ok: false, reason: 'revoked' });
    expect(
      await verifyDelegated(wallet.publicKey, challenge, fromLaptop, { now: NOW, revocation }),
    ).toMatchObject({ ok: true });

    // And the player keeps their identity: the seat binding never moved.
    const direct = await rootSigner(wallet.root.privateKey)(challenge);
    expect(
      await verifyDelegated(wallet.publicKey, challenge, direct, { now: NOW, revocation }),
    ).toMatchObject({ ok: true });
  });

  it('signs out every device at once without disturbing the identity', async () => {
    const wallet = await openWallet(generateSeed());
    const grants = await Promise.all(
      [1, 2, 3].map(async (serial) => {
        const device = await generateKeyPair();
        const token = await wallet.pairDevice({
          device: device.publicKey,
          serial,
          label: `device ${serial}`,
          issuedAt: NOW,
        });
        return { device, token };
      }),
    );
    const revocation = await openRevocation(
      await wallet.revoke({ minSerial: 4, issuedAt: NOW }),
      wallet.publicKey,
    );
    for (const { device, token } of grants) {
      const signed = await delegatedSigner(device.privateKey, token)(challenge);
      expect(
        await verifyDelegated(wallet.publicKey, challenge, signed, { now: NOW, revocation }),
      ).toMatchObject({ ok: false, reason: 'revoked' });
    }
    const direct = await rootSigner(wallet.root.privateKey)(challenge);
    expect(
      await verifyDelegated(wallet.publicKey, challenge, direct, { now: NOW, revocation }),
    ).toMatchObject({ ok: true });
  });
});
